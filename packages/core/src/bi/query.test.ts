import { describe, expect, it } from "vitest";
import { biDataset } from "./catalogue";
import {
  biQuerySpecSchema,
  checkBiQuery,
  comparisonRange,
  isCalendarDate,
  nearest,
  resolveBiPeriod,
  type BiQuerySpecInput,
} from "./query";

const check = (input: BiQuerySpecInput) => {
  const spec = biQuerySpecSchema.parse(input);
  return checkBiQuery(spec, biDataset(spec.dataset)!);
};

describe("BI periods", () => {
  const today = "2026-11-18";

  it("resolves rolling and calendar presets with an exclusive end", () => {
    expect(resolveBiPeriod("today", today)).toEqual({ from: "2026-11-18", to: "2026-11-19" });
    expect(resolveBiPeriod("last_7_days", today)).toEqual({ from: "2026-11-12", to: "2026-11-19" });
    expect(resolveBiPeriod("this_month", today)).toEqual({ from: "2026-11-01", to: "2026-12-01" });
    expect(resolveBiPeriod("last_month", today)).toEqual({ from: "2026-10-01", to: "2026-11-01" });
    expect(resolveBiPeriod("last_12_months", today)).toEqual({ from: "2025-12-01", to: "2026-11-19" });
    expect(resolveBiPeriod("last_6_months", today)).toEqual({ from: "2026-06-01", to: "2026-11-19" });
    expect(resolveBiPeriod("last_3_months", today)).toEqual({ from: "2026-09-01", to: "2026-11-19" });
    expect(resolveBiPeriod("year_to_date", today)).toEqual({ from: "2026-01-01", to: "2026-11-19" });
    expect(resolveBiPeriod("last_year", today)).toEqual({ from: "2025-01-01", to: "2026-01-01" });
  });

  it("follows the workspace financial year", () => {
    expect(resolveBiPeriod("this_financial_year", today, 4)).toEqual({
      from: "2026-04-01",
      to: "2027-04-01",
    });
    expect(resolveBiPeriod("last_financial_year", today, 4)).toEqual({
      from: "2025-04-01",
      to: "2026-04-01",
    });
    expect(resolveBiPeriod("financial_year_to_date", today, 4)).toEqual({
      from: "2026-04-01",
      to: "2026-11-19",
    });
    expect(resolveBiPeriod("this_quarter", today, 4)).toEqual({ from: "2026-10-01", to: "2027-01-01" });
    expect(resolveBiPeriod("last_quarter", today, 4)).toEqual({ from: "2026-07-01", to: "2026-10-01" });
    expect(resolveBiPeriod("last_quarter", "2026-05-02", 4)).toEqual({
      from: "2026-01-01",
      to: "2026-04-01",
    });
  });

  it("never collapses a year-back comparison near 29 February", () => {
    expect(comparisonRange({ from: "2028-02-28", to: "2028-02-29" }, "previous_year")).toEqual({
      from: "2027-02-28",
      to: "2027-03-01",
    });
    expect(comparisonRange({ from: "2028-02-29", to: "2028-03-01" }, "previous_year")).toEqual({
      from: "2027-02-28",
      to: "2027-03-01",
    });
    expect(comparisonRange({ from: "2026-01-01", to: "2027-01-01" }, "previous_year")).toEqual({
      from: "2025-01-01",
      to: "2026-01-01",
    });
  });

  it("accepts only real calendar dates", () => {
    expect(isCalendarDate("2028-02-29")).toBe(true);
    for (const bad of ["2027-02-29", "2026-02-30", "2026-13-01", "2026-1-01", "today"])
      expect(isCalendarDate(bad), bad).toBe(false);
    expect(
      biQuerySpecSchema.safeParse({ dataset: "tasks", measures: ["x"], period: { from: "2026-02-30" } })
        .success,
    ).toBe(false);
  });

  it("compares whole months with whole months, other ranges day for day, and a year back", () => {
    expect(comparisonRange({ from: "2026-10-01", to: "2026-11-01" }, "previous_period")).toEqual({
      from: "2026-09-01",
      to: "2026-10-01",
    });
    expect(comparisonRange({ from: "2026-11-12", to: "2026-11-19" }, "previous_period")).toEqual({
      from: "2026-11-05",
      to: "2026-11-12",
    });
    expect(comparisonRange({ from: "2024-02-29", to: "2024-03-01" }, "previous_year")).toEqual({
      from: "2023-02-28",
      to: "2023-03-01",
    });
  });
});

