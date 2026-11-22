import { z } from "zod";
import { parseCsv } from "./csv";
import {
  roundQuantity,
  unitCodes,
  unitsForItem,
  type ItemStatus,
  type ItemType,
  type UnitBridge,
  type UnitCode,
} from "./items";
import { addDays, daysBetween, stockAmount, toBaseQuantity, type StockAmount } from "./stock";

/**
 * Demand module: how much of each product is wanted in each week, from manual entry, CSV import
 * and (later) the sales system's API.
 *
 * Shared vocabulary, validation schemas and the pure rules (ISO weeks, CSV parsing, resolving
 * entries against items, the per-item per-week summary the production module plans from). No DOM
 * or Node APIs.
 *
 * - **Period**: an ISO week (Monday to Sunday), stored as the date of its Monday (`periodStart`)
 *   and shown as `2026-W46`. Any date given is read as the week it falls in.
 * - **Key**: one live line per item, week and customer (customer optional, compared
 *   case-insensitively). Writing the same key again replaces the quantity, so re-sending is
 *   idempotent.
 * - **Units of sale**: an item can have named pack units (case = 12 each); a quantity may be
 *   entered in one and is held in base units, with what was typed kept beside it.
 * - **Quantity**: entered as a number and a unit, held in the item's base unit (g, ml or each)
 *   with 4 decimal places, like the stock ledger (`toBaseQuantity`, `stockAmount`).
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * Where a line's current quantity came from. `manual`: a person in the app. `import`: a CSV
 * import. `api`: posted with an API token (the sales system's feed, or an agent). `forecast`:
 * copied from the forecast (`POST /demand/forecast/apply`).
 */
export const demandSources = ["manual", "import", "api", "forecast"] as const;
export type DemandSource = (typeof demandSources)[number];
export const demandSourceLabels: Record<DemandSource, string> = {
  manual: "Entered",
  import: "CSV import",
  api: "API",
  forecast: "Forecast",
};

/** What can have demand: the products a customer orders. Ingredients and packaging are bought in. */
export const demandItemTypes = ["finished", "wip"] as const satisfies readonly ItemType[];
export type DemandItemType = (typeof demandItemTypes)[number];
export const isDemandItemType = (type: ItemType): type is DemandItemType =>
  (demandItemTypes as readonly string[]).includes(type);

/** Weeks the summary covers when no range is given. */
export const DEMAND_DEFAULT_WEEKS = 12;
/** The longest range one summary or list query may span. */
export const DEMAND_MAX_WEEKS = 104;
/** Lines in one `PUT /demand/lines`. */
export const DEMAND_SET_MAX_LINES = 1000;
/** Data rows in one CSV import. */
export const DEMAND_IMPORT_MAX_ROWS = 5000;
/** Characters of CSV text in one import (about 2 MB). */
export const DEMAND_IMPORT_MAX_CHARS = 2_000_000;
const MAX_QUANTITY = 1_000_000_000_000;

// ─── ISO weeks ───────────────────────────────────────────────────────────────

