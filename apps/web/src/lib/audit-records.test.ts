import { describe, expect, it } from "vitest";
import type {
  CalibrationRecord,
  CleaningRecord,
  ChecklistCheck,
  CorrectiveAction,
  GlassBreakage,
  GlassCheck,
  HaccpLog,
  MaintenanceRecord,
  RecallTestRow,
} from "@/lib/api";
import {
  auditInRange,
  calibrationEntries,
  cleaningEntries,
  ccpLogEntries,
  checklistCheckEntries,
  glassBreakageEntries,
  glassCheckEntries,
  maintenanceEntries,
  planCorrectiveActions,
  recallTestEntries,
} from "./audit-records";

const log = (over: Record<string, unknown>) =>
  ({
    id: "l1",
    checkedAt: "2026-11-05T09:00:00.000Z",
    ccp: { code: "CCP1", processStep: "Cook", limitText: "at least 75 °C" },
    readingText: "78 °C",
    withinLimits: true,
    deviationReason: null,
    batch: { batchCode: "B-1" },
    source: "manual",
    recordedByName: "Ada",
    reviewStatus: "approved",
    reviewedByName: "Grace",
    reviewedAt: "2026-11-05T10:00:00.000Z",
    reviewNote: null,
    note: null,
    correctsLogId: null,
    correctionReason: null,
    correctedByLogId: null,
    correctiveActions: [],
    ...over,
  }) as unknown as HaccpLog;

describe("ccpLogEntries", () => {
  it("says who checked, the outcome and who approved it", () => {
    const [e] = ccpLogEntries([log({})]);
    expect(e).toMatchObject({
      title: "CCP1 Cook",
      result: "78 °C, within limits",
      problem: false,
      doneBy: "Checked by Ada",
      replaced: false,
      corrects: null,
    });
    expect(e!.signOff).toBe("Approved by Grace, 05/11/2026 10:00 UTC");
    expect(e!.lines).toContain("Batch B-1");
  });

  it("links a correction to the reading it replaced, which is marked replaced", () => {
    const wrong = log({ id: "l1", readingText: "58 °C", withinLimits: false, correctedByLogId: "l2" });
    const right = log({ id: "l2", correctsLogId: "l1", correctionReason: "Probe misread" });
    const [a, b] = ccpLogEntries([wrong, right]);
    expect(a).toMatchObject({ replaced: true, problem: true });
    expect(a!.result).toContain("OUT OF LIMITS");
    expect(b!.corrects).toEqual({
      summary: "05/11/2026 09:00 UTC: CCP1 58 °C",
      reason: "Probe misread",
    });
  });

  it("copes with a correction whose original is outside the range", () => {
    const [e] = ccpLogEntries([log({ correctsLogId: "gone" })]);
    expect(e!.corrects?.summary).toMatch(/before the start of this range/);
  });

  it("shows a pending reading as awaiting review and a rejected one with its reason", () => {
    expect(
      ccpLogEntries([log({ reviewStatus: "pending", reviewedByName: null, reviewedAt: null })])[0]!.signOff,
    ).toBe("Awaiting review");
    expect(
      ccpLogEntries([log({ reviewStatus: "rejected", reviewNote: "Wrong probe" })])[0]!.signOff,
    ).toContain("Rejected by Grace");
  });
});

describe("planCorrectiveActions", () => {
  const action = (id: string, planId: string, createdAt: string, checkedAt = "2026-01-01T00:00:00Z") =>
    ({
      id,
      createdAt,
      closedAt: null,
      log: { plan: { id: planId }, checkedAt },
    }) as unknown as CorrectiveAction;
  const range = { from: "2026-11-01", to: "2026-11-30" };

  it("keeps the plan's actions raised in the range, or answering a check in it, oldest first", () => {
    const picked = planCorrectiveActions(
      [
        action("late", "p1", "2026-11-20T00:00:00Z"),
        action("other-plan", "p2", "2026-11-10T00:00:00Z"),
        action("old", "p1", "2026-05-10T00:00:00Z"),
        action("early", "p1", "2026-11-02T00:00:00Z"),
        action("answers-a-check", "p1", "2026-12-05T00:00:00Z", "2026-11-29T00:00:00Z"),
      ],
      "p1",
      range,
    );
    expect(picked.map((a) => a.id)).toEqual(["early", "late", "answers-a-check"]);
  });
});

