import { describe, expect, it } from "vitest";
import type { AllergenCode } from "./items";
import { parseActiveModules, resolveModuleAccess } from "./modules";
import {
  canSignOffSiteRecord,
  changeoverAllergenRisk,
  pestTrendSeries,
  storageUnitOf,
  workOrderCompleteSchema,
  workOrderCreateSchema,
  workOrderIsOpen,
  workOrderTotalCost,
  type PestTrendFinding,
  checkAwaitsSignOff,
  checkCountsAsDone,
  checkOutcome,
  checkSignOffSchema,
  checklistCheckCreateSchema,
  checklistTemplateCreateSchema,
  defaultNextMaintenanceOn,
  describeStorageLimits,
  evaluateStorageReading,
  glassBreakageCreateSchema,
  glassChecksCreateSchema,
  glassConditionNeedsAction,
  glassItemCreateSchema,
  highestActivity,
  maintenanceDueOn,
  maintenanceDueState,
  maintenanceTaskCreateSchema,
  nextVisitState,
  pestFindingInputSchema,
  pestVisitCreateSchema,
  siteCheckDueState,
  sortSiteDueItems,
  storageReadingCreateSchema,
  storageReadingReviewSchema,
  storageUnitCreateSchema,
  activityNeedsAction,
  type SiteDueItem,
} from "./site";

const id = "0190a1a0-0000-7000-8000-000000000001";
const id2 = "0190a1a0-0000-7000-8000-000000000002";

describe("storage readings", () => {
  const chiller = { limitMin: 0, limitMax: 5 };
  it("flags readings outside the limits, inclusive at the edges", () => {
    expect(evaluateStorageReading(chiller, 5)).toEqual({ withinLimits: true, reason: null });
    expect(evaluateStorageReading(chiller, 0)).toEqual({ withinLimits: true, reason: null });
    expect(evaluateStorageReading(chiller, 5.1)).toEqual({ withinLimits: false, reason: "above_max" });
    expect(evaluateStorageReading(chiller, -0.5)).toEqual({ withinLimits: false, reason: "below_min" });
  });
  it("handles one-sided limits", () => {
    const freezer = { limitMin: null, limitMax: -18 };
    expect(evaluateStorageReading(freezer, -20).withinLimits).toBe(true);
    expect(evaluateStorageReading(freezer, -17.9)).toEqual({ withinLimits: false, reason: "above_max" });
    expect(evaluateStorageReading({ limitMin: 10, limitMax: null }, 9)).toEqual({
      withinLimits: false,
      reason: "below_min",
    });
  });
  it("describes limits", () => {
    expect(describeStorageLimits({ limitMin: null, limitMax: 5 }, "°C")).toBe("≤ 5 °C");
    expect(describeStorageLimits({ limitMin: 8, limitMax: 15 }, "°C")).toBe("8 to 15 °C");
    expect(describeStorageLimits({ limitMin: 2, limitMax: null }, null)).toBe("≥ 2");
  });
  it("needs a limit and a sensible range for a unit", () => {
    const base = { name: "Chiller 1", kind: "chiller" as const };
    expect(storageUnitCreateSchema.safeParse({ ...base }).success).toBe(false);
    expect(storageUnitCreateSchema.safeParse({ ...base, limitMin: 6, limitMax: 5 }).success).toBe(false);
    const ok = storageUnitCreateSchema.parse({ ...base, limitMax: 5 });
    expect(storageUnitOf(ok.measure, ok.unit)).toBe("°C");
    expect(ok.readingFrequency).toEqual({ every: 1, unit: "day" });
  });
  it("takes a reading with at most four decimals", () => {
    expect(storageReadingCreateSchema.safeParse({ unitId: id, value: 4.5 }).success).toBe(true);
    expect(storageReadingCreateSchema.safeParse({ unitId: id, value: 4.12345 }).success).toBe(false);
    expect(storageReadingCreateSchema.safeParse({ unitId: id, value: Number.NaN }).success).toBe(false);
  });
  it("needs a note to reject a reading", () => {
    expect(storageReadingReviewSchema.safeParse({ decision: "approve" }).success).toBe(true);
    expect(storageReadingReviewSchema.safeParse({ decision: "reject" }).success).toBe(false);
    expect(
      storageReadingReviewSchema.safeParse({ decision: "reject", note: "Probe in the door" }).success,
    ).toBe(true);
  });
});