/** A real calendar date as `YYYY-MM-DD`, or `null` (e.g. 31 February). */
function calendarDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2999) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** ISO day of the week: Monday 1 … Sunday 7. */
const isoWeekday = (isoDate: string) => ((new Date(`${isoDate}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/** The Monday of the ISO week `isoDate` falls in. */
export const weekStart = (isoDate: string): string => addDays(isoDate, 1 - isoWeekday(isoDate));

export const addWeeks = (isoDate: string, weeks: number): string => addDays(isoDate, weeks * 7);

/** The ISO week-numbering year and week of a date (the week belongs to the year of its Thursday). */
export function isoWeekOf(isoDate: string): { year: number; week: number } {
  const thursday = addDays(weekStart(isoDate), 3);
  const year = Number(thursday.slice(0, 4));
  return { year, week: Math.floor(daysBetween(`${year}-01-01`, thursday) / 7) + 1 };
}

/** A week as people write it: `2026-W46`. */
export function formatWeek(isoDate: string): string {
  const { year, week } = isoWeekOf(isoDate);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The Monday of ISO week `week` of `year`, or `null` when the year has no such week. */
export function weekStartOf(year: number, week: number): string | null {
  if (!Number.isInteger(week) || week < 1 || week > 53 || year < 1900 || year > 2999) return null;
  const monday = addWeeks(weekStart(`${year}-01-04`), week - 1);
  return isoWeekOf(monday).year === year ? monday : null;
}

/**
 * Reads a period as the Monday of its ISO week. Accepts an ISO date (`2026-11-12`), a UK date
 * (`12/11/2026`, day first) or an ISO week (`2026-W46`, `2026W46`, `2026-W46-4`). `null` when it
 * is none of these, or not a real date.
 */
export function parsePeriod(text: string): string | null {
  const value = text.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    const date = calendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return date && weekStart(date);
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (m) {
    const date = calendarDate(Number(m[3]), Number(m[2]), Number(m[1]));
    return date && weekStart(date);
  }
  m = /^(\d{4})-?W(\d{1,2})(?:-?[1-7])?$/i.exec(value);
  if (m) return weekStartOf(Number(m[1]), Number(m[2]));
  return null;
}

/** Every week from the one `from` falls in to the one `to` falls in, as Mondays. */
export function weeksInRange(from: string, to: string): string[] {
  const out: string[] = [];
  const last = weekStart(to);
  for (let week = weekStart(from); week <= last; week = addWeeks(week, 1)) out.push(week);
  return out;
}

/**
 * The weeks a summary covers: `from` defaults to the current week, `to` to `DEMAND_DEFAULT_WEEKS`
 * weeks on. Both are Mondays (`to` is the start of the last week). `null` when `to` is before
 * `from` or the range is longer than `DEMAND_MAX_WEEKS`.
 */
export function demandRange(
  query: { from?: string | undefined; to?: string | undefined },
  today: string,
): { from: string; to: string } | null {
  const from = weekStart(query.from ?? today);
  const to = weekStart(query.to ?? addWeeks(from, DEMAND_DEFAULT_WEEKS - 1));
  if (to < from || daysBetween(from, to) / 7 + 1 > DEMAND_MAX_WEEKS) return null;
  return { from, to };
}

// ─── Lines: keys and customers ───────────────────────────────────────────────

/** A customer or channel name as stored: trimmed, inner spaces collapsed, blank → `null`. */
export const normalizeCustomer = (value: string | null | undefined): string | null =>
  (value ?? "").trim().replace(/\s+/g, " ") || null;

/** How customers are compared: case-insensitively, no customer as "". */
export const customerKey = (customer: string | null | undefined): string =>
  (normalizeCustomer(customer) ?? "").toLowerCase();

/** The identity of a demand line: one live line per item, week and customer. */
export const demandKey = (itemId: string, periodStart: string, customer: string | null | undefined) =>
  `${itemId}|${periodStart}|${customerKey(customer)}`;

// ─── Validation ──────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const flag = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");
const paging = {
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

// ─── Units of sale (pack units) ──────────────────────────────────────────────

/** A named pack of an item: `size` base units (g, ml or each) in one. */
export interface PackUnit {
  name: string;
  size: number;
}

/** Pack units in one item's list of at most this many. */
export const PACK_UNITS_PER_ITEM = 20;
/** Pack unit names are compared without case or extra spaces. */
export const packUnitKey = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();
export const normalizePackName = (name: string): string => name.trim().replace(/\s+/g, " ");

/** The pack unit an entry's unit text names, if the item has one by that name. */
export const findPackUnit = (
  packUnits: readonly PackUnit[] | undefined,
  text: string,
): PackUnit | undefined => {
  const key = packUnitKey(text);
  return packUnits?.find((p) => packUnitKey(p.name) === key);
};

/** Names that mean a plain unit, so a pack can't hide one (`kg`, `each`, `litres`, …). */
export const isPlainUnitName = (name: string): boolean => parseUnitText(name) !== null;

const packName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .transform(normalizePackName)
  .refine(
    (v) => !isPlainUnitName(v),
    "That is a unit already (kg, g, l, ml, each…); name the pack, e.g. case",
  );

/**
 * One pack unit to set. The item is given by id or stock code. `size` is how much is in one pack,
 * in `unit` (default: the item's base unit g, ml or each); `null` removes the pack.
 */
export const packUnitInputSchema = z
  .object({
    itemId: z.uuid().optional(),
    itemCode: z.string().trim().min(1).max(40).optional(),
    name: packName,
    size: z.number().positive().finite().max(MAX_QUANTITY).nullable(),
    unit: z.enum(unitCodes).optional(),
  })
  .refine((v) => Boolean(v.itemId) !== Boolean(v.itemCode), {
    path: ["itemId"],
    message: "Give the item's id or its code (one of them)",
  });
export type PackUnitInput = z.infer<typeof packUnitInputSchema>;

/** `PUT /demand/pack-units`: create, resize or remove (`size: null`) packs, all or nothing. */
export const packUnitsSetSchema = z.object({ packUnits: z.array(packUnitInputSchema).min(1).max(200) });
export type PackUnitsSetInput = z.infer<typeof packUnitsSetSchema>;

export const packUnitListQuerySchema = z.object({
  itemId: z.uuid().optional(),
  itemCode: z.string().trim().min(1).max(40).optional(),
});
export type PackUnitListQuery = z.infer<typeof packUnitListQuerySchema>;

const PERIOD_HELP = "Use a date (2026-11-09 or 09/11/2026) or an ISO week (2026-W46)";

/** A period in any form `parsePeriod` reads, as the Monday of its week. */
export const demandPeriodSchema = z
  .string()
  .trim()
  .max(20)
  .transform((value, ctx) => {
    const monday = parsePeriod(value);
    if (!monday) {
      ctx.addIssue({ code: "custom", message: `"${value}" is not a date or week. ${PERIOD_HELP}` });
      return z.NEVER;
    }
    return monday;
  });

const customerField = z.string().trim().max(120).nullable();

/**
 * One line to set. The item is given by id or by its stock code (what a sales system knows). The
 * quantity is in `unit` (default: the item's own unit); `null` removes the line. `note` and
 * `externalRef` are kept as they are when left out, cleared with `null`.
 */
export const demandLineInputSchema = z
  .object({
    itemId: z.uuid().optional(),
    itemCode: z.string().trim().min(1).max(40).optional(),
    period: demandPeriodSchema,
    quantity: z.number().min(0).finite().max(MAX_QUANTITY).nullable(),
    /** A unit (`kg`, `each`…) or one of the item's pack units (`case`); default: the item's own. */
    unit: z.string().trim().min(1).max(40).optional(),
    customer: customerField.optional(),
    note: optionalText(500).optional(),
    /** The sales system's reference for this line (an order or forecast line id). */
    externalRef: optionalText(120).optional(),
  })
  .refine((v) => Boolean(v.itemId) !== Boolean(v.itemCode), {
    path: ["itemId"],
    message: "Give the item's id or its code (one of them)",
  });
export type DemandLineInput = z.infer<typeof demandLineInputSchema>;

/** `PUT /demand/lines`: set (create, replace or remove) many lines in one transaction. */
export const demandLinesSetSchema = z.object({
  lines: z.array(demandLineInputSchema).min(1).max(DEMAND_SET_MAX_LINES),
});
export type DemandLinesSetInput = z.infer<typeof demandLinesSetSchema>;

const rangeInOrder = (v: { from?: string | undefined; to?: string | undefined }) =>
  !v.from || !v.to || v.from <= v.to;
const RANGE_ERROR = { path: ["to"], message: "The end is before the start" };

export const demandLineListQuerySchema = z
  .object({
    itemId: z.uuid().optional(),
    /** The item's stock code (case-insensitive), instead of its id. */
    itemCode: z.string().trim().min(1).max(40).optional(),
    /** Weeks from the one this falls in (date or ISO week). */
    from: demandPeriodSchema.optional(),
    /** Up to and including the week this falls in. */
    to: demandPeriodSchema.optional(),
    /** Exact customer name, case-insensitive. */
    customer: z.string().trim().min(1).max(120).optional(),
    source: z.enum(demandSources).optional(),
    importId: z.uuid().optional(),
    /** Item name or code. */
    q: z.string().trim().max(200).optional(),
    ...paging,
  })
  .refine(rangeInOrder, RANGE_ERROR);
export type DemandLineListQuery = z.infer<typeof demandLineListQuerySchema>;

/** `GET /demand/summary`: totals per item per week. */
export const demandSummaryQuerySchema = z
  .object({
    /** Default: the current week. */
    from: demandPeriodSchema.optional(),
    /** Default: `DEMAND_DEFAULT_WEEKS` weeks from `from`; at most `DEMAND_MAX_WEEKS` in all. */
    to: demandPeriodSchema.optional(),
    itemId: z.uuid().optional(),
    /** The item's stock code (case-insensitive), instead of its id. */
    itemCode: z.string().trim().min(1).max(40).optional(),
    itemType: z.enum(demandItemTypes).optional(),
    /** One row per item and customer instead of one per item. */
    byCustomer: flag,
  })
  .refine(rangeInOrder, RANGE_ERROR);
export type DemandSummaryQuery = z.infer<typeof demandSummaryQuerySchema>;

/** `POST /demand/imports`: CSV text, checked (`dryRun`) or imported. */
export const demandImportSchema = z.object({
  csv: z.string().min(1).max(DEMAND_IMPORT_MAX_CHARS),
  fileName: optionalText(200).optional(),
  /** Check and preview only: nothing is written. */
  dryRun: z.boolean().optional(),
  /**
   * Opt-in: also remove (soft-delete, kept in the history) every live line, for any item and
   * customer, in the weeks from the file's first to its last that the file doesn't have.
   */
  replaceHorizon: z.boolean().optional(),
});
export type DemandImportInput = z.infer<typeof demandImportSchema>;

export const demandImportListQuerySchema = z.object(paging);
export type DemandImportListQuery = z.infer<typeof demandImportListQuerySchema>;

// ─── Entries: what a CSV row or an API line says, before it meets the items ──

/** A problem with one row of an import (spreadsheet row number) or one line of a request (1-based). */
export interface DemandRowError {
  row: number;
  column?: DemandCsvColumn | undefined;
  message: string;
}

/** One line to write, from a CSV row or a request, with its period already a Monday. */
export interface DemandEntry {
  row: number;
  itemId?: string | undefined;
  itemCode?: string | undefined;
  periodStart: string;
  /** In `unit`; `null` removes the line. */
  quantity: number | null;
  /** As written: a unit (`kg`, `Kgs`), an item's pack unit (`case`); `null`: the item's own unit. */
  unit: string | null;
  customer: string | null;
  /** `undefined` keeps what the line has; `null` clears it. */
  note?: string | null | undefined;
  externalRef?: string | null | undefined;
}

/** A request's lines as entries, numbered from 1. */
export const demandEntriesFromInput = (input: DemandLinesSetInput): DemandEntry[] =>
  input.lines.map((line, index) => ({
    row: index + 1,
    itemId: line.itemId,
    itemCode: line.itemCode,
    periodStart: line.period,
    quantity: line.quantity,
    unit: line.unit ?? null,
    customer: normalizeCustomer(line.customer),
    note: line.note,
    externalRef: line.externalRef,
  }));

// ─── CSV import ──────────────────────────────────────────────────────────────

export const demandCsvColumns = [
  "item",
  "period",
  "quantity",
  "unit",
  "customer",
  "note",
  "reference",
] as const;
export type DemandCsvColumn = (typeof demandCsvColumns)[number];

/** Header names each column is recognised by (compared without case, spaces or punctuation). */
export const demandCsvHeaders: Record<DemandCsvColumn, readonly string[]> = {
  item: ["item", "item code", "code", "stock code", "sku", "product", "product code"],
  period: ["period", "week", "week start", "week commencing", "w/c", "wc", "date", "period start"],
  quantity: ["quantity", "qty", "demand", "forecast", "amount"],
  unit: ["unit", "uom", "units"],
  customer: ["customer", "channel", "account"],
  note: ["note", "notes", "comment"],
  reference: ["reference", "ref", "external ref", "external reference", "order"],
};

/** A header template people can download and fill in. */
export const DEMAND_CSV_TEMPLATE = "item,period,quantity,unit,customer,note\r\n";

const headerKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const headerLookup = new Map<string, DemandCsvColumn>(
  demandCsvColumns.flatMap((column) => demandCsvHeaders[column].map((h) => [headerKey(h), column] as const)),
);

const unitAliases: Record<string, UnitCode> = {
  ...Object.fromEntries(unitCodes.map((u) => [u, u])),
  kgs: "kg",
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  gram: "g",
  grams: "g",
  litre: "l",
  litres: "l",
  liter: "l",
  liters: "l",
  ltr: "l",
  millilitre: "ml",
  millilitres: "ml",
  ea: "each",
  pcs: "each",
  pc: "each",
  unit: "each",
  units: "each",
};

/** A unit as people write it (`kg`, `Kgs`, `litres`, `ea`), or `null`. */
export const parseUnitText = (text: string): UnitCode | null =>
  unitAliases[text.trim().toLowerCase().replace(/\.$/, "")] ?? null;

/**
 * A non-negative quantity as people write it: `1200`, `1,200`, `12.5`, ` 40 `. `null` for
 * anything else (including negatives and `1.200,5`).
 */
export function parseQuantityText(text: string): number | null {
  let value = text.trim().replace(/\s/g, "");
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(value)) value = value.replaceAll(",", "");
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n <= MAX_QUANTITY ? n : null;
}

export interface DemandCsvResult {
  entries: DemandEntry[];
  errors: DemandRowError[];
  /** Data rows read (blank rows are skipped and not counted). */
  rowCount: number;
  /** Header cells that are not a known column; their values are ignored. */
  ignoredColumns: string[];
}

/**
 * Reads a demand CSV: a header row, then one row per item, week and customer. Columns (any order,
 * names from `demandCsvHeaders`): `item` (stock code), `period` (date or ISO week), `quantity`
 * (0 or more) are required; `unit` (default: the item's unit), `customer`, `note` and `reference`
 * are optional. An empty `note` or `reference` cell clears it; a missing column keeps it.
 *
 * Checks what can be checked without the items (columns, periods, numbers, units, lengths) and
 * reports every problem with its spreadsheet row; `resolveDemandEntries` does the rest.
 */
export function parseDemandCsv(text: string): DemandCsvResult {
  const records = parseCsv(text);
  const errors: DemandRowError[] = [];
  const headerIndex = records.findIndex((r) => r.some((cell) => cell.trim() !== ""));
  if (headerIndex < 0) {
    return {
      entries: [],
      errors: [{ row: 1, message: "The file is empty" }],
      rowCount: 0,
      ignoredColumns: [],
    };
  }
  const header = records[headerIndex]!;
  const columns = new Map<DemandCsvColumn, number>();
  const ignoredColumns: string[] = [];
  header.forEach((cell, index) => {
    const column = headerLookup.get(headerKey(cell));
    if (column && !columns.has(column)) columns.set(column, index);
    else if (cell.trim()) ignoredColumns.push(cell.trim());
  });
  const missing = (["item", "period", "quantity"] as const).filter((c) => !columns.has(c));
  if (missing.length) {
    return {
      entries: [],
      errors: missing.map((column) => ({
        row: headerIndex + 1,
        column,
        message: `No "${column}" column. The first row must name the columns, e.g. ${DEMAND_CSV_TEMPLATE.trim()}`,
      })),
      rowCount: 0,
      ignoredColumns,
    };
  }

  const entries: DemandEntry[] = [];
  let rowCount = 0;
  for (let index = headerIndex + 1; index < records.length; index++) {
    const record = records[index]!;
    if (record.every((cell) => cell.trim() === "")) continue;
    rowCount++;
    const row = index + 1;
    if (rowCount > DEMAND_IMPORT_MAX_ROWS) {
      errors.push({
        row,
        message: `An import can have at most ${DEMAND_IMPORT_MAX_ROWS} rows; split the file`,
      });
      break;
    }
    const cell = (column: DemandCsvColumn) => {
      const i = columns.get(column);
      return i === undefined ? undefined : (record[i] ?? "").trim();
    };
    const fail = (column: DemandCsvColumn, message: string) => errors.push({ row, column, message });
    const before = errors.length;

    const itemCode = cell("item")!;
    if (!itemCode) fail("item", "The item code is missing");
    else if (itemCode.length > 40) fail("item", "The item code is longer than 40 characters");

    const periodText = cell("period")!;
    const periodStart = periodText ? parsePeriod(periodText) : null;
    if (!periodText) fail("period", "The period is missing");
    else if (!periodStart) fail("period", `"${periodText}" is not a date or week. ${PERIOD_HELP}`);

    const quantityText = cell("quantity")!;
    const quantity = parseQuantityText(quantityText);
    if (!quantityText) fail("quantity", "The quantity is missing (use 0 for no demand)");
    else if (quantity === null) fail("quantity", `"${quantityText}" is not a quantity of 0 or more`);

    const unitText = cell("unit");
    // Kept as written: it may name one of the item's pack units, which is known only later.
    const unit = unitText || null;
    if (unit && unit.length > 40) fail("unit", "The unit is longer than 40 characters");

    const customer = normalizeCustomer(cell("customer"));
    if (customer && customer.length > 120) fail("customer", "The customer is longer than 120 characters");
    const note = cell("note");
    if (note && note.length > 500) fail("note", "The note is longer than 500 characters");
    const reference = cell("reference");
    if (reference && reference.length > 120) fail("reference", "The reference is longer than 120 characters");

    if (errors.length > before) continue;
    entries.push({
      row,
      itemCode,
      periodStart: periodStart!,
      quantity: quantity!,
      unit,
      customer,
      ...(note !== undefined ? { note: note || null } : {}),
      ...(reference !== undefined ? { externalRef: reference || null } : {}),
    });
  }
  if (rowCount === 0 && errors.length === 0) {
    errors.push({ row: headerIndex + 2, message: "The file has a header but no rows" });
  }
  return { entries, errors, rowCount, ignoredColumns };
}

// ─── Resolving entries against items ─────────────────────────────────────────

/** What demand needs to know about an item. */
export interface DemandItem extends UnitBridge {
  id: string;
  code: string;
  name: string;
  type: ItemType;
  unit: UnitCode;
  status: ItemStatus;
  /** Units of sale; left out when the item has none. */
  packUnits?: readonly PackUnit[] | undefined;
}

/** An entry checked against its item, with the quantity in the item's base unit. */
export interface ResolvedDemandEntry {
  row: number;
  item: DemandItem;
  periodStart: string;
  customer: string | null;
  /** Base unit (g, ml, each), 4 decimal places; `null` removes the line. */
  quantity: number | null;
  /** What was typed when it was in a pack unit (`{ quantity: 5, unit: "case" }`); else `null`. */
  entered: { quantity: number; unit: string } | null;
  note?: string | null | undefined;
  externalRef?: string | null | undefined;
}

/**
 * Checks entries against the items they name: the item must exist; a quantity needs a live
 * finished good or WIP item and a unit that converts to it; one entry per item, week and customer.
 * Removing a line (`quantity: null`) only needs the item to exist. Every problem is reported; the
 * caller writes nothing unless `errors` is empty.
 */
export function resolveDemandEntries(
  entries: readonly DemandEntry[],
  findItem: (ref: { itemId?: string | undefined; itemCode?: string | undefined }) => DemandItem | undefined,
): { resolved: ResolvedDemandEntry[]; errors: DemandRowError[] } {
  const resolved: ResolvedDemandEntry[] = [];
  const errors: DemandRowError[] = [];
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const fail = (column: DemandCsvColumn, message: string) =>
      errors.push({ row: entry.row, column, message });
    const item = findItem({ itemId: entry.itemId, itemCode: entry.itemCode });
    if (!item) {
      fail("item", entry.itemCode ? `No item has the code "${entry.itemCode}"` : "Item not found");
      continue;
    }
    let quantity: number | null = null;
    let entered: ResolvedDemandEntry["entered"] = null;
    if (entry.quantity !== null) {
      if (item.status !== "active") {
        fail("item", `${item.code} is archived; make it active again to plan demand for it`);
        continue;
      }
      if (!isDemandItemType(item.type)) {
        fail("item", `${item.code} is not a finished good or work in progress; demand is for products`);
        continue;
      }
      const pack = entry.unit ? findPackUnit(item.packUnits, entry.unit) : undefined;
      const options = [...unitsForItem(item), ...(item.packUnits ?? []).map((p) => p.name)].join(", ");
      if (pack) {
        quantity = roundQuantity(entry.quantity * pack.size);
        entered = { quantity: entry.quantity, unit: pack.name };
      } else {
        const unit = entry.unit === null ? item.unit : parseUnitText(entry.unit);
        if (!unit) {
          fail(
            "unit",
            `"${entry.unit}" is not a unit or a pack unit of ${item.code}. Use one of: ${options}`,
          );
          continue;
        }
        quantity = toBaseQuantity(entry.quantity, unit, item);
        if (quantity === null) {
          fail(
            "unit",
            `${item.code} is measured in ${item.unit}; ${unit} can't be converted without a density or unit weight. Use one of: ${options}`,
          );
          continue;
        }
      }
      if (quantity === 0 && entry.quantity !== 0) {
        fail("quantity", "The quantity is too small to record (below 0.0001 of the base unit)");
        continue;
      }
    }
    const key = demandKey(item.id, entry.periodStart, entry.customer);
    const first = seen.get(key);
    if (first !== undefined) {
      fail(
        "item",
        `Same item, week and customer as row ${first} (${item.code}, ${formatWeek(entry.periodStart)}${entry.customer ? `, ${entry.customer}` : ""})`,
      );
      continue;
    }
    seen.set(key, entry.row);
    resolved.push({
      row: entry.row,
      item,
      periodStart: entry.periodStart,
      customer: entry.customer,
      quantity,
      entered,
      ...(entry.note !== undefined ? { note: entry.note } : {}),
      ...(entry.externalRef !== undefined ? { externalRef: entry.externalRef } : {}),
    });
  }
  return { resolved, errors };
}

