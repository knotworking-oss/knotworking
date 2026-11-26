import { inheritIncidentHolds } from "./incident-holds";
import { executeLedgerCommand } from "./ledger-command";
import {
  addDays,
  batchCodePrefix,
  batchFactor,
  batchMaterials,
  batchSizeTarget,
  canTransitionBatch,
  classifyExpiry,
  generateBatchCode,
  isPickable,
  lotLocationKey,
  reservationExpired,
  lotMassBalance,
  materialRequirements,
  netOfReservations,
  newId,
  openBatchStatuses,
  outstandingQuantity,
  pickFefo,
  planFromDemand,
  plannedOutputBase,
  productionBatchStatusLabels,
  recordMovementType,
  roundQuantity,
  stockAmount,
  type BatchMaterial,
  type ExpiryType,
  type LotTraceQuery,
  type MaterialRequirementsQuery,
  type PlanFromDemandQuery,
  type ProductionBatchCompleteInput,
  type ProductionBatchCreateInput,
  type ProductionBatchListQuery,
  type ProductionBatchStatus,
  type ProductionBatchUpdateInput,
  type ProductionConsumptionInput,
  type ProductionOutputInput,
  type ProductionPlanBatchesInput,
  type RequirementStock,
} from "@knotworking/core";
import {
  items,
  lockWorkspaceLog,
  productionBatches,
  productionPackingRuns,
  productionLines,
  productionRecords,
  productionReservations,
  recipeLines,
  recipes,
  recipeVersions,
  recordChanges,
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
import { and, asc, count, eq, gte, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { getDemandSummary } from "./ports/demand";
import {
  assertAvailable,
  createLot,
  findActiveLocation,
  findItem,
  findLocation,
  findLot,
  insertMovements,
  itemSummary,
  lotChange,
  lotCodeTaken,
  movementChange,
  num,
  pickCandidates,
  toBase,
} from "./ports/stock";
import { assertAssignableLine, batchCalendarCheck, lineCheck } from "./production-lines";
import {
  fulfilForConsumption,
  heldOf,
  onHandOf,
  releaseBatchReservations,
  reservedByLot,
  reservedByLotLocation,
  serializeReservation,
} from "./reservations-core";
import { workspaceToday } from "./time-zone";

/**
 * Production module: batches, material requirements and batch records.
 *
 * - A batch pins the recipe's approved version when it is planned (`recipe_version_id`), so
 *   "which batches used which version" is a query. A planned batch can be moved to a newer
 *   approved version; a batch can't start on a version that has been superseded.
 * - Batch records are append-only. Each posts one stock movement through the stock module's
 *   ledger primitives (base units, workspace lock, balance re-read inside the transaction, no
 *   negative balances): `consumption` out of an ingredient lot, `production` into the lot the
 *   batch makes. A correction is a reversal record with its own reversing movement.
 * - Completing a batch is the sign-off (`manage`, a signed-in person; the route enforces it). It
 *   records who and when; after it, only a person with `manage` can post corrections.
 * - Requirements and traces are computed on read. Batches and records go to the sync log
 *   (`production_batch`, `production_record`), not the bootstrap.
 *
 * - Planning from demand (`getPlanFromDemand`, `planBatches`) reads the demand module's summary
 *   (a soft dependency: the route asks for Demand read access) and plans through the same `insertBatch` as `createBatch`.
 */

type BatchRow = typeof productionBatches.$inferSelect;
type RecordRow = typeof productionRecords.$inferSelect;
type ItemRow = typeof items.$inferSelect;
type VersionRow = typeof recipeVersions.$inferSelect;
type LotRow = typeof stockLots.$inferSelect;

/** `%` and `_` are literal in a search box. */
const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;

// ─── Serialisation ───────────────────────────────────────────────────────────

function serializeBatch(row: BatchRow) {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
}

function serializeRecord(row: RecordRow) {
  const { workspaceId: _ws, ...rest } = row;
  return rest;
}

const batchChange = (row: BatchRow): ChangeInput => ({
  entity: "production_batch",
  entityId: row.id,
  action: "upsert",
  data: serializeBatch(row),
});
const recordChange = (row: RecordRow): ChangeInput => ({
  entity: "production_record",
  entityId: row.id,
  action: "upsert",
  data: serializeRecord(row),
});

/** Names of users by id (also used by the haccp module). */
export async function userNames(db: Executor, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((u) => [u.id, u.name]));
}

/** Items by id, archived or deleted included: an old batch keeps showing what it used. */
async function itemsById(db: Executor, workspaceId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, ItemRow>();
  const rows = await db
    .select()
    .from(items)
    .where(and(eq(items.workspaceId, workspaceId), inArray(items.id, [...new Set(ids)])));
  return new Map(rows.map((r) => [r.id, r]));
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

/** A live batch of the workspace, or 404 (also used by the haccp module). */
export async function findBatch(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(productionBatches)
    .where(
      and(
        eq(productionBatches.id, id),
        eq(productionBatches.workspaceId, workspaceId),
        isNull(productionBatches.deletedAt),
      ),
    );
  if (!row) throw notFound("Batch");
  return row;
}

async function findRecipe(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(recipes)
    .where(and(eq(recipes.id, id), eq(recipes.workspaceId, workspaceId), isNull(recipes.deletedAt)));
  if (!row) throw notFound("Recipe");
  return row;
}

async function approvedVersionOf(db: Executor, recipeId: string) {
  const [row] = await db
    .select()
    .from(recipeVersions)
    .where(
      and(
        eq(recipeVersions.recipeId, recipeId),
        eq(recipeVersions.status, "approved"),
        isNull(recipeVersions.deletedAt),
      ),
    );
  return row ?? null;
}

/** Versions with their lines and every item they name (the output item included). */
async function loadVersions(
  db: Executor,
  workspaceId: string,
  versionIds: string[],
  outputItemIds: string[],
) {
  const ids = [...new Set(versionIds)];
  const versions = ids.length
    ? await db.select().from(recipeVersions).where(inArray(recipeVersions.id, ids))
    : [];
  const lines = ids.length
    ? await db
        .select()
        .from(recipeLines)
        .where(inArray(recipeLines.versionId, ids))
        .orderBy(asc(recipeLines.sortOrder), asc(recipeLines.id))
    : [];
  const itemMap = await itemsById(db, workspaceId, [...outputItemIds, ...lines.map((l) => l.itemId)]);
  return {
    versions: new Map(versions.map((v) => [v.id, v])),
    linesOf: (versionId: string) => lines.filter((l) => l.versionId === versionId),
    itemMap,
  };
}

type Loaded = Awaited<ReturnType<typeof loadVersions>>;

/** The number of batches a planned output is, rounded for display; `null` without a yield. */
function factorOf(batch: BatchRow, version: VersionRow | undefined, output: ItemRow | undefined) {
  if (!version || !output) return null;
  const factor = batchFactor(version, output, batch.plannedQuantity);
  return factor === null ? null : roundQuantity(factor);
}

/** What a batch needs of each ingredient (base units), from its pinned version. */
function materialsOf(batch: BatchRow, loaded: Loaded): BatchMaterial[] {
  const version = loaded.versions.get(batch.recipeVersionId);
  const output = loaded.itemMap.get(batch.outputItemId);
  if (!version || !output) return [];
  const factor = batchFactor(version, output, batch.plannedQuantity);
  const lines = loaded.linesOf(version.id).map((l) => ({
    itemId: l.itemId,
    quantity: l.quantity,
    unit: l.unit,
    item: loaded.itemMap.get(l.itemId)!,
  }));
  if (factor === null) return lines.map((l) => ({ itemId: l.itemId, required: null }));
  return batchMaterials(lines, factor);
}

/** Net quantity per batch, lot and kind (reversals cancel what they reverse). */
async function netRecords(db: Executor, where: SQL) {
  const rows = await db
    .select({
      batchId: productionRecords.batchId,
      lotId: productionRecords.lotId,
      itemId: productionRecords.itemId,
      kind: productionRecords.kind,
      total: sql<string>`sum(${productionRecords.quantity})`,
    })
    .from(productionRecords)
    .where(where)
    .groupBy(
      productionRecords.batchId,
      productionRecords.lotId,
      productionRecords.itemId,
      productionRecords.kind,
    )
    .having(sql`sum(${productionRecords.quantity}) <> 0`);
  return rows.map((r) => ({ ...r, total: num(r.total) }));
}

async function assertBatchCodeFree(tx: Executor, workspaceId: string, code: string, exceptId?: string) {
  const [taken] = await tx
    .select({ id: productionBatches.id })
    .from(productionBatches)
    .where(
      and(
        eq(productionBatches.workspaceId, workspaceId),
        isNull(productionBatches.deletedAt),
        sql`lower(${productionBatches.batchCode}) = lower(${code})`,
        exceptId ? ne(productionBatches.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `Another batch already uses the code "${code}"`);
}

/** The next generated batch code for a planned date: `B` + yymmdd + a sequence per workspace and day. */
async function nextBatchCode(tx: Executor, workspaceId: string, plannedOn: string) {
  const prefix = batchCodePrefix(plannedOn);
  const rows = await tx
    .select({ code: productionBatches.batchCode })
    .from(productionBatches)
    .where(
      and(
        eq(productionBatches.workspaceId, workspaceId),
        sql`${productionBatches.batchCode} ilike ${`${prefix}%`}`,
      ),
    );
  const pattern = new RegExp(`^${prefix}(\\d+)$`, "i");
  const max = rows.reduce((m, r) => Math.max(m, Number(pattern.exec(r.code)?.[1] ?? 0)), 0);
  return generateBatchCode(plannedOn, max + 1);
}

function plannedBase(version: VersionRow, output: ItemRow, input: Parameters<typeof batchSizeTarget>[0]) {
  const target = batchSizeTarget(input);
  if (!target) return null;
  const base = plannedOutputBase(version, output, target);
  if (base === null) {
    throw new ApiError(
      400,
      "unit_not_convertible",
      `Can't size the batch: the recipe has no yield, or ${"outputUnit" in target ? target.outputUnit : "its yield unit"} can't be converted for ${output.name}`,
    );
  }
  if (!(base > 0)) throw badRequest("The batch is too small to record");
  return base;
}

export function assertStatus(batch: BatchRow, allowed: readonly ProductionBatchStatus[], action: string) {
  if (!allowed.includes(batch.status)) {
    throw new ApiError(
      409,
      "invalid_batch_status",
      `Batch ${batch.batchCode} is ${productionBatchStatusLabels[batch.status].toLowerCase()}; it can't ${action}`,
    );
  }
}

// ─── Reading ─────────────────────────────────────────────────────────────────

const batchSelect = {
  batch: productionBatches,
  recipeCode: recipes.code,
  recipeName: recipes.name,
  locationName: stockLocations.name,
  lineName: productionLines.name,
};

function batchQuery(db: Executor) {
  return db
    .select(batchSelect)
    .from(productionBatches)
    .innerJoin(recipes, eq(recipes.id, productionBatches.recipeId))
    .leftJoin(stockLocations, eq(stockLocations.id, productionBatches.outputLocationId))
    .leftJoin(productionLines, eq(productionLines.id, productionBatches.lineId));
}

type BatchJoin = {
  batch: BatchRow;
  recipeCode: string;
  recipeName: string;
  locationName: string | null;
  lineName: string | null;
};

/** Batch summaries: recipe, version, output item, planned and produced amounts. */
async function summarize(db: Executor, workspaceId: string, rows: BatchJoin[]) {
  const loaded = await loadVersions(
    db,
    workspaceId,
    rows.map((r) => r.batch.recipeVersionId),
    rows.map((r) => r.batch.outputItemId),
  );
  const ids = rows.map((r) => r.batch.id);
  const produced = ids.length
    ? await db
        .select({
          batchId: productionRecords.batchId,
          total: sql<string>`sum(${productionRecords.quantity})`,
        })
        .from(productionRecords)
        .where(and(inArray(productionRecords.batchId, ids), eq(productionRecords.kind, "output")))
        .groupBy(productionRecords.batchId)
    : [];
  const producedBy = new Map(produced.map((p) => [p.batchId, num(p.total)]));
  return {
    loaded,
    batches: rows.map(({ batch, recipeCode, recipeName, locationName, lineName }) => {
      const version = loaded.versions.get(batch.recipeVersionId);
      const output = loaded.itemMap.get(batch.outputItemId)!;
      return {
        ...serializeBatch(batch),
        recipe: { id: batch.recipeId, code: recipeCode, name: recipeName },
        recipeVersion: version
          ? { id: version.id, versionNumber: version.versionNumber, status: version.status }
          : null,
        outputItem: itemSummary(output),
        outputLocation: batch.outputLocationId ? { id: batch.outputLocationId, name: locationName } : null,
        line: batch.lineId ? { id: batch.lineId, name: lineName } : null,
        planned: stockAmount(batch.plannedQuantity, output),
        batches: factorOf(batch, version, output),
        produced: stockAmount(producedBy.get(batch.id) ?? 0, output),
      };
    }),
  };
}

/** The schedule: batches by planned date, then code. */
export async function listBatches(db: Database, workspaceId: string, query: ProductionBatchListQuery) {
  const where: (SQL | undefined)[] = [
    eq(productionBatches.workspaceId, workspaceId),
    isNull(productionBatches.deletedAt),
  ];
  if (query.from) where.push(gte(productionBatches.plannedOn, query.from));
  if (query.to) where.push(lte(productionBatches.plannedOn, query.to));
  if (query.status === "open") where.push(inArray(productionBatches.status, [...openBatchStatuses]));
  else if (query.status !== "all") where.push(eq(productionBatches.status, query.status));
  if (query.recipeId) where.push(eq(productionBatches.recipeId, query.recipeId));
  if (query.recipeVersionId) where.push(eq(productionBatches.recipeVersionId, query.recipeVersionId));
  if (query.outputItemId) where.push(eq(productionBatches.outputItemId, query.outputItemId));
  if (query.q) {
    where.push(
      or(
        sql`${productionBatches.batchCode} ilike ${like(query.q)} escape '!'`,
        sql`${recipes.code} ilike ${like(query.q)} escape '!'`,
        sql`${recipes.name} ilike ${like(query.q)} escape '!'`,
      ),
    );
  }
  const [rows, [total]] = await Promise.all([
    batchQuery(db)
      .where(and(...where))
      .orderBy(asc(productionBatches.plannedOn), asc(productionBatches.batchCode), asc(productionBatches.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(productionBatches)
      .innerJoin(recipes, eq(recipes.id, productionBatches.recipeId))
      .where(and(...where)),
  ]);
  const { batches } = await summarize(db, workspaceId, rows);
  return { batches, total: total?.n ?? 0, limit: query.limit, offset: query.offset };
}

/**
 * One batch in full: the pinned version's lines scaled to the batch, what has been consumed of
 * each ingredient, the batch record (every row, reversals included) and the lots it produced.
 */
export async function getBatch(db: Executor, workspaceId: string, id: string) {
  return (await loadBatch(db, workspaceId, id)).detail;
}

/** A batch in full, with the items it names (`items`, by id) for callers that need the rows. */
async function loadBatch(db: Executor, workspaceId: string, id: string) {
  await findBatch(db, workspaceId, id);
  const [row] = await batchQuery(db).where(eq(productionBatches.id, id));
  const { batches, loaded } = await summarize(db, workspaceId, [row!]);
  const batch = row!.batch;
  const summary = batches[0]!;
  const version = loaded.versions.get(batch.recipeVersionId);
  const output = loaded.itemMap.get(batch.outputItemId)!;

  const records = await db
    .select({
      record: productionRecords,
      lot: stockLots,
      locationName: stockLocations.name,
      actorName: users.name,
    })
    .from(productionRecords)
    .innerJoin(stockLots, eq(stockLots.id, productionRecords.lotId))
    .innerJoin(stockLocations, eq(stockLocations.id, productionRecords.locationId))
    .leftJoin(users, eq(users.id, productionRecords.actorId))
    .where(eq(productionRecords.batchId, id))
    .orderBy(asc(productionRecords.occurredAt), asc(productionRecords.createdAt), asc(productionRecords.id));
  const recordItems = await itemsById(
    db,
    workspaceId,
    records.map((r) => r.record.itemId),
  );
  const reversed = new Set(records.map((r) => r.record.reversesRecordId).filter(Boolean));

  const consumedByItem = new Map<string, number>();
  const producedByLot = new Map<string, { lot: LotRow; total: number }>();
  for (const { record, lot } of records) {
    if (record.kind === "consumption") {
      consumedByItem.set(
        record.itemId,
        roundQuantity((consumedByItem.get(record.itemId) ?? 0) + record.quantity),
      );
    } else {
      const entry = producedByLot.get(lot.id) ?? { lot, total: 0 };
      entry.total = roundQuantity(entry.total + record.quantity);
      producedByLot.set(lot.id, entry);
    }
  }

  const lines = version ? loaded.linesOf(version.id) : [];
  const materials = materialsOf(batch, loaded);
  // Ingredients consumed that are no longer (or never were) on the version still show.
  const materialIds = [...materials.map((m) => m.itemId)];
  for (const itemId of consumedByItem.keys()) if (!materialIds.includes(itemId)) materialIds.push(itemId);
  const allItems = new Map([...loaded.itemMap, ...recordItems]);

  const day = await workspaceToday(db, workspaceId);
  const reservationRows = await db
    .select({ r: productionReservations, lot: stockLots, locationName: stockLocations.name })
    .from(productionReservations)
    .innerJoin(stockLots, eq(stockLots.id, productionReservations.lotId))
    .leftJoin(stockLocations, eq(stockLocations.id, productionReservations.locationId))
    .where(eq(productionReservations.batchId, id))
    .orderBy(asc(productionReservations.createdAt), asc(productionReservations.id));
  const reservedByItem = new Map<string, number>();
  for (const { r } of reservationRows) {
    reservedByItem.set(r.itemId, roundQuantity((reservedByItem.get(r.itemId) ?? 0) + heldOf(r, day)));
  }
  // "Runs out": what all active reservations hold of a lot (or of a lot at a location) is more than is there.
  const activeLotIds = [
    ...new Set(reservationRows.filter(({ r }) => r.status === "active").map(({ r }) => r.lotId)),
  ];
  const onHand = await onHandOf(db, activeLotIds);
  const heldAll = await reservedByLot(db, workspaceId, { lotIds: activeLotIds, today: day });
  const heldAtLocation = await reservedByLotLocation(db, workspaceId, { lotIds: activeLotIds, today: day });
  const check = await lineCheck(db, workspaceId, batch);
  const calendarWarning = await batchCalendarCheck(db, workspaceId, batch);

  const people = await userNames(db, [
    batch.createdBy,
    batch.startedBy,
    batch.completedBy,
    batch.cancelledBy,
  ]);
  const name = (userId: string | null) => (userId ? (people.get(userId) ?? null) : null);
  const detail = {
    ...summary,
    createdByName: name(batch.createdBy),
    startedByName: name(batch.startedBy),
    completedByName: name(batch.completedBy),
    cancelledByName: name(batch.cancelledBy),
    recipeVersion: version
      ? {
          id: version.id,
          versionNumber: version.versionNumber,
          status: version.status,
          yieldQuantity: version.yieldQuantity,
          yieldUnit: version.yieldUnit,
          approvedAt: version.approvedAt,
        }
      : null,
    lineCheck: check,
    /** Set when the planned date is a non-working day (the workspace's, or the line's): advisory. */
    calendarWarning,
    reservations: reservationRows.map(({ r, lot, locationName }) => {
      const item = allItems.get(r.itemId) ?? loaded.itemMap.get(r.itemId)!;
      const key = r.locationId ? lotLocationKey(r.lotId, r.locationId) : null;
      const short =
        r.status === "active" &&
        !reservationExpired(r, day) &&
        ((onHand.lots.get(r.lotId) ?? 0) + 1e-9 < (heldAll.get(r.lotId) ?? 0) ||
          (key !== null && (onHand.locations.get(key) ?? 0) + 1e-9 < (heldAtLocation.get(key) ?? 0)));
      return {
        ...serializeReservation(r),
        item: itemSummary(item),
        lotCode: lot.lotCode,
        lotStatus: lot.status,
        /** The lot's expiry (as before); the reservation's own last day is `reservationExpiresOn`. */
        expiresOn: lot.expiresOn,
        reservationExpiresOn: r.expiresOn,
        /** Past its last day and waiting for the next sweep to release it; it holds nothing. */
        expired: reservationExpired(r, day),
        locationName,
        /** There is less of the lot (or of the lot at its location) than active reservations hold. */
        short,
        expiryType: lot.expiryType,
        reserved: stockAmount(r.quantity, item),
        held: stockAmount(heldOf(r, day), item),
        /** The lot can no longer be consumed (not released, or past its use-by date). */
        lotUsable:
          lot.status === "available" &&
          !(lot.expiryType === "use_by" && lot.expiresOn !== null && lot.expiresOn < day),
      };
    }),
    materials: materialIds.map((itemId) => {
      const item = allItems.get(itemId)!;
      const material = materials.find((m) => m.itemId === itemId);
      // Not on the version (consumed anyway, e.g. before a version change): nothing was required.
      const required = material ? material.required : 0;
      const consumed = consumedByItem.get(itemId) ?? 0;
      const outstanding = outstandingQuantity(required, consumed);
      return {
        item: itemSummary(item),
        inRecipe: !!material,
        lines: lines
          .filter((l) => l.itemId === itemId)
          .map((l) => ({ id: l.id, quantity: l.quantity, unit: l.unit, note: l.note })),
        required: required === null ? null : stockAmount(required, item),
        consumed: stockAmount(consumed, item),
        outstanding: outstanding === null ? null : stockAmount(outstanding, item),
        reserved: stockAmount(reservedByItem.get(itemId) ?? 0, item),
      };
    }),
    outputs: [...producedByLot.values()].map(({ lot, total }) => ({
      lotId: lot.id,
      lotCode: lot.lotCode,
      status: lot.status,
      expiresOn: lot.expiresOn,
      expiryType: lot.expiryType,
      expiryState: classifyExpiry(lot.expiresOn, day),
      produced: stockAmount(total, output),
    })),
    records: records.map(({ record, lot, locationName, actorName }) => {
      const item = allItems.get(record.itemId)!;
      return {
        ...serializeRecord(record),
        amount: stockAmount(record.quantity, item),
        item: itemSummary(item),
        lotCode: lot.lotCode,
        lotStatus: lot.status,
        locationName,
        actorName,
        reversed: reversed.has(record.id),
      };
    }),
  };
  return { detail, items: allItems };
}

// ─── Planning ────────────────────────────────────────────────────────────────

/**
 * Plans a batch of a recipe's current approved version. The size is a number of batches or a
 * target output, stored as the planned output in the output item's base unit.
 */
export async function createBatch(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: ProductionBatchCreateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const row = await insertBatch(tx, workspaceId, actorId, input);
    return getBatch(tx, workspaceId, row.id);
  });
}

/**
 * The one way a batch is planned, inside a transaction that holds the workspace lock: checks the
 * recipe and its approved version, sizes the batch, checks or generates the code, inserts the row
 * and records the change.
 */
async function insertBatch(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  input: ProductionBatchCreateInput,
) {
  const recipe = await findRecipe(tx, workspaceId, input.recipeId);
  if (recipe.status === "archived") {
    throw new ApiError(409, "recipe_archived", `${recipe.name} is archived`);
  }
  const version = await approvedVersionOf(tx, recipe.id);
  if (!version) {
    throw new ApiError(
      409,
      "no_approved_version",
      `${recipe.name} has no approved version; a batch can only be made to an approved recipe`,
    );
  }
  const output = await findItem(tx, workspaceId, recipe.outputItemId);
  const plannedQuantity = plannedBase(version, output, input)!;
  if (input.outputLocationId) await findActiveLocation(tx, workspaceId, input.outputLocationId);
  if (input.lineId) await assertAssignableLine(tx, workspaceId, input.lineId);
  let batchCode = input.batchCode ?? null;
  if (batchCode) await assertBatchCodeFree(tx, workspaceId, batchCode);
  else batchCode = await nextBatchCode(tx, workspaceId, input.plannedOn);

  const [row] = await tx
    .insert(productionBatches)
    .values({
      ...(input.id ? { id: input.id } : {}),
      workspaceId,
      batchCode,
      recipeId: recipe.id,
      recipeVersionId: version.id,
      outputItemId: output.id,
      plannedOn: input.plannedOn,
      plannedQuantity,
      outputLocationId: input.outputLocationId ?? null,
      lineId: input.lineId ?? null,
      notes: input.notes ?? null,
      createdBy: actorId,
    })
    .returning();
  await recordChanges(tx, workspaceId, actorId, [batchChange(row!)]);
  return row!;
}

// ─── Planning from demand ────────────────────────────────────────────────────

/**
 * "Plan batches from demand", computed on read: demand per item per ISO week (the demand module's
 * `getDemandSummary`; Demand is a soft dependency, so the route checks the caller can read it),
 * against the batches already planned, in progress or made in each week, with the gap and the
 * whole batches of each item's recipe that cover it (`planFromDemand`). Nothing is stored.
 */
export async function getPlanFromDemand(db: Database, workspaceId: string, query: PlanFromDemandQuery) {
  const summary = await getDemandSummary(db, workspaceId, {
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
  });
  const weeks = summary.weeks.map((w) => w.periodStart);
  const itemIds = summary.rows.map((r) => r.item.id);
  const itemMap = await itemsById(db, workspaceId, itemIds);

  const recipeRows = itemIds.length
    ? await db
        .select({ recipe: recipes, version: recipeVersions })
        .from(recipes)
        .leftJoin(
          recipeVersions,
          and(
            eq(recipeVersions.recipeId, recipes.id),
            eq(recipeVersions.status, "approved"),
            isNull(recipeVersions.deletedAt),
          ),
        )
        .where(
          and(
            eq(recipes.workspaceId, workspaceId),
            isNull(recipes.deletedAt),
            inArray(recipes.outputItemId, itemIds),
          ),
        )
        .orderBy(asc(recipes.code), asc(recipes.id))
    : [];
  const batchRows = itemIds.length
    ? await batchQuery(db)
        .where(
          and(
            eq(productionBatches.workspaceId, workspaceId),
            isNull(productionBatches.deletedAt),
            ne(productionBatches.status, "cancelled"),
            inArray(productionBatches.outputItemId, itemIds),
            gte(productionBatches.plannedOn, summary.from),
            lte(productionBatches.plannedOn, addDays(summary.to, 6)),
          ),
        )
        .orderBy(
          asc(productionBatches.plannedOn),
          asc(productionBatches.batchCode),
          asc(productionBatches.id),
        )
    : [];
  const { batches } = await summarize(db, workspaceId, batchRows);
  const batchById = new Map(batches.map((b) => [b.id, b]));

  // A choice names a recipe; it applies to the item that recipe makes.
  const choices: Record<string, string> = {};
  for (const id of query.recipeIds) {
    const chosen = recipeRows.find((r) => r.recipe.id === id);
    if (chosen) choices[chosen.recipe.outputItemId] = id;
  }
  const rows = planFromDemand({
    weeks,
    items: itemMap,
    demand: summary.rows.flatMap((r) =>
      r.periods.map((p) => ({ itemId: r.item.id, periodStart: p.periodStart, quantity: p.quantity.base })),
    ),
    batches: batches.map((b) => ({
      id: b.id,
      itemId: b.outputItemId,
      plannedOn: b.plannedOn,
      status: b.status,
      planned: b.planned.base,
      produced: b.produced.base,
    })),
    recipes: recipeRows.map(({ recipe, version }) => ({
      id: recipe.id,
      outputItemId: recipe.outputItemId,
      status: recipe.status,
      approvedVersion: version,
    })),
    choices,
  });

  const recipeView = (id: string, item: ItemRow) => {
    const { recipe, version } = recipeRows.find((r) => r.recipe.id === id)!;
    const perBatch = version ? plannedOutputBase(version, item, { batches: 1 }) : null;
    return {
      id: recipe.id,
      code: recipe.code,
      name: recipe.name,
      version: version ? { id: version.id, versionNumber: version.versionNumber } : null,
      perBatch: perBatch !== null && perBatch > 0 ? stockAmount(perBatch, item) : null,
    };
  };
  return {
    from: summary.from,
    to: summary.to,
    weeks: summary.weeks,
    rows: rows.map((row) => {
      const item = itemMap.get(row.itemId)!;
      const amount = (q: number) => stockAmount(q, item);
      return {
        item: itemSummary(item),
        recipe: row.recipeId ? recipeView(row.recipeId, item) : null,
        options: row.optionIds.map((id) => recipeView(id, item)),
        issue: row.issue,
        perBatch: row.perBatch === null ? null : amount(row.perBatch),
        cells: row.cells.map((cell, i) => ({
          ...summary.weeks[i]!,
          demand: amount(cell.demand),
          planned: amount(cell.planned),
          gap: amount(cell.gap),
          suggestedBatches: cell.suggestedBatches,
          suggestedOutput: amount(cell.suggestedOutput),
          batches: cell.batchIds.map((id) => {
            const b = batchById.get(id)!;
            return {
              id: b.id,
              batchCode: b.batchCode,
              status: b.status,
              plannedOn: b.plannedOn,
              recipe: b.recipe,
              planned: b.planned,
              produced: b.produced,
            };
          }),
        })),
        totals: {
          demand: amount(row.totals.demand),
          planned: amount(row.totals.planned),
          gap: amount(row.totals.gap),
          suggestedBatches: row.totals.suggestedBatches,
          suggestedOutput: amount(row.totals.suggestedOutput),
        },
      };
    }),
  };
}

/**
 * Creates several batches in one transaction, each exactly as `createBatch` would (same checks,
 * codes and sync log), all or nothing. A refusal names the batch it is about (`details.index`,
 * counting from 0). Planning is not a sign-off: `write`, API tokens allowed.
 */
export async function planBatches(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: ProductionPlanBatchesInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const ids: string[] = [];
    for (const [index, entry] of input.batches.entries()) {
      try {
        ids.push((await insertBatch(tx, workspaceId, actorId, entry)).id);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        throw new ApiError(
          err.status,
          err.code,
          `Batch ${index + 1} (${entry.plannedOn}): ${err.message}. Nothing was planned.`,
          { index, ...(err.details !== undefined ? { cause: err.details } : {}) },
        );
      }
    }
    const rows = await batchQuery(tx)
      .where(inArray(productionBatches.id, ids))
      .orderBy(asc(productionBatches.plannedOn), asc(productionBatches.batchCode), asc(productionBatches.id));
    const { batches } = await summarize(tx, workspaceId, rows);
    return { batches };
  });
}

/**
 * Changes a batch. Rescheduling, resizing, recoding or moving to the current approved version
 * only while it is planned; the output location and notes until it is closed.
 */
export async function updateBatch(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: ProductionBatchUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const batch = await findBatch(tx, workspaceId, id);
    assertStatus(batch, openBatchStatuses, "be changed");
    const planningChange =
      patch.plannedOn !== undefined ||
      patch.batches !== undefined ||
      patch.outputQuantity !== undefined ||
      patch.batchCode !== undefined ||
      patch.recipeVersionId !== undefined;
    if (planningChange)
      assertStatus(batch, ["planned"], "be rescheduled, resized or moved to another version");

    const set: Partial<typeof productionBatches.$inferInsert> = {};
    let versionId = batch.recipeVersionId;
    if (patch.recipeVersionId !== undefined) {
      const approved = await approvedVersionOf(tx, batch.recipeId);
      if (!approved || approved.id !== patch.recipeVersionId) {
        throw new ApiError(
          409,
          "version_not_approved",
          "A batch can only move to the recipe's approved version",
        );
      }
      versionId = approved.id;
      if (approved.id !== batch.recipeVersionId) set.recipeVersionId = approved.id;
    }
    if (patch.batches !== undefined || patch.outputQuantity !== undefined) {
      const [version] = await tx.select().from(recipeVersions).where(eq(recipeVersions.id, versionId));
      const output = await findItem(tx, workspaceId, batch.outputItemId);
      set.plannedQuantity = plannedBase(version!, output, patch)!;
    }
    if (patch.plannedOn !== undefined) set.plannedOn = patch.plannedOn;
    if (patch.batchCode !== undefined) {
      await assertBatchCodeFree(tx, workspaceId, patch.batchCode, id);
      set.batchCode = patch.batchCode;
    }
    if (patch.outputLocationId !== undefined) {
      if (patch.outputLocationId) await findActiveLocation(tx, workspaceId, patch.outputLocationId);
      set.outputLocationId = patch.outputLocationId;
    }
    if (patch.lineId !== undefined) {
      if (patch.lineId && patch.lineId !== batch.lineId)
        await assertAssignableLine(tx, workspaceId, patch.lineId);
      set.lineId = patch.lineId;
    }
    if (patch.notes !== undefined) set.notes = patch.notes;
    // Moving to another line or day drops its place in the old day's order.
    if (
      (set.plannedOn !== undefined && set.plannedOn !== batch.plannedOn) ||
      (set.lineId !== undefined && set.lineId !== batch.lineId)
    )
      set.sequence = null;
    if (Object.keys(set).length > 0) {
      const [row] = await tx
        .update(productionBatches)
        .set(set)
        .where(eq(productionBatches.id, id))
        .returning();
      await recordChanges(tx, workspaceId, actorId, [batchChange(row!)]);
    }
    return getBatch(tx, workspaceId, id);
  });
}

