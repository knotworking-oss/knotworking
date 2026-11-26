import {
  batchFactor,
  blockingPrevious,
  expectedOperationMinutes,
  jobCardStatusLabels,
  loggedMinutes,
  newId,
  openJobCardStatuses,
  remainingFromPrevious,
  roundQuantity,
  stockAmount,
  workCentreCost,
  type JobCardCompleteInput,
  type JobCardExceptionInput,
  type JobCardExceptionResolveInput,
  type JobCardListQuery,
  type JobCardProgress,
  type JobCardQuantityInput,
  type JobCardTimeEntryInput,
  type JobCardTimerStartInput,
  type ProductionConsumptionInput,
  type ProductionOutputInput,
  type RoutingCreateInput,
  type RoutingDraftInput,
  type RoutingListQuery,
  type RoutingUpdateInput,
  type WorkCentreCreateInput,
  type WorkCentreListQuery,
  type WorkCentreUpdateInput,
} from "@knotworking/core";
import {
  items,
  jobCardExceptions,
  jobCardQuantities,
  jobCardRecords,
  jobCards,
  jobCardTimeLogs,
  lockWorkspaceLog,
  productionBatches,
  productionRecords,
  recipes,
  recipeVersions,
  recordChanges,
  routingOperations,
  routings,
  routingVersions,
  stockLots,
  workCentres,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { executeLedgerCommand } from "./ledger-command";
import { findBatch, recordConsumption, recordOutput, userNames } from "./ports/production";
import { findItem, toBase } from "./ports/stock";

/**
 * Routings module (`routings`): discrete manufacturing on top of Production.
 *
 * - **Work centres** carry capacity (hours a day, stations) and a cost per hour. Archived, never
 *   deleted; an archived centre can't go into a new routing version.
 * - **Routings** are per bill of materials (recipe), versioned like the bill: one draft, one
 *   approved, earlier ones superseded. Approving is a person's sign-off (`manage`).
 * - **Job cards** are made from a batch's routing (its approved version), one per operation, with
 *   the expected minutes and the work centre's rate copied onto them. Time (timers or entries),
 *   good and scrap quantities are append-only and voided with a reason. An operation can't report
 *   more than the one before it passed as good, and can't complete before it.
 * - **Production stays the ledger.** Materials used and output made at an operation are posted as
 *   the batch's own consumption and output (`recordConsumption`, `recordOutput` with hooks), linked
 *   to the card in `job_card_records`, so tracing, QA release and costing read them as they always
 *   have. While the module is active, a batch with job cards completes only once every card has;
 *   cancelling the batch cancels its open cards. Without job cards, nothing about a batch changes.
 */

type WorkCentreRow = typeof workCentres.$inferSelect;
type RoutingRow = typeof routings.$inferSelect;
type VersionRow = typeof routingVersions.$inferSelect;
type OperationRow = typeof routingOperations.$inferSelect;
type CardRow = typeof jobCards.$inferSelect;
type BatchRow = typeof productionBatches.$inferSelect;

const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

// ─── Sync changes (metadata only: no cost rates) ─────────────────────────────

const workCentreChange = (row: WorkCentreRow): ChangeInput => ({
  entity: "work_centre",
  entityId: row.id,
  action: "upsert",
  data: {
    id: row.id,
    code: row.code,
    name: row.name,
    stations: row.stations,
    hoursPerDay: row.hoursPerDay,
    status: row.status,
    updatedAt: row.updatedAt,
  },
});
const routingChange = (row: RoutingRow): ChangeInput => ({
  entity: "routing",
  entityId: row.id,
  action: "upsert",
  data: {
    id: row.id,
    code: row.code,
    name: row.name,
    recipeId: row.recipeId,
    status: row.status,
    updatedAt: row.updatedAt,
  },
});
const versionChange = (row: VersionRow): ChangeInput => ({
  entity: "routing_version",
  entityId: row.id,
  action: "upsert",
  data: {
    id: row.id,
    routingId: row.routingId,
    versionNumber: row.versionNumber,
    status: row.status,
    updatedAt: row.updatedAt,
  },
});
const operationChange = (row: OperationRow): ChangeInput => ({
  entity: "routing_operation",
  entityId: row.id,
  action: "upsert",
  data: {
    id: row.id,
    versionId: row.versionId,
    position: row.position,
    name: row.name,
    workCentreId: row.workCentreId,
    updatedAt: row.updatedAt,
  },
});
const cardChange = (row: CardRow): ChangeInput => ({
  entity: "job_card",
  entityId: row.id,
  action: "upsert",
  data: {
    id: row.id,
    batchId: row.batchId,
    position: row.position,
    name: row.name,
    workCentreId: row.workCentreId,
    status: row.status,
    updatedAt: row.updatedAt,
  },
});

// ─── Work centres ────────────────────────────────────────────────────────────

const serializeWorkCentre = (row: WorkCentreRow) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  hoursPerDay: row.hoursPerDay,
  stations: row.stations,
  /** Hours a day across every station: what the centre can load. */
  capacityHoursPerDay: Math.round(row.hoursPerDay * row.stations * 100) / 100,
  costPerHour: row.costPerHour,
  notes: row.notes,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

async function findWorkCentre(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(workCentres)
    .where(
      and(eq(workCentres.id, id), eq(workCentres.workspaceId, workspaceId), isNull(workCentres.deletedAt)),
    );
  if (!row) throw notFound("Work centre");
  return row;
}

async function assertWorkCentreCodeFree(db: Executor, workspaceId: string, code: string, exceptId?: string) {
  const [taken] = await db
    .select({ id: workCentres.id })
    .from(workCentres)
    .where(
      and(
        eq(workCentres.workspaceId, workspaceId),
        isNull(workCentres.deletedAt),
        sql`lower(${workCentres.code}) = lower(${code})`,
        exceptId ? ne(workCentres.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `A work centre with code ${code} already exists`);
}

export async function listWorkCentres(db: Executor, workspaceId: string, query: WorkCentreListQuery) {
  const where: (SQL | undefined)[] = [
    eq(workCentres.workspaceId, workspaceId),
    isNull(workCentres.deletedAt),
  ];
  if (query.status !== "all") where.push(eq(workCentres.status, query.status));
  if (query.q) {
    where.push(
      or(
        sql`${workCentres.code} ilike ${like(query.q)} escape '!'`,
        sql`${workCentres.name} ilike ${like(query.q)} escape '!'`,
      ),
    );
  }
  const rows = await db
    .select()
    .from(workCentres)
    .where(and(...where))
    .orderBy(asc(workCentres.code), asc(workCentres.id))
    .limit(500);
  return { workCentres: rows.map(serializeWorkCentre) };
}

export async function getWorkCentre(db: Executor, workspaceId: string, id: string) {
  return serializeWorkCentre(await findWorkCentre(db, workspaceId, id));
}

export async function createWorkCentre(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: WorkCentreCreateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertWorkCentreCodeFree(tx, workspaceId, input.code);
    const { id, ...fields } = input;
    const [row] = await tx
      .insert(workCentres)
      .values({ ...fields, ...(id ? { id } : {}), workspaceId })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [workCentreChange(row!)]);
    return serializeWorkCentre(row!);
  });
}

export async function updateWorkCentre(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: WorkCentreUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findWorkCentre(tx, workspaceId, id);
    if (patch.code !== undefined) await assertWorkCentreCodeFree(tx, workspaceId, patch.code, id);
    const [row] = await tx.update(workCentres).set(patch).where(eq(workCentres.id, id)).returning();
    await recordChanges(tx, workspaceId, actorId, [workCentreChange(row!)]);
    return serializeWorkCentre(row!);
  });
}

// ─── Routings ────────────────────────────────────────────────────────────────

