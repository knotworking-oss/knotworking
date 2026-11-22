import {
  DEFENCE_EXERCISE_INTERVAL_DAYS,
  addDays,
  defenceApprovalBlockers,
  defenceControlDue,
  defenceReviewStatus,
  defenceThreatRating,
  diffDefenceThreats,
  type DefenceApproveInput,
  type DefenceAssessmentCreateInput,
  type DefenceAssessmentUpdateInput,
  type DefenceCheckInput,
  type DefenceCheckListQuery,
  type DefenceCheckResolveInput,
  type DefenceControlCreateInput,
  type DefenceControlUpdateInput,
  type DefenceDraftInput,
  type DefenceExerciseInput,
  type DefenceReviewStartInput,
  type DefenceThreat,
} from "@knotworking/core";
import {
  attendanceVisits,
  defenceAssessmentVersions,
  defenceAssessments,
  defenceChecks,
  defenceControls,
  defenceExercises,
  lockWorkspaceLog,
  recordChanges,
  users,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, count, desc, eq, inArray, isNull, max, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import { ApiError, badRequest, notFound } from "../errors";

/**
 * Food defence (milestone 3.3.2): versioned threat assessments, security controls with their
 * checks, and exercises. Approving an assessment, recording a check, resolving a failure and
 * recording an exercise are a person's acts (routes refuse tokens). The sync log carries metadata
 * only: what the threats are, what a check found and what an exercise showed stay behind the
 * endpoints.
 */

type AssessmentRow = typeof defenceAssessments.$inferSelect;
type VersionRow = typeof defenceAssessmentVersions.$inferSelect;
type ControlRow = typeof defenceControls.$inferSelect;
type CheckRow = typeof defenceChecks.$inferSelect;
type ExerciseRow = typeof defenceExercises.$inferSelect;

const strip = <T extends { workspaceId: string; deletedAt: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
};

/**
 * A stamp of everything a manager reviews in a draft. Approval must send the stamp it was shown,
 * so an edit (or a different draft) between loading and pressing Approve is refused, not signed.
 */
export const draftRevision = (v: VersionRow) =>
  createHash("sha256")
    .update(JSON.stringify([v.id, v.summary, v.threats, v.reviewDueOn, v.reviewTrigger, v.reviewReason]))
    .digest("hex");

// Sync: metadata only.
const assessmentChange = (r: AssessmentRow): ChangeInput => ({
  entity: "defence_assessment",
  entityId: r.id,
  action: "upsert",
  data: { id: r.id, title: r.title, status: r.status, updatedAt: r.updatedAt },
});
const versionChange = (r: VersionRow): ChangeInput => ({
  entity: "defence_assessment_version",
  entityId: r.id,
  action: "upsert",
  data: {
    id: r.id,
    assessmentId: r.assessmentId,
    versionNumber: r.versionNumber,
    status: r.status,
    threatCount: r.threats.length,
    reviewDueOn: r.reviewDueOn,
    approvedAt: r.approvedAt,
    updatedAt: r.updatedAt,
  },
});
const controlChange = (r: ControlRow): ChangeInput => ({
  entity: "defence_control",
  entityId: r.id,
  action: "upsert",
  data: {
    id: r.id,
    name: r.name,
    kind: r.kind,
    frequencyDays: r.frequencyDays,
    status: r.status,
    updatedAt: r.updatedAt,
  },
});
const checkChange = (r: CheckRow): ChangeInput => ({
  entity: "defence_check",
  entityId: r.id,
  action: "upsert",
  data: {
    id: r.id,
    controlId: r.controlId,
    checkedOn: r.checkedOn,
    outcome: r.outcome,
    resolvedAt: r.resolvedAt,
    updatedAt: r.updatedAt,
  },
});
const exerciseChange = (r: ExerciseRow): ChangeInput => ({
  entity: "defence_exercise",
  entityId: r.id,
  action: "upsert",
  data: { id: r.id, title: r.title, heldOn: r.heldOn, outcome: r.outcome, updatedAt: r.updatedAt },
});

async function userNames(db: Executor, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (!wanted.length) return new Map<string, string>();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((u) => [u.id, u.name]));
}

const withRatings = (threats: DefenceThreat[]) => threats.map((t) => ({ ...t, ...defenceThreatRating(t) }));

