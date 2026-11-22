import { describe, expect, it } from "vitest";
import {
  chartData,
  delta,
  donutData,
  formatAxis,
  formatBucket,
  formatDimension,
  formatMeasure,
  OTHER,
  pivotData,
  resultCsv,
  type BiResult,
} from "./bi-format";

const result = (
  columns: BiResult["columns"],
  rows: BiResult["rows"],
  extra: Partial<BiResult> = {},
): BiResult => ({
  dataset: "x",
  columns,
  rows,
  truncated: false,
  period: null,
  comparePeriod: null,
  currency: "GBP",
  ...extra,
});
const month = { key: "month", label: "Month", kind: "dimension", type: "date", grain: "month" } as const;
const supplier = {
  key: "supplier",
  label: "Supplier",
  kind: "dimension",
  type: "reference",
  idKey: "supplier__id",
} as const;
const value = { key: "value", label: "Value", kind: "measure", unit: "money" } as const;

describe("formatting", () => {
  it("labels date buckets by grain", () => {
    expect(formatBucket("2026-11-01", "month")).toBe("Nov 2026");
    expect(formatBucket("2026-11-16", "week")).toBe("w/c 16 Nov 2026");
    expect(formatBucket("2026-04-01", "financial_year")).toBe("FY from Apr 2026");
    expect(formatBucket("2026-01-01", "financial_year")).toBe("2026");
  });

  it("formats dimensions and measures for people", () => {
    expect(
      formatDimension({ key: "s", label: "S", kind: "dimension", type: "category" }, "in_progress"),
    ).toBe("In progress");
    expect(formatDimension({ key: "b", label: "B", kind: "dimension", type: "boolean" }, true)).toBe("Yes");
    expect(formatDimension(supplier, null)).toBe("None");
    expect(formatMeasure("money", 1234.5, "GBP")).toBe("£1,234.50");
    expect(formatMeasure("minutes", 90, null)).toBe("1h 30m");
    expect(formatMeasure("count", 12.4, null)).toBe("12");
    expect(formatMeasure("percent", 71.25, null)).toBe("71.3%");
    expect(formatMeasure("per_million", 3.04, null)).toBe("3 per million");
    expect(formatMeasure("count", null, null)).toBe("–");
    expect(formatAxis("money", 24000, "GBP")).toBe("£24k");
    expect(formatAxis("minutes", 90, null)).toBe("1.5h");
    expect(formatAxis("count", 1200000, null)).toBe("1.2m");
  });

  it("computes the change from a comparison, or none when it can't", () => {
    expect(delta(110, 100)).toBeCloseTo(0.1);
    expect(delta(90, -100)).toBeCloseTo(1.9);
    expect(delta(5, 0)).toBeNull();
    expect(delta(null, 5)).toBeNull();
  });
});