describe("what is due", () => {
  it("treats a daily check done yesterday as due today and a missed one as overdue", () => {
    const now = new Date("2026-03-10T09:00:00Z");
    expect(
      siteCheckDueState({
        frequency: { every: 1, unit: "day" },
        lastAt: "2026-03-09T16:00:00Z",
        now,
        timeZone: "UTC",
      }).state,
    ).toBe("due");
    expect(
      siteCheckDueState({
        frequency: { every: 1, unit: "day" },
        lastAt: "2026-03-08T16:00:00Z",
        now,
        timeZone: "UTC",
      }).state,
    ).toBe("overdue");
    expect(
      siteCheckDueState({ frequency: { every: 1, unit: "day" }, lastAt: null, now, timeZone: "UTC" }).state,
    ).toBe("due");
  });
  it("runs hourly storage readings on the clock", () => {
    const now = new Date("2026-03-10T09:00:00Z");
    const result = siteCheckDueState({
      frequency: { every: 4, unit: "hour" },
      lastAt: "2026-03-10T04:00:00Z",
      now,
      timeZone: "UTC",
    });
    expect(result.state).toBe("overdue");
    expect(result.dueAt).toBe("2026-03-10T08:00:00.000Z");
  });
  it("is idle outside production for checks made only during production", () => {
    const now = new Date("2026-03-10T09:00:00Z");
    const input = {
      frequency: { every: 1, unit: "day" as const },
      lastAt: null,
      now,
      timeZone: "UTC",
      duringProduction: true,
    };
    expect(siteCheckDueState({ ...input, producing: false }).state).toBe("idle");
    expect(siteCheckDueState({ ...input, producing: true }).state).toBe("due");
  });
  it("works out maintenance due dates from the last record, the start date or nothing", () => {
    const frequency = { every: 3, unit: "month" as const };
    expect(
      maintenanceDueOn({
        lastNextDueOn: "2026-06-01",
        lastCompletedOn: "2026-03-01",
        frequency,
        startOn: null,
      }),
    ).toBe("2026-06-01");
    expect(
      maintenanceDueOn({ lastNextDueOn: null, lastCompletedOn: "2026-03-01", frequency, startOn: null }),
    ).toBe("2026-06-01");
    expect(
      maintenanceDueOn({ lastNextDueOn: null, lastCompletedOn: null, frequency, startOn: "2026-04-01" }),
    ).toBe("2026-04-01");
    expect(
      maintenanceDueOn({ lastNextDueOn: null, lastCompletedOn: null, frequency, startOn: null }),
    ).toBeNull();
    expect(defaultNextMaintenanceOn("2026-01-31", frequency)).toBe("2026-04-30");
  });
  it("states maintenance as overdue, due, soon or ok, and due now when never scheduled", () => {
    const today = "2026-03-10";
    expect(maintenanceDueState({ dueOn: "2026-03-09", hasRecord: true, today }).state).toBe("overdue");
    expect(maintenanceDueState({ dueOn: "2026-03-10", hasRecord: true, today }).state).toBe("due");
    expect(maintenanceDueState({ dueOn: "2026-03-14", hasRecord: true, today }).state).toBe("soon");
    expect(maintenanceDueState({ dueOn: "2026-05-01", hasRecord: true, today }).state).toBe("ok");
    expect(maintenanceDueState({ dueOn: null, hasRecord: false, today })).toEqual({
      state: "due",
      dueOn: null,
    });
    expect(nextVisitState("2026-03-01", today)).toBe("overdue");
  });
  it("orders due items most urgent first", () => {
    const item = (title: string, state: SiteDueItem["state"], dueOn: string | null) => ({
      title,
      state,
      dueOn,
    });
    const sorted = sortSiteDueItems([
      item("c", "soon", "2026-03-12"),
      item("b", "overdue", "2026-03-09"),
      item("a", "overdue", "2026-03-01"),
      item("d", "due", null),
    ]);
    expect(sorted.map((i) => i.title)).toEqual(["a", "b", "d", "c"]);
  });
});

