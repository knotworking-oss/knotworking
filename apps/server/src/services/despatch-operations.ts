import {
  lotLocationKey,
  loadCheckPassed,
  newId,
  roundQuantity,
  stockAmount,
  type DespatchAllocationInput,
  type DespatchUnallocateInput,
  type DespatchPackInput,
  type DespatchLoadInput,
  type DespatchProofInput,
  type DespatchReturnInput,
  type DespatchReturnVoidInput,
  type DespatchOperations,
  type DespatchReturnView,
} from "@knotworking/core";
import {
  despatches,
  despatchLines,
  despatchHandlingUnits as packages,
  despatchOperationEvents as events,
  despatchProofs as proofs,
  despatchReturns as returns,
  qualityIncidents,
  qualityIncidentSnapshots,
  qualityIncidentHolds,
  qualityIncidentEvents,
  recordChanges,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { executeLedgerCommand } from "./ledger-command";
import { findDespatch, linesOf, getDespatch, despatchChange, recipient } from "./despatch";
import {
  findLot,
  findActiveLocation,
  assertAvailable,
  toBase,
  createLot,
  insertMovements,
  movementChange,
  lotChange,
} from "./ports/stock";
import { assertNoIncidentHold } from "./incident-holds";
import { reservedByLot, reservedByLotLocation, onHandOf } from "./reservations-core";
import { workspaceToday } from "./time-zone";

type Despatch = typeof despatches.$inferSelect;
async function editable(tx: Executor, ws: string, id: string, stamp?: string) {
  const row = await findDespatch(tx, ws, id);
  if (row.status !== "draft")
    throw new ApiError(409, "despatch_immutable", "This despatch is no longer a draft");
  if (stamp && row.updatedAt.toISOString() !== stamp)
    throw new ApiError(409, "draft_changed", "The draft changed. Reload and review it before signing.");
  return row;
}
async function log(
  tx: Transaction,
  ws: string,
  actor: string,
  row: Despatch,
  kind: string,
  data: Record<string, unknown>,
) {
  await tx.insert(events).values({ workspaceId: ws, despatchId: row.id, kind, data, actorId: actor });
  await recordChanges(tx, ws, actor, [despatchChange(row)]);
}
async function checkStock(tx: Transaction, ws: string, row: Despatch) {
  const lines = await linesOf(tx, ws, row.id);
  const today = await workspaceToday(tx, ws);
  await recipient(tx, ws, row.customerId, row.deliverySiteId);
  for (const line of lines) {
    const { lot, item } = await findLot(tx, ws, line.lotId);
    const location = await findActiveLocation(tx, ws, line.locationId);
    if (item.status !== "active" || item.type !== "finished")
      throw new ApiError(409, "item_not_despatchable", "Only active finished products can be allocated");
    await assertNoIncidentHold(tx, ws, lot.id);
    if (lot.status !== "available")
      throw new ApiError(409, "lot_not_released", `Lot ${lot.lotCode} is not released`);
    if (lot.expiresOn && lot.expiresOn < today)
      throw new ApiError(409, "lot_expired", `Lot ${lot.lotCode} has expired`);
    await assertAvailable(tx, lot.id, location, item, line.quantity, { exceptDespatchId: row.id });
    const opts = { lotIds: [lot.id], today, exceptDespatchId: row.id };
    const [held, heldAt, hand] = await Promise.all([
      reservedByLot(tx, ws, opts),
      reservedByLotLocation(tx, ws, opts),
      onHandOf(tx, [lot.id]),
    ]);
    const key = lotLocationKey(lot.id, location.id);
    if (
      roundQuantity((hand.lots.get(lot.id) ?? 0) - (held.get(lot.id) ?? 0)) < line.quantity ||
      roundQuantity((hand.locations.get(key) ?? 0) - (heldAt.get(key) ?? 0)) < line.quantity
    )
      throw new ApiError(
        409,
        "stock_reserved",
        "This stock is allocated to another despatch or reserved for production",
      );
  }
  return lines;
}
export async function allocateDespatch(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: DespatchAllocationInput,
) {
  return executeLedgerCommand(db, ws, actor, "despatch.allocate", input, { id, ...input }, async (tx) => {
    const row = await editable(tx, ws, id, input.expectedUpdatedAt);
    if (row.allocatedAt)
      throw new ApiError(409, "already_allocated", "Release the existing allocation before allocating again");
    const allocatedLines = await checkStock(tx, ws, row);
    const customer = await recipient(tx, ws, row.customerId, row.deliverySiteId);
    const [updated] = await tx
      .update(despatches)
      .set({
        updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)),
        ...customer,
        ...(row.deliverySiteId
          ? { deliveryAddress: customer.deliveryAddress }
          : { deliveryAddress: row.deliveryAddress }),
        allocatedAt: new Date(),
        allocatedBy: actor,
      })
      .where(eq(despatches.id, id))
      .returning();
    await log(tx, ws, actor, updated!, "allocation", { note: input.note, lines: allocatedLines });
    return getDespatch(tx, ws, id);
  });
}
export async function unallocateDespatch(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: DespatchUnallocateInput,
) {
  return executeLedgerCommand(db, ws, actor, "despatch.unallocate", input, { id, ...input }, async (tx) => {
    const row = await editable(tx, ws, id, input.expectedUpdatedAt);
    if (!row.allocatedAt) throw badRequest("This draft has no active allocation");
    await tx
      .update(packages)
      .set({ supersededAt: new Date() })
      .where(and(eq(packages.workspaceId, ws), eq(packages.despatchId, id), isNull(packages.supersededAt)));
    const [updated] = await tx
      .update(despatches)
      .set({
        updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)),
        allocatedAt: null,
        allocatedBy: null,
        packedAt: null,
        packedBy: null,
        loadCheck: null,
        loadCheckedAt: null,
        loadCheckedBy: null,
      })
      .where(eq(despatches.id, id))
      .returning();
    await log(tx, ws, actor, updated!, "unallocation", { note: input.note });
    return getDespatch(tx, ws, id);
  });
}
export async function packDespatch(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: DespatchPackInput,
) {
  return executeLedgerCommand(db, ws, actor, "despatch.pack", input, { id, ...input }, async (tx) => {
    const row = await editable(tx, ws, id, input.expectedUpdatedAt);
    if (!row.allocatedAt || row.packedAt)
      throw badRequest("Pack an allocated draft once; release its allocation to correct packing");
    const lines = await checkStock(tx, ws, row);
    const totals = new Map<string, number>();
    for (const p of input.packages) {
      if (new Set(p.contents.map((c) => c.lineId)).size !== p.contents.length)
        throw badRequest("Combine each line into one quantity per handling unit");
      const contents = [];
      if (p.sscc) {
        const [used] = await tx
          .select({ id: packages.id })
          .from(packages)
          .where(and(eq(packages.workspaceId, ws), eq(packages.sscc, p.sscc)));
        if (used)
          throw new ApiError(
            409,
            "sscc_used",
            "That SSCC has already identified a handling unit; use a newly assigned SSCC",
          );
      }
      for (const c of p.contents) {
        const line = lines.find((l) => l.id === c.lineId);
        if (!line) throw badRequest("Unknown packing line");
        const { item } = await findLot(tx, ws, line.lotId);
        const quantity = toBase(c.quantity, c.unit, item);
        totals.set(line.id, roundQuantity((totals.get(line.id) ?? 0) + quantity));
        contents.push({ lineId: line.id, quantity });
      }
      await tx.insert(packages).values({
        workspaceId: ws,
        despatchId: id,
        reference: p.reference,
        sscc: p.sscc ?? null,
        contents,
        createdBy: actor,
      });
    }
    if (lines.some((l) => totals.get(l.id) !== l.quantity))
      throw badRequest("Packed quantities must exactly cover every allocated despatch line");
    const [updated] = await tx
      .update(despatches)
      .set({
        updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)),
        packedAt: new Date(),
        packedBy: actor,
        loadCheck: null,
        loadCheckedAt: null,
        loadCheckedBy: null,
      })
      .where(eq(despatches.id, id))
      .returning();
    await log(tx, ws, actor, updated!, "pack", { note: input.note, packages: input.packages, lines });
    return getDespatch(tx, ws, id);
  });
}
export async function checkDespatchLoad(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: DespatchLoadInput,
) {
  return executeLedgerCommand(db, ws, actor, "despatch.load", input, { id, ...input }, async (tx) => {
    const row = await editable(tx, ws, id, input.expectedUpdatedAt);
    if (!row.packedAt) throw badRequest("Pack this despatch before recording its load check");
    await checkStock(tx, ws, row);
    const [updated] = await tx
      .update(despatches)
      .set({
        updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)),
        loadCheck: input,
        loadCheckedAt: new Date(),
        loadCheckedBy: actor,
      })
      .where(eq(despatches.id, id))
      .returning();
    await log(tx, ws, actor, updated!, "load_check", { ...input, passed: loadCheckPassed(input) });
    return getDespatch(tx, ws, id);
  });
}
export async function recordDespatchProof(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: DespatchProofInput,
) {
  return executeLedgerCommand(db, ws, actor, "despatch.proof", input, { id, ...input }, async (tx) => {
    const row = await findDespatch(tx, ws, id);
    if (row.status !== "confirmed") throw badRequest("Record delivery evidence against a confirmed despatch");
    if (new Date(input.deliveredAt).getTime() > Date.now())
      throw badRequest("Delivery evidence cannot be dated in the future");
    const [previous] = await tx
      .select()
      .from(proofs)
      .where(and(eq(proofs.workspaceId, ws), eq(proofs.despatchId, id)))
      .orderBy(desc(proofs.createdAt), desc(proofs.id))
      .limit(1);
    if ((previous?.id ?? undefined) !== input.supersedesId)
      throw new ApiError(
        409,
        "proof_changed",
        "Reload and explicitly replace the latest delivery proof with a correction reason",
      );
    const lines = await linesOf(tx, ws, id);
    if (
      input.lines.length !== lines.length ||
      new Set(input.lines.map((l) => l.lineId)).size !== lines.length
    )
      throw badRequest("Record cumulative delivery/refusal quantities for every line once");
    const normalized: DespatchProofInput["lines"] = [];
    for (const p of input.lines) {
      const line = lines.find((l) => l.id === p.lineId);
      if (!line) throw badRequest("Unknown delivery line");
      const { item } = await findLot(tx, ws, line.lotId);
      const delivered = toBase(p.deliveredQuantity, p.unit, item, { allowZero: true }),
        refused = toBase(p.refusedQuantity, p.unit, item, { allowZero: true });
      if (roundQuantity(delivered + refused) > line.quantity)
        throw badRequest("Delivery and refusal quantities exceed the original despatch");
      normalized.push({
        lineId: line.id,
        deliveredQuantity: stockAmount(delivered, { unit: line.itemUnit }).display,
        refusedQuantity: stockAmount(refused, { unit: line.itemUnit }).display,
        unit: line.itemUnit,
      });
    }
    await tx
      .insert(proofs)
      .values({ workspaceId: ws, despatchId: id, data: { ...input, lines: normalized }, actorId: actor });
    await recordChanges(tx, ws, actor, [despatchChange(row)]);
    return getDespatchOperations(tx, ws, id);
  });
}
export async function returnViews(
  db: Executor,
  ws: string,
  lineIds: string[],
): Promise<DespatchReturnView[]> {
  if (!lineIds.length) return [];
  const rows = await db
    .select()
    .from(returns)
    .where(and(eq(returns.workspaceId, ws), inArray(returns.lineId, lineIds)))
    .orderBy(asc(returns.createdAt), asc(returns.id));
  return rows.map((r) => ({
    id: r.id,
    lineId: r.lineId,
    lotId: r.lotId,
    originalLotId: r.originalLotId,
    lotCode: r.lotCode,
    receivedOn: r.receivedOn,
    quantity: stockAmount(r.quantity, { unit: r.itemUnit }).display,
    unit: r.itemUnit,
    reason: r.reason,
    condition: r.condition,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
    voidedAt: r.voidedAt?.toISOString() ?? null,
    voidReason: r.voidReason,
    incidentId: r.incidentId,
  }));
}
export async function getDespatchOperations(
  db: Executor,
  ws: string,
  id: string,
): Promise<DespatchOperations> {
  await findDespatch(db, ws, id);
  const [pp, ee, proof] = await Promise.all([
    db
      .select()
      .from(packages)
      .where(and(eq(packages.workspaceId, ws), eq(packages.despatchId, id)))
      .orderBy(asc(packages.createdAt), asc(packages.id)),
    db
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, ws), eq(events.despatchId, id)))
      .orderBy(asc(events.createdAt), asc(events.id)),
    db
      .select()
      .from(proofs)
      .where(and(eq(proofs.workspaceId, ws), eq(proofs.despatchId, id)))
      .orderBy(asc(proofs.createdAt), asc(proofs.id)),
  ]);
  const lines = await linesOf(db, ws, id);
  return {
    packages: pp.map((p) => ({
      id: p.id,
      reference: p.reference,
      sscc: p.sscc,
      contents: p.contents,
      supersededAt: p.supersededAt?.toISOString() ?? null,
    })),
    events: ee.map((e) => ({
      id: e.id,
      kind: e.kind,
      data: e.data,
      createdAt: e.createdAt.toISOString(),
      actorId: e.actorId,
    })),
    proofs: proof.map((p) => ({
      id: p.id,
      data: p.data,
      createdAt: p.createdAt.toISOString(),
      actorId: p.actorId,
    })),
    returns: await returnViews(
      db,
      ws,
      lines.map((l) => l.id),
    ),
  };
}
export async function receiveDespatchReturn(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: DespatchReturnInput,
) {
  return executeLedgerCommand(db, ws, actor, "despatch.return", input, { id, ...input }, async (tx) => {
    const row = await findDespatch(tx, ws, id);
    if (row.status !== "confirmed") throw badRequest("Receive returns against a confirmed despatch");
    const lines = await linesOf(tx, ws, id);
    const line = lines.find((l) => l.id === input.lineId);
    if (!line) throw notFound("Despatch line");
    const { lot: original, item } = await findLot(tx, ws, line.lotId);
    const location = await findActiveLocation(tx, ws, input.locationId);
    const quantity = toBase(input.quantity, input.unit, item);
    const today = await workspaceToday(tx, ws);
    if (input.receivedOn > today || input.receivedOn < row.despatchedOn)
      throw badRequest("Return date must be between the original despatch date and today");
    const [received] = await tx
      .select({ total: sql<string>`coalesce(sum(${returns.quantity}),0)` })
      .from(returns)
      .where(and(eq(returns.workspaceId, ws), eq(returns.lineId, line.id), isNull(returns.voidedAt)));
    if (roundQuantity(Number(received?.total ?? 0) + quantity) > line.quantity)
      throw new ApiError(
        409,
        "return_quantity_exceeded",
        "Physical returns exceed the quantity originally despatched on this line",
      );
    if (input.incidentId) {
      const [incident] = await tx
        .select()
        .from(qualityIncidents)
        .where(and(eq(qualityIncidents.workspaceId, ws), eq(qualityIncidents.id, input.incidentId)));
      if (!incident || incident.status !== "open")
        throw badRequest("Choose an open incident case from this workspace");
      const ss = await tx
        .select()
        .from(qualityIncidentSnapshots)
        .where(
          and(
            eq(qualityIncidentSnapshots.workspaceId, ws),
            eq(qualityIncidentSnapshots.incidentId, input.incidentId),
          ),
        );
      if (!ss.some((s) => s.report.deliveries.lines.some((l) => l.lineId === line.id)))
        throw badRequest("That case does not contain this delivery in its distribution snapshots");
    }
    const now = new Date();
    const lot = await createLot(tx, ws, actor, item, {
      lotCode: `RET-${newId()}`,
      receivedOn: input.receivedOn,
      expiresOn: original.expiresOn,
      expiryType: original.expiryType,
      status: "quarantine",
      statusNote: `Customer return from ${row.reference}; awaiting QA disposition`,
      notes: input.condition,
      now,
    });
    const [movement] = await insertMovements(tx, ws, [
      {
        lotId: lot.id,
        itemId: item.id,
        locationId: location.id,
        quantity,
        type: "customer_return",
        reason: input.reason,
        reference: row.reference,
        actorId: actor,
      },
    ]);
    await tx.insert(returns).values({
      workspaceId: ws,
      despatchId: id,
      lineId: line.id,
      originalLotId: line.lotId,
      lotId: lot.id,
      lotCode: lot.lotCode,
      locationId: location.id,
      quantity,
      itemUnit: line.itemUnit,
      movementId: movement!.id,
      receivedOn: input.receivedOn,
      reason: input.reason,
      condition: input.condition,
      incidentId: input.incidentId ?? null,
      createdBy: actor,
    });
    const inherited = await tx
      .selectDistinct({ incidentId: qualityIncidentHolds.incidentId })
      .from(qualityIncidentHolds)
      .where(
        and(
          eq(qualityIncidentHolds.workspaceId, ws),
          eq(qualityIncidentHolds.lotId, line.lotId),
          isNull(qualityIncidentHolds.releasedAt),
        ),
      );
    const caseIds = new Set(inherited.map((h) => h.incidentId));
    if (input.incidentId) caseIds.add(input.incidentId);
    for (const incidentId of caseIds) {
      await tx
        .insert(qualityIncidentHolds)
        .values({ workspaceId: ws, incidentId, lotId: lot.id })
        .onConflictDoNothing();
      await tx.insert(qualityIncidentEvents).values({
        workspaceId: ws,
        incidentId,
        actorId: actor,
        data: {
          commandId: input.commandId,
          kind: "containment",
          lotId: lot.id,
          note: `Physical return received into quarantine from ${row.reference}: ${input.quantity} ${input.unit}. ${input.reason}`,
        },
      });
    }
    await recordChanges(tx, ws, actor, [
      movementChange(movement!),
      lotChange(lot),
      despatchChange(row),
      ...[...caseIds].map((incidentId) => ({
        entity: "quality_incident" as const,
        entityId: incidentId,
        action: "upsert" as const,
        data: { id: incidentId, status: "open" },
      })),
    ]);
    return getDespatchOperations(tx, ws, id);
  });
}
export async function voidDespatchReturn(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  returnId: string,
  input: DespatchReturnVoidInput,
) {
  return executeLedgerCommand(
    db,
    ws,
    actor,
    "despatch.return.void",
    input,
    { id, returnId, ...input },
    async (tx) => {
      const row = await findDespatch(tx, ws, id);
      const [ret] = await tx
        .select()
        .from(returns)
        .where(and(eq(returns.workspaceId, ws), eq(returns.despatchId, id), eq(returns.id, returnId)));
      if (!ret) throw notFound("Return receipt");
      if (ret.voidedAt)
        throw new ApiError(409, "return_voided", "This return receipt has already been corrected");
      const { item } = await findLot(tx, ws, ret.lotId);
      const location = await findActiveLocation(tx, ws, ret.locationId);
      await assertAvailable(tx, ret.lotId, location, item, ret.quantity);
      const [movement] = await insertMovements(tx, ws, [
        {
          lotId: ret.lotId,
          itemId: item.id,
          locationId: location.id,
          quantity: -ret.quantity,
          type: "customer_return",
          reversesMovementId: ret.movementId,
          reference: row.reference,
          reason: input.reason,
          actorId: actor,
        },
      ]);
      await tx
        .update(returns)
        .set({
          voidedAt: new Date(),
          voidedBy: actor,
          voidReason: input.reason,
          reversalMovementId: movement!.id,
        })
        .where(eq(returns.id, returnId));
      await recordChanges(tx, ws, actor, [movementChange(movement!), despatchChange(row)]);
      return getDespatchOperations(tx, ws, id);
    },
  );
}
