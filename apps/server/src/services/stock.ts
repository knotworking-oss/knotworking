import { foodFieldsByItem } from "./food-items";
import { despatchReturns } from "@knotworking/db";
import { assertNoIncidentHold } from "./incident-holds";
import { executeLedgerCommand } from "./ledger-command";
import {
  addDays,
  classifyExpiry,
  type ExpiryType,
  generateLotCode,
  itemBaseUnit,
  lotCodePrefix,
  newId,
  pickFefo,
  receivableItemTypes,
  roundQuantity,
  stockAmount,
  stockMovementTypeLabels,
  toBaseQuantity,
  unitsForItem,
  type LotStatusChangeInput,
  type ModuleAccessMap,
  type PickCandidate,
  type StockAdjustmentInput,
  type StockLevelsQuery,
  type StockLocationCreateInput,
  type StockLocationListQuery,
  type StockLocationUpdateInput,
  type StockLotListQuery,
  type StockMovementListQuery,
  type StockMovementType,
  type StockPickQuery,
  type StockReceiptInput,
  type StocktakeInput,
  type StockTransferInput,
  type StockWasteInput,
  type UnitCode,
  endOfDayInZone,
  startOfDayInZone,
  evaluateLotRelease,
  moduleIds,
  releaseBlockers,
  type ModuleId,
} from "@knotworking/core";
import {
  items,
  lockWorkspaceLog,
  lotReleaseExceptionRequests,
  recordChanges,
  stockBalances,
  stockLocations,
  stockLots,
  stockMovements,
  suppliers,
  users,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { workspaceTimeZone, workspaceToday } from "./time-zone";
import { deliverNotifications, type NotificationRow } from "./notifications";
import { notifyReservedLotStatus } from "./reservation-alerts";
import { forReader, gatherReleaseFacts, recordRelease } from "./lot-release";

/**
 * Stock module: locations, lots and the movement ledger.
 *
 * - The ledger (`stock_movements`) is append-only: this file never updates or deletes a movement.
 *   A correction is a new row pointing at the one it corrects.
 * - A balance is the sum of a lot's movements at a location. `stock_balances` holds that sum, kept
 *   by a trigger when a movement is inserted, so reads of stock on hand follow the stock held and not
 *   the length of the ledger. The ledger stays the truth (`reconcileStockBalances` checks the two).
 * - Quantities arrive as a number and a unit, are converted to the item's base unit
 *   and rounded to the ledger's 4 decimal places once, here at the boundary (`toBaseQuantity`).
 * - Anything that checks a balance and then writes takes the workspace lock first and re-reads the
 *   balance inside the transaction, so two withdrawals can't both spend the same stock.
 * - Not in the bootstrap: lots and movements are read through paginated queries. Every write still
 *   goes to the sync log (`stock_location`, `stock_lot`, `stock_movement`), filtered by module.
 */

type ItemRow = typeof items.$inferSelect;
type LocationRow = typeof stockLocations.$inferSelect;
type LotRow = typeof stockLots.$inferSelect;
type MovementRow = typeof stockMovements.$inferSelect;

/** `%` and `_` are literal in a search box. */
const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;

/** Today in the workspace's time zone (expiry dates are calendar dates there). */
const today = (db: Executor, workspaceId: string) => workspaceToday(db, workspaceId);

import {
  num,
  sumQuantity,
  serializeLocation,
  serializeLot,
  serializeMovement,
  itemSummary,
  locationChange,
  lotChange,
  movementChange,
  findItem,
  findLocation,
  findActiveLocation,
  findLot,
  toBase,
  balanceAt,
  assertAvailable,
  insertMovements,
  lotBalances,
  pageTotal,
} from "./stock-ledger";
export {
  num,
  sumQuantity,
  serializeLocation,
  serializeLot,
  serializeMovement,
  itemSummary,
  locationChange,
  lotChange,
  movementChange,
  findItem,
  findLocation,
  findActiveLocation,
  findLot,
  toBase,
  balanceAt,
  assertAvailable,
  insertMovements,
} from "./stock-ledger";

// ─── Locations ───────────────────────────────────────────────────────────────

export async function listLocations(db: Database, workspaceId: string, query: StockLocationListQuery) {
  const where: (SQL | undefined)[] = [
    eq(stockLocations.workspaceId, workspaceId),
    isNull(stockLocations.deletedAt),
  ];
  if (query.status !== "all") where.push(eq(stockLocations.status, query.status));
  const rows = await db
    .select()
    .from(stockLocations)
    .where(and(...where))
    .orderBy(asc(stockLocations.name), asc(stockLocations.id));
  // Lots with stock at each location.
  const counts = await db
    .select({ locationId: stockBalances.locationId, n: count() })
    .from(stockBalances)
    .where(and(eq(stockBalances.workspaceId, workspaceId), sql`${stockBalances.quantity} <> 0`))
    .groupBy(stockBalances.locationId);
  const lotCount = new Map(counts.map((c) => [c.locationId, c.n]));
  return rows.map((row) => ({ ...serializeLocation(row), lotCount: lotCount.get(row.id) ?? 0 }));
}

async function assertLocationCodeFree(tx: Transaction, workspaceId: string, code: string, exceptId?: string) {
  const [taken] = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.workspaceId, workspaceId),
        isNull(stockLocations.deletedAt),
        sql`lower(${stockLocations.code}) = lower(${code})`,
        exceptId ? ne(stockLocations.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `Another location already uses the code "${code}"`);
}

