import { lotLocationKey, type NotificationData } from "@knotworking/core";
import {
  items,
  productionBatches,
  productionReservations,
  stockLocations,
  stockLots,
  type Executor,
} from "@knotworking/db";
import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { audience, insertNotifications, memberAccess, type NotificationDraft } from "./notifications";
import { onHandOf, reservedByLot, reservedByLotLocation } from "./reservations-core";

/**
 * Reserved stock at risk: a lot reserved for a batch goes into quarantine or is rejected, or there is
 * no longer enough of it to cover what is reserved (it ran out). The same finder serves the write
 * path (a lot's status changes, in the same transaction) and the sweep (everything, including stock
 * that ran out through waste, adjustments, stocktakes or other batches). Dedupe keys name the
 * reservation and the problem, so each is told once however it is found.
 */

export type ReservedLotProblem = "quarantine" | "rejected" | "short";

export interface ReservedLotAlert {
  reservationId: string;
  createdBy: string | null;
  batchId: string;
  batchCode: string;
  lotId: string;
  lotCode: string;
  itemName: string;
  locationName: string | null;
  problem: ReservedLotProblem;
}

const words: Record<ReservedLotProblem, string> = {
  quarantine: "is in quarantine",
  rejected: "has been rejected",
  short: "no longer has enough stock",
};

/**
 * The active, unexpired reservations of planned or in-progress batches whose lot is not released or
 * has run short. `lotIds` limits it to some lots (the write path); without it, every reservation.
 */
export async function findReservedLotProblems(
  db: Executor,
  workspaceId: string,
  today: string,
  lotIds?: string[],
): Promise<ReservedLotAlert[]> {
  if (lotIds && lotIds.length === 0) return [];
  const rows = await db
    .select({
      r: productionReservations,
      lot: stockLots,
      itemName: items.name,
      batchCode: productionBatches.batchCode,
      locationName: stockLocations.name,
    })
    .from(productionReservations)
    .innerJoin(stockLots, eq(stockLots.id, productionReservations.lotId))
    .innerJoin(items, eq(items.id, productionReservations.itemId))
    .innerJoin(productionBatches, eq(productionBatches.id, productionReservations.batchId))
    .leftJoin(stockLocations, eq(stockLocations.id, productionReservations.locationId))
    .where(
      and(
        eq(productionReservations.workspaceId, workspaceId),
        eq(productionReservations.status, "active"),
        or(isNull(productionReservations.expiresOn), gte(productionReservations.expiresOn, today)),
        isNull(productionBatches.deletedAt),
        inArray(productionBatches.status, ["planned", "in_progress"]),
        lotIds ? inArray(productionReservations.lotId, lotIds) : undefined,
      ),
    );
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.r.lotId))];
  const onHand = await onHandOf(db, ids);
  const heldAll = await reservedByLot(db, workspaceId, { lotIds: ids, today });
  const heldAt = await reservedByLotLocation(db, workspaceId, { lotIds: ids, today });
  const out: ReservedLotAlert[] = [];
  for (const { r, lot, itemName, batchCode, locationName } of rows) {
    let problem: ReservedLotProblem | null = null;
    if (lot.status === "quarantine" || lot.status === "rejected") problem = lot.status;
    else {
      const key = r.locationId ? lotLocationKey(r.lotId, r.locationId) : null;
      if (
        (onHand.lots.get(r.lotId) ?? 0) + 1e-9 < (heldAll.get(r.lotId) ?? 0) ||
        (key !== null && (onHand.locations.get(key) ?? 0) + 1e-9 < (heldAt.get(key) ?? 0))
      ) {
        problem = "short";
      }
    }
    if (!problem) continue;
    out.push({
      reservationId: r.id,
      createdBy: r.createdBy,
      batchId: r.batchId,
      batchCode,
      lotId: r.lotId,
      lotCode: lot.lotCode,
      itemName,
      locationName,
      problem,
    });
  }
  return out;
}

/**
 * Drafts for the people to tell: whoever reserved the stock (if they can read production) and
 * everyone with `manage` on production, except `actorId` (who caused it).
 */
export function reservedLotDrafts(
  alerts: readonly ReservedLotAlert[],
  access: Awaited<ReturnType<typeof memberAccess>>,
  actorId: string | null,
): NotificationDraft[] {
  const managers = audience(access, "production", "manage");
  const readers = new Set(audience(access, "production", "read"));
  return alerts.flatMap((a) => {
    const people = new Set([...managers, ...(a.createdBy && readers.has(a.createdBy) ? [a.createdBy] : [])]);
    if (actorId) people.delete(actorId);
    const data: NotificationData = {
      title: `${a.batchCode}: lot ${a.lotCode} of ${a.itemName}`,
      subjectId: a.batchId,
      snippet: `${a.lotCode}${a.locationName ? ` at ${a.locationName}` : ""} ${words[a.problem]}`,
      reservationProblem: a.problem,
    };
    return [...people].map((userId): NotificationDraft => ({
      userId,
      type: "reserved_lot_problem",
      module: "production",
      data,
      dedupeKey: `reserved_lot:${a.reservationId}:${a.problem}`,
    }));
  });
}

/**
 * A lot's status changed: tell the people behind reservations of it that it is in quarantine or
 * rejected. Call inside the status change's transaction; returns the rows created, to email after
 * the commit. Does nothing when the lot was released.
 */
export async function notifyReservedLotStatus(
  tx: Executor,
  workspaceId: string,
  actorId: string,
  today: string,
  lotId: string,
) {
  const alerts = (await findReservedLotProblems(tx, workspaceId, today, [lotId])).filter(
    (a) => a.problem !== "short",
  );
  if (alerts.length === 0) return [];
  // Event notifications use all modules, as the others do (the module is active when its data exists).
  const access = await memberAccess(tx, workspaceId);
  return insertNotifications(tx, workspaceId, actorId, reservedLotDrafts(alerts, access, actorId));
}
