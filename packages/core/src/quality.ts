import { z } from "zod";
import { hasModuleLevel, type ModuleAccessLevel } from "./modules";
import type { SupplierApprovalStatus } from "./items";
import { addDaysIso, addMonthsIso } from "./training";

/**
 * Quality management module: customer and consumer complaints, non-conformances with root cause
 * and corrective and preventive action (CAPA), the internal audit schedule, and mock recall
 * (traceability) tests. Builds on items and stock lots. No DOM or Node APIs.
 *
 * Sign-off is a person's: closing a complaint, closing (verifying) a non-conformance, completing
 * an audit and recording or voiding a recall test refuse API tokens.
 */

export const qualitySeverities = ["minor", "major", "critical"] as const;
export type QualitySeverity = (typeof qualitySeverities)[number];
export const qualitySeverityLabels: Record<QualitySeverity, string> = {
  minor: "Minor",
  major: "Major",
  critical: "Critical",
};

// ─── Complaints ──────────────────────────────────────────────────────────────

export const complaintSources = ["consumer", "customer", "retailer", "regulator", "internal"] as const;
export type ComplaintSource = (typeof complaintSources)[number];
export const complaintSourceLabels: Record<ComplaintSource, string> = {
  consumer: "Consumer",
  customer: "Customer",
  retailer: "Retailer",
  regulator: "Regulator",
  internal: "Internal",
};

export const complaintCategories = [
  "foreign_body",
  "allergen",
  "illness",
  "microbiological",
  "quality",
  "labelling",
  "packaging",
  "quantity",
  "other",
] as const;
export type ComplaintCategory = (typeof complaintCategories)[number];
export const complaintCategoryLabels: Record<ComplaintCategory, string> = {
  foreign_body: "Foreign body",
  allergen: "Allergen",
  illness: "Illness or injury",
  microbiological: "Microbiological",
  quality: "Quality (taste, texture, appearance)",
  labelling: "Labelling",
  packaging: "Packaging",
  quantity: "Quantity or weight",
  other: "Other",
};
/** Categories that are food-safety complaints: a critical one opens a non-conformance at once. */
export const foodSafetyComplaintCategories: readonly ComplaintCategory[] = [
  "foreign_body",
  "allergen",
  "illness",
  "microbiological",
];

export const complaintStatuses = ["open", "investigating", "closed"] as const;
export type ComplaintStatus = (typeof complaintStatuses)[number];
export const complaintStatusLabels: Record<ComplaintStatus, string> = {
  open: "Open",
  investigating: "Investigating",
  closed: "Closed",
};

/**
 * Complaint status changes. `open` ↔ `investigating` is ordinary work (`write`); closing and
 * reopening are a manager's decision in person and go through their own routes.
 */
export const canTransitionComplaint = (from: ComplaintStatus, to: ComplaintStatus) =>
  from !== to &&
  ((from === "open" && to === "investigating") ||
    (from === "investigating" && to === "open") ||
    (from !== "closed" && to === "closed") ||
    (from === "closed" && to === "investigating"));

/**
 * Whether a new complaint opens a non-conformance by itself, in the same transaction: any critical
 * complaint, and a major one about food safety. A food-safety problem never waits for triage.
 */
export const complaintOpensNonconformance = (c: { severity: QualitySeverity; category: ComplaintCategory }) =>
  c.severity === "critical" || (c.severity === "major" && foodSafetyComplaintCategories.includes(c.category));

// ─── Non-conformances (CAPA) ─────────────────────────────────────────────────

export const nonconformanceSources = [
  "complaint",
  "audit",
  "supplier",
  "process",
  "product",
  "other",
] as const;
export type NonconformanceSource = (typeof nonconformanceSources)[number];
export const nonconformanceSourceLabels: Record<NonconformanceSource, string> = {
  complaint: "Complaint",
  audit: "Audit finding",
  supplier: "Supplier",
  process: "Process",
  product: "Product",
  other: "Other",
};

/**
 * `open`: raised, containment and investigation under way; `action_taken`: corrective action done,
 * waiting for a manager to verify it worked; `closed`: verified effective (a person, `manage`).
 */
export const nonconformanceStatuses = ["open", "action_taken", "closed"] as const;
export type NonconformanceStatus = (typeof nonconformanceStatuses)[number];
export const nonconformanceStatusLabels: Record<NonconformanceStatus, string> = {
  open: "Open",
  action_taken: "Awaiting verification",
  closed: "Closed",
};

