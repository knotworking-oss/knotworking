import { z } from "zod";
import { decimalHours } from "./attendance";
import { toCsv } from "./csv";
import { inclusiveDays } from "./time";

/**
 * Payroll runs (Phase 3.4.4.4): a reviewed, immutable snapshot of one pay period that payroll
 * exports are built from, and a provider-neutral adapter contract for payroll packages. Knotworking
 * records hours and absence days; it never calculates pay, holiday entitlement or statutory sick
 * pay. See docs/workforce.md.
 */

export const payrollRunStates = ["prepared", "approved", "superseded", "withdrawn"] as const;
export type PayrollRunState = (typeof payrollRunStates)[number];
export const payrollRunStateLabels: Record<PayrollRunState, string> = {
  prepared: "Prepared",
  approved: "Approved",
  superseded: "Superseded",
  withdrawn: "Withdrawn",
};

export interface PayrollAbsenceDays {
  /** Calendar days in the period, not working days or hours. */
  annual_leave: number;
  other_leave: number;
  sickness: number;
}
export interface PayrollRunEmployee {
  staffId: string;
  staffNumber: string;
  payrollReference: string | null;
  firstName: string;
  lastName: string;
  shifts: number;
  basicMinutes: number;
  overtimeMinutes: number;
  absenceDays: PayrollAbsenceDays;
}
/** Agency-supplied workers: paid by their agency, so listed for reconciliation and never exported as employees. */
export interface PayrollRunAgencyWorker {
  staffId: string;
  staffNumber: string;
  firstName: string;
  lastName: string;
  agencyName: string;
  reference: string;
  shifts: number;
  basicMinutes: number;
  overtimeMinutes: number;
}
export interface PayrollRunSnapshot {
  version: 1;
  from: string;
  to: string;
  /** Package references copied when the run was prepared, so exports are reproducible. */
  references: { sageBasicPaymentRef: string | null; sageOvertimePaymentRef: string | null };
  employees: PayrollRunEmployee[];
  agencyWorkers: PayrollRunAgencyWorker[];
  warnings: string[];
  /** Logins linked to the included staff when prepared: none of them may approve the run. */
  linkedUserIds: string[];
}

/**
 * Package compatibility of an export layout. `not_applicable`: Knotworking's own documented layout,
 * implying no package import. `unverified`: built from a package's published conventions but not
 * yet checked against a real import; exporting needs an explicit, recorded acknowledgement.
 * `verified`: checked against the package's own template with a successful test import, with the
 * evidence named. Nothing ships as `verified` until that evidence exists.
 */
export type PayrollPackageCompatibility =
  | { status: "not_applicable" }
  | { status: "unverified"; checkBeforeUse: string }
  | { status: "verified"; evidence: string };

export interface PayrollExportAdapter {
  id: string;
  label: string;
  description: string;
  compatibility: PayrollPackageCompatibility;
  /** Whether the layout carries absence days; otherwise they're listed for manual entry. */
  carriesAbsences: boolean;
  /** Problems that stop the export (missing references), checked before building. */
  problems(snapshot: PayrollRunSnapshot): string[];
  build(snapshot: PayrollRunSnapshot): string;
  fileName(snapshot: PayrollRunSnapshot): string;
}

const employeeRef = (e: PayrollRunEmployee) => e.payrollReference ?? e.staffNumber;
/** Text `toCsv` prefixes with a quote to neutralise spreadsheet formulas. */
const FORMULA_START = /^[=+\-@\t\r]/;
const absenceTotal = (a: PayrollAbsenceDays) => a.annual_leave + a.other_leave + a.sickness;

