import { describe, expect, it } from "vitest";
import type { AllergenCode, ItemType, UnitCode } from "./items";
import {
  calculateEnergy,
  canApproveProductLabel,
  compareLabelSources,
  computeLabelFacts,
  dateGuidance,
  declarationSegments,
  emphasiseAllergens,
  itemNutrition,
  labelFactsQuerySchema,
  labelSourceSnapshot,
  netQuantityFor,
  nutritionInputSchema,
  nutritionPanel,
  nutritionPanelRows,
  parseSegmentsMarkup,
  quidFor,
  restylePanel,
  trafficLights,
  roundNutrient,
  rollUpNutrition,
  segmentsMarkup,
  segmentsText,
  type LabelGraph,
  type LabelItemFacts,
  type LabelRecipeVersion,
  type LabelSegment,
  type LabelSourceSnapshot,
  type NutritionValues,
} from "./labels";

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

let seq = 0;
function item(
  code: string,
  over: Partial<LabelItemFacts> & { type?: ItemType; unit?: UnitCode; allergens?: AllergenCode[] } = {},
): LabelItemFacts {
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
  };
}

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

const graphOf = (items: LabelItemFacts[], subs: LabelRecipeVersion[] = []): LabelGraph => ({
  items: new Map(items.map((i) => [i.id, i])),
  subRecipes: new Map(subs.map((v) => [v.outputItemId, v])),
});

const bold = (segments: LabelSegment[]) => segments.filter((s) => s.emphasis).map((s) => s.text);

// Per 100 g, rounded figures from typical specifications.
const flour = item("FLR", {
  name: "Flour T55",
  declarationName: "Wheat flour",
  allergens: ["cereals_gluten"],
  nutrition: {
    basis: "100g",
    values: values({
      energyKj: 1450,
      energyKcal: 342,
      fat: 1.2,
      saturates: 0.2,
      carbohydrate: 70,
      sugars: 1.5,
      fibre: 3.1,
      protein: 11,
      salt: 0.01,
    }),
  },
});
const sugar = item("SUG", {
  name: "Caster sugar",
  nutrition: {
    basis: "100g",
    values: values({ energyKj: 1700, energyKcal: 400, carbohydrate: 100, sugars: 100 }),
  },
});
const butter = item("BUT", {
  name: "Butter",
  allergens: ["milk"],
  nutrition: {
    basis: "100g",
    values: values({ energyKj: 3041, energyKcal: 740, fat: 82, saturates: 52, protein: 0.6, salt: 1.2 }),
  },
});
const water = item("WAT", {
  name: "Water",
  unit: "l",
  densityGPerMl: 1,
  nutrition: { basis: "100ml", values: values() },
});
const egg = item("EGG", {
  name: "Free range egg",
  unit: "each",
  unitWeightG: 50,
  allergens: ["eggs"],
  nutrition: {
    basis: "100g",
    values: values({
      energyKj: 548,
      energyKcal: 131,
      fat: 9,
      saturates: 2.6,
      protein: 12.6,
      salt: 0.36,
      fibre: null,
    }),
  },
});