export interface NonconformanceForState {
  status: NonconformanceStatus;
  dueOn: string | null;
}

/** Past its due date and not closed. */
export const isNonconformanceOverdue = (nc: NonconformanceForState, today: string) =>
  nc.status !== "closed" && nc.dueOn !== null && nc.dueOn < today;

/** Default days to act on a non-conformance, by severity. */
export const nonconformanceDueDays: Record<QualitySeverity, number> = { critical: 7, major: 28, minor: 56 };

/** A non-conformance falling due (or overdue) notifies its owner and the managers (the sweep). */
export const nonconformanceNotifiable = (nc: NonconformanceForState, today: string) =>
  nc.status !== "closed" && nc.dueOn !== null && nc.dueOn <= today;

/**
 * Four-eyes on verification: whoever marked the corrective action as taken may not also verify
 * (close) it, unless nobody else could (they are the only member with `manage` on quality).
 * `managerIds` are the members who hold `manage`. A record with no one on it (taken before this
 * was recorded) can be verified by any manager.
 */
export function canVerifyNonconformance(input: {
  actionTakenBy: string | null;
  verifierId: string;
  managerIds: readonly string[];
}): boolean {
  if (input.actionTakenBy !== input.verifierId) return true;
  return input.managerIds.every((id) => id === input.verifierId);
}

/** Open supplier non-conformances this many (of any severity) suggest suspending the supplier. */
export const SUPPLIER_NC_SUSPEND_COUNT = 3;

export interface SupplierStandingNc {
  severity: QualitySeverity;
  status: NonconformanceStatus;
  dueOn: string | null;
}

/**
 * Whether a supplier's open non-conformances call for a look at its approval. A suggestion for a
 * person with `manage` on items, never an action: any open critical or major one, or
 * `SUPPLIER_NC_SUSPEND_COUNT` open of any severity. Nothing to suggest when the supplier is already
 * suspended or rejected.
 */
export function supplierSuspensionAdvice(
  ncs: readonly SupplierStandingNc[],
  approvalStatus: SupplierApprovalStatus,
): { suggest: boolean; reasons: string[] } {
  if (approvalStatus === "suspended" || approvalStatus === "rejected") return { suggest: false, reasons: [] };
  const open = ncs.filter((n) => n.status !== "closed");
  const reasons: string[] = [];
  const critical = open.filter((n) => n.severity === "critical").length;
  const major = open.filter((n) => n.severity === "major").length;
  if (critical) reasons.push(`${critical} open critical non-conformance${critical === 1 ? "" : "s"}`);
  if (major) reasons.push(`${major} open major non-conformance${major === 1 ? "" : "s"}`);
  if (!critical && !major && open.length >= SUPPLIER_NC_SUSPEND_COUNT)
    reasons.push(`${open.length} open non-conformances`);
  return { suggest: reasons.length > 0, reasons };
}

// ─── Internal audits ─────────────────────────────────────────────────────────

export const auditStatuses = ["planned", "completed", "cancelled"] as const;
export type AuditStatus = (typeof auditStatuses)[number];
export const auditStatusLabels: Record<AuditStatus, string> = {
  planned: "Planned",
  completed: "Completed",
  cancelled: "Cancelled",
};

/**
 * Who may sign off (complete) an audit: the auditor, when the auditor is a member, or whoever
 * heads quality, meaning anyone with `manage` on the module (owners and admins always have it). An outside
 * auditor can't sign in, so their audit is recorded by someone with `manage`.
 */
export const canCompleteAudit = (
  audit: { auditorUserId: string | null },
  actor: { userId: string; level: ModuleAccessLevel | undefined },
) =>
  hasModuleLevel(actor.level, "manage") ||
  (audit.auditorUserId !== null && audit.auditorUserId === actor.userId);

/** Days before a planned audit when it shows as coming up. */
export const AUDIT_SOON_DAYS = 14;

/** Where a planned audit stands on a date: `overdue` once its planned date has passed. */
export type AuditState = "overdue" | "soon" | "planned" | "completed" | "cancelled";
export function auditState(
  audit: { status: AuditStatus; plannedOn: string },
  today: string,
  soonDays = AUDIT_SOON_DAYS,
): AuditState {
  if (audit.status !== "planned") return audit.status;
  if (audit.plannedOn < today) return "overdue";
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + soonDays);
  return audit.plannedOn <= soon.toISOString().slice(0, 10) ? "soon" : "planned";
}