async function transition(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  batch: BatchRow,
  to: ProductionBatchStatus,
  set: Partial<typeof productionBatches.$inferInsert>,
) {
  if (!canTransitionBatch(batch.status, to)) {
    throw new ApiError(
      409,
      "invalid_batch_status",
      `Batch ${batch.batchCode} is ${productionBatchStatusLabels[batch.status].toLowerCase()}; it can't become ${productionBatchStatusLabels[to].toLowerCase()}`,
    );
  }
  const [row] = await tx
    .update(productionBatches)
    .set({ ...set, status: to })
    .where(eq(productionBatches.id, batch.id))
    .returning();
  await recordChanges(tx, workspaceId, actorId, [batchChange(row!)]);
}

/** Starts a planned batch. Its version must still be the approved one (BRCGS document control). */
export async function startBatch(db: Database, workspaceId: string, actorId: string, id: string) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const batch = await findBatch(tx, workspaceId, id);
    const [version] = await tx
      .select()
      .from(recipeVersions)
      .where(eq(recipeVersions.id, batch.recipeVersionId));
    if (batch.status === "planned" && version?.status !== "approved") {
      throw new ApiError(
        409,
        "version_superseded",
        `Version ${version?.versionNumber ?? "?"} of this recipe has been superseded; move the batch to the current approved version before starting it`,
      );
    }
    await transition(tx, workspaceId, actorId, batch, "in_progress", {
      startedAt: new Date(),
      startedBy: actorId,
    });
    return getBatch(tx, workspaceId, id);
  });
}

