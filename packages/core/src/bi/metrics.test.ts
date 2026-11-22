import { describe, expect, it } from "vitest";
import { biDataset } from "./catalogue";
import {
  BI_METRICS_DATASET,
  biCertifiedMetric,
  biCertifiedMetrics,
  biMetricBuckets,
  biMetricCompareRange,
  biMetricRange,
  checkBiMetricQuery,
} from "./metrics";
import { biQuerySpecSchema, checkBiQuery, type BiQuerySpecInput } from "./query";

const dataset = biDataset(BI_METRICS_DATASET)!;
const check = (input: Omit<BiQuerySpecInput, "dataset">) =>
  checkBiQuery(biQuerySpecSchema.parse({ dataset: BI_METRICS_DATASET, ...input }), dataset);

describe("certified metrics", () => {
  it("offers every metric as a measure of one virtual dataset, with its definition and version", () => {
    expect(dataset.virtual).toBe(true);
    expect(dataset.measures.map((m) => m.id)).toEqual(biCertifiedMetrics.map((m) => m.id));
    for (const m of dataset.measures) {
      expect(m.agg).toBe("certified");
      expect(m.certified?.version).toBeTruthy();
      expect(m.description.length).toBeGreaterThan(40);
    }
    expect(new Set(biCertifiedMetrics.map((m) => m.id)).size).toBe(biCertifiedMetrics.length);
  });

  it("runs metrics over a period, trended by month or compared, and refuses what they can't do", () => {
    expect(
      check({ measures: ["oee"], period: { preset: "last_12_months" }, compare: "previous_period" }),
    ).toEqual([]);
    expect(
      check({
        measures: ["oee", "complaint_rate"],
        groupBy: [{ dim: "period_on", grain: "month" }],
        period: { preset: "last_12_months" },
      }),
    ).toEqual([]);
    expect(check({ measures: ["oee"] }).map((i) => i.path)).toEqual(["period"]);
    expect(
      check({
        measures: ["oee"],
        groupBy: [{ dim: "period_on", grain: "week" }],
        period: { preset: "last_90_days" },
      }).map((i) => i.path),
    ).toEqual(["groupBy[0].grain"]);
    expect(
      check({
        measures: ["oee"],
        filters: [{ dim: "period_on", op: "gte", value: "2026-01-01" }],
        period: { preset: "last_90_days" },
      }).map((i) => i.path),
    ).toEqual(["filters"]);
  });

  it("takes metrics as at now without a period, and never trends, compares or mixes them", () => {
    expect(check({ measures: ["stock_value", "training_compliance"] })).toEqual([]);
    expect(
      check({ measures: ["stock_value", "oee"], period: { preset: "this_month" } }).map((i) => i.path),
    ).toEqual(["measures"]);
    const issues = checkBiMetricQuery(
      biQuerySpecSchema.parse({
        dataset: BI_METRICS_DATASET,
        measures: ["open_complaints"],
        groupBy: [{ dim: "period_on", grain: "month" }],
        period: { preset: "this_year" },
        compare: "previous_year",
      }),
      dataset,
    );
    expect(issues.map((i) => i.path)).toEqual(["groupBy", "compare"]);
  });

  it("works whole-month metrics over whole months, and compares them without overlap", () => {
    const variance = biCertifiedMetric("batch_cost_variance")!;
    const oee = biCertifiedMetric("oee")!;
    const last30 = { from: "2026-10-20", to: "2026-11-19" };
    expect(biMetricRange(variance, last30)).toEqual({ from: "2026-10-01", to: "2026-12-01" });
    expect(biMetricRange(oee, last30)).toEqual(last30);
    // Two months (October, November) against the two before; a year earlier for previous_year.
    const fallback = { from: "2026-09-20", to: "2026-10-20" };
    expect(biMetricCompareRange(variance, last30, "previous_period", fallback)).toEqual({
      from: "2026-08-01",
      to: "2026-10-01",
    });
    expect(biMetricCompareRange(variance, last30, "previous_year", fallback)).toEqual({
      from: "2025-10-01",
      to: "2025-12-01",
    });
    expect(biMetricCompareRange(oee, last30, "previous_period", fallback)).toBe(fallback);
    // Across a year end.
    expect(
      biMetricCompareRange(variance, { from: "2026-01-01", to: "2026-03-01" }, "previous_period", fallback),
    ).toEqual({ from: "2025-11-01", to: "2026-01-01" });
  });

  it("asks for a trend past a year, so each figure stays one bounded report", () => {
    expect(
      check({ measures: ["oee"], period: { from: "1990-01-01", to: "2026-01-01" } }).map((i) => i.path),
    ).toEqual(["period"]);
    expect(
      check({
        measures: ["oee"],
        groupBy: [{ dim: "period_on", grain: "year" }],
        period: { from: "2020-01-01", to: "2026-01-01" },
      }),
    ).toEqual([]);
  });

  it("cuts a period into buckets clipped to the period", () => {
    expect(biMetricBuckets({ from: "2026-02-10", to: "2026-08-01" }, "financial_quarter", 4)).toEqual([
      { bucket: "2026-01-01", from: "2026-02-10", to: "2026-04-01" },
      { bucket: "2026-04-01", from: "2026-04-01", to: "2026-07-01" },
      { bucket: "2026-07-01", from: "2026-07-01", to: "2026-08-01" },
    ]);
    expect(biMetricBuckets({ from: "2026-01-15", to: "2026-04-10" }, "month", 1)).toEqual([
      { bucket: "2026-01-01", from: "2026-01-15", to: "2026-02-01" },
      { bucket: "2026-02-01", from: "2026-02-01", to: "2026-03-01" },
      { bucket: "2026-03-01", from: "2026-03-01", to: "2026-04-01" },
      { bucket: "2026-04-01", from: "2026-04-01", to: "2026-04-10" },
    ]);
    // A financial year starting in April.
    expect(biMetricBuckets({ from: "2025-01-01", to: "2026-01-01" }, "financial_year", 4)).toEqual([
      { bucket: "2024-04-01", from: "2025-01-01", to: "2025-04-01" },
      { bucket: "2025-04-01", from: "2025-04-01", to: "2026-01-01" },
    ]);
    expect(
      biMetricBuckets({ from: "2026-01-01", to: "2026-12-31" }, "quarter", 1)!.map((b) => b.bucket),
    ).toEqual(["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01"]);
    expect(biMetricBuckets({ from: "2020-01-01", to: "2026-01-01" }, "month", 1)).toBeNull();
  });
});
