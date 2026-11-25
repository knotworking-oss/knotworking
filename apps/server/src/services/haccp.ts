import {
  addFrequencyToDate,
  analysisNotes,
  awaitsReview,
  canApproveSopVersion,
  decisionTreeOutcome,
  defaultHazardReviewDueOn,
  hazardReviewState,
  hazardRisk,
  hazardReviewIntervalOf,
  overdueByMoreThanInterval,
  processFlow,
  calibrationPasses,
  ccpLogReviewStatusLabels,
  checkDueState,
  compareDueStates,
  countsAsDone,
  dateDueState,
  defaultSopReviewDueOn,
  describeFrequency,
  describeLimit,
  describeReading,
  evaluateReading,
  initialReviewStatus,
  dateInZone,
  endOfDayInZone,
  startOfDayInZone,
  todayInZone,
  planVersionSchedule,
  reviewStatusFor,
  versionInForce,
  scopeCoversBatch,
  type CalibrationCorrectInput,
  type HaccpBulkSignoffInput,
  type HaccpHazardReviewInput,
  type HaccpPlanTemplateCreateInput,
  type HaccpPlanTemplateInput,
  type HaccpPlanTemplateListQuery,
  type HazardLibraryEntryInput,
  type HazardLibraryListQuery,
  type CalibrationRecordCreateInput,
  type CleaningCorrectInput,
  type HaccpDaySignoffInput,
  type HaccpSignoffListQuery,
  type ProcessStepInput,
  type CcpInput,
  type CcpLogBulkReviewInput,
  type CcpLogCorrectInput,
  type CcpLogCreateInput,
  type CcpLogListQuery,
  type CcpLogReviewInput,
  type CcpReading,
  type CheckFrequencyUnit,
  type CleaningRecordCreateInput,
  type CleaningVerifyInput,
  type CorrectiveActionCloseInput,
  type CorrectiveActionCreateInput,
  type CorrectiveActionListQuery,
  type CorrectiveActionUpdateInput,
  type DeviationListQuery,
  type DueResult,
  type DueState,
  type HaccpAssetCreateInput,
  type HaccpAssetListQuery,
  type HaccpAssetUpdateInput,
  type HaccpDueQuery,
  type HaccpPlanApproveInput,
  type HaccpPlanCreateInput,
  type HaccpPlanDraftInput,
  type HaccpPlanListQuery,
  type HaccpPlanStatusInput,
  type HaccpPlanUpdateInput,
  type HaccpRecordListQuery,
  type HaccpScope,
  type HaccpSource,
  type PlanVersionState,
  type ScheduleFrequencyUnit,
} from "@knotworking/core";
import {
  haccpAssets,
  haccpCalibrationRecords,
  haccpCcpLogs,
  haccpCcps,
  haccpCleaningRecords,
  haccpDaySignoffs,
  haccpHazardLibrary,
  haccpPlanTemplates,
  haccpProcessSteps,
  haccpCorrectiveActions,
  haccpPlans,
  haccpPlanVersions,
  items,
  lockWorkspaceLog,
  productionBatches,
  recipes,
  recordChanges,
  stockLots,
  workspaceMembers,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { workspaceTimeZone, workspaceToday } from "./time-zone";
import {
  audience,
  deliverNotifications,
  memberAccess,
  notifyDeviationRecorded,
  notifyReadingOutOfLimit,
  notifyReadingsAwaitingReview,
  type NotificationRow,
} from "./notifications";
import { findBatch, userNames } from "./ports/production";

/**
 * Food safety records module (`haccp`).
 *
 * - **Plans** are controlled documents like recipes: at most one draft (the only editable
 *   version) and one approved version per plan; approving (`manage`, a signed-in person, checked
 *   by the route) supersedes the previous version, which is kept. A version holds the scope and
 *   the CCPs. Which version is **in force** on a date follows the effective dates, not the status
 *   labels (`versionInForce`, core): a version approved with a future effective date is
 *   scheduled, and the previous one stays in force until that date.
 * - **CCP logs** are append-only. A check names a CCP of the version of its plan in force on the
 *   day it was checked and is pinned to that row; `evaluateReading` flags it out of limits, and an out-of-limit reading
 *   opens a corrective action in the same transaction. A correction is a new row that points at
 *   the one it corrects. A person's reading is approved as entered; one from an API token waits
 *   for a person with `manage` to approve or reject it (a one-time stamp, the only update a log
 *   takes).
 * - **Corrective actions** are worked on while open and closed by a person with `manage`.
 * - **Cleaning and calibration records** are append-only logs against a minimal registry of areas
 *   and equipment. A failed calibration opens a corrective action.
 * - **What's due** is computed on read from the frequencies and the last records.
 *
 * Everything is read through endpoints, not the bootstrap; every write appends to the sync log.
 */

type PlanRow = typeof haccpPlans.$inferSelect;
type VersionRow = typeof haccpPlanVersions.$inferSelect;
type CcpRow = typeof haccpCcps.$inferSelect;
type LogRow = typeof haccpCcpLogs.$inferSelect;
type ActionRow = typeof haccpCorrectiveActions.$inferSelect;
type AssetRow = typeof haccpAssets.$inferSelect;
type CleaningRow = typeof haccpCleaningRecords.$inferSelect;
type CalibrationRow = typeof haccpCalibrationRecords.$inferSelect;
type StepRow = typeof haccpProcessSteps.$inferSelect;
type BatchRow = typeof productionBatches.$inferSelect;

/** `%` and `_` are literal in a search box. */
const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;

/** How far ahead of the server's clock a check may be dated (clock skew on a tablet). */
const FUTURE_SKEW_MS = 5 * 60_000;

// ─── Serialisation ───────────────────────────────────────────────────────────

const strip = <T extends { workspaceId: string }>(row: T) => {
  const { workspaceId: _ws, ...rest } = row;
  return rest;
};
const stripSoft = <T extends { workspaceId: string; deletedAt: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
};
const change = (
  entity: ChangeInput["entity"],
  row: { id: string; workspaceId: string; deletedAt?: Date | null },
): ChangeInput => {
  const { workspaceId: _ws, deletedAt: _deleted, ...data } = row;
  return { entity, entityId: row.id, action: "upsert", data };
};

const frequencyOf = (every: number | null, unit: string | null) =>
  every !== null && unit !== null ? { every, unit: unit as ScheduleFrequencyUnit } : null;

function serializeCcp(row: CcpRow) {
  const { workspaceId: _ws, deletedAt: _d, frequencyEvery, frequencyUnit, ...rest } = row;
  const frequency = { every: frequencyEvery, unit: frequencyUnit };
  return {
    ...rest,
    frequency,
    frequencyText: describeFrequency(frequency),
    limitText: describeLimit(row),
  };
}

function serializeAsset(row: AssetRow) {
  const {
    workspaceId: _ws,
    deletedAt: _d,
    cleaningEvery,
    cleaningUnit,
    calibrationEvery,
    calibrationUnit,
    ...rest
  } = row;
  const cleaningFrequency = frequencyOf(cleaningEvery, cleaningUnit);
  const calibrationFrequency = frequencyOf(calibrationEvery, calibrationUnit);
  return {
    ...rest,
    cleaningFrequency,
    calibrationFrequency,
    cleaningFrequencyText: cleaningFrequency ? describeFrequency(cleaningFrequency) : null,
    calibrationFrequencyText: calibrationFrequency ? describeFrequency(calibrationFrequency) : null,
  };
}

const nameOf = (names: Map<string, string>, id: string | null) => (id ? (names.get(id) ?? null) : null);

// ─── Plans: lookups ──────────────────────────────────────────────────────────

async function findPlan(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(haccpPlans)
    .where(and(eq(haccpPlans.id, id), eq(haccpPlans.workspaceId, workspaceId), isNull(haccpPlans.deletedAt)));
  if (!row) throw notFound("HACCP plan");
  return row;
}

const liveVersions = (planId: string) =>
  and(eq(haccpPlanVersions.planId, planId), isNull(haccpPlanVersions.deletedAt));

async function versionWith(db: Executor, planId: string, status: "draft" | "approved") {
  const [row] = await db
    .select()
    .from(haccpPlanVersions)
    .where(and(liveVersions(planId), eq(haccpPlanVersions.status, status)));
  return row;
}

async function ccpsOf(db: Executor, versionIds: string[]) {
  if (versionIds.length === 0) return [];
  return db
    .select()
    .from(haccpCcps)
    .where(and(inArray(haccpCcps.versionId, versionIds), isNull(haccpCcps.deletedAt)))
    .orderBy(asc(haccpCcps.sortOrder), asc(haccpCcps.id));
}

async function stepsOf(db: Executor, versionIds: string[]) {
  if (versionIds.length === 0) return [];
  return db
    .select()
    .from(haccpProcessSteps)
    .where(and(inArray(haccpProcessSteps.versionId, versionIds), isNull(haccpProcessSteps.deletedAt)))
    .orderBy(asc(haccpProcessSteps.sortOrder), asc(haccpProcessSteps.id));
}

/** A step with each hazard's risk and where the decision tree leads, and the process flow. */
function serializeSteps(steps: StepRow[], ccps: CcpRow[]) {
  const analysed = steps.map((step) => ({
    id: step.id,
    sortOrder: step.sortOrder,
    name: step.name,
    description: step.description,
    hazards: step.hazards.map((h) => ({
      ...h,
      risk: hazardRisk(h.likelihood, h.severity),
      outcome: decisionTreeOutcome(h),
    })),
  }));
  const links = ccps.map((c) => ({ code: c.code, stepId: c.stepId }));
  return {
    steps: analysed,
    flow: processFlow(analysed, links),
    analysisNotes: analysisNotes(analysed, links).map((n) => ({ stepId: n.stepId, text: n.text })),
  };
}

const scopeOf = (version: VersionRow): HaccpScope => ({
  itemIds: version.scopeItemIds,
  recipeIds: version.scopeRecipeIds,
});

/** Every live version of the plans, for working out which is in force. */
async function versionsOf(db: Executor, planIds: string[]) {
  if (planIds.length === 0) return [];
  return db
    .select()
    .from(haccpPlanVersions)
    .where(and(inArray(haccpPlanVersions.planId, planIds), isNull(haccpPlanVersions.deletedAt)))
    .orderBy(desc(haccpPlanVersions.versionNumber));
}

/** Where a version stands today, and until when the one in force stays in force. */
interface VersionTiming {
  state: PlanVersionState;
  /** For the version in force: the date the next approved version takes effect, if one is scheduled. */
  inForceUntil: string | null;
}
const timingOf = (
  schedule: ReturnType<typeof planVersionSchedule<VersionRow>>,
  id: string,
): VersionTiming => {
  const state = schedule.states.get(id) ?? "draft";
  return { state, inForceUntil: state === "in_force" ? schedule.inForceUntil : null };
};

/** A version in full: scope with the items and recipes it names, and its CCPs. */
async function fullVersion(db: Executor, workspaceId: string, version: VersionRow, timing: VersionTiming) {
  const [ccps, steps, scopeItems, scopeRecipes, names] = await Promise.all([
    ccpsOf(db, [version.id]),
    stepsOf(db, [version.id]),
    version.scopeItemIds.length
      ? db
          .select({ id: items.id, code: items.code, name: items.name, status: items.status })
          .from(items)
          .where(and(eq(items.workspaceId, workspaceId), inArray(items.id, version.scopeItemIds)))
      : [],
    version.scopeRecipeIds.length
      ? db
          .select({ id: recipes.id, code: recipes.code, name: recipes.name, status: recipes.status })
          .from(recipes)
          .where(and(eq(recipes.workspaceId, workspaceId), inArray(recipes.id, version.scopeRecipeIds)))
      : [],
    userNames(db, [version.approvedBy, version.createdBy, version.updatedBy]),
  ]);
  const { scopeItemIds, scopeRecipeIds, ...fields } = stripSoft(version);
  return {
    ...fields,
    ...timing,
    approvedByName: nameOf(names, version.approvedBy),
    createdByName: nameOf(names, version.createdBy),
    updatedByName: nameOf(names, version.updatedBy),
    scope: {
      itemIds: scopeItemIds,
      recipeIds: scopeRecipeIds,
      items: scopeItems,
      recipes: scopeRecipes,
      wholeSite: scopeItemIds.length === 0 && scopeRecipeIds.length === 0,
    },
    ccps: ccps.map(serializeCcp),
    ...serializeSteps(steps, ccps),
  };
}

// ─── Plans: reading ──────────────────────────────────────────────────────────

export async function listPlans(db: Database, workspaceId: string, query: HaccpPlanListQuery) {
  const where: (SQL | undefined)[] = [eq(haccpPlans.workspaceId, workspaceId), isNull(haccpPlans.deletedAt)];
  if (query.status !== "all") where.push(eq(haccpPlans.status, query.status));
  if (query.q) {
    where.push(
      or(
        sql`${haccpPlans.name} ilike ${like(query.q)} escape '!'`,
        sql`${haccpPlans.code} ilike ${like(query.q)} escape '!'`,
      ),
    );
  }
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(haccpPlans)
      .where(and(...where))
      .orderBy(asc(haccpPlans.code), asc(haccpPlans.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(haccpPlans)
      .where(and(...where)),
  ]);
  const today = await workspaceToday(db, workspaceId);
  const versions = await versionsOf(
    db,
    rows.map((r) => r.id),
  );
  const schedules = new Map(
    rows.map((row) => [
      row.id,
      planVersionSchedule(
        versions.filter((v) => v.planId === row.id),
        today,
      ),
    ]),
  );
  const counted = [...schedules.values()].flatMap((s) => [s.inForce, s.next]).filter((v) => v !== null);
  const ccpCounts = counted.length
    ? await db
        .select({ versionId: haccpCcps.versionId, n: count() })
        .from(haccpCcps)
        .where(
          and(
            inArray(
              haccpCcps.versionId,
              counted.map((v) => v.id),
            ),
            isNull(haccpCcps.deletedAt),
          ),
        )
        .groupBy(haccpCcps.versionId)
    : [];
  const countOf = new Map(ccpCounts.map((c) => [c.versionId, c.n]));
  const summary = (version: VersionRow) => ({
    id: version.id,
    versionNumber: version.versionNumber,
    effectiveOn: version.effectiveOn,
    reviewDueOn: version.reviewDueOn,
    approvedAt: version.approvedAt,
    ccpCount: countOf.get(version.id) ?? 0,
    wholeSite: version.scopeItemIds.length === 0 && version.scopeRecipeIds.length === 0,
  });
  return {
    plans: rows.map((row) => {
      const { inForce, inForceUntil, next } = schedules.get(row.id)!;
      const draft = versions.find((v) => v.planId === row.id && v.status === "draft");
      return {
        ...stripSoft(row),
        /** The version in force today. */
        currentVersion: inForce ? { ...summary(inForce), inForceUntil } : null,
        /** An approved version with a future effective date: it takes over on `effectiveOn`. */
        upcomingVersion: next ? summary(next) : null,
        reviewState: inForce?.reviewDueOn ? dateDueState(inForce.reviewDueOn, today, 30) : null,
        hazardReviewState: hazardReviewState(row.hazardReviewDueOn, today),
        hasDraft: !!draft,
        draftVersionNumber: draft?.versionNumber ?? null,
      };
    }),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getPlan(db: Executor, workspaceId: string, id: string) {
  const today = await workspaceToday(db, workspaceId);
  const plan = await findPlan(db, workspaceId, id);
  const versions = await versionsOf(db, [id]);
  const names = await userNames(db, [...versions.map((v) => v.approvedBy), plan.hazardReviewedBy]);
  const schedule = planVersionSchedule(versions, today);
  const { inForce, next } = schedule;
  const draft = versions.find((v) => v.status === "draft");
  return {
    ...stripSoft(plan),
    /** The hazard analysis has its own review, apart from the plan's review date (on its versions). */
    hazardReviewIntervalEffective: hazardReviewIntervalOf(plan),
    hazardReviewState: hazardReviewState(plan.hazardReviewDueOn, today),
    hazardReviewedByName: nameOf(names, plan.hazardReviewedBy),
    versions: versions.map((v) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      status: v.status,
      ...timingOf(schedule, v.id),
      changeNote: v.changeNote,
      effectiveOn: v.effectiveOn,
      reviewDueOn: v.reviewDueOn,
      approvedAt: v.approvedAt,
      approvedBy: v.approvedBy,
      approvedByName: nameOf(names, v.approvedBy),
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    })),
    /** The version in force today (`inForceUntil`: when a scheduled version takes over). */
    currentVersion: inForce
      ? await fullVersion(db, workspaceId, inForce, timingOf(schedule, inForce.id))
      : null,
    /** The next approved version to take effect, on its `effectiveOn`. */
    upcomingVersion: next ? await fullVersion(db, workspaceId, next, timingOf(schedule, next.id)) : null,
    reviewState: inForce?.reviewDueOn ? dateDueState(inForce.reviewDueOn, today, 30) : null,
    draftVersion: draft ? await fullVersion(db, workspaceId, draft, timingOf(schedule, draft.id)) : null,
  };
}

export async function getPlanVersion(db: Executor, workspaceId: string, id: string, versionId: string) {
  await findPlan(db, workspaceId, id);
  const versions = await versionsOf(db, [id]);
  const version = versions.find((v) => v.id === versionId);
  if (!version) throw notFound("Plan version");
  return fullVersion(
    db,
    workspaceId,
    version,
    timingOf(planVersionSchedule(versions, await workspaceToday(db, workspaceId)), version.id),
  );
}

/**
 * Every item and recipe a plan's versions already name in their scope. A draft that keeps them
 * needs no access to Items or Recipes (soft dependencies); only adding new ones does.
 */
export async function planScopeIds(db: Executor, workspaceId: string, planId: string) {
  const rows = await db
    .select({ itemIds: haccpPlanVersions.scopeItemIds, recipeIds: haccpPlanVersions.scopeRecipeIds })
    .from(haccpPlanVersions)
    .innerJoin(haccpPlans, eq(haccpPlans.id, haccpPlanVersions.planId))
    .where(
      and(
        eq(haccpPlans.workspaceId, workspaceId),
        eq(haccpPlanVersions.planId, planId),
        isNull(haccpPlanVersions.deletedAt),
      ),
    );
  return {
    itemIds: new Set(rows.flatMap((r) => r.itemIds)),
    recipeIds: new Set(rows.flatMap((r) => r.recipeIds)),
  };
}

// ─── Plans: writing ──────────────────────────────────────────────────────────

async function assertPlanCodeFree(tx: Executor, workspaceId: string, code: string, exceptId?: string) {
  const [taken] = await tx
    .select({ id: haccpPlans.id })
    .from(haccpPlans)
    .where(
      and(
        eq(haccpPlans.workspaceId, workspaceId),
        isNull(haccpPlans.deletedAt),
        sql`lower(${haccpPlans.code}) = lower(${code})`,
        exceptId ? ne(haccpPlans.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `Another HACCP plan already uses the code "${code}"`);
}

/** Scope items and recipes must exist in the workspace (archived ones are allowed: history). */
async function assertScope(tx: Executor, workspaceId: string, scope: HaccpPlanDraftInput["scope"]) {
  const itemIds = [...new Set(scope.itemIds)];
  const recipeIds = [...new Set(scope.recipeIds)];
  if (itemIds.length) {
    const found = await tx
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.workspaceId, workspaceId), isNull(items.deletedAt), inArray(items.id, itemIds)));
    if (found.length !== itemIds.length) throw badRequest("The scope names an item that doesn't exist");
  }
  if (recipeIds.length) {
    const found = await tx
      .select({ id: recipes.id })
      .from(recipes)
      .where(
        and(eq(recipes.workspaceId, workspaceId), isNull(recipes.deletedAt), inArray(recipes.id, recipeIds)),
      );
    if (found.length !== recipeIds.length) throw badRequest("The scope names a recipe that doesn't exist");
  }
  return { itemIds, recipeIds };
}

