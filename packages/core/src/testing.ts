import { z } from "zod";
import { specificationParameterCategories, type SpecificationParameterCategory } from "./specifications";

/**
 * Testing module: laboratories, sampling points, risk-based sampling plans, samples and their
 * results judged against limits, out-of-specification investigations and trends. Validation and
 * the judging rules are shared by server, web and MCP. No DOM or Node APIs.
 *
 * A sample is taken from a stock lot (product, ingredient, packaging) or from a sampling point
 * (an environmental swab site, a water outlet). Its analytes, with their limits, are copied onto
 * the sample when it is logged: from what was asked for, else the plan, else the item's approved
 * specification. A failed result opens an investigation on the sample and puts an available lot on
 * hold (quarantine) in the same transaction; a person closes the investigation.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const testingRecordStatuses = ["active", "archived"] as const;
export type TestingRecordStatus = (typeof testingRecordStatuses)[number];

export const samplingPointKinds = ["environmental", "water", "air", "other"] as const;
export type SamplingPointKind = (typeof samplingPointKinds)[number];
export const samplingPointKindLabels: Record<SamplingPointKind, string> = {
  environmental: "Environmental swab",
  water: "Water",
  air: "Air",
  other: "Other",
};

/** What a sample is taken from. */
export const testSubjects = ["lot", "point"] as const;
export type TestSubject = (typeof testSubjects)[number];
export const testSubjectLabels: Record<TestSubject, string> = { lot: "Stock lot", point: "Sampling point" };

export const testSampleStatuses = ["awaiting_results", "complete", "cancelled"] as const;
export type TestSampleStatus = (typeof testSampleStatuses)[number];
export const testSampleStatusLabels: Record<TestSampleStatus, string> = {
  awaiting_results: "Awaiting results",
  complete: "Complete",
  cancelled: "Cancelled",
};

export const testOutcomes = ["pending", "pass", "fail"] as const;
export type TestOutcome = (typeof testOutcomes)[number];
export const testOutcomeLabels: Record<TestOutcome, string> = {
  pending: "Pending",
  pass: "Pass",
  fail: "Fail",
};

export const testInvestigationStatuses = ["open", "closed"] as const;
export type TestInvestigationStatus = (typeof testInvestigationStatuses)[number];

/** A plan falling due within this many days shows as "due soon". */
export const TEST_PLAN_DUE_SOON_DAYS = 7;

// ─── Validation ──────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const requiredText = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.iso.date();
const sixDecimals = (value: number) => Math.abs(value * 1e6 - Math.round(value * 1e6)) < 1e-4;
const decimal = z
  .number()
  .finite()
  .min(-1_000_000_000)
  .max(1_000_000_000)
  .refine(sixDecimals, "At most 6 decimal places");

export const laboratoryInputSchema = z.object({
  name: requiredText(200),
  /** e.g. "UKAS 1234 (ISO 17025)". */
  accreditation: optionalText(200).optional(),
  accreditationExpiresOn: isoDate.nullable().optional(),
  /** Tests done on site (ATP, allergen strips) rather than by an external laboratory. */
  inHouse: z.boolean().default(false),
  contact: optionalText(500).optional(),
  notes: optionalText(2000).optional(),
});
export type LaboratoryInput = z.infer<typeof laboratoryInputSchema>;
export const laboratoryUpdateSchema = laboratoryInputSchema
  .extend({ status: z.enum(testingRecordStatuses) })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to update");
export type LaboratoryUpdateInput = z.infer<typeof laboratoryUpdateSchema>;

export const samplingPointInputSchema = z.object({
  /** Unique among live points, case-insensitively, e.g. "HC-Z1-07". */
  code: requiredText(40),
  name: requiredText(200),
  kind: z.enum(samplingPointKinds),
  /** The hygiene or risk zone from the site's risk assessment, e.g. "High care · zone 1". */
  zone: optionalText(100).optional(),
  location: optionalText(200).optional(),
});
export type SamplingPointInput = z.infer<typeof samplingPointInputSchema>;
export const samplingPointUpdateSchema = samplingPointInputSchema
  .extend({ status: z.enum(testingRecordStatuses) })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to update");
export type SamplingPointUpdateInput = z.infer<typeof samplingPointUpdateSchema>;

/** What a sample is tested for and the limits it is judged against. */
export const analyteInputSchema = z
  .object({
    category: z.enum(specificationParameterCategories),
    name: requiredText(120),
    unit: optionalText(20).optional(),
    min: decimal.nullable().optional(),
    max: decimal.nullable().optional(),
    /** A limit that isn't a number: "Not detected", "Absent in 25 g". Judged by a person. */
    limitText: optionalText(200).optional(),
    method: optionalText(200).optional(),
  })
  .refine((a) => a.min != null || a.max != null || !!a.limitText, {
    message: "Give a minimum, a maximum or a written limit",
  })
  .refine((a) => a.min == null || a.max == null || a.min <= a.max, {
    message: "The minimum can't be above the maximum",
  });
export type AnalyteInput = z.infer<typeof analyteInputSchema>;

