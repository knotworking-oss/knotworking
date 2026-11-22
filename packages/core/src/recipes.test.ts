import { roundQuantity, unitsForItem } from "./items";
import { describe, expect, it } from "vitest";
import {
  allergenDrift,
  allergenMismatch,
  diffRecipeVersions,
  hasAllergenMismatch,
  recipeCost,
  recipeCreateSchema,
  recipeDraftSchema,
  recipeScaleQuerySchema,
  recipeUpdateSchema,
  rollUpAllergens,
  rollUpRecipe,
  scaleFactor,
  scaleRecipe,
  unitsOfDimension,
  type AllergenRollup,
  type RecipeItemFacts,
  type RecipeRollupLine,
} from "./recipes";

const item = (code: string, facts: Partial<RecipeItemFacts> = {}): RecipeItemFacts => ({
  code,
  unit: "kg",
  allergens: [],
  mayContain: [],
  standardCost: null,
  ...facts,
});

const flour = item("FLR", {
  allergens: ["cereals_gluten"],
  mayContain: ["soybeans", "milk"],
  standardCost: 0.8,
});
const milk = item("MLK", { unit: "l", allergens: ["milk"], densityGPerMl: 1.03, standardCost: 0.6 });
const eggs = item("EGG", { unit: "each", allergens: ["eggs"], unitWeightG: 60, standardCost: 0.2 });
const salt = item("SLT", { unit: "kg" });

const lines: RecipeRollupLine[] = [
  { quantity: 500, unit: "g", item: flour },
  { quantity: 250, unit: "ml", item: milk },
  { quantity: 2, unit: "each", item: eggs },
];
const version = { yieldQuantity: 800, yieldUnit: "g" as const };

describe("allergen roll-up", () => {
  it("unions what ingredients contain; may-contain excludes anything contained; declaration order", () => {
    expect(rollUpAllergens(lines)).toEqual({
      contains: ["cereals_gluten", "eggs", "milk"],
      mayContain: ["soybeans"],
    });
    expect(rollUpAllergens([])).toEqual({ contains: [], mayContain: [] });
  });

  it("reports what the output item fails to declare, and what it declares without cause", () => {
    const rolled = rollUpAllergens(lines);
    const exact = {
      allergens: ["milk", "eggs", "cereals_gluten"] as const,
      mayContain: ["soybeans"] as const,
    };
    expect(allergenMismatch(rolled, exact)).toEqual({ undeclared: [], unexplained: [] });
    expect(hasAllergenMismatch(allergenMismatch(rolled, exact))).toBe(false);

    const wrong = allergenMismatch(rolled, { allergens: ["milk", "sesame"], mayContain: ["nuts"] });
    // eggs and gluten are contained but not declared; soybeans may be present and isn't mentioned.
    expect(wrong.undeclared).toEqual(["cereals_gluten", "eggs", "soybeans"]);
    expect(wrong.unexplained).toEqual(["sesame"]);
    expect(hasAllergenMismatch(wrong)).toBe(true);
  });

  it("accepts an output that declares 'contains' for an ingredient's may-contain only as unexplained", () => {
    const rolled = rollUpAllergens([{ item: flour }]);
    const result = allergenMismatch(rolled, {
      allergens: ["cereals_gluten", "soybeans"],
      mayContain: ["milk"],
    });
    expect(result).toEqual({ undeclared: [], unexplained: ["soybeans"] });
  });
});

describe("cost roll-up", () => {
  it("costs each line in the item's unit and divides by the yield in the output unit", () => {
    const cost = recipeCost(lines, version, { unit: "kg" });
    // 0.5 kg × 0.80 + 0.25 l × 0.60 + 2 × 0.20
    expect(cost.batchCost).toBeCloseTo(0.95);
    expect(cost.costComplete).toBe(true);
    expect(cost.missingCostCodes).toEqual([]);
    expect(cost.outputUnit).toBe("kg");
    expect(cost.costPerOutputUnit).toBeCloseTo(0.95 / 0.8);
  });

  it("crosses dimensions with the item's density or unit weight", () => {
    const cost = recipeCost(
      [
        { quantity: 515, unit: "g", item: milk },
        { quantity: 120, unit: "g", item: eggs },
      ],
      version,
      { unit: "g" },
    );
    // 515 g of milk is 0.5 l; 120 g of egg is 2 eggs.
    expect(cost.batchCost).toBeCloseTo(0.5 * 0.6 + 2 * 0.2);
    expect(cost.costPerOutputUnit).toBeCloseTo(0.7 / 800);
  });

  it("returns the partial sum and the uncosted item codes", () => {
    const cost = recipeCost(
      [...lines, { quantity: 10, unit: "g", item: salt }, { quantity: 5, unit: "g", item: salt }],
      version,
      { unit: "kg" },
    );
    expect(cost.batchCost).toBeCloseTo(0.95);
    expect(cost.costComplete).toBe(false);
    expect(cost.missingCostCodes).toEqual(["SLT"]);
  });

  it("flags a line whose unit can't be converted, and a zero yield", () => {
    const cost = recipeCost(
      [{ quantity: 1, unit: "l", item: item("OIL", { standardCost: 2 }) }],
      { yieldQuantity: 0, yieldUnit: "kg" },
      { unit: "kg" },
    );
    expect(cost).toMatchObject({
      batchCost: 0,
      costComplete: false,
      unconvertibleCodes: ["OIL"],
      costPerOutputUnit: null,
    });
  });

  it("rolls everything up together", () => {
    const rollup = rollUpRecipe(lines, version, item("LOAF", { allergens: ["cereals_gluten"] }));
    expect(rollup.allergens.contains).toEqual(["cereals_gluten", "eggs", "milk"]);
    expect(rollup.allergenMismatch.undeclared).toEqual(["eggs", "milk", "soybeans"]);
    expect(rollup.cost.batchCost).toBeCloseTo(0.95);
  });
});

