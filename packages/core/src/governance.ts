import { z } from "zod";
import { addDays } from "./stock";

/**
 * Governance (Phase 3, milestone 3.3.3): food safety and quality objectives with progress, the
 * food safety culture plan (activities and how they are measured), confidential concerns, the
 * compliance and customer requirement register, and management reviews that assemble evidence
 * from the other modules, record decisions, and are signed off, creating follow-up tasks.
 * Pure; shared by server, web and MCP.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const governanceObjectiveCategories = [
  "food_safety",
  "quality",
  "legality",
  "culture",
  "other",
] as const;
export type GovernanceObjectiveCategory = (typeof governanceObjectiveCategories)[number];
export const governanceObjectiveCategoryLabels: Record<GovernanceObjectiveCategory, string> = {
  food_safety: "Food safety",
  quality: "Quality",
  legality: "Legality",
  culture: "Food safety culture",
  other: "Other",
};

export const governanceObjectiveStatuses = ["open", "achieved", "missed", "withdrawn"] as const;
export type GovernanceObjectiveStatus = (typeof governanceObjectiveStatuses)[number];
export const governanceObjectiveStatusLabels: Record<GovernanceObjectiveStatus, string> = {
  open: "Open",
  achieved: "Achieved",
  missed: "Missed",
  withdrawn: "Withdrawn",
};

/** How an open objective is going, as last reported. */
export const governanceObjectiveRags = ["on_track", "at_risk", "off_track"] as const;
export type GovernanceObjectiveRag = (typeof governanceObjectiveRags)[number];
export const governanceObjectiveRagLabels: Record<GovernanceObjectiveRag, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
};

export const governanceCultureKinds = [
  "survey",
  "training",
  "communication",
  "recognition",
  "workshop",
  "leadership_walk",
  "other",
] as const;
export type GovernanceCultureKind = (typeof governanceCultureKinds)[number];
export const governanceCultureKindLabels: Record<GovernanceCultureKind, string> = {
  survey: "Culture survey",
  training: "Training or briefing",
  communication: "Communication",
  recognition: "Recognition",
  workshop: "Workshop",
  leadership_walk: "Leadership walk",
  other: "Other",
};

export const governanceConcernCategories = [
  "food_safety",
  "quality",
  "legality",
  "behaviour",
  "other",
] as const;
export type GovernanceConcernCategory = (typeof governanceConcernCategories)[number];
export const governanceConcernCategoryLabels: Record<GovernanceConcernCategory, string> = {
  food_safety: "Food safety",
  quality: "Product quality",
  legality: "Legality or authenticity",
  behaviour: "Behaviour or practices",
  other: "Other",
};
export const governanceConcernStatuses = ["open", "investigating", "closed"] as const;
export type GovernanceConcernStatus = (typeof governanceConcernStatuses)[number];
export const governanceConcernStatusLabels: Record<GovernanceConcernStatus, string> = {
  open: "Open",
  investigating: "Investigating",
  closed: "Closed",
};

export const governanceRequirementSources = [
  "legal",
  "customer",
  "standard",
  "certification",
  "other",
] as const;
export type GovernanceRequirementSource = (typeof governanceRequirementSources)[number];
export const governanceRequirementSourceLabels: Record<GovernanceRequirementSource, string> = {
  legal: "Legislation",
  customer: "Customer code of practice",
  standard: "Standard (e.g. BRCGS)",
  certification: "Certification scheme",
  other: "Other",
};
export const governanceComplianceStatuses = [
  "not_assessed",
  "compliant",
  "partial",
  "non_compliant",
] as const;
export type GovernanceComplianceStatus = (typeof governanceComplianceStatuses)[number];
export const governanceComplianceStatusLabels: Record<GovernanceComplianceStatus, string> = {
  not_assessed: "Not assessed",
  compliant: "Compliant",
  partial: "Partly compliant",
  non_compliant: "Not compliant",
};

export const governanceReviewStatuses = ["draft", "signed"] as const;
export type GovernanceReviewStatus = (typeof governanceReviewStatuses)[number];

/** Days before a due date that it shows as due soon. */
export const GOVERNANCE_DUE_SOON_DAYS = 14;

// ─── Validation ──────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const isoDate = z.iso.date();

export const governanceObjectiveCreateSchema = z.object({
  id: z.uuid().optional(),
  title: z.string().trim().min(1).max(200),
  category: z.enum(governanceObjectiveCategories),
  /** How progress is measured. */
  measure: optionalText(2000).optional(),
  target: optionalText(500).optional(),
  ownerUserId: z.uuid().nullable().optional(),
  dueOn: isoDate.nullable().optional(),
});
export type GovernanceObjectiveCreateInput = z.infer<typeof governanceObjectiveCreateSchema>;

