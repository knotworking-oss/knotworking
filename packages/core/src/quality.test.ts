import { describe, expect, it } from "vitest";
import {
  auditCompleteSchema,
  auditCreateSchema,
  auditState,
  canCompleteAudit,
  canTransitionComplaint,
  complaintOpensNonconformance,
  isNonconformanceOverdue,
  nonconformanceCreateSchema,
  qualityReference,
  qualityReferenceSequence,
  recallTestCreateSchema,
  recallTestResult,
  recallTestSchedule,
} from "./quality";

describe("complaints", () => {
  it("moves between open and investigating, closes from either, reopens to investigating", () => {
    expect(canTransitionComplaint("open", "investigating")).toBe(true);
    expect(canTransitionComplaint("investigating", "open")).toBe(true);
    expect(canTransitionComplaint("open", "closed")).toBe(true);
    expect(canTransitionComplaint("investigating", "closed")).toBe(true);
    expect(canTransitionComplaint("closed", "investigating")).toBe(true);
    expect(canTransitionComplaint("closed", "open")).toBe(false);
    expect(canTransitionComplaint("open", "open")).toBe(false);
  });

  it("opens a non-conformance for critical complaints and major food-safety ones", () => {
    expect(complaintOpensNonconformance({ severity: "critical", category: "packaging" })).toBe(true);
    expect(complaintOpensNonconformance({ severity: "major", category: "foreign_body" })).toBe(true);
    expect(complaintOpensNonconformance({ severity: "major", category: "allergen" })).toBe(true);
    expect(complaintOpensNonconformance({ severity: "major", category: "quality" })).toBe(false);
    expect(complaintOpensNonconformance({ severity: "minor", category: "illness" })).toBe(false);
  });
});

describe("non-conformances", () => {
  it("is overdue past its due date until closed", () => {
    expect(isNonconformanceOverdue({ status: "open", dueOn: "2026-11-01" }, "2026-11-02")).toBe(true);
    expect(isNonconformanceOverdue({ status: "action_taken", dueOn: "2026-11-01" }, "2026-11-02")).toBe(true);
    expect(isNonconformanceOverdue({ status: "closed", dueOn: "2026-11-01" }, "2026-11-02")).toBe(false);
    expect(isNonconformanceOverdue({ status: "open", dueOn: "2026-11-02" }, "2026-11-02")).toBe(false);
    expect(isNonconformanceOverdue({ status: "open", dueOn: null }, "2026-11-02")).toBe(false);
  });
});

describe("non-conformance schema", () => {
  const base = { raisedOn: "2026-11-12", title: "x", description: "x" };
  const id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  it("has the source complaint or audit exactly when linked to one", () => {
    expect(nonconformanceCreateSchema.safeParse({ ...base, source: "complaint" }).success).toBe(false);
    expect(nonconformanceCreateSchema.safeParse({ ...base, source: "audit" }).success).toBe(false);
    expect(
      nonconformanceCreateSchema.safeParse({ ...base, source: "process", complaintId: id }).success,
    ).toBe(false);
    expect(
      nonconformanceCreateSchema.safeParse({ ...base, source: "complaint", complaintId: id }).success,
    ).toBe(true);
    expect(nonconformanceCreateSchema.safeParse({ ...base, source: "audit", auditId: id }).success).toBe(
      true,
    );
  });
  it("is not due before it was raised", () => {
    expect(
      nonconformanceCreateSchema.safeParse({ ...base, source: "process", dueOn: "2026-11-11" }).success,
    ).toBe(false);
  });
});

describe("audits", () => {
  it("is overdue once its date has passed, soon within 14 days", () => {
    expect(auditState({ status: "planned", plannedOn: "2026-11-01" }, "2026-11-12")).toBe("overdue");
    expect(auditState({ status: "planned", plannedOn: "2026-11-12" }, "2026-11-12")).toBe("soon");
    expect(auditState({ status: "planned", plannedOn: "2026-11-26" }, "2026-11-12")).toBe("soon");
    expect(auditState({ status: "planned", plannedOn: "2026-11-27" }, "2026-11-12")).toBe("planned");
    expect(auditState({ status: "completed", plannedOn: "2026-11-01" }, "2026-11-12")).toBe("completed");
  });

  it("is signed off by the member auditor or whoever has manage", () => {
    const mine = { auditorUserId: "u1" };
    const outside = { auditorUserId: null };
    expect(canCompleteAudit(mine, { userId: "u1", level: "write" })).toBe(true);
    expect(canCompleteAudit(mine, { userId: "u2", level: "write" })).toBe(false);
    expect(canCompleteAudit(mine, { userId: "u2", level: "manage" })).toBe(true);
    expect(canCompleteAudit(outside, { userId: "u2", level: "write" })).toBe(false);
    expect(canCompleteAudit(outside, { userId: "u2", level: "manage" })).toBe(true);
    expect(canCompleteAudit(mine, { userId: "u1", level: undefined })).toBe(true);
  });

  it("takes an auditor member or a name, not both", () => {
    const base = { title: "Hygiene", plannedOn: "2026-12-01" };
    expect(auditCreateSchema.safeParse({ ...base, auditorName: "J. Smith" }).success).toBe(true);
    expect(
      auditCreateSchema.safeParse({
        ...base,
        auditorName: "J. Smith",
        auditorUserId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      }).success,
    ).toBe(false);
  });

  it("completes with findings defaulting to none", () => {
    const parsed = auditCompleteSchema.parse({ completedOn: "2026-11-12", summary: "Good" });
    expect(parsed.findings).toEqual([]);
  });
});