const ccpValues = (
  workspaceId: string,
  versionId: string,
  ccp: CcpInput,
  sortOrder: number,
  stepId: string | null,
) => ({
  workspaceId,
  versionId,
  code: ccp.code,
  sortOrder,
  stepId,
  processStep: ccp.processStep,
  hazardType: ccp.hazardType,
  hazard: ccp.hazard,
  limitType: ccp.limitType,
  limitMin: ccp.limitMin ?? null,
  limitMax: ccp.limitMax ?? null,
  limitUnit: ccp.limitUnit ?? null,
  passCriterion: ccp.passCriterion ?? null,
  monitoringMethod: ccp.monitoringMethod,
  frequencyEvery: ccp.frequency.every,
  frequencyUnit: ccp.frequency.unit,
  duringProduction: ccp.duringProduction,
  responsibleRole: ccp.responsibleRole,
  correctiveAction: ccp.correctiveAction,
  verification: ccp.verification,
});

const stepValues = (workspaceId: string, versionId: string, step: ProcessStepInput, sortOrder: number) => ({
  workspaceId,
  versionId,
  sortOrder,
  name: step.name,
  description: step.description ?? null,
  hazards: step.hazards.map((h) => ({
    hazardType: h.hazardType,
    description: h.description,
    likelihood: h.likelihood,
    severity: h.severity,
    controlMeasure: h.controlMeasure ?? null,
    q1: h.q1,
    q2: h.q2,
    q3: h.q3,
    q4: h.q4,
    justification: h.justification ?? null,
  })),
});

/** Saves a draft inside a transaction: edits the existing draft or starts the next version. */
async function saveDraftIn(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  plan: PlanRow,
  input: HaccpPlanDraftInput,
): Promise<{ version: VersionRow; changes: ChangeInput[] }> {
  if (plan.status === "archived") {
    throw new ApiError(409, "plan_archived", "This plan is archived; make it active before editing it");
  }
  const scope = await assertScope(tx, workspaceId, input.scope);
  const fields = {
    scopeItemIds: scope.itemIds,
    scopeRecipeIds: scope.recipeIds,
    scopeNote: input.scopeNote ?? null,
    changeNote: input.changeNote ?? null,
    updatedBy: actorId,
  };
  const draft = await versionWith(tx, plan.id, "draft");
  let version: VersionRow;
  const changes: ChangeInput[] = [];
  if (draft) {
    const [updated] = await tx
      .update(haccpPlanVersions)
      .set(fields)
      .where(eq(haccpPlanVersions.id, draft.id))
      .returning();
    version = updated!;
    const old = await tx
      .delete(haccpCcps)
      .where(eq(haccpCcps.versionId, draft.id))
      .returning({ id: haccpCcps.id });
    changes.push(...old.map((c): ChangeInput => ({ entity: "haccp_ccp", entityId: c.id, action: "delete" })));
    const oldSteps = await tx
      .delete(haccpProcessSteps)
      .where(eq(haccpProcessSteps.versionId, draft.id))
      .returning({ id: haccpProcessSteps.id });
    changes.push(
      ...oldSteps.map((c): ChangeInput => ({
        entity: "haccp_process_step",
        entityId: c.id,
        action: "delete",
      })),
    );
  } else {
    const [latest] = await tx
      .select({ n: sql<number>`coalesce(max(${haccpPlanVersions.versionNumber}), 0)::int` })
      .from(haccpPlanVersions)
      .where(eq(haccpPlanVersions.planId, plan.id));
    const [inserted] = await tx
      .insert(haccpPlanVersions)
      .values({
        ...fields,
        workspaceId,
        planId: plan.id,
        versionNumber: (latest?.n ?? 0) + 1,
        status: "draft",
        createdBy: actorId,
      })
      .returning();
    version = inserted!;
  }
  changes.unshift(change("haccp_plan_version", version));
  const stepIds = new Map<string, string>();
  if (input.steps.length) {
    const insertedSteps = await tx
      .insert(haccpProcessSteps)
      .values(input.steps.map((step, i) => stepValues(workspaceId, version.id, step, i)))
      .returning();
    insertedSteps.forEach((row, i) => stepIds.set(input.steps[i]!.ref, row.id));
    changes.push(...insertedSteps.map((row) => change("haccp_process_step", row)));
  }
  if (input.ccps.length) {
    const inserted = await tx
      .insert(haccpCcps)
      .values(
        input.ccps.map((ccp, i) =>
          ccpValues(workspaceId, version.id, ccp, i, ccp.stepRef ? (stepIds.get(ccp.stepRef) ?? null) : null),
        ),
      )
      .returning();
    changes.push(...inserted.map((row) => change("haccp_ccp", row)));
  }
  return { version, changes };
}

export async function createPlan(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: HaccpPlanCreateInput,
) {
  const { draft, id, templateId, ...fields } = input;
  const planId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertPlanCodeFree(tx, workspaceId, fields.code);
    // Started from a template: its hazard analysis and CCPs are copied into the first draft.
    const start: HaccpPlanDraftInput | undefined = templateId
      ? templateDraft(await findTemplate(tx, workspaceId, templateId))
      : draft;
    const [row] = await tx
      .insert(haccpPlans)
      .values({ ...fields, ...(id ? { id } : {}), workspaceId, createdBy: actorId })
      .returning();
    const changes: ChangeInput[] = [change("haccp_plan", row!)];
    if (start) changes.push(...(await saveDraftIn(tx, workspaceId, actorId, row!, start)).changes);
    await recordChanges(tx, workspaceId, actorId, changes);
    return row!.id;
  });
  return getPlan(db, workspaceId, planId);
}

/** The plan's header: code, name, description, review interval. Not its status (`setPlanStatus`). */
export async function updatePlan(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: HaccpPlanUpdateInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findPlan(tx, workspaceId, id);
    if (patch.code !== undefined) await assertPlanCodeFree(tx, workspaceId, patch.code, id);
    const [row] = await tx.update(haccpPlans).set(patch).where(eq(haccpPlans.id, id)).returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_plan", row!)]);
  });
  return getPlan(db, workspaceId, id);
}

/**
 * Archives or restores a plan. Archiving takes it out of force (no checks are due or accepted
 * against it), so like approval it is a sign-off: the route needs `manage` and refuses API tokens.
 */
export async function setPlanStatus(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: HaccpPlanStatusInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const plan = await findPlan(tx, workspaceId, id);
    if (plan.status === input.status) return;
    const [row] = await tx
      .update(haccpPlans)
      .set({ status: input.status })
      .where(eq(haccpPlans.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_plan", row!)]);
  });
  return getPlan(db, workspaceId, id);
}

export async function savePlanDraft(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: HaccpPlanDraftInput,
) {
  const versionId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const plan = await findPlan(tx, workspaceId, id);
    const { version, changes } = await saveDraftIn(tx, workspaceId, actorId, plan, input);
    await recordChanges(tx, workspaceId, actorId, changes);
    return version.id;
  });
  return getPlanVersion(db, workspaceId, id, versionId);
}

async function removeDraft(tx: Transaction, planId: string): Promise<ChangeInput[]> {
  const draft = await versionWith(tx, planId, "draft");
  if (!draft) return [];
  const ccps = await tx
    .delete(haccpCcps)
    .where(eq(haccpCcps.versionId, draft.id))
    .returning({ id: haccpCcps.id });
  const steps = await tx
    .delete(haccpProcessSteps)
    .where(eq(haccpProcessSteps.versionId, draft.id))
    .returning({ id: haccpProcessSteps.id });
  await tx.delete(haccpPlanVersions).where(eq(haccpPlanVersions.id, draft.id));
  return [
    ...ccps.map((c): ChangeInput => ({ entity: "haccp_ccp", entityId: c.id, action: "delete" })),
    ...steps.map((c): ChangeInput => ({ entity: "haccp_process_step", entityId: c.id, action: "delete" })),
    { entity: "haccp_plan_version", entityId: draft.id, action: "delete" },
  ];
}

export async function discardPlanDraft(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findPlan(tx, workspaceId, id);
    const changes = await removeDraft(tx, id);
    if (changes.length === 0) throw new ApiError(409, "no_draft", "This plan has no draft to discard");
    await recordChanges(tx, workspaceId, actorId, changes);
  });
}

/**
 * Approves the draft (document control): it is labelled `approved`, the previous approved version
 * `superseded`, and who and when are recorded. The route needs `manage` and refuses API tokens.
 * The new version is in force from its effective date (`versionInForce`): with a future date the
 * previous version stays in force, and is monitored against, until then.
 */
