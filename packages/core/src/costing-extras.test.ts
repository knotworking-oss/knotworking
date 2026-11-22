import { describe, expect, it } from "vitest";
import {
  combineTotals,
  costingReport,
  createCostingEngine,
  mixVariances,
  standardCostOn,
  type CostingBatch,
  type CostingGraph,
  type CostingItem,
  type CostingRecipeVersion,
} from "./costing";
import {
  absorbConversion,
  absorptionRateOn,
  absorptionRateSetSchema,
  batchRunHours,
  outputKilograms,
  type AbsorptionRateEntry,
} from "./costing-conversion";
import {
  applyFrozenPeriods,
  costingDrift,
  costingPeriodOf,
  type CostingCloseSnapshot,
} from "./costing-close";
import { adjustmentCosts, stockValuation } from "./costing-valuation";
import { batchesCsv, journalCsv, valuationCsv } from "./costing-export";
import { currencySchema, effectiveCurrency, formatMoney } from "./currency";
import { formatUkDate, formatUkDateTime, formatUkDayMonth, formatUkTime } from "./format-date";

const item = (id: string, unit: CostingItem["unit"], standardCost: number | null): CostingItem => ({
  id,
  code: id.toUpperCase(),
  name: id,
  unit,
  standardCost,
});

describe("standard cost history", () => {
  const history = [
    { effectiveFrom: "2026-01-01", cost: 1 },
    { effectiveFrom: "2026-06-01", cost: 2 },
    { effectiveFrom: "2026-09-01", cost: null },
  ];
  it("uses the entry in force on the date", () => {
    const now = { standardCost: 9 };
    expect(standardCostOn(now, history, "2026-03-15")).toBe(1);
    expect(standardCostOn(now, history, "2026-06-01")).toBe(2);
    expect(standardCostOn(now, history, "2026-10-01")).toBeNull();
  });
  it("uses the first entry before it began, and the current cost without history or date", () => {
    expect(standardCostOn({ standardCost: 9 }, history, "2025-01-01")).toBe(1);
    expect(standardCostOn({ standardCost: 9 }, undefined, "2026-03-15")).toBe(9);
    expect(standardCostOn({ standardCost: 9 }, history, null)).toBe(9);
  });

  const version: CostingRecipeVersion = {
    id: "v",
    yieldQuantity: 10,
    yieldUnit: "kg",
    lines: [
      { itemId: "flour", quantity: 6, unit: "kg" },
      { itemId: "sugar", quantity: 4, unit: "kg" },
    ],
  };
  const graph = (batchDate: string | null, withHistory: boolean): CostingGraph => ({
    items: new Map(
      [item("flour", "kg", 1), item("sugar", "kg", 2), item("dough", "kg", null)].map((i) => [i.id, i]),
    ),
    lots: new Map([
      ["l1", { id: "l1", itemId: "flour", lotCode: "L1", receivedOn: "2026-02-01", receipts: [] }],
      ["l2", { id: "l2", itemId: "sugar", lotCode: "L2", receivedOn: "2026-02-01", receipts: [] }],
    ]),
    batches: new Map<string, CostingBatch>([
      [
        "b",
        {
          id: "b",
          batchCode: "B",
          status: "completed",
          outputItemId: "dough",
          plannedQuantity: 10_000,
          recipeVersionId: "v",
          costingDate: batchDate,
        },
      ],
    ]),
    versions: new Map([["v", version]]),
    flows: [
      { batchId: "b", lotId: "l1", itemId: "flour", kind: "consumption", quantity: 6000 },
      { batchId: "b", lotId: "l2", itemId: "sugar", kind: "consumption", quantity: 4000 },
      { batchId: "b", lotId: "l1", itemId: "dough", kind: "output", quantity: 10_000 },
    ],
    ...(withHistory
      ? {
          standardCosts: new Map([
            [
              "flour",
              [
                { effectiveFrom: "2026-01-01", cost: 0.5 },
                { effectiveFrom: "2026-06-01", cost: 1 },
              ],
            ],
            [
              "sugar",
              [
                { effectiveFrom: "2026-01-01", cost: 1 },
                { effectiveFrom: "2026-06-01", cost: 2 },
              ],
            ],
          ]),
        }
      : {}),
  });

  it("prices the standard side, and unpriced lots, at the cost in force then", () => {
    const early = createCostingEngine(graph("2026-03-01", true)).batchCost("b");
    // Lots came in on 2026-02-01 with no price: estimated at 0.5/kg and 1/kg then.
    expect(early.actualCost).toBeCloseTo(6 * 0.5 + 4 * 1, 6);
    expect(early.standard.inputsAtStandard).toBeCloseTo(7, 6);
    expect(early.variance.price).toBe(0);
    const late = createCostingEngine(graph("2026-07-01", true)).batchCost("b");
    // The standard side moved to today's prices, the lots (received earlier) stay estimated at theirs.
    expect(late.actualCost).toBeCloseTo(7, 6);
    expect(late.standard.inputsAtStandard).toBeCloseTo(6 + 8, 6);
    expect(late.variance.price).toBeCloseTo(-7, 6);
  });

  it("uses current costs without history", () => {
    const cost = createCostingEngine(graph("2026-03-01", false)).batchCost("b");
    expect(cost.standard.inputsAtStandard).toBeCloseTo(14, 6);
  });
});

