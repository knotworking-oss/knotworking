import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIME_ZONE,
  dateInZone,
  dateRangeInZone,
  endOfDayInZone,
  isoWeekInZone,
  isSupportedTimeZone,
  monthInZone,
  monthStartInZone,
  startOfDayInZone,
  supportedTimeZones,
  effectiveTimeZone,
  timeZoneOffsetMinutes,
  timeZoneSchema,
  todayInZone,
  weekStartInZone,
} from "./time-zone";

const HOUR = 3_600_000;
const hours = (r: { start: Date; end: Date }) => (r.end.getTime() - r.start.getTime()) / HOUR;
const day = (date: string, zone: string) => ({
  start: startOfDayInZone(date, zone),
  end: endOfDayInZone(date, zone),
});

describe("time zone validation", () => {
  it("accepts IANA zones Intl lists, and UTC", () => {
    expect(DEFAULT_TIME_ZONE).toBe("Europe/London");
    for (const zone of ["Europe/London", "America/New_York", "Australia/Sydney", "Asia/Kolkata", "UTC"]) {
      expect(isSupportedTimeZone(zone)).toBe(true);
      expect(timeZoneSchema.safeParse(zone).success).toBe(true);
    }
  });

  it("stores the listed, correctly cased name, including for aliases", () => {
    const listed = new Set(supportedTimeZones());
    for (const typed of [
      "asia/kolkata",
      "Asia/Kolkata",
      "ASIA/CALCUTTA",
      "europe/london",
      "america/new_york",
    ]) {
      const stored = timeZoneSchema.parse(typed);
      expect(listed.has(stored), `${typed} -> ${stored}`).toBe(true);
    }
    expect(timeZoneSchema.parse("europe/london")).toBe("Europe/London");
    expect(timeZoneSchema.parse("asia/kolkata").toLowerCase()).toMatch(/^asia\/(kolkata|calcutta)$/);
  });

  it("falls back to the default for stored values the schema refuses", () => {
    for (const zone of ["GMT", "utc", "+01:00", "Etc/GMT+5", "", "Mars/Olympus"]) {
      expect(effectiveTimeZone(zone), zone).toEqual({ timeZone: DEFAULT_TIME_ZONE, invalid: true });
    }
    expect(effectiveTimeZone("America/New_York")).toEqual({ timeZone: "America/New_York", invalid: false });
    expect(effectiveTimeZone(undefined)).toEqual({ timeZone: DEFAULT_TIME_ZONE, invalid: false });
  });

  it("refuses made-up zones, offsets and abbreviations", () => {
    for (const zone of ["Mars/Olympus", "", "GMT+1", "BST", "london"]) {
      expect(timeZoneSchema.safeParse(zone).success).toBe(false);
    }
  });
});

describe("dates of instants", () => {
  it("a summer evening in London after 23:00 UTC is already tomorrow", () => {
    expect(dateInZone("2026-07-15T23:30:00Z", "Europe/London")).toBe("2026-07-16");
    expect(dateInZone("2026-07-15T22:59:59Z", "Europe/London")).toBe("2026-07-15");
    expect(dateInZone("2026-07-15T23:30:00Z", "UTC")).toBe("2026-07-15");
  });

  it("in winter London is on UTC", () => {
    expect(dateInZone("2026-01-15T23:30:00Z", "Europe/London")).toBe("2026-01-15");
    expect(dateInZone("2026-01-16T00:00:00Z", "Europe/London")).toBe("2026-01-16");
    expect(timeZoneOffsetMinutes("2026-01-15T12:00:00Z", "Europe/London")).toBe(0);
    expect(timeZoneOffsetMinutes("2026-07-15T12:00:00Z", "Europe/London")).toBe(60);
  });

  it("follows zones behind UTC, half-hour offsets and the date line", () => {
    expect(dateInZone("2026-07-16T03:00:00Z", "America/New_York")).toBe("2026-07-15");
    expect(dateInZone("2026-07-15T18:45:00Z", "Asia/Kolkata")).toBe("2026-07-16");
    expect(dateInZone("2026-07-15T18:29:00Z", "Asia/Kolkata")).toBe("2026-07-15");
    expect(dateInZone("2026-07-15T10:00:00Z", "Pacific/Kiritimati")).toBe("2026-07-16");
  });

  it("todayInZone reads the clock it is given", () => {
    const now = new Date("2026-11-13T23:30:00Z");
    expect(todayInZone("Europe/London", now)).toBe("2026-11-13");
    expect(todayInZone("Asia/Tokyo", now)).toBe("2026-11-14");
    expect(todayInZone("America/Los_Angeles", now)).toBe("2026-11-13");
  });
});

