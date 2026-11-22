import { z } from "zod";
import { addDays } from "./stock";

/**
 * Food defence (Phase 3, milestone 3.3.2): threat assessments of the site against deliberate
 * contamination and malicious acts, versioned so a review keeps the version before it; security
 * controls (access, perimeter, keys, CCTV, tamper evidence) with routine checks that show when
 * they are overdue or failed; and exercises that test an incident scenario. Visitors and
 * contractors are read from the Attendance register, not copied. Pure; shared by server, web and
 * MCP.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const defenceThreatSources = [
  "employee",
  "contractor",
  "visitor",
  "intruder",
  "supply_chain",
  "cyber",
  "other",
] as const;
export type DefenceThreatSource = (typeof defenceThreatSources)[number];
export const defenceThreatSourceLabels: Record<DefenceThreatSource, string> = {
  employee: "Employee or agency worker",
  contractor: "Contractor",
  visitor: "Visitor",
  intruder: "Intruder",
  supply_chain: "Supply chain (deliveries, packaging)",
  cyber: "Cyber (control systems, data)",
  other: "Other",
};

export const defenceControlKinds = [
  "access",
  "perimeter",
  "locks_keys",
  "cctv",
  "tamper_evidence",
  "personnel",
  "cyber",
  "other",
] as const;
export type DefenceControlKind = (typeof defenceControlKinds)[number];
export const defenceControlKindLabels: Record<DefenceControlKind, string> = {
  access: "Access control",
  perimeter: "Perimeter and doors",
  locks_keys: "Locks and keys",
  cctv: "CCTV",
  tamper_evidence: "Tamper evidence and seals",
  personnel: "Personnel (vetting, ID)",
  cyber: "Cyber security",
  other: "Other",
};

export const defenceVersionStatuses = ["draft", "approved", "superseded"] as const;
export type DefenceVersionStatus = (typeof defenceVersionStatuses)[number];
export const defenceVersionStatusLabels: Record<DefenceVersionStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  superseded: "Superseded",
};

export const defenceCheckOutcomes = ["pass", "fail"] as const;
export type DefenceCheckOutcome = (typeof defenceCheckOutcomes)[number];

export const defenceExerciseOutcomes = ["effective", "partly_effective", "ineffective"] as const;
export type DefenceExerciseOutcome = (typeof defenceExerciseOutcomes)[number];
export const defenceExerciseOutcomeLabels: Record<DefenceExerciseOutcome, string> = {
  effective: "Effective",
  partly_effective: "Partly effective",
  ineffective: "Ineffective",
};

/** What prompts a review of an approved assessment. */
export const defenceReviewTriggers = [
  "scheduled",
  "incident",
  "site_change",
  "intelligence",
  "exercise",
  "other",
] as const;
export type DefenceReviewTrigger = (typeof defenceReviewTriggers)[number];
export const defenceReviewTriggerLabels: Record<DefenceReviewTrigger, string> = {
  scheduled: "Scheduled review",
  incident: "Security incident",
  site_change: "Site or process change",
  intelligence: "New threat intelligence",
  exercise: "Exercise findings",
  other: "Other",
};

/** Days before a due date that a control (at most) or review shows as due soon. */
export const DEFENCE_DUE_SOON_DAYS = 7;
/** An exercise at least this often (days). */
export const DEFENCE_EXERCISE_INTERVAL_DAYS = 365;

// ─── Validation ──────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const isoDate = z.iso.date();
const score = z.number().int().min(1).max(5);

export const defenceThreatSchema = z.object({
  /** Stable within the assessment, so a review can be compared with the version before it. */
  id: z.uuid(),
  /** Where: an area of the site, a process step, a material. */
  area: z.string().trim().min(1).max(200),
  /** What could happen and how. */
  threat: z.string().trim().min(1).max(2000),
  source: z.enum(defenceThreatSources),
  likelihood: score,
  impact: score,
  /** Controls already in place. */
  existingControls: optionalText(2000),
  /** Further mitigation, required when the threat rates high. */
  mitigation: optionalText(2000),
  /** Security controls whose checks verify the mitigation. */
  controlIds: z.array(z.uuid()).max(20).default([]),
});
export type DefenceThreat = z.infer<typeof defenceThreatSchema>;

