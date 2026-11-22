import {
  freeQuantity,
  isPickable,
  lotLocationKey,
  netOfReservations,
  parseGs1,
  pickFefo,
  reservationExpired,
  roundQuantity,
  stockAmount,
  type AvailabilityQuery,
  type ProductionReleaseInput,
  type ProductionReservationUpdateInput,
  type ReservationLineInput,
  type ProductionReserveInput,
  type ReservationListQuery,
} from "@knotworking/core";
import {
  items,
  lockWorkspaceLog,
  productionBatches,
  productionReservations,
  recordChanges,
  stockLocations,
  stockLots,
  stockMovements,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ApiError, notFound } from "../errors";
import { assertStatus, findBatch, getBatch } from "./ports/production";
import {
  balanceAt,
  findActiveLocation,
  findLot,
  itemSummary,
  num,
  pickCandidates,
  toBase,
} from "./ports/stock";
import {
  heldOf,
  releaseExpiredReservations,
  reservationChange,
  reservedByLot,
  reservedByLotLocation,
  serializeReservation,
  type ReservationRow,
} from "./reservations-core";
import { workspaceToday } from "./time-zone";

/**
 * Reserving stock for batches: set aside quantities of specific lots (or an item's quantity,
 * picked first expired first out from free stock) for a planned or in-progress batch. Available
 * stock is on hand minus reserved. A reservation never blocks consumption: it is released when
 * the batch uses it up, completes or is cancelled, or by hand.
 */

