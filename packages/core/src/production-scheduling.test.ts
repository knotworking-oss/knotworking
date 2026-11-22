import { describe, expect, it } from "vitest";
import {
  allergenCarryover,
  changeoverMinutes,
  lineCapacityHours,
  lineChangeoversSetSchema,
  lineShiftMinutes,
  minutesToClock,
  planLineDay,
  projectDailyDemand,
  proposeLineDaySequence,
  shiftWindows,
  type DayPlanBatch,
  type DayPlanLine,
} from "./production-scheduling";

const MONDAY = "2026-11-23";
const line = (extra: Partial<DayPlanLine> = {}): DayPlanLine => ({
  id: "l",
  name: "Line",
  hoursPerDay: 8,
  shifts: [],
  changeoverMinutes: 10,
  allergenCleanMinutes: 30,
  crewAvailable: null,
  changeovers: [],
  ...extra,
});
const batch = (id: string, extra: Partial<DayPlanBatch> = {}): DayPlanBatch => ({
  id,
  batchCode: id,
  recipeId: id,
  status: "planned",
  runMinutes: 60,
  crew: null,
  contains: [],
  mayContain: [],
  ...extra,
});

describe("shifts", () => {
  it("stores a night shift as crossing midnight and merges overlapping windows", () => {
    expect(lineShiftMinutes({ start: "22:00", end: "06:00" })).toEqual({
      startMinute: 1320,
      endMinute: 1800,
    });
    expect(minutesToClock(1800)).toBe("06:00 +1");
    const shifts = [
      { name: "Early", weekdays: [1], startMinute: 360, endMinute: 840 },
      { name: "Overlap", weekdays: [1], startMinute: 800, endMinute: 900 },
      { name: "Night", weekdays: [1], startMinute: 1320, endMinute: 1800 },
    ];
    expect(shiftWindows(shifts, MONDAY)).toEqual([
      { start: 360, end: 900, names: ["Early", "Overlap"] },
      { start: 1320, end: 1800, names: ["Night"] },
    ]);
    expect(lineCapacityHours({ hoursPerDay: 8, shifts }, MONDAY, null)).toBe(17);
    expect(lineCapacityHours({ hoursPerDay: 8, shifts }, "2026-11-24", null)).toBe(0);
    expect(lineCapacityHours({ hoursPerDay: 8 }, MONDAY, null)).toBe(8);
    expect(lineCapacityHours({ hoursPerDay: 8 }, MONDAY, { scope: "workspace", reason: null })).toBe(0);
  });
});

describe("changeovers and allergens", () => {
  it("prefers the most specific rule, then same recipe, then the line default", () => {
    const rules = [
      { fromRecipeId: "a", toRecipeId: "b", minutes: 5 },
      { fromRecipeId: "a", toRecipeId: null, minutes: 20 },
      { fromRecipeId: null, toRecipeId: "c", minutes: 40 },
    ];
    expect(changeoverMinutes(rules, 10, "a", "b")).toMatchObject({ minutes: 5, source: "rule" });
    expect(changeoverMinutes(rules, 10, "a", "c")).toMatchObject({ minutes: 20, source: "rule" });
    expect(changeoverMinutes(rules, 10, "b", "c")).toMatchObject({ minutes: 40, source: "rule" });
    expect(changeoverMinutes(rules, 10, "b", "b")).toMatchObject({ minutes: 0, source: "same_recipe" });
    expect(changeoverMinutes(rules, 10, "b", "d")).toMatchObject({ minutes: 10, source: "line_default" });
    expect(changeoverMinutes(rules, 10, null, "d")).toMatchObject({ minutes: 0, source: "start" });
    expect(
      lineChangeoversSetSchema.safeParse({
        rules: [
          { fromRecipeId: null, toRecipeId: "00000000-0000-4000-8000-000000000001", minutes: 1 },
          { fromRecipeId: null, toRecipeId: "00000000-0000-4000-8000-000000000001", minutes: 2 },
        ],
      }).success,
    ).toBe(false);
  });

  it("never applies a wildcard rule to the same recipe again, only an exact A→A rule", () => {
    const wild = [{ fromRecipeId: "a", toRecipeId: null, minutes: 20 }];
    expect(changeoverMinutes(wild, 10, "a", "a")).toMatchObject({ minutes: 0, source: "same_recipe" });
    expect(
      changeoverMinutes([{ fromRecipeId: null, toRecipeId: "a", minutes: 20 }], 10, "a", "a"),
    ).toMatchObject({
      minutes: 0,
    });
    const exact = [...wild, { fromRecipeId: "a", toRecipeId: "a", minutes: 3 }];
    expect(changeoverMinutes(exact, 10, "a", "a")).toMatchObject({ minutes: 3, source: "rule" });
  });

  it("needs a clean-down when the previous batch leaves an allergen the next lacks", () => {
    expect(allergenCarryover({ contains: ["milk", "eggs"] }, { contains: ["milk"] })).toEqual(["eggs"]);
    expect(allergenCarryover({ contains: ["milk"] }, { contains: ["milk", "eggs"] })).toEqual([]);
    expect(allergenCarryover(null, { contains: [] })).toEqual([]);
  });
});

