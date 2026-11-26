import {
  moduleIds,
  unitDimension,
  type ItemCreateInput,
  type ModuleId,
  type ItemListQuery,
  type ItemUpdateInput,
  type SupplierApprovalInput,
  type SupplierCreateInput,
  type SupplierListQuery,
  type SupplierUpdateInput,
} from "@knotworking/core";
import {
  demandLines,
  foodItems,
  items,
  itemSuppliers,
  lockWorkspaceLog,
  productionBatches,
  productionRecords,
  purchaseInvoiceLines,
  purchaseInvoices,
  purchaseOrderLines,
  purchaseOrders,
  purchaseReceipts,
  qualityComplaints,
  qualityNonconformances,
  recipeLines,
  recipes,
  recipeVersions,
  recordChanges,
  stockLots,
  stockMovements,
  suppliers,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { recordStandardCostChange } from "./costing-settings";
import { foodFieldsByItem, foodItemFields, saveFoodItem } from "./food-items";
import { checkSupplierControls } from "./supplier-controls";
import { workspaceToday } from "./time-zone";

/**
 * Items module: items (ingredients, packaging, WIP, finished goods) and their suppliers.
 *
 * Read through paginated queries, not the bootstrap: a manufacturer has hundreds of items. Every
 * write still appends to the sync log (`item`, `supplier`, `item_supplier`), in one transaction.
 */

type ItemRow = typeof items.$inferSelect;
type SupplierRow = typeof suppliers.$inferSelect;

/** True when the query finds a row. */
async function exists(query: PromiseLike<unknown[]>) {
  return (await query).length > 0;
}

/**
 * Whether another module's records point at the item. The tables are queried directly, whatever
 * modules are on: they exist either way, and a module switched off later still holds its records.
 * Records that are themselves soft-deleted don't count; append-only ones (movements, receipts,
 * production records) always do. Add new tables that reference `items` here.
 */
async function itemInUse(tx: Executor, id: string) {
  const checks = [
    () =>
      tx
        .select({ id: stockLots.id })
        .from(stockLots)
        .where(and(eq(stockLots.itemId, id), isNull(stockLots.deletedAt)))
        .limit(1),
    () =>
      tx.select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.itemId, id)).limit(1),
    () =>
      tx
        .select({ id: recipes.id })
        .from(recipes)
        .where(and(eq(recipes.outputItemId, id), isNull(recipes.deletedAt)))
        .limit(1),
    () =>
      tx
        .select({ id: recipeLines.id })
        .from(recipeLines)
        .innerJoin(recipeVersions, eq(recipeVersions.id, recipeLines.versionId))
        .innerJoin(recipes, eq(recipes.id, recipeVersions.recipeId))
        .where(
          and(
            eq(recipeLines.itemId, id),
            isNull(recipeLines.deletedAt),
            isNull(recipeVersions.deletedAt),
            isNull(recipes.deletedAt),
          ),
        )
        .limit(1),
    () =>
      tx
        .select({ id: demandLines.id })
        .from(demandLines)
        .where(and(eq(demandLines.itemId, id), isNull(demandLines.deletedAt)))
        .limit(1),
    () =>
      tx
        .select({ id: productionBatches.id })
        .from(productionBatches)
        .where(and(eq(productionBatches.outputItemId, id), isNull(productionBatches.deletedAt)))
        .limit(1),
    () =>
      tx
        .select({ id: productionRecords.id })
        .from(productionRecords)
        .where(eq(productionRecords.itemId, id))
        .limit(1),
    () =>
      tx
        .select({ id: purchaseOrderLines.id })
        .from(purchaseOrderLines)
        .where(and(eq(purchaseOrderLines.itemId, id), isNull(purchaseOrderLines.deletedAt)))
        .limit(1),
    () =>
      tx
        .select({ id: purchaseReceipts.id })
        .from(purchaseReceipts)
        .where(eq(purchaseReceipts.itemId, id))
        .limit(1),
    () =>
      tx
        .select({ id: purchaseInvoiceLines.id })
        .from(purchaseInvoiceLines)
        .where(and(eq(purchaseInvoiceLines.itemId, id), isNull(purchaseInvoiceLines.deletedAt)))
        .limit(1),
    () =>
      tx
        .select({ id: qualityComplaints.id })
        .from(qualityComplaints)
        .where(and(eq(qualityComplaints.itemId, id), isNull(qualityComplaints.deletedAt)))
        .limit(1),
    () =>
      tx
        .select({ id: qualityNonconformances.id })
        .from(qualityNonconformances)
        .where(and(eq(qualityNonconformances.itemId, id), isNull(qualityNonconformances.deletedAt)))
        .limit(1),
  ];
  for (const check of checks) if (await exists(check())) return true;
  return false;
}

