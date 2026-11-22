import { describe, expect, it } from "vitest";
import { parseActiveModules, resolveModuleAccess } from "./modules";
import {
  batchCodePrefix,
  batchFactor,
  batchMaterials,
  batchSizeTarget,
  batchCoverage,
  batchesToCover,
  canTransitionBatch,
  generateBatchCode,
  lotMassBalance,
  materialRequirementsQuerySchema,
  materialRequirements,
  outstandingQuantity,
  PLAN_FROM_DEMAND_MAX_BATCHES,
  planFromDemand,
  planFromDemandQuerySchema,
  plannedOutputBase,
  productionBatchCreateSchema,
  productionPlanBatchesSchema,
  productionBatchUpdateSchema,
  productionConsumptionSchema,
  productionOutputSchema,
  type RequirementBatch,
} from "./production";

const ID = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("module", () => {
  it("needs recipes, stock and demand, and is closed unless all are readable", () => {
    expect(() => parseActiveModules("items,stock,demand,production")).toThrow(/needs "recipes"/);
    expect(() => parseActiveModules("items,recipes,demand,production")).toThrow(/needs "stock"/);
    expect(() => parseActiveModules("items,recipes,stock,production")).toThrow(/needs "demand"/);
    expect(parseActiveModules("items,recipes,stock,demand,production")).toEqual([
      "items",
      "recipes",
      "stock",
      "demand",
      "production",
    ]);
    const active = parseActiveModules(undefined);
    const access = (grants: Record<string, string>) =>
      resolveModuleAccess({ role: "member", active, grants: grants as never }).production;
    expect(access({ production: "write" })).toBe("none");
    expect(access({ items: "read", recipes: "read", production: "write" })).toBe("none");
    expect(access({ items: "read", recipes: "read", stock: "read", production: "write" })).toBe("none");
    expect(
      access({ items: "read", recipes: "read", stock: "read", demand: "read", production: "write" }),
    ).toBe("write");
  });
});

describe("batch codes and status flow", () => {
  it("generates batch codes from the planned date and a sequence", () => {
    expect(batchCodePrefix("2026-11-05")).toBe("B261105-");
    expect(generateBatchCode("2026-11-05", 2)).toBe("B261105-002");
  });

  it("moves planned → in progress → completed, and cancels only open batches", () => {
    expect(canTransitionBatch("planned", "in_progress")).toBe(true);
    expect(canTransitionBatch("planned", "completed")).toBe(false);
    expect(canTransitionBatch("in_progress", "completed")).toBe(true);
    expect(canTransitionBatch("in_progress", "cancelled")).toBe(true);
    expect(canTransitionBatch("completed", "cancelled")).toBe(false);
    expect(canTransitionBatch("cancelled", "planned")).toBe(false);
  });
});

describe("scaling a batch", () => {
  // A cake recipe: one batch yields 12 cakes (each, 450 g each).
  const cake = { unit: "each" as const, unitWeightG: 450 };
  const version = { yieldQuantity: 12, yieldUnit: "each" as const };

  it("stores the size as the output in base units, by batches or by target output", () => {
    expect(plannedOutputBase(version, cake, { batches: 2.5 })).toBe(30);
    expect(plannedOutputBase(version, cake, { outputQuantity: 18, outputUnit: "each" })).toBe(18);
    // Crossing dimensions needs the item's unit weight.
    expect(plannedOutputBase(version, cake, { outputQuantity: 9, outputUnit: "kg" })).toBe(20);
    expect(plannedOutputBase(version, { unit: "each" }, { outputQuantity: 9, outputUnit: "kg" })).toBeNull();
    expect(plannedOutputBase({ yieldQuantity: 0, yieldUnit: "each" }, cake, { batches: 2 })).toBeNull();
  });

  it("derives the number of batches with the recipes module's scale factor", () => {
    expect(batchFactor(version, cake, 30)).toBe(2.5);
    const dough = { unit: "kg" as const };
    expect(batchFactor({ yieldQuantity: 5, yieldUnit: "kg" }, dough, 12_500)).toBe(2.5);
    expect(batchFactor({ yieldQuantity: 0, yieldUnit: "kg" }, dough, 1000)).toBeNull();
  });

  it("scales recipe lines to base units, adding lines of the same item", () => {
    const flour = { unit: "kg" as const };
    const milk = { unit: "l" as const, densityGPerMl: 1.03 };
    const eggs = { unit: "each" as const };
    const materials = batchMaterials(
      [
        { itemId: "flour", quantity: 1.5, unit: "kg", item: flour },
        { itemId: "milk", quantity: 515, unit: "g", item: milk },
        { itemId: "flour", quantity: 100, unit: "g", item: flour },
        { itemId: "eggs", quantity: 1, unit: "kg", item: eggs },
      ],
      2,
    );
    expect(materials).toEqual([
      { itemId: "flour", required: 3200 },
      { itemId: "milk", required: 1000 },
      { itemId: "eggs", required: null },
    ]);
  });

  it("never reports a negative outstanding quantity", () => {
    expect(outstandingQuantity(1000, 400)).toBe(600);
    expect(outstandingQuantity(1000, 1200)).toBe(0);
    expect(outstandingQuantity(null, 10)).toBeNull();
  });
});