describe("mix variance", () => {
  const input = (itemId: string, required: number | null, consumed: number, standard: number | null) => ({
    itemId,
    dimension: "mass" as const,
    required,
    consumed,
    standard,
  });
  it("is nil when the plan's proportions are kept, however much is used", () => {
    const mix = mixVariances([input("a", 600, 660, 0.001), input("b", 400, 440, 0.005)])!;
    expect(mix.get("a")).toBeCloseTo(0, 9);
    expect(mix.get("b")).toBeCloseTo(0, 9);
  });
  it("is adverse for more of the dearer ingredient, and adds to nothing across the batch", () => {
    // Plan 600 g @0.001 + 400 g @0.005; used 500 g + 500 g (same total).
    const mix = mixVariances([input("a", 600, 500, 0.001), input("b", 400, 500, 0.005)])!;
    expect(mix.get("a")).toBeCloseTo(-0.1, 9);
    expect(mix.get("b")).toBeCloseTo(0.5, 9);
    expect([...mix.values()].reduce((t, v) => t + v, 0)).toBeCloseTo(0.4, 9);
  });
  it("counts an unplanned ingredient wholly as mix, and is null when a figure is missing", () => {
    const mix = mixVariances([input("a", 1000, 900, 0.001), input("x", 0, 100, 0.002)])!;
    expect(mix.get("x")).toBeCloseTo(0.2, 9);
    expect(mixVariances([input("a", 1000, 900, null)])).toBeNull();
    expect(mixVariances([input("a", null, 900, 0.001)])).toBeNull();
  });
  it("is part of the usage variance on a batch (usage = mix + input quantity)", () => {
    const g: CostingGraph = {
      items: new Map([item("a", "kg", 1), item("b", "kg", 5), item("o", "kg", null)].map((i) => [i.id, i])),
      lots: new Map([
        ["la", { id: "la", itemId: "a", lotCode: "LA", receipts: [] }],
        ["lb", { id: "lb", itemId: "b", lotCode: "LB", receipts: [] }],
      ]),
      batches: new Map([
        [
          "x",
          {
            id: "x",
            batchCode: "X",
            status: "completed" as const,
            outputItemId: "o",
            plannedQuantity: 10_000,
            recipeVersionId: "v",
          },
        ],
      ]),
      versions: new Map([
        [
          "v",
          {
            id: "v",
            yieldQuantity: 10,
            yieldUnit: "kg" as const,
            lines: [
              { itemId: "a", quantity: 6, unit: "kg" as const },
              { itemId: "b", quantity: 4, unit: "kg" as const },
            ],
          },
        ],
      ]),
      flows: [
        { batchId: "x", lotId: "la", itemId: "a", kind: "consumption", quantity: 5000 },
        { batchId: "x", lotId: "lb", itemId: "b", kind: "consumption", quantity: 6000 },
        { batchId: "x", lotId: "la", itemId: "o", kind: "output", quantity: 10_000 },
      ],
    };
    const { variance, materials } = createCostingEngine(g).batchCost("x");
    // Used 11 kg against 10: mix = (5 − 6.6)×1 + (6 − 4.4)×5 = 6.4; usage = (−1)×1 + 2×5 = 9.
    expect(variance.usage).toBe(9);
    expect(variance.mix).toBe(6.4);
    expect(variance.inputQuantity).toBe(2.6);
    expect(materials.map((m) => m.mixVariance)).toEqual([-1.6, 8]);
  });
});

