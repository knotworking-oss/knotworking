import { describe, expect, it } from "vitest";
import {
  batchHours,
  fulfilReservations,
  netOfReservations,
  productionLineCreateSchema,
  productionReserveSchema,
  reservationHeld,
  scheduleLoads,
} from "./production-capacity";

describe("reservations", () => {
  it("holds what is not yet fulfilled, and nothing once released", () => {
    expect(reservationHeld({ quantity: 10, fulfilledQuantity: 4, status: "active" })).toBe(6);
    expect(reservationHeld({ quantity: 10, fulfilledQuantity: 4, status: "released" })).toBe(0);
  });

  it("takes reservations off lot balances across locations", () => {
    const c = [
      { lotId: "a", locationId: "x", quantity: 3 },
      { lotId: "a", locationId: "y", quantity: 4 },
      { lotId: "b", locationId: "x", quantity: 2 },
    ];
    expect(netOfReservations(c, new Map([["a", 5]]))).toEqual([
      { lotId: "a", locationId: "y", quantity: 2 },
      { lotId: "b", locationId: "x", quantity: 2 },
    ]);
    expect(netOfReservations(c, { b: 9 })).toHaveLength(2);
  });

  it("fulfils the oldest reservation first and finishes used-up ones", () => {
    const r = [
      { id: "1", quantity: 2, fulfilledQuantity: 0 },
      { id: "2", quantity: 5, fulfilledQuantity: 1 },
    ];
    expect(fulfilReservations(r, 3)).toEqual([
      { id: "1", fulfilled: 2, done: true },
      { id: "2", fulfilled: 2, done: false },
    ]);
    expect(fulfilReservations(r, 100).every((x) => x.done)).toBe(true);
  });

  it("needs lines or allOutstanding, and a unit with a quantity", () => {
    expect(productionReserveSchema.safeParse({}).success).toBe(false);
    expect(productionReserveSchema.safeParse({ allOutstanding: true }).success).toBe(true);
    const id = "0190c0de-0000-7000-8000-000000000001";
    expect(productionReserveSchema.safeParse({ lines: [{ itemId: id, quantity: 1 }] }).success).toBe(false);
    expect(
      productionReserveSchema.safeParse({ lines: [{ lotId: id, quantity: 1, unit: "kg" }] }).success,
    ).toBe(true);
  });
});

describe("line capacity", () => {
  const line = { id: "L", hoursPerDay: 8, rates: { r1: 100 } };
  const b = (id: string, qty: number, extra: object = {}) => ({
    id,
    lineId: "L",
    recipeId: "r1",
    plannedOn: "2026-11-20",
    plannedQuantity: qty,
    status: "planned" as const,
    ...extra,
  });

  it("works out hours from the rate", () => {
    expect(batchHours(250, 100)).toBe(2.5);
    expect(batchHours(250, null)).toBeNull();
  });

  it("loads a day against capacity and warns when over", () => {
    const out = scheduleLoads(
      [line],
      [b("a", 500), b("b", 400), b("c", 100, { status: "cancelled" })],
      ["2026-11-20", "2026-11-21"],
    );
    expect(out.L![0]).toMatchObject({ hours: 9, capacityHours: 8, loadPercent: 112.5, overloaded: true });
    expect(out.L![1]).toMatchObject({ hours: 0, overloaded: false, batches: [] });
    const exact = scheduleLoads([line], [b("a", 800)], ["2026-11-20"]);
    expect(exact.L![0]!.overloaded).toBe(false);
  });

  it("flags batches with no rate instead of guessing hours", () => {
    const out = scheduleLoads([line], [b("a", 100, { recipeId: "other" })], ["2026-11-20"]);
    expect(out.L![0]).toMatchObject({ hours: 0, unrated: 1 });
    expect(out.L![0]!.batches[0]!.hours).toBeNull();
  });

  it("validates a line", () => {
    expect(productionLineCreateSchema.parse({ name: " Line 1 " })).toMatchObject({
      name: "Line 1",
      hoursPerDay: 8,
    });
    expect(productionLineCreateSchema.safeParse({ name: "x", hoursPerDay: 25 }).success).toBe(false);
  });
});
