import {
  governanceCultureState,
  governanceDueStatus,
  governanceSignBlockers,
  type GovernanceComplianceReviewInput,
  type GovernanceConcernSubmitInput,
  type GovernanceConcernUpdateInput,
  type GovernanceCultureCreateInput,
  type GovernanceCultureUpdateInput,
  type GovernanceObjectiveCreateInput,
  type GovernanceObjectiveUpdateInput,
  type GovernanceProgressInput,
  type GovernanceRequirementCreateInput,
  type GovernanceRequirementUpdateInput,
  type GovernanceReviewCreateInput,
  type GovernanceReviewUpdateInput,
  type ModuleId,
} from "@knotworking/core";
import {
  governanceConcerns,
  governanceCultureActivities,
  governanceObjectives,
  governanceRequirements,
  governanceReviews,
  lockWorkspaceLog,
  qualityAudits,
  qualityComplaints,
  qualityIncidents,
  qualityNonconformances,
  recordChanges,
  tasks,
  teams,
  testingSamples,
  users,
  workflowStates,
  workspaceMembers,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { defenceOverview } from "./defence";
import { createTask } from "./tasks";

/**
 * Governance (milestone 3.3.3): objectives and their progress, the culture plan, confidential
 * concerns, the requirement register, and management reviews that assemble evidence from the
 * modules the reader can see, record decisions and, when signed by a person with `manage`,
 * snapshot the evidence and create a follow-up task per decision.
 *
 * Confidential concerns never enter the sync log; anonymous ones store no trace of who raised them.
 */

const strip = <T extends { workspaceId: string; deletedAt: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
};
const change = (
  entity: ChangeInput["entity"],
  row: { id: string; workspaceId: string; deletedAt: Date | null },
) => ({
  entity,
  entityId: row.id,
  action: "upsert" as const,
  data: strip(row),
});

export async function userNames(db: Executor, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (!wanted.length) return new Map<string, string>();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((u) => [u.id, u.name]));
}

export async function assertMember(db: Executor, workspaceId: string, userId: string | null | undefined) {
  if (!userId) return;
  const [m] = await db
    .select({ id: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  if (!m) throw badRequest("The owner must be a member of the workspace");
}

// ─── Objectives ──────────────────────────────────────────────────────────────

type ObjectiveRow = typeof governanceObjectives.$inferSelect;

async function findObjective(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(governanceObjectives)
    .where(
      and(
        eq(governanceObjectives.id, id),
        eq(governanceObjectives.workspaceId, workspaceId),
        isNull(governanceObjectives.deletedAt),
      ),
    );
  if (!row) throw notFound("Objective");
  return row;
}

const objectiveView = (o: ObjectiveRow, names: Map<string, string>, today: string) => ({
  ...strip(o),
  ownerName: o.ownerUserId ? (names.get(o.ownerUserId) ?? null) : null,
  dueStatus: o.status === "open" ? governanceDueStatus(o.dueOn, today) : ("ok" as const),
  latest: o.progress.at(-1) ?? null,
});

export async function listObjectives(db: Executor, workspaceId: string, today: string) {
  const rows = await db
    .select()
    .from(governanceObjectives)
    .where(and(eq(governanceObjectives.workspaceId, workspaceId), isNull(governanceObjectives.deletedAt)))
    .orderBy(
      sql`case ${governanceObjectives.status} when 'open' then 0 else 1 end`,
      sql`${governanceObjectives.dueOn} asc nulls last`,
    );
  const names = await userNames(
    db,
    rows.map((r) => r.ownerUserId),
  );
  return { objectives: rows.map((o) => objectiveView(o, names, today)) };
}

export async function createObjective(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: GovernanceObjectiveCreateInput,
  today: string,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertMember(tx, workspaceId, input.ownerUserId);
    const [row] = await tx
      .insert(governanceObjectives)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        title: input.title,
        category: input.category,
        measure: input.measure ?? null,
        target: input.target ?? null,
        ownerUserId: input.ownerUserId ?? null,
        dueOn: input.dueOn ?? null,
        createdBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("governance_objective", row!)]);
    return row!;
  });
  return objectiveView(row, await userNames(db, [row.ownerUserId]), today);
}

export async function updateObjective(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: GovernanceObjectiveUpdateInput,
  today: string,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findObjective(tx, workspaceId, id);
    await assertMember(tx, workspaceId, patch.ownerUserId);
    const closing = patch.status && patch.status !== "open" && current.status === "open";
    const [row] = await tx
      .update(governanceObjectives)
      .set({
        ...patch,
        ...(closing ? { closedAt: new Date() } : patch.status === "open" ? { closedAt: null } : {}),
      })
      .where(eq(governanceObjectives.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("governance_objective", row!)]);
    return row!;
  });
  return objectiveView(row, await userNames(db, [row.ownerUserId]), today);
}