async function findRouting(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(routings)
    .where(and(eq(routings.id, id), eq(routings.workspaceId, workspaceId), isNull(routings.deletedAt)));
  if (!row) throw notFound("Routing");
  return row;
}

async function findRecipe(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(recipes)
    .where(and(eq(recipes.id, id), eq(recipes.workspaceId, workspaceId), isNull(recipes.deletedAt)));
  if (!row) throw notFound("Bill of materials");
  return row;
}

async function workCentresById(db: Executor, ids: string[]) {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return new Map<string, WorkCentreRow>();
  const rows = await db.select().from(workCentres).where(inArray(workCentres.id, wanted));
  return new Map(rows.map((r) => [r.id, r]));
}

const workCentreRef = (row: WorkCentreRow | undefined) =>
  row ? { id: row.id, code: row.code, name: row.name, status: row.status } : null;

async function operationsOf(db: Executor, versionIds: string[]) {
  if (!versionIds.length) return [];
  return db
    .select()
    .from(routingOperations)
    .where(inArray(routingOperations.versionId, versionIds))
    .orderBy(asc(routingOperations.position));
}

/** A version with its operations, their work centres and what one yield of the bill expects. */
async function fullVersion(db: Executor, version: VersionRow) {
  const ops = await operationsOf(db, [version.id]);
  const centres = await workCentresById(
    db,
    ops.map((o) => o.workCentreId),
  );
  const names = await userNames(db, [version.approvedBy, version.createdBy]);
  const operations = ops.map((op) => {
    const centre = centres.get(op.workCentreId);
    const expected = expectedOperationMinutes(op, 1);
    return {
      id: op.id,
      position: op.position,
      name: op.name,
      workCentreId: op.workCentreId,
      workCentre: workCentreRef(centre),
      setupMinutes: op.setupMinutes,
      runMinutes: op.runMinutes,
      instructions: op.instructions,
      /** At the work centre's current rate, for one yield of the bill. */
      expectedCost: workCentreCost(expected.total, centre?.costPerHour ?? 0),
    };
  });
  return {
    id: version.id,
    routingId: version.routingId,
    versionNumber: version.versionNumber,
    status: version.status,
    changeNote: version.changeNote,
    approvedAt: version.approvedAt,
    approvedBy: version.approvedBy
      ? { id: version.approvedBy, name: names.get(version.approvedBy) ?? null }
      : null,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
    operations,
    totals: {
      setupMinutes: Math.round(operations.reduce((s, o) => s + o.setupMinutes, 0) * 100) / 100,
      runMinutes: Math.round(operations.reduce((s, o) => s + o.runMinutes, 0) * 100) / 100,
      expectedCost: Math.round(operations.reduce((s, o) => s + o.expectedCost, 0) * 100) / 100,
    },
  };
}

async function versionsOf(db: Executor, routingId: string) {
  return db
    .select()
    .from(routingVersions)
    .where(and(eq(routingVersions.routingId, routingId), isNull(routingVersions.deletedAt)))
    .orderBy(desc(routingVersions.versionNumber));
}

const recipeRef = (row: typeof recipes.$inferSelect | undefined) =>
  row
    ? { id: row.id, code: row.code, name: row.name, status: row.status, outputItemId: row.outputItemId }
    : null;

export async function listRoutings(db: Executor, workspaceId: string, query: RoutingListQuery) {
  const where: (SQL | undefined)[] = [eq(routings.workspaceId, workspaceId), isNull(routings.deletedAt)];
  if (query.status !== "all") where.push(eq(routings.status, query.status));
  if (query.recipeId) where.push(eq(routings.recipeId, query.recipeId));
  if (query.q) {
    where.push(
      or(
        sql`${routings.code} ilike ${like(query.q)} escape '!'`,
        sql`${routings.name} ilike ${like(query.q)} escape '!'`,
        sql`${recipes.code} ilike ${like(query.q)} escape '!'`,
        sql`${recipes.name} ilike ${like(query.q)} escape '!'`,
      ),
    );
  }
  const [rows, [total]] = await Promise.all([
    db
      .select({ routing: routings, recipe: recipes })
      .from(routings)
      .innerJoin(recipes, eq(recipes.id, routings.recipeId))
      .where(and(...where))
      .orderBy(asc(routings.code), asc(routings.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(routings)
      .innerJoin(recipes, eq(recipes.id, routings.recipeId))
      .where(and(...where)),
  ]);
  const ids = rows.map((r) => r.routing.id);
  const versions = ids.length
    ? await db
        .select()
        .from(routingVersions)
        .where(and(inArray(routingVersions.routingId, ids), isNull(routingVersions.deletedAt)))
    : [];
  const opCounts = versions.length
    ? await db
        .select({ versionId: routingOperations.versionId, n: count() })
        .from(routingOperations)
        .where(
          inArray(
            routingOperations.versionId,
            versions.map((v) => v.id),
          ),
        )
        .groupBy(routingOperations.versionId)
    : [];
  const opsOf = new Map(opCounts.map((c) => [c.versionId, c.n]));
  return {
    routings: rows.map(({ routing, recipe }) => {
      const mine = versions.filter((v) => v.routingId === routing.id);
      const approved = mine.find((v) => v.status === "approved");
      const draft = mine.find((v) => v.status === "draft");
      return {
        id: routing.id,
        code: routing.code,
        name: routing.name,
        status: routing.status,
        recipe: recipeRef(recipe),
        approvedVersion: approved
          ? {
              id: approved.id,
              versionNumber: approved.versionNumber,
              operations: opsOf.get(approved.id) ?? 0,
            }
          : null,
        draftVersion: draft ? { id: draft.id, versionNumber: draft.versionNumber } : null,
        updatedAt: routing.updatedAt,
      };
    }),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getRouting(db: Executor, workspaceId: string, id: string) {
  const routing = await findRouting(db, workspaceId, id);
  const [recipe] = await db.select().from(recipes).where(eq(recipes.id, routing.recipeId));
  const versions = await versionsOf(db, id);
  return {
    id: routing.id,
    code: routing.code,
    name: routing.name,
    description: routing.description,
    status: routing.status,
    recipe: recipeRef(recipe),
    createdAt: routing.createdAt,
    updatedAt: routing.updatedAt,
    versions: await Promise.all(versions.map((v) => fullVersion(db, v))),
  };
}

async function assertRoutingCodeFree(db: Executor, workspaceId: string, code: string, exceptId?: string) {
  const [taken] = await db
    .select({ id: routings.id })
    .from(routings)
    .where(
      and(
        eq(routings.workspaceId, workspaceId),
        isNull(routings.deletedAt),
        sql`lower(${routings.code}) = lower(${code})`,
        exceptId ? ne(routings.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `A routing with code ${code} already exists`);
}

/** Every operation's work centre must be a live, active centre of this workspace. */
async function assertWorkCentresUsable(db: Executor, workspaceId: string, ids: string[]) {
  const centres = await workCentresById(db, ids);
  for (const id of new Set(ids)) {
    const centre = centres.get(id);
    if (!centre || centre.workspaceId !== workspaceId || centre.deletedAt) throw notFound("Work centre");
    if (centre.status !== "active") {
      throw new ApiError(409, "work_centre_archived", `Work centre ${centre.code} is archived`);
    }
  }
}

async function draftOf(db: Executor, routingId: string) {
  const [draft] = await db
    .select()
    .from(routingVersions)
    .where(
      and(
        eq(routingVersions.routingId, routingId),
        eq(routingVersions.status, "draft"),
        isNull(routingVersions.deletedAt),
      ),
    );
  return draft ?? null;
}

async function saveDraftIn(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  routing: RoutingRow,
  input: RoutingDraftInput,
): Promise<{ version: VersionRow; changes: ChangeInput[] }> {
  if (routing.status === "archived") {
    throw new ApiError(409, "routing_archived", "This routing is archived; make it active before editing it");
  }
  await assertWorkCentresUsable(
    tx,
    workspaceId,
    input.operations.map((o) => o.workCentreId),
  );
  const changes: ChangeInput[] = [];
  let version = await draftOf(tx, routing.id);
  if (version) {
    const [updated] = await tx
      .update(routingVersions)
      .set({ changeNote: input.changeNote ?? null })
      .where(eq(routingVersions.id, version.id))
      .returning();
    version = updated!;
    const removed = await tx
      .delete(routingOperations)
      .where(eq(routingOperations.versionId, version.id))
      .returning({ id: routingOperations.id });
    changes.push(
      ...removed.map((r): ChangeInput => ({ entity: "routing_operation", entityId: r.id, action: "delete" })),
    );
  } else {
    const [latest] = await tx
      .select({ n: sql<number>`coalesce(max(${routingVersions.versionNumber}), 0)::int` })
      .from(routingVersions)
      .where(eq(routingVersions.routingId, routing.id));
    const [inserted] = await tx
      .insert(routingVersions)
      .values({
        workspaceId,
        routingId: routing.id,
        versionNumber: (latest?.n ?? 0) + 1,
        status: "draft",
        changeNote: input.changeNote ?? null,
        createdBy: actorId,
      })
      .returning();
    version = inserted!;
  }
  changes.push(versionChange(version));
  if (input.operations.length) {
    const inserted = await tx
      .insert(routingOperations)
      .values(
        input.operations.map((op, index) => ({
          workspaceId,
          versionId: version.id,
          position: index + 1,
          name: op.name,
          workCentreId: op.workCentreId,
          setupMinutes: op.setupMinutes,
          runMinutes: op.runMinutes,
          instructions: op.instructions ?? null,
        })),
      )
      .returning();
    changes.push(...inserted.map(operationChange));
  }
  return { version, changes };
}

export async function createRouting(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: RoutingCreateInput,
) {
  const { draft, id, ...fields } = input;
  const routingId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertRoutingCodeFree(tx, workspaceId, fields.code);
    const recipe = await findRecipe(tx, workspaceId, fields.recipeId);
    if (recipe.status === "archived") throw badRequest(`${recipe.code} is archived`);
    const [existing] = await tx
      .select({ code: routings.code })
      .from(routings)
      .where(and(eq(routings.recipeId, recipe.id), isNull(routings.deletedAt)));
    if (existing) {
      throw new ApiError(409, "routing_exists", `${recipe.code} already has routing ${existing.code}`);
    }
    const [row] = await tx
      .insert(routings)
      .values({ ...fields, description: fields.description ?? null, ...(id ? { id } : {}), workspaceId })
      .returning();
    const changes: ChangeInput[] = [routingChange(row!)];
    if (draft) changes.push(...(await saveDraftIn(tx, workspaceId, actorId, row!, draft)).changes);
    await recordChanges(tx, workspaceId, actorId, changes);
    return row!.id;
  });
  return getRouting(db, workspaceId, routingId);
}

export async function updateRouting(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: RoutingUpdateInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findRouting(tx, workspaceId, id);
    if (patch.code !== undefined) await assertRoutingCodeFree(tx, workspaceId, patch.code, id);
    const [row] = await tx.update(routings).set(patch).where(eq(routings.id, id)).returning();
    await recordChanges(tx, workspaceId, actorId, [routingChange(row!)]);
  });
  return getRouting(db, workspaceId, id);
}

export async function saveRoutingDraft(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: RoutingDraftInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const routing = await findRouting(tx, workspaceId, id);
    const { changes } = await saveDraftIn(tx, workspaceId, actorId, routing, input);
    await recordChanges(tx, workspaceId, actorId, changes);
  });
  return getRouting(db, workspaceId, id);
}

