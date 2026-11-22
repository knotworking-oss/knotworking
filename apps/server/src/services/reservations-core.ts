import { despatchAllocated } from "./despatch-allocations";
import {
  fulfilReservations,
  lotLocationKey,
  reservationHeldOn,
  roundQuantity,
  type ReservationReleaseReason,
} from "@knotworking/core";
import {
  productionReservations,
  stockMovements,
  type ChangeInput,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, eq, gte, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { num } from "./ports/stock";
import { workspaceToday } from "./time-zone";

/**
 * The database side of stock reservations that the batch service needs (fulfilling and releasing)
 * and the production reads share (what is held per lot). No imports from production.ts, so the
 * batch service can use it. High-level operations live in production-reservations.ts.
 */

export type ReservationRow = typeof productionReservations.$inferSelect;

export function serializeReservation(row: ReservationRow) {
  const { workspaceId: _ws, ...rest } = row;
  return rest;
}

export const reservationChange = (row: ReservationRow): ChangeInput => ({
  entity: "production_reservation",
  entityId: row.id,
  action: "upsert",
  data: serializeReservation(row),
});

const held = sql<string>`sum(${productionReservations.quantity} - ${productionReservations.fulfilledQuantity})`;

interface ReservedOpts {
  lotIds?: string[];
  itemIds?: string[];
  exceptBatchIds?: string[];
  /** The workspace's day: reservations that expired before it hold nothing. Default: looked up. */
  today?: string;
  exceptDespatchId?: string;
}

const heldWhere = (workspaceId: string, opts: ReservedOpts, today: string) =>
  and(
    eq(productionReservations.workspaceId, workspaceId),
    eq(productionReservations.status, "active"),
    or(isNull(productionReservations.expiresOn), gte(productionReservations.expiresOn, today)),
    opts.lotIds ? inArray(productionReservations.lotId, opts.lotIds) : undefined,
    opts.itemIds ? inArray(productionReservations.itemId, opts.itemIds) : undefined,
    opts.exceptBatchIds?.length ? notInArray(productionReservations.batchId, opts.exceptBatchIds) : undefined,
  );

/**
 * Quantity held per lot by active reservations that have not expired (base unit), optionally for
 * some lots or items only, and leaving out some batches' reservations. Location reservations count
 * towards their lot's total.
 */
export async function reservedByLot(
  db: Executor,
  workspaceId: string,
  opts: ReservedOpts = {},
): Promise<Map<string, number>> {
  if (opts.lotIds && opts.lotIds.length === 0) return new Map();
  if (opts.itemIds && opts.itemIds.length === 0) return new Map();
  const today = opts.today ?? (await workspaceToday(db, workspaceId));
  const rows = await db
    .select({ lotId: productionReservations.lotId, total: held })
    .from(productionReservations)
    .where(heldWhere(workspaceId, opts, today))
    .groupBy(productionReservations.lotId);
  const result = new Map(rows.map((r) => [r.lotId, Math.max(num(r.total), 0)]));
  for (const [key, quantity] of (await despatchAllocated(db, workspaceId, opts)).lots)
    result.set(key, roundQuantity((result.get(key) ?? 0) + quantity));
  return result;
}

/** The part of `reservedByLot` that is tied to a location, keyed by `lotLocationKey`. */
export async function reservedByLotLocation(
  db: Executor,
  workspaceId: string,
  opts: ReservedOpts = {},
): Promise<Map<string, number>> {
  if (opts.lotIds && opts.lotIds.length === 0) return new Map();
  if (opts.itemIds && opts.itemIds.length === 0) return new Map();
  const today = opts.today ?? (await workspaceToday(db, workspaceId));
  const rows = await db
    .select({
      lotId: productionReservations.lotId,
      locationId: productionReservations.locationId,
      total: held,
    })
    .from(productionReservations)
    .where(and(heldWhere(workspaceId, opts, today), sql`${productionReservations.locationId} is not null`))
    .groupBy(productionReservations.lotId, productionReservations.locationId);
  const result = new Map(
    rows.map((r) => [lotLocationKey(r.lotId, r.locationId!), Math.max(num(r.total), 0)]),
  );
  for (const [key, quantity] of (await despatchAllocated(db, workspaceId, opts)).locations)
    result.set(key, roundQuantity((result.get(key) ?? 0) + quantity));
  return result;
}

/** Consumption of a lot by a batch fulfils that batch's active reservations of it, oldest first. */
export async function fulfilForConsumption(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  batchId: string,
  lotId: string,
  quantity: number,
  locationId?: string,
): Promise<ChangeInput[]> {
  const today = await workspaceToday(tx, workspaceId);
  const all = await tx
    .select()
    .from(productionReservations)
    .where(
      and(
        eq(productionReservations.workspaceId, workspaceId),
        eq(productionReservations.batchId, batchId),
        eq(productionReservations.lotId, lotId),
        eq(productionReservations.status, "active"),
      ),
    )
    .orderBy(asc(productionReservations.createdAt), asc(productionReservations.id));
  // Expired holds are left for the sweep. Where the stock came from decides which hold is used first:
  // one at that location, then the lot as a whole, then another location's.
  const rank = (r: ReservationRow) => (r.locationId === null ? 1 : r.locationId === locationId ? 0 : 2);
  const rows = all
    .filter((r) => !(r.expiresOn && r.expiresOn < today))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map((x) => x.r);
  const changes: ChangeInput[] = [];
  for (const step of fulfilReservations(rows, quantity)) {
    const [row] = await tx
      .update(productionReservations)
      .set({
        fulfilledQuantity: step.fulfilled,
        ...(step.done
          ? { status: "released", releasedAt: new Date(), releasedBy: actorId, releaseReason: "consumed" }
          : {}),
      })
      .where(eq(productionReservations.id, step.id))
      .returning();
    changes.push(reservationChange(row!));
  }
  return changes;
}

/** Releases what a batch still holds (it completed or was cancelled). */
export async function releaseBatchReservations(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  batchId: string,
  reason: ReservationReleaseReason,
): Promise<ChangeInput[]> {
  const rows = await tx
    .update(productionReservations)
    .set({ status: "released", releasedAt: new Date(), releasedBy: actorId, releaseReason: reason })
    .where(
      and(
        eq(productionReservations.workspaceId, workspaceId),
        eq(productionReservations.batchId, batchId),
        eq(productionReservations.status, "active"),
      ),
    )
    .returning();
  return rows.map(reservationChange);
}

/** What a reservation holds on `today`: nothing once released or expired. */
export const heldOf = (
  r: Pick<ReservationRow, "quantity" | "fulfilledQuantity" | "status" | "expiresOn">,
  today: string,
) => reservationHeldOn(r, today);

/**
 * Releases the active reservations whose last day has passed (reason `expired`; no one released
 * them, so `releasedBy` is empty). Callers run it inside a transaction and record the changes. Reads
 * never wait for it: expired holds already count for nothing.
 */
export async function releaseExpiredReservations(
  tx: Transaction,
  workspaceId: string,
  today: string,
): Promise<ReservationRow[]> {
  return tx
    .update(productionReservations)
    .set({ status: "released", releasedAt: new Date(), releasedBy: null, releaseReason: "expired" })
    .where(
      and(
        eq(productionReservations.workspaceId, workspaceId),
        eq(productionReservations.status, "active"),
        lt(productionReservations.expiresOn, today),
      ),
    )
    .returning();
}

/** On hand per lot, and per lot and location (`lotLocationKey`), from the ledger (base unit). */
export async function onHandOf(
  db: Executor,
  lotIds: string[],
): Promise<{ lots: Map<string, number>; locations: Map<string, number> }> {
  const lots = new Map<string, number>();
  const locations = new Map<string, number>();
  if (lotIds.length === 0) return { lots, locations };
  const rows = await db
    .select({
      lotId: stockMovements.lotId,
      locationId: stockMovements.locationId,
      total: sql<string>`sum(${stockMovements.quantity})`,
    })
    .from(stockMovements)
    .where(inArray(stockMovements.lotId, lotIds))
    .groupBy(stockMovements.lotId, stockMovements.locationId);
  for (const r of rows) {
    const q = num(r.total);
    locations.set(lotLocationKey(r.lotId, r.locationId), q);
    lots.set(r.lotId, roundQuantity((lots.get(r.lotId) ?? 0) + q));
  }
  return { lots, locations };
}
