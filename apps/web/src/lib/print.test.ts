import { describe, expect, it } from "vitest";
import { describeRange, inDayRange, parseDayRange, printDate, printDateTime, validDay } from "./print";

describe("printDate / printDateTime", () => {
  it("writes UK dates in UTC whatever the runner's zone is", () => {
    expect(printDate("2026-11-08")).toBe("08/11/2026");
    expect(printDate("2026-11-08T23:30:00.000Z")).toBe("08/11/2026");
    expect(printDate("2026-11-09T00:30:00.000Z")).toBe("09/11/2026");
    expect(printDateTime("2026-11-08T12:41:00.000Z")).toBe("08/11/2026 12:41 UTC");
    expect(printDateTime("2026-11-08")).toBe("08/11/2026");
  });

  it("prints timestamps in the workspace's time zone; calendar dates stay as they are", () => {
    expect(printDate("2026-07-15T23:30:00.000Z", "Europe/London")).toBe("16/07/2026");
    expect(printDateTime("2026-07-15T23:30:00.000Z", "Europe/London")).toBe("16/07/2026 00:30 BST");
    expect(printDateTime("2026-01-15T12:41:00.000Z", "Europe/London")).toBe("15/01/2026 12:41 GMT");
    expect(printDate("2026-07-15", "Pacific/Kiritimati")).toBe("15/07/2026");
  });

  it("shows a dash for a missing value", () => {
    expect(printDate(null)).toBe("—");
    expect(printDateTime(undefined)).toBe("—");
  });
});

describe("validDay", () => {
  it("accepts real days only", () => {
    expect(validDay("2026-02-28")).toBe("2026-02-28");
    expect(validDay("2026-02-30")).toBeNull();
    expect(validDay("08/11/2026")).toBeNull();
    expect(validDay(undefined)).toBeNull();
    expect(validDay(["2026-11-08", "x"])).toBe("2026-11-08");
  });
});

describe("parseDayRange", () => {
  it("defaults to the 30 days ending today", () => {
    expect(parseDayRange({}, "2026-11-13")).toEqual({ from: "2026-10-15", to: "2026-11-13" });
  });

  it("keeps good dates, replaces bad ones and swaps a reversed range", () => {
    expect(parseDayRange({ from: "2026-01-01", to: "2026-01-31" }, "2026-11-13")).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(parseDayRange({ from: "nope", to: "2026-03-31" }, "2026-11-13")).toEqual({
      from: "2026-03-02",
      to: "2026-03-31",
    });
    expect(parseDayRange({ from: "2026-05-10", to: "2026-05-01" }, "2026-11-13")).toEqual({
      from: "2026-05-01",
      to: "2026-05-10",
    });
  });
});

describe("inDayRange", () => {
  const range = { from: "2026-11-01", to: "2026-11-30" };
  it("includes both end days, for dates and timestamps", () => {
    expect(inDayRange("2026-11-01", range)).toBe(true);
    expect(inDayRange("2026-11-30T23:59:59Z", range)).toBe(true);
    expect(inDayRange("2026-10-31T23:59:59Z", range)).toBe(false);
    expect(inDayRange("2026-12-01", range)).toBe(false);
    expect(inDayRange(null, range)).toBe(false);
  });
  it("puts a timestamp on its day in the workspace's time zone", () => {
    const july = { from: "2026-07-01", to: "2026-07-15" };
    // 23:30 UTC on 15 July is 00:30 on the 16th in London: outside the range there.
    expect(inDayRange("2026-07-15T23:30:00Z", july, "UTC")).toBe(true);
    expect(inDayRange("2026-07-15T23:30:00Z", july, "Europe/London")).toBe(false);
    expect(inDayRange("2026-06-30T23:30:00Z", july, "Europe/London")).toBe(true);
  });
  it("describes a range", () => {
    expect(describeRange(range)).toBe("01/11/2026 to 30/11/2026");
  });
});
