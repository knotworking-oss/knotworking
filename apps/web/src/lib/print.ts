import { dateInZone, formatUkDate, formatUkDateTime } from "@knotworking/core";

/**
 * Helpers for the print-ready pages: UK date wording (08/11/2026, 24-hour times), the `from`/`to` range a record print takes
 * from its query string, and picking records out of that range. Pure, so server and browser
 * render the same. Timestamps print in the workspace's time zone (pass it; UTC otherwise);
 * calendar dates (`YYYY-MM-DD`) print as they are.
 */

/** A date or timestamp as "08/11/2026" (a timestamp on its day in `timeZone`); "—" when missing. */
export function printDate(value: string | Date | null | undefined, timeZone = "UTC"): string {
  return value ? formatUkDate(value, timeZone) : "—";
}

/** A timestamp as "08/11/2026 12:41 GMT" in `timeZone`; a date-only value prints as the date. */
export function printDateTime(value: string | Date | null | undefined, timeZone = "UTC"): string {
  return value ? formatUkDateTime(value, timeZone, { zone: true }) : "—";
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` that is a real calendar day, else null. */
export function validDay(value: string | string[] | undefined | null): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || !ISO_DAY.test(v)) return null;
  const date = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== v ? null : v;
}

export interface DayRange {
  from: string;
  to: string;
}

const shiftDays = (iso: string, days: number) =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The inclusive range a print asks for: `from` and `to` from the query string. A bad or missing
 * date falls back to the last 30 days ending `today` (today in the workspace's time zone); a
 * reversed range is put the right way round.
 */
export function parseDayRange(
  query: { from?: string | string[] | undefined; to?: string | string[] | undefined },
  today: string,
): DayRange {
  const to = validDay(query.to) ?? today;
  const from = validDay(query.from) ?? shiftDays(to, -29);
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * Whether a date or timestamp falls on a day inside the range (ends included). A timestamp's day
 * is its date in `timeZone` (the workspace's).
 */
export function inDayRange(value: string | null | undefined, range: DayRange, timeZone = "UTC"): boolean {
  if (!value) return false;
  const d = value.length === 10 ? value : dateInZone(value, timeZone);
  return d >= range.from && d <= range.to;
}

/** "8 Nov 2026 to 7 Dec 2026". */
export const describeRange = (range: DayRange) => `${printDate(range.from)} to ${printDate(range.to)}`;