export async function createLocation(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: StockLocationCreateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (input.code) await assertLocationCodeFree(tx, workspaceId, input.code);
    const [row] = await tx
      .insert(stockLocations)
      .values({ ...input, ...(input.id ? { id: input.id } : {}), workspaceId })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [locationChange(row!)]);
    return serializeLocation(row!);
  });
}

export async function updateLocation(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: StockLocationUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findLocation(tx, workspaceId, id);
    if (patch.code) await assertLocationCodeFree(tx, workspaceId, patch.code, id);
    if (patch.status === "archived" && current.status !== "archived") {
      const [held] = await tx
        .select({ lotId: stockBalances.lotId })
        .from(stockBalances)
        .where(and(eq(stockBalances.locationId, id), sql`${stockBalances.quantity} <> 0`))
        .limit(1);
      if (held) {
        throw new ApiError(
          409,
          "location_not_empty",
          `${current.name} still holds stock; move or write it off before archiving`,
        );
      }
    }
    const [row] = await tx.update(stockLocations).set(patch).where(eq(stockLocations.id, id)).returning();
    await recordChanges(tx, workspaceId, actorId, [locationChange(row!)]);
    return serializeLocation(row!);
  });
}

// ─── Reading: levels, lots, movements ────────────────────────────────────────

/** Balances per lot and location for the given lots (non-zero only), with location names. */
async function balancesFor(db: Executor, lotIds: string[], locationId?: string) {
  const byLot = new Map<
    string,
    { locationId: string; locationName: string; locationCode: string | null; quantity: number }[]
  >();
  if (lotIds.length === 0) return byLot;
  const rows = await db
    .select({
      lotId: stockBalances.lotId,
      locationId: stockBalances.locationId,
      locationName: stockLocations.name,
      locationCode: stockLocations.code,
      total: stockBalances.quantity,
    })
    .from(stockBalances)
    .innerJoin(stockLocations, eq(stockLocations.id, stockBalances.locationId))
    .where(
      and(
        inArray(stockBalances.lotId, lotIds),
        locationId ? eq(stockBalances.locationId, locationId) : undefined,
        sql`${stockBalances.quantity} <> 0`,
      ),
    )
    .orderBy(asc(stockLocations.name));
  for (const { lotId, total, ...rest } of rows) {
    const list = byLot.get(lotId) ?? [];
    list.push({ ...rest, quantity: num(total) });
    byLot.set(lotId, list);
  }
  return byLot;
}

/** One row per item: on hand, split by lot status, lots in stock and the earliest expiry. */
export async function listStockLevels(db: Database, workspaceId: string, query: StockLevelsQuery) {
  // Balance per lot (at one location when filtered), non-zero only, from the stored balances.
  const perLot = lotBalances(db, workspaceId, { locationId: query.locationId });
  const lots = db
    .select({
      itemId: sql<string>`${stockLots.itemId}`.as("lot_item_id"),
      status: sql<string>`${stockLots.status}`.as("lot_status"),
      expiresOn: sql<string | null>`${stockLots.expiresOn}`.as("lot_expires_on"),
      qty: sql<string>`${perLot.qty}`.as("lot_qty"),
    })
    .from(stockLots)
    .innerJoin(perLot, eq(perLot.lotId, stockLots.id))
    .where(isNull(stockLots.deletedAt))
    .as("lots");
  // Total per item first, then attach the items. Joining `items` to the lots and grouping afterwards
  // lets the planner re-scan the lots once per item.
  const perItem = db
    .select({
      itemId: sql<string>`${lots.itemId}`.as("stock_item_id"),
      onHand: sql<string>`sum(${lots.qty})`.as("on_hand"),
      available: sql<string>`coalesce(sum(${lots.qty}) filter (where ${lots.status} = 'available'), 0)`.as(
        "available",
      ),
      quarantine: sql<string>`coalesce(sum(${lots.qty}) filter (where ${lots.status} = 'quarantine'), 0)`.as(
        "quarantine",
      ),
      rejected: sql<string>`coalesce(sum(${lots.qty}) filter (where ${lots.status} = 'rejected'), 0)`.as(
        "rejected",
      ),
      lotCount: sql<number>`count(*)::int`.as("lot_count"),
      earliestExpiry: sql<string | null>`min(${lots.expiresOn})`.as("earliest_expiry"),
    })
    .from(lots)
    .groupBy(lots.itemId)
    .as("per_item");

  const where: (SQL | undefined)[] = [eq(items.workspaceId, workspaceId), isNull(items.deletedAt)];
  if (query.itemType) where.push(eq(items.type, query.itemType));
  if (query.q) {
    where.push(
      or(
        sql`${items.name} ilike ${like(query.q)} escape '!'`,
        sql`${items.code} ilike ${like(query.q)} escape '!'`,
      ),
    );
  }
  // Items with nothing in stock are listed only when asked for, and only if they're active.
  where.push(
    query.includeZero
      ? or(sql`${perItem.itemId} is not null`, eq(items.status, "active"))
      : sql`${perItem.itemId} is not null`,
  );
  if (query.expiringWithinDays !== undefined) {
    where.push(
      sql`${perItem.earliestExpiry} <= ${addDays(await today(db, workspaceId), query.expiringWithinDays)}`,
    );
  }

  const rows = await db
    .select({
      item: items,
      onHand: sql<string>`coalesce(${perItem.onHand}, 0)`,
      available: sql<string>`coalesce(${perItem.available}, 0)`,
      quarantine: sql<string>`coalesce(${perItem.quarantine}, 0)`,
      rejected: sql<string>`coalesce(${perItem.rejected}, 0)`,
      lotCount: sql<number>`coalesce(${perItem.lotCount}, 0)`,
      earliestExpiry: perItem.earliestExpiry,
    })
    .from(items)
    .leftJoin(perItem, eq(perItem.itemId, items.id))
    .where(and(...where))
    .orderBy(asc(items.name), asc(items.id))
    .limit(query.limit)
    .offset(query.offset);
  const total = await pageTotal(rows, query, async () => {
    const [row] = await db
      .select({ n: count() })
      .from(items)
      .leftJoin(perItem, eq(perItem.itemId, items.id))
      .where(and(...where));
    return row?.n ?? 0;
  });
  const day = await today(db, workspaceId);
  return {
    levels: rows.map((r) => ({
      item: itemSummary(r.item),
      onHand: stockAmount(num(r.onHand), r.item),
      available: stockAmount(num(r.available), r.item),
      quarantine: stockAmount(num(r.quarantine), r.item),
      rejected: stockAmount(num(r.rejected), r.item),
      lotCount: Number(r.lotCount),
      earliestExpiry: r.earliestExpiry,
      expiryState: r.earliestExpiry ? classifyExpiry(r.earliestExpiry, day) : null,
    })),
    total,
    limit: query.limit,
    offset: query.offset,
  };
}

