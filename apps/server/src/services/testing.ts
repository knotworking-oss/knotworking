import {
  judgeResult,
  sampleOutcome,
  summarizeTrend,
  TestJudgeError,
  testPlanDue,
  type AnalyteInput,
  type LaboratoryInput,
  type LaboratoryUpdateInput,
  type ModuleId,
  type SamplingPointInput,
  type SamplingPointUpdateInput,
  type TestInvestigationCloseInput,
  type TestOutcome,
  type TestPlanInput,
  type TestPlanUpdateInput,
  type TestResultsRecordInput,
  type TestSampleCancelInput,
  type TestSampleCreateInput,
  type TestSampleListQuery,
  type TestTrendQuery,
  type TestingRecordStatus,
} from "@knotworking/core";
import {
  items,
  lockWorkspaceLog,
  recordChanges,
  specificationParameters,
  specifications,
  specificationVersions,
  stockLots,
  testingLaboratories,
  testingPlans,
  testingResults,
  testingSamples,
  testingSamplingPoints,
  users,
  type ChangeInput,
  type Database,
  type Executor,
  type TestResultHistoryEntry,
  type Transaction,
} from "@knotworking/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  max,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { ApiError, badRequest, notFound } from "../errors";
import { deliverNotifications, type NotificationRow } from "./notifications";
import { notifyReservedLotStatus } from "./reservation-alerts";
import { lotChange } from "./stock-ledger";

/**
 * Testing module: laboratories, sampling points, sampling plans, samples and results.
 *
 * Logging a sample copies its analytes and limits onto result rows (from the request, the plan,
 * or the lot's item's approved specification), so later changes never re-judge it. Recording a
 * failed result, in one transaction: fails the sample, opens an investigation on it, and puts an
 * available lot on hold (quarantine) with a note naming the sample. Releasing a held lot stays the
 * stock module's person-only decision; closing the investigation is a person's with `manage`.
 * The sync log carries metadata only (never results or findings).
 */

type LabRow = typeof testingLaboratories.$inferSelect;
type PointRow = typeof testingSamplingPoints.$inferSelect;
type PlanRow = typeof testingPlans.$inferSelect;
type SampleRow = typeof testingSamples.$inferSelect;
type ResultRow = typeof testingResults.$inferSelect;

const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
const strip = <T extends { workspaceId: string; deletedAt: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
};

const labChange = (row: LabRow): ChangeInput => ({
  entity: "testing_laboratory",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});
const pointChange = (row: PointRow): ChangeInput => ({
  entity: "testing_sampling_point",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});
const planChange = (row: PlanRow): ChangeInput => ({
  entity: "testing_plan",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});
/** A sample's metadata: never its results or investigation findings. */
const sampleChange = (row: SampleRow): ChangeInput => ({
  entity: "testing_sample",
  entityId: row.id,
  action: "upsert",
  data: {
    id: row.id,
    reference: row.reference,
    subject: row.subject,
    lotId: row.lotId,
    itemId: row.itemId,
    samplingPointId: row.samplingPointId,
    planId: row.planId,
    laboratoryId: row.laboratoryId,
    sampledOn: row.sampledOn,
    status: row.status,
    outcome: row.outcome,
    investigationStatus: row.investigationStatus,
    lotHeld: row.lotHeld,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  },
});

async function userNames(db: Executor, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((u) => [u.id, u.name]));
}

const statusFilter = (column: PgColumn, status: TestingRecordStatus | "all") =>
  status === "all" ? undefined : eq(column, status);

// ─── Laboratories and sampling points ────────────────────────────────────────

export async function listLaboratories(
  db: Database,
  workspaceId: string,
  status: TestingRecordStatus | "all",
) {
  const rows = await db
    .select()
    .from(testingLaboratories)
    .where(
      and(
        eq(testingLaboratories.workspaceId, workspaceId),
        isNull(testingLaboratories.deletedAt),
        statusFilter(testingLaboratories.status, status),
      ),
    )
    .orderBy(asc(testingLaboratories.name));
  return { laboratories: rows.map(strip) };
}

async function findLab(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(testingLaboratories)
    .where(
      and(
        eq(testingLaboratories.id, id),
        eq(testingLaboratories.workspaceId, workspaceId),
        isNull(testingLaboratories.deletedAt),
      ),
    );
  if (!row) throw notFound("Laboratory");
  return row;
}

