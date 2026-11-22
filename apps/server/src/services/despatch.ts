import { findDeliverySite } from "./customer-sites";
import { assertNoIncidentHold } from "./incident-holds";
import {
  lotLocationKey,
  loadCheckPassed,
  roundQuantity,
  stockAmount,
  type DespatchConfirmInput,
  type DespatchDraftInput,
  type DespatchListQuery,
  type DespatchRecipientQuery,
  type DespatchVoidInput,
} from "@knotworking/core";
import {
  despatches,
  despatchLines,
  despatchReturns,
  despatchProofs,
  despatchHandlingUnits,
  lockWorkspaceLog,
  recordChanges,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { findCustomer } from "./customers";
import { executeLedgerCommand } from "./ledger-command";
import { onHandOf, reservedByLot, reservedByLotLocation } from "./reservations-core";
import {
  assertAvailable,
  findActiveLocation,
  findLot,
  insertMovements,
  movementChange,
  toBase,
} from "./stock-ledger";
import { workspaceToday } from "./time-zone";

type Despatch = typeof despatches.$inferSelect;
const view = ({ workspaceId: _ws, ...row }: Despatch) => row;
// Only invalidation metadata: no recipient names, contacts, addresses, notes or line snapshots.
export const despatchChange = (row: Despatch): ChangeInput => ({
  entity: "despatch",
  entityId: row.id,
  action: "upsert",
  data: {
    id: row.id,
    reference: row.reference,
    customerId: row.customerId,
    status: row.status,
    despatchedOn: row.despatchedOn,
    updatedAt: row.updatedAt,
  },
});

export async function findDespatch(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(despatches)
    .where(and(eq(despatches.workspaceId, workspaceId), eq(despatches.id, id)));
  if (!row) throw notFound("Despatch");
  return row;
}
export const linesOf = (db: Executor, workspaceId: string, id: string) =>
  db
    .select()
    .from(despatchLines)
    .where(and(eq(despatchLines.workspaceId, workspaceId), eq(despatchLines.despatchId, id)))
    .orderBy(asc(despatchLines.id));

export async function getDespatch(db: Executor, workspaceId: string, id: string) {
  const row = await findDespatch(db, workspaceId, id);
  const lines = await linesOf(db, workspaceId, id);
  return {
    ...view(row),
    lines: lines.map(({ workspaceId: _ws, ...line }) => ({
      ...line,
      amount: stockAmount(line.quantity, { unit: line.itemUnit }),
    })),
  };
}

export async function listDespatches(db: Database, workspaceId: string, query: DespatchListQuery) {
  const where = and(
    eq(despatches.workspaceId, workspaceId),
    query.status === "all" ? undefined : eq(despatches.status, query.status),
    query.customerId ? eq(despatches.customerId, query.customerId) : undefined,
    query.from ? gte(despatches.despatchedOn, query.from) : undefined,
    query.to ? lte(despatches.despatchedOn, query.to) : undefined,
  );
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(despatches)
      .where(where)
      .orderBy(desc(despatches.despatchedOn), desc(despatches.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(despatches).where(where),
  ]);
  return { despatches: rows.map(view), total: total?.n ?? 0, limit: query.limit, offset: query.offset };
}

export async function recipient(
  db: Executor,
  workspaceId: string,
  customerId: string,
  siteId?: string | null,
) {
  const c = await findCustomer(db, workspaceId, customerId);
  if (c.status !== "active") throw new ApiError(409, "customer_archived", "Choose an active customer");
  const site = siteId ? await findDeliverySite(db, workspaceId, customerId, siteId) : null;
  if (site?.status === "archived") throw new ApiError(409, "site_archived", "Choose an active delivery site");
  return {
    deliverySiteId: site?.id ?? null,
    deliverySiteCode: site?.code ?? null,
    deliverySiteName: site?.name ?? null,
    deliveryAddress: site?.address ?? c.address,
    customerId: c.id,
    customerCode: c.code,
    customerName: c.name,
    customerAddress: c.address,
    contactName: site?.contactName ?? c.contactName,
    email: site?.email ?? c.email,
    phone: site?.phone ?? c.phone,
  };
}

async function draftLines(db: Executor, workspaceId: string, input: DespatchDraftInput) {
  const lines = [];
  for (const line of input.lines) {
    const { lot, item } = await findLot(db, workspaceId, line.lotId);
    const location = await findActiveLocation(db, workspaceId, line.locationId);
    if (item.type !== "finished" || item.status !== "active")
      throw new ApiError(409, "item_not_despatchable", "Choose an active finished product");
    lines.push({
      lotId: lot.id,
      locationId: location.id,
      itemId: item.id,
      itemCode: item.code,
      itemName: item.name,
      lotCode: lot.lotCode,
      locationName: location.name,
      quantity: toBase(line.quantity, line.unit, item, { max: 1_000_000_000_000 }),
      itemUnit: item.unit,
      expiresOn: lot.expiresOn,
    });
  }
  return lines;
}

/** Drafts commit no stock. Confirmation revalidates customer, lots, expiry and balances. */
export async function saveDespatchDraft(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: DespatchDraftInput,
  id?: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const existing = id ? await findDespatch(tx, workspaceId, id) : null;
    if (existing && existing.status !== "draft")
      throw new ApiError(409, "despatch_immutable", "Only a draft can be edited");
    if (existing?.allocatedAt)
      throw new ApiError(409, "despatch_allocated", "Release the allocation before editing this draft");
    const customer = await recipient(tx, workspaceId, input.customerId, input.deliverySiteId);
    const lines = await draftLines(tx, workspaceId, input);
    const header = {
      ...customer,
      deliveryAddress: input.deliverySiteId
        ? customer.deliveryAddress
        : (input.deliveryAddress ?? customer.customerAddress),
      despatchedOn: input.despatchedOn,
      externalReference: input.externalReference ?? null,
      notes: input.notes ?? null,
    };
    let row: Despatch;
    if (existing) {
      [row] = (await tx
        .update(despatches)
        .set({ ...header, updatedAt: new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1)) })
        .where(eq(despatches.id, existing.id))
        .returning()) as [Despatch];
      await tx.delete(despatchLines).where(eq(despatchLines.despatchId, existing.id));
    } else {
      const prefix = `DN-${(await workspaceToday(tx, workspaceId)).slice(0, 4)}-`;
      const [last] = await tx
        .select({ n: count() })
        .from(despatches)
        .where(
          and(eq(despatches.workspaceId, workspaceId), sql`${despatches.reference} like ${`${prefix}%`}`),
        );
      [row] = (await tx
        .insert(despatches)
        .values({
          ...header,
          workspaceId,
          createdBy: actorId,
          reference: `${prefix}${String((last?.n ?? 0) + 1).padStart(6, "0")}`,
        })
        .returning()) as [Despatch];
    }
    await tx
      .insert(despatchLines)
      .values(lines.map((line) => ({ ...line, workspaceId, despatchId: row.id })));
    await recordChanges(tx, workspaceId, actorId, [despatchChange(row)]);
    return getDespatch(tx, workspaceId, row.id);
  });
}

