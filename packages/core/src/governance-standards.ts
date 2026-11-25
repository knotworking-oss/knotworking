import { z } from "zod";
import { parseCsv } from "./csv";
import type { ModuleId } from "./modules";

/**
 * Standards gap analysis (G1): a library of standards (BRCGS Food Safety, Packaging, Storage &
 * Distribution, a customer's code), each issue with its clauses, and a person's assessment of each
 * clause kept as history. Pure rules and validation schemas; no DOM or Node APIs.
 *
 * **No standard text ships with the software.** Standards such as BRCGS are published under
 * licence: clauses are imported from the workspace's own licensed copy (CSV). A new issue is a new
 * standard record, so assessments against the old issue stay as they were.
 */

export const clauseAssessmentStatuses = [
  "not_assessed",
  "compliant",
  "partial",
  "gap",
  "not_applicable",
] as const;
export type ClauseAssessmentStatus = (typeof clauseAssessmentStatuses)[number];
export const clauseAssessmentLabels: Record<ClauseAssessmentStatus, string> = {
  not_assessed: "Not assessed",
  compliant: "Compliant",
  partial: "Partly compliant",
  gap: "Gap",
  not_applicable: "Not applicable",
};
/** Statuses that are findings: they need a note, an owner and a date to close them by. */
export const openFindingStatuses: readonly ClauseAssessmentStatus[] = ["partial", "gap"];

export const standardStatuses = ["active", "archived"] as const;
export type StandardStatus = (typeof standardStatuses)[number];

// ─── Clause references ───────────────────────────────────────────────────────

/** "1.1.2" sorts before "1.1.10" and "2.1"; non-numeric parts compare as text. */
export function compareClauseRefs(a: string, b: string): number {
  const pa = a.split(/[.\s]+/);
  const pb = b.split(/[.\s]+/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
    if (c !== 0) return c;
  }
  return 0;
}

/** The section a clause belongs to when none is given: its first number ("3.9.2" → "3"). */
export const sectionOfRef = (ref: string): string => ref.split(/[.\s]+/)[0] ?? ref;

// ─── Import ──────────────────────────────────────────────────────────────────

export const CLAUSE_IMPORT_MAX_ROWS = 3000;
export const CLAUSE_IMPORT_MAX_CHARS = 3_000_000;

export interface ClauseImportRow {
  ref: string;
  title: string;
  text: string | null;
  section: string;
  sectionTitle: string | null;
  fundamental: boolean;
}

const truthy = (v: string) => ["yes", "y", "true", "1", "x", "fundamental"].includes(v.trim().toLowerCase());
const header = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
const columnAliases: Record<keyof ClauseImportRow, string[]> = {
  ref: [
    "clause",
    "ref",
    "reference",
    "clauseref",
    "number",
    "clausenumber",
    "clauseno",
    "clausenum",
    "no",
    "requirementno",
    "requirementnumber",
  ],
  title: ["title", "heading", "name", "statementofintent"],
  text: ["text", "requirement", "requirements", "description", "clausetext"],
  section: ["section", "sectionnumber"],
  sectionTitle: ["sectiontitle", "sectionname"],
  fundamental: ["fundamental", "isfundamental", "fundamentalrequirement"],
};

/**
 * Reads clauses from CSV with a header row. Columns (any order, common names accepted): clause
 * (required), title (required), text, section (default: the clause's first number), section title,
 * fundamental (yes/no). Rows are checked and reported by line; a clause listed twice is an error.
 */
