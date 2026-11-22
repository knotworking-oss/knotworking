import { z } from "zod";

/**
 * The workspace financial year: calendar months, starting in the month an owner or admin picks
 * (January until changed). No 4-4-5 or 52-week calendars. Dates are `YYYY-MM-DD` strings in the
 * workspace time zone; these helpers do pure calendar arithmetic, so desktop and mobile share them.
 */
export const DEFAULT_FINANCIAL_YEAR_START_MONTH = 1;

/** A month number, 1 (January) to 12 (December). */
export const financialYearStartMonthSchema = z.number().int().min(1).max(12);

/** The start month to use for a stored value: itself when valid, else January. */
export function effectiveFinancialYearStartMonth(stored: number | null | undefined): number {
  const parsed = financialYearStartMonthSchema.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_FINANCIAL_YEAR_START_MONTH;
}

export interface FinancialYear {
  /** The calendar year the financial year ends in ("FY2027" runs Apr 2026 to Mar 2027). */
  year: number;
  /** First day, inclusive. */
  start: string;
  /** Day after the last day (exclusive), so ranges compose without gaps. */
  end: string;
  /** "FY2027", or "2026" when the year starts in January. */
  label: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const firstOfMonth = (year: number, month: number) => {
  const y = year + Math.floor((month - 1) / 12);
  const m = ((((month - 1) % 12) + 12) % 12) + 1;
  return `${y}-${pad(m)}-01`;
};

function parts(date: string): { y: number; m: number } {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  if (!match) throw new Error(`Expected a YYYY-MM-DD date, got "${date}"`);
  return { y: Number(match[1]), m: Number(match[2]) };
}

/** The financial year a calendar date falls in. */
export function financialYearOf(
  date: string,
  startMonth: number = DEFAULT_FINANCIAL_YEAR_START_MONTH,
): FinancialYear {
  const start = effectiveFinancialYearStartMonth(startMonth);
  const { y, m } = parts(date);
  const startYear = m >= start ? y : y - 1;
  const endYear = start === 1 ? startYear : startYear + 1;
  return {
    year: endYear,
    start: firstOfMonth(startYear, start),
    end: firstOfMonth(startYear, start + 12),
    label: start === 1 ? String(startYear) : `FY${endYear}`,
  };
}

export interface FinancialQuarter {
  year: number;
  /** 1 to 4, counted from the start of the financial year. */
  quarter: number;
  start: string;
  /** Exclusive. */
  end: string;
  /** "Q1 FY2027", or "Q1 2026" for a January year. */
  label: string;
}

/** The financial quarter (three calendar months from the year start) a date falls in. */
export function financialQuarterOf(
  date: string,
  startMonth: number = DEFAULT_FINANCIAL_YEAR_START_MONTH,
): FinancialQuarter {
  const fy = financialYearOf(date, startMonth);
  const { y, m } = parts(date);
  const fyStart = parts(fy.start);
  const monthsIn = (y - fyStart.y) * 12 + (m - fyStart.m);
  const quarter = Math.floor(monthsIn / 3) + 1;
  const qStart = fyStart.m + (quarter - 1) * 3;
  return {
    year: fy.year,
    quarter,
    start: firstOfMonth(fyStart.y, qStart),
    end: firstOfMonth(fyStart.y, qStart + 3),
    label: `Q${quarter} ${fy.label}`,
  };
}

/** English month names, for the settings picker. */
export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
