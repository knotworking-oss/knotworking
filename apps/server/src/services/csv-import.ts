import type { CsvImportRowError } from "@knotworking/core";
import { ApiError } from "../errors";

/**
 * Shared by the master-data CSV imports (items, suppliers, staff): the error a refused import
 * answers with and the shape of the result. The demand import (`services/demand.ts`) is the
 * reference these follow.
 */

/** Changes listed in a result; the counts cover every row. */
export const PREVIEW_LIMIT = 200;

/** Rows per statement when writing many. */
export const WRITE_CHUNK = 500;

export function chunks<T>(list: readonly T[], size = WRITE_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** `400 invalid_rows`, listing every problem, the first few in the message so an agent sees them. */
export function invalidRows(errors: readonly CsvImportRowError[]) {
  const sorted = [...errors].sort((a, b) => a.row - b.row);
  const shown = sorted
    .slice(0, 5)
    .map((e) => `Row ${e.row}${e.column ? ` (${e.column})` : ""}: ${e.message}`);
  const more = sorted.length > 5 ? `; and ${sorted.length - 5} more` : "";
  const rows = new Set(sorted.map((e) => e.row)).size;
  return new ApiError(
    400,
    "invalid_rows",
    `${rows} row${rows === 1 ? " has" : "s have"} problems; nothing was saved. ${shown.join("; ")}${more}`,
    { errors: sorted },
  );
}

/** One row of a result: what the import creates or updates, and which fields it changes. */
export interface ImportChange {
  row: number;
  action: "create" | "update";
  /** Stock code, supplier code or name, or staff number. */
  key: string;
  name: string;
  /** Fields an update changes (empty for a create). */
  fields: string[];
}

export function importResult(args: {
  dryRun: boolean;
  fileName: string | null;
  rowCount: number;
  ignoredColumns: string[];
  errors: CsvImportRowError[];
  changes: ImportChange[];
  unchanged: number;
}) {
  const { changes, ...rest } = args;
  return {
    ...rest,
    created: changes.filter((c) => c.action === "create").length,
    updated: changes.filter((c) => c.action === "update").length,
    /** The changes the import makes (or made), in row order; the first `PREVIEW_LIMIT`. */
    changes: changes.slice(0, PREVIEW_LIMIT),
    changesTruncated: changes.length > PREVIEW_LIMIT,
  };
}