// ─── Assessments ─────────────────────────────────────────────────────────────

async function findAssessment(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(defenceAssessments)
    .where(
      and(
        eq(defenceAssessments.id, id),
        eq(defenceAssessments.workspaceId, workspaceId),
        isNull(defenceAssessments.deletedAt),
      ),
    );
  if (!row) throw notFound("Assessment");
  return row;
}

async function versionsOf(db: Executor, assessmentId: string) {
  return db
    .select()
    .from(defenceAssessmentVersions)
    .where(
      and(
        eq(defenceAssessmentVersions.assessmentId, assessmentId),
        isNull(defenceAssessmentVersions.deletedAt),
      ),
    )
    .orderBy(desc(defenceAssessmentVersions.versionNumber));
}

async function controlIdsOf(db: Executor, workspaceId: string) {
  const rows = await db
    .select({ id: defenceControls.id })
    .from(defenceControls)
    .where(
      and(
        eq(defenceControls.workspaceId, workspaceId),
        isNull(defenceControls.deletedAt),
        eq(defenceControls.status, "active"),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

export async function listAssessments(db: Executor, workspaceId: string, today: string) {
  const rows = await db
    .select()
    .from(defenceAssessments)
    .where(and(eq(defenceAssessments.workspaceId, workspaceId), isNull(defenceAssessments.deletedAt)))
    .orderBy(asc(defenceAssessments.status), asc(defenceAssessments.title));
  const ids = rows.map((r) => r.id);
  const versions = ids.length
    ? await db
        .select()
        .from(defenceAssessmentVersions)
        .where(
          and(
            inArray(defenceAssessmentVersions.assessmentId, ids),
            isNull(defenceAssessmentVersions.deletedAt),
            inArray(defenceAssessmentVersions.status, ["draft", "approved"]),
          ),
        )
    : [];
  return {
    assessments: rows.map((a) => {
      const approved = versions.find((v) => v.assessmentId === a.id && v.status === "approved");
      const draft = versions.find((v) => v.assessmentId === a.id && v.status === "draft");
      const ratings = (approved?.threats ?? []).map((t) => defenceThreatRating(t).rating);
      return {
        ...strip(a),
        approvedVersion: approved?.versionNumber ?? null,
        approvedAt: approved?.approvedAt ?? null,
        reviewDueOn: approved?.reviewDueOn ?? null,
        reviewStatus:
          a.status === "active" ? defenceReviewStatus(approved?.reviewDueOn ?? null, today) : "ok",
        hasDraft: !!draft,
        draftVersion: draft?.versionNumber ?? null,
        threatCount: approved?.threats.length ?? 0,
        highThreats: ratings.filter((r) => r === "high").length,
      };
    }),
  };
}

export async function getAssessment(db: Executor, workspaceId: string, id: string, today: string) {
  const assessment = await findAssessment(db, workspaceId, id);
  const versions = await versionsOf(db, id);
  const approved = versions.find((v) => v.status === "approved") ?? null;
  const draft = versions.find((v) => v.status === "draft") ?? null;
  const controls = await db
    .select({ id: defenceControls.id, name: defenceControls.name, status: defenceControls.status })
    .from(defenceControls)
    .where(and(eq(defenceControls.workspaceId, workspaceId), isNull(defenceControls.deletedAt)));
  const names = await userNames(db, [
    assessment.createdBy,
    ...versions.flatMap((v) => [v.approvedBy, v.lastEditedBy, v.createdBy]),
  ]);
  const exercises = await db
    .select({
      id: defenceExercises.id,
      title: defenceExercises.title,
      heldOn: defenceExercises.heldOn,
      outcome: defenceExercises.outcome,
    })
    .from(defenceExercises)
    .where(and(eq(defenceExercises.assessmentId, id), isNull(defenceExercises.deletedAt)))
    .orderBy(desc(defenceExercises.heldOn));
  const versionView = (v: VersionRow) => ({
    ...strip(v),
    threats: withRatings(v.threats),
    approvedByName: v.approvedBy ? (names.get(v.approvedBy) ?? null) : null,
    lastEditedByName: v.lastEditedBy ? (names.get(v.lastEditedBy) ?? null) : null,
    revision: v.status === "draft" ? draftRevision(v) : null,
  });
  return {
    ...strip(assessment),
    reviewStatus:
      assessment.status === "active" ? defenceReviewStatus(approved?.reviewDueOn ?? null, today) : "ok",
    approved: approved ? versionView(approved) : null,
    draft: draft ? versionView(draft) : null,
    /** What the draft changes against the approved version. */
    draftChanges: draft ? diffDefenceThreats(approved?.threats ?? [], draft.threats) : [],
    approvalBlockers: draft
      ? defenceApprovalBlockers(
          draft,
          today,
          new Set(controls.filter((c) => c.status === "active").map((c) => c.id)),
        )
      : [],
    /** Every version, newest first; superseded versions are kept as they were approved. */
    history: versions.map(versionView),
    controls: controls.map((c) => ({ id: c.id, name: c.name, status: c.status })),
    exercises,
  };
}

async function assertThreatControls(db: Executor, workspaceId: string, threats: DefenceThreat[] | undefined) {
  if (!threats) return;
  const wanted = new Set(threats.flatMap((t) => t.controlIds));
  if (!wanted.size) return;
  const known = await controlIdsOf(db, workspaceId);
  for (const id of wanted)
    if (!known.has(id)) throw badRequest("A threat links a control that doesn't exist");
}

export async function createAssessment(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: DefenceAssessmentCreateInput,
  today: string,
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertThreatControls(tx, workspaceId, input.draft.threats);
    const [a] = await tx
      .insert(defenceAssessments)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        title: input.title,
        scope: input.scope ?? null,
        createdBy: actorId,
      })
      .returning();
    const [v] = await tx
      .insert(defenceAssessmentVersions)
      .values({
        workspaceId,
        assessmentId: a!.id,
        versionNumber: 1,
        summary: input.draft.summary ?? null,
        threats: input.draft.threats,
        reviewDueOn: input.draft.reviewDueOn ?? null,
        lastEditedBy: actorId,
        createdBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [assessmentChange(a!), versionChange(v!)]);
    return a!.id;
  });
  return getAssessment(db, workspaceId, id, today);
}

