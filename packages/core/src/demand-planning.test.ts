import { describe, expect, it } from "vitest";
import { addWeeks, type DemandItemSummary } from "./demand";
import {
  baselineBefore,
  buildCoverage,
  buildDemandForecast,
  forecastWeeks,
  sameWeekLastYear,
} from "./demand-planning";
import { buildDemandSummary } from "./demand";

const ORIGIN = "2026-11-09";
const item: DemandItemSummary = {
  id: "a",
  code: "CAKE",
  name: "Cake",
  type: "finished",
  unit: "each",
  status: "active",
};

describe("forecast", () => {
  it("finds the same ISO week last year", () => {
    expect(sameWeekLastYear("2026-11-09")).toBe("2025-11-10");
    expect(sameWeekLastYear("2026-12-28")).toBe("2025-12-22"); // 2026 has week 53, 2025 does not
  });

  it("averages the window, counting missing weeks as zero but not weeks before the first demand", () => {
    const byWeek = new Map([
      [addWeeks(ORIGIN, -1), 100],
      [addWeeks(ORIGIN, -3), 50],
    ]);
    // First week on record is 3 weeks back: the window is weeks -3, -2, -1.
    expect(baselineBefore({ byWeek, firstWeek: addWeeks(ORIGIN, -3) }, ORIGIN, 8)).toBe(50);
    expect(baselineBefore({ byWeek, firstWeek: ORIGIN }, ORIGIN, 8)).toBeNull();
  });

  it("is flat without a year of history", () => {
    const byWeek = new Map([1, 2, 3, 4].map((i) => [addWeeks(ORIGIN, -i), 100] as const));
    const out = forecastWeeks({
      history: { byWeek, firstWeek: addWeeks(ORIGIN, -4) },
      origin: ORIGIN,
      targets: [ORIGIN, addWeeks(ORIGIN, 1)],
      window: 4,
      seasonal: true,
    })!;
    expect(out.map((w) => [w.quantity, w.method, w.seasonalIndex])).toEqual([
      [100, "average", null],
      [100, "average", null],
    ]);
  });

  it("scales by the same week last year", () => {
    const byWeek = new Map<string, number>();
    const lyOrigin = sameWeekLastYear(ORIGIN);
    // Last year: 100 a week, but double (200) around the target week (origin + 2).
    for (let i = -60; i < 0; i++) byWeek.set(addWeeks(ORIGIN, i), 100);
    const target = addWeeks(ORIGIN, 2);
    const ly = sameWeekLastYear(target);
    for (const d of [-1, 0, 1]) byWeek.set(addWeeks(ly, d), 200);
    const out = forecastWeeks({
      history: { byWeek, firstWeek: addWeeks(ORIGIN, -60) },
      origin: ORIGIN,
      targets: [ORIGIN, target],
      window: 8,
      seasonal: true,
    })!;
    expect(lyOrigin < ORIGIN).toBe(true);
    expect(out[0]).toMatchObject({ method: "seasonal" });
    expect(out[1]).toMatchObject({ method: "seasonal", seasonalIndex: 2 });
    expect(out[1]!.quantity).toBeGreaterThan(out[0]!.quantity);
    expect(
      forecastWeeks({
        history: { byWeek, firstWeek: addWeeks(ORIGIN, -60) },
        origin: ORIGIN,
        targets: [target],
        window: 8,
        seasonal: false,
      })![0]!.method,
    ).toBe("average");
  });

  it("builds per item and per customer, ignoring weeks from the origin on", () => {
    const cells = [
      { itemId: "a", customer: "Tesco", periodStart: addWeeks(ORIGIN, -1), quantity: 60 },
      { itemId: "a", customer: "Asda", periodStart: addWeeks(ORIGIN, -1), quantity: 40 },
      { itemId: "a", customer: "Asda", periodStart: ORIGIN, quantity: 999 },
    ];
    const items = new Map([["a", item]]);
    const base = {
      from: ORIGIN,
      to: addWeeks(ORIGIN, 1),
      origin: ORIGIN,
      window: 4,
      seasonal: false,
      cells,
      items,
    };
    const total = buildDemandForecast({ ...base, byCustomer: false });
    expect(total.rows).toHaveLength(1);
    expect(total.rows[0]!.periods[0]!.quantity.base).toBe(100);
    const split = buildDemandForecast({ ...base, byCustomer: true });
    expect(split.rows.map((r) => [r.customer, r.periods[0]!.quantity.base])).toEqual([
      ["Asda", 40],
      ["Tesco", 60],
    ]);
  });
});

describe("coverage", () => {
  const w0 = "2026-11-09";
  const w1 = "2026-11-16";
  const summary = buildDemandSummary({
    from: w0,
    to: w1,
    byCustomer: false,
    items: new Map([["a", item]]),
    cells: [
      { itemId: "a", periodStart: w0, customer: null, quantity: 100, lineCount: 1 },
      { itemId: "a", periodStart: w1, customer: null, quantity: 100, lineCount: 1 },
    ],
  });

  it("runs stock and planned batches against demand week by week", () => {
    const c = buildCoverage({
      summary,
      stock: new Map([["a", 150]]),
      supply: new Map([["a", new Map([[w1, 20]])]]),
    });
    const row = c.rows[0]!;
    expect(row.periods.map((p) => [p.projected!.base, p.shortfall.base, p.status])).toEqual([
      [50, 0, "ok"],
      [-30, 30, "short"],
    ]);
    expect(row.firstShortWeek).toBe(w1);
    expect(row.maxShortfall.base).toBe(30);
  });

  it("leaves out what the caller cannot read", () => {
    const stockOnly = buildCoverage({ summary, stock: new Map([["a", 150]]), supply: null });
    expect(stockOnly.basis).toEqual({ stock: true, production: false });
    expect(stockOnly.rows[0]!.periods[0]!.planned).toBeNull();
    const none = buildCoverage({ summary, stock: null, supply: null });
    expect(none.rows[0]!.stock).toBeNull();
    expect(none.rows[0]!.periods.map((p) => [p.projected, p.status])).toEqual([
      [null, "unknown"],
      [null, "unknown"],
    ]);
  });

  it("can list only the items that run short", () => {
    const ok = buildCoverage({ summary, stock: new Map([["a", 500]]), supply: null, shortOnly: true });
    expect(ok.rows).toEqual([]);
  });
});