describe("nutrition roll-up", () => {
  const biscuit = item("BIS", { type: "finished", name: "Shortbread" });

  it("sums ingredients and divides by the yield, so moisture loss concentrates nutrients", () => {
    // 500 g flour + 250 g butter + 250 g sugar = 1000 g in the bowl; baked to 800 g.
    const v = version(
      biscuit,
      [
        [flour, 500, "g"],
        [butter, 0.25, "kg"],
        [sugar, 250, "g"],
      ],
      800,
    );
    const r = rollUpNutrition(v, graphOf([flour, butter, sugar, biscuit]));
    expect(r.complete).toBe(true);
    expect(r.bowlWeightG).toBe(1000);
    expect(r.yieldFactor).toBe(0.8);
    expect(r.basis).toBe("100g");
    // Energy: (5 × 1450 + 2.5 × 3041 + 2.5 × 1700) / 800 × 100.
    expect(r.per100!.energyKj).toBeCloseTo((7250 + 7602.5 + 4250) / 8, 6);
    expect(r.per100!.fat).toBeCloseTo((6 + 205) / 8, 6);
    expect(r.per100!.salt).toBeCloseTo((0.05 + 3) / 8, 6);
    expect(r.missing).toEqual([]);
  });

  it("reports ingredients without nutrition instead of counting them as zero", () => {
    const vanilla = item("VAN", { name: "Vanilla" });
    const v = version(
      biscuit,
      [
        [flour, 500, "g"],
        [vanilla, 5, "g"],
      ],
      450,
    );
    const r = rollUpNutrition(v, graphOf([flour, vanilla, biscuit]));
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual([
      { itemId: vanilla.id, code: "VAN", name: "Vanilla", reason: "no_nutrition", path: [] },
    ]);
    // Partial values are still there for information.
    expect(r.per100!.energyKj).toBeGreaterThan(0);
  });

  it("converts volumes and counts with the item's density or unit weight", () => {
    const v = version(
      biscuit,
      [
        [flour, 1, "kg"],
        [water, 0.5, "l"],
        [egg, 4, "each"],
      ],
      1500,
    );
    const r = rollUpNutrition(v, graphOf([flour, water, egg, biscuit]));
    expect(r.complete).toBe(true);
    expect(r.bowlWeightG).toBe(1700);
    // Egg: 4 × 50 g = 200 g → 2 × 9 g fat; flour 10 × 1.2.
    expect(r.per100!.fat).toBeCloseTo(((12 + 18) / 1500) * 100, 6);
    // Eggs give no fibre figure: fibre is unknown, not zero, and the roll-up says why.
    expect(r.per100!.fibre).toBeNull();
    expect(r.fibreMissing).toEqual(["EGG"]);
  });

  it("flags a line that can't be converted", () => {
    const oil = item("OIL", {
      unit: "l",
      nutrition: {
        basis: "100g",
        values: values({ fat: 100, saturates: 15, energyKj: 3700, energyKcal: 900 }),
      },
    });
    const v = version(
      biscuit,
      [
        [flour, 1, "kg"],
        [oil, 0.1, "l"],
      ],
      1000,
    );
    const r = rollUpNutrition(v, graphOf([flour, oil, biscuit]));
    expect(r.complete).toBe(false);
    expect(r.missing.map((m) => [m.code, m.reason])).toEqual([["OIL", "unconvertible"]]);
  });

  it("follows sub-recipes through their approved version, with the path to what is missing", () => {
    const pastry = item("PST", { type: "wip", name: "Shortcrust pastry" });
    const filling = item("FIL", { type: "wip", name: "Filling" });
    const apple = item("APL", { name: "Bramley apple" });
    const pie = item("PIE", { type: "finished", unit: "each", unitWeightG: 150 });
    const pastryV = version(
      pastry,
      [
        [flour, 600, "g"],
        [butter, 300, "g"],
        [water, 100, "ml"],
      ],
      1000,
    );
    const fillingV = version(
      filling,
      [
        [apple, 800, "g"],
        [sugar, 200, "g"],
      ],
      900,
    );
    const pieV = version(
      pie,
      [
        [pastry, 60, "g"],
        [filling, 90, "g"],
      ],
      1,
      "each",
    );
    const g = graphOf([flour, butter, water, apple, sugar, pastry, filling, pie], [pastryV, fillingV]);

    const r = rollUpNutrition(pieV, g);
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual([
      { itemId: apple.id, code: "APL", name: "Bramley apple", reason: "no_nutrition", path: ["FIL"] },
    ]);

    const withApple = {
      ...apple,
      nutrition: {
        basis: "100g" as const,
        values: values({
          energyKj: 200,
          energyKcal: 48,
          carbohydrate: 11,
          sugars: 9,
          fibre: 1.8,
          protein: 0.3,
        }),
      },
    };
    const g2 = graphOf([flour, butter, water, withApple, sugar, pastry, filling, pie], [pastryV, fillingV]);
    const ok = rollUpNutrition(pieV, g2);
    expect(ok.complete).toBe(true);
    // A pie sold by count is declared per 100 g through its unit weight.
    expect(ok.basis).toBe("100g");
    expect(ok.yieldInBasisUnit).toBe(150);
    const pastryFat = ((6 * 1.2 + 3 * 82) / 1000) * 100; // per 100 g of pastry (yield 1000 g)
    expect(ok.per100!.fat).toBeCloseTo(((0.6 * pastryFat) / 150) * 100, 4);
    // The sub-recipe's own nutrition is what the item shows.
    expect(itemNutrition(pastry.id, g2).source).toBe("recipe");
    expect(itemNutrition(withApple.id, g2).source).toBe("entered");
  });

  it("needs a unit weight to declare per 100 g of something counted", () => {
    const bun = item("BUN", { type: "finished", unit: "each" });
    const v = version(bun, [[flour, 1, "kg"]], 10, "each");
    const r = rollUpNutrition(v, graphOf([flour, bun]));
    expect(r.complete).toBe(false);
    expect(r.per100).toBeNull();
    expect(r.missing.map((m) => m.reason)).toEqual(["no_yield"]);
  });

  it("declares liquids per 100 ml", () => {
    const syrup = item("SYR", { type: "finished", unit: "l", densityGPerMl: 1.3 });
    const v = version(
      syrup,
      [
        [sugar, 1300, "g"],
        [water, 0.5, "l"],
      ],
      1,
      "l",
    );
    const r = rollUpNutrition(v, graphOf([sugar, water, syrup]));
    expect(r.basis).toBe("100ml");
    expect(r.yieldInBasisUnit).toBe(1000);
    expect(r.per100!.sugars).toBeCloseTo(130, 6);
  });

  it("leaves packaging out and survives recipes that use each other", () => {
    const film = item("FILM", { type: "packaging", unit: "each" });
    const a = item("A", { type: "wip" });
    const b = item("B", { type: "wip" });
    const av = version(
      a,
      [
        [b, 100, "g"],
        [flour, 100, "g"],
        [film, 1, "each"],
      ],
      200,
    );
    const bv = version(b, [[a, 100, "g"]], 100);
    const r = rollUpNutrition(av, graphOf([a, b, flour, film], [av, bv]));
    expect(r.bowlWeightG).toBe(200);
    expect(r.missing.map((m) => [m.code, m.reason, m.path])).toEqual([["A", "cycle", ["B"]]]);
  });
});

