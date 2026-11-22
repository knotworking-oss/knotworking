import { describe, expect, it } from "vitest";
import {
  csvDownloadPath,
  filtersToApiQuery,
  filtersToSearch,
  formatReportRange,
  parseReportFilters,
  presetRange,
  type ReportFilters,
} from "./time-report";

const ID = "01900000-0000-7000-8000-000000000000";
/** An instant at 15:30 UTC on a date; presets are worked out in the zone passed alongside. */
const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 15, 30));
const UTC = "UTC";

describe("report presets", () => {
  it("runs weeks Monday to Sunday", () => {
    // Monday 9 Nov 2026
    expect(presetRange("this-week", day(2026, 11, 9), UTC)).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    expect(presetRange("last-week", day(2026, 11, 9), UTC)).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    // Wednesday and Sunday of the week of 2 Nov
    expect(presetRange("this-week", day(2026, 11, 4), UTC)).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(presetRange("this-week", day(2026, 11, 8), UTC)).toEqual({ from: "2026-11-02", to: "2026-11-08" });
  });

  it("handles weeks and months that cross a year or a leap day", () => {
    expect(presetRange("this-week", day(2026, 1, 1), UTC)).toEqual({ from: "2025-12-29", to: "2026-01-04" });
    expect(presetRange("last-week", day(2026, 1, 1), UTC)).toEqual({ from: "2025-12-22", to: "2025-12-28" });
    expect(presetRange("this-month", day(2026, 12, 31), UTC)).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(presetRange("this-month", day(2028, 2, 10), UTC)).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
    expect(presetRange("this-month", day(2026, 2, 10), UTC)).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });

  it("stays on the right day around a daylight-saving change", () => {
    expect(presetRange("this-week", day(2026, 3, 29), UTC)).toEqual({ from: "2026-03-23", to: "2026-03-29" });
    expect(presetRange("last-week", day(2026, 11, 2), UTC)).toEqual({ from: "2026-10-26", to: "2026-11-01" });
  });
});

describe("report presets in the workspace's zone", () => {
  it("decides the day in the workspace zone, not the browser's", () => {
    // 23:30 UTC on Sunday 8 Nov is already Monday 9 Nov in Auckland and still Sunday in New York.
    const instant = new Date("2026-11-08T23:30:00Z");
    expect(presetRange("this-week", instant, "Pacific/Auckland")).toEqual({
      from: "2026-11-09",
      to: "2026-11-15",
    });
    expect(presetRange("this-week", instant, "America/New_York")).toEqual({
      from: "2026-11-02",
      to: "2026-11-08",
    });
    // 23:30 UTC on 30 Nov is already December in Auckland.
    const monthEnd = new Date("2026-11-30T23:30:00Z");
    expect(presetRange("this-month", monthEnd, "Pacific/Auckland")).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(presetRange("this-month", monthEnd, "America/New_York")).toEqual({
      from: "2026-11-01",
      to: "2026-11-30",
    });
  });
});

describe("report filters from the URL", () => {
  const today = day(2026, 11, 9);

  it("defaults to this week, grouped by project", () => {
    expect(parseReportFilters({}, today, UTC)).toEqual({
      error: null,
      filters: {
        preset: "this-week",
        from: "2026-11-09",
        to: "2026-11-15",
        projectId: undefined,
        teamId: undefined,
        userId: undefined,
        groupBy: "project",
      },
    });
  });

  it("resolves presets against today and reads the filters", () => {
    const { filters, error } = parseReportFilters(
      { preset: "last-week", project: ID, team: ID, person: ID, groupBy: "person" },
      today,
      UTC,
    );
    expect(error).toBeNull();
    expect(filters).toMatchObject({
      preset: "last-week",
      from: "2026-11-02",
      to: "2026-11-08",
      projectId: ID,
      teamId: ID,
      userId: ID,
      groupBy: "person",
    });
  });

  it("takes custom dates, and treats bare from/to as custom", () => {
    expect(
      parseReportFilters({ preset: "custom", from: "2026-10-01", to: "2026-10-15" }, today, UTC).filters,
    ).toMatchObject({
      preset: "custom",
      from: "2026-10-01",
      to: "2026-10-15",
    });
    expect(parseReportFilters({ from: "2026-10-01", to: "2026-10-15" }, today, UTC).filters.preset).toBe(
      "custom",
    );
  });

  it("falls back to this week and explains when the range or a filter is invalid", () => {
    for (const params of [
      { preset: "custom", from: "2026-10-15", to: "2026-10-01" },
      { preset: "custom", from: "2026-10-01" },
      { preset: "custom", from: "2020-01-01", to: "2026-10-01" },
      { project: "nope" },
      { groupBy: "week" },
    ]) {
      const { filters, error } = parseReportFilters(params, today, UTC);
      expect(error, JSON.stringify(params)).toEqual(expect.any(String));
      expect(filters).toMatchObject({ preset: "this-week", from: "2026-11-09", groupBy: "project" });
      expect(filters.projectId).toBeUndefined();
    }
  });

  it("ignores an unknown preset and uses the first of repeated parameters", () => {
    expect(parseReportFilters({ preset: "yesterday" }, today, UTC).filters.preset).toBe("this-week");
    expect(parseReportFilters({ groupBy: ["day", "task"] }, today, UTC).filters.groupBy).toBe("day");
  });
});

describe("report URLs", () => {
  const filters: ReportFilters = {
    preset: "this-week",
    from: "2026-11-09",
    to: "2026-11-15",
    groupBy: "project",
  };

  it("leaves defaults out of the page URL and round-trips the rest", () => {
    expect(filtersToSearch(filters)).toBe("");
    const full: ReportFilters = {
      preset: "custom",
      from: "2026-10-01",
      to: "2026-10-15",
      projectId: ID,
      teamId: ID,
      userId: ID,
      groupBy: "day",
    };
    const search = filtersToSearch(full);
    expect(
      parseReportFilters(Object.fromEntries(new URLSearchParams(search)), day(2026, 11, 9), UTC).filters,
    ).toEqual(full);
    expect(filtersToSearch({ ...filters, preset: "this-month" })).toBe("preset=this-month");
  });

  it("sends concrete dates and only the filters that are set to the API", () => {
    expect(filtersToApiQuery(filters)).toEqual({ from: "2026-11-09", to: "2026-11-15", groupBy: "project" });
    expect(filtersToApiQuery({ ...filters, userId: ID })).toMatchObject({ userId: ID });
  });

  it("builds the CSV download URL on the web app's API proxy, without a grouping", () => {
    expect(csvDownloadPath("acme", { ...filters, userId: ID, groupBy: "person" })).toBe(
      `/api/v1/workspaces/acme/time-report.csv?from=2026-11-09&to=2026-11-15&userId=${ID}`,
    );
  });
});

describe("report labels", () => {
  it("formats ranges, with the year once or on both ends", () => {
    expect(formatReportRange("2026-11-02", "2026-11-08")).toBe("02/11 – 08/11/2026");
    expect(formatReportRange("2026-11-02", "2026-11-02")).toBe("02/11/2026");
    expect(formatReportRange("2025-12-29", "2026-01-04")).toBe("29/12/2025 – 04/01/2026");
  });
});
