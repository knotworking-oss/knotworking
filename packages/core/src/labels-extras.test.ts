import { describe, expect, it } from "vitest";
import type { ItemType, UnitCode } from "./items";
import {
  calculateEnergy,
  computeLabelFacts,
  isWaterName,
  nutritionInputSchema,
  nutritionPanel,
  rollUpNutrition,
  type LabelGraph,
  type LabelItemFacts,
  type LabelRecipeVersion,
  type NutritionValues,
} from "./labels";
import { micronutrientRows, micronutrientAmountsSchema, retainedAmount } from "./micronutrients";

const values = (v: Partial<NutritionValues> = {}): NutritionValues => ({
  energyKj: 0,
  energyKcal: 0,
  fat: 0,
  saturates: 0,
  carbohydrate: 0,
  sugars: 0,
  fibre: 0,
  protein: 0,
  salt: 0,
  ...v,
});

function item(code: string, over: Partial<LabelItemFacts> & { type?: ItemType; unit?: UnitCode } = {}) {
  return {
    id: `item-${code}`,
    code,
    name: code.toLowerCase(),
    type: "ingredient",
    unit: "kg",
    allergens: [],
    mayContain: [],
    declarationName: null,
    components: null,
    nutrition: null,
    ...over,
  } as LabelItemFacts;
}

let seq = 0;
function version(
  output: LabelItemFacts,
  lines: [LabelItemFacts, number, UnitCode][],
  yieldQuantity: number,
  yieldUnit: UnitCode = "g",
): LabelRecipeVersion {
  seq += 1;
  return {
    recipeId: `recipe-${output.code}`,
    recipeCode: output.code,
    versionId: `version-${output.code}-${seq}`,
    versionNumber: 1,
    outputItemId: output.id,
    yieldQuantity,
    yieldUnit,
    lines: lines.map(([i, quantity, unit]) => ({ itemId: i.id, quantity, unit })),
  };
}

const graphOf = (items: LabelItemFacts[]): LabelGraph => ({
  items: new Map(items.map((i) => [i.id, i])),
  subRecipes: new Map(),
});