// ─── Recurring audit programme ───────────────────────────────────────────────

/** Audits of a programme are planned this many days ahead of their date (by the sweep). */
export const AUDIT_PROGRAMME_AHEAD_DAYS = 60;
/** An occurrence this many intervals in the past is skipped rather than planned late. */
export const AUDIT_PROGRAMME_MAX_CATCH_UP = 1;
export const auditProgrammeIntervals = [1, 2, 3, 6, 12, 24] as const;
export const auditIntervalLabel = (months: number) =>
  months === 1
    ? "Monthly"
    : months === 3
      ? "Quarterly"
      : months === 6
        ? "Every 6 months"
        : months === 12
          ? "Yearly"
          : `Every ${months} months`;

/** ISO weekdays, Monday 1 … Sunday 7 (`quality_audit_programmes.weekday`). */
export const auditWeekdays = [1, 2, 3, 4, 5, 6, 7] as const;
export const auditWeekdayLabels: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};

/** The ISO weekday (Monday 1 … Sunday 7) of a `YYYY-MM-DD` date. */
export const isoWeekdayOf = (date: string): number =>
  ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/**
 * The first date on or after `date` that falls on the ISO `weekday` (at most 6 days later). `null`
 * or `undefined`: the date as it is.
 */
export function onOrAfterWeekday(date: string, weekday: number | null | undefined): string {
  if (!weekday) return date;
  return addDaysIso(date, (weekday - isoWeekdayOf(date) + 7) % 7);
}

/**
 * The dates of the audits a programme should plan on `today`: from `nextPlannedOn` every
 * `intervalMonths` while the date is within `AUDIT_PROGRAMME_AHEAD_DAYS`. Dates more than one
 * interval in the past are skipped (a programme left alone for years doesn't plan a backlog of
 * overdue audits). With a `weekday` each audit is pinned to the first such day on or after its
 * date; the stored dates stay the unpinned ones, so pinning never drifts the schedule later.
 * `next` is the unpinned date of the next audit not yet planned.
 */
export function programmeOccurrences(
  programme: { nextPlannedOn: string; intervalMonths: number; weekday?: number | null },
  today: string,
): { generate: string[]; next: string } {
  const horizon = addDaysIso(today, AUDIT_PROGRAMME_AHEAD_DAYS);
  const stale = addMonthsIso(today, -programme.intervalMonths * AUDIT_PROGRAMME_MAX_CATCH_UP);
  const generate: string[] = [];
  // The programme's anchor day: months are added to the first date so 31 Jan, 28 Feb, 31 Mar holds.
  let n = 0;
  let date = programme.nextPlannedOn;
  while (onOrAfterWeekday(date, programme.weekday) <= horizon && n < 200) {
    const pinned = onOrAfterWeekday(date, programme.weekday);
    if (pinned >= stale) generate.push(pinned);
    n += 1;
    date = addMonthsIso(programme.nextPlannedOn, programme.intervalMonths * n);
  }
  return { generate, next: date };
}

// ─── Complaint trends ────────────────────────────────────────────────────────

/** Complaints per million units, one decimal; null when no units are on record for the period. */
export const complaintsPerMillion = (complaints: number, units: number) =>
  units > 0 ? Math.round((complaints / units) * 10_000_000) / 10 : null;

/** `YYYY-MM-01` of a date's month. */
export const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

/** The `months` month starts ending with `today`'s month, oldest first. */
export function trendMonths(today: string, months: number): string[] {
  const last = monthStart(today);
  return Array.from({ length: months }, (_, i) => addMonthsIso(last, -(months - 1 - i)));
}

// ─── Mock recall (traceability) tests ────────────────────────────────────────

export const recallDirections = ["forward", "backward", "both"] as const;
export type RecallDirection = (typeof recallDirections)[number];
export const recallDirectionLabels: Record<RecallDirection, string> = {
  forward: "Forward (to customers)",
  backward: "Backward (to raw materials)",
  both: "Both directions",
};

/** BRCGS: trace a lot and reconcile it fully within 4 hours, at least once a year. */
export const RECALL_TARGET_MINUTES = 240;
export const RECALL_TEST_INTERVAL_MONTHS = 12;
/** Days before the yearly test is due when it shows as coming up. */
export const RECALL_SOON_DAYS = 30;

