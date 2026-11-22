import { z } from "zod";
import { weekStart } from "./demand";
import { addDays } from "./stock";

/**
 * The workspace time zone: one IANA zone per workspace that decides every business date ("today",
 * due dates, report periods, print ranges). Instants are stored in UTC (`timestamptz`); only the
 * step from an instant to a calendar date, or from a calendar date to the instants it spans, goes
 * through these helpers. No DOM or Node APIs: `Intl` only, so desktop and mobile can share them.
 *
 * Calendar dates are plain `YYYY-MM-DD` strings, compared as strings.
 */

/** Every workspace starts in this zone until an owner or admin changes it. */
export const DEFAULT_TIME_ZONE = "Europe/London";

let supported: Set<string> | null = null;

/** IANA zones this runtime knows (`Intl.supportedValuesOf`), plus `UTC`. Empty when the runtime can't list them. */
export function supportedTimeZones(): string[] {
  const list =
    typeof Intl.supportedValuesOf === "function" ? (Intl.supportedValuesOf("timeZone") as string[]) : [];
  return list.includes("UTC") || list.length === 0 ? list : [...list, "UTC"];
}

/** Whether `Intl` accepts the zone at all (aliases such as `Europe/Kiev` included). */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The name `Intl` resolves a zone to (`Asia/Kolkata` may resolve to `Asia/Calcutta`), or null. */
function resolvedZone(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * Whether `zone` is one of `Intl.supportedValuesOf("timeZone")` (or `UTC`), directly or as a name
 * `Intl` resolves to one of them (runtimes list some zones under their older names, such as
 * `Asia/Calcutta` for `Asia/Kolkata`). Offsets (`+01:00`) and abbreviations (`BST`) are refused. On a
 * runtime that can't list zones it falls back to whether `Intl` accepts it.
 */
export function isSupportedTimeZone(zone: string): boolean {
  supported ??= new Set(supportedTimeZones());
  if (supported.size === 0) return isTimeZone(zone);
  if (supported.has(zone)) return true;
  const resolved = resolvedZone(zone);
  return resolved !== null && supported.has(resolved) && /^[A-Za-z]+\/[A-Za-z0-9_/+-]+$/.test(zone);
}

let byLowerCase: Map<string, string> | null = null;

/**
 * The listed, correctly cased name for a zone: a case-insensitive match in `supportedTimeZones()`,
 * else the listed name `Intl` resolves it to (`asia/kolkata` is stored as `Asia/Calcutta` where the
 * runtime lists that spelling). Null when the zone isn't supported. On a runtime that can't list
 * zones, the name `Intl` resolves to.
 */
export function canonicalTimeZone(zone: string): string | null {
  if (!isSupportedTimeZone(zone)) return null;
  byLowerCase ??= new Map(supportedTimeZones().map((z) => [z.toLowerCase(), z]));
  const resolved = resolvedZone(zone);
  return (
    byLowerCase.get(zone.toLowerCase()) ??
    (resolved !== null ? (byLowerCase.get(resolved.toLowerCase()) ?? resolved) : zone)
  );
}

/**
 * The zone to use for a stored value: itself when it is a valid zone under `timeZoneSchema`, else
 * `DEFAULT_TIME_ZONE`. Guards against free text copied from the old attendance setting (`GMT`,
 * `utc`, `+01:00`, `Etc/GMT+5`).
 */
export function effectiveTimeZone(stored: string | null | undefined): { timeZone: string; invalid: boolean } {
  if (stored == null) return { timeZone: DEFAULT_TIME_ZONE, invalid: false };
  const parsed = timeZoneSchema.safeParse(stored);
  return parsed.success
    ? { timeZone: stored, invalid: false }
    : { timeZone: DEFAULT_TIME_ZONE, invalid: true };
}

/** An IANA zone name, validated with `isSupportedTimeZone` and stored as the listed, correctly cased name. */
export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isSupportedTimeZone, "Unknown time zone: use an IANA name such as Europe/London")
  .transform((zone) => canonicalTimeZone(zone) ?? zone);

// ─── Instants to calendar dates ──────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

