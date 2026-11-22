import {
  DATE_HELP,
  isNoneText,
  parseDateText,
  readCsvTable,
  sortRowErrors,
  splitListText,
  type CsvImportRowError,
} from "./csv-import";
import { STAFF_NUMBER_LENGTH, isStaffNumber, staffStatuses, type StaffStatus } from "./people";

/**
 * CSV import of staff: one row per person, created or updated by staff number. A staff number is
 * the key, so an import can never change one (a different number is a different person): the rule
 * that a number is fixed once a person has training or attendance records holds by construction.
 * Kiosk PINs are never read, whatever the file calls a column; PINs stay a manager's act in the
 * app. Linking a person to a login is not importable either. Shared by the API, the web app and
 * agents.
 */

export const staffCsvColumns = [
  "staffNumber",
  "firstName",
  "lastName",
  "jobTitle",
  "department",
  "jobRoles",
  "startDate",
  "endDate",
  "payrollReference",
  "status",
] as const;
export type StaffCsvColumn = (typeof staffCsvColumns)[number];

export const staffCsvHeaders: Record<StaffCsvColumn, readonly string[]> = {
  staffNumber: [
    "staff number",
    "staff no",
    "staff id",
    "employee number",
    "employee no",
    "number",
    "clock number",
  ],
  firstName: ["first name", "forename", "given name", "first"],
  lastName: ["last name", "surname", "family name", "last"],
  jobTitle: ["job title", "title", "position"],
  department: ["department", "dept", "team"],
  jobRoles: ["job roles", "job role", "roles", "role"],
  startDate: ["start date", "started", "date started", "joined", "hire date", "start"],
  endDate: ["end date", "left", "date left", "leaving date", "leave date"],
  payrollReference: ["payroll reference", "payroll ref", "payroll number", "payroll id", "payroll"],
  status: ["status"],
};

export const STAFF_CSV_TEMPLATE =
  "staff number,first name,last name,job title,department,job roles,start date,payroll reference\r\n" +
  "100001,Ada,Lovelace,Line operative,Production,Line operative; Hygiene,2026-01-05,E1234\r\n";

/**
 * One row, as read. `firstName`, `lastName` and `status` are `undefined` when the cell is empty
 * (an existing person keeps them; a new person needs both names). For the other fields an empty
 * cell clears the value (an empty `job roles` cell means no roles), and a missing column leaves
 * it alone. Job roles are names; the server finds them.
 */
export interface StaffEntry {
  row: number;
  staffNumber: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  jobTitle?: string | null | undefined;
  department?: string | null | undefined;
  jobRoleNames?: string[] | undefined;
  startDate?: string | null | undefined;
  endDate?: string | null | undefined;
  payrollReference?: string | null | undefined;
  status?: StaffStatus | undefined;
}

export type StaffRowError = CsvImportRowError<StaffCsvColumn>;

export interface StaffCsvResult {
  entries: StaffEntry[];
  errors: StaffRowError[];
  rowCount: number;
  ignoredColumns: string[];
}

const textFields = [
  ["jobTitle", 200, "job title"],
  ["department", 200, "department"],
  ["payrollReference", 60, "payroll reference"],
] as const;

/**
 * Reads a staff CSV. Columns (any order, names from `staffCsvHeaders`): `staff number` (exactly
 * six digits; format the column as text so spreadsheets keep leading zeros) is required;
 * `first name` and `last name` (new people need both), `job title`, `department`, `job roles`
 * (names, separated by `;`), `start date`, `end date`, `payroll reference` and `status` are
 * optional. Other columns (a `PIN` column included) are ignored and reported, never read.
 */
export function parseStaffCsv(text: string): StaffCsvResult {
  const table = readCsvTable<StaffCsvColumn>(text, {
    columns: staffCsvHeaders,
    required: ["staffNumber"],
    template: STAFF_CSV_TEMPLATE.split("\r\n")[0]!,
  });
  const errors: StaffRowError[] = [...table.errors];
  const entries: StaffEntry[] = [];
  const firstRowOf = new Map<string, number>();

  for (const r of table.rows) {
    const row = r.row;
    const before = errors.length;
    const fail = (column: StaffCsvColumn, message: string) => errors.push({ row, column, message });

    const number = r.cell("staffNumber")!;
    if (!number) fail("staffNumber", "The staff number is missing");
    else if (!isStaffNumber(number)) {
      fail(
        "staffNumber",
        `"${number}" is not a staff number: it is exactly ${STAFF_NUMBER_LENGTH} digits (if a spreadsheet dropped a leading zero, format the column as text)`,
      );
    } else {
      const seen = firstRowOf.get(number);
      if (seen !== undefined) fail("staffNumber", `The staff number ${number} is already on row ${seen}`);
      else firstRowOf.set(number, row);
    }
    const entry: StaffEntry = { row, staffNumber: number };

    for (const column of ["firstName", "lastName"] as const) {
      const cell = r.cell(column);
      if (!cell) continue;
      if (cell.length > 100)
        fail(column, `The ${column === "firstName" ? "first" : "last"} name is longer than 100 characters`);
      else entry[column] = cell;
    }

    for (const [column, max, label] of textFields) {
      const cell = r.cell(column);
      if (cell === undefined) continue;
      if (cell.length > max) fail(column, `The ${label} is longer than ${max} characters`);
      else entry[column] = cell || null;
    }

    const roles = r.cell("jobRoles");
    if (roles !== undefined) {
      const names = isNoneText(roles) ? [] : splitListText(roles);
      const unique = names.filter(
        (n, i) => names.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i,
      );
      if (unique.length > 50) fail("jobRoles", "A person can have at most 50 job roles");
      else entry.jobRoleNames = unique;
    }

    for (const column of ["startDate", "endDate"] as const) {
      const cell = r.cell(column);
      if (cell === undefined) continue;
      const date = cell ? parseDateText(cell) : null;
      if (cell && !date) fail(column, `"${cell}" is not a date. ${DATE_HELP}`);
      else entry[column] = date;
    }
    if (entry.startDate && entry.endDate && entry.startDate > entry.endDate) {
      fail("endDate", "The start date is after the end date");
    }

    const statusText = r.cell("status");
    if (statusText) {
      const status = staffStatuses.find((s) => s === statusText.toLowerCase());
      if (status) entry.status = status;
      else fail("status", `"${statusText}" is not a status. Use one of: ${staffStatuses.join(", ")}`);
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
