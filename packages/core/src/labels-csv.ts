import { readCsvTable, sortRowErrors, type CsvImportRowError } from "./csv-import";
import { micronutrientKeys, type MicronutrientAmounts, type MicronutrientKey } from "./micronutrients";
import {
  kcalToKj,
  kjToKcal,
  nutritionBases,
  nutritionInputSchema,
  type EnergyExtraKey,
  type NutritionBasis,
} from "./labels";

/**
 * CSV import of items' nutrition (per 100 g or 100 ml) from a supplier's specification sheet or
 * from McCance and Widdowson's composition of foods (CoFID) columns, mapped onto the item's
 * labelling data. One row per item, found by stock code (or, with no code, by exact item name).
 * Shared by the API, the web app and agents. No DOM or Node APIs.
 *
 * Rules a sheet's cells are read by:
 * - A number may carry its unit ("12.5 g"). `Tr` or `trace`, and `<0.1`, are read as 0. `N`, `-`,
 *   `n/a` and an empty cell mean "not given". Brackets (CoFID's estimated values) are ignored.
 * - Energy given in only kJ or only kcal is completed with 1 kcal = 4.184 kJ.
 * - Salt may be given as sodium: salt = sodium × 2.5 (a `sodium` column is g, `sodium mg` is mg).
 *   An explicit salt cell wins.
 * - Every mandatory value (energy, fat, saturates, carbohydrate, sugars, protein, salt) is needed.
 *   Fibre, the energy extras and the vitamins and minerals are optional.
 */

type BaseColumn =
  | "code"
  | "name"
  | "basis"
  | "energyKj"
  | "energyKcal"
  | "fat"
  | "saturates"
  | "carbohydrate"
  | "sugars"
  | "fibre"
  | "protein"
  | "salt"
  | "sodium"
  | "sodiumMg"
  | EnergyExtraKey
  | "declarationName"
  | "components"
  | "source";
export type NutritionCsvColumn = BaseColumn | MicronutrientKey;

const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Every stem with each unit suffix a sheet might put after it ("Fat (g)", "Fat g per 100 g"). */
function aliases(stems: readonly string[], suffixes: readonly string[]): string[] {
  return stems.flatMap((stem) => suffixes.map((suffix) => `${stem} ${suffix}`.trim()));
}
const GRAM = ["", "g", "per 100 g", "g per 100 g", "100 g", "g 100 g", "per 100g"];
const MILLIGRAM = ["", "mg", "g", "ug", "mcg", "mg per 100 g", "ug per 100 g", "per 100 g"];

const microStems: Record<MicronutrientKey, string[]> = {
  vitaminA: ["vitamin a", "retinol equivalent", "retinol equivalents", "vitamin a retinol equivalents"],
  vitaminD: ["vitamin d"],
  vitaminE: ["vitamin e", "alpha tocopherol"],
  vitaminC: ["vitamin c", "ascorbic acid"],
  thiamin: ["thiamin", "thiamine", "vitamin b1"],
  riboflavin: ["riboflavin", "vitamin b2"],
  niacin: ["niacin", "niacin equivalent", "niacin equivalents"],
  vitaminB6: ["vitamin b6", "pyridoxine"],
  folate: ["folate", "total folate", "folic acid"],
  vitaminB12: ["vitamin b12", "cobalamin"],
  potassium: ["potassium"],
  calcium: ["calcium"],
  magnesium: ["magnesium"],
  iron: ["iron"],
  zinc: ["zinc"],
};