export async function approvePlanDraft(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: HaccpPlanApproveInput,
) {
  const versionId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const plan = await findPlan(tx, workspaceId, id);
    if (plan.status === "archived") {
      throw new ApiError(409, "plan_archived", "This plan is archived; make it active before approving");
    }
    const draft = await versionWith(tx, id, "draft");
    if (!draft) throw new ApiError(409, "no_draft", "This plan has no draft to approve");
    const ccps = await ccpsOf(tx, [draft.id]);
    if (ccps.length === 0) throw badRequest("A plan with no critical control points can't be approved");
    // Four-eyes, as for SOPs: not whoever last edited the draft, unless they are the only manager.
    const managers = audience(await memberAccess(tx, workspaceId), "haccp", "manage");
    if (!canApproveSopVersion({ submittedBy: draft.updatedBy, deciderId: actorId, managerIds: managers })) {
      throw new ApiError(
        403,
        "four_eyes",
        "You last edited this draft, so someone else with manage access must approve it",
      );
    }
    const now = new Date();
    const effectiveOn = input.effectiveOn ?? (await workspaceToday(tx, workspaceId, now));
    const reviewDueOn = input.reviewDueOn ?? defaultSopReviewDueOn(effectiveOn, plan.reviewIntervalMonths);
    if (reviewDueOn <= effectiveOn) throw badRequest("reviewDueOn must be after effectiveOn");

    const superseded = await tx
      .update(haccpPlanVersions)
      .set({ status: "superseded" })
      .where(and(liveVersions(id), eq(haccpPlanVersions.status, "approved")))
      .returning();
    const [approved] = await tx
      .update(haccpPlanVersions)
      .set({
        status: "approved",
        approvedAt: now,
        approvedBy: actorId,
        approvalNote: input.note ?? null,
        effectiveOn,
        reviewDueOn,
      })
      .where(eq(haccpPlanVersions.id, draft.id))
      .returning();
    const changes = [
      ...superseded.map((v) => change("haccp_plan_version", v)),
      change("haccp_plan_version", approved!),
    ];
    // Approving a version with a hazard analysis is a review of it: the hazard review date restarts.
    if ((await stepsOf(tx, [draft.id])).length > 0) {
      const hazardReviewDueOn = input.hazardReviewDueOn ?? defaultHazardReviewDueOn(effectiveOn, plan);
      if (hazardReviewDueOn <= effectiveOn) throw badRequest("hazardReviewDueOn must be after effectiveOn");
      const [updated] = await tx
        .update(haccpPlans)
        .set({
          hazardReviewDueOn,
          hazardReviewedOn: await workspaceToday(tx, workspaceId, now),
          hazardReviewedBy: actorId,
          hazardReviewNote: `Approved with version ${draft.versionNumber}`,
        })
        .where(eq(haccpPlans.id, id))
        .returning();
      changes.push(change("haccp_plan", updated!));
    } else if (input.hazardReviewDueOn) {
      throw badRequest("This version has no hazard analysis, so there is no hazard review date to set");
    }
    await recordChanges(tx, workspaceId, actorId, changes);
    return approved!.id;
  });
  return getPlanVersion(db, workspaceId, id, versionId);
}

/** Soft delete; a plan that has ever been approved can only be archived (document control). */
export async function deletePlan(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findPlan(tx, workspaceId, id);
    const [released] = await tx
      .select({ id: haccpPlanVersions.id })
      .from(haccpPlanVersions)
      .where(and(liveVersions(id), inArray(haccpPlanVersions.status, ["approved", "superseded"])));
    if (released) {
      throw new ApiError(
        409,
        "plan_approved",
        "This plan has an approved version and can't be deleted; archive it instead",
      );
    }
    const changes = await removeDraft(tx, id);
    await tx.update(haccpPlans).set({ deletedAt: new Date() }).where(eq(haccpPlans.id, id));
    await recordChanges(tx, workspaceId, actorId, [
      ...changes,
      { entity: "haccp_plan", entityId: id, action: "delete" },
    ]);
  });
}

// ─── Monitoring logs ─────────────────────────────────────────────────────────

const readingOf = (input: { value?: number | undefined; passed?: boolean | undefined }): CcpReading =>
  input.value !== undefined ? { value: input.value } : { passed: input.passed! };

function evaluateFor(ccp: CcpRow, input: { value?: number | undefined; passed?: boolean | undefined }) {
  const result = evaluateReading(ccp, readingOf(input));
  if (!result) {
    throw badRequest(
      ccp.limitType === "pass_fail"
        ? `${ccp.code} is a pass/fail check: send passed, not a value`
        : `${ccp.code} is measured${ccp.limitUnit ? ` in ${ccp.limitUnit}` : ""}: send a value, not passed`,
    );
  }
  return result;
}

function checkedAtOf(value: string | undefined, now: Date) {
  if (!value) return now;
  const at = new Date(value);
  if (at.getTime() > now.getTime() + FUTURE_SKEW_MS) throw badRequest("A check can't be dated in the future");
  return at;
}

/** A CCP with the version and plan it belongs to. */
async function findCcp(db: Executor, workspaceId: string, ccpId: string) {
  const [row] = await db
    .select({ ccp: haccpCcps, version: haccpPlanVersions, plan: haccpPlans })
    .from(haccpCcps)
    .innerJoin(haccpPlanVersions, eq(haccpPlanVersions.id, haccpCcps.versionId))
    .innerJoin(haccpPlans, eq(haccpPlans.id, haccpPlanVersions.planId))
    .where(
      and(eq(haccpCcps.id, ccpId), eq(haccpCcps.workspaceId, workspaceId), isNull(haccpPlans.deletedAt)),
    );
  if (!row) throw notFound("CCP");
  return row;
}

/**
 * The review stamp a new reading starts with: a person's own entry is approved by them as they
 * make it; a token's waits for a person (`pending`, no reviewer yet).
 */
function reviewOnEntry(source: HaccpSource, actorId: string, at: Date) {
  const reviewStatus = initialReviewStatus(source);
  return reviewStatus === "approved"
    ? { reviewStatus, reviewedBy: actorId, reviewedAt: at }
    : { reviewStatus, reviewedBy: null, reviewedAt: null };
}

/** The corrective action an out-of-limit reading opens. */
function deviationAction(
  workspaceId: string,
  actorId: string,
  source: HaccpSource,
  ccp: CcpRow,
  log: LogRow,
  details: CcpLogCreateInput["correctiveAction"],
) {
  const reading = describeReading(ccp, log);
  return {
    workspaceId,
    title: `${ccp.code} ${ccp.processStep}: ${reading} (limit ${describeLimit(ccp)})`.slice(0, 200),
    logId: log.id,
    batchId: log.batchId,
    actionTaken: details?.actionTaken ?? null,
    rootCause: details?.rootCause ?? null,
    preventiveAction: details?.preventiveAction ?? null,
    source,
    raisedBy: actorId,
    updatedBy: actorId,
  };
}

/**
 * Records a CCP check against the CCP of the version of its plan in force on the day of the check. An out-of-limit
 * reading opens a corrective action in the same transaction, whoever recorded it: a deviation
 * never waits for review. `source` follows the credential (`api` for an API token: a sensor feed
 * or an agent). A person's reading is approved as they enter it (their entry is the attestation);
 * a token's is `pending` until a person with `manage` reviews it (`reviewLogs`).
 */
export async function recordLog(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: CcpLogCreateInput,
  options: { source: HaccpSource },
) {
  let notified: NotificationRow[] = [];
  const logId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const { ccp, version, plan } = await findCcp(tx, workspaceId, input.ccpId);
    if (plan.status === "archived") {
      throw new ApiError(409, "plan_archived", `HACCP plan ${plan.code} is archived`);
    }
    const now = new Date();
    const checkedAt = checkedAtOf(input.checkedAt, now);
    // The version in force on the day of the check, by effective date: one approved for a later
    // date isn't monitored against yet, and the one it will replace still is.
    const checkedOn = dateInZone(checkedAt, await workspaceTimeZone(tx, workspaceId));
    const inForce = versionInForce(await versionsOf(tx, [plan.id]), checkedOn);
    if (inForce?.id !== version.id) {
      throw new ApiError(
        409,
        "ccp_not_current",
        inForce
          ? `${ccp.code} is from version ${version.versionNumber} of ${plan.code}, but version ${inForce.versionNumber} is in force on ${checkedOn}; record against that version's CCP`
          : `${plan.code} has no version in force on ${checkedOn}`,
      );
    }
    const evaluation = evaluateFor(ccp, input);
    let batch: BatchRow | null = null;
    if (input.batchId) {
      batch = await findBatch(tx, workspaceId, input.batchId);
      if (batch.status !== "in_progress" && batch.status !== "completed") {
        throw new ApiError(
          409,
          "batch_not_running",
          `Batch ${batch.batchCode} is ${batch.status.replace("_", " ")}; checks are recorded against batches in progress or completed`,
        );
      }
      if (!scopeCoversBatch(scopeOf(version), batch)) {
        throw badRequest(`${plan.code} doesn't cover batch ${batch.batchCode}`);
      }
    }
    const [log] = await tx
      .insert(haccpCcpLogs)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        planId: plan.id,
        planVersionId: version.id,
        ccpId: ccp.id,
        ccpCode: ccp.code,
        batchId: batch?.id ?? null,
        value: input.value ?? null,
        passed: input.passed ?? null,
        withinLimits: evaluation.withinLimits,
        deviationReason: evaluation.reason,
        note: input.note ?? null,
        source: options.source,
        checkedAt,
        recordedBy: actorId,
        ...reviewOnEntry(options.source, actorId, now),
      })
      .returning();
    const changes: ChangeInput[] = [change("haccp_ccp_log", log!)];
    if (!evaluation.withinLimits) {
      const [action] = await tx
        .insert(haccpCorrectiveActions)
        .values(deviationAction(workspaceId, actorId, options.source, ccp, log!, input.correctiveAction))
        .returning();
      changes.push(change("haccp_corrective_action", action!));
      notified = await notifyReadingOutOfLimit(tx, workspaceId, actorId, "haccp", {
        id: log!.id,
        title: action!.title,
      });
    }
    await recordChanges(tx, workspaceId, actorId, changes);
    // A token's reading waits for a person; tell the managers (a deviation already told them).
    if (log!.reviewStatus === "pending") {
      notified = [
        ...notified,
        ...(await notifyReadingsAwaitingReview(tx, workspaceId, actorId, {
          id: log!.id,
          ccpCode: log!.ccpCode,
        })),
      ];
    }
    return log!.id;
  });
  void deliverNotifications(db, notified);
  return getLog(db, workspaceId, logId);
}

/**
 * Corrects a reading: a new log with the right reading, pinned to the same CCP, batch and time,
 * pointing at the one it corrects. A signed-in person only (the route); correcting an out-of-limit
 * reading also needs `manage`, so a deviation can't be quietly written away. A correction that is
 * out of limits opens a corrective action unless a reading it replaces already had one: the
 * reading it corrects, or any earlier one in the chain of corrections back to the original. A new
 * corrective action notifies managers (`reading_out_of_limit`), emailed after commit, as `recordLog`.
 *
 * Any reading may be corrected, whatever its review status. The correction is a person's own
 * entry, so it is approved as written. A pending reading that is corrected keeps its `pending`
 * stamp but no longer counts and leaves the review queue (`awaitsReview`): the correction replaced
 * it, and it can't be reviewed afterwards.
 */
export async function correctLog(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: CcpLogCorrectInput,
  options: { canManage: boolean },
) {
  let notified: NotificationRow[] = [];
  const logId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [original] = await tx
      .select()
      .from(haccpCcpLogs)
      .where(and(eq(haccpCcpLogs.id, id), eq(haccpCcpLogs.workspaceId, workspaceId)));
    if (!original) throw notFound("CCP log");
    const [already] = await tx
      .select({ id: haccpCcpLogs.id })
      .from(haccpCcpLogs)
      .where(eq(haccpCcpLogs.correctsLogId, id));
    if (already) throw new ApiError(409, "already_corrected", "This reading has already been corrected");
    if (!original.withinLimits && !options.canManage) {
      throw new ApiError(
        403,
        "module_forbidden",
        "Correcting an out-of-limit reading needs manage access to the haccp module",
      );
    }
    const { ccp } = await findCcp(tx, workspaceId, original.ccpId);
    const evaluation = evaluateFor(ccp, input);
    const [log] = await tx
      .insert(haccpCcpLogs)
      .values({
        workspaceId,
        planId: original.planId,
        planVersionId: original.planVersionId,
        ccpId: original.ccpId,
        ccpCode: original.ccpCode,
        batchId: original.batchId,
        value: input.value ?? null,
        passed: input.passed ?? null,
        withinLimits: evaluation.withinLimits,
        deviationReason: evaluation.reason,
        note: input.note ?? null,
        source: "manual",
        checkedAt: original.checkedAt,
        recordedBy: actorId,
        correctsLogId: original.id,
        correctionReason: input.reason,
        ...reviewOnEntry("manual", actorId, new Date()),
      })
      .returning();
    const changes: ChangeInput[] = [change("haccp_ccp_log", log!)];
    if (!evaluation.withinLimits) {
      // The deviation's action may hang off any reading in the chain of corrections (a correction
      // of a correction): walk back to the original reading. Only an open action carries over: a
      // closed one dealt with the earlier excursion, so a reading still out of limits opens a new one.
      const chain = [original.id];
      for (let previous = original.correctsLogId; previous;) {
        chain.push(previous);
        const [row] = await tx
          .select({ correctsLogId: haccpCcpLogs.correctsLogId })
          .from(haccpCcpLogs)
          .where(eq(haccpCcpLogs.id, previous));
        previous = row?.correctsLogId ?? null;
      }
      const [existing] = await tx
        .select({ id: haccpCorrectiveActions.id })
        .from(haccpCorrectiveActions)
        .where(and(inArray(haccpCorrectiveActions.logId, chain), eq(haccpCorrectiveActions.status, "open")))
        .limit(1);
      if (!existing) {
        const [action] = await tx
          .insert(haccpCorrectiveActions)
          .values(deviationAction(workspaceId, actorId, "manual", ccp, log!, undefined))
          .returning();
        changes.push(change("haccp_corrective_action", action!));
        // A new deviation (the reading corrected was within limits, or its action was closed):
        // managers hear about it as they do about a reading recorded out of limits.
        notified = await notifyReadingOutOfLimit(tx, workspaceId, actorId, "haccp", {
          id: log!.id,
          title: action!.title,
        });
      }
    }
    await recordChanges(tx, workspaceId, actorId, changes);
    return log!.id;
  });
  void deliverNotifications(db, notified);
  return getLog(db, workspaceId, logId);
}

