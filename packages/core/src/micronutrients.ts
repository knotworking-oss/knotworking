import { z } from "zod";

/**
 * Vitamins and minerals, held on items as optional extra nutrition and rolled up through recipes
 * with **retention factors** for what cooking destroys or leaches out. They are information for
 * the kitchen and for claims work: **they are never part of the declared nutrition panel**, which
 * stays to what UK PPDS food needs (energy, fat, saturates, carbohydrate, sugars, protein, salt;
 * fibre optional). No DOM or Node APIs.
 */

export const micronutrientKeys = [
  "vitaminA",
  "vitaminD",
  "vitaminE",
  "vitaminC",
  "thiamin",
  "riboflavin",
  "niacin",
  "vitaminB6",
  "folate",
  "vitaminB12",
  "potassium",
  "calcium",
  "magnesium",
  "iron",
  "zinc",
] as const;
export type MicronutrientKey = (typeof micronutrientKeys)[number];

export interface MicronutrientInfo {
  label: string;
  unit: "mg" | "µg";
  /** Nutrient reference value per day (Regulation (EU) 1169/2011, Annex XIII part A), in `unit`. */
  nrv: number;
}

export const micronutrients: Record<MicronutrientKey, MicronutrientInfo> = {
  vitaminA: { label: "Vitamin A (retinol equivalents)", unit: "µg", nrv: 800 },
  vitaminD: { label: "Vitamin D", unit: "µg", nrv: 5 },
  vitaminE: { label: "Vitamin E", unit: "mg", nrv: 12 },
  vitaminC: { label: "Vitamin C", unit: "mg", nrv: 80 },
  thiamin: { label: "Thiamin (B1)", unit: "mg", nrv: 1.1 },
  riboflavin: { label: "Riboflavin (B2)", unit: "mg", nrv: 1.4 },
  niacin: { label: "Niacin", unit: "mg", nrv: 16 },
  vitaminB6: { label: "Vitamin B6", unit: "mg", nrv: 1.4 },
  folate: { label: "Folate", unit: "µg", nrv: 200 },
  vitaminB12: { label: "Vitamin B12", unit: "µg", nrv: 2.5 },
  potassium: { label: "Potassium", unit: "mg", nrv: 2000 },
  calcium: { label: "Calcium", unit: "mg", nrv: 800 },
  magnesium: { label: "Magnesium", unit: "mg", nrv: 375 },
  iron: { label: "Iron", unit: "mg", nrv: 14 },
  zinc: { label: "Zinc", unit: "mg", nrv: 10 },
};

/** Amounts per 100 g (or 100 ml), in each nutrient's own unit. A missing key: not known. */
export type MicronutrientAmounts = Partial<Record<MicronutrientKey, number>>;
/**
 * Fraction (0 to 1) of an ingredient's amount that is still there after it has been cooked in the
 * recipes that use it: 1 is no loss, 0.6 loses 40%. A missing key: no loss assumed.
 */
export type MicronutrientRetention = Partial<Record<MicronutrientKey, number>>;

const keyedObject = <T extends z.ZodType>(value: T) =>
  z
    .object(
      Object.fromEntries(micronutrientKeys.map((key) => [key, value.optional()])) as Record<
        MicronutrientKey,
        z.ZodOptional<T>
      >,
    )
    .strict();

const threeDecimals = (n: number) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6;

/** Amounts per 100 g or ml: at most 3 decimal places, up to 100 000 (potassium is in mg). */
export const micronutrientAmountsSchema = keyedObject(
  z.number().finite().min(0).max(100_000).refine(threeDecimals, "At most 3 decimal places"),
);

/** Retention factors between 0 and 1, at most 3 decimal places. */
export const micronutrientRetentionSchema = keyedObject(
  z.number().finite().min(0).max(1).refine(threeDecimals, "At most 3 decimal places"),
);

/** The keys of a map that have a number, in the order of `micronutrientKeys`. */
export const presentMicronutrients = (map: MicronutrientAmounts | null | undefined) =>
  micronutrientKeys.filter((key) => typeof map?.[key] === "number");

/** Drops everything but known keys with a finite number; `null` when nothing is left. */
export function cleanMicronutrientMap(
  map: Record<string, unknown> | null | undefined,
): MicronutrientAmounts | null {
  if (!map) return null;
  const out: MicronutrientAmounts = {};
  for (const key of micronutrientKeys) {
    const value = map[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** The amount that survives cooking: `amount` × the key's retention (1 when none is set). */
export function retainedAmount(
  key: MicronutrientKey,
  amount: number,
  retention: MicronutrientRetention | null | undefined,
): number {
  const factor = retention?.[key];
  return typeof factor === "number" ? amount * Math.min(1, Math.max(0, factor)) : amount;
}

export interface MicronutrientRow {
  key: MicronutrientKey;
  label: string;
  unit: "mg" | "µg";
  /** Per 100 g or ml of the finished product, to 3 significant figures. */
  value: number;
  /** Percent of the nutrient reference value in 100 g or ml. */
  nrvPercent: number;
}

const significant = (n: number, digits = 3) => (n === 0 ? 0 : Number(n.toPrecision(digits)));

/** Rows to show for rolled-up amounts, in the usual order; only the nutrients that have a value. */
export function micronutrientRows(amounts: MicronutrientAmounts): MicronutrientRow[] {
  return presentMicronutrients(amounts).map((key) => {
    const info = micronutrients[key];
    const value = amounts[key]!;
    return {
      key,
      label: info.label,
      unit: info.unit,
      value: significant(value),
      nrvPercent: Math.round((value / info.nrv) * 100),
    };
  });
}
