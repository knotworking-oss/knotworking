import { describe, expect, it } from "vitest";
import {
  absencesForManualEntry,
  findPayrollExportAdapter,
  payrollExportAdapters,
  payrollRunPrepareSchema,
  type PayrollRunSnapshot,
} from "./payroll-runs";
import { newId } from "./ids";

const snapshot = (refs: Partial<PayrollRunSnapshot["references"]> = {}): PayrollRunSnapshot => ({
  version: 1,
  from: "2026-03-01",
  to: "2026-03-31",
  references: { sageBasicPaymentRef: null, sageOvertimePaymentRef: null, ...refs },
  employees: [
    {
      staffId: "a",
      staffNumber: "100001",
      payrollReference: "P-1",
      firstName: "Pat",
      lastName: "One",
      shifts: 2,
      basicMinutes: 900,
      overtimeMinutes: 30,
      absenceDays: { annual_leave: 0, other_leave: 0, sickness: 0 },
    },
    {
      staffId: "b",
      staffNumber: "100002",
      payrollReference: "S-2",
      firstName: "Sam",
      lastName: "Two",
      shifts: 0,
      basicMinutes: 0,
      overtimeMinutes: 0,
      absenceDays: { annual_leave: 3, other_leave: 0, sickness: 1 },
    },
  ],
  agencyWorkers: [],
  warnings: [],
  linkedUserIds: [],
});
const lines = (csv: string) => csv.replace(/^﻿/, "").split("\r\n");

describe("payroll export adapters", () => {
  it("declares package compatibility honestly: nothing ships verified", () => {
    expect(payrollExportAdapters.every((a) => a.compatibility.status !== "verified")).toBe(true);
    expect(findPayrollExportAdapter("teamflow_hr_csv")?.compatibility.status).toBe("not_applicable");
    expect(findPayrollExportAdapter("sage50_payroll_hours")?.compatibility.status).toBe("unverified");
  });
  it("builds the Knotworking layout with hours and absence days", () => {
    const csv = findPayrollExportAdapter("teamflow_hr_csv")!.build(snapshot());
    expect(lines(csv)[1]).toBe("100001,P-1,Pat,One,2026-03-01,2026-03-31,2,15,0.5,15.5,0,0,0");
    expect(lines(csv)[2]).toBe("100002,S-2,Sam,Two,2026-03-01,2026-03-31,0,0,0,0,3,0,1");
  });
  it("needs Sage references, writes hours only and lists absences for manual entry", () => {
    const sage = findPayrollExportAdapter("sage50_payroll_hours")!;
    expect(sage.problems(snapshot())).toHaveLength(2);
    const ready = snapshot({ sageBasicPaymentRef: "1", sageOvertimePaymentRef: "4" });
    expect(sage.problems(ready)).toEqual([]);
    expect(lines(sage.build(ready))).toEqual([
      "Employee Reference,Payment Reference,Hours",
      "P-1,1,15",
      "P-1,4,0.5",
      "",
    ]);
    expect(sage.carriesAbsences).toBe(false);
    expect(absencesForManualEntry(ready).map((e) => e.firstName)).toEqual(["Sam"]);
  });
  it("blocks Sage exports for missing or formula-escaped payroll references", () => {
    const sage = findPayrollExportAdapter("sage50_payroll_hours")!;
    const refs = { sageBasicPaymentRef: "1", sageOvertimePaymentRef: "4" };
    const missing = snapshot(refs);
    missing.employees[1]!.payrollReference = null;
    expect(sage.problems(missing).join(" ")).toMatch(/no payroll reference/);
    const formula = snapshot(refs);
    formula.employees[0]!.payrollReference = "-0042";
    expect(sage.problems(formula).join(" ")).toMatch(/starts with/);
  });
  it("bounds a pay period", () => {
    const base = { commandId: newId(), from: "2026-01-01" };
    expect(payrollRunPrepareSchema.safeParse({ ...base, to: "2026-04-03" }).success).toBe(true);
    expect(payrollRunPrepareSchema.safeParse({ ...base, to: "2026-04-04" }).success).toBe(false);
  });
});