async function removeDraft(tx: Transaction, routingId: string): Promise<ChangeInput[]> {
  const draft = await draftOf(tx, routingId);
  if (!draft) return [];
  const ops = await tx
    .delete(routingOperations)
    .where(eq(routingOperations.versionId, draft.id))
    .returning({ id: routingOperations.id });
  await tx.delete(routingVersions).where(eq(routingVersions.id, draft.id));
  return [
    ...ops.map((o): ChangeInput => ({ entity: "routing_operation", entityId: o.id, action: "delete" })),
    { entity: "routing_version", entityId: draft.id, action: "delete" },
  ];
}

export async function discardRoutingDraft(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findRouting(tx, workspaceId, id);
    const changes = await removeDraft(tx, id);
    if (!changes.length) throw new ApiError(409, "no_draft", "This routing has no draft to discard");
    await recordChanges(tx, workspaceId, actorId, changes);
  });
}

/**
 * Approves the draft: it becomes the version job cards are made from, the previous approved one is
 * superseded, and who and when are kept. Job cards already made keep the version they came from.
 */
export async function approveRoutingDraft(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const routing = await findRouting(tx, workspaceId, id);
    if (routing.status === "archived") {
      throw new ApiError(
        409,
        "routing_archived",
        "This routing is archived; make it active before approving",
      );
    }
    const draft = await draftOf(tx, id);
    if (!draft) throw new ApiError(409, "no_draft", "This routing has no draft to approve");
    const ops = await operationsOf(tx, [draft.id]);
    if (!ops.length) throw badRequest("A routing with no operations can't be approved");
    await assertWorkCentresUsable(
      tx,
      workspaceId,
      ops.map((o) => o.workCentreId),
    );
    const changes: ChangeInput[] = [];
    const [previous] = await tx
      .update(routingVersions)
      .set({ status: "superseded" })
      .where(
        and(
          eq(routingVersions.routingId, id),
          eq(routingVersions.status, "approved"),
          isNull(routingVersions.deletedAt),
        ),
      )
      .returning();
    if (previous) changes.push(versionChange(previous));
    const [approved] = await tx
      .update(routingVersions)
      .set({ status: "approved", approvedAt: new Date(), approvedBy: actorId })
      .where(eq(routingVersions.id, draft.id))
      .returning();
    changes.push(versionChange(approved!));
    await recordChanges(tx, workspaceId, actorId, changes);
  });
  return getRouting(db, workspaceId, id);
}

/** Soft delete; a routing that has ever been approved can only be archived. */
export async function deleteRouting(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findRouting(tx, workspaceId, id);
    const [released] = await tx
      .select({ id: routingVersions.id })
      .from(routingVersions)
      .where(
        and(
          eq(routingVersions.routingId, id),
          inArray(routingVersions.status, ["approved", "superseded"]),
          isNull(routingVersions.deletedAt),
        ),
      );
    if (released) {
      throw new ApiError(
        409,
        "routing_approved",
        "This routing has an approved version and can't be deleted; archive it instead",
      );
    }
    const changes = await removeDraft(tx, id);
    await tx.update(routings).set({ deletedAt: new Date() }).where(eq(routings.id, id));
    await recordChanges(tx, workspaceId, actorId, [
      ...changes,
      { entity: "routing", entityId: id, action: "delete" },
    ]);
  });
}

// ─── Job cards: progress ─────────────────────────────────────────────────────

interface CardProgress extends JobCardProgress {
  minutes: number;
  runningTimers: number;
  openExceptions: number;
}