/** Whether another module's records name the supplier. Same rules as `itemInUse`. */
async function supplierInUse(tx: Executor, id: string) {
  const checks = [
    () =>
      tx
        .select({ id: stockLots.id })
        .from(stockLots)
        .where(and(eq(stockLots.supplierId, id), isNull(stockLots.deletedAt)))
        .limit(1),
    () =>
      tx
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.supplierId, id), isNull(purchaseOrders.deletedAt)))
        .limit(1),
    () =>
      tx
        .select({ id: purchaseInvoices.id })
        .from(purchaseInvoices)
        .where(and(eq(purchaseInvoices.supplierId, id), isNull(purchaseInvoices.deletedAt)))
        .limit(1),
    () =>
      tx
        .select({ id: qualityNonconformances.id })
        .from(qualityNonconformances)
        .where(and(eq(qualityNonconformances.supplierId, id), isNull(qualityNonconformances.deletedAt)))
        .limit(1),
  ];
  for (const check of checks) if (await exists(check())) return true;
  return false;
}

/** `%` and `_` are literal in a search box. */
const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;

// ─── Suppliers ───────────────────────────────────────────────────────────────

export function serializeSupplier(row: SupplierRow) {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
}

export const supplierChange = (row: SupplierRow): ChangeInput => ({
  entity: "supplier",
  entityId: row.id,
  action: "upsert",
  data: serializeSupplier(row),
});

export async function listSuppliers(db: Database, workspaceId: string, query: SupplierListQuery) {
  const where: (SQL | undefined)[] = [eq(suppliers.workspaceId, workspaceId), isNull(suppliers.deletedAt)];
  if (query.status) where.push(eq(suppliers.approvalStatus, query.status));
  if (query.category) where.push(eq(suppliers.category, query.category));
  if (query.q) {
    where.push(
      or(
        sql`${suppliers.name} ilike ${like(query.q)} escape '!'`,
        sql`${suppliers.code} ilike ${like(query.q)} escape '!'`,
      ),
    );
  }
  const rows = await db
    .select()
    .from(suppliers)
    .where(and(...where))
    .orderBy(asc(suppliers.name), asc(suppliers.id));
  const counts = await db
    .select({ supplierId: itemSuppliers.supplierId, n: count() })
    .from(itemSuppliers)
    .innerJoin(items, and(eq(items.id, itemSuppliers.itemId), isNull(items.deletedAt)))
    .where(and(eq(itemSuppliers.workspaceId, workspaceId), isNull(itemSuppliers.deletedAt)))
    .groupBy(itemSuppliers.supplierId);
  const itemCount = new Map(counts.map((c) => [c.supplierId, c.n]));
  return rows.map((row) => ({ ...serializeSupplier(row), itemCount: itemCount.get(row.id) ?? 0 }));
}

async function findSupplier(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, id), eq(suppliers.workspaceId, workspaceId), isNull(suppliers.deletedAt)));
  if (!row) throw notFound("Supplier");
  return row;
}

export async function getSupplier(db: Database, workspaceId: string, id: string) {
  return serializeSupplier(await findSupplier(db, workspaceId, id));
}

async function assertSupplierCodeFree(tx: Transaction, workspaceId: string, code: string, exceptId?: string) {
  const [taken] = await tx
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(
      and(
        eq(suppliers.workspaceId, workspaceId),
        isNull(suppliers.deletedAt),
        sql`lower(${suppliers.code}) = lower(${code})`,
        exceptId ? ne(suppliers.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `Another supplier already uses the code "${code}"`);
}

export async function createSupplier(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: SupplierCreateInput,
) {
  return db.transaction(async (tx) => {
    // Check-then-insert on the code: queue behind other writers in this workspace.
    await lockWorkspaceLog(tx, workspaceId);
    if (input.code) await assertSupplierCodeFree(tx, workspaceId, input.code);
    const [row] = await tx
      .insert(suppliers)
      .values({ ...input, ...(input.id ? { id: input.id } : {}), workspaceId })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "supplier", entityId: row!.id, action: "upsert", data: serializeSupplier(row!) },
    ]);
    return serializeSupplier(row!);
  });
}

