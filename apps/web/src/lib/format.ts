import {
  dateInZone,
  formatMoney as formatMoneyIn,
  formatUkDate,
  formatUkDateTime,
  formatUkDayMonth,
  zoneLabel,
  type MoneyFormatOptions,
} from "@knotworking/core";

/**
 * The one place dates, times and money are written for people. Dates are UK: day first, numeric
 * (`08/11/2026`), times 24-hour (`12:41`), money in the workspace's currency (`£1,234.50`). The
 * wording itself lives in `@knotworking/core` (`format-date.ts`, `currency.ts`) so the server and
 * other clients write the same.
 *
 * A date-only value (`YYYY-MM-DD`) is a calendar day and is shown as it is. A timestamp is an
 * instant, so the day it falls on depends on the zone: pass the workspace's (UTC by default) so a
 * timestamp shows the same day as the zone-aware due dates beside it, on server and browser alike.
 */

/** Date-only (YYYY-MM-DD) or ISO timestamp → "08/11" (a timestamp's day is in `timeZone`). */
export function formatShortDate(value: string | null | undefined, timeZone = "UTC") {
  return formatUkDayMonth(value, timeZone);
}

/** Date-only (YYYY-MM-DD) or ISO timestamp → "08/11/2026" (a timestamp's day is in `timeZone`). */
export function formatLongDate(value: string | null | undefined, timeZone = "UTC") {
  return formatUkDate(value, timeZone);
}

/** A due date (a calendar day) has passed: it is before today in `timeZone` (the workspace's). */
export function isOverdue(dueDate: string | null | undefined, now = new Date(), timeZone = "UTC") {
  return Boolean(dueDate && dueDate < dateInZone(now, timeZone));
}

/**
 * ISO timestamp → "08/11/2026 12:41 GMT" in a time zone (pass the workspace's; UTC by default), so
 * server and browser render the same.
 */
export function formatDateTime(value: string | Date | null | undefined, timeZone = "UTC") {
  return formatUkDateTime(value, timeZone, { zone: true });
}

export { zoneLabel };

// ─── Money ───────────────────────────────────────────────────────────────────

/**
 * An amount in the workspace's currency (`useWorkspaceCurrency()` in client components,
 * `getWorkspaceCurrency(slug)` in server ones): `£1,234.50`, at least the currency's own decimals
 * and up to 4 where a figure needs them. A missing value is "—".
 */
export function formatMoney(
  value: number | null | undefined,
  currency: string,
  options?: MoneyFormatOptions,
) {
  return value === null || value === undefined ? "—" : formatMoneyIn(value, currency, options);
}

/** A price per unit (up to the 8 places a per-gram price may need): `£0.00345`. */
export const formatUnitMoney = (value: number | null | undefined, currency: string) =>
  formatMoney(value, currency, { maxDecimals: 8 });
