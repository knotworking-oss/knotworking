import { z } from "zod";
import { DATE_HELP, parseDateText, readCsvTable, sortRowErrors, type CsvImportRowError } from "./csv-import";

/**
 * CSV import of suppliers: one row per supplier, created or updated by code, or by name when the
 * row has no code. The approval status is deliberately not a column: approval is a food-safety
 * sign-off by a person with `manage`, so imported suppliers start as `pending` and an existing
 * supplier's approval is never touched. Shared by the API, the web app and agents.
 */

export const supplierCsvColumns = [
  "code",
  "name",
  "contactName",
  "email",
  "phone",
  "address",
  "notes",
  "certification",
  "certificateExpiresOn",
] as const;
export type SupplierCsvColumn = (typeof supplierCsvColumns)[number];

export const supplierCsvHeaders: Record<SupplierCsvColumn, readonly string[]> = {
  code: ["code", "supplier code", "account", "account code", "reference", "ref"],
  name: ["name", "supplier", "supplier name", "company"],
  contactName: ["contact", "contact name", "contact person"],
  email: ["email", "e-mail", "email address", "contact email"],
  phone: ["phone", "telephone", "tel", "phone number", "contact phone"],
  address: ["address"],
  notes: ["notes", "note", "comments"],
  certification: ["certification", "certificate", "certificate type", "accreditation", "scheme"],
  certificateExpiresOn: [
    "certificate expiry",
    "certificate expires",
    "certificate expiry date",
    "certification expiry",
    "expiry",
    "expiry date",
    "expires",
    "expires on",
  ],
};

export const SUPPLIER_CSV_TEMPLATE =
  "code,name,contact name,email,phone,address,certification,certificate expiry\r\n" +
  "MILL01,Eastern Mills Ltd,Sam Baker,orders@easternmills.example,01234 567890,,BRCGS Food Safety AA,2027-03-31\r\n";

/**
 * One row, as read. `name` is `undefined` when the cell is empty (an existing supplier keeps its
 * name; a new one needs it). For the other fields an empty cell clears the value, and a missing
 * column leaves it alone.
 */
export interface SupplierEntry {
  row: number;
  code?: string | undefined;
  name?: string | undefined;
  contactName?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  address?: string | null | undefined;
  notes?: string | null | undefined;
  certification?: string | null | undefined;
  certificateExpiresOn?: string | null | undefined;
}

export type SupplierRowError = CsvImportRowError<SupplierCsvColumn>;

export interface SupplierCsvResult {
  entries: SupplierEntry[];
  errors: SupplierRowError[];
  rowCount: number;
  ignoredColumns: string[];
}

const emailSchema = z.email().max(320);
const textFields = [
  ["contactName", 200, "contact name"],
  ["phone", 60, "phone number"],
  ["address", 1000, "address"],
  ["notes", 4000, "notes"],
  ["certification", 200, "certification"],
] as const;

/**
 * Reads a suppliers CSV. Columns (any order, names from `supplierCsvHeaders`): a row needs a
 * `code` or a `name` (the file needs at least one of the two columns). Optional: `contact name`,
 * `email`, `phone`, `address`, `notes`, `certification`, `certificate expiry`. Other columns,
 * including any `approval` or `status` column, are ignored and reported.
 */
export function parseSuppliersCsv(text: string): SupplierCsvResult {
  const table = readCsvTable<SupplierCsvColumn>(text, {
    columns: supplierCsvHeaders,
    required: [],
    template: SUPPLIER_CSV_TEMPLATE.split("\r\n")[0]!,
  });
  const errors: SupplierRowError[] = [...table.errors];
  if (table.rows.length > 0 && !table.columns.has("code") && !table.columns.has("name")) {
    return {
      entries: [],
      errors: [
        {
          row: 1,
          message: `The first row must name a "code" or a "name" column, e.g. ${SUPPLIER_CSV_TEMPLATE.split("\r\n")[0]}`,
        },
      ],
      rowCount: 0,
      ignoredColumns: table.ignoredColumns,
    };
  }
  const entries: SupplierEntry[] = [];
  const firstRowOf = new Map<string, number>();

  for (const r of table.rows) {
    const row = r.row;
    const before = errors.length;
    const fail = (column: SupplierCsvColumn, message: string) => errors.push({ row, column, message });
    const entry: SupplierEntry = { row };

    const code = r.cell("code");
    const name = r.cell("name");
    if (!code && !name) {
      fail(table.columns.has("code") ? "code" : "name", "The row needs a supplier code or a name");
    }
    if (code) {
      if (code.length > 40) fail("code", "The code is longer than 40 characters");
      else entry.code = code;
    }
    if (name) {
      if (name.length > 200) fail("name", "The name is longer than 200 characters");
      else entry.name = name;
    }
    // The same supplier twice in one file: by code, or by name when there is no code.
    const identity = code ? `code:${code.toLowerCase()}` : name ? `name:${name.toLowerCase()}` : null;
    if (identity) {
      const seen = firstRowOf.get(identity);
      if (seen !== undefined) {
        fail(code ? "code" : "name", `This supplier is already on row ${seen}`);
      } else firstRowOf.set(identity, row);
    }

    for (const [column, max, label] of textFields) {
      const cell = r.cell(column);
      if (cell === undefined) continue;
      if (cell.length > max) fail(column, `The ${label} is longer than ${max} characters`);
      else entry[column] = cell || null;
    }

    const email = r.cell("email");
    if (email !== undefined) {
      if (email && !emailSchema.safeParse(email).success) fail("email", `"${email}" is not an email address`);
      else entry.email = email || null;
    }

    const expiry = r.cell("certificateExpiresOn");
    if (expiry !== undefined) {
      const date = expiry ? parseDateText(expiry) : null;
      if (expiry && !date) fail("certificateExpiresOn", `"${expiry}" is not a date. ${DATE_HELP}`);
      else entry.certificateExpiresOn = date;
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
