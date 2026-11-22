import {
  clauseAssessmentLabels,
  clauseEvidenceState,
  evidenceCheckIds,
  evidenceChecks,
  evidenceConflict,
  compareClauseRefs,
  openFindingStatuses,
  parseClauseCsv,
  summariseGaps,
  toCsv,
  type ClauseAssessmentInput,
  type ClauseDraftDismissInput,
  type ClauseDraftInput,
  type ClauseEvidenceSetInput,
  type ClauseAssessmentStatus,
  type ClauseImportInput,
  type ClauseTaskInput,
  type GapAnalysisQuery,
  type StandardCreateInput,
  type StandardUpdateInput,
} from "@knotworking/core";
import {
  governanceClauseAssessments,
  governanceClauseDrafts,
  governanceClauseEvidence,
  governanceClauseTasks,
  governanceStandardClauses,
  governanceStandards,
  lockWorkspaceLog,
  recordChanges,
  tasks,
  workflowStates,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ApiError, notFound } from "../errors";
import { assertMember, userNames } from "./governance";
import { evaluateEvidenceChecks, type EvidenceAccess } from "./governance-evidence";
import { executeLedgerCommand } from "./ledger-command";
import { createTask } from "./tasks";

/**
 * Standards gap analysis (G1): the library of standards and their clauses (imported from the
 * workspace's own licensed copy), a person's assessment of each clause kept as history, the gap
 * report, and tasks raised to close findings. Rules in `@knotworking/core` governance-standards.ts.
 */

type StandardRow = typeof governanceStandards.$inferSelect;
type ClauseRow = typeof governanceStandardClauses.$inferSelect;
type AssessmentRow = typeof governanceClauseAssessments.$inferSelect;

