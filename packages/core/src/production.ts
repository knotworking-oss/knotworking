import { z } from "zod";
import { roundQuantity, unitCodes, type UnitBridge, type UnitCode } from "./items";
import { demandPeriodSchema, weekStart } from "./demand";
import { scaleFactor, type RecipeStatus, type RecipeYield } from "./recipes";
import {
  expiryTypes,
  itemBaseUnit,
  toBaseQuantity,
  type StockItemUnits,
  type StockMovementType,
} from "./stock";

/**
 * Production module: batches planned from approved recipe versions, the material requirements
 * they create, and batch records that consume lots and produce new ones.
 *
 * Shared vocabulary, validation schemas and the pure rules (batch codes, status flow, scaling a
 * batch to base-unit requirements, aggregating requirements against stock, a lot's mass balance).
 * No DOM or Node APIs.
 *
 * A batch's size is stored once: the planned output in the output item's base unit (g, ml or
 * each). The number of batches is derived from it and the pinned version's yield.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * `planned` → `in_progress` (started; consumption and output can be recorded) → `completed`
 * (signed off by a person with `manage`; the record is then closed). `planned` or `in_progress`
 * → `cancelled`.
 */
export const productionBatchStatuses = ["planned", "in_progress", "completed", "cancelled"] as const;
export type ProductionBatchStatus = (typeof productionBatchStatuses)[number];
export const productionBatchStatusLabels: Record<ProductionBatchStatus, string> = {
  planned: "Planned",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

const transitions: Record<ProductionBatchStatus, readonly ProductionBatchStatus[]> = {
  planned: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/** Whether a batch may move from one status to another. */
export const canTransitionBatch = (from: ProductionBatchStatus, to: ProductionBatchStatus): boolean =>
  transitions[from].includes(to);

/** Statuses whose batches still need materials (material requirements count them). */
export const openBatchStatuses = [
  "planned",
  "in_progress",
] as const satisfies readonly ProductionBatchStatus[];

/**
 * A line of a batch record. `consumption`: a quantity of a lot used by the batch (posts a
 * `consumption` movement). `output`: a quantity of the produced lot (posts a `production`
 * movement). Records are append-only: a correction is a reversal record with the opposite
 * quantity that points back at the one it corrects.
 */
export const productionRecordKinds = ["consumption", "output"] as const;
export type ProductionRecordKind = (typeof productionRecordKinds)[number];
export const productionRecordKindLabels: Record<ProductionRecordKind, string> = {
  consumption: "Consumed",
  output: "Produced",
};

/** The stock movement type each record kind posts. */
export const recordMovementType: Record<ProductionRecordKind, StockMovementType> = {
  consumption: "consumption",
  output: "production",
};

// ─── Batch codes ─────────────────────────────────────────────────────────────

/** The prefix of generated batch codes for a planned date: `B` + yymmdd + `-`. */
export const batchCodePrefix = (plannedOn: string): string =>
  `B${plannedOn.slice(2, 4)}${plannedOn.slice(5, 7)}${plannedOn.slice(8, 10)}-`;

/** A generated batch code: `B` + yymmdd + a short sequence, e.g. `B261111-002`. */
export const generateBatchCode = (plannedOn: string, sequence: number): string =>
  `${batchCodePrefix(plannedOn)}${String(sequence).padStart(3, "0")}`;

// ─── Scaling a batch ─────────────────────────────────────────────────────────

/** How a batch's size is given: a number of batches, or a target output quantity. */
export type BatchSizeTarget = { batches: number } | { outputQuantity: number; outputUnit: UnitCode };

/** The output item as the scaling helpers need it. */
export type BatchOutputItem = StockItemUnits;

/**
 * A batch size in the output item's base unit (what a batch stores), rounded to the ledger's
 * precision. `null` when it can't be worked out: the recipe yields nothing, or a unit can't be
 * converted for the output item.
 */
export function plannedOutputBase(
  version: RecipeYield,
  output: BatchOutputItem,
  target: BatchSizeTarget,
): number | null {
  if ("batches" in target) {
    const perBatch = toBaseQuantity(version.yieldQuantity, version.yieldUnit, output);
    return perBatch === null || !(perBatch > 0) ? null : roundQuantity(perBatch * target.batches);
  }
  return toBaseQuantity(target.outputQuantity, target.outputUnit, output);
}

/**
 * How many batches of the version a planned output (base unit) is. Uses the recipes module's
 * `scaleFactor`, so a batch scales exactly as the recipe page does. `null` without a yield.
 */
export const batchFactor = (
  version: RecipeYield,
  output: BatchOutputItem,
  plannedQuantity: number,
): number | null =>
  scaleFactor(version, { outputQuantity: plannedQuantity, outputUnit: itemBaseUnit(output) }, output);

/** A recipe line with what is needed to express it in its item's base unit. */
export interface BatchRecipeLine {
  itemId: string;
  quantity: number;
  unit: UnitCode;
  item: { unit: UnitCode } & UnitBridge;
}

export interface BatchMaterial {
  itemId: string;
  /** What the batch needs, in the item's base unit; `null` when the line's unit can't be converted. */
  required: number | null;
}

/**
 * What a batch needs of each ingredient, in base units, scaled by `factor` batches. Lines of the
 * same item are added together; items keep the order of their first line.
 */
export function batchMaterials(lines: readonly BatchRecipeLine[], factor: number): BatchMaterial[] {
  const out = new Map<string, BatchMaterial>();
  for (const line of lines) {
    const base = toBaseQuantity(line.quantity * factor, line.unit, line.item);
    const current = out.get(line.itemId);
    if (!current) out.set(line.itemId, { itemId: line.itemId, required: base });
    else
      current.required =
        current.required === null || base === null ? null : roundQuantity(current.required + base);
  }
  return [...out.values()];
}

/** What is still to be consumed: never negative (using more than planned leaves nothing outstanding). */
export const outstandingQuantity = (required: number | null, consumed: number): number | null =>
  required === null ? null : roundQuantity(Math.max(required - consumed, 0));

// ─── Material requirements ───────────────────────────────────────────────────

/** One open batch, as the requirements roll-up needs it. */
export interface RequirementBatch {
  batchId: string;
  batchCode: string;
  plannedOn: string;
  status: ProductionBatchStatus;
  materials: readonly BatchMaterial[];
  /** Net consumed so far per item (base unit); only in-progress batches have any. */
  consumed?: Readonly<Record<string, number>>;
}

/** Stock of an item (base unit). `available`: released and not past a use-by date. */
export interface RequirementStock {
  available: number;
  quarantine: number;
}

export interface MaterialRequirement {
  itemId: string;
  /** Everything the batches need. */
  required: number;
  /** Already consumed by in-progress batches. */
  consumed: number;
  /** Still to be consumed: `required − consumed` per batch, never below zero. */
  outstanding: number;
  available: number;
  /** In quarantine: could cover a shortfall once QA releases it. */
  quarantine: number;
  /** What available stock doesn't cover. */
  shortfall: number;
  /** A batch's line for this item couldn't be converted to the base unit: totals leave it out. */
  incomplete: boolean;
  batches: {
    batchId: string;
    batchCode: string;
    plannedOn: string;
    required: number | null;
    outstanding: number | null;
  }[];
}

/**
 * Rolls the open batches up to one row per ingredient: required, consumed and outstanding
 * against available stock, and the shortfall. Rows keep the order in which items first appear
 * (pass batches in date order). Computed on read; nothing is reserved.
 */
export function materialRequirements(
  batches: readonly RequirementBatch[],
  stock: Readonly<Record<string, RequirementStock>>,
): MaterialRequirement[] {
  const rows = new Map<string, MaterialRequirement>();
  for (const batch of batches) {
    for (const material of batch.materials) {
      let row = rows.get(material.itemId);
      if (!row) {
        const s = stock[material.itemId];
        row = {
          itemId: material.itemId,
          required: 0,
          consumed: 0,
          outstanding: 0,
          available: s?.available ?? 0,
          quarantine: s?.quarantine ?? 0,
          shortfall: 0,
          incomplete: false,
          batches: [],
        };
        rows.set(material.itemId, row);
      }
      const consumed = batch.consumed?.[material.itemId] ?? 0;
      const outstanding = outstandingQuantity(material.required, consumed);
      if (material.required === null || outstanding === null) row.incomplete = true;
      else {
        row.required = roundQuantity(row.required + material.required);
        row.consumed = roundQuantity(row.consumed + consumed);
        row.outstanding = roundQuantity(row.outstanding + outstanding);
      }
      row.batches.push({
        batchId: batch.batchId,
        batchCode: batch.batchCode,
        plannedOn: batch.plannedOn,
        required: material.required,
        outstanding,
      });
    }
  }
  for (const row of rows.values())
    row.shortfall = roundQuantity(Math.max(row.outstanding - row.available, 0));
  return [...rows.values()];
}

// ─── Planning batches from demand ────────────────────────────────────────────

/**
 * Why an item with demand gets no suggestion. `no_recipe`: no recipe makes it.
 * `no_approved_version`: no active recipe for it has an approved version. `choose_recipe`: several
 * active recipes with an approved version make it and nobody has said which to use. `no_yield`:
 * the chosen version's yield can't be expressed in the item's units.
 */
export const planIssues = ["no_recipe", "no_approved_version", "choose_recipe", "no_yield"] as const;
export type PlanIssue = (typeof planIssues)[number];
export const planIssueLabels: Record<PlanIssue, string> = {
  no_recipe: "No recipe makes this item",
  no_approved_version: "No active recipe for it has an approved version",
  choose_recipe: "Several recipes make it: choose one",
  no_yield: "The recipe's yield can't be converted to the item's unit",
};

/** A recipe that makes an item with demand, with its current approved version (if any). */
export interface PlanRecipe {
  id: string;
  outputItemId: string;
  status: RecipeStatus;
  approvedVersion: (RecipeYield & { id: string }) | null;
}

/** A batch of an item with demand, as the plan counts it (base units of the output item). */
export interface PlanBatch {
  id: string;
  itemId: string;
  plannedOn: string;
  status: ProductionBatchStatus;
  /** The planned output. */
  planned: number;
  /** Net output on record. */
  produced: number;
}

/**
 * How much of the demand a batch covers: a planned batch its planned output, an in-progress one
 * the larger of planned and produced, a completed one what it actually produced, a cancelled one
 * nothing (a batch can't be cancelled with output on record).
 */
export function batchCoverage(batch: Pick<PlanBatch, "status" | "planned" | "produced">): number {
  switch (batch.status) {
    case "planned":
      return batch.planned;
    case "in_progress":
      return Math.max(batch.planned, batch.produced);
    case "completed":
      return Math.max(batch.produced, 0);
    case "cancelled":
      return 0;
  }
}

/**
 * The whole number of batches that covers `gap` when one batch makes `perBatch` (same unit).
 * Rounded up, after rounding to the ledger's precision so 2.00001 batches is 2. `0` without a gap
 * or a yield.
 */
export function batchesToCover(gap: number, perBatch: number | null): number {
  if (!(gap > 0) || perBatch === null || !(perBatch > 0)) return 0;
  return Math.ceil(roundQuantity(gap / perBatch));
}

export interface PlanCell {
  /** The Monday of the week. */
  periodStart: string;
  demand: number;
  /** What the week's batches already cover (`batchCoverage`). */
  planned: number;
  /** Demand not yet covered: `demand − planned`, never below zero. */
  gap: number;
  /** Whole batches of the chosen version that cover the gap; `0` without a usable recipe. */
  suggestedBatches: number;
  /** What the suggested batches make. */
  suggestedOutput: number;
  /** The batches counted in `planned`, in planned-date order. */
  batchIds: string[];
}

export interface PlanRow {
  itemId: string;
  /** The recipe the suggestion uses: the choice, or the only candidate. */
  recipeId: string | null;
  /** Candidates: active recipes with an approved version that make the item, in the order given. */
  optionIds: string[];
  issue: PlanIssue | null;
  /** What one batch of the chosen version makes (base unit); `null` without one. */
  perBatch: number | null;
  /** One per week of the range, in order. */
  cells: PlanCell[];
  totals: Omit<PlanCell, "periodStart" | "batchIds">;
}

/**
 * Proposes batches from demand. Per item with demand and per week: the demand, what the batches
 * planned in that week already cover (by planned date; any recipe for the item; cancelled ones
 * left out), the gap, and the whole batches of the item's recipe that cover it.
 *
 * The recipe is picked deterministically: the one in `choices` for the item when it is a
 * candidate (active, with an approved version), otherwise the only candidate. Several candidates
 * and no choice is `choose_recipe`: a person decides. Quantities are in each item's base unit;
 * batch sizes use the scaling of `POST /production/batches` (`plannedOutputBase`). Rows follow
 * the order in which items first appear in `demand`.
 */
export function planFromDemand(input: {
  weeks: readonly string[];
  items: ReadonlyMap<string, BatchOutputItem>;
  demand: readonly { itemId: string; periodStart: string; quantity: number }[];
  batches: readonly PlanBatch[];
  recipes: readonly PlanRecipe[];
  /** Item id → recipe id, for items with several candidates. */
  choices?: Readonly<Record<string, string>> | undefined;
}): PlanRow[] {
  const weekIndex = new Map(input.weeks.map((w, i) => [w, i]));
  const demandOf = new Map<string, number[]>();
  for (const d of input.demand) {
    const i = weekIndex.get(d.periodStart);
    if (i === undefined || !input.items.has(d.itemId)) continue;
    let weeks = demandOf.get(d.itemId);
    if (!weeks) demandOf.set(d.itemId, (weeks = input.weeks.map(() => 0)));
    weeks[i] = roundQuantity(weeks[i]! + d.quantity);
  }
  const batchesOf = new Map<string, PlanBatch[][]>();
  const byDate = [...input.batches].sort(
    (a, b) => a.plannedOn.localeCompare(b.plannedOn) || a.id.localeCompare(b.id),
  );
  for (const b of byDate) {
    const i = weekIndex.get(weekStart(b.plannedOn));
    if (i === undefined || !demandOf.has(b.itemId) || b.status === "cancelled") continue;
    let weeks = batchesOf.get(b.itemId);
    if (!weeks) batchesOf.set(b.itemId, (weeks = input.weeks.map(() => [])));
    weeks[i]!.push(b);
  }

  return [...demandOf].map(([itemId, demand]): PlanRow => {
    const item = input.items.get(itemId)!;
    const mine = input.recipes.filter((r) => r.outputItemId === itemId);
    const options = mine.filter((r) => r.status === "active" && r.approvedVersion);
    const chosen =
      options.find((r) => r.id === input.choices?.[itemId]) ??
      (options.length === 1 ? options[0] : undefined);
    const yieldBase = chosen ? plannedOutputBase(chosen.approvedVersion!, item, { batches: 1 }) : null;
    const perBatch = yieldBase !== null && yieldBase > 0 ? yieldBase : null;
    const issue: PlanIssue | null =
      mine.length === 0
        ? "no_recipe"
        : options.length === 0
          ? "no_approved_version"
          : !chosen
            ? "choose_recipe"
            : perBatch === null
              ? "no_yield"
              : null;

    const cells = input.weeks.map((periodStart, i): PlanCell => {
      const weekBatches = batchesOf.get(itemId)?.[i] ?? [];
      const planned = roundQuantity(weekBatches.reduce((t, b) => t + batchCoverage(b), 0));
      const gap = roundQuantity(Math.max(demand[i]! - planned, 0));
      const suggestedBatches = issue ? 0 : batchesToCover(gap, perBatch);
      const suggestedOutput =
        suggestedBatches > 0
          ? (plannedOutputBase(chosen!.approvedVersion!, item, { batches: suggestedBatches }) ?? 0)
          : 0;
      return {
        periodStart,
        demand: demand[i]!,
        planned,
        gap,
        suggestedBatches,
        suggestedOutput,
        batchIds: weekBatches.map((b) => b.id),
      };
    });
    const sum = (key: keyof PlanRow["totals"]) => roundQuantity(cells.reduce((t, c) => t + c[key], 0));
    return {
      itemId,
      recipeId: chosen?.id ?? null,
      optionIds: options.map((r) => r.id),
      issue,
      perBatch,
      cells,
      totals: {
        demand: sum("demand"),
        planned: sum("planned"),
        gap: sum("gap"),
        suggestedBatches: sum("suggestedBatches"),
        suggestedOutput: sum("suggestedOutput"),
      },
    };
  });
}

// ─── Mass balance ────────────────────────────────────────────────────────────

export interface LotMassBalance {
  /** Received through goods-in. */
  received: number;
  /** Physically received customer returns, net of corrected receipts. */
  returned: number;
  /** Produced by batches. */
  produced: number;
  /** Used by batches (positive). */
  consumed: number;
  /** Sent to customers (positive, net of voids). */
  despatched: number;
  /** Thrown away (positive). */
  wasted: number;
  /** Adjustments and stocktake differences (signed). */
  adjusted: number;
  /** Net of transfers (zero unless something is wrong: a transfer moves stock, it doesn't make any). */
  transferred: number;
  onHand: number;
  /** `received + produced + returned`: what the lot started with. */
  input: number;
  /** Share of the input that is unexplained by use: adjustments and stocktakes ÷ input, as a percentage. */
  adjustedPercent: number | null;
}

/**
 * A lot's mass balance from its movements (reversals included: they carry the opposite sign of
 * the row they correct, so they cancel it). For a mock recall: everything that came in is either
 * still on hand, used in a batch, despatched, thrown away or written off by a counted adjustment.
 */
export function lotMassBalance(
  movements: readonly { type: StockMovementType; quantity: number }[],
): LotMassBalance {
  const sum = (types: readonly StockMovementType[]) =>
    roundQuantity(movements.filter((m) => types.includes(m.type)).reduce((t, m) => t + m.quantity, 0));
  const received = sum(["receipt"]);
  const produced = sum(["production"]);
  const returned = sum(["customer_return"]);
  const input = roundQuantity(received + produced + returned);
  const adjusted = sum(["adjustment", "stocktake"]);
  return {
    received,
    returned,
    produced,
    consumed: roundQuantity(-sum(["consumption"])),
    despatched: roundQuantity(-sum(["despatch"])),
    wasted: roundQuantity(-sum(["waste"])),
    adjusted,
    transferred: sum(["transfer_in", "transfer_out"]),
    onHand: roundQuantity(movements.reduce((t, m) => t + m.quantity, 0)),
    input,
    adjustedPercent: input > 0 ? roundQuantity((adjusted / input) * 100, 2) : null,
  };
}

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
const MAX_QUANTITY = 1_000_000_000_000;
const positiveQuantity = z.number().positive().finite().max(MAX_QUANTITY);
/** Refused rather than rounded, like recipe quantities. */
const fourDecimals = (value: number) => Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-6;
const batchCount = z
  .number()
  .positive()
  .finite()
  .max(1_000_000)
  .refine(fourDecimals, "At most 4 decimal places");
const paging = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

/** A batch's size: `batches`, or `outputQuantity` with `outputUnit`. */
const sizeFields = {
  batches: batchCount.optional(),
  outputQuantity: positiveQuantity.optional(),
  outputUnit: z.enum(unitCodes).optional(),
};
type SizeFields = { batches?: number; outputQuantity?: number; outputUnit?: UnitCode };
const oneSize = (v: SizeFields) => !(v.batches !== undefined && v.outputQuantity !== undefined);
const sizePair = (v: SizeFields) => (v.outputQuantity === undefined) === (v.outputUnit === undefined);

/** The size target of a create or update input, or `null` when it gives none. */
export const batchSizeTarget = (v: SizeFields): BatchSizeTarget | null =>
  v.batches !== undefined
    ? { batches: v.batches }
    : v.outputQuantity !== undefined && v.outputUnit !== undefined
      ? { outputQuantity: v.outputQuantity, outputUnit: v.outputUnit }
      : null;

/** Plan a batch of a recipe's current approved version. */
export const productionBatchCreateSchema = z
  .object({
    id: z.uuid().optional(),
    recipeId: z.uuid(),
    plannedOn: isoDate,
    ...sizeFields,
    /** Where the output goes; can be chosen later, when output is recorded. */
    outputLocationId: z.uuid().nullable().optional(),
    /** The production line it is made on (capacity scheduling); optional. */
    lineId: z.uuid().nullable().optional(),
    /** Generated (`B` + yymmdd + sequence) when left out. */
    batchCode: optionalText(60).optional(),
    notes: optionalText(2000).optional(),
  })
  .refine(oneSize, { path: ["outputQuantity"], message: "Give either batches or outputQuantity, not both" })
  .refine(sizePair, { path: ["outputUnit"], message: "outputQuantity and outputUnit go together" })
  .refine((v) => v.batches !== undefined || v.outputQuantity !== undefined, {
    path: ["batches"],
    message: "Say how much to make: a number of batches or an output quantity",
  });
export type ProductionBatchCreateInput = z.infer<typeof productionBatchCreateSchema>;

/**
 * Change a batch. Date, size, version and code only while it is `planned`; the output location
 * and notes until it is completed or cancelled.
 */
export const productionBatchUpdateSchema = z
  .object({
    plannedOn: isoDate.optional(),
    ...sizeFields,
    outputLocationId: z.uuid().nullable().optional(),
    /** Assign to a line, or `null` to take it off one. Until the batch closes. */
    lineId: z.uuid().nullable().optional(),
    batchCode: requiredText(60).optional(),
    notes: optionalText(2000).optional(),
    /** Move a planned batch to the recipe's current approved version. */
    recipeVersionId: z.uuid().optional(),
  })
  .refine(oneSize, { path: ["outputQuantity"], message: "Give either batches or outputQuantity, not both" })
  .refine(sizePair, { path: ["outputUnit"], message: "outputQuantity and outputUnit go together" })
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), "Nothing to update");
export type ProductionBatchUpdateInput = z.infer<typeof productionBatchUpdateSchema>;