/** Header names each column is recognised by (compared without case, spaces or punctuation). */
export const nutritionCsvHeaders: Record<NutritionCsvColumn, readonly string[]> = {
  code: ["code", "stock code", "item code", "item", "sku", "product code"],
  name: ["name", "item name", "product name", "product", "food name"],
  basis: ["basis", "nutrition basis", "per", "values per", "unit basis"],
  energyKj: aliases(["energy kj", "energy (kj)", "kj", "energy kilojoules", "kilojoules"], [...GRAM, "kj"]),
  energyKcal: aliases(
    ["energy kcal", "energy (kcal)", "kcal", "energy kilocalories", "kilocalories", "calories"],
    [...GRAM, "kcal"],
  ),
  fat: aliases(["fat", "total fat"], GRAM),
  saturates: aliases(
    [
      "saturates",
      "saturated fat",
      "saturated fatty acids",
      "of which saturates",
      "sat fat",
      // McCance and Widdowson: "Satd FA /100g fd (g)" (per 100 g of food, not per 100 g of fat).
      "satd fa 100g fd",
    ],
    GRAM,
  ),
  carbohydrate: aliases(["carbohydrate", "carbohydrates", "total carbohydrate", "carbs"], GRAM),
  sugars: aliases(["sugars", "sugar", "total sugars", "of which sugars"], GRAM),
  fibre: aliases(["fibre", "fiber", "dietary fibre", "aoac fibre", "fibre aoac"], GRAM),
  protein: aliases(["protein"], GRAM),
  salt: aliases(["salt", "salt equivalent"], GRAM),
  sodium: aliases(["sodium"], ["", "g", "per 100 g", "g per 100 g"]),
  sodiumMg: aliases(["sodium"], ["mg", "mg per 100 g"]),
  polyols: aliases(["polyols", "polyol"], GRAM),
  erythritol: aliases(["erythritol"], GRAM),
  organicAcids: aliases(["organic acids", "organic acid"], GRAM),
  alcohol: aliases(["alcohol", "ethanol"], GRAM),
  declarationName: ["declaration name", "declared name", "ingredient name", "name on label"],
  components: ["components", "compound ingredients", "ingredients", "ingredients list"],
  source: ["source", "nutrition source", "reference", "spec", "specification"],
  ...(Object.fromEntries(micronutrientKeys.map((k) => [k, aliases(microStems[k], MILLIGRAM)])) as Record<
    MicronutrientKey,
    string[]
  >),
};

/** A header and an example row people can download and fill in. */
export const NUTRITION_CSV_TEMPLATE =
  "code,basis,energy kj,energy kcal,fat,saturates,carbohydrate,sugars,fibre,protein,salt,source\r\n" +
  "FLOUR-01,100g,1459,343,1.4,0.3,72,1.5,3.1,10.5,0.01,Supplier specification v3\r\n";

/** The mandatory declaration, after energy has been completed. */
const mandatoryCells = [
  "fat",
  "saturates",
  "carbohydrate",
  "sugars",
  "protein",
  "salt",
] as const satisfies readonly NutritionCsvColumn[];

/** One row, as read: every mandatory value is present and the numbers are valid. */
export interface NutritionEntryRow {
  row: number;
  /** The stock code, or `null` when the row names the item. */
  code: string | null;
  /** The item's name, when the row has no stock code. */
  name: string | null;
  /** `undefined`: the file doesn't say; the item's unit decides (litres: per 100 ml). */
  basis?: NutritionBasis | undefined;
  nutrition: {
    energyKj: number;
    energyKcal: number;
    fat: number;
    saturates: number;
    carbohydrate: number;
    sugars: number;
    fibre: number | null;
    protein: number;
    salt: number;
    polyols: number;
    erythritol: number;
    organicAcids: number;
    alcohol: number;
  };
  /** Vitamins and minerals the row gives; `undefined` when the file has none of those columns. */
  micronutrients?: MicronutrientAmounts | undefined;
  /** Left out (`undefined`): the item keeps its value. Empty cell: cleared. */
  declarationName?: string | null | undefined;
  components?: string | null | undefined;
  nutritionSource?: string | null | undefined;
  /** Which of energy's two values was worked out from the other, and whether salt came from sodium. */
  derived: string[];
}

export type NutritionRowError = CsvImportRowError<NutritionCsvColumn>;

export interface NutritionCsvResult {
  entries: NutritionEntryRow[];
  errors: NutritionRowError[];
  rowCount: number;
  ignoredColumns: string[];
}

/**
 * A nutrient cell: a number, `Tr`/`trace`/`<0.1` as 0, "N", "-", "n/a" or empty as not given
 * (`undefined`), anything else an error (`null`). Units after the number are fine.
 */