export async function createLaboratory(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: LaboratoryInput,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(testingLaboratories)
      .values({
        workspaceId,
        name: input.name,
        accreditation: input.accreditation ?? null,
        accreditationExpiresOn: input.accreditationExpiresOn ?? null,
        inHouse: input.inHouse,
        contact: input.contact ?? null,
        notes: input.notes ?? null,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [labChange(row!)]);
    return strip(row!);
  });
}

export async function updateLaboratory(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: LaboratoryUpdateInput,
) {
  return db.transaction(async (tx) => {
    await findLab(tx, workspaceId, id);
    const [row] = await tx
      .update(testingLaboratories)
      .set(patch)
      .where(eq(testingLaboratories.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [labChange(row!)]);
    return strip(row!);
  });
}

export async function listSamplingPoints(
  db: Database,
  workspaceId: string,
  status: TestingRecordStatus | "all",
) {
  const rows = await db
    .select()
    .from(testingSamplingPoints)
    .where(
      and(
        eq(testingSamplingPoints.workspaceId, workspaceId),
        isNull(testingSamplingPoints.deletedAt),
        statusFilter(testingSamplingPoints.status, status),
      ),
    )
    .orderBy(asc(sql`lower(${testingSamplingPoints.code})`));
  return { points: rows.map(strip) };
}

async function findPoint(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(testingSamplingPoints)
    .where(
      and(
        eq(testingSamplingPoints.id, id),
        eq(testingSamplingPoints.workspaceId, workspaceId),
        isNull(testingSamplingPoints.deletedAt),
      ),
    );
  if (!row) throw notFound("Sampling point");
  return row;
}

async function assertPointCodeFree(tx: Transaction, workspaceId: string, code: string, exceptId?: string) {
  const [taken] = await tx
    .select({ id: testingSamplingPoints.id })
    .from(testingSamplingPoints)
    .where(
      and(
        eq(testingSamplingPoints.workspaceId, workspaceId),
        isNull(testingSamplingPoints.deletedAt),
        sql`lower(${testingSamplingPoints.code}) = lower(${code})`,
        exceptId ? ne(testingSamplingPoints.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `Another sampling point already uses the code "${code}"`);
}

export async function createSamplingPoint(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: SamplingPointInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertPointCodeFree(tx, workspaceId, input.code);
    const [row] = await tx
      .insert(testingSamplingPoints)
      .values({
        workspaceId,
        code: input.code,
        name: input.name,
        kind: input.kind,
        zone: input.zone ?? null,
        location: input.location ?? null,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [pointChange(row!)]);
    return strip(row!);
  });
}

export async function updateSamplingPoint(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: SamplingPointUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findPoint(tx, workspaceId, id);
    if (patch.code !== undefined) await assertPointCodeFree(tx, workspaceId, patch.code, id);
    const [row] = await tx
      .update(testingSamplingPoints)
      .set(patch)
      .where(eq(testingSamplingPoints.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [pointChange(row!)]);
    return strip(row!);
  });
}

// ─── Plans ───────────────────────────────────────────────────────────────────

async function findPlan(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(testingPlans)
    .where(
      and(eq(testingPlans.id, id), eq(testingPlans.workspaceId, workspaceId), isNull(testingPlans.deletedAt)),
    );
  if (!row) throw notFound("Sampling plan");
  return row;
}

async function liveItem(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(items)
    .where(and(eq(items.id, id), eq(items.workspaceId, workspaceId), isNull(items.deletedAt)));
  if (!row) throw badRequest("That item doesn't exist");
  return row;
}

/**
 * Active plans with when each is next due: `frequencyDays` after the last sample taken under it
 * (cancelled ones don't count), or from the day it started. Sorted soonest first.
 */
export async function listPlans(
  db: Database,
  workspaceId: string,
  status: TestingRecordStatus | "all",
  today: string,
) {
  const rows = await db
    .select({
      plan: testingPlans,
      itemCode: items.code,
      itemName: items.name,
      pointCode: testingSamplingPoints.code,
      pointName: testingSamplingPoints.name,
      pointZone: testingSamplingPoints.zone,
      labName: testingLaboratories.name,
    })
    .from(testingPlans)
    .leftJoin(items, eq(items.id, testingPlans.itemId))
    .leftJoin(testingSamplingPoints, eq(testingSamplingPoints.id, testingPlans.samplingPointId))
    .leftJoin(testingLaboratories, eq(testingLaboratories.id, testingPlans.laboratoryId))
    .where(
      and(
        eq(testingPlans.workspaceId, workspaceId),
        isNull(testingPlans.deletedAt),
        statusFilter(testingPlans.status, status),
      ),
    );
  const ids = rows.map((r) => r.plan.id);
  const last = ids.length
    ? await db
        .select({ planId: testingSamples.planId, last: max(testingSamples.sampledOn) })
        .from(testingSamples)
        .where(and(inArray(testingSamples.planId, ids), ne(testingSamples.status, "cancelled")))
        .groupBy(testingSamples.planId)
    : [];
  const lastByPlan = new Map(last.map((l) => [l.planId, l.last]));
  const plans = rows.map((r) => {
    const lastSampledOn = lastByPlan.get(r.plan.id) ?? null;
    const due = testPlanDue({
      lastSampledOn,
      frequencyDays: r.plan.frequencyDays,
      startedOn: r.plan.startedOn,
      today,
    });
    return {
      ...strip(r.plan),
      item: r.plan.itemId ? { id: r.plan.itemId, code: r.itemCode!, name: r.itemName! } : null,
      samplingPoint: r.plan.samplingPointId
        ? { id: r.plan.samplingPointId, code: r.pointCode!, name: r.pointName!, zone: r.pointZone }
        : null,
      laboratoryName: r.labName,
      lastSampledOn,
      ...due,
    };
  });
  plans.sort((a, b) => a.nextDueOn.localeCompare(b.nextDueOn) || a.name.localeCompare(b.name));
  return { plans, today };
}

export async function createPlan(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: TestPlanInput,
  today: string,
) {
  return db.transaction(async (tx) => {
    if (input.itemId) await liveItem(tx, workspaceId, input.itemId);
    if (input.samplingPointId) await findPoint(tx, workspaceId, input.samplingPointId);
    if (input.laboratoryId) await findLab(tx, workspaceId, input.laboratoryId);
    const [row] = await tx
      .insert(testingPlans)
      .values({
        workspaceId,
        name: input.name,
        subject: input.subject,
        itemId: input.itemId ?? null,
        samplingPointId: input.samplingPointId ?? null,
        frequencyDays: input.frequencyDays,
        rationale: input.rationale ?? null,
        laboratoryId: input.laboratoryId ?? null,
        analytes: input.analytes,
        startedOn: today,
        createdBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [planChange(row!)]);
    return strip(row!);
  });
}

export async function updatePlan(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: TestPlanUpdateInput,
) {
  return db.transaction(async (tx) => {
    const plan = await findPlan(tx, workspaceId, id);
    if (patch.laboratoryId) await findLab(tx, workspaceId, patch.laboratoryId);
    if (patch.analytes && patch.analytes.length === 0 && plan.subject === "point") {
      throw badRequest("A sampling point plan needs at least one analyte");
    }
    const [row] = await tx.update(testingPlans).set(patch).where(eq(testingPlans.id, id)).returning();
    await recordChanges(tx, workspaceId, actorId, [planChange(row!)]);
    return strip(row!);
  });
}

// ─── Samples ─────────────────────────────────────────────────────────────────

async function findSample(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(testingSamples)
    .where(
      and(
        eq(testingSamples.id, id),
        eq(testingSamples.workspaceId, workspaceId),
        isNull(testingSamples.deletedAt),
      ),
    );
  if (!row) throw notFound("Sample");
  return row;
}

async function resultsOf(db: Executor, sampleId: string) {
  return db
    .select()
    .from(testingResults)
    .where(eq(testingResults.sampleId, sampleId))
    .orderBy(asc(testingResults.sortOrder), asc(testingResults.id));
}

const resultOut = (r: ResultRow, names: Map<string, string>) => ({
  id: r.id,
  category: r.category,
  name: r.name,
  unit: r.unit,
  min: r.min,
  max: r.max,
  limitText: r.limitText,
  method: r.method,
  specificationParameterId: r.specificationParameterId,
  value: r.value,
  valueText: r.valueText,
  outcome: r.outcome,
  reportedOn: r.reportedOn,
  reportReference: r.reportReference,
  recordedAt: r.recordedAt,
  recordedByName: r.recordedBy ? (names.get(r.recordedBy) ?? null) : null,
  history: r.history.map((h) => ({
    ...h,
    recordedByName: h.recordedBy ? (names.get(h.recordedBy) ?? null) : null,
  })),
});

/** A sample in full: what it was taken from, its results and limits, and its investigation. */
export async function getSample(
  db: Executor,
  workspaceId: string,
  id: string,
  options: { showSpecification: boolean },
) {
  const sample = await findSample(db, workspaceId, id);
  const results = await resultsOf(db, sample.id);
  const [lot] = sample.lotId
    ? await db
        .select({
          id: stockLots.id,
          lotCode: stockLots.lotCode,
          status: stockLots.status,
          expiresOn: stockLots.expiresOn,
        })
        .from(stockLots)
        .where(eq(stockLots.id, sample.lotId))
    : [];
  const [item] = sample.itemId
    ? await db
        .select({ id: items.id, code: items.code, name: items.name })
        .from(items)
        .where(eq(items.id, sample.itemId))
    : [];
  const point = sample.samplingPointId
    ? strip(await findPoint(db, workspaceId, sample.samplingPointId))
    : null;
  const [plan] = sample.planId
    ? await db
        .select({ id: testingPlans.id, name: testingPlans.name })
        .from(testingPlans)
        .where(eq(testingPlans.id, sample.planId))
    : [];
  const [lab] = sample.laboratoryId
    ? await db
        .select({
          id: testingLaboratories.id,
          name: testingLaboratories.name,
          accreditation: testingLaboratories.accreditation,
        })
        .from(testingLaboratories)
        .where(eq(testingLaboratories.id, sample.laboratoryId))
    : [];
  const [spec] =
    sample.specificationVersionId && options.showSpecification
      ? await db
          .select({
            specificationId: specifications.id,
            code: specifications.code,
            versionNumber: specificationVersions.versionNumber,
          })
          .from(specificationVersions)
          .innerJoin(specifications, eq(specifications.id, specificationVersions.specificationId))
          .where(eq(specificationVersions.id, sample.specificationVersionId))
      : [];
  const names = await userNames(db, [
    sample.createdBy,
    sample.cancelledBy,
    sample.investigationClosedBy,
    ...results.flatMap((r) => [r.recordedBy, ...r.history.map((h) => h.recordedBy)]),
  ]);
  return {
    ...strip(sample),
    lot: lot ?? null,
    item: item ?? null,
    samplingPoint: point,
    plan: plan ?? null,
    laboratory: lab ?? null,
    specification: spec ?? null,
    results: results.map((r) => resultOut(r, names)),
    createdByName: sample.createdBy ? (names.get(sample.createdBy) ?? null) : null,
    cancelledByName: sample.cancelledBy ? (names.get(sample.cancelledBy) ?? null) : null,
    investigationClosedByName: sample.investigationClosedBy
      ? (names.get(sample.investigationClosedBy) ?? null)
      : null,
  };
}

export async function listSamples(db: Database, workspaceId: string, query: TestSampleListQuery) {
  const conditions: (SQL | undefined)[] = [
    eq(testingSamples.workspaceId, workspaceId),
    isNull(testingSamples.deletedAt),
    query.status === "all" ? undefined : eq(testingSamples.status, query.status),
    query.outcome ? eq(testingSamples.outcome, query.outcome) : undefined,
    query.investigation ? eq(testingSamples.investigationStatus, query.investigation) : undefined,
    query.subject ? eq(testingSamples.subject, query.subject) : undefined,
    query.lotId ? eq(testingSamples.lotId, query.lotId) : undefined,
    query.itemId ? eq(testingSamples.itemId, query.itemId) : undefined,
    query.samplingPointId ? eq(testingSamples.samplingPointId, query.samplingPointId) : undefined,
    query.planId ? eq(testingSamples.planId, query.planId) : undefined,
    query.from ? gte(testingSamples.sampledOn, query.from) : undefined,
    query.to ? lte(testingSamples.sampledOn, query.to) : undefined,
  ];
  if (query.q) {
    const pattern = like(query.q);
    conditions.push(
      or(
        sql`${testingSamples.reference} ilike ${pattern} escape '!'`,
        sql`${stockLots.lotCode} ilike ${pattern} escape '!'`,
        sql`${items.code} ilike ${pattern} escape '!'`,
        sql`${testingSamplingPoints.code} ilike ${pattern} escape '!'`,
      ),
    );
  }
  const where = and(...conditions);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        sample: testingSamples,
        lotCode: stockLots.lotCode,
        lotStatus: stockLots.status,
        itemCode: items.code,
        itemName: items.name,
        pointCode: testingSamplingPoints.code,
        pointName: testingSamplingPoints.name,
        pointZone: testingSamplingPoints.zone,
        labName: testingLaboratories.name,
      })
      .from(testingSamples)
      .leftJoin(stockLots, eq(stockLots.id, testingSamples.lotId))
      .leftJoin(items, eq(items.id, testingSamples.itemId))
      .leftJoin(testingSamplingPoints, eq(testingSamplingPoints.id, testingSamples.samplingPointId))
      .leftJoin(testingLaboratories, eq(testingLaboratories.id, testingSamples.laboratoryId))
      .where(where)
      .orderBy(desc(testingSamples.sampledOn), desc(testingSamples.reference))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ total: count() })
      .from(testingSamples)
      .leftJoin(stockLots, eq(stockLots.id, testingSamples.lotId))
      .leftJoin(items, eq(items.id, testingSamples.itemId))
      .leftJoin(testingSamplingPoints, eq(testingSamplingPoints.id, testingSamples.samplingPointId))
      .where(where),
  ]);
  return {
    samples: rows.map((r) => {
      const { findings: _f, rootCause: _r, actionTaken: _a, ...meta } = strip(r.sample);
      return {
        ...meta,
        lot: r.sample.lotId ? { id: r.sample.lotId, lotCode: r.lotCode!, status: r.lotStatus! } : null,
        item: r.sample.itemId ? { id: r.sample.itemId, code: r.itemCode!, name: r.itemName! } : null,
        samplingPoint: r.sample.samplingPointId
          ? { id: r.sample.samplingPointId, code: r.pointCode!, name: r.pointName!, zone: r.pointZone }
          : null,
        laboratoryName: r.labName,
      };
    }),
    total: total?.total ?? 0,
    offset: query.offset,
  };
}