export const productionBatchListQuerySchema = z
  .object({
    /** Inclusive planned dates (`YYYY-MM-DD`). */
    from: isoDate.optional(),
    to: isoDate.optional(),
    /** `open`: planned or in progress. Default: every status. */
    status: z.enum([...productionBatchStatuses, "open", "all"]).default("all"),
    recipeId: z.uuid().optional(),
    /** Batches that used this recipe version. */
    recipeVersionId: z.uuid().optional(),
    /** Batches that make this item. */
    outputItemId: z.uuid().optional(),
    /** Matches the batch code, the recipe's code or name. */
    q: z.string().trim().max(200).optional(),
    ...paging,
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ["to"], message: "`to` is before `from`" });
export type ProductionBatchListQuery = z.infer<typeof productionBatchListQuerySchema>;

/** Consumption: quantities of lots used by an in-progress batch. */
export const productionConsumptionSchema = z.object({
  commandId: z.uuid().optional(),
  lines: z
    .array(
      z.object({
        lotId: z.uuid(),
        locationId: z.uuid(),
        quantity: positiveQuantity,
        unit: z.enum(unitCodes),
        note: optionalText(500).optional(),
      }),
    )
    .min(1)
    .max(100)
    .refine(
      (list) => new Set(list.map((l) => `${l.lotId}:${l.locationId}`)).size === list.length,
      "A lot is listed twice at the same location",
    ),
});
export type ProductionConsumptionInput = z.infer<typeof productionConsumptionSchema>;

