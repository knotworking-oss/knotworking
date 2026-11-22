import { roundQuantity, unitsForItem } from "./items";
import { describe, expect, it } from "vitest";
import {
  addDays,
  classifyExpiry,
  daysBetween,
  generateLotCode,
  isPickable,
  itemBaseUnit,
  lotCodePrefix,
  pickFefo,
  stockAmount,
  stockAdjustmentSchema,
  stockLevelsQuerySchema,
  stockReceiptSchema,
  stocktakeSchema,
  stockTransferSchema,
  toBaseQuantity,
  toDisplayQuantity,
  type PickCandidate,
} from "./stock";

const ID = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("quantities", () => {
  it("rounds to four decimal places, without negative zero", () => {
    expect(roundQuantity(1.23456)).toBe(1.2346);
    expect(roundQuantity(1.00005)).toBe(1.0001);
    expect(roundQuantity(-1.23456)).toBe(-1.2346);
    expect(roundQuantity(0.1 + 0.2)).toBe(0.3);
    expect(Object.is(roundQuantity(-0.00001), 0)).toBe(true);
  });

  it("converts to the item's base unit, crossing dimensions only with a bridge", () => {
    const flour = { unit: "kg" as const };
    expect(itemBaseUnit(flour)).toBe("g");
    expect(toBaseQuantity(2.5, "kg", flour)).toBe(2500);
    expect(toBaseQuantity(1, "mg", flour)).toBe(0.001);
    expect(toBaseQuantity(1, "l", flour)).toBeNull();
    const milk = { unit: "l" as const, densityGPerMl: 1.03 };
    expect(itemBaseUnit(milk)).toBe("ml");
    expect(toBaseQuantity(1.03, "kg", milk)).toBe(1000);
    expect(toBaseQuantity(1, "g", milk)).toBe(0.9709);
    const eggs = { unit: "each" as const, unitWeightG: 60 };
    expect(toBaseQuantity(0.6, "kg", eggs)).toBe(10);
  });

  it("expresses base quantities in the item's own unit", () => {
    expect(toDisplayQuantity(2500, { unit: "kg" })).toBe(2.5);
    expect(toDisplayQuantity(750, { unit: "l" })).toBe(0.75);
    expect(toDisplayQuantity(12, { unit: "each" })).toBe(12);
    expect(stockAmount(1234.5, { unit: "kg" })).toEqual({
      base: 1234.5,
      baseUnit: "g",
      display: 1.2345,
      displayUnit: "kg",
    });
  });

  it("lists the units an item can be entered in", () => {
    expect(unitsForItem({ unit: "kg" })).toEqual(["mg", "g", "kg"]);
    expect(unitsForItem({ unit: "l", densityGPerMl: 1 })).toEqual(["mg", "g", "kg", "ml", "l"]);
    expect(unitsForItem({ unit: "each", unitWeightG: 50 })).toEqual(["mg", "g", "kg", "each"]);
  });
});

describe("dates and lot codes", () => {
  it("adds days and counts them across month, year and DST boundaries", () => {
    expect(addDays("2026-03-28", 3)).toBe("2026-03-31");
    expect(addDays("2026-12-30", 5)).toBe("2027-01-04");
    expect(addDays("2026-03-31", -31)).toBe("2026-02-28");
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetween("2026-11-11", "2026-11-01")).toBe(-10);
  });

  it("generates lot codes from the received date and a sequence", () => {
    expect(lotCodePrefix("2026-11-05")).toBe("L261105-");
    expect(generateLotCode("2026-11-05", 3)).toBe("L261105-003");
    expect(generateLotCode("2026-11-05", 1234)).toBe("L261105-1234");
  });

  it("classifies expiry: good through the date itself, soon within the window", () => {
    const today = "2026-11-11";
    expect(classifyExpiry(null, today)).toBe("ok");
    expect(classifyExpiry("2026-11-10", today)).toBe("expired");
    expect(classifyExpiry("2026-11-11", today)).toBe("expiring_soon");
    expect(classifyExpiry("2026-11-18", today)).toBe("expiring_soon");
    expect(classifyExpiry("2026-11-19", today)).toBe("ok");
    expect(classifyExpiry("2026-11-19", today, 30)).toBe("expiring_soon");
  });
});