describe("pest control", () => {
  it("rates the highest activity and which calls for action", () => {
    expect(highestActivity([])).toBe("none");
    expect(highestActivity([{ activity: "low" }, { activity: "high" }, { activity: "none" }])).toBe("high");
    expect(activityNeedsAction("low")).toBe(false);
    expect(activityNeedsAction("moderate")).toBe(true);
  });
  it("needs a device or a place, and what was found when there is activity", () => {
    expect(pestFindingInputSchema.safeParse({ activity: "none" }).success).toBe(false);
    expect(pestFindingInputSchema.safeParse({ deviceId: id, activity: "none" }).success).toBe(true);
    expect(pestFindingInputSchema.safeParse({ deviceId: id, activity: "low" }).success).toBe(false);
    expect(
      pestFindingInputSchema.safeParse({ location: "Dock door", activity: "low", pest: "mice" }).success,
    ).toBe(true);
  });
  it("refuses a next visit before the visit and a device twice", () => {
    const base = { contractor: "Rentokil", visitedOn: "2026-03-10" };
    expect(pestVisitCreateSchema.safeParse({ ...base, nextVisitOn: "2026-03-09" }).success).toBe(false);
    expect(pestVisitCreateSchema.safeParse({ ...base, nextVisitOn: "2026-04-10" }).success).toBe(true);
    const finding = { deviceId: id, activity: "none" as const };
    expect(pestVisitCreateSchema.safeParse({ ...base, findings: [finding, finding] }).success).toBe(false);
    expect(pestVisitCreateSchema.parse(base).findings).toEqual([]);
  });
});

describe("glass and brittle plastics", () => {
  it("defaults a monthly check and needs the area", () => {
    const item = glassItemCreateSchema.parse({ areaId: id, kind: "glass", description: "Window" });
    expect(item.checkFrequency).toEqual({ every: 1, unit: "month" });
    expect(item.quantity).toBe(1);
    expect(glassItemCreateSchema.safeParse({ kind: "glass", description: "Window" }).success).toBe(false);
  });
  it("needs a note for damaged or missing items", () => {
    expect(glassConditionNeedsAction("intact")).toBe(false);
    expect(glassConditionNeedsAction("damaged")).toBe(true);
    expect(glassChecksCreateSchema.safeParse({ checks: [{ itemId: id, condition: "intact" }] }).success).toBe(
      true,
    );
    expect(
      glassChecksCreateSchema.safeParse({ checks: [{ itemId: id, condition: "damaged" }] }).success,
    ).toBe(false);
    expect(
      glassChecksCreateSchema.safeParse({
        checks: [
          { itemId: id, condition: "intact" },
          { itemId: id, condition: "intact" },
        ],
      }).success,
    ).toBe(false);
  });
  it("takes a breakage with what was quarantined", () => {
    const base = { areaId: id, description: "Diffuser cracked" };
    expect(glassBreakageCreateSchema.safeParse(base).success).toBe(false);
    expect(
      glassBreakageCreateSchema.safeParse({ ...base, quarantined: "Pallet 4, line 2 product" }).success,
    ).toBe(true);
  });
});

