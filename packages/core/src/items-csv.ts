import {
  isNoneText,
  parseNumberText,
  parseWholeNumberText,
  readCsvTable,
  sortRowErrors,
  splitListText,
  type CsvImportRowError,
} from "./csv-import";
import {
  allergenCodes,
  allergens,
  itemStatuses,
  itemTypeLabels,
  itemTypes,
  sortAllergens,
  storageConditions,
  unitCodes,
  type AllergenCode,
  type ItemStatus,
  type ItemType,
  type StorageCondition,
  type UnitCode,
} from "./items";
import { parseUnitText } from "./demand";

/**
 * CSV import of items: one row per item, created or updated by stock code (case-insensitively).
 * Shared by the API, the web app and agents.
 */

export const itemCsvColumns = [
  "code",
  "name",
  "type",
  "unit",
  "description",
  "density",
  "unitWeight",
  "allergens",
  "mayContain",
  "storage",
  "shelfLife",
  "standardCost",
  "status",
] as const;
export type ItemCsvColumn = (typeof itemCsvColumns)[number];

/** Header names each column is recognised by (compared without case, spaces or punctuation). */
export const itemCsvHeaders: Record<ItemCsvColumn, readonly string[]> = {
  code: ["code", "stock code", "item code", "item", "sku", "product code"],
  name: ["name", "item name", "description of item", "product", "product name"],
  type: ["type", "item type", "category"],
  unit: ["unit", "uom", "unit of measure"],
  description: ["description", "notes", "note"],
  density: ["density", "density g/ml", "density g per ml", "g per ml"],
  unitWeight: ["unit weight", "unit weight g", "weight each", "g each", "g per each"],
  allergens: ["allergens", "contains", "allergens contains", "contains allergens", "allergen"],
  mayContain: ["may contain", "may contain allergens", "allergens may contain", "precautionary"],
  storage: ["storage", "storage condition", "temperature"],
  shelfLife: ["shelf life", "shelf life days", "shelf life (days)", "life days"],
  standardCost: ["standard cost", "cost", "std cost", "unit cost", "price"],
  status: ["status"],
};

/** A header and an example row people can download and fill in. */
export const ITEM_CSV_TEMPLATE =
  "code,name,type,unit,allergens,may contain,storage,shelf life days,standard cost\r\n" +
  "FLOUR-01,Plain flour,ingredient,kg,Cereals containing gluten,,ambient,365,0.85\r\n";

/** Required columns for a file; a row for a new item also needs `name`, `type` and `unit` cells. */
export const itemCsvRequired = ["code"] as const satisfies readonly ItemCsvColumn[];

/**
 * One row, as read. A field is `undefined` when the file has no such column or (for `name`,
 * `type`, `unit`, `storage`, `status`) the cell is empty: an existing item keeps it. For the
 * other fields an empty cell clears the value, and an empty allergen cell means "none".
 */
export interface ItemEntry {
  row: number;
  code: string;
  name?: string | undefined;
  type?: ItemType | undefined;
  unit?: UnitCode | undefined;
  description?: string | null | undefined;
  densityGPerMl?: number | null | undefined;
  unitWeightG?: number | null | undefined;
  allergens?: AllergenCode[] | undefined;
  mayContain?: AllergenCode[] | undefined;
  storage?: StorageCondition | undefined;
  shelfLifeDays?: number | null | undefined;
  standardCost?: number | null | undefined;
  status?: ItemStatus | undefined;
}

export type ItemRowError = CsvImportRowError<ItemCsvColumn>;

export interface ItemCsvResult {
  entries: ItemEntry[];
  errors: ItemRowError[];
  rowCount: number;
  ignoredColumns: string[];
}

const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

const allergenLookup = new Map<string, AllergenCode>([
  ...allergenCodes.flatMap((code) => [[key(code), code] as const, [key(allergens[code]), code] as const]),
  ["gluten", "cereals_gluten"],
  ["cereals", "cereals_gluten"],
  ["wheat", "cereals_gluten"],
  ["cerealscontaininggluten", "cereals_gluten"],
  ["treenuts", "nuts"],
  ["treenut", "nuts"],
  ["nut", "nuts"],
  ["peanut", "peanuts"],
  ["egg", "eggs"],
  ["soy", "soybeans"],
  ["soya", "soybeans"],
  ["soyabeans", "soybeans"],
  ["sulphur", "sulphites"],
  ["sulphurdioxide", "sulphites"],
  ["sulfites", "sulphites"],
  ["sulphite", "sulphites"],
  ["so2", "sulphites"],
  ["crustacean", "crustaceans"],
  ["mollusc", "molluscs"],
  ["dairy", "milk"],
]);

/** Allergens named in a cell (`milk; Eggs`, `Tree nuts, soya`), or an error message. */
export function parseAllergenText(text: string): { codes: AllergenCode[] } | { error: string } {
  if (!text.trim() || isNoneText(text)) return { codes: [] };
  const codes: AllergenCode[] = [];
  for (const name of splitListText(text)) {
    const code = allergenLookup.get(key(name));
    if (!code) {
      return { error: `"${name}" is not one of the 14 allergens (${allergenCodes.join(", ")})` };
    }
    codes.push(code);
  }
  return { codes: sortAllergens(codes) };
}

