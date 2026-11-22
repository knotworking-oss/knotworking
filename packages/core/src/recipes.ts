import { z } from "zod";
import {
  convertQuantity,
  sortAllergens,
  unitCodes,
  unitDimension,
  type AllergenCode,
  type UnitBridge,
  type UnitCode,
} from "./items";

/**
 * Recipes module: versioned bills of materials. Validation schemas and the roll-ups (allergens,
 * cost, scaling) that are computed on read, shared by server, web and MCP. No DOM or Node APIs.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const recipeStatuses = ["active", "archived"] as const;
export type RecipeStatus = (typeof recipeStatuses)[number];

/**
 * Document control: a recipe has at most one `draft` (the only editable version) and at most one
 * `approved` version (the current one). Approving a draft makes the previous approved version
 * `superseded`; superseded versions are kept and never change.
 */
export const recipeVersionStatuses = ["draft", "approved", "superseded"] as const;
export type RecipeVersionStatus = (typeof recipeVersionStatuses)[number];
export const recipeVersionStatusLabels: Record<RecipeVersionStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  superseded: "Superseded",
};

/** Item types a recipe can make. */
export const recipeOutputItemTypes = ["wip", "finished"] as const;

/** Quantities are stored as `numeric(18,4)`. */
export const RECIPE_QUANTITY_DECIMALS = 4;

// ─── Validation ──────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();

/** Refused rather than rounded: a quantity the database can't hold exactly is a mistake. */
const fourDecimals = (value: number) => Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-6;
const quantity = z.number().finite().max(1_000_000_000).refine(fourDecimals, "At most 4 decimal places");

export const recipeLineInputSchema = z.object({
  itemId: z.uuid(),
  quantity: quantity.refine((v) => v > 0, "Must be more than zero"),
  unit: z.enum(unitCodes),
  note: optionalText(500).optional(),
});
export type RecipeLineInput = z.infer<typeof recipeLineInputSchema>;

/**
 * The full content of a draft version. Saving replaces the draft's header fields and all of its
 * lines (in the order given). A draft may be incomplete (no lines, zero yield); approval is not.
 */
export const recipeDraftSchema = z.object({
  /** What one batch makes, in `yieldUnit` (same dimension as the output item's unit). */
  yieldQuantity: quantity.min(0),
  yieldUnit: z.enum(unitCodes),
  method: optionalText(50_000).optional(),
  /** What changed since the previous version. */
  changeNote: optionalText(2000).optional(),
  lines: z.array(recipeLineInputSchema).max(200),
});
export type RecipeDraftInput = z.infer<typeof recipeDraftSchema>;

const recipeFields = {
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  description: optionalText(2000),
};

export const recipeCreateSchema = z.object({
  /** Client-generated id, like tasks. */
  id: z.uuid().optional(),
  code: recipeFields.code,
  name: recipeFields.name,
  /** The item this recipe makes: a work-in-progress or finished item. */
  outputItemId: z.uuid(),
  description: recipeFields.description.optional(),
  /** Content of version 1, saved as a draft. */
  draft: recipeDraftSchema.optional(),
});
export type RecipeCreateInput = z.infer<typeof recipeCreateSchema>;

export const recipeUpdateSchema = z
  .object({ ...recipeFields, status: z.enum(recipeStatuses) })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type RecipeUpdateInput = z.infer<typeof recipeUpdateSchema>;

export const recipeListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  /** Default: active recipes only. */
  status: z.enum([...recipeStatuses, "all"]).default("active"),
  outputItemId: z.uuid().optional(),
  /** Recipes whose approved or draft version uses this item as an ingredient. */
  itemId: z.uuid().optional(),
  /** `true`: only recipes whose approved version is flagged for allergen drift (filtered in the query, so paging and `total` are right). */
  allergenDrift: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type RecipeListQuery = z.infer<typeof recipeListQuerySchema>;

/** Optional scaling of a version: a number of batches, or a target output quantity and unit. */
export const recipeScaleQuerySchema = z
  .object({
    batches: z.coerce.number().positive().finite().optional(),
    outputQuantity: z.coerce.number().positive().finite().optional(),
    outputUnit: z.enum(unitCodes).optional(),
  })
  .refine((q) => q.batches === undefined || q.outputQuantity === undefined, {
    message: "Give either batches or outputQuantity, not both",
  })
  .refine((q) => (q.outputQuantity === undefined) === (q.outputUnit === undefined), {
    message: "outputQuantity and outputUnit go together",
  });
