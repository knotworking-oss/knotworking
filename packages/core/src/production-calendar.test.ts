import { describe, expect, it } from "vitest";
import { buildCapacityComparison, type CapacityBatch } from "./demand-capacity";
import { buildCoverage } from "./demand-planning";
import { isoWeekdayOf } from "./quality";
import type { DemandSummary } from "./demand";
import {
  expandNonWorkingDates,
  nonWorkingDaysAddSchema,
  workingCalendar,
  workingDaysIn,
} from "./production-calendar";
import {
  lotLocationKey,
  netOfReservations,
  reservationExpired,
  reservationHeldOn,
  scheduleLoads,
} from "./production-capacity";

describe("calendar", () => {
  it("expands a range, optionally to some weekdays", () => {
    expect(isoWeekdayOf("2026-11-14")).toBe(6);
    expect(expandNonWorkingDates({ from: "2026-12-25" })).toEqual(["2026-12-25"]);
    expect(expandNonWorkingDates({ from: "2026-11-09", to: "2026-11-15", weekdays: [6, 7] })).toEqual([
      "2026-11-14",
      "2026-11-15",
    ]);
  });

  it("validates a request", () => {
    expect(nonWorkingDaysAddSchema.safeParse({ from: "2026-12-25", to: "2026-12-24" }).success).toBe(false);
    expect(nonWorkingDaysAddSchema.safeParse({ from: "2026-01-01", to: "2028-01-01" }).success).toBe(false);
    expect(nonWorkingDaysAddSchema.safeParse({ from: "2026-12-25", weekdays: [8] }).success).toBe(false);
    expect(nonWorkingDaysAddSchema.safeParse({ from: "2026-12-25", reason: "  " }).data?.reason).toBeNull();
  });

  it("a line's own day off wins over the workspace's for the reason, and applies to that line only", () => {
    const cal = workingCalendar([
      { date: "2026-12-25", lineId: null, reason: "Christmas" },
      { date: "2026-12-25", lineId: "l1", reason: "Refit" },
      { date: "2026-12-28", lineId: "l1", reason: "Refit" },
    ]);
    expect(cal.dayOff("2026-12-25")).toEqual({ scope: "workspace", reason: "Christmas" });
    expect(cal.dayOff("2026-12-25", "l1")).toEqual({ scope: "line", reason: "Refit" });
    expect(cal.dayOff("2026-12-25", "l2")).toEqual({ scope: "workspace", reason: "Christmas" });
    expect(cal.dayOff("2026-12-28")).toBeNull();
    expect(cal.dayOff("2026-12-28", "l1")).not.toBeNull();
    expect(workingDaysIn(cal, ["2026-12-25", "2026-12-26", "2026-12-28"], "l1")).toEqual(["2026-12-26"]);
  });

  it("takes capacity off a day off in the schedule, and flags a batch on it", () => {
    const cal = workingCalendar([{ date: "2026-11-20", lineId: null, reason: "Holiday" }]);
    const line = { id: "l1", hoursPerDay: 8, rates: { r: 100 } };
    const batch = {
      id: "b",
      lineId: "l1",
      recipeId: "r",
      plannedOn: "2026-11-20",
      plannedQuantity: 400,
      status: "planned" as const,
    };
    const [off, on] = scheduleLoads([line], [batch], ["2026-11-20", "2026-11-21"], cal).l1!;
    expect(off).toMatchObject({
      capacityHours: 0,
      hours: 4,
      overloaded: true,
      dayOff: { reason: "Holiday" },
    });
    expect(on).toMatchObject({ capacityHours: 8, overloaded: false, dayOff: null });
  });
});

describe("reservations", () => {
  it("expires after its last day", () => {
    const r = { status: "active" as const, quantity: 5, fulfilledQuantity: 1, expiresOn: "2026-11-13" };
    expect(reservationExpired(r, "2026-11-13")).toBe(false);
    expect(reservationExpired(r, "2026-11-14")).toBe(true);
    expect(reservationHeldOn(r, "2026-11-13")).toBe(4);
    expect(reservationHeldOn(r, "2026-11-14")).toBe(0);
    expect(reservationExpired({ ...r, expiresOn: null }, "2030-01-01")).toBe(false);
    expect(reservationExpired({ ...r, status: "released" }, "2030-01-01")).toBe(false);
  });

  it("takes a location's reservation off that location first", () => {
    const stock = [
      { lotId: "a", locationId: "store", quantity: 4 },
      { lotId: "a", locationId: "chill", quantity: 2 },
    ];
    // 2 held at the chiller, 1 for the lot as a whole (3 in all).
    const free = netOfReservations(stock, new Map([["a", 3]]), new Map([[lotLocationKey("a", "chill"), 2]]));
    expect(free).toEqual([{ lotId: "a", locationId: "store", quantity: 3 }]);
    // Without location detail the whole lot's 3 comes off in order.
    expect(netOfReservations(stock, new Map([["a", 3]]))).toEqual([
      { lotId: "a", locationId: "store", quantity: 1 },
      { lotId: "a", locationId: "chill", quantity: 2 },
    ]);
  });

  it("a location reservation larger than what is left there spills onto the rest of the lot", () => {
    const stock = [
      { lotId: "a", locationId: "store", quantity: 4 },
      { lotId: "a", locationId: "chill", quantity: 1 },
    ];
    const free = netOfReservations(stock, new Map([["a", 3]]), new Map([[lotLocationKey("a", "chill"), 3]]));
    expect(free).toEqual([{ lotId: "a", locationId: "store", quantity: 2 }]);
  });
});