describe("absorbed labour and overhead", () => {
  const entries: AbsorptionRateEntry[] = [
    {
      lineId: null,
      effectiveFrom: "2026-01-01",
      labourPerHour: 10,
      labourPerKg: 0,
      overheadPerHour: 5,
      overheadPerKg: 0,
    },
    {
      lineId: "l1",
      effectiveFrom: "2026-03-01",
      labourPerHour: 12,
      labourPerKg: 0.1,
      overheadPerHour: 0,
      overheadPerKg: 0,
    },
    {
      lineId: "l1",
      effectiveFrom: "2026-06-01",
      labourPerHour: 14,
      labourPerKg: 0.1,
      overheadPerHour: 0,
      overheadPerKg: 0,
    },
  ];
  it("picks the line's rates in force on the date, else the default's", () => {
    expect(absorptionRateOn(entries, "l1", "2026-05-31")?.labourPerHour).toBe(12);
    expect(absorptionRateOn(entries, "l1", "2026-06-01")?.labourPerHour).toBe(14);
    expect(absorptionRateOn(entries, "l1", "2026-02-01")?.labourPerHour).toBe(10);
    expect(absorptionRateOn(entries, "l2", "2026-07-01")?.labourPerHour).toBe(10);
    expect(absorptionRateOn(entries, null, "2025-12-31")).toBeNull();
  });
  it("charges per hour and per kilogram, labour apart from overhead", () => {
    const c = absorbConversion({ hours: 2.5, kg: 100, rate: { ...entries[1]! } });
    expect(c).toMatchObject({ rated: true, labour: 40, overhead: 0, total: 40, complete: true });
    const d = absorbConversion({ hours: 2, kg: 50, rate: entries[0]! });
    expect(d).toMatchObject({ labour: 20, overhead: 10, total: 30 });
  });
  it("says what is missing rather than inventing hours", () => {
    const c = absorbConversion({ hours: null, kg: 100, rate: entries[1]! });
    expect(c).toMatchObject({ labour: 10, complete: false, missing: ["hours"] });
    expect(absorbConversion({ hours: 1, kg: 1, rate: null })).toMatchObject({ rated: false, total: 0 });
  });
  it("measures hours and kilograms", () => {
    expect(batchRunHours("2026-11-01T08:00:00Z", "2026-11-01T10:30:00Z")).toBe(2.5);
    expect(batchRunHours(null, "2026-11-01T10:30:00Z")).toBeNull();
    expect(batchRunHours("2026-11-02T08:00:00Z", "2026-11-01T10:30:00Z")).toBeNull();
    expect(outputKilograms(2500, { unit: "kg" })).toBe(2.5);
    expect(outputKilograms(10, { unit: "each" })).toBeNull();
    expect(outputKilograms(10, { unit: "each", unitWeightG: 100 })).toBe(1);
  });
  it("validates a rate", () => {
    expect(
      absorptionRateSetSchema.safeParse({ effectiveFrom: "2026-01-01", labourPerHour: -1 }).success,
    ).toBe(false);
    expect(absorptionRateSetSchema.parse({ effectiveFrom: "2026-01-01" }).lineId).toBeNull();
  });
});

describe("stock valuation", () => {
  const lot = (lotId: string, itemId: string, quantity: number, unitCost: number | null, estimated = 0) => ({
    lotId,
    lotCode: lotId,
    itemId,
    status: "available" as const,
    receivedOn: "2026-01-01",
    expiresOn: null,
    quantity,
    cost: {
      unitCost,
      source: unitCost === null ? "missing" : "purchase",
      estimatedPercent: estimated,
      provisional: false,
    },
  });
  it("values each lot at its cost per unit and rolls up per item", () => {
    const v = stockValuation({
      lots: [lot("a", "flour", 25_000, 0.9), lot("b", "flour", 5000, 1, 100), lot("c", "salt", 1000, null)],
      units: new Map([
        ["flour", "kg"],
        ["salt", "kg"],
      ]),
    });
    expect(v.lots.map((l) => l.value)).toEqual([22.5, 5, null]);
    expect(v.items.find((i) => i.itemId === "flour")).toMatchObject({
      value: 27.5,
      estimatedValue: 5,
      lots: 2,
    });
    expect(v.items.find((i) => i.itemId === "salt")).toMatchObject({
      unvaluedLots: 1,
      unvaluedQuantity: 1000,
    });
    expect(v.totals).toMatchObject({ value: 27.5, unvaluedLots: 1, estimatedValue: 5 });
    expect(v.totals.byStatus.available).toBe(27.5);
  });
});