/** Lots in FEFO order (earliest expiry first, no expiry last, then received date), with balances. */
export async function listLots(db: Database, workspaceId: string, query: StockLotListQuery) {
  const where: (SQL | undefined)[] = [eq(stockLots.workspaceId, workspaceId), isNull(stockLots.deletedAt)];
  if (query.itemId) where.push(eq(stockLots.itemId, query.itemId));
  if (query.status) where.push(eq(stockLots.status, query.status));
  if (query.q) {
    where.push(
      or(
        sql`${stockLots.lotCode} ilike ${like(query.q)} escape '!'`,
        sql`${stockLots.supplierLotCode} ilike ${like(query.q)} escape '!'`,
      ),
    );
  }
  if (query.expiringWithinDays !== undefined) {
    where.push(
      sql`${stockLots.expiresOn} <= ${addDays(await today(db, workspaceId), query.expiringWithinDays)}`,
    );
  }
  const orderBy =
    query.order === "newest"
      ? [desc(stockLots.receivedOn), desc(stockLots.lotCode), desc(stockLots.id)]
      : [
          sql`${stockLots.expiresOn} asc nulls last`,
          asc(stockLots.receivedOn),
          asc(stockLots.lotCode),
          asc(stockLots.id),
        ];
  const detail = () =>
    db
      .select({ lot: stockLots, item: items, supplierName: suppliers.name })
      .from(stockLots)
      .innerJoin(items, eq(items.id, stockLots.itemId))
      .leftJoin(suppliers, eq(suppliers.id, stockLots.supplierId));

  let rows: { lot: LotRow; item: ItemRow; supplierName: string | null }[];
  let total: number;
  if (!query.includeEmpty || query.locationId) {
    // In stock (at the location, when one is given): a lot with a non-zero stored balance.
    const holding = and(
      eq(stockBalances.workspaceId, workspaceId),
      sql`${stockBalances.quantity} <> 0`,
      query.locationId ? eq(stockBalances.locationId, query.locationId) : undefined,
    );
    // Start from the lots that hold stock and sort them afterwards. Written as a plain semi-join the planner
    // walks the lots in expiry order looking for stock, through every lot ever received (the lots still
    // holding stock are the most recent, so they come last). The `offset 0` keeps the sort out of the
    // inner query so it can't make that choice.
    const live = db
      .select({ lotId: stockBalances.lotId })
      .from(stockBalances)
      .where(holding)
      .groupBy(stockBalances.lotId)
      .as("live");
    const candidates = db
      .select({
        id: stockLots.id,
        expiresOn: stockLots.expiresOn,
        receivedOn: stockLots.receivedOn,
        lotCode: stockLots.lotCode,
      })
      .from(live)
      .innerJoin(stockLots, eq(stockLots.id, live.lotId))
      .where(and(...where))
      .offset(0)
      .as("candidates");
    const first = await db
      .select({ id: candidates.id })
      .from(candidates)
      .orderBy(
        ...(query.order === "newest"
          ? [desc(candidates.receivedOn), desc(candidates.lotCode), desc(candidates.id)]
          : [
              sql`${candidates.expiresOn} asc nulls last`,
              asc(candidates.receivedOn),
              asc(candidates.lotCode),
              asc(candidates.id),
            ]),
      )
      .limit(query.limit)
      .offset(query.offset);
    const ids = first.map((r) => r.id);
    rows = ids.length
      ? await detail()
          .where(inArray(stockLots.id, ids))
          .orderBy(...orderBy)
      : [];
    total = await pageTotal(rows, query, async () => {
      const [row] = await db
        .select({ n: count() })
        .from(stockLots)
        .where(and(...where, inArray(stockLots.id, db.select({ id: live.lotId }).from(live))));
      return row?.n ?? 0;
    });
  } else {
    rows = await detail()
      .where(and(...where))
      .orderBy(...orderBy)
      .limit(query.limit)
      .offset(query.offset);
    total = await pageTotal(rows, query, async () => {
      const [row] = await db
        .select({ n: count() })
        .from(stockLots)
        .where(and(...where));
      return row?.n ?? 0;
    });
  }
  const balances = await balancesFor(
    db,
    rows.map((r) => r.lot.id),
    query.locationId,
  );
  const day = await today(db, workspaceId);
  return {
    lots: rows.map(({ lot, item, supplierName }) => {
      const list = balances.get(lot.id) ?? [];
      return {
        ...serializeLot(lot),
        item: itemSummary(item),
        supplierName,
        expiryState: classifyExpiry(lot.expiresOn, day),
        onHand: stockAmount(
          list.reduce((sum, b) => sum + b.quantity, 0),
          item,
        ),
        balances: list.map(({ quantity, ...b }) => ({ ...b, amount: stockAmount(quantity, item) })),
      };
    }),
    total,
    limit: query.limit,
    offset: query.offset,
  };
}