/** Logs with their CCP, plan, batch, who recorded them, what corrected them and their corrective actions. */
async function describeLogs(db: Executor, rows: LogRow[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [ccps, plans, batches, corrections, actions, names] = await Promise.all([
    db
      .select()
      .from(haccpCcps)
      .where(inArray(haccpCcps.id, [...new Set(rows.map((r) => r.ccpId))])),
    db
      .select({ id: haccpPlans.id, code: haccpPlans.code, name: haccpPlans.name })
      .from(haccpPlans)
      .where(inArray(haccpPlans.id, [...new Set(rows.map((r) => r.planId))])),
    (() => {
      const batchIds = [...new Set(rows.map((r) => r.batchId).filter((b): b is string => !!b))];
      return batchIds.length
        ? db
            .select({ id: productionBatches.id, batchCode: productionBatches.batchCode })
            .from(productionBatches)
            .where(inArray(productionBatches.id, batchIds))
        : Promise.resolve([] as { id: string; batchCode: string }[]);
    })(),
    db
      .select({ id: haccpCcpLogs.id, correctsLogId: haccpCcpLogs.correctsLogId })
      .from(haccpCcpLogs)
      .where(inArray(haccpCcpLogs.correctsLogId, ids)),
    db
      .select({
        id: haccpCorrectiveActions.id,
        logId: haccpCorrectiveActions.logId,
        title: haccpCorrectiveActions.title,
        status: haccpCorrectiveActions.status,
      })
      .from(haccpCorrectiveActions)
      .where(and(inArray(haccpCorrectiveActions.logId, ids), isNull(haccpCorrectiveActions.deletedAt))),
    userNames(
      db,
      rows.flatMap((r) => [r.recordedBy, r.reviewedBy]),
    ),
  ]);
  const ccpById = new Map(ccps.map((c) => [c.id, c]));
  const planById = new Map(plans.map((p) => [p.id, p]));
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const correctedBy = new Map(corrections.map((c) => [c.correctsLogId!, c.id]));
  return rows.map((row) => {
    const ccp = ccpById.get(row.ccpId)!;
    return {
      ...strip(row),
      recordedByName: nameOf(names, row.recordedBy),
      reviewedByName: nameOf(names, row.reviewedBy),
      readingText: describeReading(ccp, row),
      ccp: {
        id: ccp.id,
        code: ccp.code,
        processStep: ccp.processStep,
        hazardType: ccp.hazardType,
        limitType: ccp.limitType,
        limitMin: ccp.limitMin,
        limitMax: ccp.limitMax,
        limitUnit: ccp.limitUnit,
        passCriterion: ccp.passCriterion,
        limitText: describeLimit(ccp),
        monitoringMethod: ccp.monitoringMethod,
        correctiveAction: ccp.correctiveAction,
        frequency: { every: ccp.frequencyEvery, unit: ccp.frequencyUnit },
      },
      plan: planById.get(row.planId) ?? null,
      batch: row.batchId ? (batchById.get(row.batchId) ?? null) : null,
      /** The log that corrected this one, if any: this reading no longer counts. */
      correctedByLogId: correctedBy.get(row.id) ?? null,
      correctiveActions: actions.filter((a) => a.logId === row.id).map(({ logId: _l, ...a }) => a),
    };
  });
}

export async function getLog(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(haccpCcpLogs)
    .where(and(eq(haccpCcpLogs.id, id), eq(haccpCcpLogs.workspaceId, workspaceId)));
  if (!row) throw notFound("CCP log");
  return (await describeLogs(db, [row]))[0]!;
}

const notCorrected = sql`not exists (select 1 from ${haccpCcpLogs} c where c.corrects_log_id = ${haccpCcpLogs.id})`;

/** CCP logs, newest check first. */
export async function listLogs(db: Database, workspaceId: string, query: CcpLogListQuery) {
  const where: (SQL | undefined)[] = [eq(haccpCcpLogs.workspaceId, workspaceId)];
  if (query.planId) where.push(eq(haccpCcpLogs.planId, query.planId));
  if (query.ccpCode) where.push(sql`lower(${haccpCcpLogs.ccpCode}) = lower(${query.ccpCode})`);
  if (query.batchId) where.push(eq(haccpCcpLogs.batchId, query.batchId));
  // `from` and `to` are inclusive local dates in the workspace's time zone.
  const zone = query.from || query.to ? await workspaceTimeZone(db, workspaceId) : null;
  if (query.from) where.push(gte(haccpCcpLogs.checkedAt, startOfDayInZone(query.from, zone!)));
  if (query.to) where.push(lt(haccpCcpLogs.checkedAt, endOfDayInZone(query.to, zone!)));
  if (query.outOfLimits !== undefined) where.push(eq(haccpCcpLogs.withinLimits, !query.outOfLimits));
  if (query.source) where.push(eq(haccpCcpLogs.source, query.source));
  if (query.review) where.push(eq(haccpCcpLogs.reviewStatus, query.review));
  if (!query.includeCorrected) where.push(notCorrected);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(haccpCcpLogs)
      .where(and(...where))
      .orderBy(desc(haccpCcpLogs.checkedAt), desc(haccpCcpLogs.createdAt), desc(haccpCcpLogs.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(haccpCcpLogs)
      .where(and(...where)),
  ]);
  return {
    logs: await describeLogs(db, rows),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

/** Readings waiting for a person's review: pending and not replaced by a correction. */
const awaitingReviewWhere = (workspaceId: string) =>
  and(eq(haccpCcpLogs.workspaceId, workspaceId), eq(haccpCcpLogs.reviewStatus, "pending"), notCorrected);

async function countAwaitingReview(db: Executor, workspaceId: string) {
  const [row] = await db.select({ n: count() }).from(haccpCcpLogs).where(awaitingReviewWhere(workspaceId));
  return row?.n ?? 0;
}

/**
 * Reviews readings an API token recorded: a person with `manage` (checked by the route) approves
 * or rejects them, recording who, when and the note (required to reject). All of them or none:
 * every reading must exist, be `pending` and not have been corrected. The stamp is the only change
 * a log ever takes. A rejected reading no longer counts as done, so the check is due again; a
 * corrective action it opened stays open for a person to close (the deviation may still be real).
 */
export async function reviewLogs(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: CcpLogBulkReviewInput,
) {
  const ids = [...new Set(input.ids)];
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const rows = await tx
      .select()
      .from(haccpCcpLogs)
      .where(and(eq(haccpCcpLogs.workspaceId, workspaceId), inArray(haccpCcpLogs.id, ids)));
    if (rows.length !== ids.length) throw notFound("CCP log");
    const reviewed = rows.filter((r) => r.reviewStatus !== "pending");
    if (reviewed.length) {
      const first = reviewed[0]!;
      throw new ApiError(
        409,
        "already_reviewed",
        `The ${first.ccpCode} reading is already ${ccpLogReviewStatusLabels[first.reviewStatus].toLowerCase()}; nothing was reviewed`,
        { ids: reviewed.map((r) => r.id) },
      );
    }
    const corrected = await tx
      .select({ correctsLogId: haccpCcpLogs.correctsLogId })
      .from(haccpCcpLogs)
      .where(inArray(haccpCcpLogs.correctsLogId, ids));
    if (corrected.length) {
      throw new ApiError(
        409,
        "already_corrected",
        "A correction has replaced this reading, so there is nothing to review; nothing was reviewed",
        { ids: corrected.map((r) => r.correctsLogId) },
      );
    }
    const updated = await tx
      .update(haccpCcpLogs)
      .set({
        reviewStatus: reviewStatusFor(input.decision),
        reviewedBy: actorId,
        reviewedAt: new Date(),
        reviewNote: input.note ?? null,
      })
      .where(and(inArray(haccpCcpLogs.id, ids), eq(haccpCcpLogs.reviewStatus, "pending")))
      .returning();
    if (updated.length !== ids.length) {
      throw new ApiError(409, "already_reviewed", "Someone else reviewed these readings first");
    }
    await recordChanges(
      tx,
      workspaceId,
      actorId,
      updated.map((row) => change("haccp_ccp_log", row)),
    );
  });
  const rows = await db
    .select()
    .from(haccpCcpLogs)
    .where(and(eq(haccpCcpLogs.workspaceId, workspaceId), inArray(haccpCcpLogs.id, ids)))
    .orderBy(desc(haccpCcpLogs.checkedAt), desc(haccpCcpLogs.id));
  return { logs: await describeLogs(db, rows), reviewed: rows.length };
}

/** Reviews one reading an API token recorded (see `reviewLogs`). */
export async function reviewLog(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: CcpLogReviewInput,
) {
  await reviewLogs(db, workspaceId, actorId, { ...input, ids: [id] });
  return getLog(db, workspaceId, id);
}

// ─── Deviations and corrective actions ───────────────────────────────────────

const openActionExists = sql`exists (select 1 from ${haccpCorrectiveActions} ca
  where ca.log_id = ${haccpCcpLogs.id} and ca.status = 'open' and ca.deleted_at is null)`;

/**
 * Out-of-limit readings, newest first, each with its corrective actions. `open`: a corrective
 * action is still open; `closed`: none is.
 */
export async function listDeviations(db: Database, workspaceId: string, query: DeviationListQuery) {
  const where: (SQL | undefined)[] = [
    eq(haccpCcpLogs.workspaceId, workspaceId),
    eq(haccpCcpLogs.withinLimits, false),
  ];
  if (query.batchId) where.push(eq(haccpCcpLogs.batchId, query.batchId));
  if (query.planId) where.push(eq(haccpCcpLogs.planId, query.planId));
  if (query.status === "open") where.push(openActionExists);
  if (query.status === "closed") where.push(sql`not ${openActionExists}`);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(haccpCcpLogs)
      .where(and(...where))
      .orderBy(desc(haccpCcpLogs.checkedAt), desc(haccpCcpLogs.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(haccpCcpLogs)
      .where(and(...where)),
  ]);
  const logs = await describeLogs(db, rows);
  return {
    deviations: logs.map((log) => ({ ...log, open: log.correctiveActions.some((a) => a.status === "open") })),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

async function findAction(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(haccpCorrectiveActions)
    .where(
      and(
        eq(haccpCorrectiveActions.id, id),
        eq(haccpCorrectiveActions.workspaceId, workspaceId),
        isNull(haccpCorrectiveActions.deletedAt),
      ),
    );
  if (!row) throw notFound("Corrective action");
  return row;
}

async function describeActions(db: Executor, rows: ActionRow[]) {
  if (rows.length === 0) return [];
  const logIds = [...new Set(rows.map((r) => r.logId).filter((v): v is string => !!v))];
  const calibrationIds = [...new Set(rows.map((r) => r.calibrationId).filter((v): v is string => !!v))];
  const batchIds = [...new Set(rows.map((r) => r.batchId).filter((v): v is string => !!v))];
  const lotIds = [...new Set(rows.map((r) => r.lotId).filter((v): v is string => !!v))];
  const [logRows, calibrations, batches, lots, names] = await Promise.all([
    logIds.length ? db.select().from(haccpCcpLogs).where(inArray(haccpCcpLogs.id, logIds)) : [],
    calibrationIds.length
      ? db
          .select({
            record: haccpCalibrationRecords,
            assetName: haccpAssets.name,
            assetCode: haccpAssets.code,
          })
          .from(haccpCalibrationRecords)
          .innerJoin(haccpAssets, eq(haccpAssets.id, haccpCalibrationRecords.assetId))
          .where(inArray(haccpCalibrationRecords.id, calibrationIds))
      : [],
    batchIds.length
      ? db
          .select({
            id: productionBatches.id,
            batchCode: productionBatches.batchCode,
            status: productionBatches.status,
          })
          .from(productionBatches)
          .where(inArray(productionBatches.id, batchIds))
      : [],
    lotIds.length
      ? db
          .select({
            id: stockLots.id,
            lotCode: stockLots.lotCode,
            status: stockLots.status,
            itemCode: items.code,
          })
          .from(stockLots)
          .innerJoin(items, eq(items.id, stockLots.itemId))
          .where(inArray(stockLots.id, lotIds))
      : [],
    userNames(
      db,
      rows.flatMap((r) => [r.raisedBy, r.closedBy, r.updatedBy]),
    ),
  ]);
  const logs = new Map((await describeLogs(db, logRows)).map((l) => [l.id, l]));
  const calibrationById = new Map(calibrations.map((c) => [c.record.id, c]));
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const lotById = new Map(lots.map((l) => [l.id, l]));
  return rows.map((row) => {
    const calibration = row.calibrationId ? calibrationById.get(row.calibrationId) : undefined;
    const log = row.logId ? logs.get(row.logId) : undefined;
    return {
      ...stripSoft(row),
      raisedByName: nameOf(names, row.raisedBy),
      closedByName: nameOf(names, row.closedBy),
      updatedByName: nameOf(names, row.updatedBy),
      log: log
        ? {
            id: log.id,
            ccp: log.ccp,
            plan: log.plan,
            readingText: log.readingText,
            deviationReason: log.deviationReason,
            checkedAt: log.checkedAt,
            recordedByName: log.recordedByName,
            source: log.source,
            reviewStatus: log.reviewStatus,
            reviewNote: log.reviewNote,
            correctedByLogId: log.correctedByLogId,
          }
        : null,
      calibration: calibration
        ? {
            id: calibration.record.id,
            asset: {
              id: calibration.record.assetId,
              name: calibration.assetName,
              code: calibration.assetCode,
            },
            referenceReading: calibration.record.referenceReading,
            actualReading: calibration.record.actualReading,
            unit: calibration.record.unit,
            calibratedAt: calibration.record.calibratedAt,
          }
        : null,
      batch: row.batchId ? (batchById.get(row.batchId) ?? null) : null,
      lot: row.lotId ? (lotById.get(row.lotId) ?? null) : null,
      /** What is still missing before it can be closed. */
      missing: missingForClose(row),
    };
  });
}

const missingForClose = (row: Pick<ActionRow, "actionTaken" | "rootCause" | "preventiveAction">) =>
  (
    [
      ["actionTaken", row.actionTaken],
      ["rootCause", row.rootCause],
      ["preventiveAction", row.preventiveAction],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([field]) => field);

export async function getCorrectiveAction(db: Executor, workspaceId: string, id: string) {
  return (await describeActions(db, [await findAction(db, workspaceId, id)]))[0]!;
}

export async function listCorrectiveActions(
  db: Database,
  workspaceId: string,
  query: CorrectiveActionListQuery,
) {
  const where: (SQL | undefined)[] = [
    eq(haccpCorrectiveActions.workspaceId, workspaceId),
    isNull(haccpCorrectiveActions.deletedAt),
  ];
  if (query.status !== "all") where.push(eq(haccpCorrectiveActions.status, query.status));
  if (query.batchId) where.push(eq(haccpCorrectiveActions.batchId, query.batchId));
  if (query.logId) where.push(eq(haccpCorrectiveActions.logId, query.logId));
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(haccpCorrectiveActions)
      .where(and(...where))
      // Open first, then newest.
      .orderBy(desc(sql`${haccpCorrectiveActions.status} = 'open'`), desc(haccpCorrectiveActions.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(haccpCorrectiveActions)
      .where(and(...where)),
  ]);
  return {
    correctiveActions: await describeActions(db, rows),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

async function assertLinks(
  tx: Executor,
  workspaceId: string,
  links: { batchId?: string | null | undefined; lotId?: string | null | undefined },
) {
  if (links.batchId) await findBatch(tx, workspaceId, links.batchId);
  if (links.lotId) {
    const [lot] = await tx
      .select({ id: stockLots.id })
      .from(stockLots)
      .where(
        and(
          eq(stockLots.id, links.lotId),
          eq(stockLots.workspaceId, workspaceId),
          isNull(stockLots.deletedAt),
        ),
      );
    if (!lot) throw notFound("Lot");
  }
}

/**
 * Raises a corrective action (or, from an API token, proposes one: `source` is `api`). Out-of-limit
 * readings and failed calibrations already open one; this is for anything else.
 */
export async function createCorrectiveAction(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: CorrectiveActionCreateInput,
  options: { source: HaccpSource },
) {
  let notified: NotificationRow[] = [];
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    let batchId = input.batchId ?? null;
    if (input.logId) {
      const [log] = await tx
        .select()
        .from(haccpCcpLogs)
        .where(and(eq(haccpCcpLogs.id, input.logId), eq(haccpCcpLogs.workspaceId, workspaceId)));
      if (!log) throw notFound("CCP log");
      if (log.withinLimits)
        throw badRequest("That reading was within its limits; there is no deviation to act on");
      batchId ??= log.batchId;
    }
    if (input.calibrationId) {
      const [record] = await tx
        .select({ id: haccpCalibrationRecords.id })
        .from(haccpCalibrationRecords)
        .where(
          and(
            eq(haccpCalibrationRecords.id, input.calibrationId),
            eq(haccpCalibrationRecords.workspaceId, workspaceId),
          ),
        );
      if (!record) throw notFound("Calibration record");
    }
    await assertLinks(tx, workspaceId, { batchId, lotId: input.lotId });
    const [row] = await tx
      .insert(haccpCorrectiveActions)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        title: input.title,
        logId: input.logId ?? null,
        calibrationId: input.calibrationId ?? null,
        batchId,
        lotId: input.lotId ?? null,
        actionTaken: input.actionTaken ?? null,
        rootCause: input.rootCause ?? null,
        preventiveAction: input.preventiveAction ?? null,
        source: options.source,
        raisedBy: actorId,
        updatedBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_corrective_action", row!)]);
    // One that answers a reading was announced with the reading (`recordLog`).
    if (!input.logId) {
      notified = await notifyDeviationRecorded(tx, workspaceId, actorId, { id: row!.id, title: row!.title });
    }
    return row!.id;
  });
  void deliverNotifications(db, notified);
  return getCorrectiveAction(db, workspaceId, id);
}

function assertOpen(row: ActionRow) {
  if (row.status !== "open") {
    throw new ApiError(409, "corrective_action_closed", "This corrective action is closed and can't change");
  }
}

export async function updateCorrectiveAction(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: CorrectiveActionUpdateInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    assertOpen(await findAction(tx, workspaceId, id));
    await assertLinks(tx, workspaceId, patch);
    const [row] = await tx
      .update(haccpCorrectiveActions)
      .set({ ...patch, updatedBy: actorId })
      .where(eq(haccpCorrectiveActions.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_corrective_action", row!)]);
  });
  return getCorrectiveAction(db, workspaceId, id);
}

/**
 * Closes a corrective action: the sign-off. The route needs `manage` and a signed-in person. What
 * was done, the root cause and the preventive action must be on record.
 */
export async function closeCorrectiveAction(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: CorrectiveActionCloseInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const action = await findAction(tx, workspaceId, id);
    assertOpen(action);
    const missing = missingForClose(action);
    if (missing.length) {
      throw new ApiError(
        409,
        "corrective_action_incomplete",
        "Record what was done, the root cause and the preventive action before closing",
        { missing },
      );
    }
    const [row] = await tx
      .update(haccpCorrectiveActions)
      .set({ status: "closed", closedAt: new Date(), closedBy: actorId, closureNote: input.note ?? null })
      .where(eq(haccpCorrectiveActions.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_corrective_action", row!)]);
  });
  return getCorrectiveAction(db, workspaceId, id);
}

// ─── Areas and equipment ─────────────────────────────────────────────────────

async function findAsset(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(haccpAssets)
    .where(
      and(eq(haccpAssets.id, id), eq(haccpAssets.workspaceId, workspaceId), isNull(haccpAssets.deletedAt)),
    );
  if (!row) throw notFound("Area or equipment");
  return row;
}

async function assertAssetCodeFree(tx: Executor, workspaceId: string, code: string, exceptId?: string) {
  const [taken] = await tx
    .select({ id: haccpAssets.id })
    .from(haccpAssets)
    .where(
      and(
        eq(haccpAssets.workspaceId, workspaceId),
        isNull(haccpAssets.deletedAt),
        sql`lower(${haccpAssets.code}) = lower(${code})`,
        exceptId ? ne(haccpAssets.id, exceptId) : undefined,
      ),
    );
  if (taken)
    throw new ApiError(409, "code_taken", `Another area or piece of equipment uses the code "${code}"`);
}

const frequencyColumns = (
  prefix: "cleaning" | "calibration",
  frequency: { every: number; unit: ScheduleFrequencyUnit } | null | undefined,
) =>
  frequency === undefined
    ? {}
    : { [`${prefix}Every`]: frequency?.every ?? null, [`${prefix}Unit`]: frequency?.unit ?? null };

export async function listAssets(db: Database, workspaceId: string, query: HaccpAssetListQuery) {
  const where: (SQL | undefined)[] = [
    eq(haccpAssets.workspaceId, workspaceId),
    isNull(haccpAssets.deletedAt),
  ];
  if (query.kind) where.push(eq(haccpAssets.kind, query.kind));
  if (query.status !== "all") where.push(eq(haccpAssets.status, query.status));
  const rows = await db
    .select()
    .from(haccpAssets)
    .where(and(...where))
    .orderBy(asc(haccpAssets.name), asc(haccpAssets.id));
  return { assets: rows.map(serializeAsset) };
}

export async function createAsset(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: HaccpAssetCreateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (input.code) await assertAssetCodeFree(tx, workspaceId, input.code);
    const { cleaningFrequency, calibrationFrequency, id, ...fields } = input;
    const [row] = await tx
      .insert(haccpAssets)
      .values({
        ...(id ? { id } : {}),
        ...fields,
        ...frequencyColumns("cleaning", cleaningFrequency),
        ...frequencyColumns("calibration", calibrationFrequency),
        workspaceId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_asset", row!)]);
    return serializeAsset(row!);
  });
}

export async function updateAsset(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: HaccpAssetUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const asset = await findAsset(tx, workspaceId, id);
    if (patch.code) await assertAssetCodeFree(tx, workspaceId, patch.code, id);
    const kind = patch.kind ?? asset.kind;
    const calibrated =
      patch.calibrationFrequency !== undefined ? patch.calibrationFrequency : asset.calibrationEvery;
    if (kind === "area" && calibrated) throw badRequest("Only equipment is calibrated");
    const { cleaningFrequency, calibrationFrequency, ...fields } = patch;
    const [row] = await tx
      .update(haccpAssets)
      .set({
        ...fields,
        ...frequencyColumns("cleaning", cleaningFrequency),
        ...frequencyColumns("calibration", calibrationFrequency),
      })
      .where(eq(haccpAssets.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_asset", row!)]);
    return serializeAsset(row!);
  });
}

function assertActiveAsset(asset: AssetRow) {
  if (asset.status === "archived") {
    throw new ApiError(
      409,
      "asset_archived",
      `${asset.name} is archived; nothing more is recorded against it`,
    );
  }
}

// ─── Cleaning records ────────────────────────────────────────────────────────

async function assertMember(tx: Executor, workspaceId: string, userId: string) {
  const [member] = await tx
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  if (!member) throw badRequest("doneBy must be a member of this workspace");
}

const notCorrectedCleaning = sql`not exists (select 1 from ${haccpCleaningRecords} c where c.corrects_record_id = ${haccpCleaningRecords.id})`;
const notCorrectedCalibration = sql`not exists (select 1 from ${haccpCalibrationRecords} c where c.corrects_record_id = ${haccpCalibrationRecords.id})`;

async function describeCleaning(db: Executor, rows: { record: CleaningRow; asset: AssetRow }[]) {
  const ids = rows.map((r) => r.record.id);
  const [names, corrections] = await Promise.all([
    userNames(
      db,
      rows.flatMap(({ record }) => [record.doneBy, record.recordedBy, record.verifiedBy]),
    ),
    ids.length
      ? db
          .select({ id: haccpCleaningRecords.id, correctsRecordId: haccpCleaningRecords.correctsRecordId })
          .from(haccpCleaningRecords)
          .where(inArray(haccpCleaningRecords.correctsRecordId, ids))
      : [],
  ]);
  const correctedBy = new Map(corrections.map((c) => [c.correctsRecordId!, c.id]));
  return rows.map(({ record, asset }) => ({
    ...strip(record),
    /** The record that replaced this one: it no longer counts. */
    correctedByRecordId: correctedBy.get(record.id) ?? null,
    asset: { id: asset.id, kind: asset.kind, code: asset.code, name: asset.name },
    doneByName: nameOf(names, record.doneBy),
    recordedByName: nameOf(names, record.recordedBy),
    verifiedByName: nameOf(names, record.verifiedBy),
  }));
}

async function getCleaning(db: Executor, workspaceId: string, id: string) {
  const rows = await db
    .select({ record: haccpCleaningRecords, asset: haccpAssets })
    .from(haccpCleaningRecords)
    .innerJoin(haccpAssets, eq(haccpAssets.id, haccpCleaningRecords.assetId))
    .where(and(eq(haccpCleaningRecords.id, id), eq(haccpCleaningRecords.workspaceId, workspaceId)));
  if (!rows[0]) throw notFound("Cleaning record");
  return (await describeCleaning(db, rows))[0]!;
}

export async function listCleaning(db: Database, workspaceId: string, query: HaccpRecordListQuery) {
  const where: (SQL | undefined)[] = [eq(haccpCleaningRecords.workspaceId, workspaceId)];
  if (query.assetId) where.push(eq(haccpCleaningRecords.assetId, query.assetId));
  // `from` and `to` are inclusive local dates in the workspace's time zone.
  const zone = query.from || query.to ? await workspaceTimeZone(db, workspaceId) : null;
  if (query.from) where.push(gte(haccpCleaningRecords.cleanedAt, startOfDayInZone(query.from, zone!)));
  if (query.to) where.push(lt(haccpCleaningRecords.cleanedAt, endOfDayInZone(query.to, zone!)));
  const [rows, [total]] = await Promise.all([
    db
      .select({ record: haccpCleaningRecords, asset: haccpAssets })
      .from(haccpCleaningRecords)
      .innerJoin(haccpAssets, eq(haccpAssets.id, haccpCleaningRecords.assetId))
      .where(and(...where))
      .orderBy(desc(haccpCleaningRecords.cleanedAt), desc(haccpCleaningRecords.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(haccpCleaningRecords)
      .where(and(...where)),
  ]);
  return {
    records: await describeCleaning(db, rows),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

/** Records a cleaning (a person's attestation; the route refuses tokens). */
export async function recordCleaning(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: CleaningRecordCreateInput,
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const asset = await findAsset(tx, workspaceId, input.assetId);
    assertActiveAsset(asset);
    const doneBy = input.doneBy ?? actorId;
    if (doneBy !== actorId) await assertMember(tx, workspaceId, doneBy);
    const [row] = await tx
      .insert(haccpCleaningRecords)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        assetId: asset.id,
        cleanedAt: checkedAtOf(input.cleanedAt, new Date()),
        doneBy,
        recordedBy: actorId,
        note: input.note ?? null,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_cleaning_record", row!)]);
    return row!.id;
  });
  return getCleaning(db, workspaceId, id);
}

/** Verifies a cleaning: once, by someone other than whoever did it. */
export async function verifyCleaning(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: CleaningVerifyInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [record] = await tx
      .select()
      .from(haccpCleaningRecords)
      .where(and(eq(haccpCleaningRecords.id, id), eq(haccpCleaningRecords.workspaceId, workspaceId)));
    if (!record) throw notFound("Cleaning record");
    if (record.verifiedAt)
      throw new ApiError(409, "already_verified", "This cleaning has already been verified");
    const [replaced] = await tx
      .select({ id: haccpCleaningRecords.id })
      .from(haccpCleaningRecords)
      .where(eq(haccpCleaningRecords.correctsRecordId, id));
    if (replaced) {
      throw new ApiError(409, "already_corrected", "A correction replaces this cleaning record: verify that");
    }
    if (record.doneBy === actorId) {
      throw new ApiError(403, "four_eyes", "Someone other than the person who cleaned must verify it");
    }
    const [row] = await tx
      .update(haccpCleaningRecords)
      .set({ verifiedAt: new Date(), verifiedBy: actorId, verificationNote: input.note ?? null })
      .where(and(eq(haccpCleaningRecords.id, id), isNull(haccpCleaningRecords.verifiedAt)))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_cleaning_record", row!)]);
  });
  return getCleaning(db, workspaceId, id);
}

/**
 * Corrects a cleaning record: a new record that points at the one it replaces, with the reason.
 * What isn't given is copied. The original stays and no longer counts for what's due; the
 * correction starts unverified. A signed-in person's act (the route refuses tokens).
 */
export async function correctCleaning(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: CleaningCorrectInput,
) {
  const newId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [original] = await tx
      .select()
      .from(haccpCleaningRecords)
      .where(and(eq(haccpCleaningRecords.id, id), eq(haccpCleaningRecords.workspaceId, workspaceId)));
    if (!original) throw notFound("Cleaning record");
    const [already] = await tx
      .select({ id: haccpCleaningRecords.id })
      .from(haccpCleaningRecords)
      .where(eq(haccpCleaningRecords.correctsRecordId, id));
    if (already)
      throw new ApiError(409, "already_corrected", "This cleaning record has already been corrected");
    const asset = await findAsset(tx, workspaceId, input.assetId ?? original.assetId);
    if (asset.id !== original.assetId) assertActiveAsset(asset);
    const doneBy = input.doneBy ?? original.doneBy;
    if (doneBy && doneBy !== actorId && doneBy !== original.doneBy)
      await assertMember(tx, workspaceId, doneBy);
    const [row] = await tx
      .insert(haccpCleaningRecords)
      .values({
        workspaceId,
        assetId: asset.id,
        cleanedAt: input.cleanedAt ? checkedAtOf(input.cleanedAt, new Date()) : original.cleanedAt,
        doneBy,
        recordedBy: actorId,
        note: input.note === undefined ? original.note : input.note,
        correctsRecordId: original.id,
        correctionReason: input.reason,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_cleaning_record", row!)]);
    return row!.id;
  });
  return getCleaning(db, workspaceId, newId);
}

// ─── Calibration records ─────────────────────────────────────────────────────

async function describeCalibration(db: Executor, rows: { record: CalibrationRow; asset: AssetRow }[]) {
  const ids = rows.map((r) => r.record.id);
  const [names, actions, corrections] = await Promise.all([
    userNames(
      db,
      rows.map((r) => r.record.recordedBy),
    ),
    ids.length
      ? db
          .select({
            id: haccpCorrectiveActions.id,
            calibrationId: haccpCorrectiveActions.calibrationId,
            status: haccpCorrectiveActions.status,
          })
          .from(haccpCorrectiveActions)
          .where(inArray(haccpCorrectiveActions.calibrationId, ids))
      : [],
    ids.length
      ? db
          .select({
            id: haccpCalibrationRecords.id,
            correctsRecordId: haccpCalibrationRecords.correctsRecordId,
          })
          .from(haccpCalibrationRecords)
          .where(inArray(haccpCalibrationRecords.correctsRecordId, ids))
      : [],
  ]);
  const correctedBy = new Map(corrections.map((c) => [c.correctsRecordId!, c.id]));
  return rows.map(({ record, asset }) => ({
    ...strip(record),
    correctedByRecordId: correctedBy.get(record.id) ?? null,
    asset: { id: asset.id, kind: asset.kind, code: asset.code, name: asset.name },
    recordedByName: nameOf(names, record.recordedBy),
    correctiveActions: actions
      .filter((a) => a.calibrationId === record.id)
      .map(({ calibrationId: _c, ...a }) => a),
  }));
}

async function getCalibration(db: Executor, workspaceId: string, id: string) {
  const rows = await db
    .select({ record: haccpCalibrationRecords, asset: haccpAssets })
    .from(haccpCalibrationRecords)
    .innerJoin(haccpAssets, eq(haccpAssets.id, haccpCalibrationRecords.assetId))
    .where(and(eq(haccpCalibrationRecords.id, id), eq(haccpCalibrationRecords.workspaceId, workspaceId)));
  if (!rows[0]) throw notFound("Calibration record");
  return (await describeCalibration(db, rows))[0]!;
}

export async function listCalibration(db: Database, workspaceId: string, query: HaccpRecordListQuery) {
  const where: (SQL | undefined)[] = [eq(haccpCalibrationRecords.workspaceId, workspaceId)];
  if (query.assetId) where.push(eq(haccpCalibrationRecords.assetId, query.assetId));
  // `from` and `to` are inclusive local dates in the workspace's time zone.
  const zone = query.from || query.to ? await workspaceTimeZone(db, workspaceId) : null;
  if (query.from) where.push(gte(haccpCalibrationRecords.calibratedAt, startOfDayInZone(query.from, zone!)));
  if (query.to) where.push(lt(haccpCalibrationRecords.calibratedAt, endOfDayInZone(query.to, zone!)));
  const [rows, [total]] = await Promise.all([
    db
      .select({ record: haccpCalibrationRecords, asset: haccpAssets })
      .from(haccpCalibrationRecords)
      .innerJoin(haccpAssets, eq(haccpAssets.id, haccpCalibrationRecords.assetId))
      .where(and(...where))
      .orderBy(desc(haccpCalibrationRecords.calibratedAt), desc(haccpCalibrationRecords.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(haccpCalibrationRecords)
      .where(and(...where)),
  ]);
  return {
    records: await describeCalibration(db, rows),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

/**
 * Records a calibration check (a person's attestation; the route refuses tokens). Passes when the
 * reading is within the equipment's tolerance; a failure opens a corrective action (check what
 * was measured with the instrument since its last good calibration).
 */
export async function recordCalibration(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: CalibrationRecordCreateInput,
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const asset = await findAsset(tx, workspaceId, input.assetId);
    assertActiveAsset(asset);
    if (asset.kind !== "equipment")
      throw badRequest(`${asset.name} is an area; only equipment is calibrated`);
    const computed = calibrationPasses({
      referenceReading: input.referenceReading,
      actualReading: input.actualReading,
      tolerance: asset.calibrationTolerance,
    });
    if (computed !== null && input.passed !== undefined) {
      throw badRequest(`${asset.name} has a tolerance, so whether it passed is worked out from the readings`);
    }
    if (computed === null && input.passed === undefined) {
      throw badRequest(`${asset.name} has no tolerance set: say whether the calibration passed`);
    }
    const passed = computed ?? input.passed!;
    const calibratedAt = checkedAtOf(input.calibratedAt, new Date());
    const frequency = frequencyOf(asset.calibrationEvery, asset.calibrationUnit);
    const nextDueOn =
      input.nextDueOn ??
      (frequency
        ? addFrequencyToDate(dateInZone(calibratedAt, await workspaceTimeZone(tx, workspaceId)), frequency)
        : null);
    const [row] = await tx
      .insert(haccpCalibrationRecords)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        assetId: asset.id,
        calibratedAt,
        referenceReading: input.referenceReading,
        actualReading: input.actualReading,
        tolerance: asset.calibrationTolerance,
        unit: asset.measurementUnit,
        passed,
        method: input.method ?? null,
        nextDueOn,
        note: input.note ?? null,
        recordedBy: actorId,
      })
      .returning();
    const changes: ChangeInput[] = [change("haccp_calibration_record", row!)];
    if (!passed) {
      const unit = asset.measurementUnit ? ` ${asset.measurementUnit}` : "";
      const tolerance =
        asset.calibrationTolerance !== null ? `, tolerance ±${asset.calibrationTolerance}${unit}` : "";
      const [action] = await tx
        .insert(haccpCorrectiveActions)
        .values({
          workspaceId,
          title:
            `Calibration failed: ${asset.code ?? asset.name} read ${input.actualReading}${unit} against ${input.referenceReading}${unit}${tolerance}`.slice(
              0,
              200,
            ),
          calibrationId: row!.id,
          source: "manual",
          raisedBy: actorId,
          updatedBy: actorId,
        })
        .returning();
      changes.push(change("haccp_corrective_action", action!));
    }
    await recordChanges(tx, workspaceId, actorId, changes);
    return row!.id;
  });
  return getCalibration(db, workspaceId, id);
}

/**
 * Corrects a calibration record: a new record with the right readings, judged against the tolerance
 * the original was judged against, pointing at the original. Correcting a failed calibration (so
 * it passes) needs `manage`, like writing off an out-of-limit reading; the failure's corrective
 * action stays open for a manager to close. A correction that still fails reuses an open action
 * of the chain and otherwise opens one.
 */
export async function correctCalibration(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: CalibrationCorrectInput,
  options: { canManage: boolean },
) {
  const newId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [original] = await tx
      .select()
      .from(haccpCalibrationRecords)
      .where(and(eq(haccpCalibrationRecords.id, id), eq(haccpCalibrationRecords.workspaceId, workspaceId)));
    if (!original) throw notFound("Calibration record");
    const [already] = await tx
      .select({ id: haccpCalibrationRecords.id })
      .from(haccpCalibrationRecords)
      .where(eq(haccpCalibrationRecords.correctsRecordId, id));
    if (already)
      throw new ApiError(409, "already_corrected", "This calibration record has already been corrected");
    if (!original.passed && !options.canManage) {
      throw new ApiError(
        403,
        "module_forbidden",
        "Correcting a failed calibration needs manage access to the haccp module",
      );
    }
    const asset = await findAsset(tx, workspaceId, original.assetId);
    const referenceReading = input.referenceReading ?? original.referenceReading;
    const actualReading = input.actualReading ?? original.actualReading;
    const computed = calibrationPasses({ referenceReading, actualReading, tolerance: original.tolerance });
    if (computed !== null && input.passed !== undefined) {
      throw badRequest("The original had a tolerance, so whether it passed is worked out from the readings");
    }
    if (computed === null && input.passed === undefined) {
      throw badRequest("The original had no tolerance: say whether the corrected calibration passed");
    }
    const passed = computed ?? input.passed!;
    const calibratedAt = input.calibratedAt
      ? checkedAtOf(input.calibratedAt, new Date())
      : original.calibratedAt;
    const frequency = frequencyOf(asset.calibrationEvery, asset.calibrationUnit);
    const nextDueOn =
      input.nextDueOn ??
      (input.calibratedAt && frequency
        ? addFrequencyToDate(dateInZone(calibratedAt, await workspaceTimeZone(tx, workspaceId)), frequency)
        : original.nextDueOn);
    const [row] = await tx
      .insert(haccpCalibrationRecords)
      .values({
        workspaceId,
        assetId: original.assetId,
        calibratedAt,
        referenceReading,
        actualReading,
        tolerance: original.tolerance,
        unit: original.unit,
        passed,
        method: input.method === undefined ? original.method : input.method,
        nextDueOn,
        note: input.note === undefined ? original.note : input.note,
        recordedBy: actorId,
        correctsRecordId: original.id,
        correctionReason: input.reason,
      })
      .returning();
    const changes: ChangeInput[] = [change("haccp_calibration_record", row!)];
    if (!passed) {
      // Any open action in the chain of corrections back to the original carries over.
      const chain = [original.id];
      for (let previous = original.correctsRecordId; previous;) {
        chain.push(previous);
        const [prev] = await tx
          .select({ correctsRecordId: haccpCalibrationRecords.correctsRecordId })
          .from(haccpCalibrationRecords)
          .where(eq(haccpCalibrationRecords.id, previous));
        previous = prev?.correctsRecordId ?? null;
      }
      const [existing] = await tx
        .select({ id: haccpCorrectiveActions.id })
        .from(haccpCorrectiveActions)
        .where(
          and(
            inArray(haccpCorrectiveActions.calibrationId, chain),
            eq(haccpCorrectiveActions.status, "open"),
          ),
        )
        .limit(1);
      if (!existing) {
        const unit = original.unit ? ` ${original.unit}` : "";
        const [action] = await tx
          .insert(haccpCorrectiveActions)
          .values({
            workspaceId,
            title:
              `Calibration failed: ${asset.code ?? asset.name} read ${actualReading}${unit} against ${referenceReading}${unit}`.slice(
                0,
                200,
              ),
            calibrationId: row!.id,
            source: "manual",
            raisedBy: actorId,
            updatedBy: actorId,
          })
          .returning();
        changes.push(change("haccp_corrective_action", action!));
      }
    }
    await recordChanges(tx, workspaceId, actorId, changes);
    return row!.id;
  });
  return getCalibration(db, workspaceId, newId);
}

// ─── What's due ──────────────────────────────────────────────────────────────

type DueBatch = Pick<BatchRow, "id" | "batchCode" | "recipeId" | "outputItemId" | "plannedOn" | "startedAt">;

/** Active plans with the version in force on `on` (an ISO date) and its CCPs. */
async function currentPlans(db: Executor, workspaceId: string, on: string) {
  const plans = await db
    .select()
    .from(haccpPlans)
    .where(
      and(
        eq(haccpPlans.workspaceId, workspaceId),
        isNull(haccpPlans.deletedAt),
        eq(haccpPlans.status, "active"),
      ),
    )
    .orderBy(asc(haccpPlans.code));
  const versions = await versionsOf(
    db,
    plans.map((p) => p.id),
  );
  const rows = plans.flatMap((plan) => {
    const version = versionInForce(
      versions.filter((v) => v.planId === plan.id),
      on,
    );
    return version ? [{ plan, version }] : [];
  });
  const ccps = await ccpsOf(
    db,
    rows.map((r) => r.version.id),
  );
  return rows.map((r) => ({ ...r, ccps: ccps.filter((c) => c.versionId === r.version.id) }));
}

async function batchesInProgress(db: Executor, workspaceId: string): Promise<DueBatch[]> {
  return db
    .select({
      id: productionBatches.id,
      batchCode: productionBatches.batchCode,
      recipeId: productionBatches.recipeId,
      outputItemId: productionBatches.outputItemId,
      plannedOn: productionBatches.plannedOn,
      startedAt: productionBatches.startedAt,
    })
    .from(productionBatches)
    .where(
      and(
        eq(productionBatches.workspaceId, workspaceId),
        isNull(productionBatches.deletedAt),
        eq(productionBatches.status, "in_progress"),
      ),
    )
    .orderBy(asc(productionBatches.plannedOn), asc(productionBatches.batchCode));
}

interface DueCheckBase extends DueResult {
  /** Stable key: `ccp:<ccpId>[:<batchId>]`, `cleaning:<assetId>`, `calibration:<assetId>`. */
  key: string;
  label: string;
  frequencyText: string;
  lastAt: string | null;
}
interface CcpDueCheck extends DueCheckBase {
  kind: "ccp";
  plan: { id: string; code: string; name: string; versionNumber: number };
  ccp: ReturnType<typeof serializeCcp>;
  /** For per-batch CCPs: the batch in progress it is due on. */
  batch: { id: string; batchCode: string } | null;
}
interface AssetDueCheck extends DueCheckBase {
  kind: "cleaning" | "calibration";
  asset: ReturnType<typeof serializeAsset>;
  /** Calibration: whether the last one passed. */
  lastPassed: boolean | null;
}
type DueCheck = CcpDueCheck | AssetDueCheck;

/** `countsAsDone` (core) in SQL: pending and approved readings count, rejected ones don't. */
const countsAsDoneSql = ne(haccpCcpLogs.reviewStatus, "rejected");

/**
 * Everything on a schedule and where it stands, most urgent first: the CCPs of current plans
 * (per batch for each batch in progress that a plan covers, otherwise by their frequency), the
 * cleaning of areas and equipment, and calibrations (by the next due date the last one set).
 * Computed on read. `include: "due"` keeps overdue and due checks only. A CCP reading counts as
 * done while pending or approved (so nothing is entered twice); a rejected one doesn't.
 * `counts.awaitingReview` is how many readings wait for a person's review.
 */
export async function getDue(
  db: Database,
  workspaceId: string,
  query: HaccpDueQuery,
  now: Date = new Date(),
  options: {
    /**
     * Whether production batches count (Production is a soft dependency): without them a per-batch
     * CCP is never due, as when nothing is in progress.
     */
    batches?: boolean;
  } = {},
) {
  const timeZone = await workspaceTimeZone(db, workspaceId);
  const today = todayInZone(timeZone, now);
  const wants = (kind: DueCheck["kind"]) => !query.kind || query.kind === kind;
  const checks: DueCheck[] = [];

  const [plans, batches] = await Promise.all([
    currentPlans(db, workspaceId, today),
    options.batches === false ? Promise.resolve([] as DueBatch[]) : batchesInProgress(db, workspaceId),
  ]);
  if (wants("ccp") && plans.length) {
    const lastRows = await db
      .select({
        planId: haccpCcpLogs.planId,
        code: sql<string>`lower(${haccpCcpLogs.ccpCode})`,
        lastAt: sql<string>`max(${haccpCcpLogs.checkedAt})`,
      })
      .from(haccpCcpLogs)
      .where(
        and(
          eq(haccpCcpLogs.workspaceId, workspaceId),
          countsAsDoneSql,
          inArray(
            haccpCcpLogs.planId,
            plans.map((p) => p.plan.id),
          ),
        ),
      )
      .groupBy(haccpCcpLogs.planId, sql`lower(${haccpCcpLogs.ccpCode})`);
    const lastOf = new Map(lastRows.map((r) => [`${r.planId}:${r.code}`, r.lastAt]));
    const batchIds = batches.map((b) => b.id);
    const perBatch = batchIds.length
      ? await db
          .select({
            planId: haccpCcpLogs.planId,
            code: sql<string>`lower(${haccpCcpLogs.ccpCode})`,
            batchId: haccpCcpLogs.batchId,
            lastAt: sql<string>`max(${haccpCcpLogs.checkedAt})`,
          })
          .from(haccpCcpLogs)
          .where(
            and(
              eq(haccpCcpLogs.workspaceId, workspaceId),
              countsAsDoneSql,
              inArray(haccpCcpLogs.batchId, batchIds),
            ),
          )
          .groupBy(haccpCcpLogs.planId, sql`lower(${haccpCcpLogs.ccpCode})`, haccpCcpLogs.batchId)
      : [];
    const batchLast = new Map(perBatch.map((r) => [`${r.planId}:${r.code}:${r.batchId}`, r.lastAt]));

    for (const { plan, version, ccps } of plans) {
      const covered = batches.filter((b) => scopeCoversBatch(scopeOf(version), b));
      for (const ccp of ccps) {
        const base = {
          kind: "ccp" as const,
          plan: { id: plan.id, code: plan.code, name: plan.name, versionNumber: version.versionNumber },
          ccp: serializeCcp(ccp),
          frequencyText: describeFrequency({ every: ccp.frequencyEvery, unit: ccp.frequencyUnit }),
        };
        const code = ccp.code.toLowerCase();
        if (ccp.frequencyUnit === "batch") {
          for (const batch of covered) {
            const lastAt = batchLast.get(`${plan.id}:${code}:${batch.id}`) ?? null;
            checks.push({
              ...base,
              key: `ccp:${ccp.id}:${batch.id}`,
              label: `${ccp.code} ${ccp.processStep} · ${batch.batchCode}`,
              batch: { id: batch.id, batchCode: batch.batchCode },
              lastAt: lastAt ? new Date(lastAt).toISOString() : null,
              state: lastAt ? "ok" : "due",
              dueOn: lastAt ? null : today,
              dueAt: null,
            });
          }
          continue;
        }
        const lastAt = lastOf.get(`${plan.id}:${code}`) ?? null;
        checks.push({
          ...base,
          key: `ccp:${ccp.id}`,
          label: `${ccp.code} ${ccp.processStep}`,
          batch: null,
          lastAt: lastAt ? new Date(lastAt).toISOString() : null,
          ...checkDueState({
            frequency: { every: ccp.frequencyEvery, unit: ccp.frequencyUnit as ScheduleFrequencyUnit },
            lastAt,
            now,
            timeZone,
            duringProduction: ccp.duringProduction,
            producing: covered.length > 0,
          }),
        });
      }
    }
  }

  if (wants("cleaning") || wants("calibration")) {
    const assets = await db
      .select()
      .from(haccpAssets)
      .where(
        and(
          eq(haccpAssets.workspaceId, workspaceId),
          isNull(haccpAssets.deletedAt),
          eq(haccpAssets.status, "active"),
        ),
      )
      .orderBy(asc(haccpAssets.name));
    const ids = assets.map((a) => a.id);
    if (wants("cleaning") && ids.length) {
      const last = await db
        .select({
          assetId: haccpCleaningRecords.assetId,
          lastAt: sql<string>`max(${haccpCleaningRecords.cleanedAt})`,
        })
        .from(haccpCleaningRecords)
        .where(and(inArray(haccpCleaningRecords.assetId, ids), notCorrectedCleaning))
        .groupBy(haccpCleaningRecords.assetId);
      const lastOf = new Map(last.map((r) => [r.assetId, r.lastAt]));
      for (const asset of assets) {
        const frequency = frequencyOf(asset.cleaningEvery, asset.cleaningUnit);
        if (!frequency) continue;
        const lastAt = lastOf.get(asset.id) ?? null;
        checks.push({
          kind: "cleaning",
          key: `cleaning:${asset.id}`,
          label: `Clean ${asset.name}`,
          asset: serializeAsset(asset),
          frequencyText: describeFrequency(frequency),
          lastAt: lastAt ? new Date(lastAt).toISOString() : null,
          lastPassed: null,
          ...checkDueState({ frequency, lastAt, now, timeZone }),
        });
      }
    }
    if (wants("calibration") && ids.length) {
      const latest = await db
        .selectDistinctOn([haccpCalibrationRecords.assetId])
        .from(haccpCalibrationRecords)
        .where(and(inArray(haccpCalibrationRecords.assetId, ids), notCorrectedCalibration))
        .orderBy(haccpCalibrationRecords.assetId, desc(haccpCalibrationRecords.calibratedAt));
      const latestOf = new Map(latest.map((r) => [r.assetId, r]));
      for (const asset of assets) {
        const frequency = frequencyOf(asset.calibrationEvery, asset.calibrationUnit);
        if (asset.kind !== "equipment" || !frequency) continue;
        const record = latestOf.get(asset.id);
        const dueOn = record
          ? (record.nextDueOn ?? addFrequencyToDate(dateInZone(record.calibratedAt, timeZone), frequency))
          : null;
        // A failed calibration leaves the instrument due until it passes.
        const state: DueState = !record ? "due" : !record.passed ? "overdue" : dateDueState(dueOn!, today);
        checks.push({
          kind: "calibration",
          key: `calibration:${asset.id}`,
          label: `Calibrate ${asset.name}`,
          asset: serializeAsset(asset),
          frequencyText: describeFrequency(frequency),
          lastAt: record ? record.calibratedAt.toISOString() : null,
          lastPassed: record ? record.passed : null,
          state,
          dueOn,
          dueAt: null,
        });
      }
    }
  }

  const listed =
    query.include === "all" ? checks : checks.filter((c) => c.state === "overdue" || c.state === "due");
  listed.sort(
    (a, b) =>
      compareDueStates(a.state, b.state) ||
      (a.dueAt ?? `${a.dueOn ?? ""}T`).localeCompare(b.dueAt ?? `${b.dueOn ?? ""}T`) ||
      a.label.localeCompare(b.label),
  );
  return {
    today,
    now: now.toISOString(),
    checks: listed,
    counts: {
      overdue: checks.filter((c) => c.state === "overdue").length,
      due: checks.filter((c) => c.state === "due").length,
      soon: checks.filter((c) => c.state === "soon").length,
      /** CCP readings from API tokens waiting for a person's review (not corrected since). */
      awaitingReview: await countAwaitingReview(db, workspaceId),
    },
    batchesInProgress: batches.map((b) => ({
      id: b.id,
      batchCode: b.batchCode,
      recipeId: b.recipeId,
      outputItemId: b.outputItemId,
      plannedOn: b.plannedOn,
      /** Plans (the versions in force) that cover this batch. */
      planIds: plans.filter((p) => scopeCoversBatch(scopeOf(p.version), b)).map((p) => p.plan.id),
    })),
  };
}

// ─── The supervisor's sign-off of a day ──────────────────────────────────────

/** CCP checks of a plan on a day that still count (not replaced by a correction). */
async function dayCounts(db: Executor, workspaceId: string, planId: string, day: string) {
  const zone = await workspaceTimeZone(db, workspaceId);
  const base = and(
    eq(haccpCcpLogs.workspaceId, workspaceId),
    eq(haccpCcpLogs.planId, planId),
    gte(haccpCcpLogs.checkedAt, startOfDayInZone(day, zone)),
    lt(haccpCcpLogs.checkedAt, endOfDayInZone(day, zone)),
    notCorrected,
  );
  const [[total], [deviations], [pending]] = await Promise.all([
    db.select({ n: count() }).from(haccpCcpLogs).where(base),
    db
      .select({ n: count() })
      .from(haccpCcpLogs)
      .where(and(base, eq(haccpCcpLogs.withinLimits, false))),
    db
      .select({ n: count() })
      .from(haccpCcpLogs)
      .where(and(base, eq(haccpCcpLogs.reviewStatus, "pending"))),
  ]);
  return { checks: total?.n ?? 0, deviations: deviations?.n ?? 0, pending: pending?.n ?? 0 };
}

async function describeSignoffs(
  db: Executor,
  workspaceId: string,
  rows: (typeof haccpDaySignoffs.$inferSelect)[],
) {
  const [names, plans] = await Promise.all([
    userNames(
      db,
      rows.map((r) => r.signedBy),
    ),
    rows.length
      ? db
          .select({ id: haccpPlans.id, code: haccpPlans.code, name: haccpPlans.name })
          .from(haccpPlans)
          .where(
            inArray(
              haccpPlans.id,
              rows.map((r) => r.planId),
            ),
          )
      : [],
  ]);
  const planOf = new Map(plans.map((p) => [p.id, p]));
  const counts = await Promise.all(rows.map((r) => dayCounts(db, workspaceId, r.planId, r.day)));
  return rows.map((row, i) => ({
    ...strip(row),
    signedByName: nameOf(names, row.signedBy),
    plan: planOf.get(row.planId) ?? null,
    /** Checks recorded for that day after the sign-off was made. */
    addedAfter: Math.max(0, counts[i]!.checks - row.checkCount),
  }));
}

export async function listSignoffs(db: Database, workspaceId: string, query: HaccpSignoffListQuery) {
  const where: (SQL | undefined)[] = [eq(haccpDaySignoffs.workspaceId, workspaceId)];
  if (query.planId) where.push(eq(haccpDaySignoffs.planId, query.planId));
  if (query.from) where.push(gte(haccpDaySignoffs.day, query.from));
  if (query.to) where.push(sql`${haccpDaySignoffs.day} <= ${query.to}`);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(haccpDaySignoffs)
      .where(and(...where))
      .orderBy(desc(haccpDaySignoffs.day), desc(haccpDaySignoffs.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(haccpDaySignoffs)
      .where(and(...where)),
  ]);
  return {
    signoffs: await describeSignoffs(db, workspaceId, rows),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

/**
 * Signs off a plan's monitoring records for a past or current day: one per plan per day, never
 * changed. Refused while that day still has readings awaiting review (`409 readings_pending`),
 * because the supervisor can't have seen what nobody has reviewed. `manage` and a signed-in
 * person (the route).
 */
export async function signOffDay(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: HaccpDaySignoffInput,
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const plan = await findPlan(tx, workspaceId, input.planId);
    const today = await workspaceToday(tx, workspaceId);
    if (input.day > today) throw badRequest("A day can't be signed off before it has happened");
    const [existing] = await tx
      .select({ id: haccpDaySignoffs.id })
      .from(haccpDaySignoffs)
      .where(and(eq(haccpDaySignoffs.planId, plan.id), eq(haccpDaySignoffs.day, input.day)));
    if (existing) throw new ApiError(409, "already_signed_off", `${input.day} is already signed off`);
    const counts = await dayCounts(tx, workspaceId, plan.id, input.day);
    if (counts.pending > 0) {
      throw new ApiError(
        409,
        "readings_pending",
        `${counts.pending} reading${counts.pending === 1 ? "" : "s"} from ${input.day} still await review`,
      );
    }
    const [row] = await tx
      .insert(haccpDaySignoffs)
      .values({
        workspaceId,
        planId: plan.id,
        day: input.day,
        signedBy: actorId,
        note: input.note ?? null,
        checkCount: counts.checks,
        deviationCount: counts.deviations,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_day_signoff", row!)]);
    return row!.id;
  });
  const [row] = await db.select().from(haccpDaySignoffs).where(eq(haccpDaySignoffs.id, id));
  return (await describeSignoffs(db, workspaceId, [row!]))[0]!;
}

/**
 * One sign-off of a day over several plans, or the whole site. **All or nothing**: it is one
 * transaction, so if any plan can't be signed off (already signed, readings awaiting review) nothing
 * is written and the error lists the plans at fault. With `wholeSite` the plans are every active
 * plan with a version in force that day; plans already signed off for the day are left as they are
 * (and listed in `skipped`) so a site sign-off still works after one plan was signed on its own.
 * Named plans that are already signed off are refused (`409 already_signed_off`). `manage` and a
 * signed-in person (the route).
 */
export async function signOffDays(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: HaccpBulkSignoffInput,
) {
  const { ids, skipped } = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const today = await workspaceToday(tx, workspaceId);
    if (input.day > today) throw badRequest("A day can't be signed off before it has happened");
    let plans: PlanRow[];
    if (input.wholeSite) {
      plans = (await currentPlans(tx, workspaceId, input.day)).map((p) => p.plan);
      if (plans.length === 0) {
        throw new ApiError(409, "no_plans_in_force", `No plan was in force on ${input.day}`);
      }
    } else {
      const wanted = [...new Set(input.planIds ?? [])];
      plans = await tx
        .select()
        .from(haccpPlans)
        .where(
          and(
            eq(haccpPlans.workspaceId, workspaceId),
            isNull(haccpPlans.deletedAt),
            inArray(haccpPlans.id, wanted),
          ),
        )
        .orderBy(asc(haccpPlans.code));
      if (plans.length !== wanted.length) throw notFound("HACCP plan");
    }
    const already = await tx
      .select({ planId: haccpDaySignoffs.planId })
      .from(haccpDaySignoffs)
      .where(
        and(
          eq(haccpDaySignoffs.day, input.day),
          inArray(
            haccpDaySignoffs.planId,
            plans.map((p) => p.id),
          ),
        ),
      );
    const signed = new Set(already.map((r) => r.planId));
    const skipped = input.wholeSite ? plans.filter((p) => signed.has(p.id)) : [];
    if (!input.wholeSite && signed.size > 0) {
      const named = plans.filter((p) => signed.has(p.id));
      throw new ApiError(
        409,
        "already_signed_off",
        `${named.map((p) => p.code).join(", ")} ${named.length === 1 ? "is" : "are"} already signed off for ${input.day}; nothing was signed off`,
        { planIds: named.map((p) => p.id) },
      );
    }
    const todo = plans.filter((p) => !signed.has(p.id));
    if (todo.length === 0) {
      throw new ApiError(409, "already_signed_off", `Every plan is already signed off for ${input.day}`);
    }
    const counts = await Promise.all(todo.map((p) => dayCounts(tx, workspaceId, p.id, input.day)));
    const pending = todo.flatMap((p, i) =>
      counts[i]!.pending > 0 ? [{ plan: p, n: counts[i]!.pending }] : [],
    );
    if (pending.length > 0) {
      throw new ApiError(
        409,
        "readings_pending",
        `Readings from ${input.day} still await review for ${pending.map((r) => r.plan.code).join(", ")}; nothing was signed off`,
        {
          planIds: pending.map((r) => r.plan.id),
          pending: pending.map((r) => ({ planId: r.plan.id, readings: r.n })),
        },
      );
    }
    const rows = await tx
      .insert(haccpDaySignoffs)
      .values(
        todo.map((p, i) => ({
          workspaceId,
          planId: p.id,
          day: input.day,
          signedBy: actorId,
          note: input.note ?? null,
          checkCount: counts[i]!.checks,
          deviationCount: counts[i]!.deviations,
        })),
      )
      .returning();
    await recordChanges(
      tx,
      workspaceId,
      actorId,
      rows.map((row) => change("haccp_day_signoff", row)),
    );
    return { ids: rows.map((r) => r.id), skipped: skipped.map((p) => ({ id: p.id, code: p.code })) };
  });
  const rows = await db
    .select()
    .from(haccpDaySignoffs)
    .where(and(eq(haccpDaySignoffs.workspaceId, workspaceId), inArray(haccpDaySignoffs.id, ids)));
  const signoffs = await describeSignoffs(db, workspaceId, rows);
  return {
    signoffs: signoffs.sort((a, b) => (a.plan?.code ?? "").localeCompare(b.plan?.code ?? "")),
    signedOff: signoffs.length,
    skipped,
  };
}

// ─── Hazard analysis review (apart from the plan's review date) ──────────────

/**
 * Records that the plan's hazard analysis (the one in force) was reviewed today and sets when it is
 * next due (default: the hazard review interval, else the plan's). A sign-off: `manage` and a
 * signed-in person (the route). Approving a version with a hazard analysis does the same.
 */
export async function reviewHazardAnalysis(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: HaccpHazardReviewInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const plan = await findPlan(tx, workspaceId, id);
    if (plan.status === "archived") {
      throw new ApiError(409, "plan_archived", "This plan is archived; make it active before reviewing it");
    }
    const today = await workspaceToday(tx, workspaceId);
    const inForce = versionInForce(await versionsOf(tx, [id]), today);
    if (!inForce || (await stepsOf(tx, [inForce.id])).length === 0) {
      throw new ApiError(
        409,
        "no_hazard_analysis",
        "This plan has no approved hazard analysis in force to review",
      );
    }
    const nextDueOn = input.nextDueOn ?? defaultHazardReviewDueOn(today, plan);
    if (nextDueOn <= today) throw badRequest("nextDueOn must be after today");
    const [row] = await tx
      .update(haccpPlans)
      .set({
        hazardReviewDueOn: nextDueOn,
        hazardReviewedOn: today,
        hazardReviewedBy: actorId,
        hazardReviewNote: input.note ?? null,
      })
      .where(eq(haccpPlans.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_plan", row!)]);
  });
  return getPlan(db, workspaceId, id);
}

/** Plans whose hazard analysis review is due, for the notification sweep (active plans only). */
export async function plansWithHazardReviewDue(db: Executor, workspaceId: string, today: string) {
  return db
    .select({
      id: haccpPlans.id,
      code: haccpPlans.code,
      name: haccpPlans.name,
      dueOn: haccpPlans.hazardReviewDueOn,
    })
    .from(haccpPlans)
    .where(
      and(
        eq(haccpPlans.workspaceId, workspaceId),
        isNull(haccpPlans.deletedAt),
        eq(haccpPlans.status, "active"),
        sql`${haccpPlans.hazardReviewDueOn} is not null`,
        sql`${haccpPlans.hazardReviewDueOn} <= ${today}`,
      ),
    )
    .orderBy(asc(haccpPlans.code));
}

// ─── The hazard library ──────────────────────────────────────────────────────

type LibraryRow = typeof haccpHazardLibrary.$inferSelect;

function serializeEntry(row: LibraryRow) {
  return {
    ...stripSoft(row),
    risk: hazardRisk(row.likelihood, row.severity),
    outcome: decisionTreeOutcome(row),
  };
}

const entryValues = (input: HazardLibraryEntryInput) => ({
  title: input.title,
  stepName: input.stepName ?? null,
  hazardType: input.hazardType,
  description: input.description,
  likelihood: input.likelihood,
  severity: input.severity,
  controlMeasure: input.controlMeasure ?? null,
  justification: input.justification ?? null,
  q1: input.q1,
  q2: input.q2,
  q3: input.q3,
  q4: input.q4,
});

async function findEntry(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(haccpHazardLibrary)
    .where(
      and(
        eq(haccpHazardLibrary.id, id),
        eq(haccpHazardLibrary.workspaceId, workspaceId),
        isNull(haccpHazardLibrary.deletedAt),
      ),
    );
  if (!row) throw notFound("Hazard library entry");
  return row;
}

export async function listHazardLibrary(db: Database, workspaceId: string, query: HazardLibraryListQuery) {
  const where: (SQL | undefined)[] = [
    eq(haccpHazardLibrary.workspaceId, workspaceId),
    isNull(haccpHazardLibrary.deletedAt),
  ];
  if (query.hazardType) where.push(eq(haccpHazardLibrary.hazardType, query.hazardType));
  if (query.q) {
    where.push(
      or(
        sql`${haccpHazardLibrary.title} ilike ${like(query.q)} escape '!'`,
        sql`${haccpHazardLibrary.description} ilike ${like(query.q)} escape '!'`,
        sql`${haccpHazardLibrary.stepName} ilike ${like(query.q)} escape '!'`,
      ),
    );
  }
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(haccpHazardLibrary)
      .where(and(...where))
      .orderBy(asc(haccpHazardLibrary.title), asc(haccpHazardLibrary.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(haccpHazardLibrary)
      .where(and(...where)),
  ]);
  return {
    entries: rows.map(serializeEntry),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getHazardLibraryEntry(db: Executor, workspaceId: string, id: string) {
  return serializeEntry(await findEntry(db, workspaceId, id));
}

export async function createHazardLibraryEntry(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: HazardLibraryEntryInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [row] = await tx
      .insert(haccpHazardLibrary)
      .values({ ...entryValues(input), workspaceId, createdBy: actorId, updatedBy: actorId })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_hazard_library", row!)]);
    return serializeEntry(row!);
  });
}

/** Replaces an entry. Plans that copied it are not touched: a plan keeps its own copy. */
export async function updateHazardLibraryEntry(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: HazardLibraryEntryInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findEntry(tx, workspaceId, id);
    const [row] = await tx
      .update(haccpHazardLibrary)
      .set({ ...entryValues(input), updatedBy: actorId })
      .where(eq(haccpHazardLibrary.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_hazard_library", row!)]);
    return serializeEntry(row!);
  });
}

export async function deleteHazardLibraryEntry(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findEntry(tx, workspaceId, id);
    await tx
      .update(haccpHazardLibrary)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(eq(haccpHazardLibrary.id, id));
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "haccp_hazard_library", entityId: id, action: "delete" },
    ]);
  });
}

