/**
 * Time tracking helpers shared by the server and every client: durations are
 * whole minutes everywhere (entries, timers and task time estimates).
 */

/** Longest single time entry: one day. A timer left running longer is capped here when stopped. */
export const TIME_ENTRY_MAX_MINUTES = 24 * 60;

/** Largest time estimate on a task: 1,000 hours. */
export const TASK_ESTIMATE_MAX_MINUTES = 1000 * 60;

/** Longest note on a time entry. */
export const TIME_ENTRY_NOTE_MAX = 500;

/**
 * Minutes a timer started at `startedAt` has run by `now`: rounded to the nearest
 * minute, at least 1 and at most `TIME_ENTRY_MAX_MINUTES`.
 */
export function timerMinutes(startedAt: Date | string, now: Date = new Date()): number {
  const ms = now.getTime() - new Date(startedAt).getTime();
  return Math.min(TIME_ENTRY_MAX_MINUTES, Math.max(1, Math.round(ms / 60_000)));
}

/** `90` → "1h 30m", `45` → "45m", `120` → "2h", `0` → "0m". */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Parses a duration typed by a person into whole minutes, or null when it can't be read.
 * Accepts "90" (minutes), "1:30", "1h 30m", "1h30", "1.5h", "2h", "45m", "45 min".
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  let minutes: number;
  const clock = /^(\d+):([0-5]\d)$/.exec(text);
  if (clock) {
    minutes = Number(clock[1]) * 60 + Number(clock[2]);
  } else if (/^\d+$/.test(text)) {
    minutes = Number(text);
  } else {
    const parts = /^(?:(\d+(?:[.,]\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*(?:m(?:in(?:utes?|s)?)?)?)?$/.exec(
      text,
    );
    if (!parts || (parts[1] === undefined && parts[2] === undefined)) return null;
    // A bare trailing number after hours ("1h30") is minutes; on its own it was handled above.
    minutes = Number((parts[1] ?? "0").replace(",", ".")) * 60 + Number(parts[2] ?? 0);
  }
  if (!Number.isFinite(minutes)) return null;
  const rounded = Math.round(minutes);
  return rounded > 0 ? rounded : null;
}

/** Longest date range a time report covers (inclusive days): one year, with a day of slack for leap years. */
export const TIME_REPORT_MAX_DAYS = 366;

/** How a time report splits the logged time. */
export const timeReportGroupBys = ["project", "person", "task", "day"] as const;
export type TimeReportGroupBy = (typeof timeReportGroupBys)[number];

/** Whole days from `from` to `to` (both `YYYY-MM-DD`), counting both ends: a single day is 1. */
export function inclusiveDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Minutes as decimal hours with two places ("1.50"), for spreadsheets. */
export function minutesToHours(minutes: number): string {
  return (Math.round((minutes / 60) * 100) / 100).toFixed(2);
}

/** How logged time compares with an estimate: over, under or exactly on it. */
export type EstimateState = "over" | "under" | "on";

/** `logged - estimate` and which side of the estimate that is. Positive minutes are an overrun. */
export function estimateVariance(
  logged: number,
  estimate: number,
): { minutes: number; state: EstimateState } {
  const minutes = logged - estimate;
  return { minutes, state: minutes > 0 ? "over" : minutes < 0 ? "under" : "on" };
}

/** `15` → "+15m over", `-90` → "1h 30m under", `0` → "on estimate". */
export function formatVariance(minutes: number): string {
  if (minutes === 0) return "on estimate";
  return minutes > 0 ? `+${formatMinutes(minutes)} over` : `${formatMinutes(-minutes)} under`;
}

/** Today's date (YYYY-MM-DD) in the runtime's local time zone, for `entryDate`. */
export function localIsoDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