describe("pickFefo", () => {
  const today = "2026-11-11";
  const lot = (over: Partial<PickCandidate> & { lotId: string }): PickCandidate => ({
    locationId: "loc-a",
    quantity: 100,
    status: "available",
    expiresOn: null,
    expiryType: null,
    receivedOn: "2026-11-01",
    ...over,
  });

  it("takes the earliest expiry first and lots without a date last", () => {
    const result = pickFefo(
      [
        lot({ lotId: "none", expiresOn: null }),
        lot({ lotId: "late", expiresOn: "2026-12-31", expiryType: "best_before" }),
        lot({ lotId: "early", expiresOn: "2026-11-20", expiryType: "use_by" }),
      ],
      250,
      today,
    );
    expect(result.allocations.map((a) => [a.candidate.lotId, a.quantity])).toEqual([
      ["early", 100],
      ["late", 100],
      ["none", 50],
    ]);
    expect(result).toMatchObject({ allocated: 250, shortfall: 0 });
  });

  it("stops as soon as the requirement is covered", () => {
    const result = pickFefo([lot({ lotId: "a" }), lot({ lotId: "b", receivedOn: "2026-11-02" })], 40, today);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]).toMatchObject({ quantity: 40, candidate: { lotId: "a" } });
  });

  it("breaks ties by received date, then lot code", () => {
    const result = pickFefo(
      [
        lot({
          lotId: "c",
          lotCode: "B",
          expiresOn: "2026-12-01",
          expiryType: "use_by",
          receivedOn: "2026-11-02",
        }),
        lot({
          lotId: "b",
          lotCode: "Z",
          expiresOn: "2026-12-01",
          expiryType: "use_by",
          receivedOn: "2026-11-01",
        }),
        lot({
          lotId: "a",
          lotCode: "A",
          expiresOn: "2026-12-01",
          expiryType: "use_by",
          receivedOn: "2026-11-02",
        }),
      ],
      300,
      today,
    );
    expect(result.allocations.map((a) => a.candidate.lotId)).toEqual(["b", "a", "c"]);
  });

  it("never picks quarantined, rejected, empty or use-by-expired stock", () => {
    const result = pickFefo(
      [
        lot({ lotId: "q", status: "quarantine", expiresOn: "2026-11-12", expiryType: "use_by" }),
        lot({ lotId: "r", status: "rejected", expiresOn: "2026-11-12", expiryType: "use_by" }),
        lot({ lotId: "expired", expiresOn: "2026-11-10", expiryType: "use_by" }),
        lot({ lotId: "empty", quantity: 0 }),
        lot({ lotId: "negative", quantity: -5 }),
        lot({ lotId: "today", expiresOn: today, expiryType: "use_by", quantity: 30 }),
      ],
      100,
      today,
    );
    expect(result.allocations.map((a) => a.candidate.lotId)).toEqual(["today"]);
    expect(result).toMatchObject({ allocated: 30, shortfall: 70 });
  });

  it("keeps lots past best-before pickable but flags them", () => {
    const result = pickFefo(
      [lot({ lotId: "old", expiresOn: "2026-11-01", expiryType: "best_before" })],
      10,
      today,
    );
    expect(result.allocations[0]).toMatchObject({ quantity: 10, pastBestBefore: true });
    expect(
      isPickable({ status: "available", quantity: 1, expiresOn: "2026-11-01", expiryType: "use_by" }, today),
    ).toBe(false);
  });

  it("splits one lot's stock across locations as separate allocations", () => {
    const result = pickFefo(
      [
        lot({ lotId: "a", locationId: "loc-b", quantity: 20 }),
        lot({ lotId: "a", locationId: "loc-a", quantity: 20 }),
      ],
      30,
      today,
    );
    expect(result.allocations.map((a) => [a.candidate.locationId, a.quantity])).toEqual([
      ["loc-a", 20],
      ["loc-b", 10],
    ]);
  });

  it("reports the full shortfall with no stock and allocates nothing for zero", () => {
    expect(pickFefo([], 12.5, today)).toEqual({ allocations: [], allocated: 0, shortfall: 12.5 });
    expect(pickFefo([lot({ lotId: "a" })], 0, today)).toEqual({
      allocations: [],
      allocated: 0,
      shortfall: 0,
    });
  });

  it("works in rounded decimals", () => {
    const result = pickFefo(
      [lot({ lotId: "a", quantity: 0.1 }), lot({ lotId: "b", quantity: 0.2 })],
      0.3,
      today,
    );
    expect(result).toMatchObject({ allocated: 0.3, shortfall: 0 });
  });
});