export interface RecallTestResult {
  /** Started minutes, rounded up: 4 h 0 min 29 s is 241 minutes. */
  durationMinutes: number;
  /** Traced against expected, as a percentage with one decimal, for display; null when nothing was expected. */
  reconciledPercent: number | null;
  withinTime: boolean;
  /** Exactly the lot's quantity accounted for (to the stored 6 decimals), no more and no less. */
  reconciled: boolean;
  passed: boolean;
}

/**
 * Quantities are stored with 6 decimals: two are the same when they differ by less than half the
 * last decimal, or by float rounding for very large ones. Not by rounded percentages, and not by
 * `n * 1e6` integers, which lose precision above about 9e9.
 */
const sameQuantity = (a: number, b: number) =>
  Math.abs(a - b) < Math.max(5e-7, Math.max(Math.abs(a), Math.abs(b)) * Number.EPSILON * 4);

/**
 * Works out a recall test's result. Over-accounting fails like under-accounting: the numbers
 * don't add up. Time is compared to the millisecond, so a second over the target fails.
 */
export function recallTestResult(input: {
  startedAt: string | Date;
  completedAt: string | Date;
  quantityExpected: number;
  quantityTraced: number;
  targetMinutes?: number;
}): RecallTestResult {
  const start = new Date(input.startedAt).getTime();
  const end = new Date(input.completedAt).getTime();
  const elapsed = Math.max(0, end - start);
  const durationMinutes = Math.ceil(elapsed / 60_000);
  const reconciledPercent =
    input.quantityExpected > 0
      ? Math.round((input.quantityTraced / input.quantityExpected) * 1000) / 10
      : null;
  const withinTime = elapsed <= (input.targetMinutes ?? RECALL_TARGET_MINUTES) * 60_000;
  const reconciled = input.quantityExpected > 0 && sameQuantity(input.quantityTraced, input.quantityExpected);
  return { durationMinutes, reconciledPercent, withinTime, reconciled, passed: withinTime && reconciled };
}

export type RecallTestState = "never" | "overdue" | "soon" | "ok";

/** When the next recall test is due (a year after the last one that wasn't voided) and how that stands. */
export function recallTestSchedule(lastConductedOn: string | null, today: string) {
  if (!lastConductedOn) return { dueOn: null, state: "never" as RecallTestState };
  const dueOn = addMonthsIso(lastConductedOn, RECALL_TEST_INTERVAL_MONTHS);
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + RECALL_SOON_DAYS);
  const state: RecallTestState =
    dueOn < today ? "overdue" : dueOn <= soon.toISOString().slice(0, 10) ? "soon" : "ok";
  return { dueOn, state };
}

// ─── References ──────────────────────────────────────────────────────────────

export const qualityReferencePrefixes = {
  complaint: "CMP",
  nonconformance: "NC",
  audit: "IA",
  recallTest: "MR",
} as const;

/** `CMP-2026-007`: prefix, the year of the record's date and a sequence that restarts each year. */
export const qualityReference = (prefix: string, isoDate: string, sequence: number) =>
  `${prefix}-${isoDate.slice(0, 4)}-${String(sequence).padStart(3, "0")}`;

/** The sequence number of a reference made by `qualityReference`, or null. */
export const qualityReferenceSequence = (reference: string) => {
  const match = /-(\d{4})-(\d+)$/.exec(reference);
  return match ? Number(match[2]) : null;
};

// ─── Schemas ─────────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const isoDate = z.iso.date();
const page = {
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
};
const q = z.string().trim().max(200).optional();

const complaintFields = {
  receivedOn: isoDate,
  source: z.enum(complaintSources),
  category: z.enum(complaintCategories),
  severity: z.enum(qualitySeverities),
  /** The customer's or consumer's name and how to reach them: personal data, never in the sync log. */
  complainantName: optionalText(200),
  complainantContact: optionalText(500),
  /** The customer account (a retailer or wholesaler), when it isn't the complainant. */
  customer: optionalText(200),
  itemId: z.uuid().nullable(),
  lotId: z.uuid().nullable(),
  /** The lot or date code as reported, which may not match a lot on record. */
  reportedLotCode: optionalText(100),
  description: z.string().trim().min(1).max(8000),
  investigation: optionalText(8000),
  rootCause: optionalText(4000),
  /** What was said or sent back to the complainant. */
  response: optionalText(4000),
  /** Whether the complaint was found justified, once known. */
  justified: z.boolean().nullable(),
};

