import {
  PRICE_DECIMALS,
  convertUnitPrice,
  defaultPurchaseOrderSettings,
  itemBaseUnit,
  priceInForce,
  type PurchaseOrderSettings,
  type PurchaseOrderSettingsUpdateInput,
  type SupplierPriceCreateInput,
  type SupplierPriceListQuery,
  type SupplierPriceUpdateInput,
  type UnitCode,
} from "@knotworking/core";
import {
  items,
  lockWorkspaceLog,
  purchaseSupplierPrices,
  purchasingSettings,
  recordChanges,
  suppliers,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, count, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { ApiError, badRequest, isPrimaryKeyViolation, notFound } from "../errors";
import { workspaceToday } from "./time-zone";
import { getInvoiceTolerances } from "./ports/purchase-invoices";
import { findItem } from "./ports/stock";

/**
 * Purchasing controls that are workspace settings or reference data: the approval threshold for
 * sending an order, the over-delivery tolerance (both on `purchasing_settings`, which also holds
 * the invoice tolerances), and supplier price lists.
 */

type PriceRow = typeof purchaseSupplierPrices.$inferSelect;

const strip = <T extends { workspaceId: string; deletedAt: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
};

// ─── Order settings ──────────────────────────────────────────────────────────

/** The workspace's order controls: everything off until someone sets it. */
export async function getOrderSettings(db: Executor, workspaceId: string): Promise<PurchaseOrderSettings> {
  const [row] = await db
    .select({
      sendApprovalThreshold: purchasingSettings.sendApprovalThreshold,
      overDeliveryTolerancePercent: purchasingSettings.overDeliveryTolerancePercent,
    })
    .from(purchasingSettings)
    .where(eq(purchasingSettings.workspaceId, workspaceId));
  return row ? { ...row } : { ...defaultPurchaseOrderSettings };
}

export async function updateOrderSettings(
  db: Database,
  workspaceId: string,
  actorId: string,
  patch: PurchaseOrderSettingsUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const next = { ...(await getOrderSettings(tx, workspaceId)), ...patch };
    // The row also holds the invoice tolerances (defaults until saved), which it needs to exist.
    const tolerances = await getInvoiceTolerances(tx, workspaceId);
    const [row] = await tx
      .insert(purchasingSettings)
      .values({
        workspaceId,
        priceTolerancePercent: tolerances.pricePercent,
        priceToleranceAmount: tolerances.priceAmount,
        quantityTolerancePercent: tolerances.quantityPercent,
        quantityToleranceAmount: tolerances.quantityAmount,
        sendApprovalThreshold: next.sendApprovalThreshold,
        overDeliveryTolerancePercent: next.overDeliveryTolerancePercent,
        updatedBy: actorId,
      })
      .onConflictDoUpdate({
        target: purchasingSettings.workspaceId,
        set: {
          sendApprovalThreshold: next.sendApprovalThreshold,
          overDeliveryTolerancePercent: next.overDeliveryTolerancePercent,
          updatedBy: actorId,
          updatedAt: new Date(),
        },
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "purchasing_settings", entityId: workspaceId, action: "upsert", data: strip(row!) },
    ]);
    return getOrderSettings(tx, workspaceId);
  });
}

// ─── Supplier price lists ────────────────────────────────────────────────────

