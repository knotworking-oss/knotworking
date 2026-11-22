import {
  clauseAssessmentLabels,
  clauseEvidenceState,
  evidenceChecks,
  evidenceConflict,
  toCsv,
  type ClauseAssessmentStatus,
  type EvidenceCheckResult,
  type GapSnapshotCreateInput,
} from "@knotworking/core";
import {
  governanceGapSnapshots,
  governanceStandards,
  lockWorkspaceLog,
  recordChanges,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { ApiError, notFound } from "../errors";
import { userNames } from "./governance";
import type { EvidenceAccess } from "./governance-evidence";
import { getGapAnalysis } from "./governance-standards";

/**
 * Pre-audit snapshots (G3): a frozen copy of a standard's gap analysis, never edited. The payload
 * keeps every clause as the person taking it saw it. On read, evidence from modules the viewer
 * can't read is hidden again and the evidence summary recomputed, so a snapshot never shows more
 * than the live analysis would. Only the header goes to the sync log.
 */

interface SnapshotClause {
  id: string;
  ref: string;
  title: string;
  section: string;
  sectionTitle: string | null;
  fundamental: boolean;
  status: ClauseAssessmentStatus;
  assessment: {
    note: string | null;
    ownerName: string | null;
    dueOn: string | null;
    overdue: boolean;
    assessedByName: string | null;
    assessedAt: string;
  } | null;
  evidence: EvidenceCheckResult[];
}
interface SnapshotPayload {
  version: 1;
  standard: { code: string; name: string; issue: string; publisher: string | null };
  clauses: SnapshotClause[];
}

type SnapshotRow = typeof governanceGapSnapshots.$inferSelect;

const header = (row: SnapshotRow) => ({
  id: row.id,
  standardId: row.standardId,
  label: row.label,
  takenOn: row.takenOn,
  takenBy: row.takenBy,
  clauseCount: row.clauseCount,
  createdAt: row.createdAt,
});

/** Freezes the standard's gap analysis as the taker sees it now. */
export async function takeGapSnapshot(
  db: Database,
  ws: string,
  actor: string,
  standardId: string,
  input: GapSnapshotCreateInput,
  today: string,
  access: EvidenceAccess,
) {
  const view = await getGapAnalysis(db, ws, standardId, {}, today, { tasks: false, evidence: access });
  if (view.standard.status !== "active")
    throw new ApiError(409, "standard_archived", "This standard is archived");
  if (!view.clauses.length) throw new ApiError(409, "no_clauses", "Import the standard's clauses first");
  const payload: SnapshotPayload = {
    version: 1,
    standard: {
      code: view.standard.code,
      name: view.standard.name,
      issue: view.standard.issue,
      publisher: view.standard.publisher ?? null,
    },
    clauses: view.clauses.map((c) => ({
      id: c.id,
      ref: c.ref,
      title: c.title,
      section: c.section,
      sectionTitle: c.sectionTitle,
      fundamental: c.fundamental,
      status: c.status,
      assessment: c.assessment
        ? {
            note: c.assessment.note,
            ownerName: c.assessment.ownerName,
            dueOn: c.assessment.dueOn,
            overdue: c.assessment.overdue,
            assessedByName: c.assessment.assessedByName,
            assessedAt: new Date(c.assessment.assessedAt).toISOString(),
          }
        : null,
      evidence: c.evidence,
    })),
  };
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    const [inserted] = await tx
      .insert(governanceGapSnapshots)
      .values({
        workspaceId: ws,
        standardId,
        label: input.label,
        takenOn: today,
        takenBy: actor,
        clauseCount: payload.clauses.length,
        payload,
      })
      .returning();
    await recordChanges(tx, ws, actor, [
      {
        entity: "governance_gap_snapshot",
        entityId: inserted!.id,
        action: "upsert",
        data: header(inserted!),
      },
    ]);
    return inserted!;
  });
  return header(row);
}

export async function listGapSnapshots(db: Executor, ws: string, standardId: string) {
  const rows = await db
    .select()
    .from(governanceGapSnapshots)
    .where(
      and(
        eq(governanceGapSnapshots.workspaceId, ws),
        eq(governanceGapSnapshots.standardId, standardId),
        isNull(governanceGapSnapshots.deletedAt),
      ),
    )
    .orderBy(desc(governanceGapSnapshots.createdAt), desc(governanceGapSnapshots.id));
  const names = await userNames(
    db,
    rows.map((r) => r.takenBy),
  );
  return {
    snapshots: rows.map((r) => ({
      ...header(r),
      takenByName: r.takenBy ? (names.get(r.takenBy) ?? null) : null,
    })),
  };
}

