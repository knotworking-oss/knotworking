import { z } from "zod";
import { convertQuantity, roundQuantity, type UnitBridge, type UnitCode } from "./items";
import { itemBaseUnit } from "./stock";

/**
 * Conversion costs: the labour and overhead a batch absorbs, kept apart from its materials.
 *
 * A simple model, deliberately: nobody clocks a person onto a batch, so labour is not worked out
 * from attendance hours. Instead each production line (or the workspace as a default) carries
 * **absorption rates**: an amount per batch hour and/or per kilogram made, for labour and for
 * overhead separately. A batch absorbs `hours × per-hour + kg × per-kg` of each. Rates take
 * effect on a date, so a batch is charged the rates in force the day it completed. Conversion
 * costs are reported next to the materials, never inside them: a lot's cost per unit (and the
 * stock valuation) stays materials only. Pure; no DOM or Node APIs.
 */

const DECIMALS = 4;
const money = (value: number) => roundQuantity(value, DECIMALS);

/** What a batch absorbs, in the workspace's currency. */
export interface AbsorptionRates {
  /** Per hour the batch ran (started to completed). */
  labourPerHour: number;
  /** Per kilogram of output. */
  labourPerKg: number;
  overheadPerHour: number;
  overheadPerKg: number;
}

export const noAbsorption: AbsorptionRates = {
  labourPerHour: 0,
  labourPerKg: 0,
  overheadPerHour: 0,
  overheadPerKg: 0,
};

/** Rates taking effect on a date, for one line, or for every line without its own (`lineId: null`). */
export interface AbsorptionRateEntry extends AbsorptionRates {
  lineId: string | null;
  /** `YYYY-MM-DD`. */
  effectiveFrom: string;
}

/**
 * The rates in force for a batch made on `lineId` on `date`: the line's own latest entry taking
 * effect on or before it, else the workspace default's. A line with its own entry never adds to
 * the default (it replaces it). `null` when neither exists.
 */
export function absorptionRateOn(
  entries: readonly AbsorptionRateEntry[],
  lineId: string | null,
  date: string,
): AbsorptionRateEntry | null {
  const latest = (id: string | null) =>
    entries
      .filter((e) => e.lineId === id && e.effectiveFrom <= date)
      .reduce<AbsorptionRateEntry | null>(
        (best, e) => (best && best.effectiveFrom > e.effectiveFrom ? best : e),
        null,
      );
  return (lineId ? latest(lineId) : null) ?? latest(null);
}

/** Hours between a batch's start and completion (2 places); `null` when either is missing. */
export function batchRunHours(
  startedAt: Date | string | null | undefined,
  completedAt: Date | string | null | undefined,
): number | null {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? roundQuantity(ms / 3_600_000, 2) : null;
}

/** Kilograms in a base-unit output quantity; `null` when the item can't be weighed (no density or unit weight). */
export function outputKilograms(baseQuantity: number, item: UnitBridge & { unit: UnitCode }): number | null {
  const grams = convertQuantity(baseQuantity, itemBaseUnit(item), "g", item);
  return grams === null ? null : roundQuantity(grams / 1000, 4);
}

export interface BatchConversion {
  /** Rates were in force for the batch (false: nothing absorbed, nothing was set). */
  rated: boolean;
  /** The date the rates in force took effect. */
  effectiveFrom: string | null;
  hours: number | null;
  kg: number | null;
  labour: number;
  overhead: number;
  /** `labour` + `overhead`. */
  total: number;
  /**
   * False when a rate needs a figure the batch lacks (a per-hour rate on a batch with no start
   * time, a per-kg rate on an output that can't be weighed): that part is left out, so the
   * amounts are understated.
   */
  complete: boolean;
  missing: ("hours" | "kg")[];
}

/** What a batch absorbs under `rate` (`null`: no rates set). */
export function absorbConversion(input: {
  hours: number | null;
  kg: number | null;
  rate: (AbsorptionRates & { effectiveFrom?: string | null }) | null;
}): BatchConversion {
  const { hours, kg, rate } = input;
  if (!rate) {
    return {
      rated: false,
      effectiveFrom: null,
      hours,
      kg,
      labour: 0,
      overhead: 0,
      total: 0,
      complete: true,
      missing: [],
    };
  }
  const missing: ("hours" | "kg")[] = [];
  if (hours === null && (rate.labourPerHour > 0 || rate.overheadPerHour > 0)) missing.push("hours");
  if (kg === null && (rate.labourPerKg > 0 || rate.overheadPerKg > 0)) missing.push("kg");
  const labour = (hours ?? 0) * rate.labourPerHour + (kg ?? 0) * rate.labourPerKg;
  const overhead = (hours ?? 0) * rate.overheadPerHour + (kg ?? 0) * rate.overheadPerKg;
  return {
    rated: true,
    effectiveFrom: rate.effectiveFrom ?? null,
    hours,
    kg,
    labour: money(labour),
    overhead: money(overhead),
    total: money(labour + overhead),
    complete: missing.length === 0,
    missing,
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

const rate = z.number().min(0).max(1_000_000);

/**
 * `PUT /costing/rates`: sets the rates for a line (or the default) from a date. Setting a date
 * that already has an entry for that line replaces it. Tokens can't change them.
 */
export const absorptionRateSetSchema = z.object({
  /** A production line, or `null` for the workspace default. */
  lineId: z.uuid().nullable().default(null),
  effectiveFrom: z.iso.date(),
  labourPerHour: rate.default(0),
  labourPerKg: rate.default(0),
  overheadPerHour: rate.default(0),
  overheadPerKg: rate.default(0),
  note: z.string().trim().max(500).nullish(),
});
export type AbsorptionRateSetInput = z.infer<typeof absorptionRateSetSchema>;