export async function updateAssessment(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: DefenceAssessmentUpdateInput,
  today: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findAssessment(tx, workspaceId, id);
    const [row] = await tx
      .update(defenceAssessments)
      .set(patch)
      .where(eq(defenceAssessments.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [assessmentChange(row!)]);
  });
  return getAssessment(db, workspaceId, id, today);
}

async function draftOf(db: Executor, assessmentId: string) {
  const [draft] = await db
    .select()
    .from(defenceAssessmentVersions)
    .where(
      and(
        eq(defenceAssessmentVersions.assessmentId, assessmentId),
        eq(defenceAssessmentVersions.status, "draft"),
        isNull(defenceAssessmentVersions.deletedAt),
      ),
    );
  return draft ?? null;
}

const assertActive = (a: AssessmentRow) => {
  if (a.status !== "active") throw new ApiError(409, "assessment_archived", "This assessment is archived");
};

export async function saveDraft(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: DefenceDraftInput,
  today: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    assertActive(await findAssessment(tx, workspaceId, id));
    const draft = await draftOf(tx, id);
    if (!draft) throw new ApiError(409, "no_draft", "Start a review to change an approved assessment");
    await assertThreatControls(tx, workspaceId, input.threats);
    const [row] = await tx
      .update(defenceAssessmentVersions)
      .set({ ...input, lastEditedBy: actorId })
      .where(eq(defenceAssessmentVersions.id, draft.id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [versionChange(row!)]);
  });
  return getAssessment(db, workspaceId, id, today);
}

/** Starts a review: a new draft copied from the approved version, which stays in force. */
export async function startReview(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: DefenceReviewStartInput,
  today: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    assertActive(await findAssessment(tx, workspaceId, id));
    if (await draftOf(tx, id)) throw new ApiError(409, "draft_exists", "A review is already in progress");
    const versions = await versionsOf(tx, id);
    const approved = versions.find((v) => v.status === "approved");
    if (!approved)
      throw new ApiError(409, "no_approved_version", "Approve the first version before reviewing it");
    const [row] = await tx
      .insert(defenceAssessmentVersions)
      .values({
        workspaceId,
        assessmentId: id,
        versionNumber: (versions[0]?.versionNumber ?? 0) + 1,
        summary: approved.summary,
        threats: approved.threats,
        reviewDueOn: null,
        reviewTrigger: input.trigger,
        reviewReason: input.reason ?? null,
        lastEditedBy: actorId,
        createdBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [versionChange(row!)]);
  });
  return getAssessment(db, workspaceId, id, today);
}