async function lotOnHand(tx: Executor, lotId: string) {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)` })
    .from(stockMovements)
    .where(eq(stockMovements.lotId, lotId));
  return num(row?.total);
}

/** Reserves stock for a batch. Lines name a lot (strict) or an item (FEFO, partial when stock is short). */
export async function reserveForBatch(
  db: Database,
  workspaceId: string,
  actorId: string,
  batchId: string,
  input: ProductionReserveInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const batch = await findBatch(tx, workspaceId, batchId);
    assertStatus(batch, ["planned", "in_progress"], "reserve stock");
    const detail = await getBatch(tx, workspaceId, batchId);
    const material = new Map(detail.materials.filter((m) => m.inRecipe).map((m) => [m.item.id, m]));
    const day = await workspaceToday(tx, workspaceId);
    if (input.expiresOn) assertExpiryNotPast(input.expiresOn, day);
    const shortfalls: {
      itemId: string;
      item: ReturnType<typeof itemSummary>;
      shortfall: ReturnType<typeof stockAmount>;
    }[] = [];
    const changes: ChangeInput[] = [];
    // Holds whose last day has passed are let go first, so their stock counts as free below.
    changes.push(...(await releaseExpiredReservations(tx, workspaceId, day)).map(reservationChange));

    /**
     * Holds `quantity` of a lot (at a location, if given) for the batch, merged into the batch's
     * active reservation of the same lot and location. An expiry replaces the merged hold's.
     */
    async function hold(
      lotId: string,
      itemId: string,
      quantity: number,
      note: string | null,
      locationId: string | null,
      expiresOn: string | null,
    ) {
      const [existing] = await tx
        .select()
        .from(productionReservations)
        .where(
          and(
            eq(productionReservations.batchId, batchId),
            eq(productionReservations.lotId, lotId),
            eq(productionReservations.status, "active"),
            locationId
              ? eq(productionReservations.locationId, locationId)
              : isNull(productionReservations.locationId),
          ),
        );
      const [row] = existing
        ? await tx
            .update(productionReservations)
            .set({
              quantity: roundQuantity(existing.quantity + quantity),
              ...(expiresOn ? { expiresOn } : {}),
            })
            .where(eq(productionReservations.id, existing.id))
            .returning()
        : await tx
            .insert(productionReservations)
            .values({
              workspaceId,
              batchId,
              itemId,
              lotId,
              locationId,
              quantity,
              note,
              expiresOn,
              createdBy: actorId,
            })
            .returning();
      changes.push(reservationChange(row!));
    }

    /** What the batch can still reserve of an item: outstanding less what it already holds. */
    const room = async (itemId: string) => {
      const m = material.get(itemId);
      if (!m) return 0;
      if (!m.outstanding) return Number.POSITIVE_INFINITY; // unit not convertible: no cap
      const [held] = await tx
        .select({
          total: sql<string>`coalesce(sum(${productionReservations.quantity} - ${productionReservations.fulfilledQuantity}), 0)`,
        })
        .from(productionReservations)
        .where(
          and(
            eq(productionReservations.batchId, batchId),
            eq(productionReservations.itemId, itemId),
            eq(productionReservations.status, "active"),
          ),
        );
      return roundQuantity(Math.max(m.outstanding.base - num(held?.total), 0));
    };

    const lines: ReservationLineInput[] = [
      ...(input.lines ?? []),
      ...(input.allOutstanding
        ? [...material.keys()].map((itemId) => ({
            itemId,
            ...(input.locationId ? { locationId: input.locationId } : {}),
          }))
        : []),
    ];
    for (const line of lines) {
      const expiresOn = line.expiresOn ?? input.expiresOn ?? null;
      if (line.expiresOn) assertExpiryNotPast(line.expiresOn, day);
      const location = line.locationId ? await findActiveLocation(tx, workspaceId, line.locationId) : null;
      if ("lotId" in line) {
        const { lot, item } = await findLot(tx, workspaceId, line.lotId);
        if (!material.has(item.id)) {
          throw new ApiError(
            409,
            "not_in_recipe",
            `${item.name} is not an ingredient of this batch's recipe version`,
          );
        }
        if (lot.status !== "available") {
          throw new ApiError(
            409,
            "lot_not_available",
            `Lot ${lot.lotCode} is ${lot.status}; only released lots can be reserved`,
          );
        }
        if (lot.expiryType === "use_by" && lot.expiresOn && lot.expiresOn < day) {
          throw new ApiError(
            409,
            "lot_expired",
            `Lot ${lot.lotCode} is past its use-by date (${lot.expiresOn})`,
          );
        }
        const quantity = toBase(line.quantity, line.unit, item);
        let free = freeQuantity(
          await lotOnHand(tx, lot.id),
          (await reservedByLot(tx, workspaceId, { lotIds: [lot.id], today: day })).get(lot.id) ?? 0,
        );
        if (location) {
          // At a location the lot's balance there, less what is already reserved there, limits it too.
          const bound = (await reservedByLotLocation(tx, workspaceId, { lotIds: [lot.id], today: day })).get(
            lotLocationKey(lot.id, location.id),
          );
          free = Math.min(free, freeQuantity(await balanceAt(tx, lot.id, location.id), bound ?? 0));
        }
        if (quantity > free) {
          const amount = stockAmount(free, item);
          throw new ApiError(
            409,
            "insufficient_unreserved_stock",
            `Only ${amount.display} ${amount.displayUnit} of lot ${lot.lotCode}${location ? ` at ${location.name}` : ""} is not already reserved`,
            { available: amount },
          );
        }
        const cap = await room(item.id);
        if (quantity > cap) {
          const amount = stockAmount(cap, item);
          throw new ApiError(
            409,
            "over_reserved",
            `${item.name}: only ${amount.display} ${amount.displayUnit} is still needed by this batch`,
            { available: amount },
          );
        }
        await hold(lot.id, item.id, quantity, line.note ?? null, location?.id ?? null, expiresOn);
      } else {
        const m = material.get(line.itemId);
        if (!m) {
          throw new ApiError(
            409,
            "not_in_recipe",
            "That item is not an ingredient of this batch's recipe version",
          );
        }
        const [itemRow] = await tx.select().from(items).where(eq(items.id, line.itemId));
        const cap = await room(line.itemId);
        const wanted =
          line.quantity !== undefined && line.unit
            ? toBase(line.quantity, line.unit, itemRow!)
            : Number.isFinite(cap)
              ? cap
              : 0;
        if (!(wanted > 0)) continue;
        if (wanted > cap) {
          const amount = stockAmount(cap, itemRow!);
          throw new ApiError(
            409,
            "over_reserved",
            `${itemRow!.name}: only ${amount.display} ${amount.displayUnit} is still needed by this batch`,
            { available: amount },
          );
        }
        const candidates = (await pickCandidates(tx, workspaceId, [line.itemId])).filter(
          (c) => !location || c.locationId === location.id,
        );
        const free = netOfReservations(
          candidates,
          await reservedByLot(tx, workspaceId, { itemIds: [line.itemId], today: day }),
          await reservedByLotLocation(tx, workspaceId, { itemIds: [line.itemId], today: day }),
        );
        const result = pickFefo(free, wanted, day);
        const perLot = new Map<string, number>();
        for (const a of result.allocations) {
          perLot.set(a.candidate.lotId, roundQuantity((perLot.get(a.candidate.lotId) ?? 0) + a.quantity));
        }
        for (const [lotId, quantity] of perLot) {
          await hold(lotId, line.itemId, quantity, line.note ?? null, location?.id ?? null, expiresOn);
        }
        if (result.shortfall > 0) {
          shortfalls.push({
            itemId: line.itemId,
            item: itemSummary(itemRow!),
            shortfall: stockAmount(result.shortfall, itemRow!),
          });
        }
      }
    }
    await recordChanges(tx, workspaceId, actorId, changes);
    return { ...(await getBatch(tx, workspaceId, batchId)), shortfalls };
  });
}