describe("capacity comparison", () => {
  const item = {
    id: "cake",
    code: "CAKE",
    name: "Cake",
    type: "finished" as const,
    unit: "each" as const,
    status: "active" as const,
  };
  const weeks = [
    { periodStart: "2026-11-09", week: "2026-W46" },
    { periodStart: "2026-11-16", week: "2026-W47" },
  ];
  const cell = (periodStart: string, week: string, quantity: number) => ({
    periodStart,
    week,
    quantity: { base: quantity, baseUnit: "each", display: quantity, displayUnit: "each" },
    lineCount: 1,
  });
  const summary = {
    from: "2026-11-09",
    to: "2026-11-16",
    weeks,
    rows: [
      {
        item,
        total: cell("", "", 0).quantity,
        periods: [cell("2026-11-09", "2026-W46", 60), cell("2026-11-16", "2026-W47", 60)],
      },
    ],
  } as unknown as DemandSummary;
  const lines = [{ id: "l1", name: "Line 1", hoursPerDay: 8 }];
  const rates = new Map([["l1", { r: 6 }]]);
  const itemRates = new Map([["cake", { ratePerHour: 6, lineId: "l1", lineName: "Line 1" }]]);
  const none = workingCalendar([]);

  it("needs the new shortfall of each week, not the running total", () => {
    const coverage = buildCoverage({ summary, stock: new Map(), supply: new Map() });
    const out = buildCapacityComparison({ coverage, lines, rates, batches: [], itemRates, calendar: none });
    // 60 cakes short each week: 10 hours each, not 10 then 20.
    expect(out.weeks.map((w) => w.neededHours)).toEqual([10, 10]);
    expect(out.weeks[0]).toMatchObject({ capacityHours: 56, status: "ok" });
    expect(out.needs[0]!.rate).toMatchObject({ lineName: "Line 1" });
  });

  it("adds booked batches, honours days off and goes over", () => {
    const coverage = buildCoverage({ summary, stock: new Map(), supply: new Map() });
    const batch: CapacityBatch = {
      id: "b1",
      batchCode: "B1",
      lineId: "l1",
      recipeId: "r",
      plannedOn: "2026-11-17",
      plannedQuantity: 120,
      status: "planned",
    };
    const cal = workingCalendar([
      { date: "2026-11-16", lineId: null, reason: "Shutdown" },
      { date: "2026-11-17", lineId: null, reason: "Shutdown" },
      { date: "2026-11-18", lineId: null, reason: "Shutdown" },
      { date: "2026-11-19", lineId: null, reason: "Shutdown" },
      { date: "2026-11-20", lineId: null, reason: "Shutdown" },
      { date: "2026-11-21", lineId: null, reason: "Shutdown" },
    ]);
    const out = buildCapacityComparison({
      coverage,
      lines,
      rates,
      batches: [batch],
      itemRates,
      calendar: cal,
    });
    const w = out.weeks[1]!;
    expect(w).toMatchObject({ capacityHours: 8, bookedHours: 20, neededHours: 10, status: "over" });
    expect(w.batchesOnDaysOff).toMatchObject([{ batchCode: "B1", date: "2026-11-17", reason: "Shutdown" }]);
    expect(w.daysOff).toHaveLength(6);
    expect(out.overWeeks).toEqual(["2026-11-16"]);
  });

  it("flags tight weeks, items no line can make, and unassigned batches", () => {
    const coverage = buildCoverage({ summary, stock: new Map(), supply: new Map() });
    const tight = buildCapacityComparison({
      coverage,
      lines: [{ id: "l1", name: "Line 1", hoursPerDay: 1.5 }],
      rates,
      batches: [],
      itemRates,
      calendar: none,
    });
    expect(tight.weeks[0]).toMatchObject({ capacityHours: 10.5, loadPercent: 95.2, status: "tight" });
    const unbooked: CapacityBatch = {
      id: "b",
      batchCode: "B",
      lineId: null,
      recipeId: "r",
      plannedOn: "2026-11-10",
      plannedQuantity: 6,
      status: "planned",
    };
    const noRate = buildCapacityComparison({
      coverage,
      lines,
      rates,
      batches: [unbooked],
      itemRates: new Map(),
      calendar: none,
    });
    expect(noRate.weeks[0]).toMatchObject({ neededHours: 0, unratedItems: 1, unassignedBatches: 1 });
    expect(noRate.needs[0]!.rate).toBeNull();
  });
});