const toMs = (at: Date | string | number) =>
  typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : at.getTime();

/** The wall-clock time of an instant in a zone, as milliseconds of a UTC date with the same fields. */
function wallClock(ms: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}

/** The zone's offset from UTC at an instant, in minutes (London in summer: 60). */
export function timeZoneOffsetMinutes(at: Date | string | number, zone: string): number {
  const ms = toMs(at);
  const whole = ms - (((ms % 1000) + 1000) % 1000);
  return Math.round((wallClock(whole, zone) - whole) / 60_000);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The calendar date (`YYYY-MM-DD`) an instant falls on in a zone. */
export function dateInZone(at: Date | string | number, zone: string): string {
  const wall = new Date(wallClock(toMs(at), zone));
  return `${pad(wall.getUTCFullYear(), 4)}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`;
}

/** Today's date (`YYYY-MM-DD`) in a zone. */
export const todayInZone = (zone: string, now: Date | number = Date.now()): string => dateInZone(now, zone);

// ─── Calendar dates to instants ──────────────────────────────────────────────

const HOUR = 3_600_000;

/**
 * The first instant of a local calendar day. Normally local midnight; on a day whose midnight
 * doesn't exist (a zone that springs forward at 00:00) the moment the clocks jump.
 */
export function startOfDayInZone(date: string, zone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const local = Date.UTC(y!, m! - 1, d!);
  // The offsets either side of the day cover any transition on it (transitions are months apart).
  const candidates = [
    ...new Set([-36, 36].map((h) => local - timeZoneOffsetMinutes(local + h * HOUR, zone) * 60_000)),
  ];
  const exact = candidates.filter((t) => wallClock(t, zone) === local);
  if (exact.length) return new Date(Math.min(...exact));
  // Midnight falls in a gap: find when the day begins (to the minute).
  let lo = Math.min(...candidates) - 2 * HOUR;
  let hi = Math.max(...candidates) + 2 * HOUR;
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
    if (dateInZone(mid, zone) >= date) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

/** The instant a local calendar day ends: the start of the next day (exclusive). */
export const endOfDayInZone = (date: string, zone: string): Date => startOfDayInZone(addDays(date, 1), zone);

/**
 * The instants an inclusive range of local dates spans: `start` inclusive, `end` exclusive. For
 * `where at >= start and at < end` filters (prints, audit records, reports).
 */
export function dateRangeInZone(from: string, to: string, zone: string): { start: Date; end: Date } {
  return { start: startOfDayInZone(from, zone), end: endOfDayInZone(to, zone) };
}

// ─── Weeks and months ────────────────────────────────────────────────────────

/** The Monday of the ISO week an instant falls in, in a zone. */
export const weekStartInZone = (at: Date | string | number, zone: string): string =>
  weekStart(dateInZone(at, zone));

/** The first of the month (`YYYY-MM-01`) an instant falls in, in a zone. */
export const monthStartInZone = (at: Date | string | number, zone: string): string =>
  `${dateInZone(at, zone).slice(0, 7)}-01`;

/** The first day of the month after the one `date` falls in. */
function nextMonthStart(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m === 12 ? `${pad(y + 1, 4)}-01-01` : `${pad(y, 4)}-${pad(m + 1)}-01`;
}

/**
 * The ISO week (Monday to Sunday) a local date falls in: its first and last dates, and the instants
 * it spans in the zone (`end` exclusive). A week with a clock change is 167 or 169 hours long.
 */
export function isoWeekInZone(date: string, zone: string) {
  const first = weekStart(date);
  const last = addDays(first, 6);
  return { first, last, start: startOfDayInZone(first, zone), end: endOfDayInZone(last, zone) };
}

/** The calendar month a local date falls in: its first and last dates, and the instants it spans in the zone. */
export function monthInZone(date: string, zone: string) {
  const first = `${date.slice(0, 7)}-01`;
  const next = nextMonthStart(first);
  return {
    first,
    last: addDays(next, -1),
    start: startOfDayInZone(first, zone),
    end: startOfDayInZone(next, zone),
  };
}
