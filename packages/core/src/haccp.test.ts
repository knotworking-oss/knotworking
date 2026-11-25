import { describe, expect, it } from "vitest";
import {
  analysisNotes,
  decisionPathError,
  decisionTreeOutcome,
  hazardRisk,
  overdueByMoreThanInterval,
  processFlow,
  addFrequencyToDate,
  awaitsReview,
  calibrationPasses,
  calibrationRecordCreateSchema,
  ccpInputSchema,
  ccpLogBulkReviewSchema,
  ccpLogCreateSchema,
  ccpLogListQuerySchema,
  ccpLogReviewSchema,
  ccpLogReviewStatuses,
  ccpLogReviewStatusLabels,
  checkDueState,
  countsAsDone,
  initialReviewStatus,
  reviewStatusFor,
  compareDueStates,
  dateDueState,
  describeFrequency,
  describeLimit,
  describeReading,
  evaluateReading,
  haccpAssetScheduleSchema,
  haccpBulkSignoffSchema,
  haccpPlanDraftSchema,
  haccpPlanTemplateCreateSchema,
  haccpPlanTemplateSchema,
  hazardLibraryEntrySchema,
  hazardReviewIntervalOf,
  hazardReviewState,
  defaultHazardReviewDueOn,
  planVersionSchedule,
  scopeCoversBatch,
  versionInForce,
  type PlanVersionTiming,
  type CriticalLimit,
  type DueState,
} from "./haccp";
import { newId } from "./ids";
import { parseActiveModules, resolveModuleAccess } from "./modules";

const range = (limitMin: number | null, limitMax: number | null, limitUnit: string | null = "°C") =>
  ({ limitType: "range", limitMin, limitMax, limitUnit, passCriterion: null }) satisfies CriticalLimit;
const passFail = {
  limitType: "pass_fail",
  limitMin: null,
  limitMax: null,
  limitUnit: null,
  passCriterion: "No metal detected",
} satisfies CriticalLimit;

const ccp = (over: Record<string, unknown> = {}) => ({
  code: "CCP1",
  processStep: "Cooking",
  hazardType: "biological",
  hazard: "Survival of vegetative pathogens",
  limitType: "range",
  limitMin: 75,
  limitUnit: "°C",
  monitoringMethod: "Probe the core of the largest piece",
  frequency: { every: 1, unit: "batch" },
  responsibleRole: "Cook",
  correctiveAction: "Continue cooking until 75 °C is reached",
  verification: "Supervisor reviews the log daily",
  ...over,
});

describe("module", () => {
  it("needs only the asset register: items and production only enhance it", () => {
    expect(() => parseActiveModules("haccp")).toThrow(/assets/);
    expect(parseActiveModules("assets,haccp")).toEqual(["assets", "haccp"]);
    expect(parseActiveModules("assets,items,recipes,stock,demand,production,haccp")).toContain("haccp");
    const active = parseActiveModules("all");
    const grants = { haccp: "write", assets: "read" } as const;
    expect(resolveModuleAccess({ role: "member", active, grants }).haccp).toBe("write");
    expect(
      resolveModuleAccess({ role: "member", active, grants: { ...grants, production: "read" } }).haccp,
    ).toBe("write");
    expect(resolveModuleAccess({ role: "member", active, grants: { haccp: "write" } }).haccp).toBe("none");
    expect(resolveModuleAccess({ role: "member", active, grants: {} }).haccp).toBe("none");
  });
});