export async function recordProgress(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: GovernanceProgressInput,
  today: string,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findObjective(tx, workspaceId, id);
    if (current.status !== "open") throw new ApiError(409, "objective_closed", "This objective is closed");
    if (input.on > today) throw badRequest("The progress date can't be in the future");
    const [actor] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actorId));
    const progress = [
      ...current.progress,
      {
        on: input.on,
        rag: input.rag,
        value: input.value ?? null,
        note: input.note,
        by: actorId,
        byName: actor?.name ?? null,
        at: new Date().toISOString(),
      },
    ].sort((a, b) => a.on.localeCompare(b.on) || a.at.localeCompare(b.at));
    const [row] = await tx
      .update(governanceObjectives)
      .set({ progress })
      .where(eq(governanceObjectives.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("governance_objective", row!)]);
    return row!;
  });
  return objectiveView(row, await userNames(db, [row.ownerUserId]), today);
}

// ─── Culture plan ────────────────────────────────────────────────────────────

type CultureRow = typeof governanceCultureActivities.$inferSelect;
const cultureView = (a: CultureRow, names: Map<string, string>, today: string) => ({
  ...strip(a),
  ownerName: a.ownerUserId ? (names.get(a.ownerUserId) ?? null) : null,
  state: governanceCultureState(a, today),
});

export async function listCulture(db: Executor, workspaceId: string, today: string) {
  const rows = await db
    .select()
    .from(governanceCultureActivities)
    .where(
      and(
        eq(governanceCultureActivities.workspaceId, workspaceId),
        isNull(governanceCultureActivities.deletedAt),
      ),
    )
    .orderBy(desc(governanceCultureActivities.plannedOn));
  const names = await userNames(
    db,
    rows.map((r) => r.ownerUserId),
  );
  return { activities: rows.map((a) => cultureView(a, names, today)) };
}

async function assertObjective(db: Executor, workspaceId: string, id: string | null | undefined) {
  if (id) await findObjective(db, workspaceId, id);
}

export async function createCulture(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: GovernanceCultureCreateInput,
  today: string,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertMember(tx, workspaceId, input.ownerUserId);
    await assertObjective(tx, workspaceId, input.objectiveId);
    const [row] = await tx
      .insert(governanceCultureActivities)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        title: input.title,
        kind: input.kind,
        plannedOn: input.plannedOn,
        ownerUserId: input.ownerUserId ?? null,
        measure: input.measure ?? null,
        objectiveId: input.objectiveId ?? null,
        createdBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("governance_culture_activity", row!)]);
    return row!;
  });
  return cultureView(row, await userNames(db, [row.ownerUserId]), today);
}

export async function updateCulture(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: GovernanceCultureUpdateInput,
  today: string,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [current] = await tx
      .select()
      .from(governanceCultureActivities)
      .where(
        and(
          eq(governanceCultureActivities.id, id),
          eq(governanceCultureActivities.workspaceId, workspaceId),
          isNull(governanceCultureActivities.deletedAt),
        ),
      );
    if (!current) throw notFound("Activity");
    await assertMember(tx, workspaceId, patch.ownerUserId);
    await assertObjective(tx, workspaceId, patch.objectiveId);
    if (patch.completedOn && patch.completedOn > today) throw badRequest("It can't be done in the future");
    const { cancelled, ...fields } = patch;
    const [row] = await tx
      .update(governanceCultureActivities)
      .set({
        ...fields,
        ...(cancelled === true
          ? { cancelledAt: new Date() }
          : cancelled === false
            ? { cancelledAt: null }
            : {}),
      })
      .where(eq(governanceCultureActivities.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("governance_culture_activity", row!)]);
    return row!;
  });
  return cultureView(row, await userNames(db, [row.ownerUserId]), today);
}

// ─── Confidential concerns ───────────────────────────────────────────────────

/** Anyone in the workspace raises a concern. Never synced. */
export async function submitConcern(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: GovernanceConcernSubmitInput,
  today: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [last] = await tx
      .select({
        n: sql<number>`coalesce(max((substring(${governanceConcerns.reference} from '^CON-([0-9]+)$'))::int), 0)`,
      })
      .from(governanceConcerns)
      .where(eq(governanceConcerns.workspaceId, workspaceId));
    const reference = `CON-${String(Number(last?.n ?? 0) + 1).padStart(4, "0")}`;
    const [row] = await tx
      .insert(governanceConcerns)
      .values({
        workspaceId,
        reference,
        category: input.category,
        description: input.description,
        raisedBy: input.anonymous ? null : actorId,
        raisedOn: today,
      })
      .returning();
    // Deliberately not in the sync log (confidential).
    return {
      reference: row!.reference,
      anonymous: input.anonymous,
      raisedOn: row!.raisedOn,
    };
  });
}