describe("energy with polyols, organic acids and alcohol (Regulation 1169/2011 Annex XIV)", () => {
  it("counts polyols at 10 kJ / 2.4 kcal and takes them out of the carbohydrate", () => {
    // 70 g carbohydrate, of which 60 g polyols (sorbitol): 10 g × 17 + 60 g × 10.
    expect(calculateEnergy({ fat: 0, carbohydrate: 70, protein: 0, fibre: 0, polyols: 60 })).toEqual({
      energyKj: 770,
      energyKcal: 184,
    });
  });

  it("counts erythritol as nothing, and takes it out of the carbohydrate", () => {
    // 25 g carbohydrate, of which 20 g erythritol: only the other 5 g count, at 17 kJ / 4 kcal.
    expect(calculateEnergy({ fat: 0, carbohydrate: 25, protein: 0, fibre: null, erythritol: 20 })).toEqual({
      energyKj: 85,
      energyKcal: 20,
    });
  });

  it("counts alcohol at 29 kJ / 7 kcal and organic acids at 13 kJ / 3 kcal, on top of the carbohydrate", () => {
    expect(calculateEnergy({ fat: 0, carbohydrate: 0, protein: 0, fibre: null, alcohol: 10 })).toEqual({
      energyKj: 290,
      energyKcal: 70,
    });
    expect(calculateEnergy({ fat: 0, carbohydrate: 3, protein: 0, fibre: null, alcohol: 10 })).toEqual({
      energyKj: 341,
      energyKcal: 82,
    });
    expect(calculateEnergy({ fat: 0, carbohydrate: 0, protein: 0, fibre: null, organicAcids: 2 })).toEqual({
      energyKj: 26,
      energyKcal: 6,
    });
  });

  it("adds every factor together", () => {
    // fat 5 × 37 = 185; carbohydrate (40 - 10) × 17 = 510; protein 6 × 17 = 102; fibre 3 × 8 = 24;
    // polyols 10 × 10 = 100; organic acids 1 × 13 = 13; alcohol 2 × 29 = 58.
    expect(
      calculateEnergy({
        fat: 5,
        carbohydrate: 40,
        protein: 6,
        fibre: 3,
        polyols: 10,
        organicAcids: 1,
        alcohol: 2,
      }),
    ).toEqual({ energyKj: 992, energyKcal: 236 });
    // The same without the extras is what it always was.
    expect(calculateEnergy({ fat: 5, carbohydrate: 40, protein: 6, fibre: 3 })).toEqual({
      energyKj: 185 + 680 + 102 + 24,
      energyKcal: 45 + 160 + 24 + 6,
    });
  });

  it("never counts more polyols than there is carbohydrate", () => {
    expect(calculateEnergy({ fat: 0, carbohydrate: 5, protein: 0, fibre: null, polyols: 8 })).toEqual({
      energyKj: 80,
      energyKcal: 19.2,
    });
  });

  it("only uses the extras in a calculated panel, and never declares them", () => {
    const raw = values({ fat: 0, carbohydrate: 70, polyols: 60, energyKj: 1190, energyKcal: 280 });
    const calculated = nutritionPanel("100g", raw, { energyMethod: "calculated" });
    expect(calculated.raw.energyKj).toBe(770);
    expect(calculated.declared.energyKcal?.display).toBe("184 kcal");
    expect(calculated.raw.polyols).toBe(60);
    expect(Object.keys(calculated.declared).sort()).toEqual(
      [
        "carbohydrate",
        "energyKcal",
        "energyKj",
        "fat",
        "fibre",
        "protein",
        "salt",
        "saturates",
        "sugars",
      ].sort(),
    );
    // The declared method keeps the ingredients' own energy.
    expect(nutritionPanel("100g", raw).raw.energyKj).toBe(1190);
    // No extras: nothing extra is kept on the panel.
    expect(Object.keys(nutritionPanel("100g", values({ polyols: 0, alcohol: null })).raw)).not.toContain(
      "polyols",
    );
  });

  it("validates the extras on entered nutrition", () => {
    const base = {
      energyKj: 1000,
      energyKcal: 239,
      fat: 1,
      saturates: 0.5,
      carbohydrate: 50,
      sugars: 10,
      protein: 5,
      salt: 0.1,
    };
    expect(nutritionInputSchema.parse({ ...base, polyols: 20, alcohol: null })).toMatchObject({
      polyols: 20,
      alcohol: 0,
      organicAcids: 0,
      erythritol: 0,
    });
    expect(nutritionInputSchema.safeParse({ ...base, polyols: 40, erythritol: 20 }).success).toBe(false);
    expect(nutritionInputSchema.safeParse({ ...base, alcohol: 101 }).success).toBe(false);
  });

  it("rolls the extras up through a recipe and concentrates them with the yield", () => {
    const syrup = item("SYR", {
      nutrition: {
        basis: "100g",
        values: values({ energyKj: 1000, energyKcal: 239, carbohydrate: 80, polyols: 50 }),
      },
    });
    const rum = item("RUM", {
      unit: "l",
      densityGPerMl: 0.95,
      nutrition: { basis: "100ml", values: values({ energyKj: 900, energyKcal: 220, alcohol: 40 }) },
    });
    const cake = item("CAKE", { type: "finished" });
    // 500 g syrup + 100 ml rum in the bowl, 560 g out.
    const v = version(
      cake,
      [
        [syrup, 500, "g"],
        [rum, 100, "ml"],
      ],
      560,
    );
    const r = rollUpNutrition(v, graphOf([syrup, rum, cake]));
    expect(r.complete).toBe(true);
    expect(r.per100?.polyols).toBeCloseTo((250 / 560) * 100, 3);
    expect(r.per100?.alcohol).toBeCloseTo((40 / 560) * 100, 3);
    expect(r.per100?.erythritol).toBeUndefined();
    const panel = computeLabelFacts(v, graphOf([syrup, rum, cake]), { energyMethod: "calculated" }).nutrition
      .panel!;
    // carbohydrate 400 g (polyols 250 g), alcohol 40 g: (150 × 17 + 250 × 10 + 40 × 29) / 5.6
    expect(panel.raw.energyKj).toBeCloseTo((150 * 17 + 250 * 10 + 40 * 29) / 5.6, 2);
  });
});