describe("checking a spec", () => {
  it("accepts the documented example", () => {
    expect(
      check({
        dataset: "purchase_orders",
        measures: ["order_value"],
        groupBy: [{ dim: "supplier" }, { dim: "ordered_on", grain: "month" }],
        filters: [{ dim: "status", op: "in", value: ["sent", "closed"] }],
        period: { preset: "last_12_months" },
        sort: [{ by: "order_value", dir: "desc" }],
        limit: 20,
      }),
    ).toEqual([]);
  });

  it("suggests the nearest field for a typo", () => {
    expect(nearest("suplier", ["supplier", "item", "status"])).toBe("supplier");
    expect(nearest("zzzzzz", ["supplier", "item"])).toBeUndefined();
    const [issue] = check({ dataset: "purchase_orders", measures: ["order_valu"] });
    expect(issue).toMatchObject({ path: "measures[0]", suggestion: "order_value" });
  });

  it("needs a grain on date dimensions, and none elsewhere", () => {
    expect(
      check({ dataset: "tasks", measures: ["task_count"], groupBy: [{ dim: "created_on" }] })[0],
    ).toMatchObject({
      path: "groupBy[0].grain",
    });
    expect(
      check({
        dataset: "tasks",
        measures: ["task_count"],
        groupBy: [{ dim: "state_type", grain: "month" }],
      })[0],
    ).toMatchObject({ path: "groupBy[0].grain" });
  });

  it("checks filter operators and values against the dimension", () => {
    expect(
      check({
        dataset: "tasks",
        measures: ["task_count"],
        filters: [{ dim: "state_type", op: "gt", value: "x" }],
      })[0],
    ).toMatchObject({ path: "filters[0].op" });
    expect(
      check({
        dataset: "tasks",
        measures: ["task_count"],
        filters: [{ dim: "due_on", op: "gte", value: "18/11/2026" }],
      })[0],
    ).toMatchObject({ path: "filters[0].value" });
    expect(
      check({
        dataset: "quality_complaints",
        measures: ["complaint_count"],
        filters: [{ dim: "severity", op: "eq", value: "majr" }],
      })[0],
    ).toMatchObject({ path: "filters[0].value", suggestion: "major" });
    expect(
      check({
        dataset: "tasks",
        measures: ["task_count"],
        filters: [{ dim: "due_on", op: "between", value: ["2026-01-01"] }],
      })[0],
    ).toMatchObject({ path: "filters[0].value" });
  });

  it("needs money split by currency and quantities by item, by grouping or a single-value filter", () => {
    expect(check({ dataset: "sales_orders", measures: ["sales_value"] })[0]).toMatchObject({
      suggestion: "currency",
    });
    expect(
      check({
        dataset: "sales_orders",
        measures: ["sales_value"],
        filters: [{ dim: "currency", op: "in", value: ["GBP", "EUR"] }],
      }),
    ).toHaveLength(1);
    expect(
      check({
        dataset: "sales_orders",
        measures: ["sales_value"],
        filters: [{ dim: "currency", op: "in", value: ["GBP"] }],
      }),
    ).toEqual([]);
    expect(
      check({ dataset: "stock_movements", measures: ["net_quantity"], groupBy: [{ dim: "base_unit" }] }),
    ).toEqual([]);
    expect(
      check({
        dataset: "tasks",
        measures: ["task_count"],
        filters: [{ dim: "assignee", op: "eq", value: "not-a-uuid" }],
      })[0],
    ).toMatchObject({ path: "filters[0].value" });
    // The workspace currency needs no split.
    expect(check({ dataset: "purchase_orders", measures: ["order_value"] })).toEqual([]);
  });

  it("only compares with a full period, and not while grouping by that period's date", () => {
    expect(
      check({ dataset: "tasks", measures: ["task_count"], compare: "previous_period" })[0],
    ).toMatchObject({ path: "compare" });
    expect(
      check({
        dataset: "tasks",
        measures: ["task_count"],
        period: { preset: "this_month" },
        compare: "previous_year",
        groupBy: [{ dim: "created_on", grain: "day" }],
      })[0],
    ).toMatchObject({ path: "compare" });
    expect(
      check({
        dataset: "tasks",
        measures: ["task_count"],
        period: { from: "2026-01-01" },
        compare: "previous_period",
      })[0],
    ).toMatchObject({ path: "compare" });
    expect(
      check({
        dataset: "tasks",
        measures: ["task_count"],
        period: { preset: "this_month" },
        compare: "previous_period",
        sort: [{ by: "task_count__compare", dir: "desc" }],
      }),
    ).toEqual([]);
  });

  it("refuses structural problems before the catalogue is consulted", () => {
    expect(biQuerySpecSchema.safeParse({ dataset: "tasks", measures: [] }).success).toBe(false);
    expect(biQuerySpecSchema.safeParse({ dataset: "tasks", measures: ["x"], limit: 50_000 }).success).toBe(
      false,
    );
    expect(
      biQuerySpecSchema.safeParse({
        dataset: "tasks",
        measures: ["x"],
        period: { preset: "this_month", from: "2026-01-01" },
      }).success,
    ).toBe(false);
  });
});