/** Good, scrap, minutes, running timers and open exceptions of each card (voided rows left out). */
async function progressOf(db: Executor, cards: readonly CardRow[]): Promise<Map<string, CardProgress>> {
  const ids = cards.map((c) => c.id);
  const out = new Map<string, CardProgress>(
    cards.map((c) => [
      c.id,
      {
        position: c.position,
        status: c.status,
        good: 0,
        scrap: 0,
        minutes: 0,
        runningTimers: 0,
        openExceptions: 0,
      },
    ]),
  );
  if (!ids.length) return out;
  const [quantities, time, exceptions] = await Promise.all([
    db
      .select({
        id: jobCardQuantities.jobCardId,
        good: sql<string>`coalesce(sum(${jobCardQuantities.good}), 0)`,
        scrap: sql<string>`coalesce(sum(${jobCardQuantities.scrap}), 0)`,
      })
      .from(jobCardQuantities)
      .where(and(inArray(jobCardQuantities.jobCardId, ids), isNull(jobCardQuantities.voidedAt)))
      .groupBy(jobCardQuantities.jobCardId),
    db
      .select({
        id: jobCardTimeLogs.jobCardId,
        minutes: sql<string>`coalesce(sum(${jobCardTimeLogs.minutes}), 0)`,
        running: sql<number>`(count(*) filter (where ${jobCardTimeLogs.endedAt} is null))::int`,
      })
      .from(jobCardTimeLogs)
      .where(and(inArray(jobCardTimeLogs.jobCardId, ids), isNull(jobCardTimeLogs.voidedAt)))
      .groupBy(jobCardTimeLogs.jobCardId),
    db
      .select({ id: jobCardExceptions.jobCardId, n: count() })
      .from(jobCardExceptions)
      .where(and(inArray(jobCardExceptions.jobCardId, ids), eq(jobCardExceptions.status, "open")))
      .groupBy(jobCardExceptions.jobCardId),
  ]);
  for (const q of quantities) {
    const p = out.get(q.id)!;
    p.good = roundQuantity(num(q.good));
    p.scrap = roundQuantity(num(q.scrap));
  }
  for (const t of time) {
    const p = out.get(t.id)!;
    p.minutes = num(t.minutes);
    p.runningTimers = t.running;
  }
  for (const e of exceptions) out.get(e.id)!.openExceptions = e.n;
  return out;
}

async function liveCardsOfBatch(db: Executor, batchId: string) {
  return db
    .select()
    .from(jobCards)
    .where(and(eq(jobCards.batchId, batchId), isNull(jobCards.deletedAt), ne(jobCards.status, "cancelled")))
    .orderBy(asc(jobCards.position));
}