/**
 * Output of an in-progress batch: a new lot of the recipe's output item (in quarantine until QA
 * releases it), or more of a lot this batch already produced (`lotId`).
 */
export const productionOutputSchema = z
  .object({
    commandId: z.uuid().optional(),
    quantity: positiveQuantity,
    unit: z.enum(unitCodes),
    /** Default: the batch's output location. */
    locationId: z.uuid().optional(),
    /** Add to a lot this batch already produced instead of starting a new one. */
    lotId: z.uuid().optional(),
    /** For a new lot. Default: the batch code. */
    lotCode: optionalText(60).optional(),
    /** For a new lot. Default: the production date plus the item's shelf life, as best before. */
    expiresOn: isoDate.nullable().optional(),
    expiryType: z.enum(expiryTypes).nullable().optional(),
    note: optionalText(500).optional(),
  })
  .refine((v) => !v.expiresOn || !!v.expiryType, {
    path: ["expiryType"],
    message: "Say whether the date is a use-by or a best-before date",
  })
  .refine((v) => !v.expiryType || !!v.expiresOn, {
    path: ["expiresOn"],
    message: "An expiry type needs an expiry date",
  })
  .refine((v) => !v.lotId || (v.lotCode === undefined && v.expiresOn === undefined), {
    path: ["lotId"],
    message: "An existing lot keeps its code and dates",
  });