const strip = <T extends { workspaceId: string; deletedAt?: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _d, ...rest } = row;
  return rest;
};
const change = (entity: ChangeInput["entity"], row: { id: string; workspaceId: string }): ChangeInput => ({
  entity,
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

async function findStandard(db: Executor, ws: string, id: string) {
  const [row] = await db
    .select()
    .from(governanceStandards)
    .where(
      and(
        eq(governanceStandards.id, id),
        eq(governanceStandards.workspaceId, ws),
        isNull(governanceStandards.deletedAt),
      ),
    );
  if (!row) throw notFound("Standard");
  return row;
}

async function findClause(db: Executor, ws: string, id: string) {
  const [row] = await db
    .select()
    .from(governanceStandardClauses)
    .where(
      and(
        eq(governanceStandardClauses.id, id),
        eq(governanceStandardClauses.workspaceId, ws),
        isNull(governanceStandardClauses.deletedAt),
      ),
    );
  if (!row) throw notFound("Clause");
  return row;
}

async function liveClauses(db: Executor, ws: string, standardIds: string[]) {
  if (!standardIds.length) return [];
  return db
    .select()
    .from(governanceStandardClauses)
    .where(
      and(
        eq(governanceStandardClauses.workspaceId, ws),
        inArray(governanceStandardClauses.standardId, standardIds),
        isNull(governanceStandardClauses.deletedAt),
      ),
    );
}

/** The latest assessment of each clause. */
async function latestAssessments(db: Executor, ws: string, clauseIds: string[]) {
  const map = new Map<string, AssessmentRow>();
  if (!clauseIds.length) return map;
  const rows = await db
    .selectDistinctOn([governanceClauseAssessments.clauseId])
    .from(governanceClauseAssessments)
    .where(
      and(
        eq(governanceClauseAssessments.workspaceId, ws),
        inArray(governanceClauseAssessments.clauseId, clauseIds),
      ),
    )
    .orderBy(
      governanceClauseAssessments.clauseId,
      desc(governanceClauseAssessments.assessedAt),
      desc(governanceClauseAssessments.id),
    );
  for (const r of rows) map.set(r.clauseId, r);
  return map;
}

const statusOf = (a: AssessmentRow | undefined): ClauseAssessmentStatus => a?.status ?? "not_assessed";

type DraftRow = typeof governanceClauseDrafts.$inferSelect;

/** The open drafted finding of each clause. */
async function openDrafts(db: Executor, ws: string, clauseIds: string[]) {
  const map = new Map<string, DraftRow>();
  if (!clauseIds.length) return map;
  const rows = await db
    .select()
    .from(governanceClauseDrafts)
    .where(
      and(
        eq(governanceClauseDrafts.workspaceId, ws),
        inArray(governanceClauseDrafts.clauseId, clauseIds),
        eq(governanceClauseDrafts.state, "open"),
        isNull(governanceClauseDrafts.deletedAt),
      ),
    );
  for (const r of rows) map.set(r.clauseId, r);
  return map;
}

const draftView = (d: DraftRow, names: Map<string, string>) => ({
  ...strip(d),
  draftedByName: d.draftedBy ? (names.get(d.draftedBy) ?? null) : null,
  ownerName: d.ownerUserId ? (names.get(d.ownerUserId) ?? null) : null,
  decidedByName: d.decidedBy ? (names.get(d.decidedBy) ?? null) : null,
});

// ─── Standards ───────────────────────────────────────────────────────────────

export async function listStandards(db: Executor, ws: string, today: string) {
  const rows = await db
    .select()
    .from(governanceStandards)
    .where(and(eq(governanceStandards.workspaceId, ws), isNull(governanceStandards.deletedAt)))
    .orderBy(asc(governanceStandards.status), asc(governanceStandards.code), desc(governanceStandards.issue));
  const clauses = await liveClauses(
    db,
    ws,
    rows.map((r) => r.id),
  );
  const latest = await latestAssessments(
    db,
    ws,
    clauses.map((c) => c.id),
  );
  return {
    standards: rows.map((s) => {
      const mine = clauses.filter((c) => c.standardId === s.id);
      const summary = summariseGaps(
        mine.map((c) => ({
          ref: c.ref,
          section: c.section,
          fundamental: c.fundamental,
          status: statusOf(latest.get(c.id)),
          dueOn: latest.get(c.id)?.dueOn ?? null,
        })),
        today,
      );
      return {
        ...strip(s),
        clauses: summary.total,
        assessed: summary.assessed,
        assessedPercent: summary.assessedPercent,
        counts: summary.counts,
        openFindings: summary.openFindings,
        overdueFindings: summary.overdueFindings,
        fundamentalAtRisk: summary.fundamentalAtRisk.length,
      };
    }),
  };
}

export async function createStandard(db: Database, ws: string, actor: string, input: StandardCreateInput) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    const [taken] = await tx
      .select({ id: governanceStandards.id })
      .from(governanceStandards)
      .where(
        and(
          eq(governanceStandards.workspaceId, ws),
          isNull(governanceStandards.deletedAt),
          sql`lower(${governanceStandards.code}) = ${input.code.toLowerCase()}`,
          sql`lower(${governanceStandards.issue}) = ${input.issue.toLowerCase()}`,
        ),
      );
    if (taken)
      throw new ApiError(
        409,
        "standard_exists",
        `${input.code} issue ${input.issue} is already in the library`,
      );
    const [row] = await tx
      .insert(governanceStandards)
      .values({
        workspaceId: ws,
        code: input.code,
        name: input.name,
        issue: input.issue,
        publisher: input.publisher || null,
        note: input.note || null,
        createdBy: actor,
      })
      .returning();
    await recordChanges(tx, ws, actor, [change("governance_standard", row!)]);
    return row!;
  });
  return strip(row);
}

export async function updateStandard(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  patch: StandardUpdateInput,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    await findStandard(tx, ws, id);
    const [row] = await tx
      .update(governanceStandards)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.note !== undefined ? { note: patch.note || null } : {}),
      })
      .where(eq(governanceStandards.id, id))
      .returning();
    await recordChanges(tx, ws, actor, [change("governance_standard", row!)]);
    return row!;
  });
  return strip(row);
}

/**
 * Imports clauses from CSV (the workspace's own licensed copy). New references are added; a
 * reference already there takes the new title, text, section and fundamental flag (a correction).
 * Clauses missing from the file are left alone. Any error in the file changes nothing.
 */