async function outputItemsOf(db: Executor, itemIds: string[]) {
  const wanted = [...new Set(itemIds)];
  if (!wanted.length) return new Map<string, typeof items.$inferSelect>();
  const rows = await db.select().from(items).where(inArray(items.id, wanted));
  return new Map(rows.map((r) => [r.id, r]));
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function serializeCard(
  card: CardRow,
  progress: CardProgress,
  output: typeof items.$inferSelect,
  centre: WorkCentreRow | undefined,
  batch: Pick<BatchRow, "id" | "batchCode" | "status">,
) {
  const expectedMinutes = round2(card.expectedSetupMinutes + card.expectedRunMinutes);
  return {
    id: card.id,
    batchId: card.batchId,
    batch: { id: batch.id, batchCode: batch.batchCode, status: batch.status },
    routingVersionId: card.routingVersionId,
    operationId: card.operationId,
    position: card.position,
    name: card.name,
    status: card.status,
    statusLabel: jobCardStatusLabels[card.status],
    workCentre: workCentreRef(centre),
    plannedQuantity: stockAmount(card.plannedQuantity, output),
    good: stockAmount(progress.good, output),
    scrap: stockAmount(progress.scrap, output),
    expected: {
      setupMinutes: card.expectedSetupMinutes,
      runMinutes: card.expectedRunMinutes,
      totalMinutes: expectedMinutes,
    },
    actualMinutes: progress.minutes,
    runningTimers: progress.runningTimers,
    openExceptions: progress.openExceptions,
    costPerHour: card.costPerHour,
    expectedCost: workCentreCost(expectedMinutes, card.costPerHour),
    actualCost: workCentreCost(progress.minutes, card.costPerHour),
    startedAt: card.startedAt,
    completedAt: card.completedAt,
    completionNote: card.completionNote,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

type CardView = ReturnType<typeof serializeCard>;

/** A batch's operations cost and progress: the work-centre time costed at each card's rate. */
function summarize(cards: readonly CardView[]) {
  const last = cards.at(-1);
  return {
    cards: cards.length,
    completed: cards.filter((c) => c.status === "completed").length,
    expectedMinutes: round2(cards.reduce((s, c) => s + c.expected.totalMinutes, 0)),
    actualMinutes: round2(cards.reduce((s, c) => s + c.actualMinutes, 0)),
    expectedCost: round2(cards.reduce((s, c) => s + c.expectedCost, 0)),
    actualCost: round2(cards.reduce((s, c) => s + c.actualCost, 0)),
    /** What the last operation passed as good: the batch's finished quantity so far. */
    finishedGood: last ? last.good : null,
    scrap: cards.length ? round2(cards.reduce((s, c) => s + c.scrap.base, 0)) : 0,
  };
}

async function batchCards(db: Executor, batch: BatchRow) {
  const cards = await liveCardsOfBatch(db, batch.id);
  const [progress, centres, outputs] = await Promise.all([
    progressOf(db, cards),
    workCentresById(
      db,
      cards.map((c) => c.workCentreId),
    ),
    outputItemsOf(db, [batch.outputItemId]),
  ]);
  const output = outputs.get(batch.outputItemId)!;
  return cards.map((c) => serializeCard(c, progress.get(c.id)!, output, centres.get(c.workCentreId), batch));
}

/** A batch's job cards in operation order, with the operations cost so far. */
export async function listBatchJobCards(db: Executor, workspaceId: string, batchId: string) {
  const batch = await findBatch(db, workspaceId, batchId);
  const cards = await batchCards(db, batch);
  const [routing] = await db
    .select({ id: routings.id, code: routings.code, name: routings.name })
    .from(routings)
    .where(and(eq(routings.recipeId, batch.recipeId), isNull(routings.deletedAt)));
  return {
    batch: { id: batch.id, batchCode: batch.batchCode, status: batch.status },
    routing: routing ?? null,
    jobCards: cards,
    summary: summarize(cards),
  };
}

/**
 * The work-centre cost a batch carries from its job cards, for Costing: `null` when it has none.
 * Actual minutes are finished time logs; running timers count once stopped.
 */
export async function batchOperationsCost(db: Executor, workspaceId: string, batchId: string) {
  const batch = await findBatch(db, workspaceId, batchId);
  const cards = await batchCards(db, batch);
  if (!cards.length) return null;
  return {
    ...summarize(cards),
    operations: cards.map((c) => ({
      jobCardId: c.id,
      position: c.position,
      name: c.name,
      status: c.status,
      workCentre: c.workCentre,
      costPerHour: c.costPerHour,
      expectedMinutes: c.expected.totalMinutes,
      actualMinutes: c.actualMinutes,
      expectedCost: c.expectedCost,
      actualCost: c.actualCost,
    })),
  };
}

export async function listJobCards(db: Executor, workspaceId: string, query: JobCardListQuery) {
  const where: (SQL | undefined)[] = [eq(jobCards.workspaceId, workspaceId), isNull(jobCards.deletedAt)];
  if (query.status === "open") where.push(inArray(jobCards.status, [...openJobCardStatuses]));
  else if (query.status !== "all") where.push(eq(jobCards.status, query.status));
  if (query.batchId) where.push(eq(jobCards.batchId, query.batchId));
  if (query.workCentreId) where.push(eq(jobCards.workCentreId, query.workCentreId));
  const [rows, [total]] = await Promise.all([
    db
      .select({ card: jobCards, batch: productionBatches })
      .from(jobCards)
      .innerJoin(productionBatches, eq(productionBatches.id, jobCards.batchId))
      .where(and(...where))
      .orderBy(desc(productionBatches.plannedOn), asc(productionBatches.batchCode), asc(jobCards.position))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(jobCards)
      .where(and(...where)),
  ]);
  const cards = rows.map((r) => r.card);
  const [progress, centres, outputs] = await Promise.all([
    progressOf(db, cards),
    workCentresById(
      db,
      cards.map((c) => c.workCentreId),
    ),
    outputItemsOf(
      db,
      rows.map((r) => r.batch.outputItemId),
    ),
  ]);
  return {
    jobCards: rows.map(({ card, batch }) => ({
      ...serializeCard(
        card,
        progress.get(card.id)!,
        outputs.get(batch.outputItemId)!,
        centres.get(card.workCentreId),
        batch,
      ),
      plannedOn: batch.plannedOn,
    })),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

async function findCard(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(jobCards)
    .where(and(eq(jobCards.id, id), eq(jobCards.workspaceId, workspaceId), isNull(jobCards.deletedAt)));
  if (!row) throw notFound("Job card");
  return row;
}

/** Net output (reversals netted off) posted from a card's linked output records. */
async function linkedOutput(db: Executor, cardId: string) {
  const linked = db
    .select({ id: jobCardRecords.productionRecordId })
    .from(jobCardRecords)
    .where(eq(jobCardRecords.jobCardId, cardId));
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${productionRecords.quantity}), 0)` })
    .from(productionRecords)
    .where(
      and(
        eq(productionRecords.kind, "output"),
        or(inArray(productionRecords.id, linked), inArray(productionRecords.reversesRecordId, linked)),
      ),
    );
  return roundQuantity(num(row?.total));
}

/** A job card in full: its sequence, time, quantities, exceptions and the batch records it posted. */
export async function getJobCard(db: Executor, workspaceId: string, id: string) {
  const card = await findCard(db, workspaceId, id);
  const batch = await findBatch(db, workspaceId, card.batchId);
  const siblings = await liveCardsOfBatch(db, batch.id);
  const all = card.status === "cancelled" ? [...siblings, card] : siblings;
  const [progress, centres, outputs] = await Promise.all([
    progressOf(db, all),
    workCentresById(
      db,
      all.map((c) => c.workCentreId),
    ),
    outputItemsOf(db, [batch.outputItemId]),
  ]);
  const output = outputs.get(batch.outputItemId)!;
  const [operation] = await db
    .select({ instructions: routingOperations.instructions })
    .from(routingOperations)
    .where(eq(routingOperations.id, card.operationId));
  const [logs, quantities, exceptions, records] = await Promise.all([
    db
      .select()
      .from(jobCardTimeLogs)
      .where(eq(jobCardTimeLogs.jobCardId, id))
      .orderBy(asc(jobCardTimeLogs.startedAt), asc(jobCardTimeLogs.id)),
    db
      .select()
      .from(jobCardQuantities)
      .where(eq(jobCardQuantities.jobCardId, id))
      .orderBy(asc(jobCardQuantities.createdAt), asc(jobCardQuantities.id)),
    db
      .select()
      .from(jobCardExceptions)
      .where(eq(jobCardExceptions.jobCardId, id))
      .orderBy(asc(jobCardExceptions.createdAt), asc(jobCardExceptions.id)),
    db
      .select({ record: productionRecords, lotCode: stockLots.lotCode })
      .from(jobCardRecords)
      .innerJoin(productionRecords, eq(productionRecords.id, jobCardRecords.productionRecordId))
      .innerJoin(stockLots, eq(stockLots.id, productionRecords.lotId))
      .where(eq(jobCardRecords.jobCardId, id))
      .orderBy(asc(productionRecords.occurredAt), asc(productionRecords.id)),
  ]);
  const recordItems = await outputItemsOf(
    db,
    records.map((r) => r.record.itemId),
  );
  const reversed = records.length
    ? new Set(
        (
          await db
            .select({ id: productionRecords.reversesRecordId })
            .from(productionRecords)
            .where(
              inArray(
                productionRecords.reversesRecordId,
                records.map((r) => r.record.id),
              ),
            )
        ).map((r) => r.id),
      )
    : new Set<string | null>();
  const names = await userNames(db, [
    card.completedBy,
    ...logs.flatMap((l) => [l.userId, l.voidedBy]),
    ...quantities.flatMap((q) => [q.recordedBy, q.voidedBy]),
    ...exceptions.flatMap((e) => [e.raisedBy, e.resolvedBy]),
  ]);
  const person = (userId: string | null) => (userId ? { id: userId, name: names.get(userId) ?? null } : null);
  const progressList = all.filter((c) => c.status !== "cancelled").map((c) => progress.get(c.id)!);
  const remaining = card.status === "cancelled" ? null : remainingFromPrevious(progressList, card.position);
  const blocking = card.status === "cancelled" ? undefined : blockingPrevious(progressList, card.position);
  const index = siblings.findIndex((c) => c.id === card.id);
  const isLast = index >= 0 && index === siblings.length - 1;
  const neighbour = (c: CardRow | undefined) =>
    c
      ? {
          id: c.id,
          position: c.position,
          name: c.name,
          status: c.status,
          good: stockAmount(progress.get(c.id)!.good, output),
        }
      : null;
  return {
    ...serializeCard(card, progress.get(card.id)!, output, centres.get(card.workCentreId), batch),
    instructions: operation?.instructions ?? null,
    outputItem: { id: output.id, code: output.code, name: output.name, unit: output.unit },
    completedBy: person(card.completedBy),
    sequence: {
      previous: neighbour(index > 0 ? siblings[index - 1] : undefined),
      next: neighbour(index >= 0 ? siblings[index + 1] : undefined),
      isLast,
      /** Most this card may still report (good plus scrap); `null`: no limit (the first operation). */
      remaining: remaining === null ? null : stockAmount(remaining, output),
      /** The previous operation is not complete, so this one can't be completed yet. */
      blockedBy: blocking ? { position: blocking.position } : null,
    },
    output: isLast ? stockAmount(await linkedOutput(db, card.id), output) : null,
    timeLogs: logs.map((l) => ({
      id: l.id,
      user: person(l.userId),
      startedAt: l.startedAt,
      endedAt: l.endedAt,
      minutes: l.minutes,
      running: l.endedAt === null && l.voidedAt === null,
      note: l.note,
      voidedAt: l.voidedAt,
      voidedBy: person(l.voidedBy),
      voidReason: l.voidReason,
    })),
    quantities: quantities.map((q) => ({
      id: q.id,
      good: stockAmount(q.good, output),
      scrap: stockAmount(q.scrap, output),
      scrapReason: q.scrapReason,
      note: q.note,
      recordedBy: person(q.recordedBy),
      createdAt: q.createdAt,
      voidedAt: q.voidedAt,
      voidedBy: person(q.voidedBy),
      voidReason: q.voidReason,
    })),
    exceptions: exceptions.map((e) => ({
      id: e.id,
      kind: e.kind,
      description: e.description,
      status: e.status,
      raisedBy: person(e.raisedBy),
      createdAt: e.createdAt,
      resolvedAt: e.resolvedAt,
      resolvedBy: person(e.resolvedBy),
      resolution: e.resolution,
    })),
    records: records.map(({ record, lotCode }) => {
      const item = recordItems.get(record.itemId)!;
      return {
        id: record.id,
        kind: record.kind,
        item: { id: item.id, code: item.code, name: item.name },
        lotId: record.lotId,
        lotCode,
        locationId: record.locationId,
        quantity: stockAmount(record.quantity, item),
        occurredAt: record.occurredAt,
        reversed: reversed.has(record.id),
      };
    }),
  };
}

// ─── Job cards: making and closing ───────────────────────────────────────────

/**
 * Makes a batch's job cards from its bill's routing: one per operation of the approved version,
 * with expected minutes scaled to the batch (setup once, run per yield) and the work centre's
 * current rate. A planned or in-progress batch only, and only once (cancel the cards to remake them).
 */
export async function createJobCards(db: Database, workspaceId: string, actorId: string, batchId: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const batch = await findBatch(tx, workspaceId, batchId);
    if (batch.status !== "planned" && batch.status !== "in_progress") {
      throw new ApiError(
        409,
        "invalid_batch_status",
        `Batch ${batch.batchCode} is ${batch.status}; it takes no new job cards`,
      );
    }
    if ((await liveCardsOfBatch(tx, batch.id)).length) {
      throw new ApiError(409, "job_cards_exist", `Batch ${batch.batchCode} already has job cards`);
    }
    const [routing] = await tx
      .select()
      .from(routings)
      .where(and(eq(routings.recipeId, batch.recipeId), isNull(routings.deletedAt)));
    if (!routing) throw new ApiError(409, "no_routing", "This batch's bill of materials has no routing");
    if (routing.status === "archived") {
      throw new ApiError(409, "routing_archived", `Routing ${routing.code} is archived`);
    }
    const [version] = await tx
      .select()
      .from(routingVersions)
      .where(
        and(
          eq(routingVersions.routingId, routing.id),
          eq(routingVersions.status, "approved"),
          isNull(routingVersions.deletedAt),
        ),
      );
    if (!version) {
      throw new ApiError(409, "routing_not_approved", `Routing ${routing.code} has no approved version`);
    }
    const ops = await operationsOf(tx, [version.id]);
    const centres = await workCentresById(
      tx,
      ops.map((o) => o.workCentreId),
    );
    const [recipeVersion] = await tx
      .select()
      .from(recipeVersions)
      .where(eq(recipeVersions.id, batch.recipeVersionId));
    const output = await findItem(tx, workspaceId, batch.outputItemId);
    const factor = (recipeVersion && batchFactor(recipeVersion, output, batch.plannedQuantity)) ?? 1;
    const inserted = await tx
      .insert(jobCards)
      .values(
        ops.map((op) => {
          const expected = expectedOperationMinutes(op, factor);
          return {
            id: newId(),
            workspaceId,
            batchId: batch.id,
            routingVersionId: version.id,
            operationId: op.id,
            position: op.position,
            name: op.name,
            workCentreId: op.workCentreId,
            plannedQuantity: batch.plannedQuantity,
            expectedSetupMinutes: expected.setup,
            expectedRunMinutes: expected.run,
            costPerHour: centres.get(op.workCentreId)?.costPerHour ?? 0,
            createdBy: actorId,
          };
        }),
      )
      .returning();
    await recordChanges(tx, workspaceId, actorId, inserted.map(cardChange));
  });
  return listBatchJobCards(db, workspaceId, batchId);
}

/** Cancels a batch's job cards before any work is recorded on them, so they can be made again. */
export async function cancelJobCards(db: Database, workspaceId: string, actorId: string, batchId: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findBatch(tx, workspaceId, batchId);
    const cards = await liveCardsOfBatch(tx, batchId);
    if (!cards.length) throw new ApiError(409, "no_job_cards", "This batch has no job cards");
    const progress = await progressOf(tx, cards);
    const ids = cards.map((c) => c.id);
    const [records] = await tx
      .select({ n: count() })
      .from(jobCardRecords)
      .where(inArray(jobCardRecords.jobCardId, ids));
    const used = cards.some((c) => {
      const p = progress.get(c.id)!;
      return c.status === "completed" || p.good > 0 || p.scrap > 0 || p.minutes > 0 || p.runningTimers > 0;
    });
    if (used || (records?.n ?? 0) > 0) {
      throw new ApiError(
        409,
        "job_cards_in_use",
        "Work is recorded on these job cards; void it first, or complete the operations",
      );
    }
    const rows = await tx
      .update(jobCards)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(inArray(jobCards.id, ids))
      .returning();
    await recordChanges(tx, workspaceId, actorId, rows.map(cardChange));
  });
  return listBatchJobCards(db, workspaceId, batchId);
}

/** Stops every running timer on the cards, at `now`. */
async function stopTimers(tx: Transaction, cardIds: string[], now: Date) {
  if (!cardIds.length) return;
  await tx
    .update(jobCardTimeLogs)
    .set({
      endedAt: now,
      minutes: sql`greatest(1, round(extract(epoch from (${now.toISOString()}::timestamptz - ${jobCardTimeLogs.startedAt})) / 60))::int`,
    })
    .where(
      and(
        inArray(jobCardTimeLogs.jobCardId, cardIds),
        isNull(jobCardTimeLogs.endedAt),
        isNull(jobCardTimeLogs.voidedAt),
      ),
    );
}

/**
 * Production's completion check while Routings is active: a batch with job cards completes only
 * once every operation has.
 */
export async function assertJobCardsComplete(tx: Executor, batch: BatchRow) {
  const cards = await liveCardsOfBatch(tx, batch.id);
  if (!cards.length) return;
  const open = cards.filter((c) => c.status !== "completed");
  if (open.length) {
    throw new ApiError(
      409,
      "job_cards_open",
      `Complete every operation before completing the batch: ${open.map((c) => `${c.position}. ${c.name}`).join(", ")} still open`,
    );
  }
  const last = cards.at(-1)!;
  await assertOutputWithinGood(tx, batch, last, (await progressOf(tx, [last])).get(last.id)!.good);
}

/**
 * The batch's finished stock can't be more than its last operation passed as good, however it was
 * posted (output posted before the cards were made, or while Routings was off, counts too).
 */
async function assertOutputWithinGood(tx: Executor, batch: BatchRow, last: CardRow, good: number) {
  const [produced] = await tx
    .select({ total: sql<string>`coalesce(sum(${productionRecords.quantity}), 0)` })
    .from(productionRecords)
    .where(and(eq(productionRecords.batchId, batch.id), eq(productionRecords.kind, "output")));
  const net = roundQuantity(num(produced?.total));
  if (net <= good) return;
  const output = await findItem(tx, batch.workspaceId, batch.outputItemId);
  const made = stockAmount(net, output);
  const passed = stockAmount(good, output);
  throw new ApiError(
    409,
    "output_exceeds_good",
    `Batch ${batch.batchCode} has ${made.display} ${made.displayUnit} of output on record but operation ${last.position} (${last.name}) passed ${passed.display} ${passed.displayUnit} as good; reverse the difference first`,
  );
}

/**
 * Production's resize check while Routings is active: a planned batch's job cards froze its size
 * and recipe version (expected minutes and cost), so it keeps them until its cards are cancelled.
 */
export async function refuseReplanWithCards(tx: Executor, batch: BatchRow) {
  if ((await liveCardsOfBatch(tx, batch.id)).length) {
    throw new ApiError(
      409,
      "job_cards_exist",
      `Batch ${batch.batchCode} has job cards made for its current size and version; cancel the job cards first`,
    );
  }
}

/**
 * Production's direct-output check while Routings is active: a batch with job cards takes its
 * output from the last operation's card (`POST /routings/job-cards/:id/output`), which keeps it
 * within what that operation passed as good.
 */
export async function refuseDirectOutput(tx: Executor, batch: BatchRow) {
  if ((await liveCardsOfBatch(tx, batch.id)).length) {
    throw new ApiError(
      409,
      "use_job_card",
      `Batch ${batch.batchCode} has job cards: post its output from the last operation's job card`,
    );
  }
}

/** Production's cancellation step while Routings is active: the batch's open cards are cancelled. */
export async function cancelOpenJobCards(tx: Transaction, batch: BatchRow): Promise<ChangeInput[]> {
  const open = (await liveCardsOfBatch(tx, batch.id)).filter((c) => openJobCardStatuses.includes(c.status));
  if (!open.length) return [];
  const now = new Date();
  await stopTimers(
    tx,
    open.map((c) => c.id),
    now,
  );
  const rows = await tx
    .update(jobCards)
    .set({ status: "cancelled", cancelledAt: now })
    .where(
      inArray(
        jobCards.id,
        open.map((c) => c.id),
      ),
    )
    .returning();
  return rows.map(cardChange);
}

// ─── Job cards: recording ────────────────────────────────────────────────────

/** The card and its batch, under the workspace lock; the card must still be open. */
async function openCard(
  tx: Transaction,
  workspaceId: string,
  id: string,
  { batchRunning = true }: { batchRunning?: boolean } = {},
) {
  await lockWorkspaceLog(tx, workspaceId);
  const card = await findCard(tx, workspaceId, id);
  const batch = await findBatch(tx, workspaceId, card.batchId);
  if (!openJobCardStatuses.includes(card.status)) {
    throw new ApiError(
      409,
      "job_card_closed",
      `This job card is ${jobCardStatusLabels[card.status].toLowerCase()}`,
    );
  }
  const allowed: BatchRow["status"][] = batchRunning ? ["in_progress"] : ["planned", "in_progress"];
  if (!allowed.includes(batch.status)) {
    throw new ApiError(
      409,
      "invalid_batch_status",
      batch.status === "planned"
        ? `Start batch ${batch.batchCode} before recording work on its operations`
        : `Batch ${batch.batchCode} is ${batch.status}`,
    );
  }
  return { card, batch };
}

/** A pending card becomes in progress with its first work. */
async function markStarted(tx: Transaction, card: CardRow, now = new Date()): Promise<ChangeInput[]> {
  if (card.status !== "pending") return [];
  const [row] = await tx
    .update(jobCards)
    .set({ status: "in_progress", startedAt: now })
    .where(eq(jobCards.id, card.id))
    .returning();
  return [cardChange(row!)];
}

export async function startJobCardTimer(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: JobCardTimerStartInput,
) {
  await db.transaction(async (tx) => {
    const { card } = await openCard(tx, workspaceId, id);
    const [running] = await tx
      .select({ id: jobCardTimeLogs.id })
      .from(jobCardTimeLogs)
      .where(
        and(
          eq(jobCardTimeLogs.jobCardId, id),
          eq(jobCardTimeLogs.userId, actorId),
          isNull(jobCardTimeLogs.endedAt),
          isNull(jobCardTimeLogs.voidedAt),
        ),
      );
    if (running) throw new ApiError(409, "timer_running", "Your timer is already running on this job card");
    const now = new Date();
    await tx.insert(jobCardTimeLogs).values({
      workspaceId,
      jobCardId: id,
      userId: actorId,
      startedAt: now,
      note: input.note ?? null,
    });
    await recordChanges(tx, workspaceId, actorId, await markStarted(tx, card, now));
  });
  return getJobCard(db, workspaceId, id);
}

/** Stops the caller's running timer on the card. Works while the card is open, whatever the batch. */
export async function stopJobCardTimer(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findCard(tx, workspaceId, id);
    const [running] = await tx
      .select()
      .from(jobCardTimeLogs)
      .where(
        and(
          eq(jobCardTimeLogs.jobCardId, id),
          eq(jobCardTimeLogs.userId, actorId),
          isNull(jobCardTimeLogs.endedAt),
          isNull(jobCardTimeLogs.voidedAt),
        ),
      );
    if (!running) throw new ApiError(409, "no_timer", "You have no timer running on this job card");
    const now = new Date();
    await tx
      .update(jobCardTimeLogs)
      .set({ endedAt: now, minutes: loggedMinutes(running.startedAt, now) })
      .where(eq(jobCardTimeLogs.id, running.id));
  });
  return getJobCard(db, workspaceId, id);
}