describe("rounding for declaration (EU guidance, 2012)", () => {
  it("rounds energy to whole kJ and kcal", () => {
    expect(roundNutrient("energyKj", 1046.5).display).toBe("1047 kJ");
    expect(roundNutrient("energyKcal", 249.4).display).toBe("249 kcal");
  });

  it("rounds fat, carbohydrate, sugars, protein and fibre", () => {
    expect(roundNutrient("fat", 12.4).display).toBe("12 g");
    expect(roundNutrient("fat", 10).display).toBe("10 g");
    expect(roundNutrient("fat", 9.94).display).toBe("9.9 g");
    expect(roundNutrient("protein", 0.51).display).toBe("0.5 g");
    expect(roundNutrient("sugars", 0.5)).toEqual({ raw: 0.5, value: 0, display: "<0.5 g", lessThan: true });
    expect(roundNutrient("carbohydrate", 0).display).toBe("0 g");
  });

  it("rounds saturates to 0.1 g down to 0.1 g", () => {
    expect(roundNutrient("saturates", 10.6).display).toBe("11 g");
    expect(roundNutrient("saturates", 0.15).display).toBe("0.2 g");
    expect(roundNutrient("saturates", 0.1).display).toBe("<0.1 g");
  });

  it("rounds salt to 0.01 g below 1 g and 0.1 g above", () => {
    expect(roundNutrient("salt", 1.26).display).toBe("1.3 g");
    expect(roundNutrient("salt", 0.384).display).toBe("0.38 g");
    expect(roundNutrient("salt", 0.0125).display).toBe("<0.01 g");
    expect(roundNutrient("salt", 0.013).display).toBe("0.01 g");
  });

  it("keeps raw values beside the rounded panel, and leaves fibre out when unknown", () => {
    const panel = nutritionPanel(
      "100g",
      values({ energyKj: 1000.4, energyKcal: 239, fat: 3.333, fibre: null }),
    );
    expect(panel.raw.fat).toBe(3.333);
    expect(panel.declared.fat?.display).toBe("3.3 g");
    expect(panel.declared.fibre).toBeNull();
    const rows = nutritionPanelRows(panel);
    expect(rows[0]).toEqual({ label: "Energy", value: "1000 kJ / 239 kcal", indent: false });
    expect(rows.map((r) => r.label)).toEqual([
      "Energy",
      "Fat",
      "of which saturates",
      "Carbohydrate",
      "of which sugars",
      "Protein",
      "Salt",
    ]);
  });
});

describe("nutrition input", () => {
  const ok = {
    energyKj: 1450,
    energyKcal: 342,
    fat: 1.2,
    saturates: 0.2,
    carbohydrate: 70,
    sugars: 1.5,
    protein: 11,
    salt: 0.01,
  };
  it("defaults to per 100 g with optional fibre", () => {
    expect(nutritionInputSchema.parse(ok)).toMatchObject({ basis: "100g", fibre: null });
  });
  it("refuses impossible values", () => {
    expect(nutritionInputSchema.safeParse({ ...ok, saturates: 2 }).success).toBe(false);
    expect(nutritionInputSchema.safeParse({ ...ok, sugars: 71 }).success).toBe(false);
    expect(nutritionInputSchema.safeParse({ ...ok, carbohydrate: 120, sugars: 1 }).success).toBe(false);
    expect(
      nutritionInputSchema.safeParse({ ...ok, carbohydrate: 120, sugars: 1, basis: "100ml" }).success,
    ).toBe(true);
    // kJ and kcal typed the wrong way round.
    expect(nutritionInputSchema.safeParse({ ...ok, energyKj: 342, energyKcal: 1450 }).success).toBe(false);
    expect(nutritionInputSchema.safeParse({ ...ok, salt: 0.0125 }).success).toBe(false);
  });
});