export async function importClauses(
  db: Database,
  ws: string,
  actor: string,
  standardId: string,
  input: ClauseImportInput,
) {
  const parsed = parseClauseCsv(input.csv);
  if (parsed.errors.length)
    return { applied: false, added: 0, updated: 0, unchanged: 0, errors: parsed.errors };
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    const standard = await findStandard(tx, ws, standardId);
    if (standard.status !== "active")
      throw new ApiError(409, "standard_archived", "This standard is archived");
    const existing = await liveClauses(tx, ws, [standardId]);
    const byRef = new Map(existing.map((c) => [c.ref.toLowerCase(), c]));
    const added: (typeof governanceStandardClauses.$inferInsert)[] = [];
    const updates: { id: string; values: Partial<ClauseRow> }[] = [];
    let unchanged = 0;
    for (const r of parsed.rows) {
      const prior = byRef.get(r.ref.toLowerCase());
      const values = {
        title: r.title,
        text: r.text,
        section: r.section,
        sectionTitle: r.sectionTitle,
        fundamental: r.fundamental,
      };
      if (!prior) added.push({ workspaceId: ws, standardId, ref: r.ref, ...values });
      else if (
        prior.title !== values.title ||
        prior.text !== values.text ||
        prior.section !== values.section ||
        prior.sectionTitle !== values.sectionTitle ||
        prior.fundamental !== values.fundamental
      )
        updates.push({ id: prior.id, values });
      else unchanged += 1;
    }
    if (!input.dryRun) {
      const changes: ChangeInput[] = [];
      if (added.length) {
        const rows = await tx.insert(governanceStandardClauses).values(added).returning();
        changes.push(...rows.map((r) => change("governance_standard_clause", r)));
      }
      for (const u of updates) {
        const [row] = await tx
          .update(governanceStandardClauses)
          .set(u.values)
          .where(eq(governanceStandardClauses.id, u.id))
          .returning();
        changes.push(change("governance_standard_clause", row!));
      }
      if (changes.length) await recordChanges(tx, ws, actor, changes);
    }
    return { applied: !input.dryRun, added: added.length, updated: updates.length, unchanged, errors: [] };
  });
}

// ─── Gap analysis ────────────────────────────────────────────────────────────

/**
 * A standard's gap analysis: every clause in clause order with its current assessment (or not
 * assessed), its open tasks, and the summary (by status and section, findings open and overdue,
 * fundamental clauses at risk). Filters narrow the clause list, never the summary.
 */