describe("evaluateReading", () => {
  it("treats limits as inclusive and says which side was breached", () => {
    expect(evaluateReading(range(75, null), { value: 75 })).toEqual({ withinLimits: true, reason: null });
    expect(evaluateReading(range(75, null), { value: 74.9 })).toEqual({
      withinLimits: false,
      reason: "below_min",
    });
    expect(evaluateReading(range(null, 5), { value: 5 })).toMatchObject({ withinLimits: true });
    expect(evaluateReading(range(null, 5), { value: 5.1 })).toEqual({
      withinLimits: false,
      reason: "above_max",
    });
    expect(evaluateReading(range(0, 5), { value: -0.5 })).toMatchObject({ reason: "below_min" });
  });

  it("isn't fooled by floating point", () => {
    expect(evaluateReading(range(null, 0.3), { value: 0.1 + 0.2 })).toMatchObject({ withinLimits: true });
  });

  it("evaluates pass/fail criteria, and refuses a reading of the wrong kind", () => {
    expect(evaluateReading(passFail, { passed: true })).toMatchObject({ withinLimits: true });
    expect(evaluateReading(passFail, { passed: false })).toEqual({ withinLimits: false, reason: "failed" });
    expect(evaluateReading(passFail, { value: 1 })).toBeNull();
    expect(evaluateReading(range(75, null), { passed: true })).toBeNull();
    expect(evaluateReading(range(75, null), { value: Number.NaN })).toBeNull();
  });

  it("describes limits and readings", () => {
    expect(describeLimit(range(75, null))).toBe("≥ 75 °C");
    expect(describeLimit(range(null, 5))).toBe("≤ 5 °C");
    expect(describeLimit(range(0, 5))).toBe("0–5 °C");
    expect(describeLimit(range(null, 4.2, null))).toBe("≤ 4.2");
    expect(describeLimit(passFail)).toBe("No metal detected");
    expect(describeReading(range(75, null), { value: 72.5, passed: null })).toBe("72.5 °C");
    expect(describeReading(passFail, { value: null, passed: false })).toBe("Fail");
  });
});

describe("when a check is due", () => {
  const now = new Date("2026-11-11T10:00:00Z");

  it("is due when never done", () => {
    expect(
      checkDueState({ frequency: { every: 2, unit: "hour" }, lastAt: null, now, timeZone: "UTC" }),
    ).toEqual({
      state: "due",
      dueOn: null,
      dueAt: null,
    });
  });

  it("runs hourly checks on the clock", () => {
    const at = (lastAt: string) =>
      checkDueState({ frequency: { every: 2, unit: "hour" }, lastAt, now, timeZone: "UTC" });
    expect(at("2026-11-11T09:00:00Z")).toEqual({
      state: "due",
      dueOn: "2026-11-11",
      dueAt: "2026-11-11T11:00:00.000Z",
    });
    expect(at("2026-11-11T07:59:00Z").state).toBe("overdue");
    expect(at("2026-11-11T04:00:00Z").state).toBe("overdue");
    // Due tomorrow: soon, not today.
    const late = checkDueState({
      frequency: { every: 24, unit: "hour" },
      lastAt: "2026-11-11T09:30:00Z",
      now,
      timeZone: "UTC",
    });
    expect(late.state).toBe("soon");
  });

  it("runs daily, weekly and monthly checks on the calendar", () => {
    const at = (every: number, unit: "day" | "week" | "month", lastAt: string) =>
      checkDueState({ frequency: { every, unit }, lastAt, now, timeZone: "UTC" }).state;
    expect(at(1, "day", "2026-11-10T16:00:00Z")).toBe("due");
    expect(at(1, "day", "2026-11-09T08:00:00Z")).toBe("overdue");
    expect(at(1, "day", "2026-11-11T07:00:00Z")).toBe("soon");
    expect(at(1, "week", "2026-11-05T08:00:00Z")).toBe("soon");
    expect(at(1, "month", "2026-10-01T08:00:00Z")).toBe("overdue");
    expect(at(1, "month", "2026-11-01T08:00:00Z")).toBe("ok");
  });

  it("runs the calendar in the workspace's time zone", () => {
    // A daily check at 23:30 UTC on a summer evening was done on the next day in London.
    const summerNow = new Date("2026-07-16T12:00:00Z");
    const daily = (timeZone: string) =>
      checkDueState({
        frequency: { every: 1, unit: "day" },
        lastAt: "2026-07-15T23:30:00Z",
        now: summerNow,
        timeZone,
      });
    expect(daily("Europe/London")).toMatchObject({ state: "soon", dueOn: "2026-07-17" });
    expect(daily("UTC")).toMatchObject({ state: "due", dueOn: "2026-07-16" });
  });

  it("is idle outside production for checks made only during production", () => {
    const base = {
      frequency: { every: 2, unit: "hour" as const },
      lastAt: null,
      now,
      timeZone: "UTC",
      duringProduction: true,
    };
    expect(checkDueState({ ...base, producing: false }).state).toBe("idle");
    expect(checkDueState({ ...base, producing: true }).state).toBe("due");
  });

  it("compares dates and orders states", () => {
    expect(dateDueState("2026-11-10", "2026-11-11")).toBe("overdue");
    expect(dateDueState("2026-11-11", "2026-11-11")).toBe("due");
    expect(dateDueState("2026-11-18", "2026-11-11")).toBe("soon");
    expect(dateDueState("2026-11-19", "2026-11-11")).toBe("ok");
    const states: DueState[] = ["ok", "idle", "due", "overdue", "soon"];
    expect(states.sort(compareDueStates)).toEqual(["overdue", "due", "soon", "ok", "idle"]);
    expect(addFrequencyToDate("2026-01-31", { every: 1, unit: "month" })).toBe("2026-02-28");
    expect(addFrequencyToDate("2026-11-11", { every: 2, unit: "week" })).toBe("2026-11-25");
  });

  it("describes frequencies", () => {
    expect(describeFrequency({ every: 1, unit: "batch" })).toBe("Every batch");
    expect(describeFrequency({ every: 2, unit: "hour" })).toBe("Every 2 hours");
    expect(describeFrequency({ every: 1, unit: "month" })).toBe("Monthly");
  });
});