async function nextReference(tx: Transaction, workspaceId: string, today: string) {
  const prefix = `S-${today.slice(0, 4)}-`;
  const [row] = await tx
    .select({
      n: sql<number>`coalesce(max((substring(${testingSamples.reference} from ${`^${prefix}([0-9]+)$`}))::int), 0)`,
    })
    .from(testingSamples)
    .where(
      and(eq(testingSamples.workspaceId, workspaceId), sql`${testingSamples.reference} like ${`${prefix}%`}`),
    );
  return `${prefix}${String(Number(row?.n ?? 0) + 1).padStart(4, "0")}`;
}

interface ResolvedAnalyte extends AnalyteInput {
  specificationParameterId?: string | null;
}

/**
 * The approved specification whose parameters a lot is tested against: the lot's supplier's, else
 * the internal one, else the only one. Null when there is none or it is ambiguous.
 */
async function specificationFor(
  tx: Executor,
  workspaceId: string,
  itemId: string,
  supplierId: string | null,
) {
  const rows = await tx
    .select({
      versionId: specificationVersions.id,
      supplierId: specifications.supplierId,
      customerName: specifications.customerName,
    })
    .from(specifications)
    .innerJoin(
      specificationVersions,
      and(
        eq(specificationVersions.specificationId, specifications.id),
        eq(specificationVersions.status, "approved"),
        isNull(specificationVersions.deletedAt),
      ),
    )
    .where(
      and(
        eq(specifications.workspaceId, workspaceId),
        eq(specifications.itemId, itemId),
        eq(specifications.status, "active"),
        isNull(specifications.deletedAt),
      ),
    );
  const pick =
    (supplierId ? rows.find((r) => r.supplierId === supplierId) : undefined) ??
    rows.find((r) => !r.supplierId && !r.customerName) ??
    (rows.length === 1 ? rows[0] : undefined);
  if (!pick) return { versionId: null, ambiguous: rows.length > 1 };
  return { versionId: pick.versionId, ambiguous: false };
}