/** Person-confirmed physical despatch; the receipt makes a lost-response retry safe. */
export async function confirmDespatch(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: DespatchConfirmInput,
) {
  return executeLedgerCommand(
    db,
    workspaceId,
    actorId,
    "despatch.confirm",
    input,
    { id, ...input },
    async (tx) => {
      const row = await findDespatch(tx, workspaceId, id);
      if (row.status !== "draft")
        throw new ApiError(409, "despatch_immutable", "This despatch is no longer a draft");
      if (row.updatedAt.toISOString() !== input.expectedUpdatedAt)
        throw new ApiError(
          409,
          "draft_changed",
          "This draft changed since you opened it. Reload and check the current delivery before confirming.",
        );
      const customer = await recipient(tx, workspaceId, row.customerId, row.deliverySiteId);
      if (
        customer.customerName !== row.customerName ||
        customer.customerAddress !== row.customerAddress ||
        customer.contactName !== row.contactName ||
        customer.email !== row.email ||
        customer.phone !== row.phone ||
        (row.deliverySiteId &&
          (customer.deliveryAddress !== row.deliveryAddress ||
            customer.deliverySiteName !== row.deliverySiteName))
      )
        throw new ApiError(
          409,
          "recipient_changed",
          "The customer or delivery site changed after allocation. Release the allocation and review the new details.",
        );
      const today = await workspaceToday(tx, workspaceId);
      if (row.despatchedOn > today) throw badRequest("A despatch cannot be confirmed in the future");
      if (row.loadCheckedAt && (await workspaceToday(tx, workspaceId, row.loadCheckedAt)) !== today)
        throw new ApiError(
          409,
          "load_check_expired",
          "Record a fresh load check on the workspace business day of confirmation",
        );
      const lines = await linesOf(tx, workspaceId, id);
      if (!lines.length) throw badRequest("Add at least one despatch line");
      const changes: ChangeInput[] = [];
      for (const line of lines) {
        const { lot, item } = await findLot(tx, workspaceId, line.lotId);
        const location = await findActiveLocation(tx, workspaceId, line.locationId);
        if (item.type !== "finished" || item.status !== "active")
          throw new ApiError(409, "item_not_despatchable", "Only active finished products can be despatched");
        await assertNoIncidentHold(tx, workspaceId, lot.id);
        if (lot.status !== "available")
          throw new ApiError(409, "lot_not_released", `Lot ${lot.lotCode} is not released`);
        if (lot.expiresOn && lot.expiresOn < today)
          throw new ApiError(409, "lot_expired", `Lot ${lot.lotCode} has expired`);
        await assertAvailable(tx, lot.id, location, item, line.quantity, { exceptDespatchId: row.id });
        // All production holds apply, even if production is not visible to this caller.
        const opts = { lotIds: [lot.id], today, exceptDespatchId: row.id };
        const held = await reservedByLot(tx, workspaceId, opts);
        const heldAt = await reservedByLotLocation(tx, workspaceId, opts);
        const hand = await onHandOf(tx, [lot.id]);
        const key = lotLocationKey(lot.id, location.id);
        if (
          roundQuantity((hand.lots.get(lot.id) ?? 0) - (held.get(lot.id) ?? 0)) < line.quantity ||
          roundQuantity((hand.locations.get(key) ?? 0) - (heldAt.get(key) ?? 0)) < line.quantity
        )
          throw new ApiError(
            409,
            "stock_reserved",
            "This stock is reserved for production; choose unreserved stock",
          );
        const [movement] = await insertMovements(tx, workspaceId, [
          {
            lotId: lot.id,
            itemId: item.id,
            locationId: location.id,
            quantity: -line.quantity,
            type: "despatch",
            reference: row.reference,
            actorId,
          },
        ]);
        await tx
          .update(despatchLines)
          .set({
            movementId: movement!.id,
            itemCode: item.code,
            itemName: item.name,
            itemUnit: item.unit,
            lotCode: lot.lotCode,
            locationName: location.name,
            expiresOn: lot.expiresOn,
          })
          .where(eq(despatchLines.id, line.id));
        changes.push(movementChange(movement!));
      }
      if (!row.allocatedAt || !row.packedAt || !row.loadCheck || !loadCheckPassed(row.loadCheck))
        throw new ApiError(
          409,
          "fulfilment_incomplete",
          "Allocate, pack and sign a passing load check before confirming this despatch",
        );
      const [confirmed] = await tx
        .update(despatches)
        .set({
          ...customer,
          deliveryAddress: row.deliveryAddress,
          status: "confirmed",
          confirmedBy: actorId,
          confirmedAt: new Date(),
        })
        .where(eq(despatches.id, id))
        .returning();
      await recordChanges(tx, workspaceId, actorId, [...changes, despatchChange(confirmed!)]);
      return getDespatch(tx, workspaceId, id);
    },
  );
}

