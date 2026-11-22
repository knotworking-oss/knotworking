import { describe, expect, it } from "vitest";
import {
  costingBatchListQuerySchema,
  costingPeriodEnd,
  costingPeriodLabel,
  costingPeriodStart,
  costingPeriodsInRange,
  costingReport,
  costingReportQuerySchema,
  costingReportRange,
  COSTING_MAX_DEPTH,
  costPerItemUnit,
  createCostingEngine,
  parseCostingBound,
  standardCostPerBase,
  type BatchCost,
  type CostingBatch,
  type CostingFlow,
  type CostingGraph,
  type CostingItem,
  type CostingLot,
  type CostingRecipeVersion,
} from "./costing";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const item = (id: string, unit: CostingItem["unit"], standardCost: number | null): CostingItem => ({
  id,
  code: id.toUpperCase(),
  name: id,
  unit,
  standardCost,
});
const items = [
  item("flour", "kg", 0.8),
  item("sugar", "kg", 1.2),
  item("eggs", "each", 0.25),
  item("salt", "kg", null),
  item("dough", "kg", 1.5),
  item("bread", "each", null),
];

/** Dough: 10 kg from 6 kg flour, 1 kg sugar, 20 eggs (standard 11.00 a batch, 1.10 a kg). */
const doughV1: CostingRecipeVersion = {
  id: "dough-v1",
  yieldQuantity: 10,
  yieldUnit: "kg",
  lines: [
    { itemId: "flour", quantity: 6, unit: "kg" },
    { itemId: "sugar", quantity: 1000, unit: "g" },
    { itemId: "eggs", quantity: 20, unit: "each" },
  ],
};
/** Bread: 10 loaves from 5 kg dough (standard 7.50 a batch at dough's 1.50 a kg). */
const breadV1: CostingRecipeVersion = {
  id: "bread-v1",
  yieldQuantity: 10,
  yieldUnit: "each",
  lines: [{ itemId: "dough", quantity: 5, unit: "kg" }],
};

const batch = (id: string, over: Partial<CostingBatch> = {}): CostingBatch => ({
  id,
  batchCode: id.toUpperCase(),
  status: "completed",
  outputItemId: "dough",
  plannedQuantity: 10_000,
  recipeVersionId: "dough-v1",
  ...over,
});
const lot = (id: string, itemId: string, receipts: CostingLot["receipts"] = []): CostingLot => ({
  id,
  itemId,
  lotCode: id.toUpperCase(),
  receipts,
});
const consumed = (batchId: string, lotId: string, itemId: string, quantity: number): CostingFlow => ({
  batchId,
  lotId,
  itemId,
  kind: "consumption",
  quantity,
});
const output = (batchId: string, lotId: string, itemId: string, quantity: number): CostingFlow => ({
  batchId,
  lotId,
  itemId,
  kind: "output",
  quantity,
});

function graph(parts: {
  batches: CostingBatch[];
  lots: CostingLot[];
  flows: CostingFlow[];
  items?: CostingItem[];
}): CostingGraph {
  return {
    items: new Map((parts.items ?? items).map((i) => [i.id, i])),
    lots: new Map(parts.lots.map((l) => [l.id, l])),
    batches: new Map(parts.batches.map((b) => [b.id, b])),
    versions: new Map([doughV1, breadV1].map((v) => [v.id, v])),
    flows: parts.flows,
  };
}

/** Flour bought at 0.90 a kg, eggs at 0.30 each, sugar from opening stock (no price). */
const purchased = [
  lot("f1", "flour", [{ quantity: 25_000, unitPrice: 0.0009, reversed: false }]),
  lot("e1", "eggs", [{ quantity: 180, unitPrice: 0.3, reversed: false }]),
  lot("s1", "sugar"),
];
/** A dough batch: everything to plan except 22 eggs, and 9.5 kg made of the 10 planned. */
const doughFlows = (batchId: string, outLot: string) => [
  consumed(batchId, "f1", "flour", 6000),
  consumed(batchId, "s1", "sugar", 1000),
  consumed(batchId, "e1", "eggs", 22),
  output(batchId, outLot, "dough", 9500),
];

// ─── Unit costs ──────────────────────────────────────────────────────────────