const movementSelect = {
  movement: stockMovements,
  item: items,
  lotCode: stockLots.lotCode,
  locationName: stockLocations.name,
  actorName: users.name,
};

type MovementJoin = {
  movement: MovementRow;
  item: ItemRow;
  lotCode: string;
  locationName: string;
  actorName: string | null;
};

const movementView = ({ movement, item, lotCode, locationName, actorName }: MovementJoin) => ({
  ...serializeMovement(movement),
  amount: stockAmount(movement.quantity, item),
  lotCode,
  locationName,
  actorName,
  item: itemSummary(item),
});

function movementQuery(db: Executor) {
  return db
    .select(movementSelect)
    .from(stockMovements)
    .innerJoin(items, eq(items.id, stockMovements.itemId))
    .innerJoin(stockLots, eq(stockLots.id, stockMovements.lotId))
    .innerJoin(stockLocations, eq(stockLocations.id, stockMovements.locationId))
    .leftJoin(users, eq(users.id, stockMovements.actorId));
}

/** The ledger, newest first. */
export async function listMovements(db: Database, workspaceId: string, query: StockMovementListQuery) {
  const where: (SQL | undefined)[] = [eq(stockMovements.workspaceId, workspaceId)];
  if (query.itemId) where.push(eq(stockMovements.itemId, query.itemId));
  if (query.lotId) where.push(eq(stockMovements.lotId, query.lotId));
  if (query.type) where.push(eq(stockMovements.type, query.type));
  // `from` and `to` are local dates in the workspace's time zone.
  const zone = query.from || query.to ? await workspaceTimeZone(db, workspaceId) : null;
  if (query.from) where.push(gte(stockMovements.occurredAt, startOfDayInZone(query.from, zone!)));
  if (query.to) where.push(lt(stockMovements.occurredAt, endOfDayInZone(query.to, zone!)));
  const [rows, [total]] = await Promise.all([
    movementQuery(db)
      .where(and(...where))
      .orderBy(desc(stockMovements.occurredAt), desc(stockMovements.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(stockMovements)
      .where(and(...where)),
  ]);
  return {
    movements: rows.map(movementView),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

/** The traceability view of one lot: the lot, its item and supplier, balances, and every movement. */
export async function getLot(db: Executor, workspaceId: string, id: string) {
  const { lot, item } = await findLot(db, workspaceId, id);
  const [supplier] = lot.supplierId
    ? await db
        .select({
          id: suppliers.id,
          name: suppliers.name,
          code: suppliers.code,
          approvalStatus: suppliers.approvalStatus,
        })
        .from(suppliers)
        .where(eq(suppliers.id, lot.supplierId))
    : [];
  const [statusChanger] = lot.statusChangedBy
    ? await db.select({ name: users.name }).from(users).where(eq(users.id, lot.statusChangedBy))
    : [];
  const balances = (await balancesFor(db, [id])).get(id) ?? [];
  const movements = await movementQuery(db)
    .where(eq(stockMovements.lotId, id))
    .orderBy(asc(stockMovements.occurredAt), asc(stockMovements.id));
  const reversed = new Set(movements.map((m) => m.movement.reversesMovementId).filter(Boolean));
  const [origin] = await db
    .select({ originalLotId: despatchReturns.originalLotId })
    .from(despatchReturns)
    .where(and(eq(despatchReturns.workspaceId, workspaceId), eq(despatchReturns.lotId, id)));
  const original = origin ? (await findLot(db, workspaceId, origin.originalLotId)).lot : null;
  return {
    ...serializeLot(lot),
    statusChangedByName: statusChanger?.name ?? null,
    returnedFrom: original ? { lotId: original.id, lotCode: original.lotCode } : null,
    item: itemSummary(item),
    supplier: supplier ?? null,
    expiryState: classifyExpiry(lot.expiresOn, await today(db, workspaceId)),
    onHand: stockAmount(
      balances.reduce((sum, b) => sum + b.quantity, 0),
      item,
    ),
    balances: balances.map(({ quantity, ...b }) => ({ ...b, amount: stockAmount(quantity, item) })),
    movements: movements.map((m) => ({ ...movementView(m), reversed: reversed.has(m.movement.id) })),
  };
}

// ─── Goods-in ────────────────────────────────────────────────────────────────

/** The next generated lot code for a receipt date: `L` + yymmdd + a sequence per workspace and day. */
async function nextLotCode(tx: Transaction, workspaceId: string, receivedOn: string) {
  const prefix = lotCodePrefix(receivedOn);
  // By prefix on the lower-cased code, which `stock_lots_workspace_code_prefix_idx` serves, so a receipt reads
  // only the day's lots and not every lot in the workspace.
  const rows = await tx
    .select({ lotCode: stockLots.lotCode })
    .from(stockLots)
    .where(
      and(
        eq(stockLots.workspaceId, workspaceId),
        sql`lower(${stockLots.lotCode}) like ${`${prefix.toLowerCase()}%`}`,
      ),
    );
  const pattern = new RegExp(`^${prefix}(\\d+)$`, "i");
  const max = rows.reduce((m, r) => Math.max(m, Number(pattern.exec(r.lotCode)?.[1] ?? 0)), 0);
  return generateLotCode(receivedOn, max + 1);
}

/** Whether an item already has a live lot with this code (case-insensitive). */
export async function lotCodeTaken(tx: Executor, itemId: string, lotCode: string) {
  const [taken] = await tx
    .select({ id: stockLots.id })
    .from(stockLots)
    .where(
      and(
        eq(stockLots.itemId, itemId),
        isNull(stockLots.deletedAt),
        sql`lower(${stockLots.lotCode}) = lower(${lotCode})`,
      ),
    );
  return !!taken;
}

/**
 * Inserts a lot (its first movement is the caller's job). A given lot code must be free for the
 * item (`409 lot_code_taken`); without one, a code is generated from `receivedOn`. Without an
 * expiry, an item with a shelf life gets a best-before date of `receivedOn` + shelf life. A lot
 * that starts in quarantine records who put it there and when. Goods-in and production use it.
 */
export async function createLot(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  item: ItemRow,
  input: {
    lotCode: string | null;
    receivedOn: string;
    expiresOn: string | null;
    expiryType: ExpiryType | null;
    status: "available" | "quarantine";
    statusNote: string;
    supplierId?: string | null;
    supplierLotCode?: string | null;
    notes?: string | null;
    now: Date;
    foodItems?: boolean;
  },
) {
  let lotCode = input.lotCode;
  if (lotCode) {
    if (await lotCodeTaken(tx, item.id, lotCode)) {
      throw new ApiError(409, "lot_code_taken", `${item.name} already has a lot "${lotCode}"`);
    }
  } else {
    lotCode = await nextLotCode(tx, workspaceId, input.receivedOn);
  }

  // No date given: the item's shelf life from receipt, as a best-before date.
  let expiresOn = input.expiresOn;
  let expiryType = input.expiryType;
  if (!expiresOn && input.foodItems) {
    const shelfLife = (await foodFieldsByItem(tx, workspaceId, [item.id])).get(item.id)?.shelfLifeDays;
    if (shelfLife != null) {
      expiresOn = addDays(input.receivedOn, shelfLife);
      expiryType = "best_before";
    }
  }

  const [lot] = await tx
    .insert(stockLots)
    .values({
      workspaceId,
      itemId: item.id,
      lotCode,
      supplierId: input.supplierId ?? null,
      supplierLotCode: input.supplierLotCode ?? null,
      receivedOn: input.receivedOn,
      expiresOn,
      expiryType,
      status: input.status,
      notes: input.notes ?? null,
      ...(input.status === "quarantine"
        ? { statusChangedAt: input.now, statusChangedBy: actorId, statusNote: input.statusNote }
        : {}),
    })
    .returning();
  return lot!;
}

/**
 * Goods-in's item rule: an archived (or deleted) item is refused (`409 item_archived`); only
 * purchasable stock items are received (`403 item_not_receivable`). Stock goods-in passes
 * `canManage`: with it, an opening balance of WIP or finished goods may be received, with a reason.
 * Purchasing receipts leave it out: there is no such path against an order.
 */
export function assertItemReceivable(
  item: ItemRow,
  options: { canManage?: boolean; reason?: string | null | undefined } = {},
) {
  if (item.status !== "active" || item.deletedAt !== null) {
    throw new ApiError(409, "item_archived", `${item.name} is archived`);
  }
  if (item.type === "service") {
    throw new ApiError(
      403,
      "item_not_receivable",
      `${item.name} is a service and cannot be received into stock`,
    );
  }
  if (!(receivableItemTypes as readonly string[]).includes(item.type)) {
    if (options.canManage === undefined) {
      throw new ApiError(
        403,
        "item_not_receivable",
        `${item.name} can't be received into stock against a purchase order`,
      );
    }
    if (!options.canManage) {
      throw new ApiError(
        403,
        "item_not_receivable",
        "Receiving an opening balance of a manufactured item needs manage access",
      );
    }
    if (!options.reason) throw badRequest("Give a reason for receiving this item outside production");
  }
}

/**
 * BRCGS supplier approval at goods-in: a suspended or rejected supplier is refused
 * (`409 supplier_not_approved`); a supplier whose approval is pending may only deliver into
 * quarantine. `status` is the status the lot will start in. Stock goods-in and purchasing receipts
 * both use it. Returns the supplier.
 */
export async function assertSupplierCanDeliver(
  tx: Executor,
  workspaceId: string,
  supplierId: string,
  status: "available" | "quarantine",
) {
  const [supplier] = await tx
    .select()
    .from(suppliers)
    .where(
      and(eq(suppliers.id, supplierId), eq(suppliers.workspaceId, workspaceId), isNull(suppliers.deletedAt)),
    );
  if (!supplier) throw notFound("Supplier");
  if (supplier.approvalStatus === "suspended" || supplier.approvalStatus === "rejected") {
    throw new ApiError(
      409,
      "supplier_not_approved",
      `${supplier.name} is ${supplier.approvalStatus}; stock from them can't be received`,
    );
  }
  if (supplier.approvalStatus === "pending" && status !== "quarantine") {
    throw new ApiError(
      409,
      "supplier_not_approved",
      `${supplier.name} is not approved yet; receive their stock into quarantine`,
    );
  }
  return supplier;
}

/**
 * Goods-in: creates the lot and its `receipt` movement in one transaction.
 *
 * BRCGS supplier approval: a suspended or rejected supplier is refused; a supplier whose approval
 * is pending may only deliver into quarantine. An opening balance of WIP or finished goods
 * needs `manage` and a reason.
 */
export async function receiveStock(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: StockReceiptInput,
  options: { canManage: boolean; foodItems?: boolean },
) {
  return executeLedgerCommand(
    db,
    workspaceId,
    actorId,
    "receiveStock",
    input,
    { input, options: { canManage: options.canManage } },
    async (tx) => {
      await lockWorkspaceLog(tx, workspaceId);
      const item = await findItem(tx, workspaceId, input.itemId);
      assertItemReceivable(item, { canManage: options.canManage, reason: input.reason });
      const quantity = toBase(input.quantity, input.unit, item);
      const location = await findActiveLocation(tx, workspaceId, input.locationId);

      const status = input.status ?? "available";
      if (input.supplierId) await assertSupplierCanDeliver(tx, workspaceId, input.supplierId, status);

      const now = new Date();
      const lot = await createLot(tx, workspaceId, actorId, item, {
        lotCode: input.lotCode ?? null,
        receivedOn: input.receivedOn,
        expiresOn: input.expiresOn ?? null,
        expiryType: input.expiryType ?? null,
        status,
        statusNote: "Received into quarantine",
        foodItems: options.foodItems ?? false,
        supplierId: input.supplierId ?? null,
        supplierLotCode: input.supplierLotCode ?? null,
        notes: input.notes ?? null,
        now,
      });
      const [movement] = await insertMovements(tx, workspaceId, [
        {
          lotId: lot.id,
          itemId: item.id,
          locationId: location.id,
          quantity,
          type: "receipt",
          reason: input.reason ?? null,
          reference: input.reference ?? null,
          actorId,
          occurredAt: now,
        },
      ]);
      await recordChanges(tx, workspaceId, actorId, [lotChange(lot), movementChange(movement!)]);
      return getLot(tx, workspaceId, lot.id);
    },
  );
}

// ─── Transfers, waste, adjustments ───────────────────────────────────────────

/** Moves part of a lot between locations: a `transfer_out` and a `transfer_in` sharing a `transferId`. */
export async function transferStock(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: StockTransferInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const { lot, item } = await findLot(tx, workspaceId, input.lotId);
    const from = await findLocation(tx, workspaceId, input.fromLocationId);
    const to = await findActiveLocation(tx, workspaceId, input.toLocationId);
    const quantity = toBase(input.quantity, input.unit, item);
    await assertAvailable(tx, lot.id, from, item, quantity);
    const transferId = newId();
    const now = new Date();
    const common = {
      lotId: lot.id,
      itemId: item.id,
      transferId,
      reason: input.reason ?? null,
      reference: input.reference ?? null,
      actorId,
      occurredAt: now,
    };
    const rows = await insertMovements(tx, workspaceId, [
      { ...common, locationId: from.id, quantity: -quantity, type: "transfer_out" },
      { ...common, locationId: to.id, quantity, type: "transfer_in" },
    ]);
    await recordChanges(tx, workspaceId, actorId, rows.map(movementChange));
    return {
      transferId,
      movements: rows.map((m) => ({ ...serializeMovement(m), amount: stockAmount(m.quantity, item) })),
    };
  });
}

/** Stock thrown away. The route makes sure a signed-in person posts it. */
export async function wasteStock(db: Database, workspaceId: string, actorId: string, input: StockWasteInput) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const { lot, item } = await findLot(tx, workspaceId, input.lotId);
    const location = await findLocation(tx, workspaceId, input.locationId);
    const quantity = toBase(input.quantity, input.unit, item);
    await assertAvailable(tx, lot.id, location, item, quantity);
    const [row] = await insertMovements(tx, workspaceId, [
      {
        lotId: lot.id,
        itemId: item.id,
        locationId: location.id,
        quantity: -quantity,
        type: "waste",
        reason: input.reason,
        reference: input.reference ?? null,
        actorId,
      },
    ]);
    await recordChanges(tx, workspaceId, actorId, [movementChange(row!)]);
    return { ...serializeMovement(row!), amount: stockAmount(row!.quantity, item) };
  });
}