describe("maintenance", () => {
  it("defaults to no hygiene clearance", () => {
    const task = maintenanceTaskCreateSchema.parse({
      assetId: id,
      title: "Grease bearings",
      frequency: { every: 1, unit: "month" },
    });
    expect(task.clearanceRequired).toBe(false);
    expect(
      maintenanceTaskCreateSchema.safeParse({ assetId: id, title: "x", frequency: { every: 0, unit: "day" } })
        .success,
    ).toBe(false);
  });
});

describe("checklists", () => {
  it("fails a check when any item failed", () => {
    expect(checkOutcome([{ result: "pass" }, { result: "na" }])).toBe("passed");
    expect(checkOutcome([{ result: "pass" }, { result: "fail" }])).toBe("failed");
    expect(checkOutcome([])).toBe("passed");
  });
  it("counts passed, signed or pending checks as done, but not held or failed ones", () => {
    expect(checkCountsAsDone({ signOffStatus: "pending", outcome: "passed" })).toBe(true);
    expect(checkCountsAsDone({ signOffStatus: "approved", outcome: "passed" })).toBe(true);
    expect(checkCountsAsDone({ signOffStatus: "rejected", outcome: "passed" })).toBe(false);
    expect(checkCountsAsDone({ signOffStatus: "pending", outcome: "failed" })).toBe(false);
  });
  it("lists checks awaiting sign-off unless corrected", () => {
    expect(checkAwaitsSignOff({ signOffStatus: "pending" })).toBe(true);
    expect(checkAwaitsSignOff({ signOffStatus: "pending", correctedByCheckId: id })).toBe(false);
    expect(checkAwaitsSignOff({ signOffStatus: "approved" })).toBe(false);
  });
  it("needs one result per item, a note for a failure, and a note to hold production", () => {
    const template = checklistTemplateCreateSchema.safeParse({
      name: "Line 2 pre-start",
      kind: "prestart",
      items: [{ prompt: "Metal detector tested" }, { prompt: "metal detector tested" }],
    });
    expect(template.success).toBe(false);
    expect(checklistTemplateCreateSchema.safeParse({ name: "x", kind: "prestart", items: [] }).success).toBe(
      false,
    );
    expect(
      checklistCheckCreateSchema.safeParse({ templateId: id, results: [{ itemId: id, result: "fail" }] })
        .success,
    ).toBe(false);
    expect(
      checklistCheckCreateSchema.safeParse({
        templateId: id,
        results: [{ itemId: id, result: "fail", note: "Replaced the probe" }],
      }).success,
    ).toBe(true);
    expect(
      checklistCheckCreateSchema.safeParse({
        templateId: id,
        results: [
          { itemId: id, result: "pass" },
          { itemId: id, result: "pass" },
        ],
      }).success,
    ).toBe(false);
    expect(
      checklistCheckCreateSchema.safeParse({
        templateId: id,
        previousBatchId: id,
        nextBatchId: id2,
        results: [{ itemId: id, result: "pass" }],
      }).success,
    ).toBe(true);
    expect(checkSignOffSchema.safeParse({ decision: "approve" }).success).toBe(true);
    expect(checkSignOffSchema.safeParse({ decision: "reject" }).success).toBe(false);
  });
});

describe("the site module's place in the manifest", () => {
  it("needs haccp, and so items and production", () => {
    expect(() => parseActiveModules("site")).toThrow(/haccp/);
    expect(parseActiveModules("items,recipes,stock,demand,production,haccp,site")).toContain("site");
  });
  it("is none unless the member can read haccp", () => {
    const active = parseActiveModules(null);
    const access = resolveModuleAccess({
      role: "member",
      active,
      grants: {
        site: "write",
        items: "read",
        recipes: "read",
        stock: "read",
        demand: "read",
        production: "read",
      },
    });
    expect(access.site).toBe("none");
    const withHaccp = resolveModuleAccess({
      role: "member",
      active,
      grants: {
        site: "write",
        haccp: "read",
        items: "read",
        recipes: "read",
        stock: "read",
        demand: "read",
        production: "read",
      },
    });
    expect(withHaccp.site).toBe("write");
  });
});