describe("unit costs", () => {
  it("converts standard costs to the base unit and back", () => {
    expect(standardCostPerBase({ unit: "kg", standardCost: 0.8 })).toBeCloseTo(0.0008, 12);
    expect(standardCostPerBase({ unit: "l", standardCost: 2 })).toBeCloseTo(0.002, 12);
    expect(standardCostPerBase({ unit: "each", standardCost: 0.25 })).toBe(0.25);
    expect(standardCostPerBase({ unit: "kg", standardCost: null })).toBeNull();
    expect(costPerItemUnit(0.0009, "kg")).toBeCloseTo(0.9, 12);
  });
});

// ─── Batch cost ──────────────────────────────────────────────────────────────

describe("actual cost per batch", () => {
  const g = graph({
    batches: [batch("d1")],
    lots: [...purchased, lot("dl1", "dough")],
    flows: doughFlows("d1", "dl1"),
  });
  const cost = createCostingEngine(g).batchCost("d1");

  it("values lots at their purchase price, and falls back to standard cost flagged as estimated", () => {
    expect(cost.lines).toEqual([
      expect.objectContaining({
        lotId: "f1",
        source: "purchase",
        quantity: 6000,
        unitCost: 0.9,
        unit: "kg",
        cost: 5.4,
        estimated: false,
        standardUnitCost: 0.8,
        reason: null,
      }),
      expect.objectContaining({
        lotId: "s1",
        source: "standard",
        unitCost: 1.2,
        cost: 1.2,
        estimated: true,
        estimatedPercent: 100,
        reason: "not_purchased",
      }),
      expect.objectContaining({ lotId: "e1", source: "purchase", unitCost: 0.3, unit: "each", cost: 6.6 }),
    ]);
    expect(cost).toMatchObject({
      actualCost: 13.2,
      estimatedCost: 1.2,
      estimatedPercent: 9.1,
      costComplete: true,
      missingItemCodes: [],
      provisional: false,
      planned: 10_000,
      produced: 9500,
      outputUnit: "kg",
      // 13.20 for 9.5 kg.
      costPerUnit: 1.38947368,
    });
  });

  it("reports the yield against plan and its cost effect", () => {
    expect(cost.yield).toEqual({ difference: -500, percent: 95 });
    // 0.5 kg short at the standard 1.10 a kg.
    expect(cost.variance.yield).toBe(0.55);
  });

  it("splits standard against actual into price, usage and yield", () => {
    expect(cost.standard).toEqual({
      costPerUnit: 1.1,
      plannedCost: 11,
      producedCost: 10.45,
      inputsAtStandard: 11.5,
      complete: true,
      missingItemCodes: [],
    });
    expect(cost.variance).toEqual({
      price: 1.7,
      usage: 0.5,
      mix: 0,
      inputQuantity: 0.5,
      yield: 0.55,
      quantity: 1.05,
      total: 2.75,
    });
    expect(cost.variancePercent).toBe(26.3);
    const eggs = cost.materials.find((m) => m.itemId === "eggs")!;
    expect(eggs).toEqual({
      itemId: "eggs",
      inRecipe: true,
      required: 20,
      consumed: 22,
      actualCost: 6.6,
      standardUnitCost: 0.25,
      priceVariance: 1.1,
      usageVariance: 0.5,
      mixVariance: 0,
    });
    const sugar = cost.materials.find((m) => m.itemId === "sugar")!;
    expect(sugar).toMatchObject({ priceVariance: 0, usageVariance: 0 });
  });

  it("uses the purchase price of receipts that weren't reversed, weighted by quantity", () => {
    const e = createCostingEngine(
      graph({
        batches: [],
        lots: [
          lot("x", "flour", [
            { quantity: 1000, unitPrice: 0.001, reversed: false },
            { quantity: 3000, unitPrice: 0.002, reversed: false },
            { quantity: 5000, unitPrice: 0.009, reversed: true },
          ]),
          lot("y", "flour", [{ quantity: 1000, unitPrice: 0.002, reversed: true }]),
          lot("z", "flour", [{ quantity: 1000, unitPrice: null, reversed: false }]),
        ],
        flows: [],
      }),
    );
    expect(e.lotCost("x")).toMatchObject({ source: "purchase", unitCost: 1.75 });
    // Only reversed receipts: their price is still the best there is.
    expect(e.lotCost("y")).toMatchObject({ source: "purchase", unitCost: 2 });
    expect(e.lotCost("z")).toMatchObject({ source: "standard", unitCost: 0.8, reason: "no_purchase_price" });
    expect(e.lotCost("nope")).toBeNull();
  });

  it("prefers the approved invoice price over the receipt's, and says so", () => {
    const e = createCostingEngine(
      graph({
        batches: [],
        lots: [
          // Ordered at 0.80 a kg, invoiced at 0.84.
          lot("inv", "flour", [
            { quantity: 1000, unitPrice: 0.0008, invoicePrice: 0.00084, reversed: false },
          ]),
          // Not yet invoiced (or the invoice is still a draft): the receipt price.
          lot("ord", "flour", [{ quantity: 1000, unitPrice: 0.0008, invoicePrice: null, reversed: false }]),
          // Received without a price, but the invoice has one.
          lot("np", "flour", [{ quantity: 1000, unitPrice: null, invoicePrice: 0.0009, reversed: false }]),
          // Two receipts, one invoiced: a purchase price, weighted.
          lot("mix", "flour", [
            { quantity: 1000, unitPrice: 0.0008, invoicePrice: 0.001, reversed: false },
            { quantity: 1000, unitPrice: 0.0008, reversed: false },
          ]),
        ],
        flows: [],
      }),
    );
    expect(e.lotCost("inv")).toMatchObject({ source: "invoice", unitCost: 0.84, estimated: false });
    expect(e.lotCost("ord")).toMatchObject({ source: "purchase", unitCost: 0.8 });
    expect(e.lotCost("np")).toMatchObject({ source: "invoice", unitCost: 0.9, reason: null });
    expect(e.lotCost("mix")).toMatchObject({ source: "purchase", unitCost: 0.9 });
  });

  it("says why an invoiced lot is at its receipt price when the invoice price couldn't be applied", () => {
    const e = createCostingEngine(
      graph({
        batches: [],
        lots: [
          lot("up", "flour", [
            { quantity: 1000, unitPrice: 0.0008, invoicePrice: null, invoiceUnpriced: true, reversed: false },
          ]),
          // No receipt price either: the standard cost, for the same reason.
          lot("none", "flour", [
            { quantity: 1000, unitPrice: null, invoicePrice: null, invoiceUnpriced: true, reversed: false },
          ]),
        ],
        flows: [],
      }),
    );
    expect(e.lotCost("up")).toMatchObject({ source: "purchase", unitCost: 0.8, reason: "invoice_unpriced" });
    expect(e.lotCost("none")).toMatchObject({ source: "standard", reason: "invoice_unpriced" });
  });
});

