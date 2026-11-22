import { weekStart, type DemandWeek } from "./demand";
import {
  demandCoverageQuerySchema,
  type CoverageRow,
  type DemandCoverage,
  type DemandCoverageQuery,
} from "./demand-planning";
import { roundQuantity } from "./items";
import type { ProductionBatchStatus } from "./production";
import { batchHours } from "./production-capacity";
import { lineCapacityHours, type LineShift } from "./production-scheduling";
import { workingDaysIn, type DayOff, type WorkingCalendar } from "./production-calendar";
import { addDays, stockAmount, type StockAmount } from "./stock";

/**
 * Demand against production line capacity, week by week. Pure rules; the demand service reads the
 * data. No DOM or Node APIs.
 *
 * Per ISO week:
 * - **Capacity**: every active line's hours per day on each of its working days (the calendar's
 *   days off, workspace-wide or the line's own, count nothing).
 * - **Booked**: the hours of the batches already on lines that week (cancelled ones left out). Open
 *   batches dated before the first week count in it, like in the cover view. A batch on a line with
 *   no rate for its recipe adds no hours; batches on no line are counted, not guessed.
 * - **Needed**: the hours to make what the cover view says is still short: the *new* shortfall of the
 *   week (this week's cumulative shortfall less last week's, never below 0), at the fastest rate any
 *   active line has for a recipe of the item. An item no line can make is listed, with no hours.
 * - **Load**: (booked + needed) ÷ capacity. Over 100% is `over`, from 90% `tight`.
 *
 * Advisory: it does not pick a line for the shortfall, sequence anything, or stop anything.
 */

export const CAPACITY_TIGHT_PERCENT = 90;

export type CapacityStatus = "ok" | "tight" | "over";

export interface CapacityLine {
  id: string;
  name: string;
  hoursPerDay: number;
  /** Shift windows: with any, a day's capacity is their length (see `lineCapacityHours`). */
  shifts?: readonly LineShift[];
}

export interface CapacityBatch {
  id: string;
  batchCode: string;
  lineId: string | null;
  recipeId: string;
  plannedOn: string;
  plannedQuantity: number;
  status: ProductionBatchStatus;
}

/** The fastest an active line makes an item: output per hour (base unit) on that line. */
export interface ItemRate {
  ratePerHour: number;
  lineId: string;
  lineName: string;
}

export interface CapacityNeedWeek extends DemandWeek {
  /** New shortfall this week (base unit). */
  shortfall: StockAmount;
  /** Hours to make it; `null` when no line can make the item. */
  hours: number | null;
}

export interface CapacityNeed {
  item: CoverageRow["item"];
  /** `null`: no active line has a rate for a recipe of the item. */
  rate: { lineId: string; lineName: string; perHour: StockAmount } | null;
  weeks: CapacityNeedWeek[];
}

export interface CapacityLineWeek {
  id: string;
  name: string;
  workingDays: number;
  capacityHours: number;
  bookedHours: number;
  /** Batches on this line that week with no rate for their recipe (their hours are unknown). */
  unratedBatches: number;
}

export interface CapacityDayOff extends DayOff {
  date: string;
  /** The line it applies to; `null` for the whole workspace. */
  lineName: string | null;
}

export interface CapacityBatchOnDayOff extends DayOff {
  batchId: string;
  batchCode: string;
  date: string;
  lineName: string | null;
}

export interface CapacityWeek extends DemandWeek {
  capacityHours: number;
  bookedHours: number;
  neededHours: number;
  /** Capacity left after booked batches and the hours the shortfall needs (negative when over). */
  freeHours: number;
  /** `(booked + needed) ÷ capacity`; `null` when there is no capacity to compare with. */
  loadPercent: number | null;
  status: CapacityStatus;
  /** Open batches that week on no line: their hours are not in `bookedHours`. */
  unassignedBatches: number;
  /** Batches on a line with no rate for their recipe. */
  unratedBatches: number;
  /** Items short that week that no line can make. */
  unratedItems: number;
  /** Days off in the week that take capacity away (workspace-wide or any active line's own). */
  daysOff: CapacityDayOff[];
  /** Batches dated on a day off for their line (or the workspace, if they have no line). */
  batchesOnDaysOff: CapacityBatchOnDayOff[];
  lines: CapacityLineWeek[];
}

export interface DemandCapacity {
  from: string;
  to: string;
  /** `false` when the caller cannot read production: there is nothing to compare with. */
  available: boolean;
  /** Active lines compared; with none, every week is `ok` with no load (set lines up first). */
  lineCount: number;
  weeks: CapacityWeek[];
  needs: CapacityNeed[];
  /** What the shortfall counts (see the cover view's `basis`). */
  basis: DemandCoverage["basis"];
  /** The weeks with `status` `over`. */
  overWeeks: string[];
}

/** An empty comparison, for callers who cannot read production. */
export const unavailableCapacity = (coverage: DemandCoverage): DemandCapacity => ({
  from: coverage.from,
  to: coverage.to,
  available: false,
  lineCount: 0,
  weeks: [],
  needs: [],
  basis: coverage.basis,
  overWeeks: [],
});

/** Hours a batch takes on its line (`null` without a line, or no rate). */
const hoursOn = (batch: CapacityBatch, rates: ReadonlyMap<string, Readonly<Record<string, number>>>) =>
  batch.lineId ? batchHours(batch.plannedQuantity, rates.get(batch.lineId)?.[batch.recipeId]) : null;