export function parseClauseCsv(text: string): {
  rows: ClauseImportRow[];
  errors: { line: number; message: string }[];
} {
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim()));
  const errors: { line: number; message: string }[] = [];
  if (table.length < 2)
    return {
      rows: [],
      errors: [{ line: 1, message: "No clauses: a header row and at least one clause are needed" }],
    };
  const heads = table[0]!.map(header);
  const col = (k: keyof ClauseImportRow) => heads.findIndex((h) => columnAliases[k].includes(h));
  const idx = Object.fromEntries(
    (Object.keys(columnAliases) as (keyof ClauseImportRow)[]).map((k) => [k, col(k)]),
  ) as Record<keyof ClauseImportRow, number>;
  if (idx.ref < 0) errors.push({ line: 1, message: 'No clause column (e.g. "Clause")' });
  if (idx.title < 0) errors.push({ line: 1, message: 'No title column (e.g. "Title")' });
  if (errors.length) return { rows: [], errors };
  if (table.length - 1 > CLAUSE_IMPORT_MAX_ROWS)
    return {
      rows: [],
      errors: [{ line: 1, message: `At most ${CLAUSE_IMPORT_MAX_ROWS} clauses at a time` }],
    };
  const seen = new Set<string>();
  const rows: ClauseImportRow[] = [];
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (k: keyof ClauseImportRow) => (idx[k] >= 0 ? (cells[idx[k]] ?? "").trim() : "");
    const ref = get("ref");
    const title = get("title");
    if (!ref) return errors.push({ line, message: "No clause number" });
    if (ref.length > 40) return errors.push({ line, message: "Clause number is longer than 40 characters" });
    if (!title) return errors.push({ line, message: `Clause ${ref} has no title` });
    if (title.length > 500)
      return errors.push({ line, message: `Clause ${ref}'s title is longer than 500 characters` });
    const body = get("text");
    if (body.length > 20_000)
      return errors.push({ line, message: `Clause ${ref}'s text is longer than 20,000 characters` });
    const key = ref.toLowerCase();
    if (seen.has(key)) return errors.push({ line, message: `Clause ${ref} is listed twice` });
    seen.add(key);
    rows.push({
      ref,
      title,
      text: body || null,
      section: get("section") || sectionOfRef(ref),
      sectionTitle: get("sectionTitle") || null,
      fundamental: truthy(get("fundamental")),
    });
  });
  return { rows, errors };
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const note = z.string().trim().max(4000);

export const standardCreateSchema = z
  .object({
    /** Short code, e.g. "BRCGS-FS". With the issue, unique among live standards. */
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(200),
    /** The issue or version, e.g. "9". */
    issue: z.string().trim().min(1).max(40),
    publisher: z.string().trim().max(120).optional(),
    note: note.optional(),
  })
  .strict();
export type StandardCreateInput = z.infer<typeof standardCreateSchema>;

export const standardUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(standardStatuses).optional(),
    note: note.optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");
export type StandardUpdateInput = z.infer<typeof standardUpdateSchema>;

export const clauseImportSchema = z
  .object({
    csv: z.string().min(1).max(CLAUSE_IMPORT_MAX_CHARS),
    /** Check and report only, changing nothing. */
    dryRun: z.boolean().default(false),
  })
  .strict();
export type ClauseImportInput = z.infer<typeof clauseImportSchema>;

export const clauseAssessmentSchema = z
  .object({
    commandId: z.uuid().optional(),
    status: z.enum(clauseAssessmentStatuses),
    /** What was found and the evidence looked at; required for anything but compliant. */
    note: note.default(""),
    ownerUserId: z.uuid().nullable().optional(),
    /** When a finding is to be closed by. */
    dueOn: z.iso.date().nullable().optional(),
  })
  .strict()
  .refine((v) => v.status === "compliant" || v.status === "not_assessed" || v.note.length > 0, {
    path: ["note"],
    message: "Say what was found (or, for not applicable, why)",
  })
  .refine((v) => !openFindingStatuses.includes(v.status) || (!!v.ownerUserId && !!v.dueOn), {
    path: ["ownerUserId"],
    message: "A gap or partial compliance needs an owner and a date to close it by",
  });
export type ClauseAssessmentInput = z.infer<typeof clauseAssessmentSchema>;

export const clauseTaskSchema = z
  .object({
    teamId: z.uuid(),
    assigneeId: z.uuid().nullable().optional(),
    dueDate: z.iso.date().nullable().optional(),
  })
  .strict();
export type ClauseTaskInput = z.infer<typeof clauseTaskSchema>;

