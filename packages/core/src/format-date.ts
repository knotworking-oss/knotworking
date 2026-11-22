import { dateInZone } from "./time-zone";

/**
 * UK date and time wording, one place for the whole product: `08/11/2026` (day first, numeric,
 * four-digit year) and 24-hour times `12:41`. A date-only value (`YYYY-MM-DD`) is a calendar day
 * and is shown as it is; a timestamp is an instant, so the day (and time) depend on the zone:
 * pass the workspace's, so server and browser render the same. `Intl` only, no DOM or Node APIs.
 */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
function timeFormatter(timeZone: string) {
  let f = timeFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    timeFormatters.set(timeZone, f);
  }
  return f;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
/** The zone's short name at an instant, as people in the UK write it: "GMT", "BST", "UTC", "CET". */
export function zoneLabel(at: Date, timeZone: string): string {
  let f = zoneFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" });
    zoneFormatters.set(timeZone, f);
  }
  return f.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}

type DateInput = string | Date | null | undefined;

/** Year, month and day of a calendar day, or of an instant in `timeZone`; null when unparseable. */
function dayParts(value: string | Date, timeZone: string): { y: string; m: string; d: string } | null {
  if (typeof value === "string") {
    const iso = ISO_DAY.exec(value);
    if (iso) return { y: iso[1]!, m: iso[2]!, d: iso[3]! };
  }
  const at = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(at.getTime())) return null;
  const [y, m, d] = dateInZone(at, timeZone).split("-");
  return { y: y!, m: m!, d: d! };
}

/** `08/11/2026`; a timestamp's day is in `timeZone`. Empty when missing. */
export function formatUkDate(value: DateInput, timeZone = "UTC"): string {
  if (!value) return "";
  const p = dayParts(value, timeZone);
  return p ? `${p.d}/${p.m}/${p.y}` : String(value);
}

/** `08/11`: the same day without the year, for tight tables where the year is clear from the page. */
export function formatUkDayMonth(value: DateInput, timeZone = "UTC"): string {
  if (!value) return "";
  const p = dayParts(value, timeZone);
  return p ? `${p.d}/${p.m}` : String(value);
}

/** `12:41` in `timeZone` (24-hour); empty for a date-only value or nothing. */
export function formatUkTime(value: DateInput, timeZone = "UTC"): string {
  if (!value || (typeof value === "string" && ISO_DAY.test(value))) return "";
  const at = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(at.getTime()) ? "" : timeFormatter(timeZone).format(at);
}

/**
 * `08/11/2026 12:41` in `timeZone`; with `zone: true` the zone's name follows (`08/11/2026 12:41 GMT`).
 * A date-only value shows as the date.
 */
export function formatUkDateTime(
  value: DateInput,
  timeZone = "UTC",
  options: { zone?: boolean } = {},
): string {
  if (!value) return "";
  if (typeof value === "string" && ISO_DAY.test(value)) return formatUkDate(value);
  const at = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(at.getTime())) return String(value);
  const text = `${formatUkDate(at, timeZone)} ${formatUkTime(at, timeZone)}`;
  return options.zone ? `${text} ${zoneLabel(at, timeZone)}` : text;
}
