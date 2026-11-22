import { z } from "zod";

/**
 * Packing checks (Phase 3.5.3): a packing run per batch that pins the approved product label (and
 * optionally the approved specification version) the packs carry, the checks made while packing
 * (line clearance, first-off and in-run label and date-code checks, metal detector challenges,
 * weight samples), and packaging reconciliation at close. Pure rules and validation schemas; no
 * DOM or Node APIs.
 *
 * Checks are **append-only**: a mistake is voided with a reason and stays as history. A failed check
 * must say what was done about it, and stays open until a later check of the same kind passes.
 */

export const packingRunStatuses = ["open", "closed"] as const;
export type PackingRunStatus = (typeof packingRunStatuses)[number];

/** The label a run pinned, copied when it was opened. */
export interface PackingLabelSummary {
  recipeId: string;
  recipeVersionId: string;
  variant: string;
  versionNumber: number;
  productName: string;
  gtin: string | null;
  netQuantity: string | null;
  allergenStatement: string | null;
}

/** The specification version a run pinned, copied when it was opened. */
export interface PackingSpecificationSummary {
  specificationId: string;
  code: string;
  title: string;
  versionNumber: number;
}

export interface PackingReconciliationLine {
  itemId: string | null;
  material: string;
  printed: boolean;
  issued: number;
  used: number;
  wasted: number;
  returned: number;
  variance: number;
}

// ─── Check kinds ─────────────────────────────────────────────────────────────

export const packingCheckKinds = [
  "line_clearance",
  "first_off",
  "in_run_label",
  "detector_challenge",
  "weight_sample",
] as const;
export type PackingCheckKind = (typeof packingCheckKinds)[number];
export const packingCheckLabels: Record<PackingCheckKind, string> = {
  line_clearance: "Line clearance",
  first_off: "First-off label and code check",
  in_run_label: "In-run label and code check",
  detector_challenge: "Metal detector challenge",
  weight_sample: "Weight sample",
};

export const lineClearanceItems = [
  "previous_product_removed",
  "previous_packaging_and_labels_removed",
  "coders_and_printers_cleared",
  "line_clean_and_ready",
] as const;
export type LineClearanceItem = (typeof lineClearanceItems)[number];
export const lineClearanceLabels: Record<LineClearanceItem, string> = {
  previous_product_removed: "Previous product removed from the line",
  previous_packaging_and_labels_removed: "Previous packaging and labels removed",
  coders_and_printers_cleared: "Date coders and printers cleared of the previous code",
  line_clean_and_ready: "Line clean and ready",
};

export const detectorTestPieces = ["ferrous", "non_ferrous", "stainless_steel"] as const;
export type DetectorTestPiece = (typeof detectorTestPieces)[number];
export const detectorTestPieceLabels: Record<DetectorTestPiece, string> = {
  ferrous: "Ferrous",
  non_ferrous: "Non-ferrous",
  stainless_steel: "Stainless steel",
};

// ─── Weight: UK average quantity system ──────────────────────────────────────

/**
 * Tolerable negative error for a nominal quantity in g or ml (UK Weights and Measures (Packaged
 * Goods) Regulations 2006, Schedule 2), rounded up to the next 0.1. Null outside 5 g to 50 kg.
 */
export function tolerableNegativeError(nominal: number): number | null {
  const up = (v: number) => Math.ceil(v * 10 - 1e-9) / 10;
  if (nominal < 5 || nominal > 50_000) return null;
  if (nominal <= 50) return up(nominal * 0.09);
  if (nominal <= 100) return 4.5;
  if (nominal <= 200) return up(nominal * 0.045);
  if (nominal <= 300) return 9;
  if (nominal <= 500) return up(nominal * 0.03);
  if (nominal <= 1000) return 15;
  if (nominal <= 10_000) return up(nominal * 0.015);
  if (nominal <= 15_000) return 150;
  return up(nominal * 0.01);
}

export interface WeightSampleResult {
  count: number;
  mean: number;
  /** Packs below nominal − TNE (non-standard). */
  belowT1: number;
  /** Packs below nominal − 2 × TNE: never allowed. */
  belowT2: number;
  tne: number;
  passed: boolean;
  reasons: string[];
}

/**
 * An indicative check of one sample against the three packer's rules: the mean is at least the
 * nominal quantity; no more than 2.5% of packs are below nominal − TNE; none is below nominal −
 * 2 × TNE. (The rules apply to a whole batch; a sample is evidence towards them, not a verdict.)
 */