export async function getGapAnalysis(
  db: Database,
  ws: string,
  standardId: string,
  query: GapAnalysisQuery,
  today: string,
  access: { tasks: boolean; evidence: EvidenceAccess },
) {
  const standard = await findStandard(db, ws, standardId);
  const clauses = (await liveClauses(db, ws, [standardId])).sort((a, b) => compareClauseRefs(a.ref, b.ref));
  const latest = await latestAssessments(
    db,
    ws,
    clauses.map((c) => c.id),
  );
  const taskLinks = clauses.length
    ? await db
        .select()
        .from(governanceClauseTasks)
        .where(
          and(
            eq(governanceClauseTasks.workspaceId, ws),
            inArray(
              governanceClauseTasks.clauseId,
              clauses.map((c) => c.id),
            ),
          ),
        )
    : [];
  const taskRows =
    access.tasks && taskLinks.length
      ? await db
          .select({
            id: tasks.id,
            title: tasks.title,
            dueDate: tasks.dueDate,
            deletedAt: tasks.deletedAt,
            state: workflowStates.name,
            category: workflowStates.type,
          })
          .from(tasks)
          .innerJoin(workflowStates, eq(workflowStates.id, tasks.stateId))
          .where(
            inArray(
              tasks.id,
              taskLinks.map((t) => t.taskId),
            ),
          )
      : [];
  const drafts = await openDrafts(
    db,
    ws,
    clauses.map((c) => c.id),
  );
  const names = await userNames(db, [
    ...[...latest.values()].flatMap((a) => [a.ownerUserId, a.assessedBy]),
    ...[...drafts.values()].flatMap((d) => [d.ownerUserId, d.draftedBy]),
  ]);
  // Evidence: each mapped check is run once for the whole standard, with the reader's access.
  const mapping = clauses.length
    ? await db
        .select()
        .from(governanceClauseEvidence)
        .where(
          and(
            eq(governanceClauseEvidence.workspaceId, ws),
            inArray(
              governanceClauseEvidence.clauseId,
              clauses.map((c) => c.id),
            ),
            isNull(governanceClauseEvidence.deletedAt),
          ),
        )
    : [];
  const results = await evaluateEvidenceChecks(db, ws, today, access.evidence, [
    ...new Set(mapping.map((m) => m.checkId)),
  ]);
  const evidenceOf = (clauseId: string) =>
    mapping
      .filter((m) => m.clauseId === clauseId)
      .map((m) => results.get(m.checkId)!)
      .sort((x, y) => x.label.localeCompare(y.label));
  const evidenceView = new Map(
    clauses.map((c) => {
      const evidence = evidenceOf(c.id);
      const state = clauseEvidenceState(evidence);
      return [
        c.id,
        { evidence, state, conflict: evidenceConflict(statusOf(latest.get(c.id)), state) },
      ] as const;
    }),
  );
  const summary = summariseGaps(
    clauses.map((c) => ({
      ref: c.ref,
      section: c.section,
      fundamental: c.fundamental,
      status: statusOf(latest.get(c.id)),
      dueOn: latest.get(c.id)?.dueOn ?? null,
    })),
    today,
  );
  const needle = query.q?.toLowerCase();
  const shown = clauses.filter((c) => {
    const a = latest.get(c.id);
    if (query.status && statusOf(a) !== query.status) return false;
    if (query.section && c.section !== query.section) return false;
    if (query.fundamental === "true" && !c.fundamental) return false;
    if (query.fundamental === "false" && c.fundamental) return false;
    if (needle && ![c.ref, c.title, c.text ?? ""].some((v) => v.toLowerCase().includes(needle))) return false;
    if (query.evidence === "gap" && evidenceView.get(c.id)!.state !== "gap") return false;
    if (query.evidence === "conflict" && !evidenceView.get(c.id)!.conflict) return false;
    if (query.evidence === "none" && evidenceView.get(c.id)!.state !== "none") return false;
    if (query.drafts === "open" && !drafts.has(c.id)) return false;
    return true;
  });
  const sectionTitles = new Map<string, string>();
  for (const c of clauses)
    if (c.sectionTitle && !sectionTitles.has(c.section)) sectionTitles.set(c.section, c.sectionTitle);
  return {
    standard: strip(standard),
    summary: {
      ...summary,
      sections: summary.sections.map((s) => ({ ...s, title: sectionTitles.get(s.section) ?? null })),
      /** Clauses with at least one mapped check. */
      clausesWithEvidence: clauses.filter((c) => evidenceView.get(c.id)!.state !== "none").length,
      /** Clauses whose mapped evidence shows a gap. */
      evidenceGaps: clauses.filter((c) => evidenceView.get(c.id)!.state === "gap").map((c) => c.ref),
      /** Clauses assessed compliant (or not applicable) while their evidence shows a gap. */
      conflicts: clauses.filter((c) => evidenceView.get(c.id)!.conflict).map((c) => c.ref),
      /** Drafted findings awaiting a person's review. */
      openDrafts: drafts.size,
    },
    clauses: shown.map((c) => {
      const a = latest.get(c.id);
      return {
        id: c.id,
        ref: c.ref,
        title: c.title,
        text: c.text,
        section: c.section,
        sectionTitle: c.sectionTitle,
        fundamental: c.fundamental,
        status: statusOf(a),
        evidence: evidenceView.get(c.id)!.evidence,
        evidenceState: evidenceView.get(c.id)!.state,
        conflict: evidenceView.get(c.id)!.conflict,
        /** A drafted finding awaiting review: a proposal, not the clause's status. */
        draft: drafts.has(c.id) ? draftView(drafts.get(c.id)!, names) : null,
        assessment: a
          ? {
              ...strip(a),
              ownerName: a.ownerUserId ? (names.get(a.ownerUserId) ?? null) : null,
              assessedByName: a.assessedBy ? (names.get(a.assessedBy) ?? null) : null,
              overdue: !!a.dueOn && openFindingStatuses.includes(a.status) && a.dueOn < today,
            }
          : null,
        /** Linked tasks, for people who can read tasks; otherwise just how many. */
        taskCount: taskLinks.filter((t) => t.clauseId === c.id).length,
        tasks: taskRows
          .filter((t) => !t.deletedAt && taskLinks.some((l) => l.clauseId === c.id && l.taskId === t.id))
          .map((t) => ({
            id: t.id,
            title: t.title,
            dueDate: t.dueDate,
            state: t.state,
            done: t.category === "completed" || t.category === "canceled",
          })),
      };
    }),
  };
}