const analyteList = z
  .array(analyteInputSchema)
  .max(100)
  .refine((list) => new Set(list.map((a) => a.name.toLowerCase())).size === list.length, {
    message: "Each analyte may appear once",
  });

const planFields = z.object({
  name: requiredText(200),
  subject: z.enum(testSubjects),
  /** Lot plans: the item whose lots are sampled. */
  itemId: z.uuid().nullable().optional(),
  /** Point plans: the sampling point. */
  samplingPointId: z.uuid().nullable().optional(),
  /** How often a sample is due, from the last one taken, in days. */
  frequencyDays: z.number().int().min(1).max(730),
  /** Why this frequency: the risk assessment it follows. */
  rationale: optionalText(2000).optional(),
  laboratoryId: z.uuid().nullable().optional(),
  /**
   * The analytes to test for. Empty on a lot plan means the item's approved specification's
   * parameters, as they stand when each sample is logged.
   */
  analytes: analyteList.default([]),
});
const planConsistent = (p: {
  subject?: TestSubject | undefined;
  itemId?: string | null | undefined;
  samplingPointId?: string | null | undefined;
}) =>
  p.subject === "lot"
    ? !!p.itemId && !p.samplingPointId
    : p.subject === "point"
      ? !!p.samplingPointId && !p.itemId
      : true;
export const testPlanInputSchema = planFields
  .refine(planConsistent, { message: "A lot plan names an item; a point plan names a sampling point" })
  .refine((p) => p.subject === "lot" || p.analytes.length > 0, {
    message: "A sampling point plan needs at least one analyte",
    path: ["analytes"],
  });
export type TestPlanInput = z.infer<typeof testPlanInputSchema>;
/** Subject, item and point are fixed once created. */
export const testPlanUpdateSchema = planFields
  .omit({ subject: true, itemId: true, samplingPointId: true })
  .extend({ status: z.enum(testingRecordStatuses) })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to update");
export type TestPlanUpdateInput = z.infer<typeof testPlanUpdateSchema>;

export const testSampleCreateSchema = z
  .object({
    id: z.uuid().optional(),
    /** Generated (`S-2026-0001`) when left out; unique in the workspace. */
    reference: optionalText(40).optional(),
    subject: z.enum(testSubjects),
    lotId: z.uuid().nullable().optional(),
    samplingPointId: z.uuid().nullable().optional(),
    planId: z.uuid().nullable().optional(),
    laboratoryId: z.uuid().nullable().optional(),
    /** The business date it was taken (workspace time zone); not in the future. */
    sampledOn: isoDate,
    sampledBy: optionalText(200).optional(),
    notes: optionalText(2000).optional(),
    /** Overrides the plan's or the specification's analytes. */
    analytes: analyteList.optional(),
  })
  .refine((s) => (s.subject === "lot" ? !!s.lotId && !s.samplingPointId : !!s.samplingPointId && !s.lotId), {
    message: "A lot sample names a lot; a point sample names a sampling point",
  });
export type TestSampleCreateInput = z.infer<typeof testSampleCreateSchema>;

export const testResultEntrySchema = z.object({
  resultId: z.uuid(),
  value: decimal.nullable().optional(),
  /** What the laboratory reported when it isn't a number: "Not detected", "<10". */
  valueText: optionalText(200).optional(),
  /** Needed when the limit is written rather than numeric; a person may also fail a numeric pass. */
  outcome: z.enum(["pass", "fail"]).optional(),
  /** Required when the result already had a value: what was wrong with it. */
  correctionReason: optionalText(500).optional(),
});
export type TestResultEntry = z.infer<typeof testResultEntrySchema>;

export const testResultsRecordSchema = z.object({
  /** The date on the laboratory's report. */
  reportedOn: isoDate,
  reportReference: optionalText(200).optional(),
  results: z
    .array(testResultEntrySchema)
    .min(1)
    .max(100)
    .refine(
      (list) => new Set(list.map((r) => r.resultId)).size === list.length,
      "Each result may appear once",
    ),
});
export type TestResultsRecordInput = z.infer<typeof testResultsRecordSchema>;

export const testSampleCancelSchema = z.object({ reason: requiredText(500) });
export type TestSampleCancelInput = z.infer<typeof testSampleCancelSchema>;

export const testInvestigationCloseSchema = z.object({
  findings: requiredText(5000),
  rootCause: optionalText(2000).optional(),
  /** What was done: retest, deep clean, lot rejected or released. */
  actionTaken: requiredText(2000),
});
export type TestInvestigationCloseInput = z.infer<typeof testInvestigationCloseSchema>;

export const testSampleListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum([...testSampleStatuses, "all"]).default("all"),
  outcome: z.enum(testOutcomes).optional(),
  investigation: z.enum(testInvestigationStatuses).optional(),
  subject: z.enum(testSubjects).optional(),
  lotId: z.uuid().optional(),
  itemId: z.uuid().optional(),
  samplingPointId: z.uuid().optional(),
  planId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type TestSampleListQuery = z.infer<typeof testSampleListQuerySchema>;

export const testingSetupListQuerySchema = z.object({
  status: z.enum([...testingRecordStatuses, "all"]).default("active"),
});