describe("multi-stage production", () => {
  const flows = [
    ...doughFlows("d1", "dl1"),
    consumed("b1", "dl1", "dough", 5000),
    output("b1", "bl1", "bread", 10),
  ];
  const bread = batch("b1", { outputItemId: "bread", plannedQuantity: 10, recipeVersionId: "bread-v1" });

  it("values WIP at the cost per unit of the batch that made it", () => {
    const g = graph({ batches: [batch("d1"), bread], lots: [...purchased, lot("dl1", "dough")], flows });
    const engine = createCostingEngine(g);
    expect(engine.lotCost("dl1")).toMatchObject({
      source: "batch",
      batchId: "d1",
      unitCost: 1.38947368,
      estimated: true,
      estimatedPercent: 9.1,
      provisional: false,
    });
    const cost = engine.batchCost("b1");
    // 5 kg of dough at 13.20 / 9.5 kg.
    expect(cost.actualCost).toBe(6.9474);
    expect(cost.estimatedCost).toBe(0.6316);
    expect(cost.estimatedPercent).toBe(9.1);
    expect(cost.costPerUnit).toBe(0.69473684);
    expect(cost.lines[0]).toMatchObject({ source: "batch", batchId: "d1", standardUnitCost: 1.5 });
    // The dough's own standard (1.50 a kg) is the standard price of the WIP input.
    expect(cost.standard).toMatchObject({ plannedCost: 7.5, producedCost: 7.5, costPerUnit: 0.75 });
    expect(cost.variance).toMatchObject({ price: -0.5526, usage: 0, yield: 0, total: -0.5526 });
    expect(cost.provisional).toBe(false);
  });

  it("is provisional while an upstream batch is still in progress", () => {
    const g = graph({
      batches: [batch("d1", { status: "in_progress" }), bread],
      lots: [...purchased, lot("dl1", "dough")],
      flows,
    });
    const engine = createCostingEngine(g);
    expect(engine.lotCost("dl1")!.provisional).toBe(true);
    expect(engine.batchCost("b1").provisional).toBe(true);
  });

  it("falls back to standard cost beyond the stages loaded, or without output", () => {
    const tooDeep = createCostingEngine(graph({ batches: [bread], lots: [lot("dl1", "dough")], flows }));
    expect(tooDeep.batchCost("b1").lines[0]).toMatchObject({
      source: "standard",
      reason: "too_deep",
      unitCost: 1.5,
      estimated: true,
    });
    const noOutput = createCostingEngine(
      graph({
        batches: [batch("d1"), bread],
        lots: [...purchased, lot("dl1", "dough")],
        flows: flows
          .filter((f) => !(f.kind === "output" && f.batchId === "d1"))
          .concat(
            // A reversed output nets to zero: the dough lot has no producer left.
            output("d1", "dl1", "dough", 0),
          ),
      }),
    );
    expect(noOutput.batchCost("b1").lines[0]).toMatchObject({ source: "standard", reason: "not_purchased" });
  });

  it("guards against cycles", () => {
    // X makes dough from bread; Y makes bread from X's dough; X then used Y's bread.
    const g = graph({
      batches: [
        batch("x", { outputItemId: "dough", recipeVersionId: "none" }),
        batch("y", { outputItemId: "bread", plannedQuantity: 10, recipeVersionId: "bread-v1" }),
      ],
      lots: [lot("xl", "dough"), lot("yl", "bread")],
      flows: [
        output("x", "xl", "dough", 1000),
        consumed("y", "xl", "dough", 500),
        output("y", "yl", "bread", 10),
        consumed("x", "yl", "bread", 2),
      ],
    });
    const engine = createCostingEngine(g);
    // X and Y are in a loop, so what each takes from the other is cut to standard cost (cycle).
    const x = engine.batchCost("x");
    // Bread has no standard cost: X's cost is incomplete rather than guessed.
    expect(x.lines[0]).toMatchObject({ lotId: "yl", source: "missing", reason: "cycle", batchId: null });
    expect(x.missingItemCodes).toEqual(["BREAD"]);
    // No recipe version: no standard side.
    expect(x.standard.complete).toBe(false);
    expect(x.variance.total).toBeNull();
    // Y: 500 g of X's dough at the dough's standard, 1.50 a kg.
    const y = engine.batchCost("y");
    expect(y.lines[0]).toMatchObject({ lotId: "xl", source: "standard", reason: "cycle" });
    expect(y.actualCost).toBe(0.75);
    expect(y).toEqual(createCostingEngine(g).batchCost("y"));
  });
});