export function parseNutrientCell(text: string): number | null | undefined {
  let value = text.trim();
  if (!value || /^(n|-|–|n\/a|na|nd|n\.a\.|not (given|measured|detected))$/i.test(value)) return undefined;
  if (/^(tr|trace)$/i.test(value)) return 0;
  value = value.replace(/^\((.*)\)$/, "$1").trim();
  if (/^<\s*[\d.]+/.test(value)) return 0;
  const m = /^(\d+(?:\.\d*)?|\.\d+)\s*(?:g|mg|µg|μg|ug|mcg|kj|kcal)?$/i.exec(
    value.replace(/,(?=\d{3}\b)/g, ""),
  );
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Reads a nutrition CSV. Columns, in any order (names from `nutritionCsvHeaders`, which include
 * McCance and Widdowson's): `code` (stock code) or `name` (the item's exact name); `basis` (`100g`
 * or `100ml`); `energy kj`, `energy kcal`, `fat`, `saturates`, `carbohydrate`, `sugars`, `protein`
 * and `salt` (or `sodium`); optional `fibre`, `polyols`, `erythritol`, `organic acids`, `alcohol`,
 * vitamins and minerals, `declaration name`, `components` and `source`.
 *
 * Checks what can be checked without the items and reports every problem with its spreadsheet row;
 * the server checks the rest (the item exists and is food, the basis it resolves to).
 */
export function parseNutritionCsv(text: string): NutritionCsvResult {
  const table = readCsvTable<NutritionCsvColumn>(text, {
    columns: nutritionCsvHeaders,
    required: [],
    template: NUTRITION_CSV_TEMPLATE.split("\r\n")[0]!,
  });
  const errors: NutritionRowError[] = [...table.errors];
  if (table.errors.length === 0 && !table.columns.has("code") && !table.columns.has("name")) {
    errors.push({
      row: 1,
      column: "code",
      message: `No "code" (stock code) or "name" column to find the items by. The first row must name the columns, e.g. ${NUTRITION_CSV_TEMPLATE.split("\r\n")[0]}`,
    });
    return { entries: [], errors, rowCount: table.rowCount, ignoredColumns: table.ignoredColumns };
  }
  const entries: NutritionEntryRow[] = [];
  const firstRowOf = new Map<string, number>();
  const hasMicro = micronutrientKeys.some((k) => table.columns.has(k));

  for (const r of table.rows) {
    const row = r.row;
    const before = errors.length;
    const fail = (column: NutritionCsvColumn, message: string) => errors.push({ row, column, message });

    const code = r.cell("code") || null;
    const name = r.cell("name") || null;
    const identity = code ?? name;
    if (!identity)
      fail(code === null && table.columns.has("code") ? "code" : "name", "The stock code is missing");
    else {
      const id = `${code ? "code" : "name"}:${identity.toLowerCase()}`;
      const seen = firstRowOf.get(id);
      if (seen !== undefined) fail(code ? "code" : "name", `"${identity}" is already on row ${seen}`);
      else firstRowOf.set(id, row);
    }

    let basis: NutritionBasis | undefined;
    const basisText = r.cell("basis");
    if (basisText) {
      const k = key(basisText);
      if (/^(per)?100g(rams?)?$/.test(k) || k === "g" || k === "solid") basis = "100g";
      else if (/^(per)?100ml$/.test(k) || k === "ml" || k === "liquid") basis = "100ml";
      else fail("basis", `"${basisText}" is not a basis. Use one of: ${nutritionBases.join(", ")}`);
    }

    const num = (column: NutritionCsvColumn): number | undefined => {
      const cell = r.cell(column);
      if (cell === undefined) return undefined;
      const n = parseNutrientCell(cell);
      if (n === null) {
        fail(column, `"${cell}" is not an amount (a number such as 12.5, "Tr" for trace, or empty)`);
        return undefined;
      }
      return n;
    };

    const derived: string[] = [];
    let energyKj = num("energyKj");
    let energyKcal = num("energyKcal");
    if (energyKj === undefined && energyKcal !== undefined) {
      energyKj = kcalToKj(energyKcal);
      derived.push("energyKj");
    } else if (energyKcal === undefined && energyKj !== undefined) {
      energyKcal = kjToKcal(energyKj);
      derived.push("energyKcal");
    }
    const failed = (column: NutritionCsvColumn) => errors.some((e) => e.row === row && e.column === column);
    if (energyKj === undefined && !failed("energyKj") && !failed("energyKcal")) {
      fail("energyKj", "Energy is missing (kJ or kcal)");
    }

    const values: Partial<Record<(typeof mandatoryCells)[number], number>> = {};
    for (const column of mandatoryCells) {
      if (column === "salt") continue;
      const value = num(column);
      if (value !== undefined) values[column] = value;
      else if (!failed(column)) {
        fail(
          column,
          r.cell(column) === undefined
            ? `No "${column}" column. Every mandatory nutrient is needed`
            : `"${column}" is empty. Every mandatory nutrient is needed (use 0, or Tr for a trace)`,
        );
      }
    }
    // Salt, or sodium × 2.5.
    let salt = num("salt");
    if (salt === undefined) {
      const sodiumG = num("sodium");
      const sodiumMg = num("sodiumMg");
      if (sodiumG !== undefined) salt = round3(sodiumG * 2.5);
      else if (sodiumMg !== undefined) salt = round3((sodiumMg * 2.5) / 1000);
      if (salt !== undefined) derived.push("salt");
    }
    if (salt === undefined && !failed("salt")) {
      fail(
        "salt",
        `No salt (or sodium) given. Every mandatory nutrient is needed (use 0, or Tr for a trace)`,
      );
    }
    const fibre = num("fibre");
    const extras = {
      polyols: num("polyols") ?? 0,
      erythritol: num("erythritol") ?? 0,
      organicAcids: num("organicAcids") ?? 0,
      alcohol: num("alcohol") ?? 0,
    };

    let micronutrients: MicronutrientAmounts | undefined;
    if (hasMicro) {
      micronutrients = {};
      for (const k of micronutrientKeys) {
        const n = num(k);
        if (n !== undefined) micronutrients[k] = round3(n);
      }
    }

    if (errors.length > before) continue;
    const nutrition = {
      energyKj: round3(energyKj!),
      energyKcal: round3(energyKcal!),
      fat: round3(values.fat!),
      saturates: round3(values.saturates!),
      carbohydrate: round3(values.carbohydrate!),
      sugars: round3(values.sugars!),
      fibre: fibre === undefined ? null : round3(fibre),
      protein: round3(values.protein!),
      salt: round3(salt!),
      polyols: round3(extras.polyols),
      erythritol: round3(extras.erythritol),
      organicAcids: round3(extras.organicAcids),
      alcohol: round3(extras.alcohol),
    };
    // Cross-checks (saturates within fat, kJ against kcal, …); the basis only matters for the 100 g cap.
    const checked = nutritionInputSchema.safeParse({ basis: basis ?? "100ml", ...nutrition });
    if (!checked.success) {
      for (const issue of checked.error.issues) {
        const column = issue.path[0];
        fail(typeof column === "string" ? (column as NutritionCsvColumn) : "energyKj", issue.message);
      }
      continue;
    }

    const entry: NutritionEntryRow = { row, code, name: code ? null : name, basis, nutrition, derived };
    if (micronutrients) entry.micronutrients = micronutrients;
    const declarationName = r.cell("declarationName");
    if (declarationName !== undefined) {
      if (declarationName.length > 200)
        fail("declarationName", "The declaration name is longer than 200 characters");
      else entry.declarationName = declarationName || null;
    }
    const components = r.cell("components");
    if (components !== undefined) {
      if (components.length > 2000) fail("components", "The components are longer than 2000 characters");
      else entry.components = components || null;
    }
    const source = r.cell("source");
    if (source !== undefined) {
      if (source.length > 300) fail("source", "The source is longer than 300 characters");
      else entry.nutritionSource = source || null;
    }
    if (errors.length === before) entries.push(entry);
  }
  return {
    entries,
    errors: sortRowErrors(errors),
    rowCount: table.rowCount,
    ignoredColumns: table.ignoredColumns,
  };
}