const typeLookup = new Map<string, ItemType>([
  ...itemTypes.flatMap((t) => [[key(t), t] as const, [key(itemTypeLabels[t]), t] as const]),
  ["finishedgood", "finished"],
  ["finishedgoods", "finished"],
  ["fg", "finished"],
  ["ingredients", "ingredient"],
  ["rawmaterial", "ingredient"],
  ["raw", "ingredient"],
  ["pack", "packaging"],
  ["semifinished", "wip"],
  ["workinprogress", "wip"],
  ["intermediate", "wip"],
]);

const storageLookup = new Map<string, StorageCondition>([
  ...storageConditions.map((s) => [s, s] as const),
  ["roomtemperature", "ambient"],
  ["dry", "ambient"],
  ["cold", "chilled"],
  ["fridge", "chilled"],
  ["refrigerated", "chilled"],
  ["freezer", "frozen"],
]);

/**
 * Reads an items CSV. Columns (any order, names from `itemCsvHeaders`): `code` is required;
 * `name`, `type`, `unit` (new items need them), `description`, `density` (g/ml), `unit weight`
 * (g each), `allergens` (contains), `may contain`, `storage`, `shelf life` (days), `standard
 * cost` and `status` are optional. A missing column leaves existing items alone.
 *
 * Checks what can be checked without the existing items and reports every problem with its
 * spreadsheet row; the server checks the rest (new items' required cells, unit dimensions).
 */
export function parseItemsCsv(text: string): ItemCsvResult {
  const table = readCsvTable<ItemCsvColumn>(text, {
    columns: itemCsvHeaders,
    required: itemCsvRequired,
    template: ITEM_CSV_TEMPLATE.split("\r\n")[0]!,
  });
  const errors: ItemRowError[] = [...table.errors];
  const entries: ItemEntry[] = [];
  const firstRowOf = new Map<string, number>();

  for (const r of table.rows) {
    const row = r.row;
    const before = errors.length;
    const fail = (column: ItemCsvColumn, message: string) => errors.push({ row, column, message });

    const code = r.cell("code")!;
    if (!code) fail("code", "The stock code is missing");
    else if (code.length > 40) fail("code", "The stock code is longer than 40 characters");
    else {
      const seen = firstRowOf.get(code.toLowerCase());
      if (seen !== undefined) fail("code", `The stock code "${code}" is already on row ${seen}`);
      else firstRowOf.set(code.toLowerCase(), row);
    }

    const entry: ItemEntry = { row, code };

    const name = r.cell("name");
    if (name) {
      if (name.length > 200) fail("name", "The name is longer than 200 characters");
      else entry.name = name;
    }

    const typeText = r.cell("type");
    if (typeText) {
      const type = typeLookup.get(key(typeText));
      if (type) entry.type = type;
      else fail("type", `"${typeText}" is not an item type. Use one of: ${itemTypes.join(", ")}`);
    }

    const unitText = r.cell("unit");
    if (unitText) {
      const unit = parseUnitText(unitText);
      if (unit) entry.unit = unit;
      else fail("unit", `"${unitText}" is not a unit. Use one of: ${unitCodes.join(", ")}`);
    }

    const description = r.cell("description");
    if (description !== undefined) {
      if (description.length > 2000) fail("description", "The description is longer than 2000 characters");
      else entry.description = description || null;
    }

    const density = r.cell("density");
    if (density !== undefined) {
      const n = density ? parseNumberText(density) : null;
      if (density && (n === null || n <= 0 || n > 100)) {
        fail("density", `"${density}" is not a density in g/ml (more than 0, up to 100)`);
      } else entry.densityGPerMl = n;
    }

    const unitWeight = r.cell("unitWeight");
    if (unitWeight !== undefined) {
      const n = unitWeight ? parseNumberText(unitWeight) : null;
      if (unitWeight && (n === null || n <= 0 || n > 10_000_000)) {
        fail("unitWeight", `"${unitWeight}" is not a weight in grams (more than 0)`);
      } else entry.unitWeightG = n;
    }

    for (const column of ["allergens", "mayContain"] as const) {
      const cell = r.cell(column);
      if (cell === undefined) continue;
      const parsed = parseAllergenText(cell);
      if ("error" in parsed) fail(column, parsed.error);
      else if (column === "allergens") entry.allergens = parsed.codes;
      else entry.mayContain = parsed.codes;
    }

    const storageText = r.cell("storage");
    if (storageText) {
      const storage = storageLookup.get(key(storageText));
      if (storage) entry.storage = storage;
      else
        fail(
          "storage",
          `"${storageText}" is not a storage condition. Use one of: ${storageConditions.join(", ")}`,
        );
    }

    const shelfLife = r.cell("shelfLife");
    if (shelfLife !== undefined) {
      const n = shelfLife ? parseWholeNumberText(shelfLife) : null;
      if (shelfLife && (n === null || n > 3650)) {
        fail("shelfLife", `"${shelfLife}" is not a whole number of days (0 to 3650)`);
      } else entry.shelfLifeDays = n;
    }

    const cost = r.cell("standardCost");
    if (cost !== undefined) {
      const n = cost ? parseNumberText(cost) : null;
      if (cost && (n === null || n > 1_000_000_000)) {
        fail("standardCost", `"${cost}" is not a cost of 0 or more`);
      } else entry.standardCost = n;
    }

    const statusText = r.cell("status");
    if (statusText) {
      const status = itemStatuses.find((s) => s === statusText.toLowerCase());
      if (status) entry.status = status;
      else fail("status", `"${statusText}" is not a status. Use one of: ${itemStatuses.join(", ")}`);
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