describe("depth limit and cycles", () => {
  /**
   * A starter kept going: batch `s<k>` makes lot `sl<k>` (1 kg) from 500 g flour (0.45) and
   * 500 g of the last starter. The starter has no standard cost, so a lot of it made beyond the
   * depth limit leaves the cost incomplete. `from`: the first batch loaded.
   */
  function starter(n: number, from = 0) {
    const flows: CostingFlow[] = [];
    for (let k = 0; k < n; k++) {
      flows.push(consumed(`s${k}`, "f1", "flour", 500));
      if (k > 0) flows.push(consumed(`s${k}`, `sl${k - 1}`, "starter", 500));
      flows.push(output(`s${k}`, `sl${k}`, "starter", 1000));
    }
    const stages = Array.from({ length: n }, (_, k) => k);
    return graph({
      items: [...items, item("starter", "kg", null)],
      batches: stages
        .filter((k) => k >= from)
        .map((k) => batch(`s${k}`, { outputItemId: "starter", plannedQuantity: 1000 })),
      lots: [...purchased, ...stages.map((k) => lot(`sl${k}`, "starter"))],
      flows,
    });
  }

  it(`follows lots back ${COSTING_MAX_DEPTH} stages, then falls back to standard cost (too_deep)`, () => {
    // Just within the limit: the oldest batch is reached, all at prices paid.
    const within = createCostingEngine(starter(COSTING_MAX_DEPTH + 1)).batchCost(`s${COSTING_MAX_DEPTH}`);
    expect(within).toMatchObject({ costComplete: true, missingItemCodes: [] });
    // One stage more: the last batch reached can't value its starter.
    const n = COSTING_MAX_DEPTH + 5;
    const cost = createCostingEngine(starter(n)).batchCost(`s${n - 1}`);
    expect(cost).toMatchObject({ costComplete: false, missingItemCodes: ["STARTER"] });
    // 0.45 a stage, halved each stage back: close to 0.90.
    expect(cost.actualCost).toBeCloseTo(0.9, 4);
    // The same as when the batches beyond the limit aren't loaded at all (`too_deep` too).
    expect(cost).toEqual(createCostingEngine(starter(n, n - 1 - COSTING_MAX_DEPTH)).batchCost(`s${n - 1}`));
    // A lot follows as many batch stages as a batch's lines do.
    const lot = createCostingEngine(starter(COSTING_MAX_DEPTH + 1)).lotCost(`sl${COSTING_MAX_DEPTH - 1}`);
    expect(lot).toMatchObject({ source: "batch", complete: true });
    const cut = createCostingEngine(starter(COSTING_MAX_DEPTH + 2)).lotCost(`sl${COSTING_MAX_DEPTH}`);
    expect(cut).toMatchObject({ source: "batch", complete: false, missingItemCodes: ["STARTER"] });
  });

  it("costs a chain of thousands of batches, the same alone as in a report", () => {
    const n = 3000;
    const g = starter(n);
    const newest = `s${n - 1}`;
    const alone = createCostingEngine(g).batchCost(newest);
    expect(alone).toMatchObject({ costComplete: false, missingItemCodes: ["STARTER"] });
    expect(alone).toEqual(createCostingEngine(starter(n, n - 1 - COSTING_MAX_DEPTH)).batchCost(newest));
    // A report costs every batch: oldest first leaves the newest's whole history memoised.
    const report = createCostingEngine(g);
    const all = Array.from({ length: n }, (_, k) => report.batchCost(`s${k}`));
    expect(all.at(-1)).toEqual(alone);
    const middle = COSTING_MAX_DEPTH + 10;
    expect(all[middle]).toEqual(createCostingEngine(g).batchCost(`s${middle}`));
    // And newest first, then back again.
    const reversed = createCostingEngine(g);
    for (let k = n - 1; k >= n - 50; k--) reversed.batchCost(`s${k}`);
    expect(reversed.batchCost(newest)).toEqual(alone);
    expect(reversed.lotCost(`sl${n - 2}`)).toEqual(createCostingEngine(g).lotCost(`sl${n - 2}`));
  });

  it("values a cycle the same whatever was costed first", () => {
    // A uses B's dough and B uses A's: each, costed on its own, meets itself one stage back.
    const g = graph({
      batches: [batch("a", { plannedQuantity: 1000 }), batch("b", { plannedQuantity: 1000 })],
      lots: [...purchased, lot("la", "dough"), lot("lb", "dough")],
      flows: [
        consumed("a", "f1", "flour", 1000),
        consumed("a", "lb", "dough", 100),
        output("a", "la", "dough", 1000),
        consumed("b", "f1", "flour", 1000),
        consumed("b", "la", "dough", 100),
        output("b", "lb", "dough", 1000),
      ],
    });
    const alone = (id: string) => createCostingEngine(g).batchCost(id);
    // A and B are in a loop: each takes the other's dough at standard (cycle), 0.90 flour + 0.15.
    expect(alone("a").actualCost).toBe(1.05);
    expect(alone("b").actualCost).toBe(1.05);
    expect(alone("a").lines[1]).toMatchObject({ lotId: "lb", source: "standard", reason: "cycle" });
    // A lot costed on its own (not by a batch in the loop) follows its batch, which cuts the loop.
    expect(createCostingEngine(g).lotCost("la")).toMatchObject({ source: "batch", batchId: "a" });
    for (const order of [
      ["a", "b"],
      ["b", "a"],
    ]) {
      const engine = createCostingEngine(g);
      for (const id of order) expect(engine.batchCost(id)).toEqual(alone(id));
      expect(engine.lotCost("la")).toEqual(createCostingEngine(g).lotCost("la"));
      for (const id of order) expect(engine.batchCost(id)).toEqual(alone(id));
    }
  });

  it("costs every batch and lot the same in any order, on graphs with loops and long chains", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = (n: number) => Math.floor(random() * n);
    for (let round = 0; round < 40; round++) {
      // Mostly a chain (longer than the depth limit), with random links back and forth.
      const n = 20 + pick(25);
      const flows: CostingFlow[] = [];
      for (let i = 0; i < n; i++) {
        flows.push(consumed(`b${i}`, "f1", "flour", 100 + pick(900)));
        if (i > 0) flows.push(consumed(`b${i}`, `l${i - 1}`, "dough", 50 + pick(100)));
        if (random() < 0.35) flows.push(consumed(`b${i}`, `l${pick(n)}`, "dough", 10 + pick(50)));
        // Some lots have two producers.
        flows.push(output(`b${i}`, `l${random() < 0.15 ? pick(n) : i}`, "dough", 500 + pick(1000)));
      }
      const ids = Array.from({ length: n }, (_, i) => i);
      const g = graph({
        batches: ids.map((i) => batch(`b${i}`, { status: random() < 0.1 ? "in_progress" : "completed" })),
        lots: [...purchased, ...ids.map((i) => lot(`l${i}`, "dough"))],
        flows: [...new Map(flows.map((f) => [`${f.batchId}|${f.lotId}|${f.kind}`, f])).values()],
      });
      const targets = [...ids.map((i) => `b${i}`), ...ids.map((i) => `l${i}`)];
      const order = [...targets, ...targets].sort(() => random() - 0.5);
      const shared = createCostingEngine(g);
      const costOf = (engine: ReturnType<typeof createCostingEngine>, id: string) =>
        id.startsWith("b") ? engine.batchCost(id) : engine.lotCost(id);
      for (const id of order) expect(costOf(shared, id)).toEqual(costOf(createCostingEngine(g), id));
    }
  });

  it("values a lot fed back into itself at standard, whichever feed is costed", () => {
    // One starter lot, fed every day from itself: every feed is in a cycle with every other.
    const days = 40;
    const flows = Array.from({ length: days }, (_, k) => [
      consumed(`feed${k}`, "f1", "flour", 100),
      consumed(`feed${k}`, "pot", "dough", 100),
      output(`feed${k}`, "pot", "dough", 200),
    ]).flat();
    const g = graph({
      batches: Array.from({ length: days }, (_, k) => batch(`feed${k}`, { plannedQuantity: 200 })),
      lots: [...purchased, lot("pot", "dough")],
      flows,
    });
    const engine = createCostingEngine(g);
    for (let k = 0; k < days; k++) {
      const cost = engine.batchCost(`feed${k}`);
      expect(cost.lines[1]).toMatchObject({ lotId: "pot", reason: "cycle", unitCost: 1.5 });
      expect(cost.actualCost).toBe(0.24);
    }
    // The lot itself: each feed's cost per unit, weighted.
    expect(engine.lotCost("pot")).toMatchObject({ source: "batch", unitCost: 1.2 });
  });
});