export const complaintCreateSchema = z.object({
  id: z.uuid().optional(),
  receivedOn: complaintFields.receivedOn,
  source: complaintFields.source,
  category: complaintFields.category,
  severity: complaintFields.severity.default("minor"),
  complainantName: complaintFields.complainantName.optional(),
  complainantContact: complaintFields.complainantContact.optional(),
  customer: complaintFields.customer.optional(),
  itemId: complaintFields.itemId.optional(),
  lotId: complaintFields.lotId.optional(),
  reportedLotCode: complaintFields.reportedLotCode.optional(),
  description: complaintFields.description,
});
export type ComplaintCreateInput = z.infer<typeof complaintCreateSchema>;

export const complaintUpdateSchema = z
  .object({ ...complaintFields, status: z.enum(["open", "investigating"]) })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type ComplaintUpdateInput = z.infer<typeof complaintUpdateSchema>;

export const complaintCloseSchema = z.object({
  /** The reply to the complainant; required unless one is already on the complaint. */
  response: optionalText(4000).optional(),
  justified: z.boolean().nullable().optional(),
  note: optionalText(2000).optional(),
});
export type ComplaintCloseInput = z.infer<typeof complaintCloseSchema>;

export const qualityReopenSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
export type QualityReopenInput = z.infer<typeof qualityReopenSchema>;

export const complaintListQuerySchema = z.object({
  q,
  status: z.enum([...complaintStatuses, "unresolved", "all"]).default("all"),
  category: z.enum(complaintCategories).optional(),
  severity: z.enum(qualitySeverities).optional(),
  itemId: z.uuid().optional(),
  lotId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...page,
});
export type ComplaintListQuery = z.infer<typeof complaintListQuerySchema>;

const nonconformanceFields = {
  raisedOn: isoDate,
  source: z.enum(nonconformanceSources),
  severity: z.enum(qualitySeverities),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(8000),
  complaintId: z.uuid().nullable(),
  auditId: z.uuid().nullable(),
  itemId: z.uuid().nullable(),
  lotId: z.uuid().nullable(),
  supplierId: z.uuid().nullable(),
  /** What was done straight away to contain the problem (quarantine, hold, rework). */
  containment: optionalText(4000),
  rootCause: optionalText(4000),
  correctiveAction: optionalText(4000),
  preventiveAction: optionalText(4000),
  /** The member responsible for the action. */
  ownerUserId: z.uuid().nullable(),
  /** When the corrective action is due; defaults by severity. */
  dueOn: isoDate.nullable(),
};

export const nonconformanceCreateSchema = z
  .object({
    id: z.uuid().optional(),
    raisedOn: nonconformanceFields.raisedOn,
    source: nonconformanceFields.source,
    severity: nonconformanceFields.severity.default("minor"),
    title: nonconformanceFields.title,
    description: nonconformanceFields.description,
    complaintId: nonconformanceFields.complaintId.optional(),
    auditId: nonconformanceFields.auditId.optional(),
    itemId: nonconformanceFields.itemId.optional(),
    lotId: nonconformanceFields.lotId.optional(),
    supplierId: nonconformanceFields.supplierId.optional(),
    containment: nonconformanceFields.containment.optional(),
    rootCause: nonconformanceFields.rootCause.optional(),
    correctiveAction: nonconformanceFields.correctiveAction.optional(),
    preventiveAction: nonconformanceFields.preventiveAction.optional(),
    ownerUserId: nonconformanceFields.ownerUserId.optional(),
    dueOn: nonconformanceFields.dueOn.optional(),
  })
  .refine((n) => (n.source === "complaint") === Boolean(n.complaintId), {
    message: "A non-conformance has the source complaint exactly when it is raised from one (complaintId)",
    path: ["complaintId"],
  })
  .refine((n) => (n.source === "audit") === Boolean(n.auditId), {
    message: "A non-conformance has the source audit exactly when it is raised from one (auditId)",
    path: ["auditId"],
  })
  .refine((n) => !n.dueOn || n.dueOn >= n.raisedOn, {
    message: "The due date can't be before the date it was raised",
    path: ["dueOn"],
  });
export type NonconformanceCreateInput = z.infer<typeof nonconformanceCreateSchema>;

