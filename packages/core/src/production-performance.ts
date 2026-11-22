import { z } from "zod";
import { unitCodes } from "./items";

/**
 * Factory performance (Phase 3.5.2): downtime on production lines with reasons, rejects (scrap)
 * on batches with reasons, actual labour on batches, and OEE with written-down definitions. Pure
 * rules and validation schemas; no DOM or Node APIs.
 *
 * Records are **append-only**: a mistake is voided with a reason (who, when, why) and stays as
 * history; it no longer counts. Costs stay in the costing module: performance reports standard
 * hours against actual hours, and line cost only at the costing module's absorption rates, so the
 * standard/actual distinction is kept.
 */

// ─── Downtime ────────────────────────────────────────────────────────────────

/**
 * Planned downtime is time the line was not meant to run (it reduces planned production time);
 * unplanned downtime is time it was meant to run and didn't (it reduces availability).
 */
export const downtimeReasons = [
  "planned_maintenance",
  "cleaning",
  "changeover",
  "break",
  "no_orders",
  "trial",
  "breakdown",
  "minor_stops",
  "material_shortage",
  "staff_shortage",
  "quality_hold",
  "utilities_failure",
  "other_unplanned",
] as const;
export type DowntimeReason = (typeof downtimeReasons)[number];
export type DowntimeCategory = "planned" | "unplanned";

export const downtimeReasonInfo: Record<DowntimeReason, { label: string; category: DowntimeCategory }> = {
  planned_maintenance: { label: "Planned maintenance", category: "planned" },
  cleaning: { label: "Scheduled cleaning", category: "planned" },
  changeover: { label: "Changeover", category: "planned" },
  break: { label: "Break", category: "planned" },
  no_orders: { label: "No orders", category: "planned" },
  trial: { label: "Trial or development run", category: "planned" },
  breakdown: { label: "Breakdown", category: "unplanned" },
  minor_stops: { label: "Minor stops", category: "unplanned" },
  material_shortage: { label: "Material shortage", category: "unplanned" },
  staff_shortage: { label: "Staff shortage", category: "unplanned" },
  quality_hold: { label: "Quality hold", category: "unplanned" },
  utilities_failure: { label: "Utilities failure", category: "unplanned" },
  other_unplanned: { label: "Other unplanned stop", category: "unplanned" },
};
export const downtimeCategory = (reason: DowntimeReason): DowntimeCategory =>
  downtimeReasonInfo[reason].category;

// ─── Rejects ─────────────────────────────────────────────────────────────────

export const rejectReasons = [
  "setup_waste",
  "underweight",
  "overweight",
  "seal_failure",
  "label_or_code_error",
  "foreign_body",
  "metal_detector_reject",
  "appearance",
  "damaged",
  "temperature",
  "other",
] as const;
export type RejectReason = (typeof rejectReasons)[number];
export const rejectReasonLabels: Record<RejectReason, string> = {
  setup_waste: "Start-up or set-up waste",
  underweight: "Underweight",
  overweight: "Overweight",
  seal_failure: "Seal failure",
  label_or_code_error: "Label or date code error",
  foreign_body: "Foreign body",
  metal_detector_reject: "Metal detector reject",
  appearance: "Appearance",
  damaged: "Damaged",
  temperature: "Temperature",
  other: "Other",
};

// ─── Schemas ─────────────────────────────────────────────────────────────────

const note = z.string().trim().max(1000).default("");
const voidReason = z.string().trim().min(1).max(1000);

export const downtimeRecordSchema = z
  .object({
    commandId: z.uuid().optional(),
    lineId: z.uuid(),
    /** The production day it happened on. */
    date: z.iso.date(),
    minutes: z.number().int().min(1).max(1440),
    reason: z.enum(downtimeReasons),
    /** The batch running (or due) when it happened, if any. */
    batchId: z.uuid().nullable().optional(),
    note,
  })
  .strict();
export type DowntimeRecordInput = z.infer<typeof downtimeRecordSchema>;

export const rejectRecordSchema = z
  .object({
    commandId: z.uuid().optional(),
    quantity: z.number().positive().max(1e12),
    /** A unit of the batch's output item. */
    unit: z.enum(unitCodes),
    reason: z.enum(rejectReasons),
    note,
  })
  .strict();
export type RejectRecordInput = z.infer<typeof rejectRecordSchema>;

export const labourRecordSchema = z
  .object({
    commandId: z.uuid().optional(),
    /** People working on the batch for the time given. */
    people: z.number().int().min(1).max(500),
    minutes: z.number().int().min(1).max(1440),
    note,
  })
  .strict();
export type LabourRecordInput = z.infer<typeof labourRecordSchema>;

export const performanceVoidSchema = z
  .object({ commandId: z.uuid().optional(), reason: voidReason })
  .strict();
export type PerformanceVoidInput = z.infer<typeof performanceVoidSchema>;

export const PERFORMANCE_MAX_DAYS = 93;
export const performanceQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    lineId: z.uuid().optional(),
  })
  .refine((v) => v.from <= v.to, { path: ["to"], message: "`to` is before `from`" })
  .refine((v) => Date.parse(v.to) - Date.parse(v.from) < PERFORMANCE_MAX_DAYS * 86_400_000, {
    path: ["to"],
    message: `At most ${PERFORMANCE_MAX_DAYS} days at a time`,
  });