// ─── Batch records ───────────────────────────────────────────────────────────

/**
 * Posts consumption: for each line, a `consumption` movement out of the lot and a record linking
 * it to the batch. Only ingredients of the batch's version, only released lots, never past a
 * use-by date, never more than is at the location (re-read under the workspace lock).
 */
export async function recordConsumption(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: ProductionConsumptionInput,
) {
  return executeLedgerCommand(
    db,
    workspaceId,
    actorId,
    "recordConsumption",
    input,
    { id, input },
    async (tx) => {
      await lockWorkspaceLog(tx, workspaceId);
      const batch = await findBatch(tx, workspaceId, id);
      assertStatus(batch, ["in_progress"], "record consumption (start it first)");
      const ingredients = new Set(
        (
          await tx
            .select({ itemId: recipeLines.itemId })
            .from(recipeLines)
            .where(eq(recipeLines.versionId, batch.recipeVersionId))
        ).map((l) => l.itemId),
      );
      const now = new Date();
      const day = await workspaceToday(tx, workspaceId);
      const movements: (Omit<typeof stockMovements.$inferInsert, "workspaceId"> & { id: string })[] = [];
      const records: (typeof productionRecords.$inferInsert)[] = [];
      for (const line of input.lines) {
        const { lot, item } = await findLot(tx, workspaceId, line.lotId);
        if (!ingredients.has(item.id)) {
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
            `Lot ${lot.lotCode} is ${lot.status}; only released lots can be used`,
          );
        }
        if (lot.expiryType === "use_by" && lot.expiresOn && lot.expiresOn < day) {
          throw new ApiError(
            409,
            "lot_expired",
            `Lot ${lot.lotCode} is past its use-by date (${lot.expiresOn})`,
          );
        }
        const location = await findLocation(tx, workspaceId, line.locationId);
        const quantity = toBase(line.quantity, line.unit, item);
        await assertAvailable(tx, lot.id, location, item, quantity);
        const movementId = newId();
        movements.push({
          id: movementId,
          lotId: lot.id,
          itemId: item.id,
          locationId: location.id,
          quantity: -quantity,
          type: "consumption",
          reference: batch.batchCode,
          actorId,
          occurredAt: now,
        });
        records.push({
          workspaceId,
          batchId: batch.id,
          kind: "consumption",
          itemId: item.id,
          lotId: lot.id,
          locationId: location.id,
          quantity,
          movementId,
          note: line.note ?? null,
          actorId,
          occurredAt: now,
        });
      }
      const posted = await insertMovements(tx, workspaceId, movements);
      const rows = await tx.insert(productionRecords).values(records).returning();
      // Using a lot fulfils what the batch reserved of it (consumption works without a reservation).
      const used = new Map<string, { lotId: string; locationId: string; quantity: number }>();
      for (const r of records) {
        const key = lotLocationKey(r.lotId, r.locationId);
        const e = used.get(key) ?? { lotId: r.lotId, locationId: r.locationId, quantity: 0 };
        e.quantity = roundQuantity(e.quantity + r.quantity);
        used.set(key, e);
      }
      const fulfilled: ChangeInput[] = [];
      for (const { lotId, locationId, quantity } of used.values()) {
        fulfilled.push(
          ...(await fulfilForConsumption(tx, workspaceId, actorId, batch.id, lotId, quantity, locationId)),
        );
      }
      await recordChanges(tx, workspaceId, actorId, [
        ...posted.map(movementChange),
        ...rows.map(recordChange),
        ...fulfilled,
      ]);
      return getBatch(tx, workspaceId, id);
    },
  );
}