describe("scaling", () => {
  it("scales by a number of batches", () => {
    expect(scaleRecipe(lines, version, { batches: 2.5 })).toEqual({
      factor: 2.5,
      outputQuantity: 2000,
      outputUnit: "g",
      quantities: [1250, 625, 5],
    });
  });

  it("scales to a target output, converting its unit; nothing is rounded", () => {
    const scaled = scaleRecipe(lines, version, { outputQuantity: 1, outputUnit: "kg" });
    expect(scaled?.factor).toBe(1.25);
    expect(scaled?.quantities).toEqual([625, 312.5, 2.5]);
    const thirds = scaleRecipe(
      [{ quantity: 1 }],
      { yieldQuantity: 3, yieldUnit: "kg" },
      { outputQuantity: 1, outputUnit: "kg" },
    );
    expect(thirds?.quantities[0]).toBe(1 / 3);
    expect(roundQuantity(thirds!.quantities[0]!)).toBe(0.3333);
  });

  it("returns null when the target can't be converted or the recipe yields nothing", () => {
    expect(scaleFactor(version, { outputQuantity: 1, outputUnit: "l" })).toBeNull();
    expect(scaleFactor(version, { outputQuantity: 1, outputUnit: "l" }, { densityGPerMl: 0.8 })).toBe(1);
    expect(
      scaleFactor({ yieldQuantity: 0, yieldUnit: "g" }, { outputQuantity: 1, outputUnit: "kg" }),
    ).toBeNull();
    expect(scaleRecipe(lines, version, { outputQuantity: 12, outputUnit: "each" })).toBeNull();
  });

  it("rounds for display to 4 decimal places", () => {
    expect(roundQuantity(1.00005)).toBe(1.0001);
    expect(roundQuantity(0.1 + 0.2)).toBe(0.3);
    expect(roundQuantity(2.345, 2)).toBe(2.35);
  });
});

describe("units", () => {
  it("offers an item's own dimension, and others only with a density or unit weight", () => {
    expect(unitsForItem({ unit: "kg" })).toEqual(["mg", "g", "kg"]);
    expect(unitsForItem(milk)).toEqual(["mg", "g", "kg", "ml", "l"]);
    expect(unitsForItem(eggs)).toEqual(["mg", "g", "kg", "each"]);
    expect(unitsOfDimension("l")).toEqual(["ml", "l"]);
  });
});