/** Time entered after the fact by the caller. */
export async function addJobCardTime(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: JobCardTimeEntryInput,
) {
  await db.transaction(async (tx) => {
    const { card } = await openCard(tx, workspaceId, id);
    const endedAt = input.startedAt
      ? new Date(new Date(input.startedAt).getTime() + input.minutes * 60_000)
      : new Date();
    const startedAt = input.startedAt
      ? new Date(input.startedAt)
      : new Date(endedAt.getTime() - input.minutes * 60_000);
    if (endedAt.getTime() > Date.now() + 60_000) throw badRequest("Time can't end in the future");
    await tx.insert(jobCardTimeLogs).values({
      workspaceId,
      jobCardId: id,
      userId: actorId,
      startedAt,
      endedAt,
      minutes: input.minutes,
      note: input.note ?? null,
    });
    await recordChanges(tx, workspaceId, actorId, await markStarted(tx, card));
  });
  return getJobCard(db, workspaceId, id);
}

export async function voidJobCardTime(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  logId: string,
  reason: string,
) {
  await db.transaction(async (tx) => {
    await openCard(tx, workspaceId, id, { batchRunning: false });
    const [log] = await tx
      .select()
      .from(jobCardTimeLogs)
      .where(and(eq(jobCardTimeLogs.id, logId), eq(jobCardTimeLogs.jobCardId, id)));
    if (!log) throw notFound("Time log");
    if (log.voidedAt) throw new ApiError(409, "already_voided", "This time log is already voided");
    const now = new Date();
    await tx
      .update(jobCardTimeLogs)
      .set({ voidedAt: now, voidedBy: actorId, voidReason: reason, endedAt: log.endedAt ?? now })
      .where(eq(jobCardTimeLogs.id, logId));
  });
  return getJobCard(db, workspaceId, id);
}