describe("material requirements", () => {
  const batch = (over: Partial<RequirementBatch> & Pick<RequirementBatch, "batchId">): RequirementBatch => ({
    batchCode: over.batchId.toUpperCase(),
    plannedOn: "2026-11-12",
    status: "planned",
    materials: [],
    ...over,
  });

  it("adds up open batches per item, takes off what is consumed and compares with stock", () => {
    const rows = materialRequirements(
      [
        batch({
          batchId: "b1",
          status: "in_progress",
          materials: [
            { itemId: "flour", required: 3000 },
            { itemId: "milk", required: 1000 },
          ],
          consumed: { flour: 1000, milk: 1500 },
        }),
        batch({
          batchId: "b2",
          plannedOn: "2026-11-13",
          materials: [
            { itemId: "flour", required: 3000 },
            { itemId: "sugar", required: null },
          ],
        }),
      ],
      {
        flour: { available: 4000, quarantine: 500 },
        milk: { available: 0, quarantine: 0 },
      },
    );
    expect(rows.map((r) => r.itemId)).toEqual(["flour", "milk", "sugar"]);
    expect(rows[0]).toMatchObject({
      required: 6000,
      consumed: 1000,
      outstanding: 5000,
      available: 4000,
      quarantine: 500,
      shortfall: 1000,
      incomplete: false,
    });
    expect(rows[0]!.batches).toEqual([
      { batchId: "b1", batchCode: "B1", plannedOn: "2026-11-12", required: 3000, outstanding: 2000 },
      { batchId: "b2", batchCode: "B2", plannedOn: "2026-11-13", required: 3000, outstanding: 3000 },
    ]);
    // Over-consumption leaves nothing outstanding and no shortfall.
    expect(rows[1]).toMatchObject({ required: 1000, consumed: 1500, outstanding: 0, shortfall: 0 });
    // An unconvertible line is flagged, not guessed.
    expect(rows[2]).toMatchObject({ required: 0, incomplete: true, available: 0 });
  });
});

describe("lot mass balance", () => {
  it("accounts for everything that came in, net of reversals", () => {
    const balance = lotMassBalance([
      { type: "receipt", quantity: 10_000 },
      { type: "transfer_out", quantity: -2000 },
      { type: "transfer_in", quantity: 2000 },
      { type: "consumption", quantity: -3000 },
      { type: "consumption", quantity: -500 },
      { type: "consumption", quantity: 500 }, // reversal
      { type: "waste", quantity: -1000 },
      { type: "stocktake", quantity: -100 },
    ]);
    expect(balance).toEqual({
      received: 10_000,
      returned: 0,
      produced: 0,
      consumed: 3000,
      despatched: 0,
      wasted: 1000,
      adjusted: -100,
      transferred: 0,
      onHand: 5900,
      input: 10_000,
      adjustedPercent: -1,
    });
    expect(lotMassBalance([]).adjustedPercent).toBeNull();
    expect(lotMassBalance([{ type: "production", quantity: 24 }])).toMatchObject({ produced: 24, input: 24 });
  });
});