const draftFields = {
  summary: optionalText(4000),
  threats: z.array(defenceThreatSchema).max(200),
  /** Next review, set on the draft and fixed when it is approved. */
  reviewDueOn: isoDate.nullable(),
};

export const defenceAssessmentCreateSchema = z.object({
  id: z.uuid().optional(),
  title: z.string().trim().min(1).max(200),
  /** What it covers: the whole site, a building, a line. */
  scope: optionalText(2000).optional(),
  draft: z
    .object({
      summary: draftFields.summary.optional(),
      threats: draftFields.threats.default([]),
      reviewDueOn: draftFields.reviewDueOn.optional(),
    })
    .default({ threats: [] }),
});
export type DefenceAssessmentCreateInput = z.infer<typeof defenceAssessmentCreateSchema>;

export const defenceAssessmentUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    scope: optionalText(2000),
    status: z.enum(["active", "archived"]),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to update");
export type DefenceAssessmentUpdateInput = z.infer<typeof defenceAssessmentUpdateSchema>;

export const defenceDraftSchema = z
  .object(draftFields)
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to update");
export type DefenceDraftInput = z.infer<typeof defenceDraftSchema>;

export const defenceReviewStartSchema = z.object({
  trigger: z.enum(defenceReviewTriggers),
  reason: optionalText(2000).optional(),
});
export type DefenceReviewStartInput = z.infer<typeof defenceReviewStartSchema>;

/** Approval names the exact draft the manager reviewed; a changed draft must be reloaded first. */
export const defenceApproveSchema = z.object({
  draftId: z.uuid(),
  revision: z.string().min(1).max(128),
});
export type DefenceApproveInput = z.infer<typeof defenceApproveSchema>;

export const defenceControlCreateSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(defenceControlKinds),
  area: optionalText(200).optional(),
  /** How often it is checked, in days. */
  frequencyDays: z.number().int().min(1).max(730),
  /** What the person checking looks for. */
  instructions: optionalText(4000).optional(),
});
export type DefenceControlCreateInput = z.infer<typeof defenceControlCreateSchema>;

export const defenceControlUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(defenceControlKinds),
    area: optionalText(200),
    frequencyDays: z.number().int().min(1).max(730),
    instructions: optionalText(4000),
    status: z.enum(["active", "archived"]),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to update");
export type DefenceControlUpdateInput = z.infer<typeof defenceControlUpdateSchema>;

export const defenceCheckSchema = z
  .object({
    checkedOn: isoDate,
    outcome: z.enum(defenceCheckOutcomes),
    notes: optionalText(2000).optional(),
    /** What was done straight away about a failure. */
    actionTaken: optionalText(2000).optional(),
  })
  .refine((c) => c.outcome === "pass" || !!c.notes, {
    message: "Say what was wrong",
    path: ["notes"],
  });
export type DefenceCheckInput = z.infer<typeof defenceCheckSchema>;

export const defenceCheckResolveSchema = z.object({
  resolution: z.string().trim().min(1).max(2000),
});
export type DefenceCheckResolveInput = z.infer<typeof defenceCheckResolveSchema>;

