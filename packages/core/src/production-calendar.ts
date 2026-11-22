import { z } from "zod";
import { isoWeekdayOf } from "./quality";
import { addDays } from "./stock";

/**
 * Production working-day calendar: dates the workspace, or one production line, does not produce
 * (bank holidays, a shutdown, a line down for a refit). **Advisory**: batch planning, the line
 * schedule and the cover view warn about it; nothing is refused, moved or sequenced for you.
 *
 * Every day is a working day unless listed (the schedule has always assumed that), so a weekend is
 * marked with the same form as a bank holiday: a range with `weekdays: [6, 7]`. A line's capacity
 * for a day is its hours per day on a working day and 0 on a day off. No DOM or Node APIs.
 */

// `isoWeekdayOf` (1 = Monday … 7 = Sunday) lives in ./quality and is exported from there.

export const isoWeekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Most days one request can add (a year's worth of Saturdays and Sundays, or a long shutdown). */
export const NON_WORKING_MAX_DAYS = 366;
/** Longest window `GET /production/calendar` reads. */
export const CALENDAR_MAX_DAYS = 731;

const isoDate = z.iso.date();
const dayCount = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

const reasonText = z
  .string()
  .trim()
  .max(200)
  .transform((v) => v || null)
  .nullable();

/**
 * Marks days as non-working: every date from `from` to `to` (default: `from` alone), optionally only
 * on some weekdays (`weekdays: [6, 7]` is weekends), for the whole workspace or one line. Dates that
 * are already marked for that scope are left as they are, so the request can be repeated.
 */
export const nonWorkingDaysAddSchema = z
  .object({
    from: isoDate,
    to: isoDate.optional(),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    /** A production line; omit for the whole workspace. */
    lineId: z.uuid().nullable().optional(),
    reason: reasonText.optional(),
  })
  .refine((v) => (v.to ?? v.from) >= v.from, { path: ["to"], message: "`to` is before `from`" })
  .refine((v) => dayCount(v.from, v.to ?? v.from) <= NON_WORKING_MAX_DAYS, {
    path: ["to"],
    message: `At most ${NON_WORKING_MAX_DAYS} days at a time`,
  });
export type NonWorkingDaysAddInput = z.infer<typeof nonWorkingDaysAddSchema>;

/** The dates a request marks, in order. */
export function expandNonWorkingDates(
  input: Pick<NonWorkingDaysAddInput, "from" | "to" | "weekdays">,
): string[] {
  const out: string[] = [];
  const to = input.to ?? input.from;
  for (let d = input.from; d <= to; d = addDays(d, 1)) {
    if (!input.weekdays || input.weekdays.includes(isoWeekdayOf(d))) out.push(d);
  }
  return out;
}

export const calendarQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    /** Only this line's days (and the workspace's). */
    lineId: z.uuid().optional(),
  })
  .refine((v) => v.from <= v.to, { path: ["to"], message: "`to` is before `from`" })
  .refine((v) => dayCount(v.from, v.to) <= CALENDAR_MAX_DAYS, {
    path: ["to"],
    message: `At most ${CALENDAR_MAX_DAYS} days at a time`,
  });
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;

/** A day off. `lineId` null: the whole workspace. */
export interface NonWorkingDay {
  id: string;
  date: string;
  lineId: string | null;
  reason: string | null;
}

/** Why a day is not a working day: the workspace's calendar, or the line's own. */
export interface DayOff {
  scope: "workspace" | "line";
  reason: string | null;
}

/** A lookup over days off: is a date (for a line, or the workspace) a day off? */
export interface WorkingCalendar {
  /** The day off for the workspace (line omitted) or a line (the line's own, else the workspace's). */
  dayOff(date: string, lineId?: string | null): DayOff | null;
}

/** Builds the lookup from the rows. A line's own entry wins over the workspace's for the reason shown. */
export function workingCalendar(
  days: readonly Pick<NonWorkingDay, "date" | "lineId" | "reason">[],
): WorkingCalendar {
  const workspace = new Map<string, string | null>();
  const lines = new Map<string, Map<string, string | null>>();
  for (const d of days) {
    if (d.lineId === null) workspace.set(d.date, d.reason);
    else {
      const map = lines.get(d.lineId) ?? new Map<string, string | null>();
      map.set(d.date, d.reason);
      lines.set(d.lineId, map);
    }
  }
  return {
    dayOff(date, lineId) {
      if (lineId) {
        const own = lines.get(lineId);
        if (own?.has(date)) return { scope: "line", reason: own.get(date) ?? null };
      }
      return workspace.has(date) ? { scope: "workspace", reason: workspace.get(date) ?? null } : null;
    },
  };
}

/** The days of `from..to` that are working days for a line (or the workspace). */
export function workingDaysIn(
  calendar: WorkingCalendar,
  days: readonly string[],
  lineId?: string | null,
): string[] {
  return days.filter((d) => calendar.dayOff(d, lineId) === null);
}

/** "Planned on 2026-12-25 (Christmas Day): a non-working day." */
export function dayOffWarning(date: string, off: DayOff, lineName?: string | null): string {
  const why = off.reason ? ` (${off.reason})` : "";
  return off.scope === "line" && lineName
    ? `${date} is a non-working day for ${lineName}${why}`
    : `${date} is a non-working day${why}`;
}