describe("cost of waste and adjustments", () => {
  it("values movements at lot cost, losses positive, and flags lots with no cost", () => {
    const { lines, totals } = adjustmentCosts({
      units: new Map([["flour", "kg" as const]]),
      movements: [
        { type: "waste", itemId: "flour", quantity: -2000, unitCost: 0.9 },
        { type: "waste", itemId: "flour", quantity: 2000, unitCost: 0.9 }, // a reversal
        { type: "waste", itemId: "flour", quantity: -1000, unitCost: 0.9 },
        { type: "adjustment", itemId: "flour", quantity: 500, unitCost: 0.9 },
        { type: "stocktake", itemId: "flour", quantity: -3000, unitCost: null },
      ],
    });
    expect(totals).toMatchObject({
      waste: 0.9,
      adjustment: -0.45,
      stocktake: 0,
      total: 0.45,
      incomplete: true,
    });
    expect(lines.find((l) => l.type === "stocktake")).toMatchObject({ unvaluedQuantity: -3000, loss: 0 });
    expect(lines.find((l) => l.type === "waste")).toMatchObject({ quantity: -1000, movements: 3 });
  });
});

describe("closing a period", () => {
  it("reads the period a date, week or month falls in", () => {
    expect(costingPeriodOf("month", "2026-11-14")).toMatchObject({
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      label: "2026-11",
    });
    expect(costingPeriodOf("week", "2026-W46")).toMatchObject({
      periodStart: "2026-11-09",
      periodEnd: "2026-11-15",
    });
    expect(costingPeriodOf("month", "nonsense")).toBeNull();
  });

  const totals = (actual: number, variance: number) =>
    costingReport({
      period: "month",
      from: "2026-10-01",
      to: "2026-10-31",
      itemUnits: new Map(),
      batches: [],
    }).totals && {
      ...costingReport({
        period: "month",
        from: "2026-10-01",
        to: "2026-10-31",
        itemUnits: new Map(),
        batches: [],
      }).totals,
      batches: 1,
      actualCost: actual,
      totalCost: actual,
      variance: {
        price: null,
        usage: null,
        mix: null,
        inputQuantity: null,
        yield: null,
        quantity: null,
        total: variance,
      },
    };

  it("swaps frozen figures in, rebuilds the total and measures the drift", () => {
    const frozenTotals = totals(100, 5);
    const snapshot = {
      version: 1,
      currency: "GBP",
      period: "month",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      totals: frozenTotals,
      rows: [],
      batches: [],
      adjustments: {
        totals: { waste: 0, adjustment: 0, stocktake: 0, total: 0, incomplete: false, movements: 0 },
        lines: [],
      },
    } as CostingCloseSnapshot;
    const live = [
      { periodStart: "2026-10-01", period: "2026-10", totals: totals(120, 6) },
      { periodStart: "2026-11-01", period: "2026-11", totals: totals(50, 1) },
    ];
    const out = applyFrozenPeriods(
      { periods: live, totals: combineTotals(live.map((p) => p.totals)) },
      [],
      new Map([
        [
          "2026-10-01",
          { snapshot, info: { closeId: "c", closedAt: "2026-11-02T10:00:00Z", closedBy: null, note: null } },
        ],
      ]),
    );
    expect(out.periods[0]!.totals.actualCost).toBe(100);
    expect(out.periods[0]!.frozen?.drift).toEqual({ batches: 0, actualCost: 20, changed: true });
    expect(out.periods[1]!.frozen).toBeNull();
    expect(out.totals.actualCost).toBe(150);
    expect(costingDrift(frozenTotals, frozenTotals).changed).toBe(false);
  });
});