export async function updateSupplier(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: SupplierUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findSupplier(tx, workspaceId, id);
    if (patch.code) await assertSupplierCodeFree(tx, workspaceId, patch.code, id);
    const [row] = await tx.update(suppliers).set(patch).where(eq(suppliers.id, id)).returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "supplier", entityId: id, action: "upsert", data: serializeSupplier(row!) },
    ]);
    return serializeSupplier(row!);
  });
}

/**
 * Records an approval decision (BRCGS supplier approval). The caller must hold `manage` in the
 * module and be a signed-in person: the route refuses API tokens.
 */
export async function setSupplierApproval(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: SupplierApprovalInput,
  options: { active?: readonly ModuleId[] } = {},
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findSupplier(tx, workspaceId, id);
    // Under `block` enforcement, open control issues stop an approval unless overridden.
    const override =
      input.status === "approved"
        ? await checkSupplierControls(tx, workspaceId, id, "approval", {
            active: options.active ?? moduleIds,
            today: await workspaceToday(tx, workspaceId),
            override: input.controlsOverride,
            overrideAllowed: true,
          })
        : null;
    const [row] = await tx
      .update(suppliers)
      .set({
        approvalStatus: input.status,
        approvalChangedAt: new Date(),
        approvalChangedBy: actorId,
        approvalNote: input.note ?? null,
        approvalControlsOverride: override,
        ...(input.reviewDueOn !== undefined ? { reviewDueOn: input.reviewDueOn } : {}),
      })
      .where(eq(suppliers.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "supplier", entityId: id, action: "upsert", data: serializeSupplier(row!) },
    ]);
    return serializeSupplier(row!);
  });
}

/** Soft-deletes an unused supplier and its item links. Items stay. A supplier anything points at (see `supplierInUse`) can only be archived. */
export async function deleteSupplier(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    // Serialised with goods-in and recipe saves, so nothing starts using it between check and delete.
    await lockWorkspaceLog(tx, workspaceId);
    await findSupplier(tx, workspaceId, id);
    if (await supplierInUse(tx, id)) {
      throw new ApiError(
        409,
        "supplier_in_use",
        "This supplier is named on stock lots, purchase orders, invoices or non-conformances, so it can't be deleted. Archive it instead (set its approval status to rejected or suspended).",
      );
    }
    const now = new Date();
    await tx.update(suppliers).set({ deletedAt: now }).where(eq(suppliers.id, id));
    const links = await tx
      .update(itemSuppliers)
      .set({ deletedAt: now })
      .where(and(eq(itemSuppliers.supplierId, id), isNull(itemSuppliers.deletedAt)))
      .returning({ id: itemSuppliers.id });
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "supplier", entityId: id, action: "delete" },
      ...links.map((l): ChangeInput => ({ entity: "item_supplier", entityId: l.id, action: "delete" })),
    ]);
  });
}

// ─── Items ───────────────────────────────────────────────────────────────────

interface ItemSupplierView {
  supplierId: string;
  name: string;
  approvalStatus: SupplierRow["approvalStatus"];
  supplierCode: string | null;
  preferred: boolean;
}

function serializeItem(row: ItemRow, links: ItemSupplierView[]) {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return { ...rest, suppliers: links };
}

async function supplierLinks(db: Executor, itemIds: string[]) {
  const byItem = new Map<string, ItemSupplierView[]>();
  if (itemIds.length === 0) return byItem;
  const rows = await db
    .select({
      itemId: itemSuppliers.itemId,
      supplierId: suppliers.id,
      name: suppliers.name,
      approvalStatus: suppliers.approvalStatus,
      supplierCode: itemSuppliers.supplierCode,
      preferred: itemSuppliers.preferred,
    })
    .from(itemSuppliers)
    .innerJoin(suppliers, and(eq(suppliers.id, itemSuppliers.supplierId), isNull(suppliers.deletedAt)))
    .where(and(inArray(itemSuppliers.itemId, itemIds), isNull(itemSuppliers.deletedAt)))
    .orderBy(asc(suppliers.name));
  for (const { itemId, ...link } of rows) {
    const list = byItem.get(itemId) ?? [];
    list.push(link);
    byItem.set(itemId, list);
  }
  return byItem;
}