/** One clause with its full assessment history, newest first. */
export async function getClause(db: Executor, ws: string, id: string) {
  const clause = await findClause(db, ws, id);
  const standard = await findStandard(db, ws, clause.standardId);
  const history = await db
    .select()
    .from(governanceClauseAssessments)
    .where(and(eq(governanceClauseAssessments.workspaceId, ws), eq(governanceClauseAssessments.clauseId, id)))
    .orderBy(desc(governanceClauseAssessments.assessedAt), desc(governanceClauseAssessments.id));
  const drafts = await db
    .select()
    .from(governanceClauseDrafts)
    .where(
      and(
        eq(governanceClauseDrafts.workspaceId, ws),
        eq(governanceClauseDrafts.clauseId, id),
        isNull(governanceClauseDrafts.deletedAt),
      ),
    )
    .orderBy(desc(governanceClauseDrafts.createdAt), desc(governanceClauseDrafts.id));
  const names = await userNames(db, [
    ...history.flatMap((a) => [a.ownerUserId, a.assessedBy]),
    ...drafts.flatMap((d) => [d.ownerUserId, d.draftedBy, d.decidedBy]),
  ]);
  return {
    /** Drafted findings, newest first; at most one open. */
    drafts: drafts.map((d) => draftView(d, names)),
    clause: strip(clause),
    standard: { id: standard.id, code: standard.code, name: standard.name, issue: standard.issue },
    status: statusOf(history[0]),
    history: history.map((a) => ({
      ...strip(a),
      ownerName: a.ownerUserId ? (names.get(a.ownerUserId) ?? null) : null,
      assessedByName: a.assessedBy ? (names.get(a.assessedBy) ?? null) : null,
    })),
  };
}

/**
 * A person's assessment of a clause: appended, never edited. A gap or partial compliance needs an
 * owner (a member) and a date to close it by; anything other than compliant needs a note.
 */
export async function assessClause(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: ClauseAssessmentInput,
) {
  await executeLedgerCommand(db, ws, actor, "assessClause", input, { id, input }, async (tx) => {
    const row = await insertAssessment(tx, ws, actor, id, input);
    await recordChanges(tx, ws, actor, [change("governance_clause_assessment", row)]);
    return { id: row.id };
  });
  return getClause(db, ws, id);
}

async function activeClause(tx: Executor, ws: string, id: string) {
  const clause = await findClause(tx, ws, id);
  const standard = await findStandard(tx, ws, clause.standardId);
  if (standard.status !== "active") throw new ApiError(409, "standard_archived", "This standard is archived");
  return clause;
}

async function insertAssessment(
  tx: Executor,
  ws: string,
  actor: string,
  id: string,
  input: ClauseAssessmentInput,
) {
  const clause = await activeClause(tx, ws, id);
  await assertMember(tx, ws, input.ownerUserId);
  const [row] = await tx
    .insert(governanceClauseAssessments)
    .values({
      workspaceId: ws,
      clauseId: id,
      standardId: clause.standardId,
      status: input.status,
      note: input.note || null,
      ownerUserId: input.ownerUserId ?? null,
      dueOn: input.dueOn ?? null,
      assessedBy: actor,
      assessedAt: new Date(),
    })
    .returning();
  return row!;
}