/** Correct a recording mistake; a physical return needs a separate quarantine workflow. */
export async function voidDespatch(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: DespatchVoidInput,
) {
  return executeLedgerCommand(
    db,
    workspaceId,
    actorId,
    "despatch.void",
    input,
    { id, ...input },
    async (tx) => {
      const row = await findDespatch(tx, workspaceId, id);
      if (row.status === "voided")
        throw new ApiError(409, "already_voided", "This despatch has already been voided");
      const changes: ChangeInput[] = [];
      const [physicalReturn] = await tx
        .select({ id: despatchReturns.id })
        .from(despatchReturns)
        .where(
          and(
            eq(despatchReturns.workspaceId, workspaceId),
            eq(despatchReturns.despatchId, id),
            sql`${despatchReturns.voidedAt} is null`,
          ),
        )
        .limit(1);
      const [proof] = await tx
        .select({ id: despatchProofs.id })
        .from(despatchProofs)
        .where(and(eq(despatchProofs.workspaceId, workspaceId), eq(despatchProofs.despatchId, id)))
        .limit(1);
      if (physicalReturn || proof)
        throw new ApiError(
          409,
          "despatch_has_evidence",
          "This despatch has delivery proof or active return receipts. Retain the physical shipment history and correct its evidence through the relevant workflow.",
        );
      await tx
        .update(despatchHandlingUnits)
        .set({ supersededAt: new Date() })
        .where(
          and(
            eq(despatchHandlingUnits.workspaceId, workspaceId),
            eq(despatchHandlingUnits.despatchId, id),
            sql`${despatchHandlingUnits.supersededAt} is null`,
          ),
        );
      if (row.status === "confirmed") {
        for (const line of await linesOf(tx, workspaceId, id)) {
          await findActiveLocation(tx, workspaceId, line.locationId);
          const [movement] = await insertMovements(tx, workspaceId, [
            {
              lotId: line.lotId,
              itemId: line.itemId,
              locationId: line.locationId,
              quantity: line.quantity,
              type: "despatch",
              reference: row.reference,
              reason: input.reason,
              reversesMovementId: line.movementId!,
              actorId,
            },
          ]);
          await tx
            .update(despatchLines)
            .set({ reversalMovementId: movement!.id })
            .where(eq(despatchLines.id, line.id));
          changes.push(movementChange(movement!));
        }
      }
      const [voided] = await tx
        .update(despatches)
        .set({ status: "voided", voidedBy: actorId, voidedAt: new Date(), voidReason: input.reason })
        .where(eq(despatches.id, id))
        .returning();
      await recordChanges(tx, workspaceId, actorId, [...changes, despatchChange(voided!)]);
      return getDespatch(tx, workspaceId, id);
    },
  );
}