/** A free lot code for a new output lot: the batch code, else the batch code with `-2`, `-3`, … */
async function outputLotCode(tx: Transaction, itemId: string, batchCode: string) {
  for (let n = 1; n < 1000; n++) {
    const code = n === 1 ? batchCode : `${batchCode}-${n}`;
    if (!(await lotCodeTaken(tx, itemId, code))) return code;
  }
  throw new ApiError(409, "lot_code_taken", "Give the output lot a code");
}

/**
 * Posts output: a `production` movement into the lot the batch makes, and a record. A new lot
 * starts in quarantine (QA releases it in the stock module, a person's sign-off); its code is the
 * batch code unless given, its date of manufacture today, and without an expiry it gets the
 * output item's shelf life as a best-before date. Output is added to an existing lot of the batch
 * only while it is still in quarantine (`409 lot_released` / `lot_rejected` otherwise), so QA's
 * decision always covers everything in the lot.
 */
export async function recordOutput(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: ProductionOutputInput,
  foodItems = false,
) {
  return executeLedgerCommand(db, workspaceId, actorId, "recordOutput", input, { id, input }, async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const batch = await findBatch(tx, workspaceId, id);
    assertStatus(batch, ["in_progress"], "record output (start it first)");
    const item = await findItem(tx, workspaceId, batch.outputItemId);
    const quantity = toBase(input.quantity, input.unit, item);
    const locationId = input.locationId ?? batch.outputLocationId;
    if (!locationId) throw badRequest("Choose the location the output goes to");
    const location = await findActiveLocation(tx, workspaceId, locationId);
    const now = new Date();
    const changes: ChangeInput[] = [];

    let lot: LotRow;
    if (input.lotId) {
      const [mine] = await tx
        .select({ id: productionRecords.id })
        .from(productionRecords)
        .where(
          and(
            eq(productionRecords.batchId, batch.id),
            eq(productionRecords.lotId, input.lotId),
            eq(productionRecords.kind, "output"),
          ),
        )
        .limit(1);
      if (!mine)
        throw new ApiError(
          409,
          "lot_not_from_batch",
          "Output can only be added to a lot this batch produced",
        );
      lot = (await findLot(tx, workspaceId, input.lotId)).lot;
      // QA's decision covers what was in the lot when it was made: more product goes into a new
      // lot (in quarantine), not into one already released or rejected.
      if (lot.status !== "quarantine") {
        throw new ApiError(
          409,
          lot.status === "available" ? "lot_released" : "lot_rejected",
          `Lot ${lot.lotCode} has been ${lot.status === "available" ? "released" : "rejected"} by QA; record further output into a new lot`,
        );
      }
    } else {
      lot = await createLot(tx, workspaceId, actorId, item, {
        lotCode: input.lotCode ?? (await outputLotCode(tx, item.id, batch.batchCode)),
        receivedOn: await workspaceToday(tx, workspaceId),
        expiresOn: input.expiresOn ?? null,
        expiryType: input.expiryType ?? null,
        status: "quarantine",
        foodItems,
        statusNote: `Produced by batch ${batch.batchCode}; awaiting QA release`,
        notes: null,
        now,
      });
      changes.push(lotChange(lot));
    }
    const movementId = newId();
    const posted = await insertMovements(tx, workspaceId, [
      {
        id: movementId,
        lotId: lot.id,
        itemId: item.id,
        locationId: location.id,
        quantity,
        type: "production",
        reference: batch.batchCode,
        actorId,
        occurredAt: now,
      },
    ]);
    const [row] = await tx
      .insert(productionRecords)
      .values({
        workspaceId,
        batchId: batch.id,
        kind: "output",
        itemId: item.id,
        lotId: lot.id,
        locationId: location.id,
        quantity,
        movementId,
        note: input.note ?? null,
        actorId,
        occurredAt: now,
      })
      .returning();
    await inheritIncidentHolds(tx, workspaceId, batch.id, lot.id, actorId);
    changes.push(movementChange(posted[0]!), recordChange(row!));
    await recordChanges(tx, workspaceId, actorId, changes);
    return getBatch(tx, workspaceId, id);
  });
}