// ─── Drafted findings (G3) ───────────────────────────────────────────────────

/**
 * Drafts a finding on a clause: a proposal (usually an agent's, from the clause text and its
 * evidence) that changes nothing until a person accepts or dismisses it. Replaces the clause's
 * open draft.
 */
export async function draftClauseFinding(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: ClauseDraftInput,
  via: "agent" | "person",
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    const clause = await activeClause(tx, ws, id);
    await assertMember(tx, ws, input.ownerUserId);
    const changes: ChangeInput[] = [];
    if (via === "agent") {
      const [open] = await tx
        .select({ draftedVia: governanceClauseDrafts.draftedVia })
        .from(governanceClauseDrafts)
        .where(
          and(
            eq(governanceClauseDrafts.workspaceId, ws),
            eq(governanceClauseDrafts.clauseId, id),
            eq(governanceClauseDrafts.state, "open"),
            isNull(governanceClauseDrafts.deletedAt),
          ),
        );
      if (open?.draftedVia === "person")
        throw new ApiError(
          409,
          "draft_open",
          "A person's draft is awaiting review on this clause; an agent can't replace it",
        );
    }
    const replaced = await tx
      .update(governanceClauseDrafts)
      .set({ state: "superseded", updatedAt: new Date() })
      .where(
        and(
          eq(governanceClauseDrafts.workspaceId, ws),
          eq(governanceClauseDrafts.clauseId, id),
          eq(governanceClauseDrafts.state, "open"),
          isNull(governanceClauseDrafts.deletedAt),
        ),
      )
      .returning();
    changes.push(...replaced.map((r) => change("governance_clause_draft", r)));
    const [row] = await tx
      .insert(governanceClauseDrafts)
      .values({
        workspaceId: ws,
        clauseId: id,
        standardId: clause.standardId,
        status: input.status,
        note: input.note,
        rationale: input.rationale || null,
        ownerUserId: input.ownerUserId ?? null,
        dueOn: input.dueOn ?? null,
        draftedVia: via,
        draftedBy: actor,
      })
      .returning();
    changes.push(change("governance_clause_draft", row!));
    await recordChanges(tx, ws, actor, changes);
  });
  return getClause(db, ws, id);
}

async function findOpenDraft(tx: Executor, ws: string, id: string) {
  const [row] = await tx
    .select()
    .from(governanceClauseDrafts)
    .where(
      and(
        eq(governanceClauseDrafts.id, id),
        eq(governanceClauseDrafts.workspaceId, ws),
        isNull(governanceClauseDrafts.deletedAt),
      ),
    );
  if (!row) throw notFound("Draft");
  if (row.state !== "open")
    throw new ApiError(409, "draft_decided", "This draft has already been accepted, dismissed or replaced");
  return row;
}

/**
 * A person accepts a draft by recording their own assessment (the draft's values, as they confirm
 * or change them). The assessment is theirs, not the drafter's.
 */
export async function acceptClauseDraft(
  db: Database,
  ws: string,
  actor: string,
  draftId: string,
  input: ClauseAssessmentInput,
) {
  const result = await executeLedgerCommand(
    db,
    ws,
    actor,
    "acceptClauseDraft",
    input,
    { draftId, input },
    async (tx) => {
      await lockWorkspaceLog(tx, ws);
      if (input.status === "not_assessed")
        throw new ApiError(400, "invalid_input", "Accepting a draft records a finding: choose one");
      const draft = await findOpenDraft(tx, ws, draftId);
      const assessment = await insertAssessment(tx, ws, actor, draft.clauseId, input);
      const [decided] = await tx
        .update(governanceClauseDrafts)
        .set({
          state: "accepted",
          decidedBy: actor,
          decidedAt: new Date(),
          assessmentId: assessment.id,
          updatedAt: new Date(),
        })
        .where(eq(governanceClauseDrafts.id, draft.id))
        .returning();
      await recordChanges(tx, ws, actor, [
        change("governance_clause_assessment", assessment),
        change("governance_clause_draft", decided!),
      ]);
      return { clauseId: draft.clauseId };
    },
  );
  return getClause(db, ws, result.clauseId);
}