/** Approves the draft; the previous approved version is superseded and kept. A person with manage. */
export async function approveDraft(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: DefenceApproveInput,
  today: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    assertActive(await findAssessment(tx, workspaceId, id));
    const draft = await draftOf(tx, id);
    if (!draft) throw new ApiError(409, "no_draft", "There is no draft to approve");
    if (draft.id !== input.draftId || draftRevision(draft) !== input.revision)
      throw new ApiError(
        409,
        "draft_changed",
        "This draft changed since you opened it. Reload and review it before approving.",
      );
    const blockers = defenceApprovalBlockers(draft, today, await controlIdsOf(tx, workspaceId));
    if (blockers.length)
      throw new ApiError(409, "not_ready", `Can't approve yet: ${blockers.join("; ")}`, { blockers });
    const changes: ChangeInput[] = [];
    const superseded = await tx
      .update(defenceAssessmentVersions)
      .set({ status: "superseded" })
      .where(
        and(
          eq(defenceAssessmentVersions.assessmentId, id),
          eq(defenceAssessmentVersions.status, "approved"),
          isNull(defenceAssessmentVersions.deletedAt),
        ),
      )
      .returning();
    changes.push(...superseded.map(versionChange));
    const [row] = await tx
      .update(defenceAssessmentVersions)
      .set({ status: "approved", approvedAt: new Date(), approvedBy: actorId })
      .where(eq(defenceAssessmentVersions.id, draft.id))
      .returning();
    changes.push(versionChange(row!));
    await recordChanges(tx, workspaceId, actorId, changes);
  });
  return getAssessment(db, workspaceId, id, today);
}

// ─── Controls and checks ─────────────────────────────────────────────────────

async function findControl(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(defenceControls)
    .where(
      and(
        eq(defenceControls.id, id),
        eq(defenceControls.workspaceId, workspaceId),
        isNull(defenceControls.deletedAt),
      ),
    );
  if (!row) throw notFound("Control");
  return row;
}

export async function listControls(
  db: Executor,
  workspaceId: string,
  today: string,
  status: "active" | "all",
) {
  const rows = await db
    .select()
    .from(defenceControls)
    .where(
      and(
        eq(defenceControls.workspaceId, workspaceId),
        isNull(defenceControls.deletedAt),
        status === "active" ? eq(defenceControls.status, "active") : undefined,
      ),
    )
    .orderBy(asc(defenceControls.name));
  const ids = rows.map((r) => r.id);
  const last = ids.length
    ? await db
        .select({ controlId: defenceChecks.controlId, on: max(defenceChecks.checkedOn) })
        .from(defenceChecks)
        .where(and(inArray(defenceChecks.controlId, ids), isNull(defenceChecks.deletedAt)))
        .groupBy(defenceChecks.controlId)
    : [];
  const open = ids.length
    ? await db
        .select({ controlId: defenceChecks.controlId, n: count() })
        .from(defenceChecks)
        .where(
          and(
            inArray(defenceChecks.controlId, ids),
            isNull(defenceChecks.deletedAt),
            eq(defenceChecks.outcome, "fail"),
            isNull(defenceChecks.resolvedAt),
          ),
        )
        .groupBy(defenceChecks.controlId)
    : [];
  const lastOf = new Map(last.map((l) => [l.controlId, l.on]));
  const openOf = new Map(open.map((o) => [o.controlId, o.n]));
  return {
    controls: rows.map((c) => {
      const lastCheckedOn = lastOf.get(c.id) ?? null;
      const due = defenceControlDue(c.frequencyDays, lastCheckedOn, today);
      return {
        ...strip(c),
        lastCheckedOn,
        dueOn: c.status === "active" ? due.dueOn : null,
        dueStatus: c.status === "active" ? due.status : ("ok" as const),
        openFailures: openOf.get(c.id) ?? 0,
      };
    }),
  };
}

export async function createControl(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: DefenceControlCreateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [row] = await tx
      .insert(defenceControls)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        name: input.name,
        kind: input.kind,
        area: input.area ?? null,
        frequencyDays: input.frequencyDays,
        instructions: input.instructions ?? null,
        createdBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [controlChange(row!)]);
    return strip(row!);
  });
}