// ─── Plan templates ──────────────────────────────────────────────────────────

type TemplateRow = typeof haccpPlanTemplates.$inferSelect;

function serializeTemplate(row: TemplateRow, names: Map<string, string>) {
  const { content, ...rest } = stripSoft(row);
  return {
    ...rest,
    steps: content.steps,
    ccps: content.ccps,
    stepCount: content.steps.length,
    hazardCount: content.steps.reduce((n, s) => n + s.hazards.length, 0),
    ccpCount: content.ccps.length,
    createdByName: nameOf(names, row.createdBy),
    updatedByName: nameOf(names, row.updatedBy),
  };
}

async function describeTemplates(db: Executor, rows: TemplateRow[]) {
  const names = await userNames(
    db,
    rows.flatMap((r) => [r.createdBy, r.updatedBy]),
  );
  return rows.map((row) => serializeTemplate(row, names));
}

async function findTemplate(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(haccpPlanTemplates)
    .where(
      and(
        eq(haccpPlanTemplates.id, id),
        eq(haccpPlanTemplates.workspaceId, workspaceId),
        isNull(haccpPlanTemplates.deletedAt),
      ),
    );
  if (!row) throw notFound("HACCP plan template");
  return row;
}

/** The first draft of a plan started from a template: its hazard analysis and CCPs, no scope. */
function templateDraft(template: TemplateRow): HaccpPlanDraftInput {
  return {
    scope: { itemIds: [], recipeIds: [] },
    changeNote: `Started from the template "${template.name}"`,
    steps: template.content.steps,
    ccps: template.content.ccps,
  };
}