export type RecipeScaleQuery = z.infer<typeof recipeScaleQuerySchema>;

// ─── Roll-ups ────────────────────────────────────────────────────────────────

/** What the roll-ups need to know about an item. */
export interface RecipeItemFacts extends UnitBridge {
  code: string;
  unit: UnitCode;
  allergens: readonly AllergenCode[];
  mayContain: readonly AllergenCode[];
  /** Per `unit`; `null` when not costed. */
  standardCost?: number | null | undefined;
}

export interface RecipeRollupLine {
  quantity: number;
  unit: UnitCode;
  item: RecipeItemFacts;
}

export interface RecipeYield {
  yieldQuantity: number;
  yieldUnit: UnitCode;
}

export interface AllergenRollup {
  /** Allergens any ingredient contains. */
  contains: AllergenCode[];
  /** Allergens an ingredient may contain and none contains. */
  mayContain: AllergenCode[];
}

/** Allergens rolled up from the ingredients, in declaration order. */
export function rollUpAllergens(lines: readonly Pick<RecipeRollupLine, "item">[]): AllergenRollup {
  const contains = new Set(lines.flatMap((line) => [...line.item.allergens]));
  const mayContain = lines.flatMap((line) => [...line.item.mayContain]).filter((code) => !contains.has(code));
  return { contains: sortAllergens(contains), mayContain: sortAllergens(mayContain) };
}

export interface AllergenMismatch {
  /**
   * Allergens the recipe brings in that the output item does not declare: an ingredient contains
   * one the output doesn't list under "contains", or an ingredient may contain one the output
   * doesn't mention at all. The serious direction: the product's declaration understates.
   */
  undeclared: AllergenCode[];
  /** Allergens the output item says it contains that no ingredient contains. */
  unexplained: AllergenCode[];
}

/**
 * Compares the roll-up with what the output item declares. The output item's own "may contain"
 * is not questioned: cross-contact on site is a reason to declare one that no ingredient carries.
 */
export function allergenMismatch(
  rollup: AllergenRollup,
  output: Pick<RecipeItemFacts, "allergens" | "mayContain">,
): AllergenMismatch {
  const declared = new Set(output.allergens);
  const mentioned = new Set([...output.allergens, ...output.mayContain]);
  const rolled = new Set(rollup.contains);
  return {
    undeclared: sortAllergens([
      ...rollup.contains.filter((code) => !declared.has(code)),
      ...rollup.mayContain.filter((code) => !mentioned.has(code)),
    ]),
    unexplained: sortAllergens(output.allergens.filter((code) => !rolled.has(code))),
  };
}

export const hasAllergenMismatch = (mismatch: AllergenMismatch) =>
  mismatch.undeclared.length > 0 || mismatch.unexplained.length > 0;

/** A line's quantity in its item's own unit, or `null` when the item can't bridge the units. */
export const lineQuantityInItemUnit = (line: RecipeRollupLine): number | null =>
  convertQuantity(line.quantity, line.unit, line.item.unit, line.item);

/** The yield of one batch in the output item's unit, or `null` if the units don't convert. */
export const yieldInOutputUnit = (version: RecipeYield, output: Pick<RecipeItemFacts, "unit"> & UnitBridge) =>
  convertQuantity(version.yieldQuantity, version.yieldUnit, output.unit, output);

export interface RecipeCost {
  /** Sum of the lines that could be costed. Partial when `costComplete` is false. */
  batchCost: number;
  /** False when a line's item has no standard cost (or its quantity can't be converted). */
  costComplete: boolean;
  /** Codes of the items without a standard cost, in line order. */
  missingCostCodes: string[];
  /** Codes of the items whose line unit can't be converted to the item's unit. */
  unconvertibleCodes: string[];
  /** `batchCost` ÷ yield in the output item's unit; `null` when the yield is zero or unknown. */
  costPerOutputUnit: number | null;
  /** The output item's unit, which `costPerOutputUnit` is per. */
  outputUnit: UnitCode;
}

