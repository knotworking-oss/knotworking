import { z } from "zod";

/**
 * Pay periods: the stretch of days a payroll run covers, as a workspace setting (attendance
 * settings). The payroll page and the payroll file default to the last finished period instead of
 * a calendar month. Dates are local calendar days (`YYYY-MM-DD`) in the workspace's time zone, so
 * everything here is plain date arithmetic. No DOM or Node APIs.
 *
 * - `weekly`, `fortnightly` and `four_weekly` periods are 7, 14 and 28 days long and repeat from
 *   the `anchor`: the first day of any one period (a Monday, or whichever day pay weeks start).
 * - `monthly` periods start on the anchor's day of the month and end the day before the next one
 *   (anchor `2026-01-26`: 26th to 25th). No anchor means calendar months. A day past the end of a
 *   short month (the 31st in April) starts on that month's last day.
 */

export const payPeriodKinds = ["weekly", "fortnightly", "four_weekly", "monthly"] as const;
export type PayPeriodKind = (typeof payPeriodKinds)[number];

export const payPeriodLabels: Record<PayPeriodKind, string> = {
  weekly: "Weekly",
  fortnightly: "Fortnightly (every 2 weeks)",
  four_weekly: "Four-weekly",
  monthly: "Monthly",
};

/** The days in one period of the fixed-length kinds. */
const fixedDays: Record<Exclude<PayPeriodKind, "monthly">, number> = {
  weekly: 7,
  fortnightly: 14,
  four_weekly: 28,
};

export interface PayPeriodSetting {
  kind: PayPeriodKind;
  /** The first day of any period (`YYYY-MM-DD`). Needed unless monthly; monthly without one is calendar months. */
  anchor: string | null;
}

export interface PayPeriod {
  /** First day, inclusive. */
  from: string;
  /** Last day, inclusive. */
  to: string;
}

export const defaultPayPeriod: PayPeriodSetting = { kind: "monthly", anchor: null };

/** The fields of the attendance settings that make up the pay period (what the UI and API send). */
export const payPeriodSettingFields = {
  payPeriodKind: z.enum(payPeriodKinds),
  payPeriodAnchor: z.iso.date().nullable(),
};

/** Why a setting can't define periods (an anchor is needed unless monthly), or null. */
export function payPeriodProblem(setting: PayPeriodSetting): string | null {
  if (setting.kind !== "monthly" && !setting.anchor) {
    return "Pick the first day of a pay period (the anchor date) for weekly, fortnightly and four-weekly pay";
  }
  return null;
}

const DAY_MS = 86_400_000;
const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (date: string, days: number) => iso(utc(date) + days * DAY_MS);
const daysInMonth = (year: number, month0: number) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

/** The first day of the monthly period that starts in month `month0` (0-based) of `year`. */
function monthlyStart(year: number, month0: number, day: number) {
  const y = year + Math.floor(month0 / 12);
  const m = ((month0 % 12) + 12) % 12;
  return iso(Date.UTC(y, m, Math.min(day, daysInMonth(y, m))));
}

/** The pay period a local date falls in. */
export function payPeriodContaining(date: string, setting: PayPeriodSetting): PayPeriod {
  const problem = payPeriodProblem(setting);
  if (problem) throw new Error(problem);
  if (setting.kind === "monthly") {
    const day = setting.anchor ? Number(setting.anchor.slice(8, 10)) : 1;
    const year = Number(date.slice(0, 4));
    const month0 = Number(date.slice(5, 7)) - 1;
    const thisMonth = monthlyStart(year, month0, day);
    const from = date >= thisMonth ? thisMonth : monthlyStart(year, month0 - 1, day);
    const [fy, fm] = [Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1];
    return { from, to: addDays(monthlyStart(fy, fm + 1, day), -1) };
  }
  const length = fixedDays[setting.kind];
  const offset = Math.floor((utc(date) - utc(setting.anchor!)) / DAY_MS / length) * length;
  const from = addDays(setting.anchor!, offset);
  return { from, to: addDays(from, length - 1) };
}

/** The period before `period`. */
export const previousPayPeriod = (period: PayPeriod, setting: PayPeriodSetting): PayPeriod =>
  payPeriodContaining(addDays(period.from, -1), setting);

/** The period after `period`. */
export const nextPayPeriod = (period: PayPeriod, setting: PayPeriodSetting): PayPeriod =>
  payPeriodContaining(addDays(period.to, 1), setting);

/**
 * The most recent period that has finished by `today`: what payroll normally runs for, and the
 * default of the payroll page and file.
 */
export const lastFinishedPayPeriod = (today: string, setting: PayPeriodSetting): PayPeriod =>
  previousPayPeriod(payPeriodContaining(today, setting), setting);

/** Whether a range is exactly one of the setting's periods. */
export function isPayPeriod(range: PayPeriod, setting: PayPeriodSetting): boolean {
  if (payPeriodProblem(setting)) return false;
  const period = payPeriodContaining(range.from, setting);
  return period.from === range.from && period.to === range.to;
}