/** Hides a check's result from a viewer who couldn't see it in the live analysis. */
function redact(result: EvidenceCheckResult, access: EvidenceAccess): EvidenceCheckResult {
  const modules = evidenceChecks[result.id]?.modules ?? [];
  if (modules.every((m) => access.active.includes(m) && access.readable(m))) return result;
  return {
    id: result.id,
    label: result.label,
    status: "unavailable",
    detail: `Needs read access to ${modules.join(" and ")}`,
    items: [],
  };
}

/**
 * A snapshot as the viewer may see it, with what has changed since: clauses whose assessed status
 * differs now, and clauses added or removed.
 */
export async function getGapSnapshot(
  db: Database,
  ws: string,
  id: string,
  today: string,
  access: EvidenceAccess,
) {
  const [row] = await db
    .select()
    .from(governanceGapSnapshots)
    .where(
      and(
        eq(governanceGapSnapshots.id, id),
        eq(governanceGapSnapshots.workspaceId, ws),
        isNull(governanceGapSnapshots.deletedAt),
      ),
    );
  if (!row) throw notFound("Snapshot");
  const [standard] = await db
    .select({ id: governanceStandards.id })
    .from(governanceStandards)
    .where(
      and(
        eq(governanceStandards.id, row.standardId),
        eq(governanceStandards.workspaceId, ws),
        isNull(governanceStandards.deletedAt),
      ),
    );
  if (!standard) throw notFound("Snapshot");
  const payload = row.payload as SnapshotPayload;
  const clauses = payload.clauses.map((c) => {
    const evidence = c.evidence.map((e) => redact(e, access));
    const evidenceState = clauseEvidenceState(evidence);
    return { ...c, evidence, evidenceState, conflict: evidenceConflict(c.status, evidenceState) };
  });
  const counts = Object.fromEntries(
    Object.keys(clauseAssessmentLabels).map((s) => [s, clauses.filter((c) => c.status === s).length]),
  ) as Record<ClauseAssessmentStatus, number>;
  const assessed = clauses.length - counts.not_assessed;
  // What changed since: compared with the live statuses (governance data, no evidence needed).
  const live = await getGapAnalysis(db, ws, row.standardId, {}, today, {
    tasks: false,
    evidence: { active: [], readable: () => false },
  });
  const liveById = new Map(live.clauses.map((c) => [c.id, c]));
  const thenIds = new Set(clauses.map((c) => c.id));
  const names = await userNames(db, [row.takenBy]);
  return {
    snapshot: { ...header(row), takenByName: row.takenBy ? (names.get(row.takenBy) ?? null) : null },
    standard: payload.standard,
    summary: {
      total: clauses.length,
      assessed,
      assessedPercent: clauses.length ? Math.round((assessed / clauses.length) * 1000) / 10 : 0,
      counts,
      openFindings: clauses.filter((c) => c.status === "gap" || c.status === "partial").length,
      overdueFindings: clauses.filter((c) => c.assessment?.overdue).length,
      fundamentalAtRisk: clauses
        .filter((c) => c.fundamental && c.status !== "compliant" && c.status !== "not_applicable")
        .map((c) => c.ref),
      evidenceGaps: clauses.filter((c) => c.evidenceState === "gap").map((c) => c.ref),
      conflicts: clauses.filter((c) => c.conflict).map((c) => c.ref),
    },
    changesSince: {
      status: clauses
        .filter((c) => liveById.has(c.id) && liveById.get(c.id)!.status !== c.status)
        .map((c) => ({ ref: c.ref, title: c.title, then: c.status, now: liveById.get(c.id)!.status })),
      added: live.clauses.filter((c) => !thenIds.has(c.id)).map((c) => c.ref),
      removed: clauses.filter((c) => !liveById.has(c.id)).map((c) => c.ref),
    },
    clauses,
  };
}

/** A snapshot as CSV, with the same redaction. */
export async function gapSnapshotCsv(
  db: Database,
  ws: string,
  id: string,
  today: string,
  access: EvidenceAccess,
) {
  const view = await getGapSnapshot(db, ws, id, today, access);
  const csv = toCsv([
    [
      "Snapshot",
      "Taken on",
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
      "Evidence gaps",
      "Conflict",
    ],
    ...view.clauses.map((c) => [
      view.snapshot.label,
      view.snapshot.takenOn,
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
      c.assessment?.assessedAt ?? "",
      c.evidence
        .filter((e) => e.status === "gap")
        .map((e) => `${e.label}: ${e.detail}`)
        .join("; "),
      c.conflict ? "Yes" : "",
    ]),
  ]);
  return {
    csv,
    fileName:
      `gap-snapshot-${view.standard.code}-issue-${view.standard.issue}-${view.snapshot.takenOn}-${view.snapshot.label}.csv`.replace(
        /[^\w.-]+/g,
        "-",
      ),
  };
}