export const defenceCheckListQuerySchema = z.object({
  controlId: z.uuid().optional(),
  /** `open`: failed and not yet resolved. */
  outcome: z.enum(["pass", "fail", "open", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type DefenceCheckListQuery = z.infer<typeof defenceCheckListQuerySchema>;

export const defenceExerciseSchema = z.object({
  title: z.string().trim().min(1).max(200),
  /** The incident scenario tested: what was simulated and how. */
  scenario: z.string().trim().min(1).max(4000),
  heldOn: isoDate,
  /** The assessment whose threats it tested, if any. */
  assessmentId: z.uuid().nullable().optional(),
  participants: optionalText(2000).optional(),
  outcome: z.enum(defenceExerciseOutcomes),
  findings: optionalText(4000).optional(),
  /** Follow-up actions agreed. */
  actions: optionalText(4000).optional(),
});
export type DefenceExerciseInput = z.infer<typeof defenceExerciseSchema>;

// ─── Rules ───────────────────────────────────────────────────────────────────

export type DefenceRating = "low" | "medium" | "high";
export const defenceRatingLabels: Record<DefenceRating, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** Likelihood × impact on 1–5 scales: 1–6 low, 8–12 medium, 15–25 high. */
export function defenceThreatRating(t: Pick<DefenceThreat, "likelihood" | "impact">): {
  score: number;
  rating: DefenceRating;
} {
  const s = t.likelihood * t.impact;
  return { score: s, rating: s >= 15 ? "high" : s >= 8 ? "medium" : "low" };
}

/** Why a draft can't be approved yet (empty when it can). */
export function defenceApprovalBlockers(
  draft: { threats: readonly DefenceThreat[]; reviewDueOn: string | null },
  today: string,
  knownControlIds: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  if (draft.threats.length === 0) out.push("Record at least one threat");
  if (!draft.reviewDueOn) out.push("Set the next review date");
  else if (draft.reviewDueOn <= today) out.push("The next review date must be in the future");
  const ids = new Set<string>();
  for (const t of draft.threats) {
    if (ids.has(t.id)) out.push(`Threat "${t.area}" appears twice`);
    ids.add(t.id);
    if (defenceThreatRating(t).rating === "high" && !t.mitigation)
      out.push(`"${t.area}: ${t.threat.slice(0, 60)}" rates high and needs a mitigation`);
    for (const c of t.controlIds)
      if (!knownControlIds.has(c)) out.push(`"${t.area}" links a control that no longer exists`);
  }
  return out;
}

export type DefenceDueStatus = "never" | "overdue" | "due_soon" | "ok";
export const defenceDueStatusLabels: Record<DefenceDueStatus, string> = {
  never: "Never checked",
  overdue: "Overdue",
  due_soon: "Due soon",
  ok: "Up to date",
};

/** When a control is next due and where it stands. A control never checked is due now. */
export function defenceControlDue(
  frequencyDays: number,
  lastCheckedOn: string | null,
  today: string,
): { dueOn: string; status: DefenceDueStatus } {
  if (!lastCheckedOn) return { dueOn: today, status: "never" };
  const dueOn = addDays(lastCheckedOn, frequencyDays);
  // Due soon within a week, or a quarter of the interval when that is shorter: a daily check done
  // today isn't "due soon"; it is on the day it falls due.
  const window = Math.min(DEFENCE_DUE_SOON_DAYS, Math.floor(frequencyDays / 4));
  return {
    dueOn,
    status: dueOn < today ? "overdue" : dueOn <= addDays(today, window) ? "due_soon" : "ok",
  };
}

/** Where an approved assessment's review date stands. */
export function defenceReviewStatus(reviewDueOn: string | null, today: string): DefenceDueStatus {
  if (!reviewDueOn) return "never";
  if (reviewDueOn < today) return "overdue";
  return reviewDueOn <= addDays(today, DEFENCE_DUE_SOON_DAYS) ? "due_soon" : "ok";
}

export interface DefenceThreatChange {
  id: string;
  area: string;
  change: "added" | "removed" | "rerated" | "changed";
  detail: string;
}

/** What a draft changes against the approved version: threats added, removed or re-rated. */
export function diffDefenceThreats(
  before: readonly DefenceThreat[],
  after: readonly DefenceThreat[],
): DefenceThreatChange[] {
  const out: DefenceThreatChange[] = [];
  const prev = new Map(before.map((t) => [t.id, t]));
  const next = new Map(after.map((t) => [t.id, t]));
  for (const t of after) {
    const p = prev.get(t.id);
    if (!p) {
      out.push({ id: t.id, area: t.area, change: "added", detail: t.threat });
      continue;
    }
    const a = defenceThreatRating(p);
    const b = defenceThreatRating(t);
    if (a.score !== b.score) {
      out.push({
        id: t.id,
        area: t.area,
        change: "rerated",
        detail: `${a.score} (${a.rating}) → ${b.score} (${b.rating})`,
      });
    } else if (
      p.threat !== t.threat ||
      p.area !== t.area ||
      p.source !== t.source ||
      p.existingControls !== t.existingControls ||
      p.mitigation !== t.mitigation ||
      [...p.controlIds].sort().join() !== [...t.controlIds].sort().join()
    ) {
      out.push({ id: t.id, area: t.area, change: "changed", detail: "Wording, controls or mitigation" });
    }
  }
  for (const t of before)
    if (!next.has(t.id)) out.push({ id: t.id, area: t.area, change: "removed", detail: t.threat });
  return out;
}