/** A plan's draft (else its version in force) as template content: steps and CCPs, not scope. */
async function planContent(db: Executor, workspaceId: string, planId: string) {
  const plan = await findPlan(db, workspaceId, planId);
  const version =
    (await versionWith(db, plan.id, "draft")) ??
    versionInForce(await versionsOf(db, [plan.id]), await workspaceToday(db, workspaceId));
  if (!version) throw new ApiError(409, "no_content", "This plan has no draft or approved version to copy");
  const [steps, ccps] = await Promise.all([stepsOf(db, [version.id]), ccpsOf(db, [version.id])]);
  const refOf = new Map(steps.map((step, i) => [step.id, `step${i + 1}`]));
  return {
    steps: steps.map((step): ProcessStepInput => ({
      ref: refOf.get(step.id)!,
      name: step.name,
      description: step.description,
      hazards: step.hazards.map((h) => ({ ...h })),
    })),
    ccps: ccps.map((ccp): CcpInput => ({
      code: ccp.code,
      processStep: ccp.processStep,
      stepRef: ccp.stepId ? (refOf.get(ccp.stepId) ?? null) : null,
      hazardType: ccp.hazardType,
      hazard: ccp.hazard,
      limitType: ccp.limitType,
      limitMin: ccp.limitMin,
      limitMax: ccp.limitMax,
      limitUnit: ccp.limitUnit,
      passCriterion: ccp.passCriterion,
      monitoringMethod: ccp.monitoringMethod,
      frequency: { every: ccp.frequencyEvery, unit: ccp.frequencyUnit },
      duringProduction: ccp.duringProduction,
      responsibleRole: ccp.responsibleRole,
      correctiveAction: ccp.correctiveAction,
      verification: ccp.verification,
    })),
  };
}