const priceChange = (row: PriceRow): ChangeInput => ({
  entity: "purchase_supplier_price",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

/**
 * The price list's price for an item from a supplier on a date, as a price per `unit` (converted
 * with the item's own conversion, 8 places). Null when no entry is in force or its unit doesn't
 * convert to `unit`: the caller falls back to the item's standard cost.
 */
export async function listPriceFor(
  db: Executor,
  workspaceId: string,
  supplierId: string,
  item: typeof items.$inferSelect,
  unit: UnitCode,
  on: string,
) {
  const entries = await db
    .select()
    .from(purchaseSupplierPrices)
    .where(
      and(
        eq(purchaseSupplierPrices.workspaceId, workspaceId),
        eq(purchaseSupplierPrices.supplierId, supplierId),
        eq(purchaseSupplierPrices.itemId, item.id),
        isNull(purchaseSupplierPrices.deletedAt),
        lte(purchaseSupplierPrices.effectiveFrom, on),
        or(isNull(purchaseSupplierPrices.effectiveTo), gte(purchaseSupplierPrices.effectiveTo, on)),
      ),
    );
  const entry = priceInForce(entries, on);
  if (!entry) return null;
  const price =
    entry.unit === unit
      ? entry.unitPrice
      : convertUnitPrice(entry.unitPrice, entry.unit, unit, item, PRICE_DECIMALS);
  return price === null ? null : { price, entryId: entry.id };
}

const priceView = (
  row: PriceRow,
  item: { id: string; code: string; name: string },
  supplier: { id: string; name: string },
  today: string,
) => ({
  ...strip(row),
  item,
  supplier,
  /** In force today (as of the query's date when `on` is given). */
  inForce: row.effectiveFrom <= today && (row.effectiveTo === null || row.effectiveTo >= today),
});

export async function listSupplierPrices(
  db: Executor,
  workspaceId: string,
  query: SupplierPriceListQuery,
  todayOn?: string,
) {
  const p = purchaseSupplierPrices;
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const on = query.on ?? today;
  const where = and(
    eq(p.workspaceId, workspaceId),
    isNull(p.deletedAt),
    query.supplierId ? eq(p.supplierId, query.supplierId) : undefined,
    query.itemId ? eq(p.itemId, query.itemId) : undefined,
    query.on
      ? and(lte(p.effectiveFrom, query.on), or(isNull(p.effectiveTo), gte(p.effectiveTo, query.on)))
      : undefined,
  );
  const [rows, [total]] = await Promise.all([
    db
      .select({
        row: p,
        item: { id: items.id, code: items.code, name: items.name },
        supplier: { id: suppliers.id, name: suppliers.name },
      })
      .from(p)
      .innerJoin(items, eq(items.id, p.itemId))
      .innerJoin(suppliers, eq(suppliers.id, p.supplierId))
      .where(where)
      .orderBy(asc(suppliers.name), asc(items.name), desc(p.effectiveFrom), asc(p.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(p).where(where),
  ]);
  return {
    prices: rows.map((r) => priceView(r.row, r.item, r.supplier, on)),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

/** 409 when the supplier already has an entry for the item taking effect that day. */
async function assertEntryFree(
  tx: Executor,
  workspaceId: string,
  supplierId: string,
  itemId: string,
  effectiveFrom: string,
  exceptId?: string,
) {
  const [taken] = await tx
    .select({ id: purchaseSupplierPrices.id })
    .from(purchaseSupplierPrices)
    .where(
      and(
        eq(purchaseSupplierPrices.workspaceId, workspaceId),
        eq(purchaseSupplierPrices.supplierId, supplierId),
        eq(purchaseSupplierPrices.itemId, itemId),
        eq(purchaseSupplierPrices.effectiveFrom, effectiveFrom),
        isNull(purchaseSupplierPrices.deletedAt),
        exceptId ? sql`${purchaseSupplierPrices.id} <> ${exceptId}` : undefined,
      ),
    )
    .limit(1);
  if (taken) {
    throw new ApiError(
      409,
      "duplicate_price",
      `This supplier already has a price for the item from ${effectiveFrom}; change that one instead`,
      { priceId: taken.id },
    );
  }
}

/** The price's unit must convert to the item's base unit, or it could never be used on a line. */
function assertUnitConverts(item: typeof items.$inferSelect, unit: UnitCode) {
  if (convertUnitPrice(1, unit, itemBaseUnit(item), item) === null) {
    throw badRequest(`${unit} doesn't convert for this item (set its unit weight or density first)`, {
      code: "unit_not_convertible",
    });
  }
}

async function findPrice(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(purchaseSupplierPrices)
    .where(
      and(
        eq(purchaseSupplierPrices.id, id),
        eq(purchaseSupplierPrices.workspaceId, workspaceId),
        isNull(purchaseSupplierPrices.deletedAt),
      ),
    );
  if (!row) throw notFound("Price");
  return row;
}

async function priceViewFor(db: Executor, workspaceId: string, row: PriceRow) {
  const [item] = await db
    .select({ id: items.id, code: items.code, name: items.name })
    .from(items)
    .where(eq(items.id, row.itemId));
  const [supplier] = await db
    .select({ id: suppliers.id, name: suppliers.name })
    .from(suppliers)
    .where(eq(suppliers.id, row.supplierId));
  return priceView(row, item!, supplier!, await workspaceToday(db, workspaceId));
}

export async function createSupplierPrice(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: SupplierPriceCreateInput,
) {
  try {
    return await db.transaction(async (tx) => {
      await lockWorkspaceLog(tx, workspaceId);
      const [supplier] = await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(
          and(
            eq(suppliers.id, input.supplierId),
            eq(suppliers.workspaceId, workspaceId),
            isNull(suppliers.deletedAt),
          ),
        );
      if (!supplier) throw notFound("Supplier");
      const item = await findItem(tx, workspaceId, input.itemId);
      assertUnitConverts(item, input.unit);
      await assertEntryFree(tx, workspaceId, input.supplierId, input.itemId, input.effectiveFrom);
      const [row] = await tx
        .insert(purchaseSupplierPrices)
        .values({
          ...(input.id ? { id: input.id } : {}),
          workspaceId,
          supplierId: input.supplierId,
          itemId: input.itemId,
          unit: input.unit,
          unitPrice: input.unitPrice,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          notes: input.notes ?? null,
          createdBy: actorId,
        })
        .returning();
      await recordChanges(tx, workspaceId, actorId, [priceChange(row!)]);
      return priceViewFor(tx, workspaceId, row!);
    });
  } catch (err) {
    if (input.id && isPrimaryKeyViolation(err)) {
      throw new ApiError(409, "conflict", "A price with this id already exists");
    }
    throw err;
  }
}

export async function updateSupplierPrice(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: SupplierPriceUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findPrice(tx, workspaceId, id);
    const effectiveFrom = patch.effectiveFrom ?? current.effectiveFrom;
    const effectiveTo = patch.effectiveTo !== undefined ? patch.effectiveTo : current.effectiveTo;
    if (effectiveTo && effectiveTo < effectiveFrom)
      throw badRequest("`effectiveTo` is before `effectiveFrom`");
    if (patch.unit) assertUnitConverts(await findItem(tx, workspaceId, current.itemId), patch.unit);
    if (effectiveFrom !== current.effectiveFrom) {
      await assertEntryFree(tx, workspaceId, current.supplierId, current.itemId, effectiveFrom, id);
    }
    const [row] = await tx
      .update(purchaseSupplierPrices)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(purchaseSupplierPrices.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [priceChange(row!)]);
    return priceViewFor(tx, workspaceId, row!);
  });
}

/** Removes an entry (soft): lines already on orders keep the price they were given. */
export async function deleteSupplierPrice(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findPrice(tx, workspaceId, id);
    await tx
      .update(purchaseSupplierPrices)
      .set({ deletedAt: new Date() })
      .where(eq(purchaseSupplierPrices.id, id));
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "purchase_supplier_price", entityId: id, action: "delete" },
    ]);
  });
}