/** What happens to one line when entries are applied. */
export const demandActions = ["create", "update", "remove", "unchanged"] as const;
export type DemandAction = (typeof demandActions)[number];

/**
 * What applying an entry does to the line it names (`current`: the live line with that key, if
 * any; quantities in the base unit). Notes and references count as changes only when the entry
 * gives them.
 */
export function demandAction(
  entry: Pick<ResolvedDemandEntry, "quantity" | "note" | "externalRef">,
  current: { quantity: number; note: string | null; externalRef: string | null } | undefined,
): DemandAction {
  if (entry.quantity === null) return current ? "remove" : "unchanged";
  if (!current) return "create";
  const changed =
    current.quantity !== entry.quantity ||
    (entry.note !== undefined && entry.note !== current.note) ||
    (entry.externalRef !== undefined && entry.externalRef !== current.externalRef);
  return changed ? "update" : "unchanged";
}

// ─── Summary: what production plans from ─────────────────────────────────────

/** An item as demand responses show it. */
export interface DemandItemSummary {
  id: string;
  code: string;
  name: string;
  type: ItemType;
  unit: UnitCode;
  status: ItemStatus;
  /** Units of sale, when the item has any. */
  packUnits?: PackUnit[] | undefined;
}

export interface DemandWeek {
  /** The Monday the week starts on. */
  periodStart: string;
  /** e.g. `2026-W46`. */
  week: string;
}