export async function createSample(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  input: TestSampleCreateInput,
  today: string,
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (input.sampledOn > today) throw badRequest("The sample date can't be in the future");
    let itemId: string | null = null;
    let lotSupplier: string | null = null;
    if (input.subject === "lot") {
      const [lot] = await tx
        .select()
        .from(stockLots)
        .where(
          and(
            eq(stockLots.id, input.lotId!),
            eq(stockLots.workspaceId, workspaceId),
            isNull(stockLots.deletedAt),
          ),
        );
      if (!lot) throw badRequest("That lot doesn't exist");
      itemId = lot.itemId;
      lotSupplier = lot.supplierId;
    } else {
      const point = await findPoint(tx, workspaceId, input.samplingPointId!);
      if (point.status === "archived") throw badRequest(`${point.code} is archived`);
    }
    let plan: PlanRow | null = null;
    if (input.planId) {
      plan = await findPlan(tx, workspaceId, input.planId);
      const matches =
        plan.subject === input.subject &&
        (plan.subject === "lot" ? plan.itemId === itemId : plan.samplingPointId === input.samplingPointId);
      if (!matches) throw badRequest("That plan is for another item or sampling point");
    }
    const laboratoryId = input.laboratoryId ?? plan?.laboratoryId ?? null;
    if (laboratoryId) {
      const lab = await findLab(tx, workspaceId, laboratoryId);
      if (lab.status === "archived") throw badRequest(`${lab.name} is archived`);
    }

    // Analytes: as asked, else the plan's, else the lot's item's approved specification.
    let analytes: ResolvedAnalyte[] = input.analytes ?? (plan?.analytes.length ? plan.analytes : []);
    let specificationVersionId: string | null = null;
    if (analytes.length === 0 && itemId && active.includes("specifications")) {
      const found = await specificationFor(tx, workspaceId, itemId, lotSupplier);
      if (found.ambiguous) {
        throw badRequest(
          "The item has several approved specifications and none matches the lot's supplier: list the analytes",
        );
      }
      if (found.versionId) {
        specificationVersionId = found.versionId;
        const params = await tx
          .select()
          .from(specificationParameters)
          .where(eq(specificationParameters.versionId, found.versionId))
          .orderBy(asc(specificationParameters.sortOrder));
        // Only limits a test can judge: a parameter with just a target has nothing to fail.
        analytes = params
          .filter((p) => p.min != null || p.max != null || p.limitText)
          .map((p) => ({
            category: p.category,
            name: p.name,
            unit: p.unit,
            min: p.min,
            max: p.max,
            limitText: p.limitText,
            method: p.method,
            specificationParameterId: p.id,
          }));
      }
    }
    if (analytes.length === 0) {
      throw badRequest(
        "Say what the sample is tested for: list the analytes, choose a plan, or approve a specification with limits for the item",
      );
    }

    let reference = input.reference ?? null;
    if (reference) {
      const [taken] = await tx
        .select({ id: testingSamples.id })
        .from(testingSamples)
        .where(
          and(
            eq(testingSamples.workspaceId, workspaceId),
            sql`lower(${testingSamples.reference}) = lower(${reference})`,
          ),
        );
      if (taken)
        throw new ApiError(
          409,
          "reference_taken",
          `Another sample already uses the reference "${reference}"`,
        );
    } else reference = await nextReference(tx, workspaceId, today);

    const [sample] = await tx
      .insert(testingSamples)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        reference,
        subject: input.subject,
        lotId: input.lotId ?? null,
        itemId,
        samplingPointId: input.samplingPointId ?? null,
        planId: plan?.id ?? null,
        laboratoryId,
        specificationVersionId,
        sampledOn: input.sampledOn,
        sampledBy: input.sampledBy ?? null,
        notes: input.notes ?? null,
        createdBy: actorId,
      })
      .returning();
    await tx.insert(testingResults).values(
      analytes.map((a, i) => ({
        workspaceId,
        sampleId: sample!.id,
        sortOrder: i,
        category: a.category,
        name: a.name,
        unit: a.unit ?? null,
        min: a.min ?? null,
        max: a.max ?? null,
        limitText: a.limitText ?? null,
        method: a.method ?? null,
        specificationParameterId: a.specificationParameterId ?? null,
      })),
    );
    await recordChanges(tx, workspaceId, actorId, [sampleChange(sample!)]);
    return sample!.id;
  });
  return getSample(db, workspaceId, id, { showSpecification: active.includes("specifications") });
}