export type ProductionOutputInput = z.infer<typeof productionOutputSchema>;

export const productionRecordReverseSchema = z.object({ reason: requiredText(500) });
export type ProductionRecordReverseInput = z.infer<typeof productionRecordReverseSchema>;

/** The sign-off: a person with `manage` closes the batch record. */
export const productionBatchCompleteSchema = z.object({ note: optionalText(2000).optional() });
export type ProductionBatchCompleteInput = z.infer<typeof productionBatchCompleteSchema>;

export const productionBatchCancelSchema = z.object({ reason: requiredText(500) });
export type ProductionBatchCancelInput = z.infer<typeof productionBatchCancelSchema>;

/** Planned and in-progress batches between two dates (inclusive), at most a year apart. */
export const materialRequirementsQuerySchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((v) => v.from <= v.to, { path: ["to"], message: "`to` is before `from`" })
  .refine((v) => Date.parse(v.to) - Date.parse(v.from) <= 366 * 86_400_000, {
    path: ["to"],
    message: "At most a year at a time",
  });
export type MaterialRequirementsQuery = z.infer<typeof materialRequirementsQuerySchema>;

/** How many levels a trace follows each way (a lot → batch → lot is one level). */
export const MAX_TRACE_DEPTH = 10;
export const lotTraceQuerySchema = z.object({
  depth: z.coerce.number().int().min(1).max(MAX_TRACE_DEPTH).default(MAX_TRACE_DEPTH),
});
export type LotTraceQuery = z.infer<typeof lotTraceQuerySchema>;