/** The caller's own named concerns, with status and the outcome they are told. */
export async function myConcerns(db: Executor, workspaceId: string, actorId: string) {
  const rows = await db
    .select({
      id: governanceConcerns.id,
      reference: governanceConcerns.reference,
      category: governanceConcerns.category,
      raisedOn: governanceConcerns.raisedOn,
      status: governanceConcerns.status,
      outcome: governanceConcerns.outcome,
    })
    .from(governanceConcerns)
    .where(
      and(
        eq(governanceConcerns.workspaceId, workspaceId),
        eq(governanceConcerns.raisedBy, actorId),
        isNull(governanceConcerns.deletedAt),
      ),
    )
    .orderBy(desc(governanceConcerns.raisedOn), desc(governanceConcerns.createdAt));
  return { concerns: rows };
}

export async function listConcerns(db: Executor, workspaceId: string) {
  const rows = await db
    .select()
    .from(governanceConcerns)
    .where(and(eq(governanceConcerns.workspaceId, workspaceId), isNull(governanceConcerns.deletedAt)))
    .orderBy(
      sql`case ${governanceConcerns.status} when 'open' then 0 when 'investigating' then 1 else 2 end`,
      desc(governanceConcerns.raisedOn),
      desc(governanceConcerns.createdAt),
    );
  const names = await userNames(
    db,
    rows.flatMap((r) => [r.raisedBy, r.handledBy]),
  );
  return {
    concerns: rows.map((r) => ({
      ...strip(r),
      raisedByName: r.raisedBy ? (names.get(r.raisedBy) ?? null) : null,
      anonymous: !r.raisedBy,
      handledByName: r.handledBy ? (names.get(r.handledBy) ?? null) : null,
    })),
  };
}

export async function updateConcern(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: GovernanceConcernUpdateInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [current] = await tx
      .select()
      .from(governanceConcerns)
      .where(
        and(
          eq(governanceConcerns.id, id),
          eq(governanceConcerns.workspaceId, workspaceId),
          isNull(governanceConcerns.deletedAt),
        ),
      );
    if (!current) throw notFound("Concern");
    if (current.status === "closed" && patch.status !== "open" && patch.status !== "investigating")
      throw new ApiError(409, "concern_closed", "Reopen the concern to change it");
    const status = patch.status ?? current.status;
    if (status === "closed" && !(patch.outcome ?? current.outcome))
      throw badRequest("Say what was done before closing it");
    await tx
      .update(governanceConcerns)
      .set({
        ...patch,
        handledBy: actorId,
        closedAt: status === "closed" ? (current.closedAt ?? new Date()) : null,
      })
      .where(eq(governanceConcerns.id, id));
  });
  const { concerns } = await listConcerns(db, workspaceId);
  return concerns.find((c) => c.id === id)!;
}

// ─── Requirements register ───────────────────────────────────────────────────

type RequirementRow = typeof governanceRequirements.$inferSelect;
const requirementView = (r: RequirementRow, names: Map<string, string>, today: string) => ({
  ...strip(r),
  ownerName: r.ownerUserId ? (names.get(r.ownerUserId) ?? null) : null,
  lastReviewedByName: r.lastReviewedBy ? (names.get(r.lastReviewedBy) ?? null) : null,
  reviewStatus: r.status === "active" ? governanceDueStatus(r.reviewDueOn, today) : ("ok" as const),
});

async function findRequirement(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(governanceRequirements)
    .where(
      and(
        eq(governanceRequirements.id, id),
        eq(governanceRequirements.workspaceId, workspaceId),
        isNull(governanceRequirements.deletedAt),
      ),
    );
  if (!row) throw notFound("Requirement");
  return row;
}

export async function listRequirements(db: Executor, workspaceId: string, today: string) {
  const rows = await db
    .select()
    .from(governanceRequirements)
    .where(and(eq(governanceRequirements.workspaceId, workspaceId), isNull(governanceRequirements.deletedAt)))
    .orderBy(
      asc(governanceRequirements.status),
      asc(governanceRequirements.source),
      asc(governanceRequirements.title),
    );
  const names = await userNames(
    db,
    rows.flatMap((r) => [r.ownerUserId, r.lastReviewedBy]),
  );
  return { requirements: rows.map((r) => requirementView(r, names, today)) };
}