describe("scope and calibration", () => {
  it("covers a batch by recipe or output item, or everything when empty", () => {
    const batch = { recipeId: "r1", outputItemId: "i1" };
    expect(scopeCoversBatch({ itemIds: [], recipeIds: [] }, batch)).toBe(true);
    expect(scopeCoversBatch({ itemIds: ["i1"], recipeIds: [] }, batch)).toBe(true);
    expect(scopeCoversBatch({ itemIds: [], recipeIds: ["r1"] }, batch)).toBe(true);
    expect(scopeCoversBatch({ itemIds: ["i2"], recipeIds: ["r2"] }, batch)).toBe(false);
  });

  it("passes a calibration within tolerance (inclusive)", () => {
    expect(calibrationPasses({ referenceReading: 100, actualReading: 100.5, tolerance: 0.5 })).toBe(true);
    expect(calibrationPasses({ referenceReading: 0, actualReading: -0.6, tolerance: 0.5 })).toBe(false);
    expect(calibrationPasses({ referenceReading: 0, actualReading: 1, tolerance: null })).toBeNull();
  });
});

describe("which plan version is in force", () => {
  const v = (
    versionNumber: number,
    effectiveOn: string | null,
    status = "superseded",
  ): PlanVersionTiming => ({
    id: `v${versionNumber}`,
    versionNumber,
    status: status as PlanVersionTiming["status"],
    effectiveOn,
    approvedAt: status === "draft" ? null : "2026-01-01T00:00:00Z",
  });

  it("keeps the previous version in force until a future effective date", () => {
    const versions = [v(1, "2026-01-01"), v(2, "2026-12-01", "approved"), v(3, null, "draft")];
    expect(versionInForce(versions, "2025-12-31")).toBeNull();
    expect(versionInForce(versions, "2026-11-30")?.id).toBe("v1");
    expect(versionInForce(versions, "2026-12-01")?.id).toBe("v2");
    const before = planVersionSchedule(versions, "2026-11-12");
    expect(before).toMatchObject({ inForce: { id: "v1" }, inForceUntil: "2026-12-01", next: { id: "v2" } });
    expect(Object.fromEntries(before.states)).toEqual({ v1: "in_force", v2: "scheduled", v3: "draft" });
    const after = planVersionSchedule(versions, "2026-12-02");
    expect(after).toMatchObject({ inForce: { id: "v2" }, inForceUntil: null, next: null });
    expect(after.states.get("v1")).toBe("replaced");
  });

  it("gives a shared effective date to the higher version", () => {
    expect(versionInForce([v(2, "2026-03-01"), v(1, "2026-03-01")], "2026-03-01")?.id).toBe("v2");
  });

  it("ignores versions that were never signed off", () => {
    const unsigned = { ...v(2, "2026-01-01", "approved"), approvedAt: null };
    expect(versionInForce([v(1, "2026-01-01"), unsigned], "2026-06-01")?.id).toBe("v1");
  });

  it("doesn't bring back a scheduled version that a later approval replaced first", () => {
    // v2 was approved for 1 December, then v3 for 20 November: v2 never takes effect.
    const versions = [v(1, "2026-01-01"), v(2, "2026-12-01"), v(3, "2026-11-20", "approved")];
    const now = planVersionSchedule(versions, "2026-11-12");
    expect(now).toMatchObject({ inForce: { id: "v1" }, inForceUntil: "2026-11-20", next: { id: "v3" } });
    expect(now.states.get("v2")).toBe("replaced");
    expect(versionInForce(versions, "2026-12-05")?.id).toBe("v3");
  });

  it("schedules each later version in turn", () => {
    const versions = [v(1, "2026-01-01"), v(2, "2026-12-01"), v(3, "2026-12-15", "approved")];
    const now = planVersionSchedule(versions, "2026-11-12");
    expect(now.inForceUntil).toBe("2026-12-01");
    expect(Object.fromEntries(now.states)).toEqual({ v1: "in_force", v2: "scheduled", v3: "scheduled" });
    expect(planVersionSchedule(versions, "2026-12-05")).toMatchObject({
      inForce: { id: "v2" },
      inForceUntil: "2026-12-15",
    });
  });
});