describe("local days", () => {
  it("an ordinary London day is 24 hours from local midnight", () => {
    const summer = day("2026-07-16", "Europe/London");
    expect(summer.start.toISOString()).toBe("2026-07-15T23:00:00.000Z");
    expect(summer.end.toISOString()).toBe("2026-07-16T23:00:00.000Z");
    expect(day("2026-01-16", "Europe/London").start.toISOString()).toBe("2026-01-16T00:00:00.000Z");
  });

  it("the UK spring change (29 March 2026) makes a 23-hour day", () => {
    const d = day("2026-03-29", "Europe/London");
    expect(d.start.toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(d.end.toISOString()).toBe("2026-03-29T23:00:00.000Z");
    expect(hours(d)).toBe(23);
    // 00:59 GMT is still the 29th; 01:00 UTC is 02:00 BST, the same day.
    expect(dateInZone("2026-03-29T00:59:00Z", "Europe/London")).toBe("2026-03-29");
    expect(dateInZone("2026-03-29T22:59:00Z", "Europe/London")).toBe("2026-03-29");
    expect(dateInZone("2026-03-29T23:00:00Z", "Europe/London")).toBe("2026-03-30");
  });

  it("the UK autumn change (25 October 2026) makes a 25-hour day", () => {
    const d = day("2026-10-25", "Europe/London");
    expect(d.start.toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(d.end.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(hours(d)).toBe(25);
    // 01:30 local happens twice; both are the 25th.
    expect(dateInZone("2026-10-25T00:30:00Z", "Europe/London")).toBe("2026-10-25");
    expect(dateInZone("2026-10-25T01:30:00Z", "Europe/London")).toBe("2026-10-25");
  });

  it("New York's changes (8 March and 1 November 2026)", () => {
    const spring = day("2026-03-08", "America/New_York");
    expect(spring.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(hours(spring)).toBe(23);
    const autumn = day("2026-11-01", "America/New_York");
    expect(autumn.start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(hours(autumn)).toBe(25);
  });

  it("the southern hemisphere: Sydney leaves summer time on 5 April 2026", () => {
    const d = day("2026-04-05", "Australia/Sydney");
    expect(d.start.toISOString()).toBe("2026-04-04T13:00:00.000Z");
    expect(d.end.toISOString()).toBe("2026-04-05T14:00:00.000Z");
    expect(hours(d)).toBe(25);
  });

  it("a day whose midnight doesn't exist starts when the clocks jump", () => {
    // Chile springs forward at midnight: 6 September 2026 starts at 01:00 local.
    const start = startOfDayInZone("2026-09-06", "America/Santiago");
    expect(dateInZone(start, "America/Santiago")).toBe("2026-09-06");
    expect(dateInZone(start.getTime() - 60_000, "America/Santiago")).toBe("2026-09-05");
    expect(hours(day("2026-09-06", "America/Santiago"))).toBe(23);
  });

  it("every day of a year starts on its own date and ends where the next begins", () => {
    for (const zone of ["Europe/London", "America/New_York", "Australia/Lord_Howe", "Asia/Kolkata"]) {
      let date = "2026-01-01";
      while (date < "2027-01-01") {
        const { start, end } = day(date, zone);
        expect(dateInZone(start, zone)).toBe(date);
        expect(dateInZone(start.getTime() - 1, zone) < date).toBe(true);
        expect(dateInZone(end.getTime() - 1, zone)).toBe(date);
        date = dateInZone(end, zone);
      }
    }
  });

  it("a range of dates spans from the first day's start to the last day's end", () => {
    const r = dateRangeInZone("2026-10-01", "2026-10-31", "Europe/London");
    expect(r.start.toISOString()).toBe("2026-09-30T23:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(hours(r)).toBe(31 * 24 + 1);
  });
});

describe("weeks and months", () => {
  it("the ISO week of an instant follows the local date", () => {
    // Sunday 23:30 UTC in summer is Monday in London: the next ISO week.
    expect(weekStartInZone("2026-07-19T23:30:00Z", "Europe/London")).toBe("2026-07-20");
    expect(weekStartInZone("2026-07-19T23:30:00Z", "UTC")).toBe("2026-07-13");
  });

  it("an ISO week with a clock change is 169 or 167 hours", () => {
    const autumn = isoWeekInZone("2026-10-22", "Europe/London");
    expect(autumn).toMatchObject({ first: "2026-10-19", last: "2026-10-25" });
    expect(autumn.start.toISOString()).toBe("2026-10-18T23:00:00.000Z");
    expect(hours(autumn)).toBe(169);
    expect(hours(isoWeekInZone("2026-03-29", "Europe/London"))).toBe(167);
    expect(hours(isoWeekInZone("2026-07-01", "Europe/London"))).toBe(168);
  });

  it("months start at local midnight on the 1st", () => {
    expect(monthStartInZone("2026-06-30T23:30:00Z", "Europe/London")).toBe("2026-07-01");
    expect(monthStartInZone("2026-06-30T23:30:00Z", "America/New_York")).toBe("2026-06-01");
    const march = monthInZone("2026-03-15", "Europe/London");
    expect(march).toMatchObject({ first: "2026-03-01", last: "2026-03-31" });
    expect(march.start.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(march.end.toISOString()).toBe("2026-03-31T23:00:00.000Z");
    expect(hours(march)).toBe(31 * 24 - 1);
    expect(monthInZone("2026-12-31", "Europe/London")).toMatchObject({
      first: "2026-12-01",
      last: "2026-12-31",
    });
    expect(monthInZone("2028-02-10", "UTC").last).toBe("2028-02-29");
  });
});