describe("storage measures", () => {
  const base = { name: "Dry store", kind: "ambient" as const };
  it("defaults to temperature and its unit, and takes the measure's own unit as the default", () => {
    const parsed = storageUnitCreateSchema.parse({ ...base, limitMax: 25 });
    expect(parsed.measure).toBe("temperature");
    expect(parsed.unit).toBeUndefined();
    expect(storageUnitOf("temperature", parsed.unit)).toBe("°C");
    expect(storageUnitOf("humidity", undefined)).toBe("%RH");
    expect(storageUnitOf("humidity", " % ")).toBe("%");
  });
  it("keeps relative humidity between 0 and 100 and makes 'other' name its unit", () => {
    expect(
      storageUnitCreateSchema.safeParse({ ...base, measure: "humidity", limitMin: 40, limitMax: 65 }).success,
    ).toBe(true);
    expect(storageUnitCreateSchema.safeParse({ ...base, measure: "humidity", limitMax: 120 }).success).toBe(
      false,
    );
    expect(storageUnitCreateSchema.safeParse({ ...base, measure: "other", limitMax: 5 }).success).toBe(false);
    expect(
      storageUnitCreateSchema.safeParse({ ...base, measure: "other", unit: "ppm", limitMax: 5 }).success,
    ).toBe(true);
  });
  it("judges a humidity reading against its limits like any other value", () => {
    expect(evaluateStorageReading({ limitMin: 40, limitMax: 65 }, 70)).toEqual({
      withinLimits: false,
      reason: "above_max",
    });
    expect(describeStorageLimits({ limitMin: 40, limitMax: 65 }, "%RH")).toBe("40 to 65 %RH");
  });
});

describe("four-eyes on a site release", () => {
  it("refuses whoever recorded it unless they are the only manager", () => {
    const managerIds = ["a", "b"];
    expect(canSignOffSiteRecord({ recordedBy: ["a", null], deciderId: "b", managerIds })).toBe(true);
    expect(canSignOffSiteRecord({ recordedBy: ["a", "c"], deciderId: "a", managerIds })).toBe(false);
    expect(canSignOffSiteRecord({ recordedBy: ["a"], deciderId: "a", managerIds: ["a"] })).toBe(true);
    expect(canSignOffSiteRecord({ recordedBy: [null, undefined], deciderId: "a", managerIds })).toBe(true);
  });
});

describe("changeover allergen risk", () => {
  const rollup = (contains: AllergenCode[], mayContain: AllergenCode[] = []) => ({ contains, mayContain });
  it("warns about what the batch before contains and the batch after doesn't", () => {
    const risk = changeoverAllergenRisk({
      previous: rollup(["milk", "eggs"]),
      next: rollup(["milk"], ["nuts"]),
      previousNamed: true,
      nextNamed: true,
    });
    expect(risk.status).toBe("review");
    expect(risk.carriedOver).toEqual(["eggs"]);
    expect(risk.notDeclaredAfter).toEqual(["eggs"]);
    expect(risk.warnings).toHaveLength(2);
  });
  it("is quiet when nothing new is left on the line, and an undeclared one is only a 'may contain' gap", () => {
    expect(
      changeoverAllergenRisk({
        previous: rollup(["milk"]),
        next: rollup(["milk", "eggs"]),
        previousNamed: true,
        nextNamed: true,
      }),
    ).toMatchObject({ status: "none", carriedOver: [], warnings: [] });
    const covered = changeoverAllergenRisk({
      previous: rollup(["sesame"]),
      next: rollup([], ["sesame"]),
      previousNamed: true,
      nextNamed: true,
    });
    expect(covered.status).toBe("review");
    expect(covered.notDeclaredAfter).toEqual([]);
    expect(covered.warnings).toHaveLength(1);
  });
  it("is unknown when a batch is not named or has no allergen data", () => {
    expect(
      changeoverAllergenRisk({ previous: null, next: null, previousNamed: false, nextNamed: false }).status,
    ).toBe("unknown");
    expect(
      changeoverAllergenRisk({ previous: null, next: rollup([]), previousNamed: true, nextNamed: true })
        .status,
    ).toBe("unknown");
  });
});