export async function listPlanTemplates(
  db: Database,
  workspaceId: string,
  query: HaccpPlanTemplateListQuery,
) {
  const where: (SQL | undefined)[] = [
    eq(haccpPlanTemplates.workspaceId, workspaceId),
    isNull(haccpPlanTemplates.deletedAt),
  ];
  if (query.q) {
    where.push(
      or(
        sql`${haccpPlanTemplates.name} ilike ${like(query.q)} escape '!'`,
        sql`${haccpPlanTemplates.description} ilike ${like(query.q)} escape '!'`,
      ),
    );
  }
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(haccpPlanTemplates)
      .where(and(...where))
      .orderBy(asc(haccpPlanTemplates.name), asc(haccpPlanTemplates.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(haccpPlanTemplates)
      .where(and(...where)),
  ]);
  return {
    templates: await describeTemplates(db, rows),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getPlanTemplate(db: Executor, workspaceId: string, id: string) {
  return (await describeTemplates(db, [await findTemplate(db, workspaceId, id)]))[0]!;
}

export async function createPlanTemplate(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: HaccpPlanTemplateCreateInput,
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const content = input.fromPlanId
      ? await planContent(tx, workspaceId, input.fromPlanId)
      : { steps: input.steps ?? [], ccps: input.ccps ?? [] };
    const [row] = await tx
      .insert(haccpPlanTemplates)
      .values({
        workspaceId,
        name: input.name,
        description: input.description ?? null,
        content,
        createdBy: actorId,
        updatedBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_plan_template", row!)]);
    return row!.id;
  });
  return getPlanTemplate(db, workspaceId, id);
}

/** Replaces a template. Plans started from it are not touched: they hold their own copy. */
export async function updatePlanTemplate(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: HaccpPlanTemplateInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findTemplate(tx, workspaceId, id);
    const [row] = await tx
      .update(haccpPlanTemplates)
      .set({
        name: input.name,
        description: input.description ?? null,
        content: { steps: input.steps, ccps: input.ccps },
        updatedBy: actorId,
      })
      .where(eq(haccpPlanTemplates.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("haccp_plan_template", row!)]);
  });
  return getPlanTemplate(db, workspaceId, id);
}