/** Releases one reservation by hand: the stock is free again. */
export async function releaseReservation(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: ProductionReleaseInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [row] = await tx
      .select()
      .from(productionReservations)
      .where(and(eq(productionReservations.id, id), eq(productionReservations.workspaceId, workspaceId)));
    if (!row) throw notFound("Reservation");
    if (row.status !== "active") {
      throw new ApiError(409, "reservation_released", "This reservation has already been released");
    }
    const [updated] = await tx
      .update(productionReservations)
      .set({
        status: "released",
        releasedAt: new Date(),
        releasedBy: actorId,
        releaseReason: "manual",
        releaseNote: input.note ?? null,
      })
      .where(eq(productionReservations.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [reservationChange(updated!)]);
    return getBatch(tx, workspaceId, row.batchId);
  });
}

/** The last day of a reservation can't be in the past: it would expire at once. */
function assertExpiryNotPast(expiresOn: string, today: string) {
  if (expiresOn < today) {
    throw new ApiError(400, "invalid_expiry", `The expiry date ${expiresOn} is in the past`);
  }
}

/** Sets or removes a reservation's expiry date (its last day); only while it is active. */
export async function updateReservation(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: ProductionReservationUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [row] = await tx
      .select()
      .from(productionReservations)
      .where(and(eq(productionReservations.id, id), eq(productionReservations.workspaceId, workspaceId)));
    if (!row) throw notFound("Reservation");
    if (row.status !== "active") {
      throw new ApiError(409, "reservation_released", "This reservation has already been released");
    }
    if (input.expiresOn) assertExpiryNotPast(input.expiresOn, await workspaceToday(tx, workspaceId));
    const [updated] = await tx
      .update(productionReservations)
      .set({ expiresOn: input.expiresOn })
      .where(eq(productionReservations.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [reservationChange(updated!)]);
    return getBatch(tx, workspaceId, row.batchId);
  });
}

/** Reservations, newest first: for a batch, a lot or an item (default: active ones). */
export async function listReservations(db: Executor, workspaceId: string, query: ReservationListQuery) {
  const rows = await db
    .select({
      r: productionReservations,
      lot: stockLots,
      item: items,
      batchCode: productionBatches.batchCode,
      batchStatus: productionBatches.status,
      batchPlannedOn: productionBatches.plannedOn,
      locationName: stockLocations.name,
    })
    .from(productionReservations)
    .innerJoin(stockLots, eq(stockLots.id, productionReservations.lotId))
    .leftJoin(stockLocations, eq(stockLocations.id, productionReservations.locationId))
    .innerJoin(items, eq(items.id, productionReservations.itemId))
    .innerJoin(productionBatches, eq(productionBatches.id, productionReservations.batchId))
    .where(
      and(
        eq(productionReservations.workspaceId, workspaceId),
        query.batchId ? eq(productionReservations.batchId, query.batchId) : undefined,
        query.lotId ? eq(productionReservations.lotId, query.lotId) : undefined,
        query.itemId ? eq(productionReservations.itemId, query.itemId) : undefined,
        query.status === "all" ? undefined : eq(productionReservations.status, query.status),
      ),
    )
    .orderBy(asc(productionReservations.createdAt), asc(productionReservations.id));
  const day = await workspaceToday(db, workspaceId);
  return {
    reservations: rows.map(({ r, lot, item, batchCode, batchStatus, batchPlannedOn, locationName }) => ({
      ...serializeReservation(r as ReservationRow),
      item: itemSummary(item),
      lotCode: lot.lotCode,
      locationName,
      batchCode,
      batchStatus,
      batchPlannedOn,
      reserved: stockAmount(r.quantity, item),
      held: stockAmount(heldOf(r, day), item),
      expired: reservationExpired(r, day),
    })),
  };
}

/**
 * Availability per item: what can be used today (released, not past use-by), what active
 * reservations hold of it, and what is free (per lot: on hand less reserved, never below zero).
 */