describe("missing data", () => {
  it("leaves out a lot with neither price nor standard cost, and says so", () => {
    const g = graph({
      batches: [batch("d1")],
      lots: [...purchased, lot("salt1", "salt"), lot("dl1", "dough")],
      flows: [...doughFlows("d1", "dl1"), consumed("d1", "salt1", "salt", 50)],
    });
    const cost = createCostingEngine(g).batchCost("d1");
    expect(cost.lines.at(-1)).toMatchObject({
      source: "missing",
      unitCost: null,
      cost: null,
      complete: false,
    });
    expect(cost).toMatchObject({ actualCost: 13.2, costComplete: false, missingItemCodes: ["SALT"] });
    expect(cost.standard.complete).toBe(false);
    expect(cost.standard.missingItemCodes).toEqual(["SALT"]);
    expect(cost.variance).toEqual({
      price: null,
      usage: null,
      mix: null,
      inputQuantity: null,
      yield: 0.55,
      quantity: null,
      total: null,
    });
    expect(cost.materials.find((m) => m.itemId === "salt")).toMatchObject({
      inRecipe: false,
      required: 0,
      consumed: 50,
      actualCost: null,
    });
  });

  it("propagates a missing cost through the batch that made a lot", () => {
    const g = graph({
      batches: [
        batch("d1"),
        batch("b1", { outputItemId: "bread", plannedQuantity: 10, recipeVersionId: "bread-v1" }),
      ],
      lots: [...purchased, lot("salt1", "salt"), lot("dl1", "dough")],
      flows: [
        ...doughFlows("d1", "dl1"),
        consumed("d1", "salt1", "salt", 50),
        consumed("b1", "dl1", "dough", 5000),
        output("b1", "bl1", "bread", 10),
      ],
    });
    const cost = createCostingEngine(g).batchCost("b1");
    expect(cost.lines[0]).toMatchObject({ source: "batch", complete: false, missingItemCodes: ["SALT"] });
    expect(cost.costComplete).toBe(false);
  });

  it("has no cost per unit or yield cost before output, and no standard without a version", () => {
    const g = graph({
      batches: [batch("d1", { status: "in_progress" }), batch("d2", { recipeVersionId: "gone" })],
      lots: purchased,
      flows: [consumed("d1", "f1", "flour", 6000), consumed("d2", "f1", "flour", 100)],
    });
    const engine = createCostingEngine(g);
    const running = engine.batchCost("d1");
    expect(running).toMatchObject({ produced: 0, costPerUnit: null, provisional: true, actualCost: 5.4 });
    expect(running.yield).toEqual({ difference: -10_000, percent: 0 });
    // Nothing made: the whole planned standard is a yield shortfall, and the actual cost is adverse.
    expect(running.variance).toMatchObject({ yield: 11, total: 5.4 });
    const versionless = engine.batchCost("d2");
    expect(versionless.standard).toMatchObject({ complete: false, plannedCost: null, costPerUnit: null });
    expect(versionless.materials).toEqual([
      expect.objectContaining({ itemId: "flour", inRecipe: false, required: null, usageVariance: null }),
    ]);
  });

  it("treats a cancelled batch's figures as final, not provisional", () => {
    const g = graph({
      batches: [batch("c1", { status: "cancelled" })],
      lots: purchased,
      flows: [consumed("c1", "f1", "flour", 1000)],
    });
    expect(createCostingEngine(g).batchCost("c1")).toMatchObject({ provisional: false, actualCost: 0.9 });
  });

  it("refuses to cost a batch that isn't in the graph", () => {
    expect(() => createCostingEngine(graph({ batches: [], lots: [], flows: [] })).batchCost("x")).toThrow();
  });
});