describe("vitamins and minerals with retention factors", () => {
  const spinach = item("SPN", {
    nutrition: { basis: "100g", values: values({ energyKj: 100, energyKcal: 24, protein: 2.9 }) },
    micronutrients: { vitaminC: 40, folate: 150, iron: 1.6 },
    retention: { vitaminC: 0.5, folate: 0.7 },
  });
  const oil = item("OIL", {
    nutrition: { basis: "100g", values: values({ energyKj: 3700, energyKcal: 900, fat: 100 }) },
  });
  const dish = item("DISH", { type: "finished" });

  it("applies each ingredient's retention before concentrating by the yield", () => {
    // 500 g spinach: vitamin C 40 × 5 × 0.5 = 100 mg, folate 150 × 5 × 0.7 = 525 µg, iron 8 mg (no loss set).
    const v = version(
      dish,
      [
        [spinach, 500, "g"],
        [oil, 20, "g"],
      ],
      400,
    );
    const r = rollUpNutrition(v, graphOf([spinach, oil, dish]));
    expect(r.micronutrients.vitaminC).toBeCloseTo(25, 5);
    expect(r.micronutrients.folate).toBeCloseTo(131.25, 5);
    expect(r.micronutrients.iron).toBeCloseTo(2, 5);
    expect(r.micronutrients.calcium).toBeUndefined();
    // The oil gave no vitamin or mineral figures: the totals are a lower bound.
    expect(r.micronutrientsMissing).toEqual(["OIL"]);
  });

  it("is not on the declared panel", () => {
    const v = version(
      dish,
      [
        [spinach, 500, "g"],
        [oil, 20, "g"],
      ],
      400,
    );
    const panel = computeLabelFacts(v, graphOf([spinach, oil, dish])).nutrition.panel!;
    expect(JSON.stringify(panel)).not.toMatch(/vitamin|folate|iron/i);
  });

  it("follows sub-recipes, applying the retention of the sub-recipe's own item too", () => {
    const sauce = item("SAU", {
      type: "wip",
      retention: { vitaminC: 0.8 },
    });
    const sauceV = version(sauce, [[spinach, 200, "g"]], 200);
    const meal = item("MEAL", { type: "finished" });
    const mealV = version(meal, [[sauce, 100, "g"]], 100);
    const g: LabelGraph = {
      items: new Map([spinach, sauce, meal].map((i) => [i.id, i])),
      subRecipes: new Map([[sauce.id, sauceV]]),
    };
    // Sauce: vitamin C 40 × 2 × 0.5 = 40 mg in 200 g = 20 per 100 g; then × 0.8 when the sauce is cooked on = 16.
    expect(rollUpNutrition(mealV, g).micronutrients.vitaminC).toBeCloseTo(16, 5);
  });

  it("gives rows with the share of the nutrient reference value", () => {
    expect(micronutrientRows({ vitaminC: 25, iron: 2 })).toEqual([
      { key: "vitaminC", label: "Vitamin C", unit: "mg", value: 25, nrvPercent: 31 },
      { key: "iron", label: "Iron", unit: "mg", value: 2, nrvPercent: 14 },
    ]);
  });

  it("limits retention to between 0 and 1 and the amounts to known keys", () => {
    expect(retainedAmount("vitaminC", 100, { vitaminC: 0.6 })).toBe(60);
    expect(retainedAmount("vitaminC", 100, { vitaminC: 1.5 })).toBe(100);
    expect(retainedAmount("iron", 100, { vitaminC: 0.6 })).toBe(100);
    expect(micronutrientAmountsSchema.safeParse({ vitaminC: 1, caffeine: 3 }).success).toBe(false);
    expect(micronutrientAmountsSchema.safeParse({ vitaminC: -1 }).success).toBe(false);
  });
});