export async function updateControl(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: DefenceControlUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findControl(tx, workspaceId, id);
    const [row] = await tx.update(defenceControls).set(patch).where(eq(defenceControls.id, id)).returning();
    await recordChanges(tx, workspaceId, actorId, [controlChange(row!)]);
    return strip(row!);
  });
}

export async function listChecks(db: Executor, workspaceId: string, query: DefenceCheckListQuery) {
  const conditions: (SQL | undefined)[] = [
    eq(defenceChecks.workspaceId, workspaceId),
    isNull(defenceChecks.deletedAt),
    query.controlId ? eq(defenceChecks.controlId, query.controlId) : undefined,
    query.outcome === "pass" || query.outcome === "fail"
      ? eq(defenceChecks.outcome, query.outcome)
      : undefined,
    query.outcome === "open"
      ? and(eq(defenceChecks.outcome, "fail"), isNull(defenceChecks.resolvedAt))
      : undefined,
  ];
  const where = and(...conditions);
  const [rows, [total]] = await Promise.all([
    db
      .select({ check: defenceChecks, controlName: defenceControls.name, controlKind: defenceControls.kind })
      .from(defenceChecks)
      .innerJoin(defenceControls, eq(defenceControls.id, defenceChecks.controlId))
      .where(where)
      .orderBy(desc(defenceChecks.checkedOn), desc(defenceChecks.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ total: count() }).from(defenceChecks).where(where),
  ]);
  const names = await userNames(
    db,
    rows.flatMap((r) => [r.check.checkedBy, r.check.resolvedBy]),
  );
  return {
    checks: rows.map((r) => ({
      ...strip(r.check),
      controlName: r.controlName,
      controlKind: r.controlKind,
      checkedByName: r.check.checkedBy ? (names.get(r.check.checkedBy) ?? null) : null,
      resolvedByName: r.check.resolvedBy ? (names.get(r.check.resolvedBy) ?? null) : null,
    })),
    total: total?.total ?? 0,
    offset: query.offset,
  };
}

export async function recordCheck(
  db: Database,
  workspaceId: string,
  actorId: string,
  controlId: string,
  input: DefenceCheckInput,
  today: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const control = await findControl(tx, workspaceId, controlId);
    if (control.status !== "active") throw new ApiError(409, "control_archived", "This control is archived");
    if (input.checkedOn > today) throw badRequest("The check date can't be in the future");
    const [row] = await tx
      .insert(defenceChecks)
      .values({
        workspaceId,
        controlId,
        checkedOn: input.checkedOn,
        outcome: input.outcome,
        notes: input.notes ?? null,
        actionTaken: input.actionTaken ?? null,
        checkedBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [checkChange(row!)]);
    return strip(row!);
  });
}

export async function resolveCheck(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: DefenceCheckResolveInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [check] = await tx
      .select()
      .from(defenceChecks)
      .where(
        and(
          eq(defenceChecks.id, id),
          eq(defenceChecks.workspaceId, workspaceId),
          isNull(defenceChecks.deletedAt),
        ),
      );
    if (!check) throw notFound("Check");
    if (check.outcome !== "fail") throw badRequest("Only a failed check is resolved");
    if (check.resolvedAt) throw new ApiError(409, "already_resolved", "This failure is already resolved");
    const [row] = await tx
      .update(defenceChecks)
      .set({ resolvedAt: new Date(), resolvedBy: actorId, resolution: input.resolution })
      .where(eq(defenceChecks.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [checkChange(row!)]);
    return strip(row!);
  });
}

// ─── Exercises ───────────────────────────────────────────────────────────────

export async function listExercises(db: Executor, workspaceId: string) {
  const rows = await db
    .select({ exercise: defenceExercises, assessmentTitle: defenceAssessments.title })
    .from(defenceExercises)
    .leftJoin(defenceAssessments, eq(defenceAssessments.id, defenceExercises.assessmentId))
    .where(and(eq(defenceExercises.workspaceId, workspaceId), isNull(defenceExercises.deletedAt)))
    .orderBy(desc(defenceExercises.heldOn), desc(defenceExercises.createdAt));
  const names = await userNames(
    db,
    rows.map((r) => r.exercise.recordedBy),
  );
  return {
    exercises: rows.map((r) => ({
      ...strip(r.exercise),
      assessmentTitle: r.assessmentTitle,
      recordedByName: r.exercise.recordedBy ? (names.get(r.exercise.recordedBy) ?? null) : null,
    })),
  };
}