export function buildCapacityComparison(input: {
  coverage: DemandCoverage;
  lines: readonly CapacityLine[];
  /** lineId → recipeId → output per hour (base unit). */
  rates: ReadonlyMap<string, Readonly<Record<string, number>>>;
  batches: readonly CapacityBatch[];
  /** The fastest active line's rate per output item id. */
  itemRates: ReadonlyMap<string, ItemRate>;
  calendar: WorkingCalendar;
}): DemandCapacity {
  const { coverage, lines, rates, calendar } = input;
  const weeks = coverage.weeks;
  const lineName = new Map(lines.map((l) => [l.id, l.name]));
  const firstWeek = weeks[0]?.periodStart ?? coverage.from;
  const lastWeek = weeks.at(-1)?.periodStart ?? coverage.from;
  const weekOf = (date: string) => {
    const w = weekStart(date);
    return w < firstWeek ? firstWeek : w;
  };
  const counted = input.batches.filter((b) => {
    if (b.status === "cancelled") return false;
    const w = weekStart(b.plannedOn);
    if (w > lastWeek) return false;
    // Finished batches before the range are history; open ones that are overdue still need the time.
    return w >= firstWeek || b.status === "planned" || b.status === "in_progress";
  });

  const needs: CapacityNeed[] = [];
  for (const row of coverage.rows) {
    const rate = input.itemRates.get(row.item.id) ?? null;
    let previous = 0;
    const weeksOut = row.periods.map((p): CapacityNeedWeek => {
      const short = p.shortfall.base;
      const fresh = roundQuantity(Math.max(short - previous, 0));
      previous = short;
      return {
        periodStart: p.periodStart,
        week: p.week,
        shortfall: stockAmount(fresh, row.item),
        hours: rate ? batchHours(fresh, rate.ratePerHour) : fresh > 0 ? null : 0,
      };
    });
    if (!weeksOut.some((w) => w.shortfall.base > 0)) continue;
    needs.push({
      item: row.item,
      rate: rate
        ? {
            lineId: rate.lineId,
            lineName: rate.lineName,
            perHour: stockAmount(rate.ratePerHour, row.item),
          }
        : null,
      weeks: weeksOut,
    });
  }

  const outWeeks = weeks.map((w): CapacityWeek => {
    const days = Array.from({ length: 7 }, (_, i) => addDays(w.periodStart, i));
    const inWeek = counted.filter((b) => weekOf(b.plannedOn) === w.periodStart);
    const lineRows = lines.map((l): CapacityLineWeek => {
      const workingDays = workingDaysIn(calendar, days, l.id).length;
      const mine = inWeek.filter((b) => b.lineId === l.id);
      const booked = mine.reduce((t, b) => t + (hoursOn(b, rates) ?? 0), 0);
      return {
        id: l.id,
        name: l.name,
        workingDays,
        capacityHours: roundQuantity(
          days.reduce((t, d) => t + lineCapacityHours(l, d, calendar.dayOff(d, l.id)), 0),
          2,
        ),
        bookedHours: roundQuantity(booked, 2),
        unratedBatches: mine.filter((b) => hoursOn(b, rates) === null).length,
      };
    });
    const capacityHours = roundQuantity(
      lineRows.reduce((t, l) => t + l.capacityHours, 0),
      2,
    );
    const bookedHours = roundQuantity(
      lineRows.reduce((t, l) => t + l.bookedHours, 0),
      2,
    );
    const neededHours = roundQuantity(
      needs.reduce((t, n) => t + (n.weeks.find((x) => x.periodStart === w.periodStart)?.hours ?? 0), 0),
      2,
    );
    const unratedItems = needs.filter((n) => {
      const x = n.weeks.find((y) => y.periodStart === w.periodStart);
      return x && x.shortfall.base > 0 && x.hours === null;
    }).length;
    const total = bookedHours + neededHours;
    const loadPercent = capacityHours > 0 ? roundQuantity((total / capacityHours) * 100, 1) : null;
    const over = total > capacityHours + 1e-9;
    const status: CapacityStatus =
      lines.length === 0
        ? "ok"
        : over
          ? "over"
          : loadPercent !== null && loadPercent >= CAPACITY_TIGHT_PERCENT
            ? "tight"
            : "ok";

    const daysOff: CapacityDayOff[] = [];
    for (const date of days) {
      const ws = calendar.dayOff(date);
      if (ws) daysOff.push({ ...ws, date, lineName: null });
      for (const l of lines) {
        const own = calendar.dayOff(date, l.id);
        if (own && own.scope === "line") daysOff.push({ ...own, date, lineName: l.name });
      }
    }
    const batchesOnDaysOff: CapacityBatchOnDayOff[] = [];
    for (const b of inWeek) {
      if (b.status === "completed") continue;
      const off = calendar.dayOff(b.plannedOn, b.lineId);
      if (off) {
        batchesOnDaysOff.push({
          ...off,
          batchId: b.id,
          batchCode: b.batchCode,
          date: b.plannedOn,
          lineName: b.lineId ? (lineName.get(b.lineId) ?? null) : null,
        });
      }
    }
    return {
      periodStart: w.periodStart,
      week: w.week,
      capacityHours,
      bookedHours,
      neededHours,
      freeHours: roundQuantity(capacityHours - total, 2),
      loadPercent,
      status,
      unassignedBatches: inWeek.filter((b) => !b.lineId && b.status !== "completed").length,
      unratedBatches: lineRows.reduce((t, l) => t + l.unratedBatches, 0),
      unratedItems,
      daysOff,
      batchesOnDaysOff,
      lines: lineRows,
    };
  });

  return {
    from: coverage.from,
    to: coverage.to,
    available: true,
    lineCount: lines.length,
    weeks: outWeeks,
    needs,
    basis: coverage.basis,
    overWeeks: outWeeks.filter((w) => w.status === "over").map((w) => w.periodStart),
  };
}
export const demandCapacityQuerySchema = demandCoverageQuerySchema;
export type DemandCapacityQuery = DemandCoverageQuery;