describe("allergen emphasis", () => {
  it("emphasises the words that name an allergen the ingredient contains", () => {
    const r = emphasiseAllergens("Wheat flour", ["cereals_gluten"]);
    expect(r.segments).toEqual([{ text: "Wheat", emphasis: true }, { text: " flour" }]);
    expect(r.unnamed).toEqual([]);
  });

  it("doesn't emphasise allergens the ingredient doesn't contain, or parts of words", () => {
    expect(bold(emphasiseAllergens("Coconut milk", []).segments)).toEqual([]);
    expect(bold(emphasiseAllergens("Coconut, nutmeg", ["nuts"]).segments)).toEqual([]);
    expect(emphasiseAllergens("Coconut, nutmeg", ["nuts"]).unnamed).toEqual(["nuts"]);
  });

  it("doesn't emphasise phrases that aren't the allergen: cocoa butter, cream of tartar, coconut milk", () => {
    const chocolate = emphasiseAllergens(
      "sugar, cocoa butter, whole milk powder, cocoa mass, emulsifier: soya lecithin",
      ["milk", "soybeans"],
    );
    expect(bold(chocolate.segments)).toEqual(["milk", "soya"]);
    expect(bold(emphasiseAllergens("cream of tartar, butter", ["milk"]).segments)).toEqual(["butter"]);
    expect(bold(emphasiseAllergens("Shea butter, coconut milk, coconut cream", ["milk"]).segments)).toEqual(
      [],
    );
    // Only cocoa butter: milk is not named, so a caller adds it in brackets.
    expect(emphasiseAllergens("Cocoa butter", ["milk"]).unnamed).toEqual(["milk"]);
    expect(emphasiseAllergens("Cocoa Butter, butter", ["milk"]).unnamed).toEqual([]);
  });

  it("rules a phrase out for one allergen only: peanut butter is peanut, not milk", () => {
    const r = emphasiseAllergens("Peanut butter", ["peanuts", "milk"]);
    expect(r.segments).toEqual([{ text: "Peanut", emphasis: true }, { text: " butter" }]);
    expect(r.unnamed).toEqual(["milk"]);
    // Oat milk names oats, not milk; pine nuts are not tree nuts.
    expect(bold(emphasiseAllergens("Oat milk", ["cereals_gluten", "milk"]).segments)).toEqual(["Oat"]);
    expect(bold(emphasiseAllergens("Pine nuts, almonds", ["nuts"]).segments)).toEqual(["almonds"]);
  });

  it("never matches inside a word: butternut, buckwheat, butter beans", () => {
    expect(bold(emphasiseAllergens("Butternut squash", ["milk", "nuts"]).segments)).toEqual([]);
    expect(bold(emphasiseAllergens("Buckwheat flour", ["cereals_gluten"]).segments)).toEqual([]);
    expect(bold(emphasiseAllergens("Butter beans", ["milk"]).segments)).toEqual([]);
    expect(bold(emphasiseAllergens("Single cream, ice cream", ["milk"]).segments)).toEqual([
      "cream",
      "cream",
    ]);
  });

  it("takes text written with ** markers as written", () => {
    const r = emphasiseAllergens("Whey powder (**milk**)", ["milk"]);
    expect(r.segments).toEqual([{ text: "Whey powder (" }, { text: "milk", emphasis: true }, { text: ")" }]);
  });

  it("round-trips the editing markup", () => {
    const segments = parseSegmentsMarkup("**Wheat** flour, sugar, **butter** (**milk**)");
    expect(bold(segments)).toEqual(["Wheat", "butter", "milk"]);
    expect(segmentsMarkup(segments)).toBe("**Wheat** flour, sugar, **butter** (**milk**)");
    expect(segmentsText(segments)).toBe("Wheat flour, sugar, butter (milk)");
    // An unpaired marker stays as text.
    expect(parseSegmentsMarkup("a ** b")).toEqual([{ text: "a ** b" }]);
  });
});