describe("recall tests", () => {
  const start = "2026-11-12T09:00:00Z";
  it("passes when fully reconciled within four hours", () => {
    expect(
      recallTestResult({
        startedAt: start,
        completedAt: "2026-11-12T12:30:00Z",
        quantityExpected: 500,
        quantityTraced: 500,
      }),
    ).toEqual({
      durationMinutes: 210,
      reconciledPercent: 100,
      withinTime: true,
      reconciled: true,
      passed: true,
    });
  });

  it("fails when slow, short or over", () => {
    expect(
      recallTestResult({
        startedAt: start,
        completedAt: "2026-11-12T13:01:00Z",
        quantityExpected: 10,
        quantityTraced: 10,
      }).passed,
    ).toBe(false);
    const short = recallTestResult({
      startedAt: start,
      completedAt: "2026-11-12T10:00:00Z",
      quantityExpected: 480,
      quantityTraced: 470,
    });
    expect(short.reconciledPercent).toBe(97.9);
    expect(short.passed).toBe(false);
    const over = recallTestResult({
      startedAt: start,
      completedAt: "2026-11-12T10:00:00Z",
      quantityExpected: 100,
      quantityTraced: 102,
    });
    expect(over.reconciledPercent).toBe(102);
    expect(over.passed).toBe(false);
    expect(
      recallTestResult({ startedAt: start, completedAt: start, quantityExpected: 0, quantityTraced: 0 })
        .reconciledPercent,
    ).toBeNull();
  });

  it("compares quantities exactly and time to the second", () => {
    const at = (end: string, expected: number, traced: number) =>
      recallTestResult({
        startedAt: start,
        completedAt: end,
        quantityExpected: expected,
        quantityTraced: traced,
      });
    // Rounds to 100.0% but five units are missing, or four too many.
    expect(at("2026-11-12T10:00:00Z", 10000, 9995)).toMatchObject({ reconciledPercent: 100, passed: false });
    expect(at("2026-11-12T10:00:00Z", 10000, 10004)).toMatchObject({ reconciledPercent: 100, passed: false });
    expect(at("2026-11-12T10:00:00Z", 2.5, 2.5).passed).toBe(true);
    // Large quantities still compare exactly, and a millionth short still fails.
    expect(at("2026-11-12T10:00:00Z", 9_000_000_000.5, 9_000_000_000.5).passed).toBe(true);
    expect(at("2026-11-12T10:00:00Z", 100, 99.999999).passed).toBe(false);
    expect(at("2026-11-12T10:00:00Z", 0.1 + 0.2, 0.3).passed).toBe(true);
    // Exactly four hours passes; 29 seconds more doesn't, and counts as a started minute.
    expect(at("2026-11-12T13:00:00Z", 1, 1)).toMatchObject({ durationMinutes: 240, passed: true });
    expect(at("2026-11-12T13:00:29Z", 1, 1)).toMatchObject({ durationMinutes: 241, withinTime: false });
  });

  it("refuses unit mistakes and a date far from the start", () => {
    const base = {
      conductedOn: "2026-11-12",
      lotId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      startedAt: start,
      completedAt: start,
      quantityExpected: 0.001,
      quantityTraced: 100000,
    };
    expect(recallTestCreateSchema.safeParse(base).success).toBe(false);
    expect(
      recallTestCreateSchema.safeParse({ ...base, quantityExpected: 1e12, quantityTraced: 1 }).success,
    ).toBe(false);
    const ok = { ...base, quantityExpected: 10, quantityTraced: 10 };
    expect(recallTestCreateSchema.safeParse(ok).success).toBe(true);
    expect(recallTestCreateSchema.safeParse({ ...ok, conductedOn: "2026-11-13" }).success).toBe(true);
    expect(recallTestCreateSchema.safeParse({ ...ok, conductedOn: "2026-11-15" }).success).toBe(false);
  });

  it("is due a year after the last test", () => {
    expect(recallTestSchedule(null, "2026-11-12")).toEqual({ dueOn: null, state: "never" });
    expect(recallTestSchedule("2025-11-01", "2026-11-12")).toEqual({ dueOn: "2026-11-01", state: "overdue" });
    expect(recallTestSchedule("2025-12-01", "2026-11-12")).toEqual({ dueOn: "2026-12-01", state: "soon" });
    expect(recallTestSchedule("2026-06-01", "2026-11-12")).toEqual({ dueOn: "2027-06-01", state: "ok" });
  });

  it("can't finish before it started", () => {
    const base = {
      conductedOn: "2026-11-12",
      lotId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      quantityExpected: 1,
      quantityTraced: 1,
    };
    expect(
      recallTestCreateSchema.safeParse({ ...base, startedAt: start, completedAt: "2026-11-12T08:00:00Z" })
        .success,
    ).toBe(false);
    expect(recallTestCreateSchema.parse({ ...base, startedAt: start, completedAt: start }).direction).toBe(
      "both",
    );
  });
});