/**
 * Records (or corrects) results from a laboratory report. Each result is judged against the limit
 * copied onto it. Correcting a recorded result needs a reason and keeps the previous value in its
 * history. When the sample has failed: it opens an investigation (if none yet) and, for a lot that
 * is available, puts it on hold. The investigation stays open if a correction later passes it.
 */
export async function recordResults(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: TestResultsRecordInput,
  today: string,
  options: { showSpecification: boolean },
) {
  let notified: NotificationRow[] = [];
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const sample = await findSample(tx, workspaceId, id);
    if (sample.status === "cancelled")
      throw new ApiError(409, "sample_cancelled", "This sample was cancelled");
    if (input.reportedOn > today) throw badRequest("The report date can't be in the future");
    if (input.reportedOn < sample.sampledOn)
      throw badRequest("The report can't be dated before the sample was taken");
    const results = await resultsOf(tx, sample.id);
    const byId = new Map(results.map((r) => [r.id, r]));
    const now = new Date();
    const failedNames: string[] = [];
    for (const entry of input.results) {
      const result = byId.get(entry.resultId);
      if (!result) throw badRequest("A result doesn't belong to this sample");
      let outcome: "pass" | "fail";
      try {
        outcome = judgeResult(result, entry);
      } catch (err) {
        if (err instanceof TestJudgeError) throw badRequest(`${result.name}: ${err.message}`);
        throw err;
      }
      const history = [...result.history];
      if (result.outcome !== "pending") {
        if (!entry.correctionReason) {
          throw badRequest(`${result.name} already has a result: give a reason to correct it`);
        }
        const previous: TestResultHistoryEntry = {
          value: result.value,
          valueText: result.valueText,
          outcome: result.outcome,
          reportedOn: result.reportedOn,
          reportReference: result.reportReference,
          recordedBy: result.recordedBy,
          recordedAt: result.recordedAt?.toISOString() ?? null,
          reason: entry.correctionReason,
        };
        history.push(previous);
      }
      const [updated] = await tx
        .update(testingResults)
        .set({
          value: entry.value ?? null,
          valueText: entry.valueText ?? null,
          outcome,
          reportedOn: input.reportedOn,
          reportReference: input.reportReference ?? null,
          recordedBy: actorId,
          recordedAt: now,
          history,
        })
        .where(eq(testingResults.id, result.id))
        .returning();
      byId.set(result.id, updated!);
      if (outcome === "fail") failedNames.push(result.name);
    }
    const outcomes = [...byId.values()].map((r) => r.outcome as TestOutcome);
    const outcome = sampleOutcome(outcomes);
    const complete = !outcomes.includes("pending");
    const opening = outcome === "fail" && sample.investigationStatus === null;
    const changes: ChangeInput[] = [];

    let lotHeld = sample.lotHeld;
    if (failedNames.length && sample.lotId) {
      const [lot] = await tx.select().from(stockLots).where(eq(stockLots.id, sample.lotId));
      if (lot && lot.status === "available") {
        const [held] = await tx
          .update(stockLots)
          .set({
            status: "quarantine",
            statusChangedAt: now,
            statusChangedBy: actorId,
            statusNote: `On hold: test sample ${sample.reference} failed (${failedNames.join(", ")})`,
          })
          .where(eq(stockLots.id, lot.id))
          .returning();
        changes.push(lotChange(held!));
        lotHeld = true;
        notified = await notifyReservedLotStatus(tx, workspaceId, actorId, today, lot.id);
      }
    }

    const [updated] = await tx
      .update(testingSamples)
      .set({
        outcome,
        status: complete ? "complete" : "awaiting_results",
        completedAt: complete ? (sample.completedAt ?? now) : null,
        lotHeld,
        ...(opening ? { investigationStatus: "open" as const, investigationOpenedAt: now } : {}),
      })
      .where(eq(testingSamples.id, sample.id))
      .returning();
    changes.push(sampleChange(updated!));
    await recordChanges(tx, workspaceId, actorId, changes);
  });
  void deliverNotifications(db, notified);
  return getSample(db, workspaceId, id, options);
}