describe("review of readings", () => {
  it("approves a person's reading on entry and holds a token's for review", () => {
    expect(initialReviewStatus("manual")).toBe("approved");
    expect(initialReviewStatus("api")).toBe("pending");
    expect(reviewStatusFor("approve")).toBe("approved");
    expect(reviewStatusFor("reject")).toBe("rejected");
    expect(ccpLogReviewStatuses.map((s) => ccpLogReviewStatusLabels[s])).toEqual([
      "Awaiting review",
      "Approved",
      "Rejected",
    ]);
  });

  it("counts pending and approved readings as done, not rejected ones", () => {
    expect(countsAsDone({ reviewStatus: "pending" })).toBe(true);
    expect(countsAsDone({ reviewStatus: "approved" })).toBe(true);
    expect(countsAsDone({ reviewStatus: "rejected" })).toBe(false);
  });

  it("only waits for review while pending and not corrected", () => {
    expect(awaitsReview({ reviewStatus: "pending" })).toBe(true);
    expect(awaitsReview({ reviewStatus: "pending", correctedByLogId: null })).toBe(true);
    expect(awaitsReview({ reviewStatus: "pending", correctedByLogId: "x" })).toBe(false);
    expect(awaitsReview({ reviewStatus: "approved" })).toBe(false);
    expect(awaitsReview({ reviewStatus: "rejected" })).toBe(false);
  });
});

describe("validation", () => {
  it("checks critical limits against their type", () => {
    expect(ccpInputSchema.safeParse(ccp()).success).toBe(true);
    expect(ccpInputSchema.safeParse(ccp({ limitMin: null })).success).toBe(false);
    expect(ccpInputSchema.safeParse(ccp({ limitMin: 10, limitMax: 5 })).success).toBe(false);
    expect(
      ccpInputSchema.safeParse(ccp({ limitType: "pass_fail", limitMin: null, passCriterion: "No metal" }))
        .success,
    ).toBe(true);
    expect(ccpInputSchema.safeParse(ccp({ limitType: "pass_fail", passCriterion: "x" })).success).toBe(false);
    expect(ccpInputSchema.safeParse(ccp({ limitType: "pass_fail", limitMin: null })).success).toBe(false);
    expect(ccpInputSchema.safeParse(ccp({ limitMin: 75.00001 })).success).toBe(false);
  });

  it("refuses two CCPs with the same code in a draft", () => {
    const draft = (codes: string[]) =>
      haccpPlanDraftSchema.safeParse({ ccps: codes.map((code) => ccp({ code })) });
    expect(draft(["CCP1", "CCP2"]).success).toBe(true);
    expect(draft(["CCP1", "ccp1"]).success).toBe(false);
    expect(haccpPlanDraftSchema.parse({ ccps: [] }).scope).toEqual({ itemIds: [], recipeIds: [] });
  });

  it("takes exactly one kind of reading", () => {
    const base = { ccpId: "00000000-0000-7000-8000-000000000001" };
    expect(ccpLogCreateSchema.safeParse({ ...base, value: 72 }).success).toBe(true);
    expect(ccpLogCreateSchema.safeParse({ ...base, passed: false }).success).toBe(true);
    expect(ccpLogCreateSchema.safeParse(base).success).toBe(false);
    expect(ccpLogCreateSchema.safeParse({ ...base, value: 1, passed: true }).success).toBe(false);
  });

  it("parses log filters", () => {
    const q = ccpLogListQuerySchema.parse({ outOfLimits: "true" });
    expect(q).toMatchObject({ outOfLimits: true, includeCorrected: true, limit: 50, offset: 0 });
    expect(ccpLogListQuerySchema.safeParse({ ccpCode: "CCP1" }).success).toBe(false);
    expect(ccpLogListQuerySchema.parse({ review: "pending" }).review).toBe("pending");
    expect(ccpLogListQuerySchema.safeParse({ review: "maybe" }).success).toBe(false);
  });

  it("needs a note to reject a reading, alone or in bulk", () => {
    expect(ccpLogReviewSchema.safeParse({ decision: "approve" }).success).toBe(true);
    expect(ccpLogReviewSchema.safeParse({ decision: "reject" }).success).toBe(false);
    expect(ccpLogReviewSchema.safeParse({ decision: "reject", note: "  " }).success).toBe(false);
    expect(ccpLogReviewSchema.parse({ decision: "reject", note: " Probe not in the core " }).note).toBe(
      "Probe not in the core",
    );
    expect(ccpLogReviewSchema.safeParse({ decision: "maybe" }).success).toBe(false);
    const id = "00000000-0000-7000-8000-000000000001";
    expect(ccpLogBulkReviewSchema.safeParse({ ids: [id], decision: "approve" }).success).toBe(true);
    expect(ccpLogBulkReviewSchema.safeParse({ ids: [id], decision: "reject" }).success).toBe(false);
    expect(ccpLogBulkReviewSchema.safeParse({ ids: [], decision: "approve" }).success).toBe(false);
    expect(ccpLogBulkReviewSchema.safeParse({ ids: [id, id], decision: "approve" }).success).toBe(false);
  });

  it("sets a schedule on an asset of the register (the server checks only equipment is calibrated)", () => {
    const calibration = { calibrationFrequency: { every: 1, unit: "month" } };
    expect(haccpAssetScheduleSchema.safeParse(calibration).success).toBe(true);
    expect(haccpAssetScheduleSchema.safeParse({ cleaningFrequency: null }).success).toBe(true);
    // The asset itself is kept in the register, not here.
    expect(haccpAssetScheduleSchema.safeParse({ name: "Probe" }).success).toBe(false);
    expect(
      calibrationRecordCreateSchema.safeParse({
        assetId: "00000000-0000-7000-8000-000000000001",
        referenceReading: 0,
        actualReading: 0.2,
      }).success,
    ).toBe(true);
  });
});