export type PerformanceQuery = z.infer<typeof performanceQuerySchema>;

export const downtimeListSchema = performanceQuerySchema;

// ─── OEE ─────────────────────────────────────────────────────────────────────

export const OEE_DEFINITION_VERSION = "oee-v1";

/** The definitions every figure uses, returned with them so a report says how it was worked out. */
export const oeeDefinitions = {
  version: OEE_DEFINITION_VERSION,
  plannedProductionTime:
    "The line's capacity that day (its shift windows, else its hours per day; none on a day off) less planned downtime. A day with no batches on the line is not scheduled and counts no planned production time; downtime logged on it is listed apart and not counted. Downtime recorded against a batch counts on the day the batch is planned, like its output.",
  runTime: "Planned production time less unplanned downtime.",
  availability: "Run time ÷ planned production time.",
  performance:
    "Ideal time for everything made (good output plus rejects, at the line's rate for each recipe) ÷ run time. Batches without a rate are left out and flagged.",
  quality: "Ideal time for the good output ÷ ideal time for everything made (good plus rejects).",
  oee: "Availability × performance × quality, which equals ideal time for the good output ÷ planned production time.",
  goodOutput:
    "Net output recorded into stock by batches planned that day (production records less reversals); rejects are recorded separately and never put into stock.",
} as const;

export interface OeeBatchInput {
  /** Net good output (base unit). */
  good: number;
  /** Active rejects (base unit). */
  rejects: number;
  /** Line rate for the recipe (base unit per hour); null: no rate, left out of P and Q. */
  ratePerHour: number | null;
}

export interface OeeResult {
  capacityMinutes: number;
  plannedDowntimeMinutes: number;
  unplannedDowntimeMinutes: number;
  plannedProductionMinutes: number;
  runMinutes: number;
  /** Ideal minutes for everything made, over batches with a rate. */
  idealMinutesTotal: number;
  idealMinutesGood: number;
  /** Ratios 0..1 (performance may exceed 1 when the rate is set too low); null when undefined. */
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
  unratedBatches: number;
  warnings: string[];
}

const ratio = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10_000) / 10_000 : null);
const minutes2 = (m: number) => Math.round(m * 100) / 100;

/**
 * OEE across lines (the site): ideal run time of the good output over planned production time,
 * both summed over the lines, so a line's share follows its planned time. The certified metric
 * `oee` and Production → Performance both use this.
 */
export function siteOee(lines: readonly Pick<OeeResult, "plannedProductionMinutes" | "idealMinutesGood">[]) {
  const planned = lines.reduce((t, l) => t + l.plannedProductionMinutes, 0);
  const good = lines.reduce((t, l) => t + l.idealMinutesGood, 0);
  return { plannedProductionMinutes: planned, idealMinutesGood: minutes2(good), oee: ratio(good, planned) };
}

/** OEE for a line over some days, from capacity, downtime and its batches (see {@link oeeDefinitions}). */
export function computeOee(input: {
  capacityMinutes: number;
  plannedDowntimeMinutes: number;
  unplannedDowntimeMinutes: number;
  batches: readonly OeeBatchInput[];
}): OeeResult {
  const warnings: string[] = [];
  const planned = Math.max(0, input.capacityMinutes - input.plannedDowntimeMinutes);
  if (input.plannedDowntimeMinutes > input.capacityMinutes)
    warnings.push("Planned downtime is more than the line's capacity");
  const run = Math.max(0, planned - input.unplannedDowntimeMinutes);
  if (input.unplannedDowntimeMinutes > planned)
    warnings.push("Unplanned downtime is more than the planned production time");
  let idealTotal = 0;
  let idealGood = 0;
  let unrated = 0;
  for (const b of input.batches) {
    if (!b.ratePerHour || b.ratePerHour <= 0) {
      if (b.good > 0 || b.rejects > 0) unrated += 1;
      continue;
    }
    idealTotal += ((b.good + b.rejects) / b.ratePerHour) * 60;
    idealGood += (b.good / b.ratePerHour) * 60;
  }
  if (unrated)
    warnings.push(
      `${unrated} batch${unrated === 1 ? " has" : "es have"} no rate on the line, so performance and quality leave them out`,
    );
  const performance = ratio(idealTotal, run);
  if (performance !== null && performance > 1)
    warnings.push("Performance is over 100%: the line's rate for a recipe may be set too low");
  if (input.capacityMinutes === 0 && input.batches.some((b) => b.good > 0 || b.rejects > 0))
    warnings.push("Output was recorded on a day with no capacity (a day off or no shift)");
  const availability = ratio(run, planned);
  const quality = ratio(idealGood, idealTotal);
  return {
    capacityMinutes: input.capacityMinutes,
    plannedDowntimeMinutes: input.plannedDowntimeMinutes,
    unplannedDowntimeMinutes: input.unplannedDowntimeMinutes,
    plannedProductionMinutes: planned,
    runMinutes: run,
    idealMinutesTotal: minutes2(idealTotal),
    idealMinutesGood: minutes2(idealGood),
    availability,
    performance,
    quality,
    oee: ratio(idealGood, planned),
    unratedBatches: unrated,
    warnings,
  };
}