export async function deletePlanTemplate(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findTemplate(tx, workspaceId, id);
    await tx
      .update(haccpPlanTemplates)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(eq(haccpPlanTemplates.id, id));
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "haccp_plan_template", entityId: id, action: "delete" },
    ]);
  });
}

// ─── A batch's food safety record ────────────────────────────────────────────

/**
 * For the production batch page: the CCP checks recorded against a batch, the CCPs of the plan
 * versions in force that cover it (and whether each has been checked on this batch), and its open deviations.
 */
/**
 * The open corrective actions on a production batch (a deviation nobody has closed), for the
 * production side to warn about when the batch is completed. Warns only; it never blocks. The
 * route returns it to people who can read haccp.
 */
export async function getBatchDeviationWarning(db: Executor, workspaceId: string, batchId: string) {
  const rows = await db
    .select({ id: haccpCorrectiveActions.id, title: haccpCorrectiveActions.title })
    .from(haccpCorrectiveActions)
    .where(
      and(
        eq(haccpCorrectiveActions.workspaceId, workspaceId),
        eq(haccpCorrectiveActions.batchId, batchId),
        eq(haccpCorrectiveActions.status, "open"),
        isNull(haccpCorrectiveActions.deletedAt),
      ),
    )
    .orderBy(haccpCorrectiveActions.createdAt);
  return { openDeviations: rows.length, actions: rows.slice(0, 5) };
}

export async function getBatchRecord(db: Database, workspaceId: string, batchId: string) {
  const batch = await findBatch(db, workspaceId, batchId);
  const [logRows, plans, openActions] = await Promise.all([
    db
      .select()
      .from(haccpCcpLogs)
      .where(and(eq(haccpCcpLogs.workspaceId, workspaceId), eq(haccpCcpLogs.batchId, batchId)))
      .orderBy(desc(haccpCcpLogs.checkedAt), desc(haccpCcpLogs.id)),
    currentPlans(db, workspaceId, await workspaceToday(db, workspaceId)),
    db
      .select({ n: count() })
      .from(haccpCorrectiveActions)
      .where(
        and(
          eq(haccpCorrectiveActions.workspaceId, workspaceId),
          eq(haccpCorrectiveActions.batchId, batchId),
          eq(haccpCorrectiveActions.status, "open"),
          isNull(haccpCorrectiveActions.deletedAt),
        ),
      ),
  ]);
  const logs = await describeLogs(db, logRows);
  const current = logs.filter((l) => !l.correctedByLogId);
  const ccps = plans
    .filter((p) => scopeCoversBatch(scopeOf(p.version), batch))
    .flatMap(({ plan, ccps }) =>
      ccps.map((ccp) => {
        const mine = current.filter(
          (l) => l.planId === plan.id && l.ccpCode.toLowerCase() === ccp.code.toLowerCase(),
        );
        // Rejected readings don't count as checks; their deviations stay (the corrective action is open).
        const done = mine.filter(countsAsDone);
        return {
          plan: { id: plan.id, code: plan.code, name: plan.name },
          ccp: serializeCcp(ccp),
          checks: done.length,
          /** Of those, recorded through an API token and waiting for a person's review. */
          awaitingReview: done.filter((l) => awaitsReview(l)).length,
          lastCheckedAt: done[0]?.checkedAt ?? null,
          deviations: mine.filter((l) => !l.withinLimits).length,
        };
      }),
    );
  return {
    batch: { id: batch.id, batchCode: batch.batchCode, status: batch.status },
    logs,
    ccps,
    /** Per-batch CCPs with no check on this batch yet (rejected readings don't count). */
    missingChecks: ccps.filter((c) => c.ccp.frequency.unit === "batch" && c.checks === 0).length,
    /** Readings on this batch waiting for a person's review. */
    awaitingReview: current.filter((l) => awaitsReview(l)).length,
    openDeviations: current.filter(
      (l) => !l.withinLimits && l.correctiveActions.some((a) => a.status === "open"),
    ).length,
    openCorrectiveActions: openActions[0]?.n ?? 0,
  };
}