export const governanceObjectiveUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    category: z.enum(governanceObjectiveCategories),
    measure: optionalText(2000),
    target: optionalText(500),
    ownerUserId: z.uuid().nullable(),
    dueOn: isoDate.nullable(),
    status: z.enum(governanceObjectiveStatuses),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to update");
export type GovernanceObjectiveUpdateInput = z.infer<typeof governanceObjectiveUpdateSchema>;

export const governanceProgressSchema = z.object({
  on: isoDate,
  rag: z.enum(governanceObjectiveRags),
  /** The measured value, as text ("96.2%", "3 of 4"). */
  value: optionalText(200).optional(),
  note: z.string().trim().min(1).max(2000),
});
export type GovernanceProgressInput = z.infer<typeof governanceProgressSchema>;

export interface GovernanceProgress {
  on: string;
  rag: GovernanceObjectiveRag;
  value: string | null;
  note: string;
  by: string;
  byName: string | null;
  at: string;
}

export const governanceCultureCreateSchema = z.object({
  id: z.uuid().optional(),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(governanceCultureKinds),
  plannedOn: isoDate,
  ownerUserId: z.uuid().nullable().optional(),
  /** How its effect is measured. */
  measure: optionalText(2000).optional(),
  objectiveId: z.uuid().nullable().optional(),
});
export type GovernanceCultureCreateInput = z.infer<typeof governanceCultureCreateSchema>;

