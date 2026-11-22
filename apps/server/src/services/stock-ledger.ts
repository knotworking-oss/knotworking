import { despatchAllocated } from "./despatch-allocations";
/** Shared stock ledger contract: units, tenant-scoped lookups, balances, serializers and posting. */
import {
  lotLocationKey,
  roundQuantity,
  itemBaseUnit,
  stockAmount,
  toBaseQuantity,
  unitsForItem,
  type UnitCode,
} from "@knotworking/core";
import {
  items,
  stockBalances,
  stockLocations,
  stockLots,
  stockMovements,
  type ChangeInput,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
type ItemRow = typeof items.$inferSelect;
type LocationRow = typeof stockLocations.$inferSelect;
type LotRow = typeof stockLots.$inferSelect;
type MovementRow = typeof stockMovements.$inferSelect;
/** Sums come back from Postgres as numeric strings. */
export const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));

export const sumQuantity = sql<string>`coalesce(sum(${stockMovements.quantity}), 0)`;

/**
 * Stock per lot (at one location when given) from `stock_balances`, for lots holding stock only. A
 * subquery to join to `stock_lots` on `lotId`. Reads the stored balances, so its cost follows the stock
 * on hand, not the length of the ledger. With `positiveOnly`, lots whose total is not above zero are left out.
 */
export function lotBalances(
  db: Executor,
  workspaceId: string,
  opts: { locationId?: string; positiveOnly?: boolean } = {},
) {
  return db
    .select({ lotId: stockBalances.lotId, qty: sql<string>`sum(${stockBalances.quantity})`.as("qty") })
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.workspaceId, workspaceId),
        sql`${stockBalances.quantity} <> 0`,
        opts.locationId ? eq(stockBalances.locationId, opts.locationId) : undefined,
      ),
    )
    .groupBy(stockBalances.lotId)
    .having(
      opts.positiveOnly ? sql`sum(${stockBalances.quantity}) > 0` : sql`sum(${stockBalances.quantity}) <> 0`,
    )
    .as("per_lot");
}

/**
 * The total for a paged list: when the first page isn't full it is the page's own length, so the common
 * case needs no count query. Otherwise `count` runs.
 */
export async function pageTotal(
  rows: unknown[],
  page: { limit: number; offset: number },
  count: () => Promise<number>,
): Promise<number> {
  return page.offset === 0 && rows.length < page.limit ? rows.length : count();
}

// The serialisers, lookups and ledger primitives below are exported for the production module,
// which posts `consumption` and `production` movements through the same rules (base units, the
// workspace lock, no negative balances, append-only rows).

// ─── Serialisation ───────────────────────────────────────────────────────────

export function serializeLocation(row: LocationRow) {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
}

export function serializeLot(row: LotRow) {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
}

export function serializeMovement(row: MovementRow) {
  const { workspaceId: _ws, ...rest } = row;
  return rest;
}

export const itemSummary = (item: ItemRow) => ({
  id: item.id,
  code: item.code,
  name: item.name,
  type: item.type,
  unit: item.unit,
  status: item.status,
});

export const locationChange = (row: LocationRow): ChangeInput => ({
  entity: "stock_location",
  entityId: row.id,
  action: "upsert",
  data: serializeLocation(row),
});
export const lotChange = (row: LotRow): ChangeInput => ({
  entity: "stock_lot",
  entityId: row.id,
  action: "upsert",
  data: serializeLot(row),
});
export const movementChange = (row: MovementRow): ChangeInput => ({
  entity: "stock_movement",
  entityId: row.id,
  action: "upsert",
  data: serializeMovement(row),
});

// ─── Lookups ─────────────────────────────────────────────────────────────────

export async function findItem(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(items)
    .where(and(eq(items.id, id), eq(items.workspaceId, workspaceId), isNull(items.deletedAt)));
  if (!row) throw notFound("Item");
  return row;
}

export async function findLocation(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.id, id),
        eq(stockLocations.workspaceId, workspaceId),
        isNull(stockLocations.deletedAt),
      ),
    );
  if (!row) throw notFound("Location");
  return row;
}

/** A location stock may be put into: it must not be archived. */
export async function findActiveLocation(db: Executor, workspaceId: string, id: string) {
  const row = await findLocation(db, workspaceId, id);
  if (row.status !== "active") {
    throw new ApiError(409, "location_archived", `${row.name} is archived; choose another location`);
  }
  return row;
}

export async function findLot(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select({ lot: stockLots, item: items })
    .from(stockLots)
    .innerJoin(items, eq(items.id, stockLots.itemId))
    .where(and(eq(stockLots.id, id), eq(stockLots.workspaceId, workspaceId), isNull(stockLots.deletedAt)));
  if (!row) throw notFound("Lot");
  return row;
}

/**
 * Converts an entered quantity to the item's base unit, rounded to the ledger's 4 decimal places
 * (the only place a quantity is rounded). 400 when the unit can't be converted for this item.
 */
export function toBase(
  quantity: number,
  unit: UnitCode,
  item: ItemRow,
  { allowZero = false, max }: { allowZero?: boolean; max?: number } = {},
): number {
  const base = toBaseQuantity(quantity, unit, item);
  if (base === null) {
    throw new ApiError(
      400,
      "unit_not_convertible",
      `${item.name} is measured in ${item.unit}; ${unit} can't be converted without a density or unit weight. Use one of: ${unitsForItem(item).join(", ")}`,
    );
  }
  if (base === 0 && !allowZero && quantity !== 0) {
    throw badRequest("The quantity is too small to record (below 0.0001 of the base unit)");
  }
  if (max !== undefined && Math.abs(base) > max) {
    throw badRequest(
      `The quantity is too large to record (at most ${max.toLocaleString("en-GB")} ${itemBaseUnit(item)} of ${item.name})`,
    );
  }
  return base;
}

/** The current balance of a lot at a location, read inside the caller's transaction. */
export async function balanceAt(tx: Executor, lotId: string, locationId: string): Promise<number> {
  const [row] = await tx
    .select({ total: stockBalances.quantity })
    .from(stockBalances)
    .where(and(eq(stockBalances.lotId, lotId), eq(stockBalances.locationId, locationId)));
  return num(row?.total);
}

function insufficientStock(available: number, item: ItemRow, location: LocationRow) {
  const amount = stockAmount(available, item);
  return new ApiError(
    409,
    "insufficient_stock",
    `Only ${amount.display} ${amount.displayUnit} of this lot is at ${location.name}`,
    { available: amount, locationId: location.id },
  );
}

/** Takes `quantity` (base, positive) out of a lot at a location, or 409 if it isn't there. */
export async function assertAvailable(
  tx: Transaction,
  lotId: string,
  location: LocationRow,
  item: ItemRow,
  quantity: number,
  opts: { exceptDespatchId?: string } = {},
) {
  const balance = await balanceAt(tx, lotId, location.id);
  if (balance < quantity) throw insufficientStock(balance, item, location);
  const allocated =
    (await despatchAllocated(tx, item.workspaceId, { lotIds: [lotId], ...opts })).locations.get(
      lotLocationKey(lotId, location.id),
    ) ?? 0;
  if (roundQuantity(balance - allocated) < quantity)
    throw new ApiError(
      409,
      "stock_allocated",
      "This stock has been allocated to a despatch. Release its allocation before using or correcting it.",
    );
  return balance;
}

export async function insertMovements(
  tx: Transaction,
  workspaceId: string,
  rows: Omit<typeof stockMovements.$inferInsert, "workspaceId">[],
) {
  return tx
    .insert(stockMovements)
    .values(rows.map((r) => ({ ...r, workspaceId })))
    .returning();
}
