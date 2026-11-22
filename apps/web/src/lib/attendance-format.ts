import { addDays, formatUkDateTime, weekStartInZone } from "@knotworking/core";

/** Formatting for attendance pages: times in the site's time zone, hours as "7h 30m". */

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

/** "07:58" in the site's time zone. */
export function siteTime(at: string | Date | null | undefined, timeZone: string) {
  if (!at) return "—";
  let f = timeFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" });
    timeFormatters.set(timeZone, f);
  }
  return f.format(new Date(at));
}

/** "02/03/2026 07:58" (UK date, 24-hour time) in the site's time zone. */
export function siteDateTime(at: string | Date | null | undefined, timeZone: string) {
  return at ? formatUkDateTime(at, timeZone) : "—";
}

/** 450 → "7h 30m"; 0 → "0h". */
export function hoursAndMinutes(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Monday and Sunday of the week `offsetWeeks` from this one, in the workspace's time zone. */
export function weekRange(timeZone: string, offsetWeeks = 0, now: Date = new Date()) {
  const monday = addDays(weekStartInZone(now, timeZone), offsetWeeks * 7);
  return { from: monday, to: addDays(monday, 6) };
}
