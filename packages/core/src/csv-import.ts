import { z } from "zod";
import { parseCsv } from "./csv";

/**
 * Shared plumbing for the master-data CSV imports (items, suppliers, staff): the request body, a
 * header-row reader, and cell parsers for the things people type into spreadsheets. The demand
 * import has its own parser (`demand.ts`) and the same shape of result. No DOM or Node APIs.
 */

/** Data rows in one import. */
export const CSV_IMPORT_MAX_ROWS = 5000;
/** Characters of CSV text in one import (about 2 MB). */
export const CSV_IMPORT_MAX_CHARS = 2_000_000;

/** `POST …/import`: CSV text, checked (`dryRun`) or imported. */
export const csvImportSchema = z.object({
  csv: z.string().min(1).max(CSV_IMPORT_MAX_CHARS),
  fileName: z.string().trim().max(200).optional(),
  /** Check and preview only: nothing is written. */
  dryRun: z.boolean().optional(),
});
export type CsvImportInput = z.infer<typeof csvImportSchema>;

/** A problem with one row of an import, by spreadsheet row number (the header is row 1 or later). */
export interface CsvImportRowError<C extends string = string> {
  row: number;
  column?: C | undefined;
  message: string;
}

/** One row's cells, looked up by column. */
export interface CsvTableRow<C extends string> {
  /** Spreadsheet row number. */
  row: number;
  /** The trimmed cell; `undefined` when the file has no such column, `""` when it is empty. */
  cell(column: C): string | undefined;
}

export interface CsvTable<C extends string> {
  rows: CsvTableRow<C>[];
  /** Columns the header names. */
  columns: Set<C>;
  errors: CsvImportRowError<C>[];
  /** Data rows read (blank rows are skipped and not counted). */
  rowCount: number;
  /** Header cells that are not a known column; their values are never read. */
  ignoredColumns: string[];
}

const headerKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Reads a CSV with a header row: finds each known column by its header names (compared without
 * case, spaces or punctuation), reports the required ones that are missing, and returns the
 * non-blank data rows. A column named twice uses the first. Stops at `CSV_IMPORT_MAX_ROWS`.
 */
export function readCsvTable<C extends string>(
  text: string,
  spec: { columns: Record<C, readonly string[]>; required: readonly C[]; template: string },
): CsvTable<C> {
  const records = parseCsv(text);
  const empty = (errors: CsvImportRowError<C>[], ignoredColumns: string[] = []): CsvTable<C> => ({
    rows: [],
    columns: new Set(),
    errors,
    rowCount: 0,
    ignoredColumns,
  });
  const headerIndex = records.findIndex((r) => r.some((cell) => cell.trim() !== ""));
  if (headerIndex < 0) return empty([{ row: 1, message: "The file is empty" }]);

  const lookup = new Map<string, C>();
  for (const column of Object.keys(spec.columns) as C[]) {
    lookup.set(headerKey(column), column);
    for (const name of spec.columns[column]) lookup.set(headerKey(name), column);
  }
  const positions = new Map<C, number>();
  const ignoredColumns: string[] = [];
  records[headerIndex]!.forEach((cell, index) => {
    const column = lookup.get(headerKey(cell));
    if (column && !positions.has(column)) positions.set(column, index);
    else if (cell.trim()) ignoredColumns.push(cell.trim());
  });
  const missing = spec.required.filter((c) => !positions.has(c));
  if (missing.length) {
    return empty(
      missing.map((column) => ({
        row: headerIndex + 1,
        column,
        message: `No "${column}" column. The first row must name the columns, e.g. ${spec.template.trim()}`,
      })),
      ignoredColumns,
    );
  }

  const rows: CsvTableRow<C>[] = [];
  const errors: CsvImportRowError<C>[] = [];
  let rowCount = 0;
  for (let index = headerIndex + 1; index < records.length; index++) {
    const record = records[index]!;
    if (record.every((cell) => cell.trim() === "")) continue;
    rowCount++;
    if (rowCount > CSV_IMPORT_MAX_ROWS) {
      errors.push({
        row: index + 1,
        message: `An import can have at most ${CSV_IMPORT_MAX_ROWS} rows; split the file`,
      });
      break;
    }
    rows.push({
      row: index + 1,
      cell: (column) => {
        const i = positions.get(column);
        return i === undefined ? undefined : (record[i] ?? "").trim();
      },
    });
  }
  if (rowCount === 0 && errors.length === 0) {
    errors.push({ row: headerIndex + 2, message: "The file has a header but no rows" });
  }
  return { rows, columns: new Set(positions.keys()), errors, rowCount, ignoredColumns };
}

// ─── Cells ───────────────────────────────────────────────────────────────────

/** A real calendar date as `YYYY-MM-DD`, or `null` (e.g. 31 February). */
function isoDateOf(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2999) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** A date as people write it: `2026-11-12` or a UK date, day first (`12/11/2026`, `12.11.2026`). */
export function parseDateText(text: string): string | null {
  const value = text.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return isoDateOf(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (m) return isoDateOf(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

export const DATE_HELP = "Use a date such as 2026-11-12 or 12/11/2026 (day first)";

/**
 * A non-negative number as people write it: `12`, `1,200`, `0.85`, `£4.20`, ` 40 `. `null` for
 * anything else (negatives, `1.200,5`, text). A leading currency sign is dropped.
 */
export function parseNumberText(text: string): number | null {
  let value = text
    .trim()
    .replace(/^[£$€]\s*/, "")
    .replace(/\s/g, "");
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(value)) value = value.replaceAll(",", "");
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A whole number of 0 or more (`14`, `1,000`, `14 days` is not one), or `null`. */
export function parseWholeNumberText(text: string): number | null {
  const n = parseNumberText(text);
  return n !== null && Number.isInteger(n) ? n : null;
}

/** Splits a list cell: `a; b`, `a | b` or `a, b`. Blank items are dropped. */
export const splitListText = (text: string): string[] =>
  text
    .split(/[;|,]/)
    .map((part) => part.trim())
    .filter(Boolean);

/** Cell text meaning "nothing" in a list cell. */
export const isNoneText = (text: string) => /^(none|n\/a|nil|-)$/i.test(text.trim());

/** Problems found while reading, in row order. */
export const sortRowErrors = <E extends { row: number }>(errors: E[]): E[] =>
  [...errors].sort((a, b) => a.row - b.row);