describe("maintenanceEntries", () => {
  const record = (over: Record<string, unknown>) =>
    ({
      id: "m1",
      completedAt: "2026-11-05T09:00:00.000Z",
      task: { title: "Replace belt" },
      asset: { name: "Slicer" },
      area: { name: "Production" },
      workDone: "Belt replaced",
      contractor: null,
      nextDueOn: "2027-05-05",
      doneByName: "Ben",
      recordedByName: "Ada",
      clearanceRequired: true,
      clearedAt: null,
      clearedByName: null,
      clearanceNote: null,
      correctedByRecordId: null,
      correctsRecordId: null,
      awaitingClearance: true,
      note: null,
      ...over,
    }) as unknown as MaintenanceRecord;

  it("shows work still awaiting clearance in bold and who cleared it once given", () => {
    const [waiting] = maintenanceEntries([record({})]);
    expect(waiting).toMatchObject({ problem: true, result: "Done, AWAITING CLEARANCE" });
    const [cleared] = maintenanceEntries([
      record({
        awaitingClearance: false,
        clearedAt: "2026-11-05T11:00:00.000Z",
        clearedByName: "Grace",
        clearanceNote: "Swabs clear",
      }),
    ]);
    expect(cleared!.signOff).toBe("Cleared to restart by Grace, 05/11/2026 11:00 UTC: Swabs clear");
    expect(cleared!.doneBy).toBe("Done by Ben");
  });
});

describe("recallTestEntries / auditInRange", () => {
  it("keeps a voided recall test on the page with who voided it", () => {
    const test = {
      id: "r1",
      reference: "RT-0001",
      conductedOn: "2026-11-03",
      direction: "forward",
      lot: { lotCode: "L9", item: { name: "Tomato sauce" } },
      scenario: null,
      startedAt: "2026-11-03T09:00:00.000Z",
      completedAt: "2026-11-03T09:45:00.000Z",
      durationMinutes: 45,
      quantityTraced: 99,
      quantityExpected: 100,
      unit: "kg",
      reconciledPercent: 99,
      passed: true,
      notes: null,
      recordedByName: "Ada",
      voidedAt: "2026-11-04T08:00:00.000Z",
      voidedByName: "Grace",
      voidReason: "Wrong lot",
    } as unknown as RecallTestRow;
    const [e] = recallTestEntries([test]);
    expect(e).toMatchObject({ replaced: true, result: "Passed" });
    expect(e!.replacedNote).toBe("Voided by Grace, 04/11/2026 08:00 UTC: Wrong lot. It no longer counts.");
  });

  it("dates a completed audit by when it was done, a planned one by when it is planned", () => {
    const range = { from: "2026-11-01", to: "2026-11-30" };
    expect(
      auditInRange({ status: "completed", plannedOn: "2026-10-20", completedOn: "2026-11-02" }, range),
    ).toBe(true);
    expect(auditInRange({ status: "planned", plannedOn: "2026-10-20", completedOn: null }, range)).toBe(
      false,
    );
  });
});

describe("cleaningEntries and calibrationEntries", () => {
  it("shows who cleaned and who verified, or that it is not verified", () => {
    const base = {
      id: "c1",
      cleanedAt: "2026-11-05T09:00:00.000Z",
      asset: { name: "Mixer 2", code: "EQ-2" },
      doneByName: "Ben",
      recordedByName: "Ada",
      note: null,
      verifiedAt: null,
      verifiedByName: null,
      verificationNote: null,
    };
    const [open] = cleaningEntries([base as unknown as CleaningRecord]);
    expect(open).toMatchObject({
      title: "Cleaning · Mixer 2 (EQ-2)",
      doneBy: "Done by Ben",
      signOff: "Not yet verified",
    });
    const [done] = cleaningEntries([
      {
        ...base,
        verifiedAt: "2026-11-05T11:00:00.000Z",
        verifiedByName: "Grace",
      } as unknown as CleaningRecord,
    ]);
    expect(done!.signOff).toBe("Verified by Grace, 05/11/2026 11:00 UTC");
  });

  it("marks a failed calibration as a problem and lists its corrective action", () => {
    const [e] = calibrationEntries([
      {
        id: "k1",
        calibratedAt: "2026-11-05T09:00:00.000Z",
        asset: { name: "Probe 1", code: null },
        referenceReading: 0,
        actualReading: 1.8,
        tolerance: 0.5,
        unit: "°C",
        passed: false,
        method: "Ice bath",
        nextDueOn: null,
        recordedByName: "Ada",
        note: null,
        correctiveActions: [{ id: "a1", title: "Probe 1 failed calibration", status: "open" }],
      } as unknown as CalibrationRecord,
    ]);
    expect(e).toMatchObject({ title: "Calibration · Probe 1", result: "FAILED", problem: true });
    expect(e!.lines[0]).toBe("Reference 0 °C, reading 1.8 °C, tolerance ±0.5 °C");
    expect(e!.followUps).toEqual(["Corrective action (Open)"]);
  });
});