/** Dismisses a draft: the clause's status is unchanged. */
export async function dismissClauseDraft(
  db: Database,
  ws: string,
  actor: string,
  draftId: string,
  input: ClauseDraftDismissInput,
  via: "agent" | "person",
) {
  const clauseId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    const draft = await findOpenDraft(tx, ws, draftId);
    // The clause must still exist (a draft on a removed clause is gone with it).
    await findClause(tx, ws, draft.clauseId);
    if (via === "agent" && draft.draftedVia === "person")
      throw new ApiError(403, "draft_not_yours", "An agent can only dismiss drafts made by agents");
    const [decided] = await tx
      .update(governanceClauseDrafts)
      .set({
        state: "dismissed",
        decidedBy: actor,
        decidedAt: new Date(),
        decisionNote: input.reason || null,
        updatedAt: new Date(),
      })
      .where(eq(governanceClauseDrafts.id, draft.id))
      .returning();
    await recordChanges(tx, ws, actor, [change("governance_clause_draft", decided!)]);
    return draft.clauseId;
  });
  return getClause(db, ws, clauseId);
}

/** Raises a task to close a clause's finding, linked to the clause. Needs the tasks module. */
export async function raiseClauseTask(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: ClauseTaskInput,
) {
  const clause = await findClause(db, ws, id);
  const standard = await findStandard(db, ws, clause.standardId);
  const [latest] = await db
    .select()
    .from(governanceClauseAssessments)
    .where(and(eq(governanceClauseAssessments.workspaceId, ws), eq(governanceClauseAssessments.clauseId, id)))
    .orderBy(desc(governanceClauseAssessments.assessedAt), desc(governanceClauseAssessments.id))
    .limit(1);
  if (!latest || !openFindingStatuses.includes(latest.status))
    throw new ApiError(409, "no_open_finding", "Only a gap or partial compliance needs a task to close it");
  return db.transaction(async (tx) => {
    // A savepoint inside this transaction: a failure rolls back the link too.
    const task = await createTask(tx as unknown as Database, ws, actor, {
      teamId: input.teamId,
      title: `${standard.code} ${clause.ref}: ${clause.title}`.slice(0, 512),
      assigneeId: input.assigneeId ?? latest.ownerUserId ?? null,
      dueDate: input.dueDate ?? latest.dueOn ?? null,
    });
    const [link] = await tx
      .insert(governanceClauseTasks)
      .values({ workspaceId: ws, clauseId: id, taskId: task.id, createdBy: actor })
      .returning();
    await recordChanges(tx, ws, actor, [change("governance_clause_task", link!)]);
    return { clauseId: id, taskId: task.id };
  });
}

/** The gap analysis as CSV: every clause with its status, note, owner, due date and assessor. */
export async function gapAnalysisCsv(
  db: Database,
  ws: string,
  standardId: string,
  today: string,
  evidence: EvidenceAccess,
) {
  const view = await getGapAnalysis(db, ws, standardId, {}, today, { tasks: false, evidence });
  const csv = toCsv([
    [
      "Standard",
      "Issue",
      "Clause",
      "Title",
      "Section",
      "Fundamental",
      "Status",
      "Note",
      "Owner",
      "Due",
      "Overdue",
      "Assessed by",
      "Assessed at",
      "Evidence",
      "Evidence gaps",
      "Conflict",
    ],
    ...view.clauses.map((c) => [
      view.standard.code,
      view.standard.issue,
      c.ref,
      c.title,
      c.section,
      c.fundamental ? "Yes" : "No",
      clauseAssessmentLabels[c.status],
      c.assessment?.note ?? "",
      c.assessment?.ownerName ?? "",
      c.assessment?.dueOn ?? "",
      c.assessment?.overdue ? "Yes" : "",
      c.assessment?.assessedByName ?? "",
      c.assessment?.assessedAt ? new Date(c.assessment.assessedAt).toISOString() : "",
      evidenceStateLabel[c.evidenceState],
      c.evidence
        .filter((e) => e.status === "gap")
        .map((e) => `${e.label}: ${e.detail}`)
        .join("; "),
      c.conflict ? "Yes" : "",
    ]),
  ]);
  return {
    csv,
    fileName: `gap-analysis-${view.standard.code}-issue-${view.standard.issue}-${today}.csv`.replace(
      /[^\w.-]+/g,
      "-",
    ),
  };
}