/**
 * Corrects a record by appending its opposite: a reversal record and a reversing stock movement
 * (`reversesMovementId`). A record is reversed once. Reversing output can't take more out of the
 * produced lot than is still there. On an in-progress batch this is `write`; once the batch is
 * completed or cancelled it needs `manage` (the route passes `canManage`). Always a person.
 */
export async function reverseRecord(
  db: Database,
  workspaceId: string,
  actorId: string,
  batchId: string,
  recordId: string,
  reason: string,
  options: { canManage: boolean },
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const batch = await findBatch(tx, workspaceId, batchId);
    if (batch.status !== "in_progress" && !options.canManage) {
      throw new ApiError(
        403,
        "module_forbidden",
        "Correcting a closed batch record needs manage access to the production module",
      );
    }
    const [record] = await tx
      .select()
      .from(productionRecords)
      .where(and(eq(productionRecords.id, recordId), eq(productionRecords.batchId, batch.id)));
    if (!record) throw notFound("Record");
    if (record.reversesRecordId) {
      throw new ApiError(409, "not_reversible", "This record is itself a reversal");
    }
    const [already] = await tx
      .select({ id: productionRecords.id })
      .from(productionRecords)
      .where(eq(productionRecords.reversesRecordId, record.id));
    if (already) throw new ApiError(409, "already_reversed", "This record has already been reversed");

    const { item } = await findLot(tx, workspaceId, record.lotId);
    const location = await findLocation(tx, workspaceId, record.locationId);
    // Reversing output takes stock back out of the produced lot: it must still be there.
    if (record.kind === "output") await assertAvailable(tx, record.lotId, location, item, record.quantity);
    const sign = record.kind === "consumption" ? 1 : -1;
    const movementId = newId();
    const now = new Date();
    const posted = await insertMovements(tx, workspaceId, [
      {
        id: movementId,
        lotId: record.lotId,
        itemId: record.itemId,
        locationId: record.locationId,
        quantity: sign * record.quantity,
        type: recordMovementType[record.kind],
        reason,
        reference: batch.batchCode,
        reversesMovementId: record.movementId,
        actorId,
        occurredAt: now,
      },
    ]);
    const [row] = await tx
      .insert(productionRecords)
      .values({
        workspaceId,
        batchId: batch.id,
        kind: record.kind,
        itemId: record.itemId,
        lotId: record.lotId,
        locationId: record.locationId,
        quantity: -record.quantity,
        movementId,
        reversesRecordId: record.id,
        note: reason,
        actorId,
        occurredAt: now,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [movementChange(posted[0]!), recordChange(row!)]);
    return getBatch(tx, workspaceId, batchId);
  });
}