export const testTrendQuerySchema = z
  .object({
    analyte: requiredText(120),
    itemId: z.uuid().optional(),
    samplingPointId: z.uuid().optional(),
    /** Every point in this zone (exact, case-insensitive). */
    zone: z.string().trim().max(100).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((q) => [q.itemId, q.samplingPointId, q.zone].filter(Boolean).length <= 1, {
    message: "Filter by an item, a sampling point or a zone, not several",
  });
export type TestTrendQuery = z.infer<typeof testTrendQuerySchema>;

// ─── Judging ─────────────────────────────────────────────────────────────────

export interface AnalyteLimit {
  min: number | null;
  max: number | null;
  limitText: string | null;
}

export class TestJudgeError extends Error {}

/**
 * The outcome of one result against its limit:
 * - a numeric value outside `min`/`max` fails, whatever else was said;
 * - a person may fail a result explicitly (a written limit not met, a numeric pass they reject);
 * - a numeric value within limits passes; a written limit passes only when a person says so.
 * Throws when there isn't enough to judge (no value for a numeric limit, no outcome for a written one).
 */
export function judgeResult(
  limit: AnalyteLimit,
  entry: { value?: number | null | undefined; outcome?: "pass" | "fail" | undefined },
): "pass" | "fail" {
  const numeric = limit.min != null || limit.max != null;
  const value = entry.value ?? null;
  if (numeric && value === null && !(limit.limitText && entry.outcome)) {
    throw new TestJudgeError("Enter the measured value");
  }
  if (!numeric && !entry.outcome) {
    throw new TestJudgeError("Say whether the result meets the written limit");
  }
  if (
    numeric &&
    value !== null &&
    ((limit.min != null && value < limit.min) || (limit.max != null && value > limit.max))
  ) {
    return "fail";
  }
  if (entry.outcome === "fail") return "fail";
  return "pass";
}

/** A sample's outcome from its results: any fail fails it; otherwise any pending keeps it pending. */
export function sampleOutcome(outcomes: readonly TestOutcome[]): TestOutcome {
  if (outcomes.includes("fail")) return "fail";
  if (outcomes.length === 0 || outcomes.includes("pending")) return "pending";
  return "pass";
}

/** A limit in words: "≤ 100 cfu/g", "0.5–0.6 %", "Not detected". */
export function formatAnalyteLimit(a: {
  min: number | null;
  max: number | null;
  unit: string | null;
  limitText: string | null;
}) {
  const unit = a.unit ? ` ${a.unit}` : "";
  const parts: string[] = [];
  if (a.min != null && a.max != null) parts.push(`${a.min}–${a.max}${unit}`);
  else if (a.min != null) parts.push(`≥ ${a.min}${unit}`);
  else if (a.max != null) parts.push(`≤ ${a.max}${unit}`);
  if (a.limitText) parts.push(a.limitText);
  return parts.join("; ");
}

// ─── Plans due ───────────────────────────────────────────────────────────────

const dayNumber = (iso: string) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;
const fromDayNumber = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

export type TestPlanDueState = "overdue" | "due" | "due_soon" | "ok";

/**
 * When a plan's next sample is due: `frequencyDays` after the last sample taken under it (not
 * cancelled), or straight away when none has been. `due` is today; `overdue` is before.
 */
export function testPlanDue(input: {
  lastSampledOn: string | null;
  frequencyDays: number;
  startedOn: string;
  today: string;
}) {
  const nextDueOn = input.lastSampledOn
    ? fromDayNumber(dayNumber(input.lastSampledOn) + input.frequencyDays)
    : input.startedOn;
  const days = dayNumber(nextDueOn) - dayNumber(input.today);
  const state: TestPlanDueState =
    days < 0 ? "overdue" : days === 0 ? "due" : days <= TEST_PLAN_DUE_SOON_DAYS ? "due_soon" : "ok";
  return { nextDueOn, state, daysOverdue: days < 0 ? -days : 0 };
}

// ─── Trends ──────────────────────────────────────────────────────────────────

export interface TrendPoint {
  sampledOn: string;
  value: number | null;
  outcome: TestOutcome;
}

/** A series' totals: how many results, how many failed, the numeric mean and the latest. */
export function summarizeTrend(points: readonly TrendPoint[]) {
  const judged = points.filter((p) => p.outcome !== "pending");
  const fails = judged.filter((p) => p.outcome === "fail").length;
  const numeric = judged.map((p) => p.value).filter((v): v is number => v !== null);
  const mean = numeric.length ? numeric.reduce((a, b) => a + b, 0) / numeric.length : null;
  const sorted = [...judged].sort((a, b) => a.sampledOn.localeCompare(b.sampledOn));
  return {
    results: judged.length,
    fails,
    failRate: judged.length ? fails / judged.length : null,
    mean: mean === null ? null : Math.round(mean * 1e6) / 1e6,
    min: numeric.length ? Math.min(...numeric) : null,
    max: numeric.length ? Math.max(...numeric) : null,
    latest: sorted.at(-1) ?? null,
  };
}

export type { SpecificationParameterCategory as AnalyteCategory };