export async function createRequirement(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: GovernanceRequirementCreateInput,
  today: string,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertMember(tx, workspaceId, input.ownerUserId);
    const [row] = await tx
      .insert(governanceRequirements)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        source: input.source,
        reference: input.reference ?? null,
        title: input.title,
        customerName: input.customerName ?? null,
        description: input.description ?? null,
        ownerUserId: input.ownerUserId ?? null,
        reviewDueOn: input.reviewDueOn ?? null,
        createdBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("governance_requirement", row!)]);
    return row!;
  });
  return requirementView(row, await userNames(db, [row.ownerUserId]), today);
}

export async function updateRequirement(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: GovernanceRequirementUpdateInput,
  today: string,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findRequirement(tx, workspaceId, id);
    await assertMember(tx, workspaceId, patch.ownerUserId);
    const [row] = await tx
      .update(governanceRequirements)
      .set(patch)
      .where(eq(governanceRequirements.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("governance_requirement", row!)]);
    return row!;
  });
  return requirementView(row, await userNames(db, [row.ownerUserId, row.lastReviewedBy]), today);
}

/** A person's compliance review: the status found, notes, and when to look again. */
export async function reviewRequirement(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: GovernanceComplianceReviewInput,
  today: string,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findRequirement(tx, workspaceId, id);
    if (current.status !== "active")
      throw new ApiError(409, "requirement_archived", "This requirement is archived");
    if (input.reviewedOn > today) throw badRequest("The review date can't be in the future");
    if (input.nextReviewOn <= input.reviewedOn) throw badRequest("The next review must be after this one");
    const [row] = await tx
      .update(governanceRequirements)
      .set({
        compliance: input.compliance,
        lastReviewedOn: input.reviewedOn,
        lastReviewedBy: actorId,
        reviewNotes: input.notes ?? null,
        reviewDueOn: input.nextReviewOn,
      })
      .where(eq(governanceRequirements.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("governance_requirement", row!)]);
    return row!;
  });
  return requirementView(row, await userNames(db, [row.ownerUserId, row.lastReviewedBy]), today);
}

// ─── Evidence ────────────────────────────────────────────────────────────────

type Section<T> = ({ available: true } & T) | { available: false; reason: string };
const unavailable = (module: string) => ({
  available: false as const,
  reason: `${module} is off or you can't read it`,
});

/** Dates as timestamps at the start of `from` and the end of `to` (UTC), for timestamp columns. */
const range = (from: string, to: string) =>
  [new Date(`${from}T00:00:00Z`), new Date(`${to}T23:59:59.999Z`)] as const;

/**
 * The evidence for a management review over a period, from the modules the reader can see.
 * Counts and short lists only: a review links to the records, it doesn't copy them.
 */