export interface DemandSummaryCell extends DemandWeek {
  /** Total demand in the week (base unit and the item's own unit). */
  quantity: StockAmount;
  /** How many lines (customers) make it up. */
  lineCount: number;
}

export interface DemandSummaryRow {
  item: DemandItemSummary;
  /** With `byCustomer`: the customer (`null` for lines without one). Otherwise always `null`. */
  customer: string | null;
  /** Over the whole range. */
  total: StockAmount;
  /** Weeks with demand only, in order. */
  periods: DemandSummaryCell[];
}

/**
 * Demand per item per week over a range: the contract the production module plans batches from
 * (`getDemandSummary` in the API's demand service, `GET /demand/summary`). Quantities are
 * `quantity.base` in `quantity.baseUnit` (g, ml or each).
 */
export interface DemandSummary {
  /** Monday of the first week. */
  from: string;
  /** Monday of the last week (inclusive). */
  to: string;
  /** Every week in the range, in order, whether or not it has demand. */
  weeks: DemandWeek[];
  byCustomer: boolean;
  /** Items (and customers) with demand in the range, by item code then customer. */
  rows: DemandSummaryRow[];
}

/** Total base quantity for one item (and customer) in one week, e.g. a `group by` row. */
export interface DemandCellInput {
  itemId: string;
  periodStart: string;
  customer: string | null;
  quantity: number;
  lineCount: number;
}