export async function recordExercise(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: DefenceExerciseInput,
  today: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (input.heldOn > today) throw badRequest("The exercise date can't be in the future");
    if (input.assessmentId) await findAssessment(tx, workspaceId, input.assessmentId);
    const [row] = await tx
      .insert(defenceExercises)
      .values({
        workspaceId,
        title: input.title,
        scenario: input.scenario,
        heldOn: input.heldOn,
        assessmentId: input.assessmentId ?? null,
        participants: input.participants ?? null,
        outcome: input.outcome,
        findings: input.findings ?? null,
        actions: input.actions ?? null,
        recordedBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [exerciseChange(row!)]);
    return strip(row!);
  });
}

// ─── Overview ────────────────────────────────────────────────────────────────

/** Visitors on site longer than this are flagged as possibly not signed out. */
const LONG_VISIT_HOURS = 12;

/**
 * What needs attention: overdue controls, open failures, assessments due for review or never
 * approved, the last exercise, and (with Attendance access) who is signed in as a visitor now.
 */
export async function defenceOverview(
  db: Executor,
  workspaceId: string,
  today: string,
  opts: { visitors: boolean },
) {
  const [{ controls }, { assessments }, [lastExercise], openFailures] = await Promise.all([
    listControls(db, workspaceId, today, "active"),
    listAssessments(db, workspaceId, today),
    db
      .select({ id: defenceExercises.id, title: defenceExercises.title, heldOn: defenceExercises.heldOn })
      .from(defenceExercises)
      .where(and(eq(defenceExercises.workspaceId, workspaceId), isNull(defenceExercises.deletedAt)))
      .orderBy(desc(defenceExercises.heldOn))
      .limit(1),
    listChecks(db, workspaceId, { outcome: "open", limit: 50, offset: 0 }),
  ]);
  const exerciseDueOn = lastExercise ? addDays(lastExercise.heldOn, DEFENCE_EXERCISE_INTERVAL_DAYS) : today;
  let visitors: {
    onSite: {
      id: string;
      name: string;
      company: string | null;
      hostName: string | null;
      signedInAt: Date;
      longVisit: boolean;
    }[];
  } | null = null;
  if (opts.visitors) {
    const rows = await db
      .select({
        id: attendanceVisits.id,
        firstName: attendanceVisits.firstName,
        lastName: attendanceVisits.lastName,
        company: attendanceVisits.company,
        hostName: attendanceVisits.hostName,
        signedInAt: attendanceVisits.signedInAt,
      })
      .from(attendanceVisits)
      .where(
        and(
          eq(attendanceVisits.workspaceId, workspaceId),
          isNull(attendanceVisits.signedOutAt),
          isNull(attendanceVisits.deletedAt),
        ),
      )
      .orderBy(asc(attendanceVisits.signedInAt));
    const cutoff = Date.now() - LONG_VISIT_HOURS * 3600_000;
    visitors = {
      onSite: rows.map((r) => ({
        id: r.id,
        name: `${r.firstName} ${r.lastName}`,
        company: r.company,
        hostName: r.hostName,
        signedInAt: r.signedInAt,
        longVisit: r.signedInAt.getTime() < cutoff,
      })),
    };
  }
  const active = assessments.filter((a) => a.status === "active");
  return {
    controlsDue: controls.filter((c) => c.dueStatus !== "ok"),
    openFailures: openFailures.checks,
    assessmentsDue: active.filter((a) => a.reviewStatus !== "ok"),
    lastExercise: lastExercise ?? null,
    exerciseDueOn,
    exerciseOverdue: exerciseDueOn < today || !lastExercise,
    /** Null without Attendance access (or with Attendance off). */
    visitors,
    counts: {
      controls: controls.length,
      overdueControls: controls.filter((c) => c.dueStatus === "overdue" || c.dueStatus === "never").length,
      openFailures: openFailures.total,
      assessments: active.length,
      highThreats: active.reduce((n, a) => n + a.highThreats, 0),
    },
  };
}
