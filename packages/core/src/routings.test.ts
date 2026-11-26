import { describe, expect, it } from "vitest";
import {
  blockingPrevious,
  expectedOperationMinutes,
  jobCardQuantitySchema,
  loggedMinutes,
  remainingFromPrevious,
  routingDraftSchema,
  ROUTING_MAX_OPERATIONS,
  workCentreCost,
  workCentreCreateSchema,
  type JobCardProgress,
} from "./routings";

const card = (
  position: number,
  good: number,
  scrap = 0,
  status: JobCardProgress["status"] = "in_progress",
) => ({
  position,
  status,
  good,
  scrap,
});

describe("routings rules", () => {
  it("expects setup once and run per yield of the bill", () => {
    expect(expectedOperationMinutes({ setupMinutes: 15, runMinutes: 10 }, 5)).toEqual({
      setup: 15,
      run: 50,
      total: 65,
    });
    expect(expectedOperationMinutes({ setupMinutes: 0, runMinutes: 2.5 }, 0.5)).toEqual({
      setup: 0,
      run: 1.25,
      total: 1.25,
    });
    expect(expectedOperationMinutes({ setupMinutes: 5, runMinutes: 10 }, -1).run).toBe(0);
  });

  it("costs work-centre time to the cent", () => {
    expect(workCentreCost(61, 30)).toBe(30.5);
    expect(workCentreCost(90, 45)).toBe(67.5);
    expect(workCentreCost(10, 33.3333)).toBe(5.56);
    expect(workCentreCost(0, 100)).toBe(0);
  });

  it("logs whole minutes, at least one for a timer that ran", () => {
    expect(loggedMinutes("2026-11-20T08:00:00Z", "2026-11-20T09:30:20Z")).toBe(90);
    expect(loggedMinutes("2026-11-20T08:00:00Z", "2026-11-20T08:00:10Z")).toBe(1);
    expect(loggedMinutes("2026-11-20T08:00:00Z", "2026-11-20T08:00:00Z")).toBe(0);
    expect(loggedMinutes("2026-11-20T09:00:00Z", "2026-11-20T08:00:00Z")).toBe(0);
  });

  it("limits each operation to what the one before passed as good", () => {
    const cards = [card(1, 4, 1), card(2, 3), card(3, 0)];
    expect(remainingFromPrevious(cards, 1)).toBeNull();
    expect(remainingFromPrevious(cards, 2)).toBe(1);
    expect(remainingFromPrevious(cards, 3)).toBe(3);
    // Scrap at an operation counts against what it may still report.
    expect(remainingFromPrevious([card(1, 4), card(2, 2, 2)], 2)).toBe(0);
    // Never negative, and a cancelled operation is skipped.
    expect(remainingFromPrevious([card(1, 1), card(2, 3)], 2)).toBe(0);
    expect(remainingFromPrevious([card(1, 6), card(2, 0, 0, "cancelled"), card(3, 2)], 3)).toBe(4);
    // Order of the input doesn't matter.
    expect(remainingFromPrevious([card(2, 1), card(1, 5)], 2)).toBe(4);
  });

  it("blocks completing an operation until the one before is complete", () => {
    const cards = [card(1, 4, 0, "completed"), card(2, 4), card(3, 0, 0, "pending")];
    expect(blockingPrevious(cards, 1)).toBeUndefined();
    expect(blockingPrevious(cards, 2)).toBeUndefined();
    expect(blockingPrevious(cards, 3)).toMatchObject({ position: 2 });
    expect(
      blockingPrevious([card(1, 0, 0, "completed"), card(2, 0, 0, "cancelled"), card(3, 0)], 3),
    ).toBeUndefined();
  });
});

describe("routings validation", () => {
  it("defaults a work centre's capacity and rate", () => {
    expect(workCentreCreateSchema.parse({ code: "CNC-1", name: "Synthetic mill" })).toMatchObject({
      hoursPerDay: 8,
      stations: 1,
      costPerHour: 0,
    });
    expect(workCentreCreateSchema.safeParse({ code: "X", name: "Y", hoursPerDay: 25 }).success).toBe(false);
    expect(workCentreCreateSchema.safeParse({ code: "X", name: "Y", stations: 0 }).success).toBe(false);
    expect(workCentreCreateSchema.safeParse({ code: "X", name: "Y", costPerHour: 1.23456 }).success).toBe(
      false,
    );
  });

  it("caps a routing at its maximum operations", () => {
    const op = { name: "Op", workCentreId: "00000000-0000-4000-8000-000000000001" };
    expect(routingDraftSchema.parse({ operations: [op] }).operations[0]).toMatchObject({
      setupMinutes: 0,
      runMinutes: 0,
    });
    const tooMany = Array.from({ length: ROUTING_MAX_OPERATIONS + 1 }, () => op);
    expect(routingDraftSchema.safeParse({ operations: tooMany }).success).toBe(false);
  });

  it("needs a quantity, and a reason for scrap", () => {
    expect(jobCardQuantitySchema.safeParse({ unit: "each" }).success).toBe(false);
    expect(jobCardQuantitySchema.safeParse({ scrap: 1, unit: "each" }).success).toBe(false);
    expect(jobCardQuantitySchema.safeParse({ scrap: 1, unit: "each", scrapReason: "Bent" }).success).toBe(
      true,
    );
    expect(jobCardQuantitySchema.safeParse({ good: 2, unit: "each" }).success).toBe(true);
  });
});