export const gapAnalysisQuerySchema = z.object({
  status: z.enum(clauseAssessmentStatuses).optional(),
  section: z.string().max(40).optional(),
  fundamental: z.enum(["true", "false"]).optional(),
  q: z.string().trim().max(200).optional(),
  /** By evidence: mapped checks show a gap, assessed compliant against failing evidence, none mapped. */
  evidence: z.enum(["gap", "conflict", "none"]).optional(),
  /** Clauses with a drafted finding awaiting a person's review. */
  drafts: z.enum(["open"]).optional(),
});
export type GapAnalysisQuery = z.infer<typeof gapAnalysisQuerySchema>;

// ─── Report ──────────────────────────────────────────────────────────────────

export type StatusCounts = Record<ClauseAssessmentStatus, number>;
export const emptyCounts = (): StatusCounts =>
  Object.fromEntries(clauseAssessmentStatuses.map((s) => [s, 0])) as StatusCounts;

export interface GapClause {
  ref: string;
  section: string;
  fundamental: boolean;
  status: ClauseAssessmentStatus;
  dueOn: string | null;
}

/**
 * The summary of a gap analysis: counts by status overall and per section, how much is assessed,
 * open findings (gaps and partials), those past their date, and fundamental clauses not compliant.
 */
export function summariseGaps(clauses: readonly GapClause[], today: string) {
  const overall = emptyCounts();
  const bySection = new Map<string, StatusCounts>();
  for (const c of clauses) {
    overall[c.status] += 1;
    const s = bySection.get(c.section) ?? emptyCounts();
    s[c.status] += 1;
    bySection.set(c.section, s);
  }
  const total = clauses.length;
  const assessed = total - overall.not_assessed;
  const open = clauses.filter((c) => openFindingStatuses.includes(c.status));
  return {
    total,
    assessed,
    assessedPercent: total ? Math.round((assessed / total) * 1000) / 10 : 0,
    counts: overall,
    sections: [...bySection.entries()]
      .sort(([a], [b]) => compareClauseRefs(a, b))
      .map(([section, counts]) => ({ section, counts })),
    openFindings: open.length,
    overdueFindings: open.filter((c) => c.dueOn && c.dueOn < today).length,
    /** Fundamental clauses that aren't compliant or not applicable (including not yet assessed). */
    fundamentalAtRisk: clauses
      .filter((c) => c.fundamental && !["compliant", "not_applicable"].includes(c.status))
      .map((c) => c.ref),
  };
}

// ─── Evidence checks (G2) ────────────────────────────────────────────────────

/**
 * Automatic evidence checks: each reads live records in one or more modules and reports `met`, a
 * `gap` (with the records behind it), `no_data` (nothing on record to judge), or `unavailable`
 * (a module is off or the reader can't see it). Checks are mapped to clauses by a person; a clause
 * assessed compliant whose mapped evidence shows a gap is flagged as a conflict. Checks see what is
 * recorded, not whether practice on the floor matches it.
 */
export const evidenceCheckIds = [
  "traceability_test",
  "internal_audits",
  "nonconformances_overdue",
  "haccp_plan_review",
  "ccp_monitoring",
  "cleaning_schedule",
  "calibration",
  "sop_reviews",
  "sop_acknowledgements",
  "specification_reviews",
  "supplier_controls",
  "training_competence",
  "food_defence",
  "food_fraud",
  "management_review",
  "requirements_register",
] as const;
export type EvidenceCheckId = (typeof evidenceCheckIds)[number];
export type EvidenceCheckStatus = "met" | "gap" | "no_data" | "unavailable";
export const evidenceCheckStatusLabels: Record<EvidenceCheckStatus, string> = {
  met: "Evidence met",
  gap: "Evidence gap",
  no_data: "Nothing on record",
  unavailable: "Not available to you",
};

export interface EvidenceCheckDefinition {
  id: EvidenceCheckId;
  label: string;
  /** What it looks at and what counts as a gap. */
  description: string;
  /** Every one must be on and readable for the check to run. */
  modules: readonly ModuleId[];
  /** Plain-language subjects, to help a person find the clauses it supports. */
  topics: readonly string[];
}