describe("chart shapes", () => {
  it("plots one grouping with a series per measure", () => {
    const data = chartData(
      result(
        [month, value],
        [
          { month: "2026-10-01", value: 10 },
          { month: "2026-11-01", value: 12 },
        ],
      ),
    );
    expect(data.points).toEqual([
      { x: "Oct 2026", value: 10 },
      { x: "Nov 2026", value: 12 },
    ]);
    expect(data.series).toEqual([{ key: "value", label: "Value", color: "var(--chart-1)" }]);
  });

  it("splits a second grouping into series, keeping the largest and folding the rest into Other", () => {
    const names = ["A", "B", "C", "D", "E", "F", "G"];
    const rows = names.map((name, i) => ({
      month: "2026-11-01",
      supplier: name,
      supplier__id: `id${i}`,
      value: 100 - i,
    }));
    const data = chartData(result([month, supplier, value], rows));
    expect(data.folded).toBe(true);
    expect(data.series.map((s) => s.label)).toEqual(["A", "B", "C", "D", OTHER]);
    // Five slots, never cycled: "Other" takes the last.
    expect(data.series.map((s) => s.color)).toEqual([1, 2, 3, 4, 5].map((n) => `var(--chart-${n})`));
    expect(data.points[0]!.other).toBe(96 + 95 + 94);
  });

  it("gives each series a colour that follows the entity, not its size", () => {
    const state = {
      key: "state",
      label: "State",
      kind: "dimension",
      type: "category",
      values: ["backlog", "unstarted", "started", "completed", "canceled"],
    } as const;
    const colours = (rows: Array<{ state: string; value: number }>) =>
      Object.fromEntries(
        chartData(
          result(
            [month, state, value],
            rows.map((r) => ({ month: "2026-11-01", ...r })),
          ),
        ).series.map((s) => [s.label, s.color]),
      );
    const all = colours([
      { state: "backlog", value: 1 },
      { state: "started", value: 9 },
      { state: "canceled", value: 3 },
    ]);
    const filtered = colours([
      { state: "backlog", value: 9 },
      { state: "canceled", value: 1 },
    ]);
    expect(all).toEqual({ Backlog: "var(--chart-1)", Started: "var(--chart-3)", Canceled: "var(--chart-5)" });
    expect(filtered).toEqual({ Backlog: "var(--chart-1)", Canceled: "var(--chart-5)" });
    // Without catalogue values, alphabetical order decides, whatever the totals.
    const named = (rows: Array<{ supplier: string; value: number }>) =>
      chartData(
        result(
          [month, supplier, value],
          rows.map((r) => ({ month: "2026-11-01", ...r })),
        ),
      ).series.map((s) => [s.label, s.color]);
    expect(
      named([
        { supplier: "Zed", value: 9 },
        { supplier: "Acme", value: 1 },
      ]),
    ).toEqual([
      ["Acme", "var(--chart-1)"],
      ["Zed", "var(--chart-2)"],
    ]);
  });

  it("never gives two series the same colour: unlisted values and None take free slots, Other keeps the last", () => {
    const state = {
      key: "state",
      label: "State",
      kind: "dimension",
      type: "category",
      values: ["open", "done"],
    } as const;
    const series = chartData(
      result(
        [month, state, value],
        [
          { month: "2026-11-01", state: "open", value: 3 },
          { month: "2026-11-01", state: null, value: 2 },
        ],
      ),
    ).series.map((s) => [s.label, s.color]);
    expect(series).toEqual([
      ["Open", "var(--chart-1)"],
      ["None", "var(--chart-3)"],
    ]);
    const five = {
      key: "s",
      label: "S",
      kind: "dimension",
      type: "category",
      values: ["a", "b", "c", "d", "e"],
    } as const;
    const folded = chartData(
      result(
        [month, five, value],
        ["a", "b", "c", "d", "e", null].map((v, i) => ({ month: "2026-11-01", s: v, value: 10 - i })),
      ),
    ).series;
    const colours = folded.map((s) => s.color);
    expect(new Set(colours).size).toBe(colours.length);
    expect(folded.at(-1)).toMatchObject({ label: OTHER, color: "var(--chart-5)" });
  });

  it("orders pivot date columns in time, not alphabetically", () => {
    const rows = ["2025-12-01", "2026-01-01", "2026-02-01", "2026-04-01"].map((m) => ({
      supplier: "A",
      month: m,
      value: 1,
    }));
    expect(pivotData(result([supplier, month, value], rows))!.colLabels).toEqual([
      "Dec 2025",
      "Jan 2026",
      "Feb 2026",
      "Apr 2026",
    ]);
  });

  it("folds small donut slices into Other and drops empty ones", () => {
    const rows = ["A", "B", "C", "D", "E", "F"].map((name, i) => ({
      supplier: name,
      value: i === 5 ? 0 : 10 - i,
    }));
    const { slices } = donutData(result([supplier, value], rows));
    expect(slices.map((s) => s.name)).toEqual(["A", "B", "C", "D", "E"]);
    const more = ["A", "B", "C", "D", "E", "F", "G"].map((name, i) => ({ supplier: name, value: 10 - i }));
    expect(
      donutData(result([supplier, value], more))
        .slices.map((s) => [s.name, s.value])
        .at(-1),
    ).toEqual([OTHER, 6 + 5 + 4]);
  });

  it("pivots two groupings, and exports CSV with raw numbers", () => {
    const rows = [
      { supplier: "A", month: "2026-11-01", value: 1 },
      { supplier: "A", month: "2026-10-01", value: 2 },
      { supplier: "B", month: "2026-11-01", value: 3 },
    ];
    const pivot = pivotData(result([supplier, month, value], rows))!;
    expect(pivot.rowLabels).toEqual(["A", "B"]);
    expect(pivot.cell("B", "Oct 2026")).toBeNull();
    expect(pivot.cell("A", "Oct 2026")).toBe(2);
    const csv = resultCsv(
      result(
        [supplier, { ...value, compareKey: "value__compare" }],
        [{ supplier: "A", value: 5, value__compare: 4 }],
      ),
    );
    expect(csv).toEqual([
      ["Supplier", "Value", "Value (comparison)"],
      ["A", 5, 4],
    ]);
  });
});