export const payrollExportAdapters: readonly PayrollExportAdapter[] = [
  {
    id: "teamflow_hr_csv",
    label: "Knotworking hours and absence CSV",
    description:
      "One row per employee: staff number, payroll reference, names, period, shifts, basic/overtime/total hours, and calendar days of annual leave, other leave and sickness. Agency workers are not included.",
    compatibility: { status: "not_applicable" },
    carriesAbsences: true,
    problems: () => [],
    build: (s) =>
      toCsv([
        [
          "Staff number",
          "Payroll reference",
          "First name",
          "Last name",
          "Period start",
          "Period end",
          "Shifts",
          "Basic hours",
          "Overtime hours",
          "Total hours",
          "Annual leave days",
          "Other leave days",
          "Sickness days",
        ],
        ...s.employees.map((e) => [
          e.staffNumber,
          e.payrollReference,
          e.firstName,
          e.lastName,
          s.from,
          s.to,
          e.shifts,
          decimalHours(e.basicMinutes),
          decimalHours(e.overtimeMinutes),
          decimalHours(e.basicMinutes + e.overtimeMinutes),
          e.absenceDays.annual_leave,
          e.absenceDays.other_leave,
          e.absenceDays.sickness,
        ]),
      ]),
    fileName: (s) => `payroll-run-${s.from}-to-${s.to}.csv`,
  },
  {
    id: "sage50_payroll_hours",
    label: "Sage 50 Payroll (hours only)",
    description:
      "Hours against payment references, one row per employee and payment: Employee Reference (the payroll reference, required for every employee), Payment Reference and Hours. Absences are not carried: enter them in Sage from the run's absence list.",
    compatibility: {
      status: "unverified",
      checkBeforeUse:
        "Compare the columns with the import template exported from your Sage 50 Payroll version and do a test import into a backup company before the first real run.",
    },
    carriesAbsences: false,
    problems: (s) => [
      ...(s.employees.some((e) => !e.payrollReference)
        ? [
            "Some employees have no payroll reference. Sage matches employees by its own reference, so add them in People, then prepare a correction.",
          ]
        : []),
      ...(s.employees.some((e) => e.payrollReference && FORMULA_START.test(e.payrollReference))
        ? [
            "A payroll reference starts with =, +, -, @ or a tab. CSV files escape these against spreadsheet formulas, which would stop Sage matching it; change the reference in People.",
          ]
        : []),
      ...(s.references.sageBasicPaymentRef
        ? []
        : [
            "Set the Sage payment reference for basic hours in attendance settings, then prepare a correction.",
          ]),
      ...(s.employees.some((e) => e.overtimeMinutes > 0) && !s.references.sageOvertimePaymentRef
        ? ["There is overtime: set the Sage overtime payment reference, then prepare a correction."]
        : []),
    ],
    build: (s) =>
      toCsv([
        ["Employee Reference", "Payment Reference", "Hours"],
        ...s.employees.flatMap((e) => [
          ...(e.basicMinutes > 0
            ? [[employeeRef(e), s.references.sageBasicPaymentRef, decimalHours(e.basicMinutes)]]
            : []),
          ...(e.overtimeMinutes > 0
            ? [[employeeRef(e), s.references.sageOvertimePaymentRef, decimalHours(e.overtimeMinutes)]]
            : []),
        ]),
      ]),
    fileName: (s) => `sage50-payroll-hours-${s.from}-to-${s.to}.csv`,
  },
];
export const payrollExportAdapterIds = payrollExportAdapters.map((a) => a.id);
export const findPayrollExportAdapter = (id: string) => payrollExportAdapters.find((a) => a.id === id);
/** Employees with absences an adapter can't carry, to enter by hand in the package. */
export const absencesForManualEntry = (s: PayrollRunSnapshot) =>
  s.employees.filter((e) => absenceTotal(e.absenceDays) > 0);

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const PAYROLL_RUN_MAX_DAYS = 93;
const reason = z.string().trim().min(1).max(2000);
const period = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine(
    (v) => v.to >= v.from && inclusiveDays(v.from, v.to) <= PAYROLL_RUN_MAX_DAYS,
    `Choose a pay period of no more than ${PAYROLL_RUN_MAX_DAYS} days`,
  );
export const payrollRunPreviewSchema = period;
export const payrollRunPrepareSchema = z
  .object({
    commandId: z.uuid(),
    from: z.iso.date(),
    to: z.iso.date(),
    note: z.string().trim().max(2000).default(""),
  })
  .strict()
  .refine(
    (v) => v.to >= v.from && inclusiveDays(v.from, v.to) <= PAYROLL_RUN_MAX_DAYS,
    `Choose a pay period of no more than ${PAYROLL_RUN_MAX_DAYS} days`,
  );
export const payrollRunApproveSchema = z
  .object({ commandId: z.uuid(), expectedRevision: z.number().int().positive(), note: reason })
  .strict();
export const payrollRunCorrectSchema = z
  .object({ commandId: z.uuid(), expectedRevision: z.number().int().positive(), reason })
  .strict();
export const payrollRunExportSchema = z
  .object({
    commandId: z.uuid(),
    adapterId: z.string().min(1).max(80),
    /** Required for an adapter whose package compatibility is unverified. */
    acknowledgeUnverified: z.boolean().default(false),
  })
  .strict();
export const payrollRunWithdrawSchema = z
  .object({ commandId: z.uuid(), expectedRevision: z.number().int().positive(), reason })
  .strict();
export const payrollRunListSchema = z.object({
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