// ─── Periods and the report ──────────────────────────────────────────────────

describe("periods", () => {
  it("finds the start, end and label of weeks and months", () => {
    expect(costingPeriodStart("2026-11-12", "week")).toBe("2026-11-09");
    expect(costingPeriodEnd("2026-11-12", "week")).toBe("2026-11-15");
    expect(costingPeriodLabel("2026-11-09", "week")).toBe("2026-W46");
    expect(costingPeriodStart("2026-11-12", "month")).toBe("2026-11-01");
    expect(costingPeriodEnd("2026-12-12", "month")).toBe("2026-12-31");
    expect(costingPeriodEnd("2028-02-03", "month")).toBe("2028-02-29");
    expect(costingPeriodLabel("2026-11-01", "month")).toBe("2026-11");
    expect(costingPeriodsInRange("2026-10-15", "2026-12-31", "month")).toEqual([
      "2026-10-01",
      "2026-11-01",
      "2026-12-01",
    ]);
    expect(costingPeriodsInRange("2026-11-12", "2026-11-22", "week")).toEqual(["2026-11-09", "2026-11-16"]);
  });

  it("reads dates, weeks and months as bounds", () => {
    expect(parseCostingBound("2026-11-12", "start")).toBe("2026-11-12");
    expect(parseCostingBound("2026-W46", "start")).toBe("2026-11-09");
    expect(parseCostingBound("2026w46", "end")).toBe("2026-11-15");
    expect(parseCostingBound("2026-02", "end")).toBe("2026-02-28");
    expect(parseCostingBound("2026-13", "start")).toBeNull();
    expect(parseCostingBound("2026-02-30", "start")).toBeNull();
    expect(parseCostingBound("last week", "start")).toBeNull();
  });

  it("works out the report window", () => {
    expect(costingReportRange({ period: "month" }, "2026-11-12")).toEqual({
      from: "2026-06-01",
      to: "2026-11-30",
      error: null,
    });
    expect(costingReportRange({ period: "week" }, "2026-11-12")).toEqual({
      from: "2026-08-17",
      to: "2026-11-15",
      error: null,
    });
    expect(costingReportRange({ period: "week", from: "2026-11-01", to: "2026-W46" }, "x")).toEqual({
      from: "2026-10-26",
      to: "2026-11-15",
      error: null,
    });
    expect(costingReportRange({ period: "month", from: "2026-11", to: "2026-10" }, "x").error).toBe(
      "`to` is before `from`",
    );
    expect(costingReportRange({ period: "month", from: "2024-01", to: "2026-12" }, "x").error).toBe(
      "At most two years at a time",
    );
    expect(costingReportRange({ period: "month", from: "soon" }, "2026-11-12").error).toMatch(/not a date/);
  });

  it("validates the queries", () => {
    expect(costingReportQuerySchema.parse({})).toEqual({ period: "month" });
    expect(costingReportQuerySchema.safeParse({ period: "year" }).success).toBe(false);
    expect(costingBatchListQuerySchema.parse({})).toMatchObject({
      status: "completed",
      limit: 25,
      offset: 0,
    });
    expect(costingBatchListQuerySchema.safeParse({ status: "planned" }).success).toBe(false);
    expect(costingBatchListQuerySchema.safeParse({ from: "2026-11-02", to: "2026-11-01" }).success).toBe(
      false,
    );
  });
});