describe("hazard analysis rules", () => {
  const a = (q1: boolean | null, q2: boolean | null, q3: boolean | null, q4: boolean | null) => ({
    q1,
    q2,
    q3,
    q4,
  });
  it("follows the Codex decision tree", () => {
    expect(decisionTreeOutcome(a(null, null, null, null))).toBe("incomplete");
    expect(decisionTreeOutcome(a(false, null, null, null))).toBe("no_control");
    expect(decisionTreeOutcome(a(true, true, null, null))).toBe("ccp");
    expect(decisionTreeOutcome(a(true, false, false, null))).toBe("not_ccp");
    expect(decisionTreeOutcome(a(true, false, true, true))).toBe("not_ccp");
    expect(decisionTreeOutcome(a(true, false, true, false))).toBe("ccp");
    expect(decisionTreeOutcome(a(true, false, true, null))).toBe("incomplete");
  });
  it("finds answers the path doesn't reach", () => {
    expect(decisionPathError(a(true, true, null, null))).toBeNull();
    expect(decisionPathError(a(true, true, true, null))).toBe("q3");
    expect(decisionPathError(a(false, true, null, null))).toBe("q2");
  });
  it("scores risk", () => {
    expect(hazardRisk(1, 4)).toEqual({ score: 4, level: "low" });
    expect(hazardRisk(3, 4)).toEqual({ score: 12, level: "medium" });
    expect(hazardRisk(4, 4).level).toBe("high");
  });
  it("builds the flow and notes the gaps", () => {
    const hazard = {
      hazardType: "biological" as const,
      description: "x",
      likelihood: 5,
      severity: 5,
      controlMeasure: "heat",
    };
    const steps = [
      { id: "s1", name: "Cook", hazards: [{ ...hazard, ...a(true, true, null, null) }] },
      { id: "s2", name: "Pack", hazards: [] },
    ];
    const flow = processFlow(steps, [{ code: "CCP1", stepId: "s2" }]);
    expect(flow.map((n) => [n.number, n.ccpCodes, n.isCcp])).toEqual([
      [1, [], true],
      [2, ["CCP1"], true],
    ]);
    const notes = analysisNotes(steps, [{ code: "CCP1", stepId: "s2" }]).map((n) => n.text);
    expect(notes).toHaveLength(2);
  });
});