export async function assembleEvidence(
  db: Executor,
  workspaceId: string,
  period: { from: string; to: string },
  today: string,
  readable: (m: ModuleId) => boolean,
  excludeReviewId?: string,
) {
  const { from, to } = period;
  const [start, end] = range(from, to);
  const n = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0);

  const quality = readable("quality");
  const complaints: Section<{
    received: number;
    justified: number;
    open: number;
    bySeverity: Record<string, number>;
  }> = quality
    ? await (async () => {
        const inPeriod = and(
          eq(qualityComplaints.workspaceId, workspaceId),
          isNull(qualityComplaints.deletedAt),
          gte(qualityComplaints.receivedOn, from),
          lte(qualityComplaints.receivedOn, to),
        );
        const bySeverity = await db
          .select({ severity: qualityComplaints.severity, n: count() })
          .from(qualityComplaints)
          .where(inPeriod)
          .groupBy(qualityComplaints.severity);
        return {
          available: true as const,
          received: bySeverity.reduce((s, r) => s + Number(r.n), 0),
          justified: n(
            await db
              .select({ n: count() })
              .from(qualityComplaints)
              .where(and(inPeriod, eq(qualityComplaints.justified, true))),
          ),
          open: n(
            await db
              .select({ n: count() })
              .from(qualityComplaints)
              .where(
                and(
                  eq(qualityComplaints.workspaceId, workspaceId),
                  isNull(qualityComplaints.deletedAt),
                  ne(qualityComplaints.status, "closed"),
                ),
              ),
          ),
          bySeverity: Object.fromEntries(bySeverity.map((r) => [r.severity, Number(r.n)])),
        };
      })()
    : unavailable("Quality");

  const nonconformances: Section<{ raised: number; closed: number; open: number; overdue: number }> = quality
    ? await (async () => {
        const live = and(
          eq(qualityNonconformances.workspaceId, workspaceId),
          isNull(qualityNonconformances.deletedAt),
        );
        return {
          available: true as const,
          raised: n(
            await db
              .select({ n: count() })
              .from(qualityNonconformances)
              .where(
                and(
                  live,
                  gte(qualityNonconformances.raisedOn, from),
                  lte(qualityNonconformances.raisedOn, to),
                ),
              ),
          ),
          closed: n(
            await db
              .select({ n: count() })
              .from(qualityNonconformances)
              .where(
                and(
                  live,
                  gte(qualityNonconformances.closedAt, start),
                  lte(qualityNonconformances.closedAt, end),
                ),
              ),
          ),
          open: n(
            await db
              .select({ n: count() })
              .from(qualityNonconformances)
              .where(and(live, ne(qualityNonconformances.status, "closed"))),
          ),
          overdue: n(
            await db
              .select({ n: count() })
              .from(qualityNonconformances)
              .where(
                and(
                  live,
                  ne(qualityNonconformances.status, "closed"),
                  lt(qualityNonconformances.dueOn, today),
                ),
              ),
          ),
        };
      })()
    : unavailable("Quality");

  const audits: Section<{ completed: number; overdue: number; findings: number }> = quality
    ? await (async () => {
        const live = and(eq(qualityAudits.workspaceId, workspaceId), isNull(qualityAudits.deletedAt));
        return {
          available: true as const,
          completed: n(
            await db
              .select({ n: count() })
              .from(qualityAudits)
              .where(and(live, gte(qualityAudits.completedOn, from), lte(qualityAudits.completedOn, to))),
          ),
          overdue: n(
            await db
              .select({ n: count() })
              .from(qualityAudits)
              .where(and(live, eq(qualityAudits.status, "planned"), lt(qualityAudits.plannedOn, today))),
          ),
          findings: n(
            await db
              .select({ n: count() })
              .from(qualityNonconformances)
              .where(
                and(
                  eq(qualityNonconformances.workspaceId, workspaceId),
                  isNull(qualityNonconformances.deletedAt),
                  isNotNull(qualityNonconformances.auditId),
                  gte(qualityNonconformances.raisedOn, from),
                  lte(qualityNonconformances.raisedOn, to),
                ),
              ),
          ),
        };
      })()
    : unavailable("Quality");

  const incidents: Section<{ opened: number; open: number; byKind: Record<string, number> }> = quality
    ? await (async () => {
        const byKind = await db
          .select({ kind: qualityIncidents.kind, n: count() })
          .from(qualityIncidents)
          .where(
            and(
              eq(qualityIncidents.workspaceId, workspaceId),
              gte(qualityIncidents.createdAt, start),
              lte(qualityIncidents.createdAt, end),
            ),
          )
          .groupBy(qualityIncidents.kind);
        return {
          available: true as const,
          opened: byKind.reduce((s, r) => s + Number(r.n), 0),
          open: n(
            await db
              .select({ n: count() })
              .from(qualityIncidents)
              .where(and(eq(qualityIncidents.workspaceId, workspaceId), eq(qualityIncidents.status, "open"))),
          ),
          byKind: Object.fromEntries(byKind.map((r) => [r.kind, Number(r.n)])),
        };
      })()
    : unavailable("Quality");

  const testing: Section<{ sampled: number; failed: number; openInvestigations: number }> = readable(
    "testing",
  )
    ? await (async () => {
        const live = and(
          eq(testingSamples.workspaceId, workspaceId),
          isNull(testingSamples.deletedAt),
          ne(testingSamples.status, "cancelled"),
        );
        const inPeriod = and(live, gte(testingSamples.sampledOn, from), lte(testingSamples.sampledOn, to));
        return {
          available: true as const,
          sampled: n(await db.select({ n: count() }).from(testingSamples).where(inPeriod)),
          failed: n(
            await db
              .select({ n: count() })
              .from(testingSamples)
              .where(and(inPeriod, eq(testingSamples.outcome, "fail"))),
          ),
          openInvestigations: n(
            await db
              .select({ n: count() })
              .from(testingSamples)
              .where(and(live, eq(testingSamples.investigationStatus, "open"))),
          ),
        };
      })()
    : unavailable("Testing");

  const defence: Section<{
    overdueControls: number;
    openFailures: number;
    assessmentsDue: number;
    exerciseOverdue: boolean;
  }> = readable("defence")
    ? await (async () => {
        const o = await defenceOverview(db, workspaceId, today, { visitors: false });
        return {
          available: true as const,
          overdueControls: o.counts.overdueControls,
          openFailures: o.counts.openFailures,
          assessmentsDue: o.assessmentsDue.length,
          exerciseOverdue: o.exerciseOverdue,
        };
      })()
    : unavailable("Food defence");

  // Governance's own records (the reader has Governance).
  const { objectives } = await listObjectives(db, workspaceId, today);
  const { activities } = await listCulture(db, workspaceId, today);
  const inPeriod = (d: string | null) => !!d && d >= from && d <= to;
  const concernCounts = await db
    .select({ status: governanceConcerns.status, n: count() })
    .from(governanceConcerns)
    .where(and(eq(governanceConcerns.workspaceId, workspaceId), isNull(governanceConcerns.deletedAt)))
    .groupBy(governanceConcerns.status);
  const concernsRaised = n(
    await db
      .select({ n: count() })
      .from(governanceConcerns)
      .where(
        and(
          eq(governanceConcerns.workspaceId, workspaceId),
          isNull(governanceConcerns.deletedAt),
          gte(governanceConcerns.raisedOn, from),
          lte(governanceConcerns.raisedOn, to),
        ),
      ),
  );
  const { requirements } = await listRequirements(db, workspaceId, today);
  const activeReqs = requirements.filter((r) => r.status === "active");

  // Actions from earlier signed reviews and where their tasks stand.
  const earlier = await db
    .select({
      id: governanceReviews.id,
      title: governanceReviews.title,
      decisions: governanceReviews.decisions,
    })
    .from(governanceReviews)
    .where(
      and(
        eq(governanceReviews.workspaceId, workspaceId),
        isNull(governanceReviews.deletedAt),
        eq(governanceReviews.status, "signed"),
        excludeReviewId ? ne(governanceReviews.id, excludeReviewId) : undefined,
      ),
    )
    .orderBy(desc(governanceReviews.periodTo))
    .limit(5);
  const taskIds = earlier.flatMap((r) => r.decisions.map((d) => d.taskId).filter((t): t is string => !!t));
  const taskStates =
    taskIds.length && readable("tasks")
      ? await db
          .select({
            id: tasks.id,
            type: workflowStates.type,
            dueDate: tasks.dueDate,
            deletedAt: tasks.deletedAt,
          })
          .from(tasks)
          .innerJoin(workflowStates, eq(workflowStates.id, tasks.stateId))
          .where(inArray(tasks.id, taskIds))
      : [];
  const stateOf = new Map(taskStates.map((t) => [t.id, t]));
  const previousActions = earlier.flatMap((r) =>
    r.decisions.map((d) => {
      const t = d.taskId ? stateOf.get(d.taskId) : undefined;
      const done = t?.type === "completed";
      return {
        review: r.title,
        decision: d.decision,
        dueOn: d.dueOn,
        taskId: d.taskId ?? null,
        state: !t
          ? ("unknown" as const)
          : t.type === "canceled" || t.deletedAt
            ? ("cancelled" as const)
            : done
              ? ("done" as const)
              : d.dueOn && d.dueOn < today
                ? ("overdue" as const)
                : ("open" as const),
      };
    }),
  );

  return {
    period: { from, to },
    assembledOn: today,
    previousActions,
    objectives: {
      open: objectives.filter((o) => o.status === "open").length,
      achievedInPeriod: objectives.filter(
        (o) => o.status === "achieved" && o.closedAt && inPeriod(o.closedAt.toISOString().slice(0, 10)),
      ).length,
      missedInPeriod: objectives.filter(
        (o) => o.status === "missed" && o.closedAt && inPeriod(o.closedAt.toISOString().slice(0, 10)),
      ).length,
      offTrack: objectives.filter((o) => o.status === "open" && o.latest?.rag === "off_track").length,
      atRisk: objectives.filter((o) => o.status === "open" && o.latest?.rag === "at_risk").length,
      overdue: objectives.filter((o) => o.dueStatus === "overdue").length,
      list: objectives
        .filter((o) => o.status === "open")
        .map((o) => ({
          id: o.id,
          title: o.title,
          rag: o.latest?.rag ?? null,
          value: o.latest?.value ?? null,
          dueOn: o.dueOn,
        })),
    },
    culture: {
      plannedInPeriod: activities.filter((a) => inPeriod(a.plannedOn) && a.state !== "cancelled").length,
      doneInPeriod: activities.filter((a) => inPeriod(a.completedOn)).length,
      overdue: activities.filter((a) => a.state === "overdue").length,
      done: activities
        .filter((a) => inPeriod(a.completedOn))
        .map((a) => ({
          id: a.id,
          title: a.title,
          completedOn: a.completedOn,
          participants: a.participants,
          result: a.result,
        })),
    },
    concerns: {
      raisedInPeriod: concernsRaised,
      open: concernCounts.filter((c) => c.status !== "closed").reduce((s, c) => s + Number(c.n), 0),
    },
    requirements: {
      total: activeReqs.length,
      byCompliance: Object.fromEntries(
        ["compliant", "partial", "non_compliant", "not_assessed"].map((s) => [
          s,
          activeReqs.filter((r) => r.compliance === s).length,
        ]),
      ),
      reviewOverdue: activeReqs.filter((r) => r.reviewStatus === "overdue").length,
    },
    complaints,
    nonconformances,
    audits,
    incidents,
    testing,
    defence,
  };
}