describe("pest trends", () => {
  const f = (over: Partial<PestTrendFinding>): PestTrendFinding => ({
    visitedOn: "2026-01-10",
    deviceId: "d1",
    deviceCode: "RB-01",
    deviceLocation: "Goods in",
    location: null,
    areaId: "a1",
    areaName: "Goods in",
    pest: null,
    activity: "none",
    count: null,
    ...over,
  });
  it("counts sightings per device over time, with a zero for a clear check", () => {
    const series = pestTrendSeries(
      [
        f({ visitedOn: "2026-02-10", activity: "low", pest: "mice", count: 2 }),
        f({ visitedOn: "2026-01-10" }),
        f({ visitedOn: "2026-02-10", deviceId: "d2", deviceCode: "RB-02", activity: "none" }),
        f({ visitedOn: "2026-03-10", activity: "moderate", pest: "mice" }),
      ],
      "device",
    );
    expect(series.map((s) => s.label)).toEqual(["RB-01", "RB-02"]);
    const first = series[0]!;
    expect(first.points.map((p) => [p.on, p.sightings])).toEqual([
      ["2026-01-10", 0],
      ["2026-02-10", 2],
      ["2026-03-10", 1],
    ]);
    expect(first.sightings).toBe(3);
    expect(first.highest).toBe("moderate");
    expect(first.direction).toBe("down");
    expect(series[1]!.direction).toBeNull();
  });
  it("groups by area, with devices of no area together, and by pest", () => {
    const findings = [
      f({ activity: "low", pest: "Mice", count: 1 }),
      f({
        deviceId: "d2",
        deviceCode: "EFK-1",
        areaId: null,
        areaName: null,
        activity: "low",
        pest: "flies",
        count: 4,
      }),
      f({
        deviceId: null,
        deviceCode: null,
        location: "Yard",
        areaId: null,
        areaName: null,
        activity: "low",
        pest: "mice",
      }),
    ];
    expect(pestTrendSeries(findings, "area").map((s) => [s.label, s.sightings])).toEqual([
      ["No area", 5],
      ["Goods in", 1],
    ]);
    expect(pestTrendSeries(findings, "pest").map((s) => [s.label, s.sightings])).toEqual([
      ["flies", 4],
      ["Mice", 2],
    ]);
    expect(pestTrendSeries(findings, "device").map((s) => s.label)).toEqual(["EFK-1", "RB-01", "Yard"]);
  });
});

describe("work orders", () => {
  it("defaults to a medium-priority breakdown and costs to the penny", () => {
    const wo = workOrderCreateSchema.parse({ assetId: id, title: "Mixer seized" });
    expect(wo).toMatchObject({ kind: "breakdown", priority: "medium", stopsProduction: false });
    expect(
      workOrderCompleteSchema.safeParse({ workDone: "Replaced bearing", partsCost: 12.345 }).success,
    ).toBe(false);
    expect(
      workOrderCompleteSchema.safeParse({ workDone: "Replaced bearing", partsCost: 12.34, labourCost: 0 })
        .success,
    ).toBe(true);
    expect(workOrderCompleteSchema.safeParse({ partsCost: 1 }).success).toBe(false);
  });
  it("totals the costs that were entered", () => {
    expect(workOrderTotalCost({ partsCost: null, labourCost: null, contractorCost: null })).toBeNull();
    expect(workOrderTotalCost({ partsCost: 10.1, labourCost: 20.2, contractorCost: null })).toBe(30.3);
    expect(workOrderIsOpen("in_progress")).toBe(true);
    expect(workOrderIsOpen("completed")).toBe(false);
  });
});