/**
 * Good and scrap reported at an operation. Operation N+1 can never report (good plus scrap) more
 * than operation N passed as good: what isn't there can't be worked on.
 */
export async function recordJobCardQuantity(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: JobCardQuantityInput,
) {
  await executeLedgerCommand(
    db,
    workspaceId,
    actorId,
    "recordJobCardQuantity",
    input,
    { id, input },
    async (tx) => {
      const { card, batch } = await openCard(tx, workspaceId, id);
      const output = await findItem(tx, workspaceId, batch.outputItemId);
      const good = toBase(input.good, input.unit, output, { allowZero: true });
      const scrap = toBase(input.scrap, input.unit, output, { allowZero: true });
      if (!(good > 0 || scrap > 0)) throw badRequest("Enter a good or scrap quantity");
      const cards = await liveCardsOfBatch(tx, batch.id);
      const progress = await progressOf(tx, cards);
      const remaining = remainingFromPrevious([...progress.values()], card.position);
      if (remaining === null && !input.overPlanned) {
        // The first operation: no more than the batch was planned to make, unless said so.
        const mine = progress.get(card.id)!;
        if (roundQuantity(mine.good + mine.scrap + good + scrap) > card.plannedQuantity) {
          const planned = stockAmount(card.plannedQuantity, output);
          throw new ApiError(
            409,
            "exceeds_planned",
            `The batch was planned for ${planned.display} ${planned.displayUnit}; to report more at the first operation, confirm it was over-produced`,
          );
        }
      }
      if (remaining !== null && roundQuantity(good + scrap) > remaining) {
        const previous = cards[cards.findIndex((c) => c.id === card.id) - 1]!;
        const passed = stockAmount(progress.get(previous.id)!.good, output);
        const left = stockAmount(remaining, output);
        throw new ApiError(
          409,
          "exceeds_previous_good",
          `Operation ${previous.position} (${previous.name}) passed ${passed.display} ${passed.displayUnit} as good; at most ${left.display} ${left.displayUnit} more can be reported here`,
        );
      }
      await tx.insert(jobCardQuantities).values({
        workspaceId,
        jobCardId: id,
        good,
        scrap,
        scrapReason: input.scrapReason ?? null,
        note: input.note ?? null,
        recordedBy: actorId,
      });
      await recordChanges(tx, workspaceId, actorId, await markStarted(tx, card));
      return { id };
    },
  );
  return getJobCard(db, workspaceId, id);
}