// ─── Sign-off and cancellation ───────────────────────────────────────────────

/**
 * Completes a batch: the sign-off that closes its record. Needs output on record. The route
 * requires `manage` and a signed-in person; who and when are kept.
 */
export async function completeBatch(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: ProductionBatchCompleteInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const batch = await findBatch(tx, workspaceId, id);
    assertStatus(batch, ["in_progress"], "be completed");
    const [produced] = await tx
      .select({ total: sql<string>`coalesce(sum(${productionRecords.quantity}), 0)` })
      .from(productionRecords)
      .where(and(eq(productionRecords.batchId, id), eq(productionRecords.kind, "output")));
    if (!(num(produced?.total) > 0)) {
      throw new ApiError(409, "no_output", "Record what the batch produced before completing it");
    }
    await transition(tx, workspaceId, actorId, batch, "completed", {
      completedAt: new Date(),
      completedBy: actorId,
      completionNote: input.note ?? null,
    });
    await recordChanges(
      tx,
      workspaceId,
      actorId,
      await releaseBatchReservations(tx, workspaceId, actorId, id, "completed"),
    );
    return getBatch(tx, workspaceId, id);
  });
}

/**
 * Cancels a planned batch (`write`) or an in-progress one (`manage`: ingredients already
 * consumed stay consumed, as they were used; reverse records first to return unused stock). An
 * in-progress batch with output still on record can't be cancelled: reverse the output first.
 */
export async function cancelBatch(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  reason: string,
  options: { canManage: boolean },
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const batch = await findBatch(tx, workspaceId, id);
    if (batch.status === "in_progress") {
      if (!options.canManage) {
        throw new ApiError(
          403,
          "module_forbidden",
          "Cancelling a batch that has started needs manage access to the production module",
        );
      }
      const [produced] = await tx
        .select({ total: sql<string>`coalesce(sum(${productionRecords.quantity}), 0)` })
        .from(productionRecords)
        .where(and(eq(productionRecords.batchId, id), eq(productionRecords.kind, "output")));
      if (num(produced?.total) !== 0) {
        throw new ApiError(
          409,
          "batch_has_output",
          "This batch has output on record; reverse it before cancelling",
        );
      }
    }
    const [packing] = await tx
      .select({ id: productionPackingRuns.id })
      .from(productionPackingRuns)
      .where(and(eq(productionPackingRuns.batchId, id), eq(productionPackingRuns.status, "open")));
    if (packing)
      throw new ApiError(
        409,
        "packing_run_open",
        "This batch is being packed; close the packing run before cancelling",
      );
    await transition(tx, workspaceId, actorId, batch, "cancelled", {
      cancelledAt: new Date(),
      cancelledBy: actorId,
      cancelReason: reason,
    });
    await recordChanges(
      tx,
      workspaceId,
      actorId,
      await releaseBatchReservations(tx, workspaceId, actorId, id, "cancelled"),
    );
    return getBatch(tx, workspaceId, id);
  });
}

