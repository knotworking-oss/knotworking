import { describe, expect, it } from "vitest";
import {
  effectiveFinancialYearStartMonth,
  financialQuarterOf,
  financialYearOf,
  financialYearStartMonthSchema,
} from "./financial-year";

describe("financial year", () => {
  it("is the calendar year when it starts in January", () => {
    expect(financialYearOf("2026-11-18")).toEqual({
      year: 2026,
      start: "2026-01-01",
      end: "2027-01-01",
      label: "2026",
    });
    expect(financialQuarterOf("2026-11-18")).toMatchObject({
      quarter: 4,
      start: "2026-10-01",
      end: "2027-01-01",
    });
  });

  it("is named after the year it ends in when it starts later (UK April year)", () => {
    expect(financialYearOf("2026-04-01", 4)).toEqual({
      year: 2027,
      start: "2026-04-01",
      end: "2027-04-01",
      label: "FY2027",
    });
    expect(financialYearOf("2026-03-31", 4)).toMatchObject({ start: "2025-04-01", label: "FY2026" });
    expect(financialQuarterOf("2027-02-10", 4)).toEqual({
      year: 2027,
      quarter: 4,
      start: "2027-01-01",
      end: "2027-04-01",
      label: "Q4 FY2027",
    });
    expect(financialQuarterOf("2026-06-30", 4)).toMatchObject({
      quarter: 1,
      start: "2026-04-01",
      end: "2026-07-01",
    });
  });

  it("wraps quarters across a December year end", () => {
    expect(financialQuarterOf("2026-12-05", 10)).toMatchObject({
      quarter: 1,
      start: "2026-10-01",
      end: "2027-01-01",
    });
    expect(financialQuarterOf("2027-01-05", 10)).toMatchObject({
      quarter: 2,
      start: "2027-01-01",
      end: "2027-04-01",
    });
  });

  it("accepts whole months 1 to 12 only, and falls back to January", () => {
    for (const ok of [1, 6, 12]) expect(financialYearStartMonthSchema.safeParse(ok).success).toBe(true);
    for (const bad of [0, 13, 2.5, "4"])
      expect(financialYearStartMonthSchema.safeParse(bad).success).toBe(false);
    expect(effectiveFinancialYearStartMonth(null)).toBe(1);
    expect(effectiveFinancialYearStartMonth(99)).toBe(1);
  });
});