describe("validation", () => {
  it("plans a batch by batches or by output, not both", () => {
    const base = { recipeId: ID(1), plannedOn: "2026-11-12" };
    expect(productionBatchCreateSchema.safeParse({ ...base, batches: 2 }).success).toBe(true);
    expect(
      productionBatchCreateSchema.safeParse({ ...base, outputQuantity: 24, outputUnit: "each" }).success,
    ).toBe(true);
    expect(productionBatchCreateSchema.safeParse(base).success).toBe(false);
    expect(
      productionBatchCreateSchema.safeParse({ ...base, batches: 1, outputQuantity: 2, outputUnit: "each" })
        .success,
    ).toBe(false);
    expect(productionBatchCreateSchema.safeParse({ ...base, outputQuantity: 2 }).success).toBe(false);
    expect(productionBatchCreateSchema.safeParse({ ...base, batches: 1.00001 }).success).toBe(false);
    expect(batchSizeTarget({ batches: 2 })).toEqual({ batches: 2 });
    expect(batchSizeTarget({ outputQuantity: 2, outputUnit: "kg" })).toEqual({
      outputQuantity: 2,
      outputUnit: "kg",
    });
    expect(batchSizeTarget({})).toBeNull();
  });

  it("refuses empty updates", () => {
    expect(productionBatchUpdateSchema.safeParse({}).success).toBe(false);
    expect(productionBatchUpdateSchema.safeParse({ notes: "" }).success).toBe(true);
  });

  it("refuses the same lot twice at one location in one consumption", () => {
    const line = { lotId: ID(1), locationId: ID(2), quantity: 1, unit: "kg" };
    expect(productionConsumptionSchema.safeParse({ lines: [line] }).success).toBe(true);
    expect(productionConsumptionSchema.safeParse({ lines: [line, line] }).success).toBe(false);
    expect(productionConsumptionSchema.safeParse({ lines: [] }).success).toBe(false);
  });

  it("keeps an existing lot's code and dates when adding output to it", () => {
    expect(productionOutputSchema.safeParse({ quantity: 1, unit: "each" }).success).toBe(true);
    expect(
      productionOutputSchema.safeParse({ quantity: 1, unit: "each", expiresOn: "2026-12-01" }).success,
    ).toBe(false);
    expect(
      productionOutputSchema.safeParse({ quantity: 1, unit: "each", lotId: ID(1), lotCode: "X" }).success,
    ).toBe(false);
  });

  it("limits requirements to a year", () => {
    expect(materialRequirementsQuerySchema.safeParse({ from: "2026-11-01", to: "2026-11-30" }).success).toBe(
      true,
    );
    expect(materialRequirementsQuerySchema.safeParse({ from: "2026-11-30", to: "2026-11-01" }).success).toBe(
      false,
    );
    expect(materialRequirementsQuerySchema.safeParse({ from: "2026-01-01", to: "2027-06-01" }).success).toBe(
      false,
    );
  });
});