describe("references", () => {
  it("uses the record's year and a padded sequence", () => {
    expect(qualityReference("CMP", "2026-03-04", 7)).toBe("CMP-2026-007");
    expect(qualityReference("NC", "2027-01-01", 1234)).toBe("NC-2027-1234");
    expect(qualityReferenceSequence("CMP-2026-007")).toBe(7);
    expect(qualityReferenceSequence("nonsense")).toBeNull();
  });
});

describe("programme, trends, four-eyes and supplier advice", () => {
  it("plans programme occurrences ahead and skips stale ones", async () => {
    const q = await import("./quality");
    expect(q.programmeOccurrences({ nextPlannedOn: "2026-12-31", intervalMonths: 1 }, "2026-11-13")).toEqual({
      generate: ["2026-12-31"],
      next: "2027-01-31",
    });
    // Two months ahead is inside 60 days: both are planned; month ends hold.
    expect(
      q.programmeOccurrences({ nextPlannedOn: "2026-11-30", intervalMonths: 1 }, "2026-11-13").generate,
    ).toEqual(["2026-11-30", "2026-12-30"]);
    // Years in the past: not a backlog.
    const old = q.programmeOccurrences({ nextPlannedOn: "2020-01-01", intervalMonths: 12 }, "2026-11-13");
    expect(old.generate).toEqual(["2026-01-01", "2027-01-01"]);
    expect(old.next > "2026-11-13").toBe(true);
  });

  it("pins programme audits to a weekday on or after their date, and keeps the anchor", async () => {
    const q = await import("./quality");
    // 2026-11-13 is a Friday (5); Monday (1) is the 16th, a Friday stays.
    expect(q.isoWeekdayOf("2026-11-13")).toBe(5);
    expect(q.onOrAfterWeekday("2026-11-13", 1)).toBe("2026-11-16");
    expect(q.onOrAfterWeekday("2026-11-13", 5)).toBe("2026-11-13");
    expect(q.onOrAfterWeekday("2026-11-13", null)).toBe("2026-11-13");
    const r = q.programmeOccurrences(
      { nextPlannedOn: "2026-11-30", intervalMonths: 1, weekday: 2 },
      "2026-11-13",
    );
    // 30 Nov is a Monday: Tuesday 1 Dec; 30 Dec is a Wednesday: Tuesday 5 Jan, inside the 60 days.
    expect(r.generate).toEqual(["2026-12-01", "2027-01-05"]);
    expect(r.next).toBe("2027-01-30");
    // The same programme later still keys off the unpinned dates, so it doesn't creep.
    const later = q.programmeOccurrences(
      { nextPlannedOn: r.next, intervalMonths: 1, weekday: 2 },
      "2026-12-20",
    );
    expect(later.generate).toEqual(["2027-02-02"]);
  });

  it("computes rates, four-eyes and supplier advice", async () => {
    const q = await import("./quality");
    expect(q.complaintsPerMillion(2, 50_000)).toBe(40);
    expect(q.complaintsPerMillion(2, 0)).toBeNull();
    expect(q.trendMonths("2026-11-13", 3)).toEqual(["2026-09-01", "2026-10-01", "2026-11-01"]);
    expect(q.canVerifyNonconformance({ actionTakenBy: "a", verifierId: "a", managerIds: ["a", "b"] })).toBe(
      false,
    );
    expect(q.canVerifyNonconformance({ actionTakenBy: "a", verifierId: "a", managerIds: ["a"] })).toBe(true);
    expect(q.canVerifyNonconformance({ actionTakenBy: null, verifierId: "a", managerIds: ["a", "b"] })).toBe(
      true,
    );
    const nc = (severity: "minor" | "major" | "critical") => ({
      severity,
      status: "open" as const,
      dueOn: null,
    });
    expect(q.supplierSuspensionAdvice([nc("major")], "approved").suggest).toBe(true);
    expect(q.supplierSuspensionAdvice([nc("minor"), nc("minor")], "approved").suggest).toBe(false);
    expect(q.supplierSuspensionAdvice([nc("major")], "suspended").suggest).toBe(false);
  });
});