// ─── FEFO pick for a batch ───────────────────────────────────────────────────

/**
 * What to consume next: for each ingredient still outstanding, a first-expired-first-out
 * suggestion from released lots not past their use-by date. Reserves nothing.
 */
export async function suggestBatchPick(db: Database, workspaceId: string, id: string) {
  // The batch already loaded its materials' items: reuse them rather than reading them again.
  const { detail, items: itemMap } = await loadBatch(db, workspaceId, id);
  const wanted = detail.materials.filter((m) => m.inRecipe && m.outstanding && m.outstanding.base > 0);
  const candidates = await pickCandidates(
    db,
    workspaceId,
    wanted.map((m) => m.item.id),
  );
  const day = await workspaceToday(db, workspaceId);
  // Stock held for any batch is not free; what this batch holds is offered to it first.
  const wantedIds = wanted.map((m) => m.item.id);
  const reservedAll = await reservedByLot(db, workspaceId, { itemIds: wantedIds });
  const free = netOfReservations(
    candidates,
    reservedAll,
    await reservedByLotLocation(db, workspaceId, { itemIds: wantedIds }),
  );
  const own = detail.reservations.filter((r) => r.status === "active" && r.held.base > 0 && r.lotUsable);
  return {
    batchId: detail.id,
    materials: detail.materials
      .filter((m) => m.inRecipe)
      .map((m) => {
        const item = itemMap.get(m.item.id);
        const outstanding = m.outstanding?.base ?? 0;
        if (!item || outstanding <= 0) {
          return {
            item: m.item,
            outstanding: m.outstanding,
            allocated: null,
            shortfall: null,
            allocations: [],
          };
        }
        // 1. What this batch reserved, up to what is outstanding.
        type Alloc = {
          lotId: string;
          lotCode: string;
          locationId: string;
          locationName: string;
          expiresOn: string | null;
          expiryType: ExpiryType | null;
          pastBestBefore: boolean;
          reserved: boolean;
          quantity: number;
        };
        const allocs = new Map<string, Alloc>();
        const add = (c: (typeof candidates)[number], quantity: number, reserved: boolean) => {
          const key = `${c.lotId}:${c.locationId}`;
          const have = allocs.get(key);
          if (have) have.quantity = roundQuantity(have.quantity + quantity);
          else
            allocs.set(key, {
              lotId: c.lotId,
              lotCode: c.lotCode,
              locationId: c.locationId,
              locationName: c.locationName,
              expiresOn: c.expiresOn,
              expiryType: c.expiryType,
              pastBestBefore: c.expiresOn !== null && c.expiresOn < day,
              reserved,
              quantity,
            });
        };
        let left = outstanding;
        for (const r of own.filter((r) => r.item.id === item.id)) {
          let heldLeft = Math.min(r.held.base, left);
          for (const c of candidates.filter(
            (c) =>
              c.lotId === r.lotId && (!r.locationId || c.locationId === r.locationId) && isPickable(c, day),
          )) {
            if (heldLeft <= 0) break;
            const q = roundQuantity(Math.min(c.quantity, heldLeft));
            add(c, q, true);
            heldLeft = roundQuantity(heldLeft - q);
            left = roundQuantity(left - q);
          }
        }
        // 2. The rest, first expired first out, from stock nobody has reserved.
        const result = pickFefo(
          free.filter((c) => c.itemId === item.id),
          left,
          day,
        );
        for (const a of result.allocations) add(a.candidate, a.quantity, false);
        const list = [...allocs.values()];
        const total = roundQuantity(list.reduce((t, a) => t + a.quantity, 0));
        return {
          item: m.item,
          outstanding: m.outstanding,
          allocated: stockAmount(total, item),
          shortfall: stockAmount(Math.max(roundQuantity(outstanding - total), 0), item),
          allocations: list.map(({ quantity, ...a }) => ({ ...a, amount: stockAmount(quantity, item) })),
        };
      }),
  };
}

// ─── Material requirements ───────────────────────────────────────────────────

/**
 * What the planned and in-progress batches between two dates need, per ingredient, against stock
 * that can be used today (released, not past use-by), with the shortfall. Computed on read.
 */
export async function getMaterialRequirements(
  db: Database,
  workspaceId: string,
  query: MaterialRequirementsQuery,
) {
  const rows = await batchQuery(db)
    .where(
      and(
        eq(productionBatches.workspaceId, workspaceId),
        isNull(productionBatches.deletedAt),
        inArray(productionBatches.status, [...openBatchStatuses]),
        gte(productionBatches.plannedOn, query.from),
        lte(productionBatches.plannedOn, query.to),
      ),
    )
    .orderBy(asc(productionBatches.plannedOn), asc(productionBatches.batchCode), asc(productionBatches.id));
  const { batches, loaded } = await summarize(db, workspaceId, rows);
  const started = rows.filter((r) => r.batch.status === "in_progress").map((r) => r.batch.id);
  const consumed = started.length
    ? await netRecords(
        db,
        and(inArray(productionRecords.batchId, started), eq(productionRecords.kind, "consumption"))!,
      )
    : [];
  const consumedBy = new Map<string, Record<string, number>>();
  for (const c of consumed) {
    const map = consumedBy.get(c.batchId) ?? {};
    map[c.itemId] = roundQuantity((map[c.itemId] ?? 0) + c.total);
    consumedBy.set(c.batchId, map);
  }
  const requirementBatches = rows.map(({ batch }) => ({
    batchId: batch.id,
    batchCode: batch.batchCode,
    plannedOn: batch.plannedOn,
    status: batch.status,
    materials: materialsOf(batch, loaded),
    consumed: consumedBy.get(batch.id),
  }));
  const itemIds = [...new Set(requirementBatches.flatMap((b) => b.materials.map((m) => m.itemId)))];
  const candidates = await pickCandidates(db, workspaceId, itemIds);
  const day = await workspaceToday(db, workspaceId);
  const stock: Record<string, RequirementStock> = {};
  // Stock reserved for batches outside this range is not available to these batches.
  const reservedElsewhere = await reservedByLot(db, workspaceId, {
    itemIds,
    exceptBatchIds: rows.map((r) => r.batch.id),
  });
  const reservedHere = await db
    .select({
      itemId: productionReservations.itemId,
      total: sql<string>`sum(${productionReservations.quantity} - ${productionReservations.fulfilledQuantity})`,
    })
    .from(productionReservations)
    .where(
      and(
        eq(productionReservations.workspaceId, workspaceId),
        eq(productionReservations.status, "active"),
        or(isNull(productionReservations.expiresOn), gte(productionReservations.expiresOn, day)),
        rows.length
          ? inArray(
              productionReservations.batchId,
              rows.map((r) => r.batch.id),
            )
          : sql`false`,
      ),
    )
    .groupBy(productionReservations.itemId);
  const reservedHereBy = new Map(reservedHere.map((r) => [r.itemId, Math.max(num(r.total), 0)]));
  const reservedElsewhereAt = await reservedByLotLocation(db, workspaceId, {
    itemIds,
    exceptBatchIds: rows.map((r) => r.batch.id),
  });
  for (const c of netOfReservations(candidates, reservedElsewhere, reservedElsewhereAt)) {
    const s = (stock[c.itemId] ??= { available: 0, quarantine: 0 });
    if (isPickable(c, day)) s.available = roundQuantity(s.available + c.quantity);
    else if (c.status === "quarantine") s.quarantine = roundQuantity(s.quarantine + c.quantity);
  }
  const itemMap = await itemsById(db, workspaceId, itemIds);
  const amount = (q: number | null, item: ItemRow) => (q === null ? null : stockAmount(q, item));
  return {
    from: query.from,
    to: query.to,
    batches,
    requirements: materialRequirements(requirementBatches, stock).map((r) => {
      const item = itemMap.get(r.itemId)!;
      return {
        item: itemSummary(item),
        required: stockAmount(r.required, item),
        consumed: stockAmount(r.consumed, item),
        outstanding: stockAmount(r.outstanding, item),
        available: stockAmount(r.available, item),
        quarantine: stockAmount(r.quarantine, item),
        reserved: stockAmount(reservedHereBy.get(r.itemId) ?? 0, item),
        shortfall: stockAmount(r.shortfall, item),
        incomplete: r.incomplete,
        batches: r.batches.map((b) => ({
          ...b,
          required: amount(b.required, item),
          outstanding: amount(b.outstanding, item),
        })),
      };
    }),
  };
}