export const nonconformanceUpdateSchema = z
  .object({
    ...nonconformanceFields,
    /** Every non-conformance keeps a due date; it can be moved, not removed. */
    dueOn: isoDate,
    status: z.enum(["open", "action_taken"]),
  })
  .omit({ complaintId: true, auditId: true })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type NonconformanceUpdateInput = z.infer<typeof nonconformanceUpdateSchema>;

/** Closing a non-conformance is verifying that the action worked. */
export const nonconformanceCloseSchema = z.object({
  verificationNote: z.string().trim().min(1).max(2000),
});
export type NonconformanceCloseInput = z.infer<typeof nonconformanceCloseSchema>;

export const nonconformanceListQuerySchema = z.object({
  q,
  status: z.enum([...nonconformanceStatuses, "unresolved", "overdue", "all"]).default("all"),
  source: z.enum(nonconformanceSources).optional(),
  severity: z.enum(qualitySeverities).optional(),
  complaintId: z.uuid().optional(),
  auditId: z.uuid().optional(),
  ownerUserId: z.uuid().optional(),
  itemId: z.uuid().optional(),
  supplierId: z.uuid().optional(),
  ...page,
});
export type NonconformanceListQuery = z.infer<typeof nonconformanceListQuerySchema>;

const auditFields = {
  title: z.string().trim().min(1).max(200),
  /** What is audited: an area, a process, the BRCGS clauses covered. */
  scope: optionalText(4000),
  plannedOn: isoDate,
  /** A member who audits, or an outside auditor by name. */
  auditorUserId: z.uuid().nullable(),
  auditorName: optionalText(200),
};
const oneAuditor = (a: { auditorUserId?: string | null; auditorName?: string | null }) =>
  !(a.auditorUserId && a.auditorName);

export const auditCreateSchema = z
  .object({
    id: z.uuid().optional(),
    title: auditFields.title,
    scope: auditFields.scope.optional(),
    plannedOn: auditFields.plannedOn,
    auditorUserId: auditFields.auditorUserId.optional(),
    auditorName: auditFields.auditorName.optional(),
  })
  .refine(oneAuditor, {
    message: "Give an auditor member or an auditor name, not both",
    path: ["auditorName"],
  });
export type AuditCreateInput = z.infer<typeof auditCreateSchema>;

export const auditUpdateSchema = z
  .object(auditFields)
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update")
  .refine(oneAuditor, {
    message: "Give an auditor member or an auditor name, not both",
    path: ["auditorName"],
  });
export type AuditUpdateInput = z.infer<typeof auditUpdateSchema>;

const findingSchema = z.object({
  title: nonconformanceFields.title,
  description: nonconformanceFields.description,
  severity: nonconformanceFields.severity.default("minor"),
  correctiveAction: nonconformanceFields.correctiveAction.optional(),
  ownerUserId: nonconformanceFields.ownerUserId.optional(),
  dueOn: nonconformanceFields.dueOn.optional(),
});
export type AuditFindingInput = z.infer<typeof findingSchema>;

export const auditCompleteSchema = z.object({
  completedOn: isoDate,
  summary: z.string().trim().min(1).max(8000),
  /** Each finding becomes a non-conformance (source `audit`) in the same transaction. */
  findings: z.array(findingSchema).max(100).default([]),
});
export type AuditCompleteInput = z.infer<typeof auditCompleteSchema>;

export const auditCancelSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
export type AuditCancelInput = z.infer<typeof auditCancelSchema>;