describe("exports", () => {
  it("writes the journal with one amount per line, neutralising spreadsheet formulas", () => {
    const csv = journalCsv({
      currency: "GBP",
      period: "month",
      periods: [
        {
          periodStart: "2026-10-01",
          periodEnd: "2026-10-31",
          label: "2026-10",
          frozen: true,
          rows: [
            {
              itemCode: "DOUGH",
              itemName: "=Dough",
              unit: "kg",
              produced: 9.5,
              batches: 2,
              materials: 10,
              labour: 4,
              overhead: 0,
            },
          ],
          adjustments: { waste: 3, adjustment: 0, stocktake: 0 },
        },
      ],
    });
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toContain("Cost type");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe("2026-10-31,2026-10,COST-2026-10,Materials,DOUGH,'=Dough,9.5,kg,2,10,GBP,Closed");
    expect(lines[2]).toContain("Labour absorbed");
    expect(lines[3]).toContain("Waste,,,,,,3,GBP");
  });
  it("writes batches and valuation", () => {
    expect(
      batchesCsv({
        currency: "GBP",
        batches: [
          {
            batchCode: "B1",
            completedOn: "2026-10-02",
            itemCode: "D",
            itemName: "Dough",
            unit: "kg",
            produced: 9,
            planned: 10,
            materials: 10,
            labour: 2,
            overhead: 1,
            standardCost: 12,
            variance: 1,
            costComplete: true,
          },
        ],
      }),
    ).toContain("B1,2026-10-02,D,Dough,10,9,kg,10,2,1,13,12,1,Yes,GBP");
    expect(
      valuationCsv({
        currency: "EUR",
        asOf: "2026-11-14",
        lots: [
          {
            itemCode: "F",
            itemName: "Flour",
            lotCode: "L1",
            status: "available",
            receivedOn: "2026-10-01",
            expiresOn: null,
            quantity: 25,
            unit: "kg",
            unitCost: 0.9,
            value: 22.5,
            source: "purchase",
            estimatedPercent: 0,
          },
        ],
      }),
    ).toContain("2026-11-14,F,Flour,L1,available,2026-10-01,,25,kg,0.9,22.5,purchase,0,EUR");
  });
});

describe("currency", () => {
  it("accepts ISO 4217 codes in any case and refuses the rest", () => {
    expect(currencySchema.parse(" gbp ")).toBe("GBP");
    expect(currencySchema.safeParse("pounds").success).toBe(false);
    expect(currencySchema.safeParse("ZZZ").success).toBe(false);
    expect(effectiveCurrency("nope")).toBe("GBP");
    expect(effectiveCurrency(null)).toBe("GBP");
  });
  it("formats as people in the UK read money", () => {
    expect(formatMoney(1234.5, "GBP")).toBe("£1,234.50");
    expect(formatMoney(-2.1, "GBP")).toBe("-£2.10");
    expect(formatMoney(0.00345, "GBP", { maxDecimals: 8 })).toBe("£0.00345");
    expect(formatMoney(1.38951, "GBP")).toBe("£1.3895");
    expect(formatMoney(5, "JPY")).toMatch(/5/);
    expect(formatMoney(3, "EUR")).toBe("€3.00");
  });
});

describe("UK dates", () => {
  it("writes day first with four-digit years and 24-hour times", () => {
    expect(formatUkDate("2026-11-08")).toBe("08/11/2026");
    expect(formatUkDayMonth("2026-11-08")).toBe("08/11");
    expect(formatUkDate("2026-11-08T23:30:00Z", "Europe/London")).toBe("08/11/2026");
    expect(formatUkDate("2026-07-08T23:30:00Z", "Europe/London")).toBe("09/07/2026");
    expect(formatUkTime("2026-07-08T13:05:00Z", "Europe/London")).toBe("14:05");
    expect(formatUkDateTime("2026-07-08T00:05:00Z", "Europe/London")).toBe("08/07/2026 01:05");
    expect(formatUkDateTime("2026-11-08T12:41:00Z", "Europe/London", { zone: true })).toBe(
      "08/11/2026 12:41 GMT",
    );
    expect(formatUkDateTime("2026-11-08")).toBe("08/11/2026");
    expect(formatUkDate(null)).toBe("");
  });
});