/** Direct recipients only. Ingredient-to-output impact analysis follows in Phase 3.1. */
export async function lotRecipients(
  db: Database,
  workspaceId: string,
  lotId: string,
  query: DespatchRecipientQuery,
) {
  const { lot, item } = await findLot(db, workspaceId, lotId);
  const where = and(
    eq(despatchLines.workspaceId, workspaceId),
    eq(despatchLines.lotId, lotId),
    eq(despatches.status, "confirmed"),
  );
  const [rows, [total]] = await Promise.all([
    db
      .select({ despatch: despatches, line: despatchLines })
      .from(despatchLines)
      .innerJoin(
        despatches,
        and(eq(despatches.id, despatchLines.despatchId), eq(despatches.workspaceId, workspaceId)),
      )
      .where(where)
      .orderBy(asc(despatches.despatchedOn), asc(despatchLines.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(despatchLines)
      .innerJoin(despatches, eq(despatches.id, despatchLines.despatchId))
      .where(where),
  ]);
  return {
    lotId: lot.id,
    lotCode: lot.lotCode,
    itemCode: item.code,
    scope: "direct_lot_only" as const,
    recipients: rows.map(({ despatch: d, line }) => ({
      despatchId: d.id,
      reference: d.reference,
      despatchedOn: d.despatchedOn,
      customerId: d.customerId,
      customerCode: d.customerCode,
      customerName: d.customerName,
      customerAddress: d.customerAddress,
      deliveryAddress: d.deliveryAddress,
      contactName: d.contactName,
      email: d.email,
      phone: d.phone,
      externalReference: d.externalReference,
      amount: stockAmount(line.quantity, { unit: line.itemUnit }),
    })),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}