describe("ingredient declaration", () => {
  const cake = item("CAKE", { type: "finished", name: "Victoria sponge", mayContain: ["nuts"] });
  const whey = item("WHEY", { name: "Whey powder", allergens: ["milk"] });
  const choc = item("CHC", {
    name: "Choc chips 5kg",
    declarationName: "Chocolate chips",
    components: "sugar, cocoa mass, cocoa butter, whole milk powder, emulsifier: soya lecithin",
    allergens: ["soybeans", "milk"],
    mayContain: ["peanuts"],
  });

  it("lists ingredients by weight at the mixing bowl, heaviest first, allergens emphasised", () => {
    const v = version(
      cake,
      [
        [sugar, 200, "g"],
        [flour, 0.3, "kg"],
        [egg, 4, "each"],
        [whey, 10, "g"],
      ],
      600,
    );
    const facts = computeLabelFacts(v, graphOf([sugar, flour, egg, whey, cake]));
    expect(facts.ingredients.map((e) => e.code)).toEqual(["FLR", "EGG", "SUG", "WHEY"]);
    expect(segmentsMarkup(facts.declaration)).toBe(
      "**Wheat** flour, Free range **egg**, Caster sugar, Whey powder (**milk**)",
    );
    expect(facts.allergens.contains).toEqual(["cereals_gluten", "eggs", "milk"]);
    // The product's own "may contain" (cross-contact on site) is added.
    expect(facts.mayContain).toEqual(["nuts"]);
    expect(facts.allergenStatement).toBe(
      "Allergy advice: for allergens, see ingredients in bold. May contain tree nuts.",
    );
    expect(facts.warnings.map((w) => [w.kind, w.itemCode])).toEqual([["allergen_not_named", "WHEY"]]);
  });

  it("puts a bought-in compound's components in brackets", () => {
    const v = version(
      cake,
      [
        [flour, 300, "g"],
        [choc, 50, "g"],
      ],
      300,
    );
    const facts = computeLabelFacts(v, graphOf([flour, choc, cake]));
    expect(segmentsMarkup(facts.declaration)).toBe(
      // Cocoa butter is not milk: only the milk powder is.
      "**Wheat** flour, Chocolate chips (sugar, cocoa mass, cocoa butter, whole **milk** powder, emulsifier: **soya** lecithin)",
    );
    expect(facts.mayContain).toEqual(["nuts", "peanuts"]);
  });

  it("brackets or expands sub-recipes, merging the same ingredient when expanded", () => {
    const sponge = item("SPG", { type: "wip", name: "Sponge mix", declarationName: "Sponge" });
    const spongeV = version(
      sponge,
      [
        [flour, 400, "g"],
        [sugar, 300, "g"],
        [butter, 300, "g"],
      ],
      900,
    );
    const v = version(
      cake,
      [
        [sponge, 800, "g"],
        [sugar, 150, "g"],
        [butter, 50, "g"],
      ],
      950,
    );
    const g = graphOf([flour, sugar, butter, sponge, cake], [spongeV]);

    const bracketed = computeLabelFacts(v, g);
    expect(segmentsMarkup(bracketed.declaration)).toBe(
      "Sponge (**Wheat** flour, **Butter**, Caster sugar), Caster sugar, **Butter**",
    );
    expect(bracketed.ingredients[0]!.compound).toBe(true);
    // "Butter" names milk, so it is emphasised wherever it appears.
    expect(bold(bracketed.declaration)).toEqual(["Wheat", "Butter", "Butter"]);

    const expanded = computeLabelFacts(v, g, { compoundStyle: "expanded" });
    // 800 g of sponge is 8/9 of a batch (1000 g in the bowl, 900 g made): flour 356, sugar 267
    // (+150), butter 267 (+50).
    expect(expanded.ingredients.map((e) => [e.code, Math.round(e.weightG!)])).toEqual([
      ["SUG", 417],
      ["FLR", 356],
      ["BUT", 317],
    ]);
    expect(segmentsMarkup(expanded.declaration)).toBe("Caster sugar, **Wheat** flour, **Butter**");
  });

  it("declares QUID percentages for the ingredients marked, against the finished weight after moisture loss", () => {
    const v = version(
      cake,
      [
        [flour, 500, "g"],
        [butter, 250, "g"],
        [sugar, 250, "g"],
      ],
      800,
    );
    const facts = computeLabelFacts(v, graphOf([flour, butter, sugar, cake]), { quidItemIds: [butter.id] });
    const entry = facts.ingredients.find((e) => e.code === "BUT")!;
    // 250 g of butter in 800 g of finished product.
    expect(entry.quid).toEqual({ percent: 31.3, display: "31%" });
    expect(segmentsText(facts.declaration)).toContain("Butter (31%)");
  });

  it("states QUID over 100% as grams per 100 g", () => {
    expect(quidFor(150, 160, 100)).toEqual({ percent: 150, display: "150 g per 100 g" });
    expect(quidFor(5, 100, null)).toEqual({ percent: 5, display: "5%" });
    expect(quidFor(0, 0, null)).toBeNull();
  });

  it("warns about a QUID item that isn't in the recipe and places unweighable lines last", () => {
    const oil = item("OIL", { unit: "l" });
    const v = version(
      cake,
      [
        [oil, 1, "l"],
        [flour, 10, "g"],
      ],
      1000,
    );
    const facts = computeLabelFacts(v, graphOf([oil, flour, sugar, cake]), { quidItemIds: [sugar.id] });
    expect(facts.ingredients.map((e) => e.code)).toEqual(["FLR", "OIL"]);
    expect(facts.warnings.map((w) => w.kind).sort()).toEqual(["quid_not_found", "unweighable"]);
  });

  describe("a sub-recipe reduced in cooking", () => {
    const per1 = (o: Partial<NutritionValues> = {}) => ({
      basis: "100g" as const,
      values: values({ energyKj: 100, energyKcal: 24, fat: 1, carbohydrate: 2, protein: 1, salt: 0.1, ...o }),
    });
    const tomato = item("TOM", { name: "Tomato", nutrition: per1() });
    const oil = item("OIL", { name: "Olive oil", nutrition: per1({ fat: 10 }) });
    const pasta = item("PAS", { name: "Pasta", nutrition: per1({ carbohydrate: 30 }) });
    const sauce = item("SAU", { type: "wip", name: "Tomato sauce" });
    const meal = item("MEAL", { type: "finished", name: "Pasta in tomato sauce" });
    // 900 g tomato and 100 g oil reduced to 500 g of sauce.
    const sauceV = version(
      sauce,
      [
        [tomato, 0.9, "kg"],
        [oil, 0.1, "kg"],
      ],
      0.5,
      "kg",
    );
    const mealV = version(
      meal,
      [
        [sauce, 0.4, "kg"],
        [pasta, 0.38, "kg"],
      ],
      0.78,
      "kg",
    );
    const g = graphOf([tomato, oil, pasta, sauce, meal], [sauceV]);

    it("weighs its ingredients by the yield, not the bowl: 400 g of sauce used 720 g of tomato", () => {
      const facts = computeLabelFacts(mealV, g, { compoundStyle: "expanded", quidItemIds: [tomato.id] });
      expect(facts.ingredients.map((e) => [e.code, Math.round(e.weightG!)])).toEqual([
        ["TOM", 720],
        ["PAS", 380],
        ["OIL", 80],
      ]);
      // 720 g of tomato in 780 g of product.
      expect(segmentsText(facts.declaration)).toBe("Tomato (92%), Pasta, Olive oil");
      expect(facts.warnings).toEqual([]);

      const bracketed = computeLabelFacts(mealV, g, { quidItemIds: [tomato.id] });
      expect(segmentsText(bracketed.declaration)).toBe("Tomato sauce (Tomato (92%), Olive oil), Pasta");
    });

    it("agrees with the nutrition roll-up, which already divides by the sub-recipe's yield", () => {
      const facts = computeLabelFacts(mealV, g, { compoundStyle: "expanded" });
      const byCode = new Map([tomato, oil, pasta].map((i) => [i.code, i]));
      // Moisture is lost once: the ingoing weights carry the nutrients, the product's yield divides.
      const fatFromIngredients = facts.ingredients.reduce(
        (sum, e) => sum + (e.weightG! * byCode.get(e.code)!.nutrition!.values.fat) / 100,
        0,
      );
      expect(facts.nutrition.per100!.fat).toBeCloseTo((fatFromIngredients / 780) * 100, 6);
      expect(facts.nutrition.bowlWeightG).toBe(780);
    });

    it("falls back to the bowl weight, with a warning, when the yield can't be weighed", () => {
      const counted = version(
        sauce,
        [
          [tomato, 0.9, "kg"],
          [oil, 0.1, "kg"],
        ],
        4,
        "each",
      );
      const facts = computeLabelFacts(mealV, graphOf([tomato, oil, pasta, sauce, meal], [counted]), {
        compoundStyle: "expanded",
      });
      expect(facts.ingredients.map((e) => [e.code, Math.round(e.weightG!)])).toEqual([
        ["PAS", 380],
        ["TOM", 360],
        ["OIL", 40],
      ]);
      expect(facts.warnings.map((w) => [w.kind, w.itemCode])).toEqual([["sub_recipe_yield", "SAU"]]);
    });
  });

  it("renders nested brackets and QUID before components", () => {
    const segments = declarationSegments([
      {
        itemId: "x",
        code: "X",
        name: [{ text: "Filling" }],
        weightG: 10,
        quid: { percent: 40, display: "40%" },
        components: [
          {
            itemId: "y",
            code: "Y",
            name: [{ text: "Milk", emphasis: true }],
            weightG: 5,
            quid: null,
            components: null,
            componentsText: null,
            compound: false,
          },
        ],
        componentsText: null,
        compound: true,
      },
    ]);
    expect(segmentsMarkup(segments)).toBe("Filling (40%) (**Milk**)");
  });
});