describe("overdueByMoreThanInterval", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const base = { now, timeZone: "UTC", state: "overdue" as const };
  it("needs a whole interval past due", () => {
    const hourly = { every: 2, unit: "hour" as const };
    expect(
      overdueByMoreThanInterval({ ...base, frequency: hourly, dueOn: null, dueAt: "2026-11-13T10:30:00Z" }),
    ).toBe(false);
    expect(
      overdueByMoreThanInterval({ ...base, frequency: hourly, dueOn: null, dueAt: "2026-11-13T09:30:00Z" }),
    ).toBe(true);
    const daily = { every: 1, unit: "day" as const };
    expect(overdueByMoreThanInterval({ ...base, frequency: daily, dueOn: "2026-11-12", dueAt: null })).toBe(
      false,
    );
    expect(overdueByMoreThanInterval({ ...base, frequency: daily, dueOn: "2026-11-11", dueAt: null })).toBe(
      true,
    );
    expect(
      overdueByMoreThanInterval({
        ...base,
        state: "due",
        frequency: daily,
        dueOn: "2026-11-01",
        dueAt: null,
      }),
    ).toBe(false);
  });
});

describe("hazard review, library and templates", () => {
  it("uses the hazard review interval, else the plan's, and flags the date", () => {
    const plan = { reviewIntervalMonths: 12, hazardReviewIntervalMonths: null };
    expect(hazardReviewIntervalOf(plan)).toBe(12);
    expect(hazardReviewIntervalOf({ ...plan, hazardReviewIntervalMonths: 6 })).toBe(6);
    expect(defaultHazardReviewDueOn("2026-01-31", { ...plan, hazardReviewIntervalMonths: 6 })).toMatch(
      /^2026-07-/,
    );
    expect(hazardReviewState(null, "2026-11-13")).toBeNull();
    expect(hazardReviewState("2026-11-12", "2026-11-13")).toBe("overdue");
    expect(hazardReviewState("2026-11-13", "2026-11-13")).toBe("due");
    expect(hazardReviewState("2026-12-01", "2026-11-13")).toBe("soon");
    expect(hazardReviewState("2027-06-01", "2026-11-13")).toBe("ok");
  });

  const hazard = {
    hazardType: "biological",
    description: "Pathogens",
    likelihood: 3,
    severity: 3,
    controlMeasure: "Cook",
    q1: true,
    q2: true,
  };
  it("validates a library entry like a hazard of the analysis", () => {
    expect(hazardLibraryEntrySchema.safeParse({ title: "Listeria", ...hazard }).success).toBe(true);
    expect(
      hazardLibraryEntrySchema.safeParse({ title: "Listeria", ...hazard, controlMeasure: null }).success,
    ).toBe(false);
    expect(hazardLibraryEntrySchema.safeParse({ title: "Listeria", ...hazard, q1: false }).success).toBe(
      false,
    );
    expect(hazardLibraryEntrySchema.safeParse({ ...hazard }).success).toBe(false);
  });

  it("validates templates and bulk sign-offs", () => {
    const step = { ref: "a", name: "Cook", hazards: [hazard] };
    expect(haccpPlanTemplateSchema.parse({ name: "T", steps: [step] }).ccps).toEqual([]);
    expect(
      haccpPlanTemplateSchema.safeParse({ name: "T", steps: [step], ccps: [ccp({ stepRef: "nope" })] })
        .success,
    ).toBe(false);
    const fromPlanId = newId();
    expect(haccpPlanTemplateCreateSchema.safeParse({ name: "T", fromPlanId, steps: [step] }).success).toBe(
      false,
    );
    expect(haccpPlanTemplateCreateSchema.safeParse({ name: "T", fromPlanId }).success).toBe(true);
    const id = newId();
    expect(haccpBulkSignoffSchema.safeParse({ planIds: [id], day: "2026-11-13" }).success).toBe(true);
    expect(haccpBulkSignoffSchema.safeParse({ wholeSite: true, day: "2026-11-13" }).success).toBe(true);
    expect(haccpBulkSignoffSchema.safeParse({ day: "2026-11-13" }).success).toBe(false);
    expect(
      haccpBulkSignoffSchema.safeParse({ planIds: [id], wholeSite: true, day: "2026-11-13" }).success,
    ).toBe(false);
    expect(haccpBulkSignoffSchema.safeParse({ planIds: [], day: "2026-11-13" }).success).toBe(false);
  });
});