export const auditListQuerySchema = z.object({
  q,
  status: z.enum([...auditStatuses, "all"]).default("all"),
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...page,
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

/** Below the `numeric(18,6)` column's limit. */
const quantity = z.number().min(0).max(1e11);
/** A traced quantity this far above the expected one is a unit mistake, not a result. */
const MAX_TRACED_RATIO = 1000;

export const recallTestCreateSchema = z
  .object({
    id: z.uuid().optional(),
    conductedOn: isoDate,
    lotId: z.uuid(),
    direction: z.enum(recallDirections).default("both"),
    /** The scenario played, e.g. "customer reports glass in product". */
    scenario: optionalText(2000).optional(),
    startedAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }),
    /** In the lot item's unit: what was received or produced. */
    quantityExpected: quantity,
    /** In the same unit: everything accounted for (in stock, used, dispatched, wasted). */
    quantityTraced: quantity,
    notes: optionalText(4000).optional(),
  })
  .refine((r) => new Date(r.completedAt) >= new Date(r.startedAt), {
    message: "The test can't finish before it started",
    path: ["completedAt"],
  })
  .refine((r) => r.quantityExpected === 0 || r.quantityTraced <= r.quantityExpected * MAX_TRACED_RATIO, {
    message: `The traced quantity is over ${MAX_TRACED_RATIO} times the lot's: check the unit`,
    path: ["quantityTraced"],
  })
  .refine(
    // A day either side: the date is the person's local day, the times are absolute.
    (r) => {
      const day = new Date(r.startedAt).toISOString().slice(0, 10);
      const gap = Math.abs(Date.parse(`${day}T00:00:00Z`) - Date.parse(`${r.conductedOn}T00:00:00Z`));
      return gap <= 86_400_000;
    },
    { message: "The date must be the day the test started", path: ["conductedOn"] },
  );
export type RecallTestCreateInput = z.infer<typeof recallTestCreateSchema>;

export const recallTestVoidSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
export type RecallTestVoidInput = z.infer<typeof recallTestVoidSchema>;

export const recallTestListQuerySchema = z.object({
  q,
  lotId: z.uuid().optional(),
  includeVoided: z.enum(["true", "false"]).optional(),
  ...page,
});
export type RecallTestListQuery = z.infer<typeof recallTestListQuerySchema>;

// Recurring audit programme.

const programmeFields = {
  title: z.string().trim().min(1).max(200),
  /** The area, process or standard clauses covered: copied onto every audit it plans. */
  scope: optionalText(4000),
  /** Months between audits. */
  intervalMonths: z.number().int().min(1).max(60),
  /** The date of the next audit that is not yet planned. */
  nextPlannedOn: isoDate,
  /** Pins each audit to this ISO weekday (1 Monday … 7 Sunday): the first such day on or after its date. */
  weekday: z.number().int().min(1).max(7).nullable(),
  auditorUserId: z.uuid().nullable(),
  auditorName: optionalText(200),
  active: z.boolean(),
};

export const auditProgrammeCreateSchema = z
  .object({
    id: z.uuid().optional(),
    title: programmeFields.title,
    scope: programmeFields.scope.optional(),
    intervalMonths: programmeFields.intervalMonths,
    nextPlannedOn: programmeFields.nextPlannedOn,
    weekday: programmeFields.weekday.optional(),
    auditorUserId: programmeFields.auditorUserId.optional(),
    auditorName: programmeFields.auditorName.optional(),
  })
  .refine(oneAuditor, {
    message: "Give an auditor member or an auditor name, not both",
    path: ["auditorName"],
  });
export type AuditProgrammeCreateInput = z.infer<typeof auditProgrammeCreateSchema>;

export const auditProgrammeUpdateSchema = z
  .object(programmeFields)
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update")
  .refine(oneAuditor, {
    message: "Give an auditor member or an auditor name, not both",
    path: ["auditorName"],
  });
export type AuditProgrammeUpdateInput = z.infer<typeof auditProgrammeUpdateSchema>;

// Complaint trends.

/** Units sold of a product in a month: `period` is any date in the month. */
export const salesVolumeSchema = z.object({
  itemId: z.uuid(),
  period: isoDate,
  units: z.number().min(0).max(1e12),
});
export type SalesVolumeInput = z.infer<typeof salesVolumeSchema>;

export const salesVolumeListQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(36).default(12),
  itemId: z.uuid().optional(),
});
export type SalesVolumeListQuery = z.infer<typeof salesVolumeListQuerySchema>;

export const complaintTrendsQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(36).default(12),
});
export type ComplaintTrendsQuery = z.infer<typeof complaintTrendsQuerySchema>;

// Supplier non-conformances and the supplier's approval.

/** A manager records which open supplier non-conformances they weighed in the supplier's approval decision. */
export const supplierReviewSchema = z.object({
  nonconformanceIds: z.array(z.uuid()).min(1).max(50),
});
export type SupplierReviewInput = z.infer<typeof supplierReviewSchema>;

// Recall test prefill.

export const recallPrefillQuerySchema = z.object({
  lotId: z.uuid(),
  direction: z.enum(recallDirections).default("both"),
});
export type RecallPrefillQuery = z.infer<typeof recallPrefillQuerySchema>;