export function recipeCost(
  lines: readonly RecipeRollupLine[],
  version: RecipeYield,
  output: Pick<RecipeItemFacts, "unit"> & UnitBridge,
): RecipeCost {
  let batchCost = 0;
  const missing = new Set<string>();
  const unconvertible = new Set<string>();
  for (const line of lines) {
    const inItemUnit = lineQuantityInItemUnit(line);
    if (inItemUnit === null) unconvertible.add(line.item.code);
    else if (line.item.standardCost === null || line.item.standardCost === undefined)
      missing.add(line.item.code);
    else batchCost += inItemUnit * line.item.standardCost;
  }
  const yieldQuantity = yieldInOutputUnit(version, output);
  return {
    batchCost,
    costComplete: missing.size === 0 && unconvertible.size === 0,
    missingCostCodes: [...missing],
    unconvertibleCodes: [...unconvertible],
    costPerOutputUnit: yieldQuantity ? batchCost / yieldQuantity : null,
    outputUnit: output.unit,
  };
}

export interface RecipeRollup {
  allergens: AllergenRollup;
  allergenMismatch: AllergenMismatch;
  cost: RecipeCost;
}

/** Everything computed on read for one version. */
export function rollUpRecipe(
  lines: readonly RecipeRollupLine[],
  version: RecipeYield,
  output: RecipeItemFacts,
): RecipeRollup {
  const rolled = rollUpAllergens(lines);
  return {
    allergens: rolled,
    allergenMismatch: allergenMismatch(rolled, output),
    cost: recipeCost(lines, version, output),
  };
}

/** The allergen roll-up recorded when a version was approved, and what it says now. */
export interface AllergenChange {
  added: AllergenCode[];
  removed: AllergenCode[];
}
export interface AllergenDrift {
  contains: AllergenChange;
  mayContain: AllergenChange;
}

const changeBetween = (before: readonly AllergenCode[], after: readonly AllergenCode[]): AllergenChange => {
  const was = new Set(before);
  const is = new Set(after);
  return {
    added: sortAllergens(after.filter((code) => !was.has(code))),
    removed: sortAllergens(before.filter((code) => !is.has(code))),
  };
};

/**
 * How the allergens the ingredients bring in now differ from the roll-up recorded at approval
 * (an ingredient's declaration changed since). `null` when they match, or when no roll-up was
 * recorded (versions approved before it was kept).
 */
export function allergenDrift(
  recorded: AllergenRollup | null | undefined,
  current: AllergenRollup,
): AllergenDrift | null {
  if (!recorded) return null;
  const drift = {
    contains: changeBetween(recorded.contains, current.contains),
    mayContain: changeBetween(recorded.mayContain, current.mayContain),
  };
  const any = [drift.contains, drift.mayContain].some((c) => c.added.length > 0 || c.removed.length > 0);
  return any ? drift : null;
}

// ─── Comparing versions ──────────────────────────────────────────────────────

/** What a comparison needs of one version. */
export interface RecipeDiffVersion extends RecipeYield {
  method?: string | null | undefined;
  lines: readonly { itemId: string; quantity: number; unit: UnitCode; note?: string | null | undefined }[];
  allergens: AllergenRollup;
}

export interface RecipeLineChange<L> {
  before: L;
  after: L;
  quantityChanged: boolean;
  noteChanged: boolean;
}

export interface RecipeVersionDiff<L extends RecipeDiffVersion["lines"][number]> {
  /** Lines only in the newer version. */
  added: L[];
  /** Lines only in the older version. */
  removed: L[];
  /** Same item in both, with a different quantity, unit or note. */
  changed: RecipeLineChange<L>[];
  unchanged: L[];
  yield: { changed: boolean; from: RecipeYield; to: RecipeYield };
  methodChanged: boolean;
  /** Allergen roll-up of `to` relative to `from`. */
  allergens: AllergenDrift;
  hasChanges: boolean;
}

/**
 * Compares two versions of a recipe, `from` (older) to `to`. Lines are matched by item (a repeated
 * item is matched in order); a line is "changed" when its quantity, unit or note differ. Pure
 * data comparison: quantities are not converted between units.
 */