export const governanceCultureUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    kind: z.enum(governanceCultureKinds),
    plannedOn: isoDate,
    ownerUserId: z.uuid().nullable(),
    measure: optionalText(2000),
    objectiveId: z.uuid().nullable(),
    /** Recording it done: the date, how many took part, and what it showed. */
    completedOn: isoDate.nullable(),
    participants: z.number().int().min(0).max(100_000).nullable(),
    result: optionalText(4000),
    cancelled: z.boolean(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to update");
export type GovernanceCultureUpdateInput = z.infer<typeof governanceCultureUpdateSchema>;

export const governanceConcernSubmitSchema = z.object({
  category: z.enum(governanceConcernCategories),
  description: z.string().trim().min(10).max(10_000),
  /** Anonymous: who raised it is not stored at all, so it can't be traced or followed up with them. */
  anonymous: z.boolean().default(false),
});
export type GovernanceConcernSubmitInput = z.infer<typeof governanceConcernSubmitSchema>;

export const governanceConcernUpdateSchema = z
  .object({
    status: z.enum(governanceConcernStatuses),
    /** What was looked into and found (confidential). */
    investigation: optionalText(10_000),
    /** What the reporter is told when it is closed (they see this, not the investigation). */
    outcome: optionalText(4000),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to update")
  .refine((p) => p.status !== "closed" || !!p.outcome, {
    message: "Say what was done before closing it",
    path: ["outcome"],
  });
export type GovernanceConcernUpdateInput = z.infer<typeof governanceConcernUpdateSchema>;

export const governanceRequirementCreateSchema = z.object({
  id: z.uuid().optional(),
  source: z.enum(governanceRequirementSources),
  /** The clause, regulation or code reference, e.g. "BRCGS 1.1.2", "Reg (EU) 1169/2011". */
  reference: optionalText(200).optional(),
  title: z.string().trim().min(1).max(300),
  /** For a customer requirement, whose. */
  customerName: optionalText(200).optional(),
  description: optionalText(4000).optional(),
  ownerUserId: z.uuid().nullable().optional(),
  reviewDueOn: isoDate.nullable().optional(),
});
export type GovernanceRequirementCreateInput = z.infer<typeof governanceRequirementCreateSchema>;

export const governanceRequirementUpdateSchema = z
  .object({
    source: z.enum(governanceRequirementSources),
    reference: optionalText(200),
    title: z.string().trim().min(1).max(300),
    customerName: optionalText(200),
    description: optionalText(4000),
    ownerUserId: z.uuid().nullable(),
    reviewDueOn: isoDate.nullable(),
    status: z.enum(["active", "archived"]),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to update");
export type GovernanceRequirementUpdateInput = z.infer<typeof governanceRequirementUpdateSchema>;

/** Recording a compliance review of a requirement. */
export const governanceComplianceReviewSchema = z.object({
  reviewedOn: isoDate,
  compliance: z.enum(
    governanceComplianceStatuses.filter((s) => s !== "not_assessed") as [
      "compliant",
      "partial",
      "non_compliant",
    ],
  ),
  notes: optionalText(4000).optional(),
  nextReviewOn: isoDate,
});
export type GovernanceComplianceReviewInput = z.infer<typeof governanceComplianceReviewSchema>;

export const governanceDecisionSchema = z.object({
  /** Stable within the review. */
  id: z.uuid(),
  /** The agenda topic it came from. */
  topic: optionalText(200),
  decision: z.string().trim().min(1).max(2000),
  /** Who follows it up; a task is created for them when the review is signed. */
  ownerUserId: z.uuid().nullable(),
  dueOn: isoDate.nullable(),
});
export type GovernanceDecision = z.infer<typeof governanceDecisionSchema>;

export const governanceReviewCreateSchema = z
  .object({
    id: z.uuid().optional(),
    title: z.string().trim().min(1).max(200),
    /** The period the review looks back over. */
    periodFrom: isoDate,
    periodTo: isoDate,
    heldOn: isoDate.nullable().optional(),
  })
  .refine((r) => r.periodFrom <= r.periodTo, {
    message: "The period ends before it starts",
    path: ["periodTo"],
  });
export type GovernanceReviewCreateInput = z.infer<typeof governanceReviewCreateSchema>;

export const governanceReviewUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    periodFrom: isoDate,
    periodTo: isoDate,
    heldOn: isoDate.nullable(),
    attendees: optionalText(2000),
    /** Discussion notes per agenda topic. */
    notes: z.record(z.string().max(60), z.string().max(10_000)),
    /** Resources needed: people, equipment, budget. */
    resources: optionalText(4000),
    decisions: z.array(governanceDecisionSchema).max(100),
    /** The team the follow-up tasks go to (Tasks module). */
    followUpTeamId: z.uuid().nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to update")
  .refine((p) => !p.periodFrom || !p.periodTo || p.periodFrom <= p.periodTo, {
    message: "The period ends before it starts",
    path: ["periodTo"],
  });
export type GovernanceReviewUpdateInput = z.infer<typeof governanceReviewUpdateSchema>;

// ─── Rules ───────────────────────────────────────────────────────────────────

export type GovernanceDueStatus = "none" | "overdue" | "due_soon" | "ok";
export const governanceDueStatusLabels: Record<GovernanceDueStatus, string> = {
  none: "No date",
  overdue: "Overdue",
  due_soon: "Due soon",
  ok: "On time",
};

export function governanceDueStatus(dueOn: string | null, today: string): GovernanceDueStatus {
  if (!dueOn) return "none";
  if (dueOn < today) return "overdue";
  return dueOn <= addDays(today, GOVERNANCE_DUE_SOON_DAYS) ? "due_soon" : "ok";
}

export type GovernanceCultureState = "planned" | "overdue" | "done" | "cancelled";
export const governanceCultureStateLabels: Record<GovernanceCultureState, string> = {
  planned: "Planned",
  overdue: "Overdue",
  done: "Done",
  cancelled: "Cancelled",
};
export function governanceCultureState(
  a: { plannedOn: string; completedOn: string | null; cancelledAt: unknown },
  today: string,
): GovernanceCultureState {
  if (a.cancelledAt) return "cancelled";
  if (a.completedOn) return "done";
  return a.plannedOn < today ? "overdue" : "planned";
}

/** The standing agenda of a management review; the evidence feeds the topics. */
export const governanceAgendaTopics = [
  { key: "previous_actions", label: "Actions from previous reviews" },
  { key: "objectives", label: "Food safety and quality objectives" },
  { key: "culture", label: "Food safety culture plan" },
  { key: "complaints", label: "Complaints and customer feedback" },
  { key: "nonconformances", label: "Non-conformances and corrective action" },
  { key: "audits", label: "Internal and external audits" },
  { key: "incidents", label: "Incidents, withdrawals and recalls" },
  { key: "testing", label: "Testing and verification results" },
  { key: "defence", label: "Food defence and fraud" },
  { key: "concerns", label: "Confidential concerns" },
  { key: "requirements", label: "Legal and customer requirements" },
  { key: "resources", label: "Resources" },
] as const;
export type GovernanceAgendaKey = (typeof governanceAgendaTopics)[number]["key"];

/** Why a review can't be signed yet (empty when it can). */
export function governanceSignBlockers(
  review: {
    heldOn: string | null;
    attendees: string | null;
    decisions: readonly GovernanceDecision[];
    followUpTeamId: string | null;
    tasksActive: boolean;
  },
  today: string,
): string[] {
  const out: string[] = [];
  if (!review.heldOn) out.push("Record when the review was held");
  else if (review.heldOn > today) out.push("The review can't be signed before it is held");
  if (!review.attendees) out.push("Record who attended");
  const owned = review.decisions.filter((d) => d.ownerUserId);
  if (owned.length && review.tasksActive && !review.followUpTeamId)
    out.push("Choose the team the follow-up tasks go to");
  for (const d of owned) if (!d.dueOn) out.push(`Set a due date for "${d.decision.slice(0, 60)}"`);
  return out;
}