/** A signed correction (needs `manage` and a person). A negative one can't overdraw the balance. */
export async function adjustStock(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: StockAdjustmentInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const { lot, item } = await findLot(tx, workspaceId, input.lotId);
    const location = await findLocation(tx, workspaceId, input.locationId);
    const magnitude = toBase(Math.abs(input.quantity), input.unit, item);
    const quantity = input.quantity < 0 ? -magnitude : magnitude;
    if (quantity < 0) await assertAvailable(tx, lot.id, location, item, magnitude);
    // Stock can be taken out of an archived location, never put into one.
    else await findActiveLocation(tx, workspaceId, location.id);
    const [row] = await insertMovements(tx, workspaceId, [
      {
        lotId: lot.id,
        itemId: item.id,
        locationId: location.id,
        quantity,
        type: "adjustment",
        reason: input.reason,
        reference: input.reference ?? null,
        actorId,
      },
    ]);
    await recordChanges(tx, workspaceId, actorId, [movementChange(row!)]);
    return { ...serializeMovement(row!), amount: stockAmount(row!.quantity, item) };
  });
}

// ─── QA status ───────────────────────────────────────────────────────────────

/** Quarantine, release or reject a lot: a QA sign-off that records who and when. */
export async function setLotStatus(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: LotStatusChangeInput,
  options: { active?: readonly ModuleId[]; access?: ModuleAccessMap } = {},
) {
  let notified: NotificationRow[] = [];
  const lot = await db.transaction(async (tx) => {
    // Serialize QA with ledger writers before reading or changing the lot.
    await lockWorkspaceLog(tx, workspaceId);
    const { lot: current } = await findLot(tx, workspaceId, id);
    // A lot held by an open incident (recall or withdrawal case) can't be released at all, not even
    // as a release exception: the incident decides its disposition.
    if (input.status === "available") await assertNoIncidentHold(tx, workspaceId, id);
    // A release is checked against the evidence (tests, specification, CCP reviews) and the
    // item's rule, inside the lock so nothing changes between the check and the release.
    if (input.status === "available" && current.status !== "available") {
      const active = options.active ?? moduleIds;
      const facts = await gatherReleaseFacts(tx, workspaceId, current, active);
      const evaluation = evaluateLotRelease(facts);
      if (evaluation.blocked) {
        const checks = options.access ? forReader(evaluation.checks, options.access) : evaluation.checks;
        throw new ApiError(
          409,
          "release_blocked",
          `This lot can't be released yet: ${releaseBlockers({ ...evaluation, checks }).join("; ")}. Resolve these first, or request a release exception with a reason and evidence for another manager to approve.`,
          { checks },
        );
      }
      await recordRelease(tx, workspaceId, actorId, {
        lotId: id,
        fromStatus: current.status,
        note: input.note,
        evaluation,
        rule: facts.rule,
      });
    }
    const [row] = await tx
      .update(stockLots)
      .set({
        status: input.status,
        statusChangedAt: new Date(),
        statusChangedBy: actorId,
        statusNote: input.note,
      })
      .where(eq(stockLots.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [lotChange(row!)]);
    // A status change overtakes any pending release exception: it was asked about the lot as it was.
    await tx
      .update(lotReleaseExceptionRequests)
      .set({
        status: "superseded",
        decidedBy: actorId,
        decidedAt: new Date(),
        decisionNote: `The lot's status was changed to ${input.status}`,
      })
      .where(
        and(eq(lotReleaseExceptionRequests.lotId, id), eq(lotReleaseExceptionRequests.status, "pending")),
      );
    // Batches that reserved the lot (production module): tell their planners it is no longer usable.
    if (input.status !== "available") {
      notified = await notifyReservedLotStatus(
        tx,
        workspaceId,
        actorId,
        await workspaceToday(tx, workspaceId),
        id,
      );
    }
    return getLot(tx, workspaceId, id);
  });
  void deliverNotifications(db, notified);
  return lot;
}

// ─── Stocktakes ──────────────────────────────────────────────────────────────

/**
 * Posts a `stocktake` movement for every count that differs from the ledger, in one transaction,
 * and returns the variances. The movements share a reference (generated when not given).
 */
export async function postStocktake(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: StocktakeInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const now = new Date();
    const reference = input.reference ?? `ST-${now.toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
    const variances = [];
    const toInsert: Omit<typeof stockMovements.$inferInsert, "workspaceId">[] = [];
    const itemsById = new Map<string, ItemRow>();
    for (const count of input.counts) {
      const { lot, item } = await findLot(tx, workspaceId, count.lotId);
      const location = await findLocation(tx, workspaceId, count.locationId);
      itemsById.set(item.id, item);
      const counted = toBase(count.countedQuantity, count.unit, item, { allowZero: true });
      const expected = await balanceAt(tx, lot.id, location.id);
      const variance = roundQuantity(counted - expected);
      if (variance < 0) await assertAvailable(tx, lot.id, location, item, -variance);
      variances.push({
        lotId: lot.id,
        lotCode: lot.lotCode,
        item: itemSummary(item),
        locationId: location.id,
        locationName: location.name,
        expected: stockAmount(expected, item),
        counted: stockAmount(counted, item),
        variance: stockAmount(variance, item),
      });
      if (variance !== 0) {
        toInsert.push({
          lotId: lot.id,
          itemId: item.id,
          locationId: location.id,
          quantity: variance,
          type: "stocktake",
          reason: input.reason ?? null,
          reference,
          actorId,
          occurredAt: now,
        });
      }
    }
    const rows = toInsert.length ? await insertMovements(tx, workspaceId, toInsert) : [];
    await recordChanges(tx, workspaceId, actorId, rows.map(movementChange));
    return { reference, posted: rows.length, variances };
  });
}

// ─── Reversals ───────────────────────────────────────────────────────────────

/**
 * Corrects a movement by appending its opposite (`reversesMovementId` points back). A movement is
 * reversed once; the two rows of a transfer are reversed together. The reversal may not leave a
 * negative balance.
 */
export async function reverseMovement(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  reason: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [target] = await tx
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.id, id), eq(stockMovements.workspaceId, workspaceId)));
    if (!target) throw notFound("Movement");
    const originals = target.transferId
      ? await tx
          .select()
          .from(stockMovements)
          .where(
            and(eq(stockMovements.transferId, target.transferId), isNull(stockMovements.reversesMovementId)),
          )
      : [target];
    const already = await tx
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(
        inArray(
          stockMovements.reversesMovementId,
          originals.map((o) => o.id),
        ),
      );
    if (target.type === "customer_return")
      throw new ApiError(
        409,
        "return_movement",
        "Correct customer return receipts through their despatch return workflow",
      );
    if (target.type === "despatch") {
      throw new ApiError(
        409,
        "despatch_movement",
        "This movement belongs to a despatch; correct it by voiding that despatch",
      );
    }
    if (target.type === "consumption" || target.type === "production") {
      throw new ApiError(
        409,
        "production_movement",
        "This movement belongs to a production batch record; correct it from the batch",
      );
    }
    if (target.reversesMovementId) {
      throw new ApiError(
        409,
        "not_reversible",
        "This movement is itself a reversal; post an adjustment instead",
      );
    }
    if (already.length) {
      throw new ApiError(409, "already_reversed", "This movement has already been reversed");
    }
    const { item } = await findLot(tx, workspaceId, target.lotId);
    // Apply the reversal's withdrawals against the balances they touch.
    const net = new Map<string, number>();
    for (const o of originals) net.set(o.locationId, (net.get(o.locationId) ?? 0) - o.quantity);
    for (const [locationId, change] of net) {
      if (change >= 0) continue;
      const location = await findLocation(tx, workspaceId, locationId);
      await assertAvailable(tx, target.lotId, location, item, -change);
    }
    const now = new Date();
    const rows = await insertMovements(
      tx,
      workspaceId,
      originals.map((o) => ({
        lotId: o.lotId,
        itemId: o.itemId,
        locationId: o.locationId,
        quantity: -o.quantity,
        type: o.type,
        reason,
        reference: o.reference,
        transferId: o.transferId,
        reversesMovementId: o.id,
        actorId,
        occurredAt: now,
      })),
    );
    await recordChanges(tx, workspaceId, actorId, rows.map(movementChange));
    return {
      movements: rows.map((m) => ({
        ...serializeMovement(m),
        amount: stockAmount(m.quantity, item),
        label: `Reversal of ${stockMovementTypeLabels[m.type as StockMovementType].toLowerCase()}`,
      })),
    };
  });
}

// ─── FEFO pick suggestion ────────────────────────────────────────────────────

export type StockPickCandidate = PickCandidate & { lotCode: string; locationName: string; itemId: string };

/**
 * Every positive lot balance of the given items, as FEFO candidates (any status: `pickFefo`
 * filters). Shared with the production module's pick suggestion and material requirements.
 */
export async function pickCandidates(
  db: Executor,
  workspaceId: string,
  itemIds: string[],
): Promise<StockPickCandidate[]> {
  if (itemIds.length === 0) return [];
  const rows = await db
    .select({
      lot: stockLots,
      locationId: stockBalances.locationId,
      locationName: stockLocations.name,
      total: stockBalances.quantity,
    })
    .from(stockBalances)
    .innerJoin(stockLots, eq(stockLots.id, stockBalances.lotId))
    .innerJoin(stockLocations, eq(stockLocations.id, stockBalances.locationId))
    .where(
      and(
        eq(stockBalances.workspaceId, workspaceId),
        inArray(stockBalances.itemId, [...new Set(itemIds)]),
        sql`${stockBalances.quantity} > 0`,
        isNull(stockLots.deletedAt),
      ),
    );
  return rows.map((r) => ({
    lotId: r.lot.id,
    itemId: r.lot.itemId,
    lotCode: r.lot.lotCode,
    locationId: r.locationId,
    locationName: r.locationName,
    quantity: num(r.total),
    status: r.lot.status,
    expiresOn: r.lot.expiresOn,
    expiryType: r.lot.expiryType,
    receivedOn: r.lot.receivedOn,
  }));
}

/** Suggests which lots to use for `quantity` of an item, first expired first out. Reserves nothing. */
export async function suggestPick(db: Database, workspaceId: string, itemId: string, query: StockPickQuery) {
  const item = await findItem(db, workspaceId, itemId);
  const required = toBase(query.quantity, query.unit, item);
  const candidates = await pickCandidates(db, workspaceId, [item.id]);
  const result = pickFefo(candidates, required, await today(db, workspaceId));
  return {
    item: itemSummary(item),
    required: stockAmount(required, item),
    allocated: stockAmount(result.allocated, item),
    shortfall: stockAmount(result.shortfall, item),
    allocations: result.allocations.map(({ candidate, quantity, pastBestBefore }) => ({
      lotId: candidate.lotId,
      lotCode: candidate.lotCode,
      locationId: candidate.locationId,
      locationName: candidate.locationName,
      expiresOn: candidate.expiresOn,
      expiryType: candidate.expiryType,
      receivedOn: candidate.receivedOn,
      pastBestBefore,
      amount: stockAmount(quantity, item),
    })),
  };
}