describe("planning batches from demand", () => {
  const W1 = "2026-11-09";
  const W2 = "2026-11-16";
  const W3 = "2026-11-23";
  const weeks = [W1, W2, W3];
  // Cakes are counted (base: each), 450 g each; soup is in litres (base: ml).
  const CAKE = ID(1);
  const SOUP = ID(2);
  const PIE = ID(3);
  const items = new Map([
    [CAKE, { unit: "each" as const, unitWeightG: 450 }],
    [SOUP, { unit: "l" as const }],
    [PIE, { unit: "each" as const }],
  ]);
  const recipe = (
    id: number,
    itemId: string,
    version: { yieldQuantity: number; yieldUnit: "each" | "kg" | "l" | "ml" } | null,
    status: "active" | "archived" = "active",
  ) => ({
    id: ID(100 + id),
    outputItemId: itemId,
    status,
    approvedVersion: version && { id: ID(200 + id), ...version },
  });
  const batch = (
    id: number,
    itemId: string,
    plannedOn: string,
    planned: number,
    status: "planned" | "in_progress" | "completed" | "cancelled" = "planned",
    produced = 0,
  ) => ({ id: ID(300 + id), itemId, plannedOn, planned, status, produced });

  it("counts what batches cover: planned output, the larger of planned and made, then what was made", () => {
    expect(batchCoverage({ status: "planned", planned: 24, produced: 0 })).toBe(24);
    expect(batchCoverage({ status: "in_progress", planned: 24, produced: 10 })).toBe(24);
    expect(batchCoverage({ status: "in_progress", planned: 24, produced: 30 })).toBe(30);
    expect(batchCoverage({ status: "completed", planned: 24, produced: 20 })).toBe(20);
    expect(batchCoverage({ status: "cancelled", planned: 24, produced: 0 })).toBe(0);
  });

  it("rounds the batches needed up to whole batches, ignoring float noise", () => {
    expect(batchesToCover(25, 12)).toBe(3);
    expect(batchesToCover(24, 12)).toBe(2);
    expect(batchesToCover(24.000001, 12)).toBe(2);
    expect(batchesToCover(0, 12)).toBe(0);
    expect(batchesToCover(-5, 12)).toBe(0);
    expect(batchesToCover(10, null)).toBe(0);
    expect(batchesToCover(10, 0)).toBe(0);
  });

  it("works out demand, planned, gap and whole batches per item and week", () => {
    const [row] = planFromDemand({
      weeks,
      items,
      demand: [
        { itemId: CAKE, periodStart: W1, quantity: 30 },
        { itemId: CAKE, periodStart: W2, quantity: 20 },
        { itemId: CAKE, periodStart: W2, quantity: 5 }, // another customer: summed
        { itemId: CAKE, periodStart: "2026-11-30", quantity: 99 }, // outside the range
      ],
      batches: [
        batch(1, CAKE, "2026-11-11", 12), // W1, a Wednesday
        batch(2, CAKE, "2026-11-15", 12, "in_progress", 14), // W1, Sunday: counts 14
        batch(3, CAKE, "2026-11-16", 24, "cancelled"), // W2: ignored
        batch(4, CAKE, "2026-11-23", 24, "completed", 30), // W3: no demand, over-covered
        batch(5, CAKE, "2026-11-08", 50), // the Sunday before the range: ignored
      ],
      recipes: [recipe(1, CAKE, { yieldQuantity: 12, yieldUnit: "each" })],
    });
    expect(row!.itemId).toBe(CAKE);
    expect(row!.recipeId).toBe(ID(101));
    expect(row!.issue).toBeNull();
    expect(row!.perBatch).toBe(12);
    expect(row!.cells).toEqual([
      {
        periodStart: W1,
        demand: 30,
        planned: 26,
        gap: 4,
        suggestedBatches: 1,
        suggestedOutput: 12,
        batchIds: [ID(301), ID(302)],
      },
      {
        periodStart: W2,
        demand: 25,
        planned: 0,
        gap: 25,
        suggestedBatches: 3,
        suggestedOutput: 36,
        batchIds: [],
      },
      {
        periodStart: W3,
        demand: 0,
        planned: 30,
        gap: 0,
        suggestedBatches: 0,
        suggestedOutput: 0,
        batchIds: [ID(304)],
      },
    ]);
    expect(row!.totals).toEqual({
      demand: 55,
      planned: 56,
      gap: 29,
      suggestedBatches: 4,
      suggestedOutput: 48,
    });
  });

  it("scales across units with the item's own conversions", () => {
    // Soup demand is held in ml; one batch yields 40 l. A cake recipe that yields 5.4 kg makes 12 cakes.
    const [soup, cake] = planFromDemand({
      weeks,
      items,
      demand: [
        { itemId: SOUP, periodStart: W1, quantity: 100_000 },
        { itemId: CAKE, periodStart: W1, quantity: 13 },
      ],
      batches: [],
      recipes: [
        recipe(1, SOUP, { yieldQuantity: 40, yieldUnit: "l" }),
        recipe(2, CAKE, { yieldQuantity: 5.4, yieldUnit: "kg" }),
      ],
    });
    expect(soup!.perBatch).toBe(40_000);
    expect(soup!.cells[0]).toMatchObject({ gap: 100_000, suggestedBatches: 3, suggestedOutput: 120_000 });
    expect(cake!.perBatch).toBe(12);
    expect(cake!.cells[0]).toMatchObject({ suggestedBatches: 2, suggestedOutput: 24 });
  });

  it("flags items with no recipe, no approved version, several recipes or no usable yield", () => {
    const plan = (recipes: ReturnType<typeof recipe>[], choices?: Record<string, string>) =>
      planFromDemand({
        weeks,
        items,
        demand: [{ itemId: PIE, periodStart: W1, quantity: 10 }],
        batches: [],
        recipes,
        choices,
      })[0]!;
    expect(plan([]).issue).toBe("no_recipe");
    expect(plan([recipe(1, CAKE, { yieldQuantity: 1, yieldUnit: "each" })]).issue).toBe("no_recipe");
    // A draft-only recipe, or an archived one, can't be planned.
    expect(plan([recipe(1, PIE, null)]).issue).toBe("no_approved_version");
    expect(plan([recipe(1, PIE, { yieldQuantity: 4, yieldUnit: "each" }, "archived")]).issue).toBe(
      "no_approved_version",
    );
    // A pie has no unit weight, so a yield in kg can't be counted.
    const heavy = plan([recipe(1, PIE, { yieldQuantity: 2, yieldUnit: "kg" })]);
    expect(heavy).toMatchObject({ issue: "no_yield", recipeId: ID(101), perBatch: null });
    expect(heavy.cells[0]).toMatchObject({ demand: 10, gap: 10, suggestedBatches: 0 });

    // Several candidates: the person chooses; an archived or draft-only recipe isn't one.
    const several = [
      recipe(1, PIE, { yieldQuantity: 4, yieldUnit: "each" }),
      recipe(2, PIE, { yieldQuantity: 6, yieldUnit: "each" }),
      recipe(3, PIE, { yieldQuantity: 100, yieldUnit: "each" }, "archived"),
      recipe(4, PIE, null),
    ];
    const ambiguous = plan(several);
    expect(ambiguous).toMatchObject({
      issue: "choose_recipe",
      recipeId: null,
      perBatch: null,
      optionIds: [ID(101), ID(102)],
    });
    expect(ambiguous.cells[0]).toMatchObject({ gap: 10, suggestedBatches: 0, suggestedOutput: 0 });
    const chosen = plan(several, { [PIE]: ID(102) });
    expect(chosen).toMatchObject({ issue: null, recipeId: ID(102), perBatch: 6 });
    expect(chosen.cells[0]).toMatchObject({ suggestedBatches: 2, suggestedOutput: 12 });
    // Choosing something that isn't a candidate changes nothing.
    expect(plan(several, { [PIE]: ID(103) }).issue).toBe("choose_recipe");
    // With one candidate, it is picked whatever else exists.
    expect(plan(several.slice(1)).recipeId).toBe(ID(102));
  });

  it("keeps the order of the demand and leaves out unknown items", () => {
    const rows = planFromDemand({
      weeks,
      items,
      demand: [
        { itemId: SOUP, periodStart: W2, quantity: 1 },
        { itemId: ID(99), periodStart: W2, quantity: 1 },
        { itemId: CAKE, periodStart: W1, quantity: 1 },
      ],
      batches: [],
      recipes: [],
    });
    expect(rows.map((r) => r.itemId)).toEqual([SOUP, CAKE]);
  });

  it("validates the query and the batches to create", () => {
    const query = planFromDemandQuerySchema.parse({
      from: "2026-W46",
      to: "2026-11-25",
      recipeIds: ` ${ID(1)},${ID(2)} ,`,
    });
    expect(query).toEqual({ from: W1, to: W3, recipeIds: [ID(1), ID(2)] });
    expect(planFromDemandQuerySchema.parse({})).toEqual({ recipeIds: [] });
    expect(planFromDemandQuerySchema.safeParse({ recipeIds: "nope" }).success).toBe(false);
    expect(planFromDemandQuerySchema.safeParse({ from: W2, to: W1 }).success).toBe(false);

    const ok = productionPlanBatchesSchema.safeParse({
      batches: [
        { recipeId: ID(1), plannedOn: W1, batches: 2 },
        { recipeId: ID(1), plannedOn: W2, outputQuantity: 30, outputUnit: "each" },
      ],
    });
    expect(ok.success).toBe(true);
    expect(productionPlanBatchesSchema.safeParse({ batches: [] }).success).toBe(false);
    expect(
      productionPlanBatchesSchema.safeParse({ batches: [{ recipeId: ID(1), plannedOn: W1 }] }).success,
    ).toBe(false);
    expect(
      productionPlanBatchesSchema.safeParse({
        batches: Array.from({ length: PLAN_FROM_DEMAND_MAX_BATCHES + 1 }, () => ({
          recipeId: ID(1),
          plannedOn: W1,
          batches: 1,
        })),
      }).success,
    ).toBe(false);
  });
});