export const demandWeek = (periodStart: string): DemandWeek => ({
  periodStart,
  week: formatWeek(periodStart),
});

/**
 * Builds the summary from per-week totals (any grouping finer than the result is summed). Cells
 * outside the range or for unknown items are ignored.
 */
export function buildDemandSummary(input: {
  from: string;
  to: string;
  byCustomer: boolean;
  cells: readonly DemandCellInput[];
  items: ReadonlyMap<string, DemandItemSummary>;
}): DemandSummary {
  const weeks = weeksInRange(input.from, input.to);
  const inRange = new Set(weeks);
  const rows = new Map<
    string,
    { item: DemandItemSummary; customer: string | null; byWeek: Map<string, { qty: number; lines: number }> }
  >();
  for (const cell of input.cells) {
    const item = input.items.get(cell.itemId);
    if (!item || !inRange.has(cell.periodStart)) continue;
    const key = input.byCustomer ? `${cell.itemId}|${customerKey(cell.customer)}` : cell.itemId;
    let row = rows.get(key);
    if (!row) {
      row = {
        item,
        customer: input.byCustomer ? normalizeCustomer(cell.customer) : null,
        byWeek: new Map(),
      };
      rows.set(key, row);
    }
    const sum = row.byWeek.get(cell.periodStart) ?? { qty: 0, lines: 0 };
    sum.qty += cell.quantity;
    sum.lines += cell.lineCount;
    row.byWeek.set(cell.periodStart, sum);
  }
  const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    from: weekStart(input.from),
    to: weekStart(input.to),
    weeks: weeks.map(demandWeek),
    byCustomer: input.byCustomer,
    rows: [...rows.values()]
      .sort(
        (a, b) =>
          text(a.item.code.toLowerCase(), b.item.code.toLowerCase()) ||
          text(a.item.id, b.item.id) ||
          text(customerKey(a.customer), customerKey(b.customer)),
      )
      .map(({ item, customer, byWeek }) => {
        const periods = weeks
          .filter((w) => byWeek.has(w))
          .map((w) => ({
            ...demandWeek(w),
            quantity: stockAmount(byWeek.get(w)!.qty, item),
            lineCount: byWeek.get(w)!.lines,
          }));
        return {
          item,
          customer,
          total: stockAmount(
            periods.reduce((sum, p) => sum + p.quantity.base, 0),
            item,
          ),
          periods,
        };
      }),
  };
}