export type GovernanceEvidence = Awaited<ReturnType<typeof assembleEvidence>>;

/**
 * A signed review's snapshot as the current reader may see it. The stored snapshot never changes,
 * but it holds whatever the signer could read, so each section from another module is shown only
 * to readers who can read that module now (as `assembleEvidence` does for a draft).
 */
export function evidenceForReader(
  evidence: GovernanceEvidence,
  readable: (m: ModuleId) => boolean,
): GovernanceEvidence {
  const quality = readable("quality");
  return {
    ...evidence,
    previousActions: readable("tasks")
      ? evidence.previousActions
      : evidence.previousActions.map((a) => ({ ...a, state: "unknown" as const })),
    complaints: quality ? evidence.complaints : unavailable("Quality"),
    nonconformances: quality ? evidence.nonconformances : unavailable("Quality"),
    audits: quality ? evidence.audits : unavailable("Quality"),
    incidents: quality ? evidence.incidents : unavailable("Quality"),
    testing: readable("testing") ? evidence.testing : unavailable("Testing"),
    defence: readable("defence") ? evidence.defence : unavailable("Food defence"),
  };
}

// ─── Management reviews ──────────────────────────────────────────────────────

type ReviewRow = typeof governanceReviews.$inferSelect;
const reviewChange = (r: ReviewRow): ChangeInput => ({
  entity: "governance_review",
  entityId: r.id,
  action: "upsert",
  // Metadata only: the notes and evidence are read through the endpoint.
  data: {
    id: r.id,
    title: r.title,
    periodFrom: r.periodFrom,
    periodTo: r.periodTo,
    heldOn: r.heldOn,
    status: r.status,
    signedAt: r.signedAt,
    updatedAt: r.updatedAt,
  },
});