/**
 * Voids a quantity entry. The card must still be open, and what it then passed as good must still
 * cover what the next operation (or, at the last one, the output posted from it) has already used.
 */
export async function voidJobCardQuantity(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  entryId: string,
  reason: string,
) {
  await db.transaction(async (tx) => {
    const { card, batch } = await openCard(tx, workspaceId, id, { batchRunning: false });
    const [entry] = await tx
      .select()
      .from(jobCardQuantities)
      .where(and(eq(jobCardQuantities.id, entryId), eq(jobCardQuantities.jobCardId, id)));
    if (!entry) throw notFound("Quantity entry");
    if (entry.voidedAt) throw new ApiError(409, "already_voided", "This entry is already voided");
    const cards = await liveCardsOfBatch(tx, batch.id);
    const progress = await progressOf(tx, cards);
    const goodAfter = roundQuantity(progress.get(card.id)!.good - entry.good);
    const index = cards.findIndex((c) => c.id === card.id);
    const next = cards[index + 1];
    if (next) {
      const p = progress.get(next.id)!;
      if (roundQuantity(p.good + p.scrap) > goodAfter) {
        throw new ApiError(
          409,
          "used_by_next_operation",
          `Operation ${next.position} (${next.name}) has already reported more than would be left; void it there first`,
        );
      }
    } else if ((await linkedOutput(tx, card.id)) > goodAfter) {
      throw new ApiError(
        409,
        "used_by_output",
        "Output posted from this job card needs it; reverse that output first",
      );
    }
    await tx
      .update(jobCardQuantities)
      .set({ voidedAt: new Date(), voidedBy: actorId, voidReason: reason })
      .where(eq(jobCardQuantities.id, entryId));
  });
  return getJobCard(db, workspaceId, id);
}

export async function raiseJobCardException(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: JobCardExceptionInput,
) {
  await db.transaction(async (tx) => {
    await openCard(tx, workspaceId, id, { batchRunning: false });
    await tx.insert(jobCardExceptions).values({
      workspaceId,
      jobCardId: id,
      kind: input.kind,
      description: input.description,
      raisedBy: actorId,
    });
  });
  return getJobCard(db, workspaceId, id);
}

export async function resolveJobCardException(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  exceptionId: string,
  input: JobCardExceptionResolveInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findCard(tx, workspaceId, id);
    const [row] = await tx
      .select()
      .from(jobCardExceptions)
      .where(and(eq(jobCardExceptions.id, exceptionId), eq(jobCardExceptions.jobCardId, id)));
    if (!row) throw notFound("Exception");
    if (row.status !== "open")
      throw new ApiError(409, "already_resolved", "This exception is already resolved");
    await tx
      .update(jobCardExceptions)
      .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: actorId, resolution: input.resolution })
      .where(eq(jobCardExceptions.id, exceptionId));
  });
  return getJobCard(db, workspaceId, id);
}

/**
 * Completes an operation: the one before it must be complete, no exception may be open, and it
 * must have reported something. Running timers on it stop now.
 */
export async function completeJobCard(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: JobCardCompleteInput,
) {
  await db.transaction(async (tx) => {
    const { card, batch } = await openCard(tx, workspaceId, id);
    const cards = await liveCardsOfBatch(tx, batch.id);
    const progress = await progressOf(tx, cards);
    const blocking = blockingPrevious([...progress.values()], card.position);
    if (blocking) {
      throw new ApiError(
        409,
        "previous_operation_open",
        `Complete operation ${blocking.position} before this one`,
      );
    }
    const mine = progress.get(card.id)!;
    if (mine.openExceptions > 0) {
      throw new ApiError(
        409,
        "open_exceptions",
        "Resolve this operation's open exceptions before completing it",
      );
    }
    if (!(mine.good > 0 || mine.scrap > 0)) {
      throw new ApiError(409, "nothing_reported", "Report the good and scrap quantities before completing");
    }
    if (cards.at(-1)?.id === card.id) await assertOutputWithinGood(tx, batch, card, mine.good);
    const now = new Date();
    await stopTimers(tx, [card.id], now);
    const [row] = await tx
      .update(jobCards)
      .set({
        status: "completed",
        startedAt: card.startedAt ?? now,
        completedAt: now,
        completedBy: actorId,
        completionNote: input.note ?? null,
      })
      .where(eq(jobCards.id, card.id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [cardChange(row!)]);
  });
  return getJobCard(db, workspaceId, id);
}

/** The record hooks that tie a batch record to an open job card of that batch. */
function cardHooks(
  workspaceId: string,
  cardId: string,
  operation: string,
  check?: (tx: Transaction, card: CardRow, batch: BatchRow) => Promise<void>,
  afterPost?: (tx: Transaction, card: CardRow) => Promise<void>,
) {
  let current: CardRow | undefined;
  return {
    operation,
    scope: `job_card:${cardId}`,
    beforePost: async (tx: Transaction, batch: BatchRow) => {
      const { card } = await openCard(tx, workspaceId, cardId);
      if (card.batchId !== batch.id) throw notFound("Job card");
      await check?.(tx, card, batch);
      current = card;
    },
    onPosted: async (tx: Transaction, _batch: BatchRow, rows: { id: string }[]) => {
      await tx
        .insert(jobCardRecords)
        .values(rows.map((r) => ({ workspaceId, jobCardId: cardId, productionRecordId: r.id })));
      await afterPost?.(tx, current!);
      return markStarted(tx, current!);
    },
  };
}

/** Materials used at an operation: the batch's consumption, linked to the card. */
export async function consumeOnJobCard(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: ProductionConsumptionInput,
) {
  const card = await findCard(db, workspaceId, id);
  await recordConsumption(
    db,
    workspaceId,
    actorId,
    card.batchId,
    input,
    cardHooks(workspaceId, id, "recordJobCardConsumption"),
  );
  return getJobCard(db, workspaceId, id);
}

/**
 * Output of the last operation: the batch's output, linked to the card. Never more, net, than the
 * card has passed as good.
 */
export async function outputFromJobCard(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: ProductionOutputInput,
  foodItems: boolean,
) {
  const card = await findCard(db, workspaceId, id);
  await recordOutput(
    db,
    workspaceId,
    actorId,
    card.batchId,
    input,
    foodItems,
    cardHooks(
      workspaceId,
      id,
      "recordJobCardOutput",
      async (tx, current, batch) => {
        const cards = await liveCardsOfBatch(tx, batch.id);
        if (cards.at(-1)?.id !== current.id) {
          throw new ApiError(
            409,
            "not_last_operation",
            "Only the last operation's job card posts the batch's output",
          );
        }
      },
      async (tx, current) => {
        const good = (await progressOf(tx, [current])).get(current.id)!.good;
        if ((await linkedOutput(tx, current.id)) > good) {
          throw new ApiError(
            409,
            "output_exceeds_good",
            "That is more output than this operation has passed as good; report the good quantity first",
          );
        }
      },
    ),
  );
  return getJobCard(db, workspaceId, id);
}