describe("standard against actual by product and period", () => {
  const g = graph({
    batches: [
      batch("d1"),
      batch("d2"),
      batch("d3"),
      batch("b1", { outputItemId: "bread", plannedQuantity: 10, recipeVersionId: "bread-v1" }),
    ],
    lots: [...purchased, lot("salt1", "salt"), lot("dl1", "dough"), lot("dl2", "dough"), lot("dl3", "dough")],
    flows: [
      ...doughFlows("d1", "dl1"),
      ...doughFlows("d2", "dl2"),
      // d3 used salt that has no cost: incomplete.
      ...doughFlows("d3", "dl3"),
      consumed("d3", "salt1", "salt", 10),
      consumed("b1", "dl1", "dough", 5000),
      output("b1", "bl1", "bread", 10),
    ],
  });
  const engine = createCostingEngine(g);
  const entry = (id: string, outputItemId: string, completedOn: string) => ({
    outputItemId,
    completedOn,
    cost: engine.batchCost(id),
  });
  const report = costingReport({
    period: "month",
    from: "2026-10-01",
    to: "2026-11-30",
    batches: [
      entry("d1", "dough", "2026-10-20"),
      entry("d2", "dough", "2026-11-03"),
      entry("d3", "dough", "2026-11-04"),
      entry("b1", "bread", "2026-11-05"),
      // Outside the window: left out.
      entry("d1", "dough", "2026-12-01"),
    ],
    itemUnits: new Map([
      ["dough", "kg"],
      ["bread", "each"],
    ]),
    itemOrder: ["bread", "dough"],
  });

  it("groups by product then period, with yield and per-unit costs", () => {
    expect(report.rows.map((r) => [r.itemId, r.period, r.batches])).toEqual([
      ["bread", "2026-11", 1],
      ["dough", "2026-10", 1],
      ["dough", "2026-11", 2],
    ]);
    const october = report.rows[1]!;
    expect(october).toMatchObject({
      planned: 10_000,
      produced: 9500,
      yieldPercent: 95,
      actualCost: 13.2,
      standardCost: 10.45,
      costPerUnit: 1.38947368,
      standardCostPerUnit: 1.1,
      incompleteBatches: 0,
      variance: { price: 1.7, usage: 0.5, yield: 0.55, quantity: 1.05, total: 2.75 },
      variancePercent: 26.3,
    });
  });

  it("leaves incomplete batches out of the standard and the variances, and counts them", () => {
    const november = report.rows[2]!;
    expect(november).toMatchObject({
      batches: 2,
      incompleteBatches: 1,
      // Both batches' actual cost (the salt line has none)...
      actualCost: 26.4,
      produced: 19_000,
      // ...but only d2 is compared.
      comparedActualCost: 13.2,
      standardCost: 10.45,
      standardCostPerUnit: 1.1,
      variance: { total: 2.75 },
    });
    // A product whose batches are all incomplete has no standard.
    const onlyIncomplete = costingReport({
      period: "week",
      from: "2026-11-02",
      to: "2026-11-08",
      batches: [entry("d3", "dough", "2026-11-04")],
      itemUnits: new Map([["dough", "kg"]]),
    });
    expect(onlyIncomplete.rows[0]).toMatchObject({
      period: "2026-W45",
      standardCost: null,
      comparedActualCost: null,
      variance: { total: null, price: null },
      variancePercent: null,
    });
  });

  it("totals by period and overall, including periods without batches", () => {
    expect(report.periods.map((p) => [p.period, p.totals.batches])).toEqual([
      ["2026-10", 1],
      ["2026-11", 3],
    ]);
    expect(report.totals).toMatchObject({ batches: 4, incompleteBatches: 1, actualCost: 46.5474 });
    const variance = (c: BatchCost) => c.variance.total!;
    expect(report.totals.variance.total).toBe(
      Math.round((variance(engine.batchCost("d1")) * 2 + variance(engine.batchCost("b1"))) * 1e4) / 1e4,
    );
    expect(
      costingReport({
        period: "week",
        from: "2026-11-09",
        to: "2026-11-22",
        batches: [],
        itemUnits: new Map(),
      }).periods,
    ).toEqual([
      expect.objectContaining({
        period: "2026-W46",
        totals: expect.objectContaining({ batches: 0, standardCost: null }),
      }),
      expect.objectContaining({ period: "2026-W47" }),
    ]);
  });
});