async function findReview(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(governanceReviews)
    .where(
      and(
        eq(governanceReviews.id, id),
        eq(governanceReviews.workspaceId, workspaceId),
        isNull(governanceReviews.deletedAt),
      ),
    );
  if (!row) throw notFound("Review");
  return row;
}

export async function listReviews(db: Executor, workspaceId: string) {
  const rows = await db
    .select()
    .from(governanceReviews)
    .where(and(eq(governanceReviews.workspaceId, workspaceId), isNull(governanceReviews.deletedAt)))
    .orderBy(desc(governanceReviews.periodTo));
  return {
    reviews: rows.map((r) => ({
      id: r.id,
      title: r.title,
      periodFrom: r.periodFrom,
      periodTo: r.periodTo,
      heldOn: r.heldOn,
      status: r.status,
      signedAt: r.signedAt,
      decisions: r.decisions.length,
    })),
  };
}

export async function getReview(
  db: Executor,
  workspaceId: string,
  id: string,
  today: string,
  readable: (m: ModuleId) => boolean,
  active: readonly ModuleId[],
) {
  const r = await findReview(db, workspaceId, id);
  const names = await userNames(db, [r.signedBy, r.createdBy, ...r.decisions.map((d) => d.ownerUserId)]);
  const [team] = r.followUpTeamId
    ? await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.id, r.followUpTeamId))
    : [];
  const evidence: GovernanceEvidence =
    r.status === "signed" && r.evidence
      ? evidenceForReader(r.evidence as GovernanceEvidence, readable)
      : await assembleEvidence(
          db,
          workspaceId,
          { from: r.periodFrom, to: r.periodTo },
          today,
          readable,
          r.id,
        );
  return {
    ...strip(r),
    evidence,
    /** Live for a draft; the snapshot taken at signing for a signed review. */
    evidenceIsSnapshot: r.status === "signed",
    signedByName: r.signedBy ? (names.get(r.signedBy) ?? null) : null,
    followUpTeam: team ?? null,
    decisions: r.decisions.map((d) => ({
      ...d,
      ownerName: d.ownerUserId ? (names.get(d.ownerUserId) ?? null) : null,
    })),
    signBlockers:
      r.status === "draft"
        ? governanceSignBlockers({ ...r, tasksActive: active.includes("tasks") }, today)
        : [],
  };
}

export async function createReview(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: GovernanceReviewCreateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [row] = await tx
      .insert(governanceReviews)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        title: input.title,
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
        heldOn: input.heldOn ?? null,
        createdBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [reviewChange(row!)]);
    return { id: row!.id };
  });
}

