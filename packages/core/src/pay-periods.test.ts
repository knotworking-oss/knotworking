import { describe, expect, it } from "vitest";
import {
  isPayPeriod,
  lastFinishedPayPeriod,
  nextPayPeriod,
  payPeriodContaining,
  payPeriodProblem,
  previousPayPeriod,
  type PayPeriodSetting,
} from "./pay-periods";

const weekly: PayPeriodSetting = { kind: "weekly", anchor: "2026-01-05" }; // a Monday
const fortnightly: PayPeriodSetting = { kind: "fortnightly", anchor: "2026-01-05" };
const fourWeekly: PayPeriodSetting = { kind: "four_weekly", anchor: "2026-01-05" };
const calendarMonths: PayPeriodSetting = { kind: "monthly", anchor: null };
const from26: PayPeriodSetting = { kind: "monthly", anchor: "2026-01-26" };
const from31: PayPeriodSetting = { kind: "monthly", anchor: "2026-01-31" };

describe("pay periods", () => {
  it("repeats fixed-length periods from the anchor, before it as well as after", () => {
    expect(payPeriodContaining("2026-11-13", weekly)).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    expect(payPeriodContaining("2026-01-05", weekly)).toEqual({ from: "2026-01-05", to: "2026-01-11" });
    expect(payPeriodContaining("2026-01-04", weekly)).toEqual({ from: "2025-12-29", to: "2026-01-04" });
    expect(payPeriodContaining("2026-01-19", fortnightly)).toEqual({ from: "2026-01-19", to: "2026-02-01" });
    expect(payPeriodContaining("2026-01-18", fortnightly)).toEqual({ from: "2026-01-05", to: "2026-01-18" });
    expect(payPeriodContaining("2026-02-01", fourWeekly)).toEqual({ from: "2026-01-05", to: "2026-02-01" });
    expect(payPeriodContaining("2026-02-02", fourWeekly)).toEqual({ from: "2026-02-02", to: "2026-03-01" });
  });

  it("does not drift across a year end or a leap day", () => {
    expect(payPeriodContaining("2027-01-04", fourWeekly)).toEqual({ from: "2027-01-04", to: "2027-01-31" }); // 364 days on
    const leap: PayPeriodSetting = { kind: "weekly", anchor: "2024-02-26" };
    expect(payPeriodContaining("2024-02-29", leap)).toEqual({ from: "2024-02-26", to: "2024-03-03" });
  });

  it("makes calendar months without an anchor, and months from the anchor's day with one", () => {
    expect(payPeriodContaining("2026-02-10", calendarMonths)).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(payPeriodContaining("2028-02-10", calendarMonths)).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
    expect(payPeriodContaining("2026-03-25", from26)).toEqual({ from: "2026-02-26", to: "2026-03-25" });
    expect(payPeriodContaining("2026-03-26", from26)).toEqual({ from: "2026-03-26", to: "2026-04-25" });
    expect(payPeriodContaining("2026-01-05", from26)).toEqual({ from: "2025-12-26", to: "2026-01-25" });
  });

  it("starts a month's period on its last day when the anchor day is past the end", () => {
    expect(payPeriodContaining("2026-02-28", from31)).toEqual({ from: "2026-02-28", to: "2026-03-30" });
    expect(payPeriodContaining("2026-03-30", from31)).toEqual({ from: "2026-02-28", to: "2026-03-30" });
    expect(payPeriodContaining("2026-03-31", from31)).toEqual({ from: "2026-03-31", to: "2026-04-29" });
    expect(payPeriodContaining("2026-04-30", from31)).toEqual({ from: "2026-04-30", to: "2026-05-30" });
  });

  it("tiles the calendar: periods are consecutive, each one's neighbours point back at it", () => {
    for (const setting of [weekly, fortnightly, fourWeekly, calendarMonths, from26, from31]) {
      let period = payPeriodContaining("2025-12-01", setting);
      for (let i = 0; i < 40; i++) {
        const next = nextPayPeriod(period, setting);
        expect(Date.parse(next.from) - Date.parse(period.to)).toBe(86_400_000);
        expect(previousPayPeriod(next, setting)).toEqual(period);
        expect(Date.parse(period.to) - Date.parse(period.from)).toBeLessThan(31 * 86_400_000);
        period = next;
      }
    }
  });

  it("finds the last finished period, whatever day of the period today is", () => {
    expect(lastFinishedPayPeriod("2026-11-13", calendarMonths)).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(lastFinishedPayPeriod("2026-11-01", calendarMonths)).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(lastFinishedPayPeriod("2026-01-15", calendarMonths)).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
    expect(lastFinishedPayPeriod("2026-11-13", weekly)).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(lastFinishedPayPeriod("2026-11-09", weekly)).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(lastFinishedPayPeriod("2026-11-15", weekly)).toEqual({ from: "2026-11-02", to: "2026-11-08" });
  });

  it("needs an anchor unless monthly", () => {
    expect(payPeriodProblem({ kind: "weekly", anchor: null })).toMatch(/anchor/);
    expect(payPeriodProblem({ kind: "fortnightly", anchor: null })).toMatch(/anchor/);
    expect(payPeriodProblem(calendarMonths)).toBeNull();
    expect(payPeriodProblem(weekly)).toBeNull();
    expect(() => payPeriodContaining("2026-01-01", { kind: "weekly", anchor: null })).toThrow();
  });

  it("recognises a range that is exactly a period", () => {
    expect(isPayPeriod({ from: "2026-11-09", to: "2026-11-15" }, weekly)).toBe(true);
    expect(isPayPeriod({ from: "2026-11-09", to: "2026-11-14" }, weekly)).toBe(false);
    expect(isPayPeriod({ from: "2026-11-10", to: "2026-11-16" }, weekly)).toBe(false);
    expect(isPayPeriod({ from: "2026-10-01", to: "2026-10-31" }, calendarMonths)).toBe(true);
    expect(isPayPeriod({ from: "2026-10-01", to: "2026-10-31" }, { kind: "weekly", anchor: null })).toBe(
      false,
    );
  });
});