describe("glassCheckEntries and glassBreakageEntries", () => {
  const check = (over: Record<string, unknown>) =>
    ({
      id: "g1",
      checkedAt: "2026-11-05T09:00:00.000Z",
      condition: "intact",
      note: null,
      area: { name: "Packing hall" },
      item: { kind: "glass", description: "East window", location: "East wall" },
      recordedByName: "Ada",
      correctsCheckId: null,
      correctionReason: null,
      correctedByCheckId: null,
      ...over,
    }) as unknown as GlassCheck;

  it("prints each check with its condition, flagging damaged or missing items in bold", () => {
    const [ok, bad] = glassCheckEntries([
      check({}),
      check({ id: "g2", condition: "damaged", note: "Cracked corner" }),
    ]);
    expect(ok).toMatchObject({ result: "Intact", problem: false, doneBy: "Checked by Ada" });
    expect(bad).toMatchObject({ result: "DAMAGED", problem: true, note: "Cracked corner" });
    expect(ok!.title).toBe("East window · Packing hall");
  });

  it("quotes what a correction replaced", () => {
    const entries = glassCheckEntries([
      check({ correctedByCheckId: "g2" }),
      check({
        id: "g2",
        correctsCheckId: "g1",
        correctionReason: "Wrong item",
        condition: "missing",
        note: "Gone",
      }),
    ]);
    expect(entries[0]!.replaced).toBe(true);
    expect(entries[1]!.corrects).toMatchObject({ reason: "Wrong item" });
  });

  const breakage = (over: Record<string, unknown>) =>
    ({
      id: "b1",
      occurredAt: "2026-11-05T09:00:00.000Z",
      area: { name: "Packing hall" },
      item: null,
      description: "Diffuser cracked",
      quarantined: "Line 1 product",
      cleanDown: "Stripped and swabbed",
      cleanDownByName: "Ben",
      cleanDownAt: "2026-11-05T09:30:00.000Z",
      status: "released",
      source: "manual",
      raisedByName: "Ada",
      releasedByName: "Grace",
      releasedAt: "2026-11-05T10:00:00.000Z",
      releaseNote: "Visual check clear",
      ...over,
    }) as unknown as GlassBreakage;

  it("prints a breakage with the clean-down and who released the area, or says it is still held", () => {
    const [released] = glassBreakageEntries([breakage({})]);
    expect(released).toMatchObject({ result: "Released", problem: false, doneBy: "Reported by Ada" });
    expect(released!.signOff).toBe("Released by Grace, 05/11/2026 10:00 UTC: Visual check clear");
    expect(released!.lines).toContain("Quarantined: Line 1 product");
    const [held] = glassBreakageEntries([
      breakage({ status: "open", cleanDown: null, releasedByName: null, releasedAt: null }),
    ]);
    expect(held).toMatchObject({ result: "AREA HELD", problem: true });
    expect(held!.signOff).toBe("Area still held: not yet released");
    expect(held!.lines).toContain("Clean-down: not yet recorded");
  });
});

describe("checklistCheckEntries allergen risk", () => {
  it("prints the allergen warnings of a changeover", () => {
    const base = {
      id: "c1",
      performedAt: "2026-11-05T09:00:00.000Z",
      templateName: "Changeover",
      kind: "allergen_changeover",
      outcome: "passed",
      results: [],
      failedCount: 0,
      signOffStatus: "pending",
      previousBatch: { batchCode: "B1" },
      nextBatch: { batchCode: "B2" },
      correctedByCheckId: null,
    };
    const [risky] = checklistCheckEntries([
      { ...base, allergenRisk: { status: "review", warnings: ["Contains milk."] } },
    ] as unknown as ChecklistCheck[]);
    expect(risky!.lines).toContain("Allergen risk: Contains milk.");
    const [none] = checklistCheckEntries([
      { ...base, allergenRisk: { status: "none", warnings: [] } },
    ] as unknown as ChecklistCheck[]);
    expect(none!.lines.some((l) => l.startsWith("Allergen risk"))).toBe(false);
  });
});
