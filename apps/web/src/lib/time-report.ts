import {
  addDays,
  monthInZone,
  timeReportQuerySchema,
  todayInZone,
  weekStartInZone,
  type TimeReportGroupBy,
} from "@knotworking/core";
import { formatLongDate, formatShortDate } from "./format";

/** The report page's filters. The date range is either a preset (relative to today) or custom. */
export const reportPresets = ["this-week", "last-week", "this-month", "custom"] as const;
export type ReportPreset = (typeof reportPresets)[number];

export const reportPresetLabels: Record<ReportPreset, string> = {
  "this-week": "This week",
  "last-week": "Last week",
  "this-month": "This month",
  custom: "Custom",
};

export const groupByLabels: Record<TimeReportGroupBy, string> = {
  project: "Project",
  person: "Person",
  task: "Task",
  day: "Day",
};

export interface ReportFilters {
  preset: ReportPreset;
  /** Inclusive `YYYY-MM-DD`; for a preset these are the preset's days. */
  from: string;
  to: string;
  projectId?: string | undefined;
  teamId?: string | undefined;
  userId?: string | undefined;
  groupBy: TimeReportGroupBy;
}

const DEFAULT_PRESET: Exclude<ReportPreset, "custom"> = "this-week";
const DEFAULT_GROUP_BY: TimeReportGroupBy = "project";

/**
 * The days a preset covers, as seen from `now` in the workspace's time zone (never the browser's).
 * Weeks run Monday to Sunday, so "this week" includes days that haven't happened yet (they simply
 * have no time).
 */
export function presetRange(
  preset: Exclude<ReportPreset, "custom">,
  now: Date,
  timeZone: string,
): { from: string; to: string } {
  if (preset === "this-month") {
    const { first, last } = monthInZone(todayInZone(timeZone, now), timeZone);
    return { from: first, to: last };
  }
  const monday = addDays(weekStartInZone(now, timeZone), preset === "last-week" ? -7 : 0);
  return { from: monday, to: addDays(monday, 6) };
}

type Params = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) || undefined;

/**
 * Reads the page's filters from the URL. Presets are resolved against `today` in the workspace's `timeZone`; a custom range
 * (or any other malformed value) that the API would refuse falls back to this week with no
 * filters and an `error` to show. Every state is one URL, so a report can be shared and reloaded.
 *
 * URL: `?preset=last-week|this-week|this-month|custom&from=&to=&project=&team=&person=&groupBy=`.
 */
export function parseReportFilters(
  params: Params,
  today: Date,
  timeZone: string,
): { filters: ReportFilters; error: string | null } {
  const presetParam = first(params.preset);
  const hasCustomDates = Boolean(first(params.from) || first(params.to));
  const preset: ReportPreset = (reportPresets as readonly string[]).includes(presetParam ?? "")
    ? (presetParam as ReportPreset)
    : hasCustomDates
      ? "custom"
      : DEFAULT_PRESET;
  const range =
    preset === "custom"
      ? { from: first(params.from) ?? "", to: first(params.to) ?? "" }
      : presetRange(preset, today, timeZone);
  const groupParam = first(params.groupBy);
  const candidate = {
    from: range.from,
    to: range.to,
    groupBy: groupParam ?? DEFAULT_GROUP_BY,
    ...(first(params.project) ? { projectId: first(params.project) } : {}),
    ...(first(params.team) ? { teamId: first(params.team) } : {}),
    ...(first(params.person) ? { userId: first(params.person) } : {}),
  };
  const parsed = timeReportQuerySchema.safeParse(candidate);
  if (!parsed.success) {
    const fallback = presetRange(DEFAULT_PRESET, today, timeZone);
    return {
      error: parsed.error.issues[0]?.message ?? "Those filters aren't valid.",
      filters: { preset: DEFAULT_PRESET, ...fallback, groupBy: DEFAULT_GROUP_BY },
    };
  }
  const { projectId, teamId, userId, groupBy } = parsed.data;
  return {
    error: null,
    filters: { preset, from: range.from, to: range.to, projectId, teamId, userId, groupBy },
  };
}

/** The page URL's query string for some filters. Defaults are left out to keep links short. */
export function filtersToSearch(filters: ReportFilters): string {
  const q = new URLSearchParams();
  if (filters.preset !== DEFAULT_PRESET) q.set("preset", filters.preset);
  if (filters.preset === "custom") {
    q.set("from", filters.from);
    q.set("to", filters.to);
  }
  if (filters.projectId) q.set("project", filters.projectId);
  if (filters.teamId) q.set("team", filters.teamId);
  if (filters.userId) q.set("person", filters.userId);
  if (filters.groupBy !== DEFAULT_GROUP_BY) q.set("groupBy", filters.groupBy);
  return q.toString();
}

/** The API's query for these filters (`GET /time-report` and `.csv`). Always concrete dates. */
export function filtersToApiQuery(filters: ReportFilters) {
  return {
    from: filters.from,
    to: filters.to,
    groupBy: filters.groupBy,
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.teamId ? { teamId: filters.teamId } : {}),
    ...(filters.userId ? { userId: filters.userId } : {}),
  };
}

/**
 * Where the CSV export downloads from: the web app's own `/api/*` proxy (same origin, so the
 * session cookie goes along, and the proxy passes `Content-Disposition` through). The CSV is one
 * row per entry whatever the grouping, so `groupBy` is left out.
 */
export function csvDownloadPath(slug: string, filters: ReportFilters): string {
  const { groupBy: _ignored, ...query } = filtersToApiQuery(filters);
  return `/api/v1/workspaces/${encodeURIComponent(slug)}/time-report.csv?${new URLSearchParams(query).toString()}`;
}

/** "Nov 2 – Nov 8, 2026" (the year once, or on both ends across New Year); one day shows just that day. */
export function formatReportRange(from: string, to: string): string {
  if (from === to) return formatLongDate(from);
  return from.slice(0, 4) === to.slice(0, 4)
    ? `${formatShortDate(from)} – ${formatLongDate(to)}`
    : `${formatLongDate(from)} – ${formatLongDate(to)}`;
}