export const evidenceChecks: Record<EvidenceCheckId, EvidenceCheckDefinition> = {
  traceability_test: {
    id: "traceability_test",
    label: "Traceability test in the last 12 months",
    description:
      "A passing traceability (recall) test within the last 12 months. Gap: none on record, or the last passing one is over a year old.",
    // Mock recalls trace stock lots: Stock is a soft dependency of Quality.
    modules: ["quality", "stock"],
    topics: ["traceability", "recall", "withdrawal"],
  },
  internal_audits: {
    id: "internal_audits",
    label: "Internal audit programme on schedule",
    description:
      "Internal audits planned and done to schedule. Gap: an audit past its planned date, or none completed in the last 12 months.",
    modules: ["quality"],
    topics: ["internal audit", "audit programme"],
  },
  nonconformances_overdue: {
    id: "nonconformances_overdue",
    label: "Corrective actions closed on time",
    description:
      "Non-conformances and their corrective actions within their due dates. Gap: any open past its date.",
    modules: ["quality"],
    topics: ["corrective action", "preventive action", "CAPA", "non-conformance", "root cause"],
  },
  haccp_plan_review: {
    id: "haccp_plan_review",
    label: "HACCP plan reviewed",
    description:
      "Each current HACCP plan's hazard analysis reviewed within its period. Gap: a plan with its review due.",
    modules: ["haccp"],
    topics: ["HACCP", "hazard analysis", "food safety plan", "review"],
  },
  ccp_monitoring: {
    id: "ccp_monitoring",
    label: "CCP monitoring up to date",
    description: "Critical control points checked at their frequency. Gap: a CCP check overdue.",
    modules: ["haccp"],
    topics: ["CCP", "monitoring", "critical limits", "HACCP"],
  },
  cleaning_schedule: {
    id: "cleaning_schedule",
    label: "Cleaning schedule up to date",
    description: "Areas and equipment cleaned at their frequency. Gap: cleaning overdue.",
    modules: ["haccp"],
    topics: ["cleaning", "housekeeping", "hygiene"],
  },
  calibration: {
    id: "calibration",
    label: "Measuring equipment calibrated",
    description:
      "Equipment calibrated by its due date with the last calibration passing. Gap: overdue, or the last one failed.",
    modules: ["haccp"],
    topics: ["calibration", "measuring equipment", "monitoring devices"],
  },
  sop_reviews: {
    id: "sop_reviews",
    label: "Procedures reviewed",
    description:
      "Every active SOP's current version reviewed by its review date. Gap: one past its review date.",
    modules: ["sops"],
    topics: ["procedures", "document control", "documented procedures"],
  },
  sop_acknowledgements: {
    id: "sop_acknowledgements",
    label: "Procedures read by the people who use them",
    description:
      "Staff in an SOP's audience have read and acknowledged its current version. Gap: acknowledgements outstanding.",
    modules: ["sops"],
    topics: ["procedures", "training", "document control", "awareness"],
  },
  specification_reviews: {
    id: "specification_reviews",
    label: "Specifications reviewed",
    description:
      "Each active specification's approved version reviewed by its review date. Gap: one past its review date.",
    modules: ["specifications"],
    topics: ["specifications", "raw materials", "finished products", "packaging"],
  },
  supplier_controls: {
    id: "supplier_controls",
    label: "Approved suppliers under control",
    description:
      "Approved suppliers with their required controls current (risk assessment, questionnaires, certificates). Gap: an approved supplier with control issues to act on.",
    modules: ["items"],
    topics: ["supplier approval", "supplier monitoring", "raw material risk assessment"],
  },
  training_competence: {
    id: "training_competence",
    label: "Staff trained and competent",
    description:
      "Required training for each person's role current. Gap: required training missing or expired.",
    modules: ["training"],
    topics: ["training", "competence", "personnel"],
  },
  food_defence: {
    id: "food_defence",
    label: "Food defence assessment and controls current",
    description:
      "The food defence (threat) assessment reviewed and its security controls checked on time. Gap: an assessment review due or a control check overdue.",
    modules: ["defence"],
    topics: ["food defence", "site security", "threat assessment"],
  },
  food_fraud: {
    id: "food_fraud",
    label: "Food fraud vulnerability assessment current",
    description:
      "Each active vulnerability assessment approved and reviewed by its review date. Gap: none approved, or a review past due.",
    modules: ["quality"],
    topics: ["food fraud", "vulnerability assessment", "authenticity", "substitution"],
  },
  management_review: {
    id: "management_review",
    label: "Management review in the last 12 months",
    description:
      "A management review signed within the last 12 months. Gap: none, or the last is over a year old.",
    modules: ["governance"],
    topics: ["management review", "senior management commitment"],
  },
  requirements_register: {
    id: "requirements_register",
    label: "Legal and customer requirements reviewed",
    description:
      "The requirement register reviewed on time and compliant. Gap: a requirement not compliant, never assessed, or past its review date.",
    modules: ["governance"],
    topics: ["legislation", "customer requirements", "codes of practice"],
  },
};

