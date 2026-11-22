import { describe, expect, it } from "vitest";
import {
  taskUpdateSchema,
  timeEntryCreateSchema,
  timeEntryUpdateSchema,
  timeReportQuerySchema,
} from "./schemas";
import {
  estimateVariance,
  formatMinutes,
  formatVariance,
  inclusiveDays,
  localIsoDate,
  minutesToHours,
  parseDuration,
  timerMinutes,
} from "./time";

describe("time helpers", () => {
  it("formats minutes", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(90)).toBe("1h 30m");
    expect(formatMinutes(1500)).toBe("25h");
  });

  it("parses durations people type", () => {
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("1h 30m")).toBe(90);
    expect(parseDuration("1h30")).toBe(90);
    expect(parseDuration("1.5h")).toBe(90);
    expect(parseDuration("1,5 h")).toBe(90);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("2 hours")).toBe(120);
    expect(parseDuration("45m")).toBe(45);
    expect(parseDuration("45 min")).toBe(45);
    expect(parseDuration(" 15 ")).toBe(15);
    for (const bad of ["", "0", "0m", "abc", "h", "1:75", "-5", "1h 30x"]) {
      expect(parseDuration(bad), bad).toBeNull();
    }
  });

  it("rounds timers to whole minutes between 1 minute and a day", () => {
    const start = new Date("2026-11-09T10:00:00Z");
    const at = (ms: number) => new Date(start.getTime() + ms);
    expect(timerMinutes(start, at(5_000))).toBe(1);
    expect(timerMinutes(start, at(25 * 60_000 + 20_000))).toBe(25);
    expect(timerMinutes(start.toISOString(), at(25 * 60_000 + 40_000))).toBe(26);
    expect(timerMinutes(start, at(3 * 24 * 60 * 60_000))).toBe(24 * 60);
  });

  it("gives the local calendar date", () => {
    expect(localIsoDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("validates entries and time estimates", () => {
    expect(timeEntryCreateSchema.safeParse({ minutes: 30 }).success).toBe(true);
    expect(timeEntryCreateSchema.safeParse({ minutes: 0 }).success).toBe(false);
    expect(timeEntryCreateSchema.safeParse({ minutes: 1441 }).success).toBe(false);
    expect(timeEntryUpdateSchema.safeParse({}).success).toBe(false);
    expect(timeEntryUpdateSchema.safeParse({ note: null }).success).toBe(true);
    expect(taskUpdateSchema.safeParse({ estimateMinutes: 120 }).success).toBe(true);
    expect(taskUpdateSchema.safeParse({ estimateMinutes: null }).success).toBe(true);
  });
});

describe("time report query", () => {
  const parse = (q: Record<string, string>) => timeReportQuerySchema.safeParse(q);
  const ID = "01900000-0000-7000-8000-000000000000";

  it("counts inclusive days, across month, year and leap boundaries", () => {
    expect(inclusiveDays("2026-11-02", "2026-11-02")).toBe(1);
    expect(inclusiveDays("2026-11-02", "2026-11-08")).toBe(7);
    expect(inclusiveDays("2026-02-28", "2026-03-01")).toBe(2);
    expect(inclusiveDays("2028-02-28", "2028-03-01")).toBe(3);
    expect(inclusiveDays("2025-01-01", "2026-01-01")).toBe(366);
  });

  it("compares logged time with an estimate", () => {
    expect(estimateVariance(135, 120)).toEqual({ minutes: 15, state: "over" });
    expect(estimateVariance(30, 120)).toEqual({ minutes: -90, state: "under" });
    expect(estimateVariance(60, 60)).toEqual({ minutes: 0, state: "on" });
    expect(formatVariance(15)).toBe("+15m over");
    expect(formatVariance(-90)).toBe("1h 30m under");
    expect(formatVariance(0)).toBe("on estimate");
  });

  it("formats decimal hours", () => {
    expect(minutesToHours(90)).toBe("1.50");
    expect(minutesToHours(60)).toBe("1.00");
    expect(minutesToHours(20)).toBe("0.33");
    expect(minutesToHours(1)).toBe("0.02");
  });

  it("accepts a range and defaults to grouping by project", () => {
    const ok = parse({ from: "2026-11-02", to: "2026-11-08" });
    expect(ok.success && ok.data).toEqual({ from: "2026-11-02", to: "2026-11-08", groupBy: "project" });
    expect(parse({ from: "2026-11-02", to: "2026-11-02" }).success).toBe(true);
  });

  it("accepts filters and every grouping", () => {
    for (const groupBy of ["project", "person", "task", "day"]) {
      expect(parse({ from: "2026-11-02", to: "2026-11-08", groupBy }).success, groupBy).toBe(true);
    }
    expect(
      parse({ from: "2026-11-02", to: "2026-11-08", projectId: ID, teamId: ID, userId: ID }).success,
    ).toBe(true);
  });

  it("refuses missing, malformed, reversed and impossible dates", () => {
    expect(parse({}).success).toBe(false);
    expect(parse({ from: "2026-11-02" }).success).toBe(false);
    expect(parse({ from: "2026-11-08", to: "2026-11-02" }).success).toBe(false);
    expect(parse({ from: "2026-02-30", to: "2026-03-02" }).success).toBe(false);
    expect(parse({ from: "11/02/2026", to: "11/08/2026" }).success).toBe(false);
    expect(parse({ from: "2026-11-02T00:00:00Z", to: "2026-11-08" }).success).toBe(false);
  });

  it("limits the range to 366 days", () => {
    expect(parse({ from: "2025-01-01", to: "2026-01-01" }).success).toBe(true);
    expect(parse({ from: "2025-01-01", to: "2026-01-02" }).success).toBe(false);
    expect(parse({ from: "1900-01-01", to: "2026-01-01" }).success).toBe(false);
  });

  it("refuses unknown groupings and malformed ids", () => {
    expect(parse({ from: "2026-11-02", to: "2026-11-08", groupBy: "week" }).success).toBe(false);
    expect(parse({ from: "2026-11-02", to: "2026-11-08", projectId: "abc" }).success).toBe(false);
  });
});