/** Cancels a sample that won't be tested (lost, spoiled, taken in error). Recorded results stay. */
export async function cancelSample(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: TestSampleCancelInput,
  options: { showSpecification: boolean },
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const sample = await findSample(tx, workspaceId, id);
    if (sample.status !== "awaiting_results") {
      throw new ApiError(409, "sample_not_open", "Only a sample awaiting results can be cancelled");
    }
    if (sample.outcome === "fail") {
      throw new ApiError(
        409,
        "sample_failed",
        "A failed sample can't be cancelled: close its investigation instead",
      );
    }
    const [row] = await tx
      .update(testingSamples)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelledBy: actorId, cancelReason: input.reason })
      .where(eq(testingSamples.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [sampleChange(row!)]);
  });
  return getSample(db, workspaceId, id, options);
}

/**
 * Closes a failed sample's investigation: a person with `manage` records the findings and what
 * was done. It doesn't release the lot; that is the stock module's QA decision.
 */
export async function closeInvestigation(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: TestInvestigationCloseInput,
  options: { showSpecification: boolean },
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const sample = await findSample(tx, workspaceId, id);
    if (sample.investigationStatus !== "open") {
      throw new ApiError(409, "no_open_investigation", "This sample has no open investigation");
    }
    if ((await resultsOf(tx, id)).some((r) => r.outcome === "pending")) {
      throw new ApiError(409, "results_pending", "Record every result before closing the investigation");
    }
    const [row] = await tx
      .update(testingSamples)
      .set({
        investigationStatus: "closed",
        findings: input.findings,
        rootCause: input.rootCause ?? null,
        actionTaken: input.actionTaken,
        investigationClosedAt: new Date(),
        investigationClosedBy: actorId,
      })
      .where(eq(testingSamples.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [sampleChange(row!)]);
  });
  return getSample(db, workspaceId, id, options);
}