export function evaluateWeightSample(nominal: number, readings: readonly number[]): WeightSampleResult {
  const tne = tolerableNegativeError(nominal) ?? 0;
  const count = readings.length;
  const exactMean = count ? readings.reduce((t, r) => t + r, 0) / count : 0;
  // Compared unrounded: a mean of 499.996 g is below a 500 g nominal.
  const mean = Math.round(exactMean * 100) / 100;
  const belowT1 = readings.filter((r) => r < nominal - tne - 1e-9).length;
  const belowT2 = readings.filter((r) => r < nominal - 2 * tne - 1e-9).length;
  const reasons: string[] = [];
  if (exactMean < nominal - 1e-9) reasons.push(`Mean ${mean} is below the nominal ${nominal}`);
  // At most 2.5% of the sample (rounded down): stricter than the reference test's sampling plan for
  // small samples, so a sample errs towards a false failure, never a false pass.
  if (belowT1 > Math.floor(count * 0.025))
    reasons.push(
      `${belowT1} of ${count} packs are below ${Math.round((nominal - tne) * 10) / 10} (nominal less TNE)`,
    );
  if (belowT2 > 0)
    reasons.push(
      `${belowT2} pack${belowT2 === 1 ? " is" : "s are"} below ${Math.round((nominal - 2 * tne) * 10) / 10} (nominal less twice TNE)`,
    );
  return { count, mean, belowT1, belowT2, tne, passed: reasons.length === 0, reasons };
}

// ─── Codes ───────────────────────────────────────────────────────────────────

/** Codes compare without case or spacing differences ("BB 24NOV26" is "bb 24 nov 26"). */
export const normaliseCode = (code: string) => code.toUpperCase().replace(/\s+/g, "");

// ─── Schemas ─────────────────────────────────────────────────────────────────

const note = z.string().trim().max(1000).default("");
const code = z.string().trim().min(1).max(80);

export const packingRunOpenSchema = z
  .object({
    commandId: z.uuid().optional(),
    /** An approved product label of the batch's recipe, drafted from the batch's recipe version. */
    labelId: z.uuid().nullable(),
    /** An approved specification version of the batch's output item. */
    specificationVersionId: z.uuid().nullable().optional(),
    /** Nominal quantity per pack in g (or ml): turns on weight samples. */
    nominalQuantity: z.number().min(5).max(50_000).nullable().optional(),
    /** The date code the packs must carry, e.g. "BB 24 NOV 2026". */
    expectedDateCode: code,
    /** The lot code printed on packs; default: the batch code. */
    expectedLotCode: code.optional(),
    /** Whether the line has a metal detector to challenge (default yes). */
    detectorRequired: z.boolean().default(true),
    note,
  })
  .strict();
export type PackingRunOpenInput = z.infer<typeof packingRunOpenSchema>;

const failureAction = z.string().trim().max(2000).optional();

export const packingCheckSchema = z.discriminatedUnion("kind", [
  z
    .object({
      commandId: z.uuid().optional(),
      kind: z.literal("line_clearance"),
      /** An item left out counts as not done. */
      items: z.partialRecord(z.enum(lineClearanceItems), z.boolean()),
      failureAction,
      note,
    })
    .strict(),
  z
    .object({
      commandId: z.uuid().optional(),
      kind: z.enum(["first_off", "in_run_label"]),
      /** The label on the pack is the run's approved label (right product, version and variant). */
      labelCorrect: z.boolean(),
      /** What the pack actually shows. */
      dateCodeSeen: code,
      lotCodeSeen: code,
      /** The printed codes are legible and complete. */
      legible: z.boolean(),
      failureAction,
      note,
    })
    .strict(),
  z
    .object({
      commandId: z.uuid().optional(),
      kind: z.literal("detector_challenge"),
      detector: z.string().trim().min(1).max(120),
      pieces: z
        .array(
          z
            .object({
              piece: z.enum(detectorTestPieces),
              sizeMm: z.number().positive().max(50),
              rejected: z.boolean(),
            })
            .strict(),
        )
        .min(detectorTestPieces.length)
        .max(10)
        .refine((ps) => detectorTestPieces.every((t) => ps.some((p) => p.piece === t)), {
          message: "Challenge with each test piece: ferrous, non-ferrous and stainless steel",
        }),
      failureAction,
      note,
    })
    .strict(),
  z
    .object({
      commandId: z.uuid().optional(),
      kind: z.literal("weight_sample"),
      /** Pack weights in g (or ml), at least 1. */
      readings: z.array(z.number().positive().max(100_000)).min(1).max(500),
      failureAction,
      note,
    })
    .strict(),
]);
export type PackingCheckInput = z.infer<typeof packingCheckSchema>;