describe("staleness", () => {
  const tart = item("TART", { type: "finished", allergens: ["cereals_gluten", "milk"] });
  const base = [flour, butter];

  it("detects changed nutrition, allergens and wording of an ingredient", () => {
    const v = version(
      tart,
      [
        [flour, 100, "g"],
        [butter, 50, "g"],
      ],
      140,
    );
    const before = labelSourceSnapshot(v, graphOf([...base, tart]));
    expect(compareLabelSources(before, labelSourceSnapshot(v, graphOf([...base, tart])))).toEqual([]);

    const flour2 = {
      ...flour,
      nutrition: { basis: "100g" as const, values: { ...flour.nutrition!.values, salt: 0.02 } },
    };
    const butter2 = { ...butter, mayContain: ["nuts" as const] };
    const now = labelSourceSnapshot(v, graphOf([flour2, butter2, { ...tart }]));
    expect(compareLabelSources(before, now)).toEqual([
      { kind: "allergens_changed", itemCodes: ["BUT"] },
      { kind: "nutrition_changed", itemCodes: ["FLR"] },
    ]);
    // A label declaring no nutrition doesn't care about nutrition.
    expect(compareLabelSources(before, now, false)).toEqual([
      { kind: "allergens_changed", itemCodes: ["BUT"] },
    ]);

    const renamed = labelSourceSnapshot(
      v,
      graphOf([{ ...flour, declarationName: "Fortified wheat flour" }, butter, tart]),
    );
    expect(compareLabelSources(before, renamed)).toEqual([
      { kind: "declaration_changed", itemCodes: ["FLR"] },
    ]);
  });

  it("detects a new approved version of the recipe or of a sub-recipe", () => {
    const pastry = item("PST", { type: "wip" });
    const pastryV1 = version(pastry, [[flour, 100, "g"]], 100);
    const pastryV2 = version(
      pastry,
      [
        [flour, 100, "g"],
        [sugar, 10, "g"],
      ],
      100,
    );
    const v = version(tart, [[pastry, 100, "g"]], 100);
    const before = labelSourceSnapshot(v, graphOf([flour, sugar, pastry, tart], [pastryV1]));
    const now = labelSourceSnapshot(v, graphOf([flour, sugar, pastry, tart], [pastryV2]));
    expect(compareLabelSources(before, now)).toEqual([
      { kind: "sub_recipe_changed", itemCodes: ["PST"] },
      { kind: "ingredients_changed", itemCodes: ["SUG"] },
    ]);
    const v2 = version(tart, [[pastry, 100, "g"]], 100);
    expect(
      compareLabelSources(before, labelSourceSnapshot(v2, graphOf([flour, sugar, pastry, tart], [pastryV1]))),
    ).toEqual([{ kind: "recipe_version_superseded", itemCodes: [] }]);
  });

  it("flags a change to the product's own declared allergens", () => {
    const v = version(tart, [[flour, 100, "g"]], 100);
    const before = labelSourceSnapshot(v, graphOf([flour, tart]));
    const now = labelSourceSnapshot(v, graphOf([flour, { ...tart, mayContain: ["sesame"] }]));
    expect(compareLabelSources(before, now)).toEqual([{ kind: "allergens_changed", itemCodes: ["TART"] }]);
  });
});

