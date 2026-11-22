/** Local-time date helpers for the calendar (weeks start on Monday). */

export const HOUR_PX = 48;

export function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function startOfWeek(d: Date) {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7; // Monday = 0
  return addDays(x, -dow);
}

/** "2026-11-09" in local time. */
export function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Parses "2026-11-09" as local midnight. */
export function parseIsoDate(s: string | undefined | null) {
  const m = s && /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export function isoTime(d: Date) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const sameDay = (a: Date, b: Date) => isoDate(a) === isoDate(b);

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const longFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const rangeFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

export const formatTime = (d: Date) => timeFmt.format(d);
export const formatWeekday = (d: Date) => dayFmt.format(d);
export const formatLongDate = (d: Date) => longFmt.format(d);
export const formatWeekRange = (start: Date) => `${rangeFmt.formatRange(start, addDays(start, 6))}`;

export function formatSpan(start: Date, end: Date, allDay: boolean) {
  if (allDay) {
    const last = addDays(end, -1);
    return sameDay(start, last)
      ? `${formatLongDate(start)} · All day`
      : `${formatLongDate(start)} – ${formatLongDate(last)}`;
  }
  return sameDay(start, end)
    ? `${formatLongDate(start)} · ${formatTime(start)} – ${formatTime(end)}`
    : `${formatLongDate(start)} ${formatTime(start)} – ${formatLongDate(end)} ${formatTime(end)}`;
}

/**
 * All-day events are stored as UTC midnight of their date. Shows them on that
 * same calendar date in local time (never shifted by the time zone).
 */
export const dateOnlyToLocal = (d: Date) => new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** The UTC-midnight instant for a local calendar date (how all-day dates are sent). */
export const localDateToUtc = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