export function diffRecipeVersions<L extends RecipeDiffVersion["lines"][number]>(
  from: Omit<RecipeDiffVersion, "lines"> & { lines: readonly L[] },
  to: Omit<RecipeDiffVersion, "lines"> & { lines: readonly L[] },
): RecipeVersionDiff<L> {
  const pool = new Map<string, L[]>();
  for (const line of from.lines) pool.set(line.itemId, [...(pool.get(line.itemId) ?? []), line]);
  const added: L[] = [];
  const changed: RecipeLineChange<L>[] = [];
  const unchanged: L[] = [];
  for (const after of to.lines) {
    const before = pool.get(after.itemId)?.shift();
    if (!before) {
      added.push(after);
      continue;
    }
    const quantityChanged = before.quantity !== after.quantity || before.unit !== after.unit;
    const noteChanged = (before.note ?? null) !== (after.note ?? null);
    if (quantityChanged || noteChanged) changed.push({ before, after, quantityChanged, noteChanged });
    else unchanged.push(after);
  }
  const removed = [...pool.values()].flat();

  const yieldChanged = from.yieldQuantity !== to.yieldQuantity || from.yieldUnit !== to.yieldUnit;
  const methodChanged = (from.method ?? null) !== (to.method ?? null);
  const allergenChanges = {
    contains: changeBetween(from.allergens.contains, to.allergens.contains),
    mayContain: changeBetween(from.allergens.mayContain, to.allergens.mayContain),
  };
  const allergensChanged = [allergenChanges.contains, allergenChanges.mayContain].some(
    (c) => c.added.length > 0 || c.removed.length > 0,
  );
  return {
    added,
    removed,
    changed,
    unchanged,
    yield: {
      changed: yieldChanged,
      from: { yieldQuantity: from.yieldQuantity, yieldUnit: from.yieldUnit },
      to: { yieldQuantity: to.yieldQuantity, yieldUnit: to.yieldUnit },
    },
    methodChanged,
    allergens: allergenChanges,
    hasChanges:
      added.length > 0 ||
      removed.length > 0 ||
      changed.length > 0 ||
      yieldChanged ||
      methodChanged ||
      allergensChanged,
  };
}

// ─── Scaling ─────────────────────────────────────────────────────────────────

export type RecipeScaleTarget = { batches: number } | { outputQuantity: number; outputUnit: UnitCode };

/**
 * How many batches a target is. `null` when it can't be worked out: the recipe yields nothing, or
 * the target unit can't be converted to the yield's unit with what the output item says.
 */
export function scaleFactor(
  version: RecipeYield,
  target: RecipeScaleTarget,
  output: UnitBridge = {},
): number | null {
  if ("batches" in target) return target.batches;
  if (!(version.yieldQuantity > 0)) return null;
  const wanted = convertQuantity(target.outputQuantity, target.outputUnit, version.yieldUnit, output);
  return wanted === null ? null : wanted / version.yieldQuantity;
}

export interface RecipeScale {
  /** Number of batches (may be fractional). */
  factor: number;
  /** What the scaled recipe makes, in the yield's unit. Not rounded. */
  outputQuantity: number;
  outputUnit: UnitCode;
  /** Scaled quantity of each line, in the line's unit and the lines' order. Not rounded. */
  quantities: number[];
}

/** Scales every line to a target. Nothing is rounded; use `roundQuantity` to display. */
export function scaleRecipe(
  lines: readonly Pick<RecipeRollupLine, "quantity">[],
  version: RecipeYield,
  target: RecipeScaleTarget,
  output: UnitBridge = {},
): RecipeScale | null {
  const factor = scaleFactor(version, target, output);
  if (factor === null) return null;
  return {
    factor,
    outputQuantity: version.yieldQuantity * factor,
    outputUnit: version.yieldUnit,
    quantities: lines.map((line) => line.quantity * factor),
  };
}

// ─── Units a line may use ────────────────────────────────────────────────────

/** Units of the same dimension (what a yield may be given in). */
export const unitsOfDimension = (unit: UnitCode): UnitCode[] =>
  unitCodes.filter((candidate) => unitDimension(candidate) === unitDimension(unit));