describe("staleness of unit conversions", () => {
  const cake = item("CAKE", { type: "finished", unit: "kg" });
  const egg10 = item("EGG", {
    unit: "each",
    unitWeightG: 50,
    allergens: ["eggs"],
    nutrition: { basis: "100g", values: values({ energyKj: 600, energyKcal: 143, fat: 10, saturates: 3 }) },
  });
  const flour1 = item("FLOUR", {
    declarationName: "Wheat flour",
    allergens: ["cereals_gluten"],
    nutrition: { basis: "100g", values: values({ energyKj: 100, energyKcal: 24, fat: 1 }) },
  });
  const v = version(
    cake,
    [
      [egg10, 10, "each"],
      [flour1, 0.6, "kg"],
    ],
    1,
    "kg",
  );
  const before = labelSourceSnapshot(v, graphOf([egg10, flour1, cake]));

  it("flags a changed unit weight, which changes the panel and the order", () => {
    const heavier = graphOf([{ ...egg10, unitWeightG: 70 }, flour1, cake]);
    const was = computeLabelFacts(v, graphOf([egg10, flour1, cake]));
    const now = computeLabelFacts(v, heavier);
    expect([was.nutrition.per100!.fat, now.nutrition.per100!.fat]).toEqual([5.6, 7.6]);
    expect([segmentsText(was.declaration), segmentsText(now.declaration)]).toEqual([
      "Wheat flour, egg",
      "egg, Wheat flour",
    ]);
    expect(compareLabelSources(before, labelSourceSnapshot(v, heavier))).toEqual([
      { kind: "conversion_changed", itemCodes: ["EGG"] },
    ]);
    // It moves the order and QUID too, so it counts when no nutrition is declared.
    expect(compareLabelSources(before, labelSourceSnapshot(v, heavier), false)).toEqual([
      { kind: "conversion_changed", itemCodes: ["EGG"] },
    ]);
  });

  it("flags a cleared unit weight, which makes the roll-up incomplete", () => {
    const cleared = graphOf([{ ...egg10, unitWeightG: null }, flour1, cake]);
    expect(computeLabelFacts(v, cleared).nutrition.complete).toBe(false);
    expect(compareLabelSources(before, labelSourceSnapshot(v, cleared))).toEqual([
      { kind: "conversion_changed", itemCodes: ["EGG"] },
    ]);
  });

  it("flags a change to the product's conversion, which converts the yield", () => {
    const loaf = item("LOAF", { type: "finished", unit: "each", unitWeightG: 800 });
    const lv = version(loaf, [[flour1, 1, "kg"]], 1, "each");
    const was = labelSourceSnapshot(lv, graphOf([flour1, loaf]));
    const now = labelSourceSnapshot(lv, graphOf([flour1, { ...loaf, unitWeightG: 750 }]));
    expect(compareLabelSources(was, now)).toEqual([{ kind: "conversion_changed", itemCodes: ["LOAF"] }]);
  });

  it("doesn't turn a snapshot taken before conversions were recorded stale", () => {
    const old: LabelSourceSnapshot = {
      ...before,
      items: Object.fromEntries(
        Object.entries(before.items).map(([id, { conversion: _c, ...entry }]) => [id, entry]),
      ),
      output: { itemId: before.output.itemId, code: before.output.code, allergens: before.output.allergens },
    };
    const heavier = graphOf([{ ...egg10, unitWeightG: 70 }, flour1, cake]);
    expect(compareLabelSources(old, labelSourceSnapshot(v, heavier))).toEqual([]);
  });
});

describe("label defaults and queries", () => {
  it("drafts storage and date wording", () => {
    expect(dateGuidance("chilled", 5)).toBe("Use by: see date on pack. Shelf life 5 days from production.");
    expect(dateGuidance("ambient", null)).toBe("Best before: see date on pack.");
  });
  it("gives a net quantity for items sold by count with a unit weight", () => {
    expect(netQuantityFor({ unit: "each", unitWeightG: 400 })).toBe("400 g");
    expect(netQuantityFor({ unit: "each", unitWeightG: 1500 })).toBe("1.5 kg");
    expect(netQuantityFor({ unit: "kg", unitWeightG: null })).toBeNull();
  });
  it("parses QUID ids from a comma-separated list", () => {
    const id = "0190a000-0000-7000-8000-000000000001";
    expect(labelFactsQuerySchema.parse({ quid: `${id}, ` }).quid).toEqual([id]);
    expect(labelFactsQuerySchema.safeParse({ quid: "nope" }).success).toBe(false);
  });
});