describe("day plan", () => {
  it("pauses between shift windows and reports an overrun past the last", () => {
    const shifts = [
      { name: "AM", weekdays: [1], startMinute: 360, endMinute: 480 },
      { name: "PM", weekdays: [1], startMinute: 540, endMinute: 600 },
    ];
    const plan = planLineDay(line({ shifts }), MONDAY, null, [
      batch("a", { runMinutes: 90 }),
      batch("b", { runMinutes: 60, contains: [] }),
    ]);
    // a: 06:00–07:30. b: 10 min changeover 07:30–07:40, then 07:40–08:00 and 09:00–09:40.
    expect(plan.steps.map((s) => [s.start, s.end])).toEqual([
      [360, 450],
      [460, 580],
    ]);
    expect(plan.overrunMinutes).toBe(0);
    const over = planLineDay(line({ shifts }), MONDAY, null, [batch("a", { runMinutes: 200 })]);
    expect(over.overrunMinutes).toBe(20);
    expect(over.steps[0]!.overrun).toBe(true);
  });

  it("times from 06:00 without shifts and flags unrated batches and a day off", () => {
    const plan = planLineDay(line(), MONDAY, null, [batch("a", { runMinutes: null }), batch("b")]);
    expect(plan.timing).toBe("hours_per_day");
    expect(plan.windows).toEqual([{ start: 360, end: 840, names: ["Hours per day"] }]);
    expect(plan.unrated).toBe(1);
    expect(plan.steps[1]!.start).toBe(370);
    const off = planLineDay(line(), MONDAY, { scope: "line", reason: "Refit" }, [batch("a")]);
    expect(off.capacityMinutes).toBe(0);
    expect(off.warnings[0]).toContain("Refit");
    expect(off.steps[0]!.overrun).toBe(true);
  });

  it("keeps started batches first and proposes allergen-free first", () => {
    const started = batch("s", { status: "in_progress", contains: ["milk"] });
    const nuts = batch("n", { contains: ["nuts"] });
    const free = batch("f");
    const proposal = proposeLineDaySequence(line(), MONDAY, null, [started, nuts, free]);
    expect(proposal.order.map((s) => [s.batchId, s.fixed])).toEqual([
      ["s", true],
      ["f", false],
      ["n", false],
    ]);
    // Both lack milk, so the clean-down comes first either way; the allergen-free one goes first.
    expect(proposal.order[1]!.reason).toContain("Clean-down unavoidable");
    const fresh = proposeLineDaySequence(line(), MONDAY, null, [nuts, free]);
    expect(fresh.order.map((s) => s.batchId)).toEqual(["f", "n"]);
    expect(fresh).toMatchObject({ changed: true, improves: true });
  });
});

describe("proposal reasons", () => {
  it("names the tie-breaker that actually decided, and ranks clean-downs by their full time", () => {
    const first = batch("first");
    const nuts = batch("nuts", { contains: ["nuts"] });
    const plain = batch("plain");
    // Both follow `first` with the 10 min default; the allergen-free one wins on allergens.
    const tie = proposeLineDaySequence(line(), MONDAY, null, [first, nuts, plain]);
    expect(tie.order.map((s) => s.batchId)).toEqual(["first", "plain", "nuts"]);
    expect(tie.order[1]!.reason).toBe("Same changeover as the alternatives (10 min); contains no allergens");

    // After milk, both need a clean-down: 20 and 25 min raw, both raised to the 30 min clean-down.
    const milk = batch("milk", { status: "in_progress", contains: ["milk"] });
    const p = batch("p", { contains: ["eggs"] });
    const q = batch("q");
    const rules = [
      { fromRecipeId: "milk", toRecipeId: "p", minutes: 20 },
      { fromRecipeId: "milk", toRecipeId: "q", minutes: 25 },
    ];
    const clean = proposeLineDaySequence(line({ changeovers: rules }), MONDAY, null, [milk, p, q]);
    expect(clean.order.map((s) => s.batchId)).toEqual(["milk", "q", "p"]);
    expect(clean.order[1]!.reason).toContain("Clean-down unavoidable");
    expect(clean.order[1]!.reason).toContain("contains no allergens");
  });
});

describe("daily demand projection", () => {
  it("runs from opening stock and marks the first short day", () => {
    const result = projectDailyDemand(10, [
      { date: "d1", committed: 5, planned: 0 },
      { date: "d2", committed: 10, planned: 0 },
      { date: "d3", committed: 0, planned: 20 },
    ]);
    expect(result.days.map((d) => [d.projected, d.short])).toEqual([
      [5, false],
      [-5, true],
      [15, false],
    ]);
    expect(result.firstShortDate).toBe("d2");
    expect(projectDailyDemand(null, [{ date: "d1", committed: 5, planned: 0 }]).days[0]).toMatchObject({
      projected: null,
      short: false,
    });
  });
});