export async function getAvailability(db: Executor, workspaceId: string, query: AvailabilityQuery) {
  const itemIds = query.itemIds;
  if (itemIds.length === 0) return { items: [] };
  const rows = await db
    .select()
    .from(items)
    .where(and(eq(items.workspaceId, workspaceId), inArray(items.id, itemIds), isNull(items.deletedAt)));
  const day = await workspaceToday(db, workspaceId);
  const candidates = await pickCandidates(db, workspaceId, itemIds);
  const reserved = await reservedByLot(db, workspaceId, { itemIds });
  const reservedLeft = new Map(reserved);
  const perItem = new Map<string, { usable: number; free: number; reservedUsable: number }>();
  // Per lot: usable on hand less its reservation (spread over its locations).
  const usableLots = candidates.filter((c) => isPickable(c, day));
  const lotTotals = new Map<string, number>();
  for (const c of usableLots)
    lotTotals.set(c.lotId, roundQuantity((lotTotals.get(c.lotId) ?? 0) + c.quantity));
  for (const c of usableLots) {
    const e = perItem.get(c.itemId) ?? { usable: 0, free: 0, reservedUsable: 0 };
    e.usable = roundQuantity(e.usable + c.quantity);
    perItem.set(c.itemId, e);
  }
  for (const [lotId, total] of lotTotals) {
    const itemId = usableLots.find((c) => c.lotId === lotId)!.itemId;
    const e = perItem.get(itemId)!;
    const held = Math.min(reservedLeft.get(lotId) ?? 0, total);
    e.reservedUsable = roundQuantity(e.reservedUsable + held);
    e.free = roundQuantity(e.free + freeQuantity(total, held));
  }
  const heldByItem = new Map<string, number>();
  for (const [lotId, q] of reserved) {
    const itemId = candidates.find((c) => c.lotId === lotId)?.itemId;
    if (itemId) heldByItem.set(itemId, roundQuantity((heldByItem.get(itemId) ?? 0) + q));
  }
  return {
    items: rows.map((item) => {
      const e = perItem.get(item.id) ?? { usable: 0, free: 0, reservedUsable: 0 };
      return {
        item: itemSummary(item),
        usable: stockAmount(e.usable, item),
        reserved: stockAmount(heldByItem.get(item.id) ?? 0, item),
        available: stockAmount(e.free, item),
      };
    }),
  };
}

/**
 * Resolves a scanned (or typed) lot code for a batch's consumption form: every lot with that code
 * (case-insensitive; codes are unique per item), with whether it can be consumed by this batch and
 * where it is. Reads only.
 */
export async function scanLotForBatch(db: Executor, workspaceId: string, batchId: string, code: string) {
  const detail = await getBatch(db, workspaceId, batchId);
  const wanted = code.trim();
  const findLots = (lotCode: string) =>
    db
      .select({ lot: stockLots, item: items })
      .from(stockLots)
      .innerJoin(items, eq(items.id, stockLots.itemId))
      .where(
        and(
          eq(stockLots.workspaceId, workspaceId),
          isNull(stockLots.deletedAt),
          sql`lower(${stockLots.lotCode}) = lower(${lotCode})`,
        ),
      );
  let lots = await findLots(wanted);
  // A GS1-128 lot label (see lot barcodes) scans as "(17)261231(10)LOT": look the lot up by its AI 10.
  if (lots.length === 0) {
    const gs1 = parseGs1(wanted);
    if (gs1?.lot) lots = await findLots(gs1.lot);
  }
  const day = await workspaceToday(db, workspaceId);
  const candidates = await pickCandidates(
    db,
    workspaceId,
    lots.map((l) => l.item.id),
  );
  const reserved = await reservedByLot(db, workspaceId, { lotIds: lots.map((l) => l.lot.id) });
  return {
    code: wanted,
    matches: lots.map(({ lot, item }) => {
      const material = detail.materials.find((m) => m.item.id === item.id && m.inRecipe);
      const balances = candidates.filter((c) => c.lotId === lot.id);
      const problem = !material
        ? "not_in_recipe"
        : lot.status !== "available"
          ? "lot_not_available"
          : lot.expiryType === "use_by" && lot.expiresOn && lot.expiresOn < day
            ? "lot_expired"
            : balances.length === 0
              ? "no_stock"
              : null;
      return {
        lotId: lot.id,
        lotCode: lot.lotCode,
        item: itemSummary(item),
        status: lot.status,
        expiresOn: lot.expiresOn,
        expiryType: lot.expiryType,
        inRecipe: !!material,
        problem,
        outstanding: material?.outstanding ?? null,
        reservedForBatch: detail.reservations
          .filter((r) => r.lotId === lot.id && r.status === "active")
          .reduce((t, r) => t + r.held.base, 0),
        reservedTotal: reserved.get(lot.id) ?? 0,
        balances: balances.map((b) => ({
          locationId: b.locationId,
          locationName: b.locationName,
          amount: stockAmount(b.quantity, item),
        })),
      };
    }),
  };
}