describe("energy, portions, zero rule, traffic lights and four-eyes", () => {
  it("calculates energy with the UK conversion factors", () => {
    expect(calculateEnergy({ fat: 10, carbohydrate: 50, protein: 8, fibre: 2 })).toEqual({
      energyKj: 10 * 37 + 50 * 17 + 8 * 17 + 2 * 8,
      energyKcal: 10 * 9 + 50 * 4 + 8 * 4 + 2 * 2,
    });
    // Fibre unknown: left out.
    expect(calculateEnergy({ fat: 1, carbohydrate: 0, protein: 0, fibre: null })).toEqual({
      energyKj: 37,
      energyKcal: 9,
    });
    const panel = nutritionPanel(
      "100g",
      values({ energyKj: 1, energyKcal: 1, fat: 10, carbohydrate: 50, protein: 8, fibre: null }),
      { energyMethod: "calculated" },
    );
    expect(panel.energyMethod).toBe("calculated");
    expect(panel.declared.energyKcal?.display).toBe("322 kcal");
  });

  it("declares negligible amounts as 0 g when asked", () => {
    expect(roundNutrient("fat", 0.3).display).toBe("<0.5 g");
    expect(roundNutrient("fat", 0.3, { negligibleAsZero: true }).display).toBe("0 g");
    expect(roundNutrient("salt", 0.005, { negligibleAsZero: true }).display).toBe("0 g");
    expect(roundNutrient("fat", 0.6, { negligibleAsZero: true }).display).toBe("0.6 g");
  });

  it("works out per-portion values and % of the reference intake", () => {
    const raw = values({
      energyKj: 1000,
      energyKcal: 240,
      fat: 14,
      saturates: 7,
      carbohydrate: 26,
      sugars: 9,
      protein: 5,
      salt: 0.6,
    });
    const panel = nutritionPanel("100g", raw, { portionSize: 50, portionLabel: " 1 slice " });
    expect(panel.portion).toMatchObject({ size: 50, label: "1 slice" });
    expect(panel.portion?.declared.fat?.display).toBe("7.0 g");
    expect(panel.portion?.declared.energyKcal?.display).toBe("120 kcal");
    expect(panel.portion?.ri).toEqual({
      energy: 6,
      fat: 10,
      saturates: 18,
      carbohydrate: 5,
      sugars: 5,
      protein: 5,
      salt: 5,
    });
    const rows = nutritionPanelRows(panel);
    expect(rows[1]).toMatchObject({ label: "Fat", value: "14 g", portionValue: "7.0 g", ri: "10%" });
    // Restyling keeps the raw values and redoes the portion.
    const again = restylePanel(panel, { portionSize: 100 });
    expect(again.raw).toEqual(raw);
    expect(again.portion?.declared.fat?.display).toBe("14 g");
    expect(restylePanel(panel, {}).portion).toBeNull();
  });

  it("colours fat, saturates, sugars and salt by the UK front-of-pack thresholds", () => {
    const level = (panel: ReturnType<typeof nutritionPanel>, nutrient: string) =>
      trafficLights(panel).find((t) => t.nutrient === nutrient)?.level;
    const panel = nutritionPanel(
      "100g",
      values({ fat: 3, saturates: 5.2, sugars: 22.4, salt: 0.31, carbohydrate: 30 }),
    );
    expect(level(panel, "fat")).toBe("green"); // 3.0 is low (at or below)
    expect(level(panel, "saturates")).toBe("red"); // above 5.0
    expect(level(panel, "sugars")).toBe("amber"); // printed 22 g: medium
    expect(level(panel, "salt")).toBe("amber"); // 0.31 rounds to 0.31
    // A big portion makes it red even when per 100 g is medium.
    const big = nutritionPanel("100g", values({ fat: 10, carbohydrate: 10 }), { portionSize: 250 });
    expect(level(big, "fat")).toBe("red"); // 25 g per portion
    // Liquids use the per 100 ml thresholds.
    const drink = nutritionPanel("100ml", values({ sugars: 3, carbohydrate: 3 }));
    expect(level(drink, "sugars")).toBe("amber");
  });

  it("lets the last editor approve only as the sole manager", () => {
    const base = { lastEditedBy: "a", managerIds: ["a", "b"] };
    expect(canApproveProductLabel({ ...base, deciderId: "b" })).toBe(true);
    expect(canApproveProductLabel({ ...base, deciderId: "a" })).toBe(false);
    expect(canApproveProductLabel({ lastEditedBy: "a", deciderId: "a", managerIds: ["a"] })).toBe(true);
    expect(canApproveProductLabel({ lastEditedBy: null, deciderId: "a", managerIds: ["a", "b"] })).toBe(true);
  });
});