// ─── Trends ──────────────────────────────────────────────────────────────────

export const TEST_TREND_MAX_POINTS = 1000;

/** One analyte's results over time (cancelled samples left out), with totals. */
export async function getTrend(db: Database, workspaceId: string, query: TestTrendQuery) {
  const rows = await db
    .select({
      sampleId: testingSamples.id,
      reference: testingSamples.reference,
      sampledOn: testingSamples.sampledOn,
      subject: testingSamples.subject,
      lotCode: stockLots.lotCode,
      itemCode: items.code,
      pointCode: testingSamplingPoints.code,
      zone: testingSamplingPoints.zone,
      name: testingResults.name,
      unit: testingResults.unit,
      min: testingResults.min,
      max: testingResults.max,
      limitText: testingResults.limitText,
      value: testingResults.value,
      valueText: testingResults.valueText,
      outcome: testingResults.outcome,
    })
    .from(testingResults)
    .innerJoin(testingSamples, eq(testingSamples.id, testingResults.sampleId))
    .leftJoin(stockLots, eq(stockLots.id, testingSamples.lotId))
    .leftJoin(items, eq(items.id, testingSamples.itemId))
    .leftJoin(testingSamplingPoints, eq(testingSamplingPoints.id, testingSamples.samplingPointId))
    .where(
      and(
        eq(testingResults.workspaceId, workspaceId),
        isNull(testingSamples.deletedAt),
        ne(testingSamples.status, "cancelled"),
        sql`lower(${testingResults.name}) = lower(${query.analyte})`,
        query.itemId ? eq(testingSamples.itemId, query.itemId) : undefined,
        query.samplingPointId ? eq(testingSamples.samplingPointId, query.samplingPointId) : undefined,
        query.zone ? sql`lower(${testingSamplingPoints.zone}) = lower(${query.zone})` : undefined,
        query.from ? gte(testingSamples.sampledOn, query.from) : undefined,
        query.to ? lte(testingSamples.sampledOn, query.to) : undefined,
      ),
    )
    .orderBy(asc(testingSamples.sampledOn), asc(testingSamples.reference))
    .limit(TEST_TREND_MAX_POINTS + 1);
  const points = rows.slice(0, TEST_TREND_MAX_POINTS);
  return {
    analyte: query.analyte,
    points,
    summary: summarizeTrend(points),
    truncated: rows.length > TEST_TREND_MAX_POINTS,
  };
}

/** Analyte names recorded in the workspace, for choosing a trend. */
export async function listAnalyteNames(db: Database, workspaceId: string) {
  const rows = await db
    .selectDistinct({ name: sql<string>`min(${testingResults.name})` })
    .from(testingResults)
    .where(eq(testingResults.workspaceId, workspaceId))
    .groupBy(sql`lower(${testingResults.name})`)
    .orderBy(sql`min(${testingResults.name})`);
  return { analytes: rows.map((r) => r.name) };
}