export const packingVoidSchema = z
  .object({ commandId: z.uuid().optional(), reason: z.string().trim().min(1).max(1000) })
  .strict();
export type PackingVoidInput = z.infer<typeof packingVoidSchema>;

export const reconciliationLineSchema = z
  .object({
    /** A packaging item, or none for a material named here only. */
    itemId: z.uuid().nullable().optional(),
    material: z.string().trim().min(1).max(120),
    /** Printed with the label or codes: any difference must be explained. */
    printed: z.boolean().default(false),
    issued: z.number().int().min(0).max(10_000_000),
    used: z.number().int().min(0).max(10_000_000),
    wasted: z.number().int().min(0).max(10_000_000),
    returned: z.number().int().min(0).max(10_000_000),
  })
  .strict();
export type ReconciliationLineInput = z.infer<typeof reconciliationLineSchema>;

export const packingRunCloseSchema = z
  .object({
    commandId: z.uuid().optional(),
    /** Packs of good product made. */
    packsProduced: z.number().int().min(0).max(100_000_000),
    /** At least one material; with a label pinned, at least one printed one. */
    reconciliation: z.array(reconciliationLineSchema).min(1).max(50),
    /** Required when any line doesn't reconcile. */
    varianceReason: z.string().trim().max(2000).optional(),
    note,
  })
  .strict();
export type PackingRunCloseInput = z.infer<typeof packingRunCloseSchema>;

// ─── Evaluation ──────────────────────────────────────────────────────────────

export interface PackingRunExpectation {
  expectedDateCode: string;
  expectedLotCode: string;
  nominalQuantity: number | null;
}

/** Whether a check passed, and why not, from what was entered and what the run expects. */
export function evaluatePackingCheck(
  input: PackingCheckInput,
  run: PackingRunExpectation,
): { passed: boolean; reasons: string[]; result: Record<string, unknown> } {
  switch (input.kind) {
    case "line_clearance": {
      const missing = lineClearanceItems.filter((i) => input.items[i] !== true);
      return {
        passed: missing.length === 0,
        reasons: missing.map((i) => `Not done: ${lineClearanceLabels[i]}`),
        result: {},
      };
    }
    case "first_off":
    case "in_run_label": {
      const reasons: string[] = [];
      if (!input.labelCorrect) reasons.push("The label on the pack is not the approved label");
      if (normaliseCode(input.dateCodeSeen) !== normaliseCode(run.expectedDateCode))
        reasons.push(`Date code reads "${input.dateCodeSeen}", expected "${run.expectedDateCode}"`);
      if (normaliseCode(input.lotCodeSeen) !== normaliseCode(run.expectedLotCode))
        reasons.push(`Lot code reads "${input.lotCodeSeen}", expected "${run.expectedLotCode}"`);
      if (!input.legible) reasons.push("Printed codes are not legible or complete");
      return { passed: reasons.length === 0, reasons, result: {} };
    }
    case "detector_challenge": {
      const missed = input.pieces.filter((p) => !p.rejected);
      return {
        passed: missed.length === 0,
        reasons: missed.map(
          (p) => `${detectorTestPieceLabels[p.piece]} ${p.sizeMm} mm test piece was not rejected`,
        ),
        result: {},
      };
    }
    case "weight_sample": {
      if (run.nominalQuantity === null)
        return { passed: false, reasons: ["The run has no nominal quantity to weigh against"], result: {} };
      const r = evaluateWeightSample(run.nominalQuantity, input.readings);
      return { passed: r.passed, reasons: r.reasons, result: { ...r } };
    }
  }
}

export const reconciliationVariance = (
  l: Pick<ReconciliationLineInput, "issued" | "used" | "wasted" | "returned">,
) => l.issued - l.used - l.wasted - l.returned;

/** The checks a run needs before it closes, given what is on record (latest live check of each kind). */
export function packingRunGaps(
  run: { detectorRequired: boolean; nominalQuantity: number | null },
  latest: Partial<Record<PackingCheckKind, { passed: boolean }>>,
): string[] {
  const required: PackingCheckKind[] = ["line_clearance", "first_off"];
  if (run.detectorRequired) required.push("detector_challenge");
  if (run.nominalQuantity !== null) required.push("weight_sample");
  const gaps: string[] = [];
  for (const kind of required) {
    if (!latest[kind]) gaps.push(`No ${packingCheckLabels[kind].toLowerCase()} recorded`);
  }
  for (const kind of packingCheckKinds) {
    if (latest[kind] && !latest[kind]!.passed)
      gaps.push(`The last ${packingCheckLabels[kind].toLowerCase()} failed and no passing one has followed`);
  }
  return gaps;
}
