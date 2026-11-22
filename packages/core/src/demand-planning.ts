import { z } from "zod";
import {
  addWeeks,
  customerKey,
  demandItemTypes,
  demandPeriodSchema,
  formatWeek,
  isoWeekOf,
  normalizeCustomer,
  weekStart,
  weekStartOf,
  weeksInRange,
  type DemandItemSummary,
  type DemandSummary,
  type DemandWeek,
} from "./demand";
import { roundQuantity } from "./items";
import { stockAmount, type StockAmount } from "./stock";

/**
 * Demand planning aids: a simple forecast from past demand, and demand compared with stock and
 * planned production. Pure rules and shared schemas; the API's demand service reads the data.
 * No DOM or Node APIs.
 *
 * **Forecast** (no ML; every number can be explained):
 * - *Baseline*: the average weekly demand over the last `window` weeks before the current week
 *   (weeks with no line count as 0, but weeks before the first demand ever recorded don't).
 * - *Seasonality* (optional, on by default): when there is demand history from a year ago, the
 *   baseline is scaled by a seasonal index: the average of the target week and the weeks either
 *   side of it a year earlier (same ISO week number), divided by that year's own baseline (the
 *   `window` weeks before the same point). The index is held between `SEASONAL_MIN` and
 *   `SEASONAL_MAX`, so one odd week can't swing the forecast wildly. Without a year of history
 *   the forecast is the plain average, and each week says which one it used.
 *
 * **Coverage**: per item per week, demand against the stock available now plus the output of
 * planned batches, running week by week.
 */

// ─── Forecast ────────────────────────────────────────────────────────────────

export const FORECAST_DEFAULT_WINDOW = 8;
export const FORECAST_MIN_WINDOW = 2;
export const FORECAST_MAX_WINDOW = 26;
/** The seasonal index is never below or above these. */
export const SEASONAL_MIN = 0.25;
export const SEASONAL_MAX = 4;
/** Most weeks a forecast may cover (shorter than a demand summary: it is a short-range tool). */
export const FORECAST_MAX_WEEKS = 52;

const flag = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true" || v === "1"));

const forecastFields = {
  /** Default: the current week. */
  from: demandPeriodSchema.optional(),
  /** Default: 8 weeks from `from`; at most `FORECAST_MAX_WEEKS` in all. */
  to: demandPeriodSchema.optional(),
  itemId: z.uuid().optional(),
  /** The item's stock code (case-insensitive), instead of its id. */
  itemCode: z.string().trim().min(1).max(40).optional(),
  itemType: z.enum(demandItemTypes).optional(),
  /** One forecast per item and customer instead of one per item. */
  byCustomer: flag(false),
  /** Weeks of history the baseline averages. */
  window: z.coerce
    .number()
    .int()
    .min(FORECAST_MIN_WINDOW)
    .max(FORECAST_MAX_WINDOW)
    .default(FORECAST_DEFAULT_WINDOW),
  /** Scale by the same weeks last year when there is that much history. */
  seasonal: flag(true),
};
const rangeOk = (v: { from?: string | undefined; to?: string | undefined }) =>
  !v.from || !v.to || v.from <= v.to;
const RANGE_ERROR = { path: ["to"], message: "The end is before the start" };

/** `GET /demand/forecast`. */
export const demandForecastQuerySchema = z.object(forecastFields).refine(rangeOk, RANGE_ERROR);
export type DemandForecastQuery = z.infer<typeof demandForecastQuerySchema>;

/** `POST /demand/forecast/apply`: the same options, in a body. */
export const demandForecastApplySchema = z
  .object({
    from: demandPeriodSchema.optional(),
    to: demandPeriodSchema.optional(),
    itemId: z.uuid().optional(),
    itemCode: z.string().trim().min(1).max(40).optional(),
    itemType: z.enum(demandItemTypes).optional(),
    byCustomer: z.boolean().optional(),
    window: z.number().int().min(FORECAST_MIN_WINDOW).max(FORECAST_MAX_WINDOW).optional(),
    seasonal: z.boolean().optional(),
    /** Replace existing lines too (default: only fill weeks that have no demand). */
    overwrite: z.boolean().optional(),
  })
  .refine(rangeOk, RANGE_ERROR);
export type DemandForecastApplyInput = z.infer<typeof demandForecastApplySchema>;