export async function updateReview(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: GovernanceReviewUpdateInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findReview(tx, workspaceId, id);
    if (current.status === "signed")
      throw new ApiError(409, "review_signed", "A signed review no longer changes");
    const from = patch.periodFrom ?? current.periodFrom;
    const to = patch.periodTo ?? current.periodTo;
    if (from > to) throw badRequest("The period ends before it starts");
    if (patch.decisions) {
      const ids = new Set<string>();
      for (const d of patch.decisions) {
        if (ids.has(d.id)) throw badRequest("A decision appears twice");
        ids.add(d.id);
        await assertMember(tx, workspaceId, d.ownerUserId);
      }
    }
    if (patch.followUpTeamId) {
      const [team] = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(
          and(
            eq(teams.id, patch.followUpTeamId),
            eq(teams.workspaceId, workspaceId),
            isNull(teams.deletedAt),
          ),
        );
      if (!team) throw badRequest("That team doesn't exist");
    }
    const [row] = await tx
      .update(governanceReviews)
      .set(patch)
      .where(eq(governanceReviews.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [reviewChange(row!)]);
  });
}

/**
 * Signs the review (a person with manage): snapshots the evidence, and creates a task in the
 * follow-up team for each decision with an owner, assigned to them with its due date. All or
 * nothing: if a task can't be created, nothing is signed.
 */
export async function signReview(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  today: string,
  readable: (m: ModuleId) => boolean,
  active: readonly ModuleId[],
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const r = await findReview(tx, workspaceId, id);
    if (r.status === "signed") throw new ApiError(409, "review_signed", "This review is already signed");
    const tasksActive = active.includes("tasks");
    const blockers = governanceSignBlockers({ ...r, tasksActive }, today);
    if (blockers.length)
      throw new ApiError(409, "not_ready", `Can't sign yet: ${blockers.join("; ")}`, { blockers });
    const evidence = await assembleEvidence(
      tx,
      workspaceId,
      { from: r.periodFrom, to: r.periodTo },
      today,
      readable,
      r.id,
    );
    const decisions = [];
    for (const d of r.decisions) {
      let taskId: string | null = null;
      if (tasksActive && d.ownerUserId && r.followUpTeamId) {
        // Savepoint inside this transaction: a failure rolls back the signing too.
        const task = await createTask(tx as unknown as Database, workspaceId, actorId, {
          teamId: r.followUpTeamId,
          title: `${r.title}: ${d.decision}`.slice(0, 512),
          assigneeId: d.ownerUserId,
          dueDate: d.dueOn,
        });
        taskId = task.id;
      }
      decisions.push({ ...d, taskId });
    }
    const [row] = await tx
      .update(governanceReviews)
      .set({ status: "signed", signedAt: new Date(), signedBy: actorId, evidence, decisions })
      .where(eq(governanceReviews.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [reviewChange(row!)]);
  });
  return getReview(db, workspaceId, id, today, readable, active);
}

/** The governance dashboard: what's overdue or needs attention. */
export async function governanceOverview(
  db: Executor,
  workspaceId: string,
  today: string,
  canSeeConcerns: boolean,
) {
  const [{ objectives }, { activities }, { requirements }, { reviews }] = await Promise.all([
    listObjectives(db, workspaceId, today),
    listCulture(db, workspaceId, today),
    listRequirements(db, workspaceId, today),
    listReviews(db, workspaceId),
  ]);
  const openConcerns = canSeeConcerns
    ? Number(
        (
          await db
            .select({ n: count() })
            .from(governanceConcerns)
            .where(
              and(
                eq(governanceConcerns.workspaceId, workspaceId),
                isNull(governanceConcerns.deletedAt),
                ne(governanceConcerns.status, "closed"),
              ),
            )
        )[0]?.n ?? 0,
      )
    : null;
  const lastSigned = reviews.find((r) => r.status === "signed") ?? null;
  return {
    objectivesNeedingAttention: objectives.filter(
      (o) =>
        o.status === "open" &&
        (o.dueStatus === "overdue" || o.latest?.rag === "off_track" || o.latest?.rag === "at_risk"),
    ),
    cultureOverdue: activities.filter((a) => a.state === "overdue"),
    cultureUpcoming: activities
      .filter((a) => a.state === "planned")
      .slice(-5)
      .reverse(),
    requirementsDue: requirements.filter(
      (r) =>
        r.status === "active" &&
        (r.reviewStatus === "overdue" ||
          r.reviewStatus === "due_soon" ||
          r.compliance === "non_compliant" ||
          r.compliance === "not_assessed"),
    ),
    openConcerns,
    lastSignedReview: lastSigned,
    draftReviews: reviews.filter((r) => r.status === "draft"),
  };
}