describe("stock schemas", () => {
  const receipt = { itemId: ID(1), quantity: 25, unit: "kg", locationId: ID(2), receivedOn: "2026-11-11" };

  it("accepts a minimal receipt and normalises empty text", () => {
    expect(stockReceiptSchema.parse({ ...receipt, lotCode: " ", supplierLotCode: " B12 " })).toMatchObject({
      lotCode: null,
      supplierLotCode: "B12",
    });
  });

  it("needs an expiry date and type together, not before the received date", () => {
    expect(stockReceiptSchema.safeParse({ ...receipt, expiresOn: "2026-12-01" }).success).toBe(false);
    expect(stockReceiptSchema.safeParse({ ...receipt, expiryType: "use_by" }).success).toBe(false);
    expect(
      stockReceiptSchema.safeParse({ ...receipt, expiresOn: "2026-11-01", expiryType: "use_by" }).success,
    ).toBe(false);
    expect(
      stockReceiptSchema.safeParse({ ...receipt, expiresOn: "2026-12-01", expiryType: "use_by" }).success,
    ).toBe(true);
  });

  it("refuses zero, negative and rejected-on-receipt quantities", () => {
    expect(stockReceiptSchema.safeParse({ ...receipt, quantity: 0 }).success).toBe(false);
    expect(stockReceiptSchema.safeParse({ ...receipt, quantity: -1 }).success).toBe(false);
    expect(stockReceiptSchema.safeParse({ ...receipt, status: "rejected" }).success).toBe(false);
    expect(stockReceiptSchema.safeParse({ ...receipt, unit: "lb" }).success).toBe(false);
  });

  it("refuses a transfer to the same location and a zero adjustment", () => {
    const transfer = { lotId: ID(1), fromLocationId: ID(2), toLocationId: ID(2), quantity: 1, unit: "kg" };
    expect(stockTransferSchema.safeParse(transfer).success).toBe(false);
    expect(stockTransferSchema.safeParse({ ...transfer, toLocationId: ID(3) }).success).toBe(true);
    const adjustment = { lotId: ID(1), locationId: ID(2), unit: "kg", reason: "Recount" };
    expect(stockAdjustmentSchema.safeParse({ ...adjustment, quantity: 0 }).success).toBe(false);
    expect(stockAdjustmentSchema.safeParse({ ...adjustment, quantity: -2 }).success).toBe(true);
    expect(stockAdjustmentSchema.safeParse({ ...adjustment, quantity: 2, reason: " " }).success).toBe(false);
  });

  it("refuses a stocktake that counts the same lot twice at one location", () => {
    const count = { lotId: ID(1), locationId: ID(2), countedQuantity: 3, unit: "kg" };
    expect(stocktakeSchema.safeParse({ counts: [count, count] }).success).toBe(false);
    expect(stocktakeSchema.safeParse({ counts: [count, { ...count, locationId: ID(3) }] }).success).toBe(
      true,
    );
    expect(stocktakeSchema.safeParse({ counts: [] }).success).toBe(false);
  });

  it("parses query flags and paging", () => {
    expect(stockLevelsQuerySchema.parse({ includeZero: "true", limit: "10" })).toMatchObject({
      includeZero: true,
      limit: 10,
      offset: 0,
    });
    expect(stockLevelsQuerySchema.parse({})).toMatchObject({ includeZero: false, limit: 50 });
  });
});