export async function listItems(db: Database, workspaceId: string, query: ItemListQuery, withFood = false) {
  const where: (SQL | undefined)[] = [eq(items.workspaceId, workspaceId), isNull(items.deletedAt)];
  if (query.type) where.push(eq(items.type, query.type));
  if (query.status !== "all") where.push(eq(items.status, query.status));
  if (query.q) {
    where.push(
      or(
        sql`${items.name} ilike ${like(query.q)} escape '!'`,
        sql`${items.code} ilike ${like(query.q)} escape '!'`,
      ),
    );
  }
  if (query.allergen) {
    const needle = JSON.stringify([query.allergen]);
    where.push(sql`exists (select 1 from ${foodItems}
      where ${foodItems.itemId} = ${items.id} and ${foodItems.workspaceId} = ${items.workspaceId}
      and (${foodItems.allergens} @> ${needle}::jsonb or ${foodItems.mayContain} @> ${needle}::jsonb))`);
  }
  if (query.supplierId) {
    where.push(
      sql`exists (select 1 from ${itemSuppliers} where ${itemSuppliers.itemId} = ${items.id}
        and ${itemSuppliers.supplierId} = ${query.supplierId} and ${itemSuppliers.deletedAt} is null)`,
    );
  }
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(items)
      .where(and(...where))
      .orderBy(asc(items.name), asc(items.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(items)
      .where(and(...where)),
  ]);
  const ids = rows.map((r) => r.id);
  const [links, food] = await Promise.all([
    supplierLinks(db, ids),
    withFood ? foodFieldsByItem(db, workspaceId, ids) : undefined,
  ]);
  return {
    items: rows.map((row) => ({
      ...serializeItem(row, links.get(row.id) ?? []),
      ...(food ? foodItemFields(food.get(row.id)) : {}),
    })),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

async function findItem(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(items)
    .where(and(eq(items.id, id), eq(items.workspaceId, workspaceId), isNull(items.deletedAt)));
  if (!row) throw notFound("Item");
  return row;
}

export async function getItem(db: Executor, workspaceId: string, id: string, withFood = false) {
  const row = await findItem(db, workspaceId, id);
  const [links, food] = await Promise.all([
    supplierLinks(db, [id]),
    withFood ? foodFieldsByItem(db, workspaceId, [id]) : undefined,
  ]);
  return {
    ...serializeItem(row, links.get(id) ?? []),
    ...(food ? foodItemFields(food.get(id)) : {}),
  };
}

async function assertItemCodeFree(tx: Transaction, workspaceId: string, code: string, exceptId?: string) {
  const [taken] = await tx
    .select({ id: items.id })
    .from(items)
    .where(
      and(
        eq(items.workspaceId, workspaceId),
        isNull(items.deletedAt),
        sql`lower(${items.code}) = lower(${code})`,
        exceptId ? ne(items.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `Another item already uses the code "${code}"`);
}

/** Replaces an item's supplier links, returning the sync changes. */
async function setItemSuppliers(
  tx: Transaction,
  workspaceId: string,
  itemId: string,
  links: NonNullable<ItemCreateInput["suppliers"]>,
): Promise<ChangeInput[]> {
  if (links.length) {
    const known = await tx
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(
        and(
          eq(suppliers.workspaceId, workspaceId),
          isNull(suppliers.deletedAt),
          inArray(
            suppliers.id,
            links.map((l) => l.supplierId),
          ),
        ),
      );
    if (known.length !== links.length) throw badRequest("Unknown supplierId");
  }
  const changes: ChangeInput[] = [];
  const now = new Date();
  const wanted = new Set(links.map((l) => l.supplierId));
  const existing = await tx
    .select()
    .from(itemSuppliers)
    .where(and(eq(itemSuppliers.itemId, itemId), isNull(itemSuppliers.deletedAt)));
  for (const row of existing) {
    if (wanted.has(row.supplierId)) continue;
    await tx.update(itemSuppliers).set({ deletedAt: now }).where(eq(itemSuppliers.id, row.id));
    changes.push({ entity: "item_supplier", entityId: row.id, action: "delete" });
  }
  for (const link of links) {
    const [row] = await tx
      .insert(itemSuppliers)
      .values({
        workspaceId,
        itemId,
        supplierId: link.supplierId,
        supplierCode: link.supplierCode ?? null,
        preferred: link.preferred ?? false,
      })
      .onConflictDoUpdate({
        target: [itemSuppliers.itemId, itemSuppliers.supplierId],
        set: {
          supplierCode: link.supplierCode ?? null,
          preferred: link.preferred ?? false,
          deletedAt: null,
          updatedAt: now,
        },
      })
      .returning();
    const { workspaceId: _ws, deletedAt: _deleted, ...data } = row!;
    changes.push({ entity: "item_supplier", entityId: row!.id, action: "upsert", data });
  }
  return changes;
}

export const itemChange = (row: ItemRow): ChangeInput => {
  const { workspaceId: _ws, deletedAt: _deleted, ...data } = row;
  return { entity: "item", entityId: row.id, action: "upsert", data };
};

export async function createItem(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: ItemCreateInput,
  withFood = false,
) {
  const { suppliers: links, id, allergens, mayContain, storage, shelfLifeDays, ...fields } = input;
  const food = { allergens, mayContain, storage, shelfLifeDays };
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertItemCodeFree(tx, workspaceId, fields.code);
    const [row] = await tx
      .insert(items)
      .values({ ...fields, ...(id ? { id } : {}), workspaceId })
      .returning();
    const linkChanges = links ? await setItemSuppliers(tx, workspaceId, row!.id, links) : [];
    const foodChanges = await saveFoodItem(tx, workspaceId, row!.id, food);
    await recordChanges(tx, workspaceId, actorId, [itemChange(row!), ...foodChanges, ...linkChanges]);
    return getItem(tx, workspaceId, row!.id, withFood);
  });
}

export async function updateItem(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: ItemUpdateInput,
  withFood = false,
) {
  const { suppliers: links, allergens, mayContain, storage, shelfLifeDays, ...fields } = patch;
  const food = { allergens, mayContain, storage, shelfLifeDays };
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findItem(tx, workspaceId, id);
    if (fields.code !== undefined) await assertItemCodeFree(tx, workspaceId, fields.code, id);
    // Stored quantities are in the dimension's base unit, so the dimension can never change.
    if (fields.unit && unitDimension(fields.unit) !== unitDimension(current.unit)) {
      throw new ApiError(
        409,
        "unit_dimension_fixed",
        `This item is measured by ${unitDimension(current.unit)}; its unit can't change to ${fields.unit}. Create a new item instead.`,
      );
    }
    const [row] = Object.keys(fields).length
      ? await tx.update(items).set(fields).where(eq(items.id, id)).returning()
      : // Supplier links only: still bump the item so readers see it changed.
        await tx.update(items).set({ updatedAt: new Date() }).where(eq(items.id, id)).returning();
    const linkChanges = links ? await setItemSuppliers(tx, workspaceId, id, links) : [];
    // A changed standard cost is kept in the item's cost history (costing) from today.
    const costChanges =
      fields.standardCost !== undefined && fields.standardCost !== current.standardCost
        ? await recordStandardCostChange(tx, workspaceId, actorId, current, fields.standardCost)
        : [];
    const foodChanges = await saveFoodItem(tx, workspaceId, id, food);
    await recordChanges(tx, workspaceId, actorId, [
      itemChange(row!),
      ...foodChanges,
      ...linkChanges,
      ...costChanges,
    ]);
    return getItem(tx, workspaceId, id, withFood);
  });
}

/**
 * Soft delete, for items that were never used. An item any other module points at (see
 * `itemInUse`) is refused: archive it (`status: "archived"`) instead.
 */
export async function deleteItem(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    // Serialised with goods-in and recipe saves, so nothing starts using it between check and delete.
    await lockWorkspaceLog(tx, workspaceId);
    await findItem(tx, workspaceId, id);
    if (await itemInUse(tx, id)) {
      throw new ApiError(
        409,
        "item_in_use",
        "This item has stock or is used on a recipe, demand, a batch, a purchase order, an invoice or a quality record, so it can't be deleted. Archive it instead.",
      );
    }
    const now = new Date();
    await tx.update(items).set({ deletedAt: now }).where(eq(items.id, id));
    const links = await tx
      .update(itemSuppliers)
      .set({ deletedAt: now })
      .where(and(eq(itemSuppliers.itemId, id), isNull(itemSuppliers.deletedAt)))
      .returning({ id: itemSuppliers.id });
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "item", entityId: id, action: "delete" },
      { entity: "food_item", entityId: id, action: "delete" },
      ...links.map((l): ChangeInput => ({ entity: "item_supplier", entityId: l.id, action: "delete" })),
    ]);
  });
}