/**
 * `GET /production/plan-from-demand`: the weeks to plan (dates or ISO weeks; default 12 weeks from
 * the current one, at most `DEMAND_MAX_WEEKS`) and, for items several recipes make, which recipe
 * to use (`recipeIds`, comma-separated).
 */
export const planFromDemandQuerySchema = z
  .object({
    from: demandPeriodSchema.optional(),
    to: demandPeriodSchema.optional(),
    recipeIds: z
      .string()
      .max(20_000)
      .optional()
      .transform((v) =>
        (v ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.uuid()).max(500)),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    path: ["to"],
    message: "The end is before the start",
  });
export type PlanFromDemandQuery = z.infer<typeof planFromDemandQuerySchema>;

/** How many batches one `POST /production/plan-from-demand` may create. */
export const PLAN_FROM_DEMAND_MAX_BATCHES = 200;

/**
 * `POST /production/plan-from-demand`: batches to create together, all or nothing. Each is what
 * `POST /production/batches` takes (`recipeId`, `plannedOn`, `batches` or `outputQuantity` with
 * `outputUnit`, and the optional fields) and is checked the same way.
 */
export const productionPlanBatchesSchema = z.object({
  batches: z.array(productionBatchCreateSchema).min(1).max(PLAN_FROM_DEMAND_MAX_BATCHES),
});
export type ProductionPlanBatchesInput = z.infer<typeof productionPlanBatchesSchema>;
