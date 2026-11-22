import { describe, expect, it } from "vitest";
import {
  addDays,
  dateOnlyToLocal,
  formatSpan,
  formatWeekRange,
  isoDate,
  isoTime,
  localDateToUtc,
  parseIsoDate,
  sameDay,
  startOfDay,
  startOfWeek,
} from "./calendar-dates";

// The runner is pinned to America/New_York (see vitest.config.ts); DST ended on 2026-11-01.
// ICU may use thin/narrow no-break spaces; compare with plain ones.
const plain = (s: string) => s.replace(/\s/g, " ");
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

describe("startOfDay / addDays", () => {
  it("truncates to local midnight without mutating the input", () => {
    const input = local(2026, 11, 9, 15, 45);
    const out = startOfDay(input);
    expect(isoDate(out)).toBe("2026-11-09");
    expect(isoTime(out)).toBe("00:00");
    expect(isoTime(input)).toBe("15:45");
  });

  it("adds calendar days across a DST change (days are not 24h long)", () => {
    // Fall back: 2026-11-01 has 25 hours.
    const out = addDays(local(2026, 10, 31), 2);
    expect(isoDate(out)).toBe("2026-11-02");
    expect(isoTime(out)).toBe("00:00");
    // Spring forward: 2026-03-08 has 23 hours.
    expect(isoDate(addDays(local(2026, 3, 7), 2))).toBe("2026-03-09");
    expect(isoDate(addDays(local(2026, 11, 9), -9))).toBe("2026-10-31");
  });

  it("rolls over month and year ends", () => {
    expect(isoDate(addDays(local(2026, 12, 31), 1))).toBe("2027-01-01");
    expect(isoDate(addDays(local(2026, 3, 1), -1))).toBe("2026-02-28");
  });
});

describe("startOfWeek", () => {
  it("starts weeks on Monday", () => {
    // 2026-11-09 is a Monday.
    expect(isoDate(startOfWeek(local(2026, 11, 9, 13)))).toBe("2026-11-09");
    expect(isoDate(startOfWeek(local(2026, 11, 11)))).toBe("2026-11-09");
    expect(isoDate(startOfWeek(local(2026, 11, 15, 23, 59)))).toBe("2026-11-09");
    expect(isoDate(startOfWeek(local(2026, 11, 16)))).toBe("2026-11-16");
  });

  it("returns local midnight and crosses month/DST boundaries", () => {
    const out = startOfWeek(local(2026, 11, 3, 10)); // Tuesday after the DST change
    expect(isoDate(out)).toBe("2026-11-02");
    expect(isoTime(out)).toBe("00:00");
    expect(isoDate(startOfWeek(local(2026, 11, 1, 12)))).toBe("2026-10-26"); // Sunday on the DST day
  });
});

describe("isoDate / isoTime / parseIsoDate / sameDay", () => {
  it("formats local components with zero padding", () => {
    expect(isoDate(local(2026, 1, 5))).toBe("2026-01-05");
    expect(isoTime(local(2026, 1, 5, 7, 3))).toBe("07:03");
    expect(isoTime(local(2026, 1, 5, 23, 59))).toBe("23:59");
  });

  it("parses YYYY-MM-DD as local midnight and round-trips", () => {
    const d = parseIsoDate("2026-11-09")!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(9);
    expect(d.getHours()).toBe(0);
    expect(isoDate(d)).toBe("2026-11-09");
  });

  it("rejects malformed input", () => {
    expect(parseIsoDate(undefined)).toBeNull();
    expect(parseIsoDate(null)).toBeNull();
    expect(parseIsoDate("")).toBeNull();
    expect(parseIsoDate("2026-1-9")).toBeNull();
    expect(parseIsoDate("2026-11-09T00:00:00Z")).toBeNull();
    expect(parseIsoDate("nope")).toBeNull();
  });

  it("compares by calendar day, not by instant", () => {
    expect(sameDay(local(2026, 11, 9, 0, 0), local(2026, 11, 9, 23, 59))).toBe(true);
    expect(sameDay(local(2026, 11, 9, 23, 59), local(2026, 11, 10, 0, 0))).toBe(false);
  });
});

describe("all-day date conversion", () => {
  it("shows a UTC-midnight all-day date on the same local calendar date", () => {
    const stored = new Date("2026-11-09T00:00:00Z"); // 2026-11-08 19:00 in New York
    expect(isoDate(stored)).toBe("2026-11-08"); // the naive reading is off by a day
    expect(isoDate(dateOnlyToLocal(stored))).toBe("2026-11-09");
    expect(isoTime(dateOnlyToLocal(stored))).toBe("00:00");
  });

  it("round-trips local date -> UTC midnight -> local date", () => {
    for (const d of [local(2026, 11, 9), local(2026, 11, 1), local(2026, 3, 8), local(2026, 12, 31)]) {
      const utc = localDateToUtc(d);
      expect(utc.toISOString()).toBe(`${isoDate(d)}T00:00:00.000Z`);
      expect(isoDate(dateOnlyToLocal(utc))).toBe(isoDate(d));
    }
  });
});

describe("formatting", () => {
  it("formats a week range spanning months", () => {
    expect(plain(formatWeekRange(local(2026, 10, 26)))).toBe("Oct 26 – Nov 1, 2026");
    expect(plain(formatWeekRange(local(2026, 11, 9)))).toBe("Nov 9 – 15, 2026");
  });

  it("describes all-day spans using an exclusive end", () => {
    // A single all-day event on Nov 9 ends (exclusive) at the start of Nov 10.
    expect(formatSpan(local(2026, 11, 9), local(2026, 11, 10), true)).toBe("Monday, November 9 · All day");
    expect(formatSpan(local(2026, 11, 9), local(2026, 11, 12), true)).toBe(
      "Monday, November 9 – Wednesday, November 11",
    );
  });

  it("describes timed spans on one day and across days", () => {
    expect(formatSpan(local(2026, 11, 9, 9, 30), local(2026, 11, 9, 10, 15), false)).toMatch(
      /^Monday, November 9 · 9:30\s?AM – 10:15\s?AM$/,
    );
    expect(formatSpan(local(2026, 11, 9, 22), local(2026, 11, 10, 1), false)).toMatch(
      /^Monday, November 9 10:00\s?PM – Tuesday, November 10 1:00\s?AM$/,
    );
  });
});