export interface EvidenceCheckResult {
  id: EvidenceCheckId;
  label: string;
  status: EvidenceCheckStatus;
  /** One line: what was found. */
  detail: string;
  /** The records behind a gap (or the latest that meets it), at most 10. */
  items: { label: string; detail?: string | null }[];
}

export const clauseEvidenceSetSchema = z
  .object({ checkIds: z.array(z.enum(evidenceCheckIds)).max(evidenceCheckIds.length) })
  .strict()
  .refine((v) => new Set(v.checkIds).size === v.checkIds.length, "A check can be mapped once");
export type ClauseEvidenceSetInput = z.infer<typeof clauseEvidenceSetSchema>;

/** The evidence position of a clause from its mapped checks' results. */
export function clauseEvidenceState(
  results: readonly Pick<EvidenceCheckResult, "status">[],
): "none" | "met" | "gap" | "partial_view" {
  if (!results.length) return "none";
  if (results.some((r) => r.status === "gap")) return "gap";
  if (results.some((r) => r.status === "unavailable" || r.status === "no_data")) return "partial_view";
  return "met";
}

/** A clause assessed compliant (or not applicable) while its mapped evidence shows a gap. */
export const evidenceConflict = (
  status: ClauseAssessmentStatus,
  evidence: ReturnType<typeof clauseEvidenceState>,
) => (status === "compliant" || status === "not_applicable") && evidence === "gap";

// ─── Drafted findings (G3) ───────────────────────────────────────────────────

/**
 * A proposed assessment of a clause, usually drafted by an agent from the clause text and its
 * evidence. It never counts until a person accepts it (recording their own assessment, which may
 * differ) or dismisses it. A new draft replaces the clause's open one.
 */
export const clauseDraftStates = ["open", "accepted", "dismissed", "superseded"] as const;
export type ClauseDraftState = (typeof clauseDraftStates)[number];
export const clauseDraftStateLabels: Record<ClauseDraftState, string> = {
  open: "Awaiting review",
  accepted: "Accepted",
  dismissed: "Dismissed",
  superseded: "Replaced",
};

/** What a draft may propose: anything but "not assessed". */
export const draftableStatuses = ["compliant", "partial", "gap", "not_applicable"] as const;

export const clauseDraftSchema = z
  .object({
    status: z.enum(draftableStatuses),
    /** The proposed finding, as it would read on the assessment. */
    note: note.min(1, "Say what was found"),
    /** What the proposal is based on: evidence checks, records, documents looked at. */
    rationale: note.default(""),
    ownerUserId: z.uuid().nullable().optional(),
    dueOn: z.iso.date().nullable().optional(),
  })
  .strict();
export type ClauseDraftInput = z.infer<typeof clauseDraftSchema>;

export const clauseDraftDismissSchema = z
  .object({ reason: z.string().trim().max(1000).default("") })
  .strict();
export type ClauseDraftDismissInput = z.infer<typeof clauseDraftDismissSchema>;

// ─── Pre-audit snapshots (G3) ────────────────────────────────────────────────

/** A frozen copy of a standard's gap analysis, e.g. before an audit. Never edited. */
export const gapSnapshotCreateSchema = z
  .object({ label: z.string().trim().min(1, "Name the snapshot").max(120) })
  .strict();
export type GapSnapshotCreateInput = z.infer<typeof gapSnapshotCreateSchema>;