export interface ForecastHistory {
  /** Demand by week (Monday), base unit; weeks without demand are absent. */
  byWeek: ReadonlyMap<string, number>;
  /** The Monday of the first week with any demand on record for this item (and customer). */
  firstWeek: string;
}

export interface ForecastWeek extends DemandWeek {
  /** Forecast demand, base unit, rounded to a whole base unit. */
  quantity: number;
  /** The average weekly demand it started from. */
  baseline: number;
  /** The seasonal index applied; `null` when the plain average was used. */
  seasonalIndex: number | null;
  method: "average" | "seasonal";
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/** The same ISO week number in the previous ISO year (week 53 becomes 52 if last year had none). */
export function sameWeekLastYear(periodStart: string): string {
  const { year, week } = isoWeekOf(periodStart);
  return weekStartOf(year - 1, week) ?? weekStartOf(year - 1, 52) ?? addWeeks(periodStart, -52);
}

/**
 * Average weekly demand over the `window` weeks ending the week before `origin`, counting weeks
 * without a line as 0 but not weeks before `firstWeek`. `null` when no week of the window is on
 * record (`origin` is no later than the first week with demand).
 */
export function baselineBefore(history: ForecastHistory, origin: string, window: number): number | null {
  const weeks: number[] = [];
  for (let i = window; i >= 1; i--) {
    const week = addWeeks(origin, -i);
    if (week < history.firstWeek) continue;
    weeks.push(history.byWeek.get(week) ?? 0);
  }
  return weeks.length ? mean(weeks) : null;
}

/**
 * Forecasts the `targets` weeks (Mondays) from `history`. `origin` is the Monday history runs up
 * to (not included): normally the current week. Returns `null` when there is no history to go on
 * or the forecast would be zero throughout.
 */
export function forecastWeeks(input: {
  history: ForecastHistory;
  origin: string;
  targets: readonly string[];
  window: number;
  seasonal: boolean;
}): ForecastWeek[] | null {
  const { history, origin, window } = input;
  const baseline = baselineBefore(history, origin, window);
  if (baseline === null) return null;
  const lastYearOrigin = sameWeekLastYear(origin);
  const lastYearBaseline = input.seasonal ? baselineBefore(history, lastYearOrigin, window) : null;
  const out = input.targets.map((target): ForecastWeek => {
    let seasonalIndex: number | null = null;
    if (lastYearBaseline !== null && lastYearBaseline > 0) {
      const ly = sameWeekLastYear(target);
      const around = [-1, 0, 1].map((d) => history.byWeek.get(addWeeks(ly, d)) ?? 0);
      // Only when last year's weeks are before the origin (otherwise they are forecast weeks).
      if (addWeeks(ly, 1) < origin && ly >= history.firstWeek) {
        seasonalIndex = Math.min(SEASONAL_MAX, Math.max(SEASONAL_MIN, mean(around) / lastYearBaseline));
      }
    }
    return {
      periodStart: target,
      week: formatWeek(target),
      quantity: Math.round(baseline * (seasonalIndex ?? 1)),
      baseline: roundQuantity(baseline),
      seasonalIndex: seasonalIndex === null ? null : Math.round(seasonalIndex * 100) / 100,
      method: seasonalIndex === null ? "average" : "seasonal",
    };
  });
  return out.some((w) => w.quantity > 0) ? out : null;
}

/** One line of text saying how a forecast week was worked out. */
export function explainForecastWeek(week: ForecastWeek, window: number, unit: string): string {
  const base = `Average of the last ${window} weeks: ${Math.round(week.baseline).toLocaleString("en-GB")} ${unit} a week`;
  if (week.seasonalIndex === null)
    return `${base}. No year-ago history for this week, so no seasonal adjustment.`;
  const pct = Math.round((week.seasonalIndex - 1) * 100);
  const how = pct === 0 ? "the same as" : `${Math.abs(pct)}% ${pct > 0 ? "above" : "below"}`;
  return `${base}, times ${week.seasonalIndex} for the season (the same week last year was ${how} that year's average).`;
}

export interface DemandForecastRow {
  item: DemandItemSummary;
  /** With `byCustomer`: the customer (`null` for demand without one). Otherwise `null`. */
  customer: string | null;
  /** How many of the window's weeks had demand. */
  weeksWithDemand: number;
  periods: (Omit<ForecastWeek, "quantity" | "baseline"> & {
    quantity: StockAmount;
    baseline: StockAmount;
    /** How the figure was worked out, in words. */
    explanation: string;
  })[];
}

export interface DemandForecast {
  from: string;
  to: string;
  weeks: DemandWeek[];
  byCustomer: boolean;
  window: number;
  seasonal: boolean;
  /** The week history runs up to (not included): the current week. */
  historyUntil: string;
  /** What the method is, for display. */
  method: string;
  rows: DemandForecastRow[];
}

export const forecastMethodText = (window: number, seasonal: boolean): string =>
  seasonal
    ? `Average weekly demand over the last ${window} weeks, scaled by a seasonal index from the same weeks last year when there is a year of history.`
    : `Average weekly demand over the last ${window} weeks.`;

/** One lump of past demand: base quantity for an item (and customer) in a week. */
export interface ForecastCell {
  itemId: string;
  customer: string | null;
  periodStart: string;
  quantity: number;
}

/** Builds a forecast from past demand cells (any weeks; only those before `origin` are used). */
export function buildDemandForecast(input: {
  from: string;
  to: string;
  origin: string;
  byCustomer: boolean;
  window: number;
  seasonal: boolean;
  cells: readonly ForecastCell[];
  items: ReadonlyMap<string, DemandItemSummary>;
}): DemandForecast {
  const targets = weeksInRange(input.from, input.to);
  const series = new Map<string, { itemId: string; customer: string | null; byWeek: Map<string, number> }>();
  for (const cell of input.cells) {
    if (cell.periodStart >= input.origin || !input.items.has(cell.itemId)) continue;
    const key = input.byCustomer ? `${cell.itemId}|${customerKey(cell.customer)}` : cell.itemId;
    let s = series.get(key);
    if (!s) {
      s = {
        itemId: cell.itemId,
        customer: input.byCustomer ? normalizeCustomer(cell.customer) : null,
        byWeek: new Map(),
      };
      series.set(key, s);
    }
    s.byWeek.set(cell.periodStart, (s.byWeek.get(cell.periodStart) ?? 0) + cell.quantity);
  }
  const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const rows: DemandForecastRow[] = [];
  for (const s of series.values()) {
    const item = input.items.get(s.itemId)!;
    // Only positive weeks count as "on record": a zero line is no sign of a product being sold.
    const positive = [...s.byWeek.entries()].filter(([, q]) => q > 0).map(([w]) => w);
    if (positive.length === 0) continue;
    const history: ForecastHistory = { byWeek: s.byWeek, firstWeek: positive.sort()[0]! };
    const weeks = forecastWeeks({
      history,
      origin: input.origin,
      targets,
      window: input.window,
      seasonal: input.seasonal,
    });
    if (!weeks) continue;
    const inWindow = Array.from({ length: input.window }, (_, i) => addWeeks(input.origin, -(i + 1)));
    rows.push({
      item,
      customer: s.customer,
      weeksWithDemand: inWindow.filter((w) => (s.byWeek.get(w) ?? 0) > 0).length,
      periods: weeks.map((w) => ({
        periodStart: w.periodStart,
        week: w.week,
        method: w.method,
        seasonalIndex: w.seasonalIndex,
        quantity: stockAmount(w.quantity, item),
        baseline: stockAmount(w.baseline, item),
        explanation: explainForecastWeek(w, input.window, item.unit === "each" ? "each" : "in the base unit"),
      })),
    });
  }
  rows.sort(
    (a, b) =>
      text(a.item.code.toLowerCase(), b.item.code.toLowerCase()) ||
      text(a.item.id, b.item.id) ||
      text(customerKey(a.customer), customerKey(b.customer)),
  );
  return {
    from: weekStart(input.from),
    to: weekStart(input.to),
    weeks: targets.map((periodStart) => ({ periodStart, week: formatWeek(periodStart) })),
    byCustomer: input.byCustomer,
    window: input.window,
    seasonal: input.seasonal,
    historyUntil: input.origin,
    method: forecastMethodText(input.window, input.seasonal),
    rows,
  };
}

// ─── Coverage: demand against stock and planned batches ──────────────────────

/** `GET /demand/coverage`. */
export const demandCoverageQuerySchema = z
  .object({
    /** Default (and earliest): the current week. */
    from: demandPeriodSchema.optional(),
    to: demandPeriodSchema.optional(),
    itemId: z.uuid().optional(),
    itemCode: z.string().trim().min(1).max(40).optional(),
    itemType: z.enum(demandItemTypes).optional(),
    /** Only items that run short. */
    shortOnly: flag(false),
  })
  .refine(rangeOk, RANGE_ERROR);
export type DemandCoverageQuery = z.infer<typeof demandCoverageQuerySchema>;

export const coverageStatuses = ["ok", "short", "unknown"] as const;
export type CoverageStatus = (typeof coverageStatuses)[number];

export interface CoverageWeek extends DemandWeek {
  demand: StockAmount;
  /** Output of planned and in-progress batches due this week; `null` when production is not readable. */
  planned: StockAmount | null;
  /**
   * What is left at the end of the week: stock now + planned batches so far - demand so far,
   * counting only the sources the caller can read. Negative when short. `null` when neither is.
   */
  projected: StockAmount | null;
  /** How much more is needed by the end of this week (0 when covered). */
  shortfall: StockAmount;
  status: CoverageStatus;
}

export interface CoverageRow {
  item: DemandItemSummary;
  /** Available stock now (released lots); `null` when stock is not readable. */
  stock: StockAmount | null;
  periods: CoverageWeek[];
  /** The first week that runs short. */
  firstShortWeek: string | null;
  /** The largest shortfall in the range. */
  maxShortfall: StockAmount;
}

export interface DemandCoverage {
  from: string;
  to: string;
  weeks: DemandWeek[];
  /** What the figures count: `demand` always, `stock` and `production` only if the caller can read them. */
  basis: { stock: boolean; production: boolean };
  rows: CoverageRow[];
}

/**
 * Demand against what covers it, week by week. Stock is what is available now and is not
 * replenished except by the planned batches; `supply` is planned output by week (batches due
 * before the range count in its first week). An item with no stock or batches shows its whole
 * demand as the shortfall. Rows are the items with demand in the range.
 */
export function buildCoverage(input: {
  summary: DemandSummary;
  /** Available stock per item (base unit); `null` when the caller can't read stock. */
  stock: ReadonlyMap<string, number> | null;
  /** Planned batch output per item per week (base unit); `null` when the caller can't read production. */
  supply: ReadonlyMap<string, ReadonlyMap<string, number>> | null;
  shortOnly?: boolean;
}): DemandCoverage {
  const { summary, stock, supply } = input;
  const known = stock !== null || supply !== null;
  const rows: CoverageRow[] = [];
  for (const row of summary.rows) {
    const item = row.item;
    const demandBy = new Map(row.periods.map((p) => [p.periodStart, p.quantity.base]));
    const supplyBy = supply?.get(item.id);
    let running = (stock?.get(item.id) ?? 0) as number;
    let firstShortWeek: string | null = null;
    let maxShort = 0;
    const periods = summary.weeks.map((w): CoverageWeek => {
      const demand = demandBy.get(w.periodStart) ?? 0;
      const planned = supply ? (supplyBy?.get(w.periodStart) ?? 0) : null;
      running = roundQuantity(running + (planned ?? 0) - demand);
      const short = known && running < 0 ? -running : 0;
      if (short > 0) {
        firstShortWeek ??= w.periodStart;
        maxShort = Math.max(maxShort, short);
      }
      return {
        periodStart: w.periodStart,
        week: w.week,
        demand: stockAmount(demand, item),
        planned: planned === null ? null : stockAmount(planned, item),
        projected: known ? stockAmount(running, item) : null,
        shortfall: stockAmount(short, item),
        status: !known ? "unknown" : short > 0 ? "short" : "ok",
      };
    });
    if (input.shortOnly && firstShortWeek === null) continue;
    rows.push({
      item,
      stock: stock ? stockAmount(stock.get(item.id) ?? 0, item) : null,
      periods,
      firstShortWeek,
      maxShortfall: stockAmount(maxShort, item),
    });
  }
  return {
    from: summary.from,
    to: summary.to,
    weeks: summary.weeks,
    basis: { stock: stock !== null, production: supply !== null },
    rows,
  };
}