describe("recipe schemas", () => {
  const itemId = "0190a1b2-0000-7000-8000-000000000001";

  it("accepts a draft and normalises empty text", () => {
    const draft = recipeDraftSchema.parse({
      yieldQuantity: 12.5,
      yieldUnit: "kg",
      method: "  ",
      lines: [{ itemId, quantity: 0.0001, unit: "kg", note: " sifted " }],
    });
    expect(draft.method).toBeNull();
    expect(draft.lines[0]).toMatchObject({ quantity: 0.0001, note: "sifted" });
    expect(recipeDraftSchema.safeParse({ yieldQuantity: 0, yieldUnit: "kg", lines: [] }).success).toBe(true);
  });

  it("refuses quantities it would have to round, zero or negative lines and unknown units", () => {
    const line = (patch: object) =>
      recipeDraftSchema.safeParse({
        yieldQuantity: 1,
        yieldUnit: "kg",
        lines: [{ itemId, quantity: 1, unit: "kg", ...patch }],
      }).success;
    expect(line({})).toBe(true);
    expect(line({ quantity: 0.00001 })).toBe(false);
    expect(line({ quantity: 0 })).toBe(false);
    expect(line({ quantity: -1 })).toBe(false);
    expect(line({ unit: "lb" })).toBe(false);
    expect(recipeDraftSchema.safeParse({ yieldQuantity: -1, yieldUnit: "kg", lines: [] }).success).toBe(
      false,
    );
  });

  it("validates create, update and scaling input", () => {
    expect(recipeCreateSchema.safeParse({ code: "R1", name: "Loaf", outputItemId: itemId }).success).toBe(
      true,
    );
    expect(recipeCreateSchema.safeParse({ code: "", name: "Loaf", outputItemId: itemId }).success).toBe(
      false,
    );
    expect(recipeUpdateSchema.safeParse({}).success).toBe(false);
    expect(recipeUpdateSchema.safeParse({ status: "archived" }).success).toBe(true);
    expect(recipeScaleQuerySchema.parse({ batches: "2.5" })).toEqual({ batches: 2.5 });
    expect(recipeScaleQuerySchema.safeParse({ outputQuantity: "5" }).success).toBe(false);
    expect(
      recipeScaleQuerySchema.safeParse({ batches: "1", outputQuantity: "5", outputUnit: "kg" }).success,
    ).toBe(false);
    expect(recipeScaleQuerySchema.safeParse({ batches: "0" }).success).toBe(false);
  });
});

describe("allergenDrift", () => {
  const recorded: AllergenRollup = { contains: ["milk"], mayContain: [] };
  it("is null when nothing was recorded or nothing changed", () => {
    expect(allergenDrift(null, { contains: ["milk"], mayContain: [] })).toBeNull();
    expect(allergenDrift(recorded, { contains: ["milk"], mayContain: [] })).toBeNull();
  });
  it("reports allergens added and removed, for contains and may contain separately", () => {
    expect(allergenDrift(recorded, { contains: ["eggs"], mayContain: ["nuts"] })).toEqual({
      contains: { added: ["eggs"], removed: ["milk"] },
      mayContain: { added: ["nuts"], removed: [] },
    });
  });
});

describe("diffRecipeVersions", () => {
  const line = (itemId: string, quantity: number, unit: "kg" | "g" = "kg", note: string | null = null) => ({
    itemId,
    quantity,
    unit,
    note,
  });
  const version = (lines: ReturnType<typeof line>[], extra: Record<string, unknown> = {}) => ({
    yieldQuantity: 10,
    yieldUnit: "kg" as const,
    method: "Mix",
    allergens: { contains: [], mayContain: [] },
    lines,
    ...extra,
  });

  it("finds nothing between identical versions", () => {
    const v = version([line("a", 1), line("b", 2)]);
    const diff = diffRecipeVersions(v, v);
    expect(diff.hasChanges).toBe(false);
    expect(diff.unchanged).toHaveLength(2);
  });

  it("finds added, removed and changed lines, yield, method and allergens", () => {
    const from = version([line("a", 1), line("b", 2), line("c", 3)], {
      allergens: { contains: ["milk"], mayContain: ["nuts"] },
    });
    const to = version([line("a", 1), line("b", 2.5), line("c", 3, "kg", "sifted"), line("d", 4)], {
      yieldQuantity: 12,
      method: "Mix well",
      allergens: { contains: ["eggs", "milk"], mayContain: [] },
    });
    const diff = diffRecipeVersions(from, to);
    expect(diff.hasChanges).toBe(true);
    expect(diff.added.map((l) => l.itemId)).toEqual(["d"]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged.map((l) => l.itemId)).toEqual(["a"]);
    expect(diff.changed.map((c) => [c.after.itemId, c.quantityChanged, c.noteChanged])).toEqual([
      ["b", true, false],
      ["c", false, true],
    ]);
    expect(diff.yield).toMatchObject({ changed: true, to: { yieldQuantity: 12 } });
    expect(diff.methodChanged).toBe(true);
    expect(diff.allergens).toEqual({
      contains: { added: ["eggs"], removed: [] },
      mayContain: { added: [], removed: ["nuts"] },
    });
  });

  it("sees a removed line and a changed unit", () => {
    const diff = diffRecipeVersions(
      version([line("a", 1000, "g"), line("b", 1)]),
      version([line("a", 1, "kg")]),
    );
    expect(diff.removed.map((l) => l.itemId)).toEqual(["b"]);
    expect(diff.changed[0]).toMatchObject({ quantityChanged: true });
  });

  it("matches a repeated item in order", () => {
    const diff = diffRecipeVersions(version([line("a", 1), line("a", 2)]), version([line("a", 1)]));
    expect(diff.removed).toEqual([line("a", 2)]);
    expect(diff.unchanged).toHaveLength(1);
  });
});