describe("the 5% rule for added water", () => {
  const flour = item("FLR", {
    declarationName: "Wheat flour",
    nutrition: { basis: "100g", values: values({ energyKj: 1450, energyKcal: 342, carbohydrate: 70 }) },
  });
  const sugar = item("SUG", {
    declarationName: "Sugar",
    nutrition: { basis: "100g", values: values({ energyKj: 1700, energyKcal: 400, carbohydrate: 100 }) },
  });
  const water = item("WAT", {
    name: "Water",
    unit: "l",
    densityGPerMl: 1,
    nutrition: { basis: "100ml", values: values() },
  });
  const product = item("PRD", { type: "finished" });
  const text = (segments: { text: string }[]) => segments.map((s) => s.text).join("");

  it("recognises water by its name", () => {
    expect(isWaterName("Water")).toBe(true);
    expect(isWaterName("drinking water")).toBe(true);
    expect(isWaterName(" Cold  water ".replace("  ", " "))).toBe(true);
    expect(isWaterName("Coconut water")).toBe(false);
    expect(isWaterName("Water chestnuts")).toBe(false);
  });

  it("leaves out water that is under 5% of the finished product", () => {
    // 940 g flour + 40 g water + 20 g sugar = 1000 g, nothing lost: water is 4%.
    const v = version(
      product,
      [
        [flour, 940, "g"],
        [water, 40, "g"],
        [sugar, 20, "g"],
      ],
      1000,
    );
    const facts = computeLabelFacts(v, graphOf([flour, sugar, water, product]));
    expect(text(facts.declaration)).toBe("Wheat flour, Sugar");
    expect(facts.omittedWater).toEqual([{ itemId: water.id, code: "WAT", weightG: 40, percent: 4 }]);
  });

  it("keeps water that is exactly 5% out (it must not exceed 5%), and water over it in", () => {
    const five = version(
      product,
      [
        [flour, 950, "g"],
        [water, 50, "g"],
      ],
      1000,
    );
    expect(text(computeLabelFacts(five, graphOf([flour, water, product])).declaration)).toBe("Wheat flour");
    const six = version(
      product,
      [
        [flour, 940, "g"],
        [water, 60, "g"],
      ],
      1000,
    );
    const facts = computeLabelFacts(six, graphOf([flour, water, product]));
    expect(text(facts.declaration)).toBe("Wheat flour, Water");
    expect(facts.omittedWater).toEqual([]);
  });

  it("works from the weight in the finished product for water marked as volatile", () => {
    // 900 g flour + 100 g water in the bowl, 940 g out: 60 g evaporated, 40 g of water is left (4.3%).
    const v = version(
      product,
      [
        [flour, 900, "g"],
        [water, 100, "g"],
      ],
      940,
    );
    const unmarked = computeLabelFacts(v, graphOf([flour, water, product]));
    expect(text(unmarked.declaration)).toBe("Wheat flour, Water");
    const marked = computeLabelFacts(v, graphOf([flour, water, product]), { volatileItemIds: [water.id] });
    expect(text(marked.declaration)).toBe("Wheat flour");
    expect(marked.omittedWater[0]).toMatchObject({ code: "WAT", weightG: 40, percent: 4.3 });
  });

  it("drops water that has all evaporated", () => {
    const v = version(
      product,
      [
        [flour, 900, "g"],
        [water, 100, "g"],
      ],
      900,
    );
    const facts = computeLabelFacts(v, graphOf([flour, water, product]), { volatileItemIds: [water.id] });
    expect(text(facts.declaration)).toBe("Wheat flour");
  });

  it("leaves other ingredients and the nutrition alone", () => {
    const v = version(
      product,
      [
        [flour, 940, "g"],
        [water, 40, "g"],
        [sugar, 20, "g"],
      ],
      1000,
    );
    const g = graphOf([flour, sugar, water, product]);
    expect(computeLabelFacts(v, g).nutrition.per100).toEqual(rollUpNutrition(v, g).per100);
  });

  it("says so when the weight of the finished product is not known", () => {
    const each = item("EACH", { type: "finished", unit: "each" });
    const v = version(
      each,
      [
        [flour, 940, "g"],
        [water, 40, "g"],
      ],
      10,
      "each",
    );
    const facts = computeLabelFacts(v, graphOf([flour, water, each]));
    expect(text(facts.declaration)).toBe("Wheat flour, Water");
    expect(facts.warnings.map((w) => w.kind)).toContain("water_rule_not_applied");
  });
});