// ─── Traceability ────────────────────────────────────────────────────────────

/**
 * Lot tracing through batch records. Forward (one-down, repeated): the batches that consumed the
 * lot and the lots they produced, then the batches that consumed those, and so on. Backward
 * (one-up, repeated): the batch that produced the lot and the lots it consumed, and so on back to
 * goods-in. Plus the lot's mass balance: everything that came in is on hand, used, wasted or
 * adjusted. Fully reversed records drop out (their net is zero).
 */
export async function traceLot(db: Database, workspaceId: string, lotId: string, query: LotTraceQuery) {
  const { lot, item } = await findLot(db, workspaceId, lotId);
  const movements = await db
    .select({ type: stockMovements.type, quantity: stockMovements.quantity })
    .from(stockMovements)
    .where(eq(stockMovements.lotId, lotId));
  const balance = lotMassBalance(movements);

  type Edge = { batchId: string; lotId: string; total: number };
  const forward: { depth: number; batchId: string; consumed: Edge; outputs: Edge[] }[] = [];
  const backward: { depth: number; batchId: string; produced: Edge; inputs: Edge[] }[] = [];

  // Forward: lots → batches that consumed them → their output lots.
  let frontier = [lotId];
  const seenForward = new Set<string>();
  for (let depth = 1; depth <= query.depth && frontier.length; depth++) {
    const used = (
      await netRecords(
        db,
        and(
          eq(productionRecords.workspaceId, workspaceId),
          inArray(productionRecords.lotId, frontier),
          eq(productionRecords.kind, "consumption"),
        )!,
      )
    ).filter((e) => !seenForward.has(e.batchId));
    if (!used.length) break;
    const batchIds = [...new Set(used.map((e) => e.batchId))];
    const outputs = await netRecords(
      db,
      and(inArray(productionRecords.batchId, batchIds), eq(productionRecords.kind, "output"))!,
    );
    for (const e of used) {
      forward.push({
        depth,
        batchId: e.batchId,
        consumed: e,
        outputs: outputs.filter((o) => o.batchId === e.batchId),
      });
    }
    batchIds.forEach((b) => seenForward.add(b));
    frontier = [...new Set(outputs.map((o) => o.lotId))];
  }

  // Backward: lots → batches that produced them → the lots they consumed.
  frontier = [lotId];
  const seenBackward = new Set<string>();
  for (let depth = 1; depth <= query.depth && frontier.length; depth++) {
    const made = (
      await netRecords(
        db,
        and(
          eq(productionRecords.workspaceId, workspaceId),
          inArray(productionRecords.lotId, frontier),
          eq(productionRecords.kind, "output"),
        )!,
      )
    ).filter((e) => !seenBackward.has(e.batchId));
    if (!made.length) break;
    const batchIds = [...new Set(made.map((e) => e.batchId))];
    const inputs = await netRecords(
      db,
      and(inArray(productionRecords.batchId, batchIds), eq(productionRecords.kind, "consumption"))!,
    );
    for (const e of made) {
      backward.push({
        depth,
        batchId: e.batchId,
        produced: e,
        inputs: inputs.filter((i) => i.batchId === e.batchId),
      });
    }
    batchIds.forEach((b) => seenBackward.add(b));
    frontier = [...new Set(inputs.map((i) => i.lotId))];
  }

  // Summaries of every lot and batch the trace names.
  const lotIds = [
    ...new Set([
      ...forward.flatMap((f) => [f.consumed.lotId, ...f.outputs.map((o) => o.lotId)]),
      ...backward.flatMap((b) => [b.produced.lotId, ...b.inputs.map((i) => i.lotId)]),
    ]),
  ];
  const lotRows = lotIds.length
    ? await db
        .select({ lot: stockLots, supplierName: suppliers.name })
        .from(stockLots)
        .leftJoin(suppliers, eq(suppliers.id, stockLots.supplierId))
        .where(inArray(stockLots.id, lotIds))
    : [];
  const onHand = lotIds.length
    ? await db
        .select({ lotId: stockMovements.lotId, total: sql<string>`sum(${stockMovements.quantity})` })
        .from(stockMovements)
        .where(inArray(stockMovements.lotId, lotIds))
        .groupBy(stockMovements.lotId)
    : [];
  const onHandOf = new Map(onHand.map((r) => [r.lotId, num(r.total)]));
  const itemMap = await itemsById(
    db,
    workspaceId,
    lotRows.map((r) => r.lot.itemId),
  );
  const day = await workspaceToday(db, workspaceId);
  const lots = new Map(
    lotRows.map(({ lot: l, supplierName }) => {
      const it = itemMap.get(l.itemId)!;
      return [
        l.id,
        {
          id: l.id,
          lotCode: l.lotCode,
          item: itemSummary(it),
          status: l.status,
          expiresOn: l.expiresOn,
          expiryType: l.expiryType,
          expiryState: classifyExpiry(l.expiresOn, day),
          supplierName,
          supplierLotCode: l.supplierLotCode,
          onHand: stockAmount(onHandOf.get(l.id) ?? 0, it),
          item_: it,
        },
      ] as const;
    }),
  );
  const batchIds = [...new Set([...forward.map((f) => f.batchId), ...backward.map((b) => b.batchId)])];
  const batchRows = batchIds.length
    ? await db
        .select({
          batch: productionBatches,
          recipeCode: recipes.code,
          recipeName: recipes.name,
          versionNumber: recipeVersions.versionNumber,
        })
        .from(productionBatches)
        .innerJoin(recipes, eq(recipes.id, productionBatches.recipeId))
        .innerJoin(recipeVersions, eq(recipeVersions.id, productionBatches.recipeVersionId))
        .where(inArray(productionBatches.id, batchIds))
    : [];
  const batchMap = new Map(
    batchRows.map((r) => [
      r.batch.id,
      {
        id: r.batch.id,
        batchCode: r.batch.batchCode,
        status: r.batch.status,
        plannedOn: r.batch.plannedOn,
        completedAt: r.batch.completedAt,
        recipe: { id: r.batch.recipeId, code: r.recipeCode, name: r.recipeName },
        recipeVersion: { id: r.batch.recipeVersionId, versionNumber: r.versionNumber },
      },
    ]),
  );
  const lotView = (id: string) => {
    const { item_: _item, ...view } = lots.get(id)!;
    return view;
  };
  const edge = (e: Edge) => ({
    lot: lotView(e.lotId),
    amount: stockAmount(e.total, lots.get(e.lotId)!.item_),
  });

  return {
    lot: {
      id: lot.id,
      lotCode: lot.lotCode,
      item: itemSummary(item),
      status: lot.status,
      expiresOn: lot.expiresOn,
      expiryType: lot.expiryType,
    },
    massBalance: {
      received: stockAmount(balance.received, item),
      returned: stockAmount(balance.returned, item),
      produced: stockAmount(balance.produced, item),
      consumed: stockAmount(balance.consumed, item),
      despatched: stockAmount(balance.despatched, item),
      wasted: stockAmount(balance.wasted, item),
      adjusted: stockAmount(balance.adjusted, item),
      transferred: stockAmount(balance.transferred, item),
      onHand: stockAmount(balance.onHand, item),
      input: stockAmount(balance.input, item),
      adjustedPercent: balance.adjustedPercent,
    },
    forward: forward.map((f) => ({
      depth: f.depth,
      batch: batchMap.get(f.batchId)!,
      consumed: edge(f.consumed),
      outputs: f.outputs.map(edge),
    })),
    backward: backward.map((b) => ({
      depth: b.depth,
      batch: batchMap.get(b.batchId)!,
      produced: edge(b.produced),
      inputs: b.inputs.map(edge),
    })),
  };
}