const evidenceStateLabel: Record<ReturnType<typeof clauseEvidenceState>, string> = {
  none: "Not mapped",
  met: "Met",
  gap: "Gap",
  partial_view: "Partly checked",
};

/**
 * Replaces the evidence checks mapped to a clause. Configuration, like importing clauses (`manage`,
 * and an agent may do it): it decides which records are shown against the clause but never
 * changes the clause's assessed status, which stays a person's.
 */
export async function setClauseEvidence(
  db: Database,
  ws: string,
  actor: string,
  clauseId: string,
  input: ClauseEvidenceSetInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    const clause = await findClause(tx, ws, clauseId);
    const standard = await findStandard(tx, ws, clause.standardId);
    if (standard.status !== "active")
      throw new ApiError(409, "standard_archived", "This standard is archived");
    const current = await tx
      .select()
      .from(governanceClauseEvidence)
      .where(
        and(
          eq(governanceClauseEvidence.workspaceId, ws),
          eq(governanceClauseEvidence.clauseId, clauseId),
          isNull(governanceClauseEvidence.deletedAt),
        ),
      );
    const keep = new Set(input.checkIds);
    const removed = current.filter((r) => !keep.has(r.checkId));
    const have = new Set(current.map((r) => r.checkId));
    const added = input.checkIds.filter((id) => !have.has(id));
    const changes: ChangeInput[] = [];
    if (removed.length) {
      const rows = await tx
        .update(governanceClauseEvidence)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          inArray(
            governanceClauseEvidence.id,
            removed.map((r) => r.id),
          ),
        )
        .returning();
      changes.push(
        ...rows.map((r) => ({
          entity: "governance_clause_evidence" as const,
          entityId: r.id,
          action: "delete" as const,
        })),
      );
    }
    if (added.length) {
      const rows = await tx
        .insert(governanceClauseEvidence)
        .values(added.map((checkId) => ({ workspaceId: ws, clauseId, checkId, createdBy: actor })))
        .returning();
      changes.push(...rows.map((r) => change("governance_clause_evidence", r)));
    }
    if (changes.length) await recordChanges(tx, ws, actor, changes);
  });
  return { clauseId, checkIds: input.checkIds };
}

/**
 * Every evidence check's live result for the reader, with the clauses (of active standards) it is
 * mapped to: a view of the site's evidence position across standards.
 */
export async function listEvidenceChecks(db: Database, ws: string, today: string, access: EvidenceAccess) {
  const results = await evaluateEvidenceChecks(db, ws, today, access);
  const mapped = await db
    .select({
      checkId: governanceClauseEvidence.checkId,
      ref: governanceStandardClauses.ref,
      code: governanceStandards.code,
    })
    .from(governanceClauseEvidence)
    .innerJoin(governanceStandardClauses, eq(governanceStandardClauses.id, governanceClauseEvidence.clauseId))
    .innerJoin(governanceStandards, eq(governanceStandards.id, governanceStandardClauses.standardId))
    .where(
      and(
        eq(governanceClauseEvidence.workspaceId, ws),
        isNull(governanceClauseEvidence.deletedAt),
        isNull(governanceStandardClauses.deletedAt),
        eq(governanceStandards.status, "active"),
        isNull(governanceStandards.deletedAt),
      ),
    );
  return {
    checks: evidenceCheckIds.map((id) => ({
      ...results.get(id)!,
      description: evidenceChecks[id].description,
      modules: evidenceChecks[id].modules,
      topics: evidenceChecks[id].topics,
      clauses: mapped
        .filter((m) => m.checkId === id)
        .map((m) => `${m.code} ${m.ref}`)
        .sort(),
    })),
  };
}
