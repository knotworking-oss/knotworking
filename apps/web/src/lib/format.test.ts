import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatLongDate,
  formatMoney,
  formatShortDate,
  formatUnitMoney,
  isOverdue,
} from "./format";

describe("formatDateTime and formatMoney", () => {
  it("writes UK date times with the zone's name, and money in the workspace currency", () => {
    expect(formatDateTime("2026-11-08T12:41:00Z", "Europe/London")).toBe("08/11/2026 12:41 GMT");
    expect(formatDateTime("2026-07-08T12:41:00Z", "Europe/London")).toBe("08/07/2026 13:41 BST");
    expect(formatDateTime(null)).toBe("");
    expect(formatMoney(1234.5, "GBP")).toBe("£1,234.50");
    expect(formatMoney(12, "EUR")).toBe("€12.00");
    expect(formatMoney(null, "GBP")).toBe("—");
    expect(formatUnitMoney(0.00345, "GBP")).toBe("£0.00345");
  });
});

describe("formatShortDate / formatLongDate in a time zone", () => {
  it("shows the day a timestamp falls on in the zone, and leaves date-only values alone", () => {
    // 23:30 UTC on 8 Nov is already the 9th in Auckland and still the 8th in New York.
    const at = "2026-11-08T23:30:00.000Z";
    expect(formatShortDate(at, "Pacific/Auckland")).toBe("09/11");
    expect(formatLongDate(at, "Pacific/Auckland")).toBe("09/11/2026");
    expect(formatShortDate(at, "America/New_York")).toBe("08/11");
    expect(formatShortDate(at)).toBe("08/11");
    expect(formatShortDate("2026-11-08", "Pacific/Auckland")).toBe("08/11");
    expect(formatLongDate("2026-11-08", "America/New_York")).toBe("08/11/2026");
  });
});

describe("formatShortDate / formatLongDate", () => {
  it("renders date-only values on that calendar day, regardless of the local time zone", () => {
    // The test runner is pinned to America/New_York; a naive `new Date("2026-11-08")` would show Nov 7.
    expect(formatShortDate("2026-11-08")).toBe("08/11");
    expect(formatLongDate("2026-11-08")).toBe("08/11/2026");
    expect(formatShortDate("2026-01-01")).toBe("01/01");
  });

  it("renders ISO timestamps in UTC", () => {
    expect(formatShortDate("2026-11-08T23:30:00.000Z")).toBe("08/11");
    expect(formatShortDate("2026-11-09T00:30:00.000Z")).toBe("09/11");
    expect(formatLongDate("2025-12-31T23:59:59Z")).toBe("31/12/2025");
  });

  it("returns an empty string for missing values", () => {
    expect(formatShortDate(null)).toBe("");
    expect(formatShortDate(undefined)).toBe("");
    expect(formatShortDate("")).toBe("");
    expect(formatLongDate(null)).toBe("");
  });
});

describe("isOverdue", () => {
  it("is false without a due date", () => {
    expect(isOverdue(null)).toBe(false);
    expect(isOverdue(undefined)).toBe(false);
    expect(isOverdue("")).toBe(false);
  });

  it("stays false through the end of the due day and flips afterwards", () => {
    expect(isOverdue("2026-11-08", new Date("2026-11-07T12:00:00Z"))).toBe(false);
    expect(isOverdue("2026-11-08", new Date("2026-11-08T23:59:58Z"))).toBe(false);
    expect(isOverdue("2026-11-08", new Date("2026-11-09T00:00:00Z"))).toBe(true);
    expect(isOverdue("2026-11-08", new Date("2027-01-01T00:00:00Z"))).toBe(true);
  });

  it("defaults to the current time", () => {
    expect(isOverdue("2000-01-01")).toBe(true);
    expect(isOverdue("2999-01-01")).toBe(false);
  });
});
