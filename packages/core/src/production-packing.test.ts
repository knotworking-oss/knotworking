import { describe, expect, it } from "vitest";
import {
  evaluatePackingCheck,
  evaluateWeightSample,
  normaliseCode,
  packingCheckSchema,
  packingRunGaps,
  reconciliationVariance,
  tolerableNegativeError,
} from "./production-packing";

describe("tolerable negative error (UK Packaged Goods Regulations, Schedule 2)", () => {
  it("follows the table at each band and rounds up to 0.1", () => {
    expect(tolerableNegativeError(4)).toBeNull();
    expect(tolerableNegativeError(5)).toBe(0.5); // 9% of 5 = 0.45 → 0.5
    expect(tolerableNegativeError(50)).toBe(4.5);
    expect(tolerableNegativeError(75)).toBe(4.5);
    expect(tolerableNegativeError(150)).toBe(6.8); // 4.5% of 150 = 6.75 → 6.8
    expect(tolerableNegativeError(250)).toBe(9);
    expect(tolerableNegativeError(400)).toBe(12);
    expect(tolerableNegativeError(750)).toBe(15);
    expect(tolerableNegativeError(2000)).toBe(30);
    expect(tolerableNegativeError(12_000)).toBe(150);
    expect(tolerableNegativeError(20_000)).toBe(200);
    expect(tolerableNegativeError(60_000)).toBeNull();
  });
});

describe("weight samples", () => {
  it("applies the three packer's rules to the sample", () => {
    expect(evaluateWeightSample(250, [250, 251, 252]).passed).toBe(true);
    const lowMean = evaluateWeightSample(250, [249, 249, 250]);
    expect(lowMean.passed).toBe(false);
    expect(lowMean.reasons[0]).toMatch(/Mean 249.33 is below/);
    // One pack below 241 in 10 is more than 2.5% of the sample (floor(0.25) = 0 allowed).
    const t1 = evaluateWeightSample(250, [240, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
    expect(t1).toMatchObject({ belowT1: 1, belowT2: 0, passed: false });
    // The mean is compared unrounded: 499.996 is below 500.
    expect(evaluateWeightSample(500, [499.992, 500]).passed).toBe(false);
    const t2 = evaluateWeightSample(250, [231, 300, 300]);
    expect(t2.belowT2).toBe(1);
  });
});

describe("label and code checks", () => {
  it("compares codes without case or spacing and names each failure", () => {
    expect(normaliseCode(" bb 24 Nov  26 ")).toBe("BB24NOV26");
    const input = packingCheckSchema.parse({
      kind: "in_run_label",
      labelCorrect: false,
      dateCodeSeen: "BB 24 NOV 26",
      lotCodeSeen: "L2",
      legible: false,
    });
    const r = evaluatePackingCheck(input, {
      expectedDateCode: "bb24nov26",
      expectedLotCode: "L1",
      nominalQuantity: null,
    });
    expect(r.passed).toBe(false);
    expect(r.reasons).toEqual([
      "The label on the pack is not the approved label",
      'Lot code reads "L2", expected "L1"',
      "Printed codes are not legible or complete",
    ]);
  });

  it("refuses a weight sample on a run without a nominal quantity", () => {
    const input = packingCheckSchema.parse({ kind: "weight_sample", readings: [250] });
    expect(
      evaluatePackingCheck(input, { expectedDateCode: "x", expectedLotCode: "y", nominalQuantity: null })
        .passed,
    ).toBe(false);
  });
});

describe("detector challenges", () => {
  it("need every test piece", () => {
    const one = packingCheckSchema.safeParse({
      kind: "detector_challenge",
      detector: "MD-1",
      pieces: [
        { piece: "ferrous", sizeMm: 2, rejected: true },
        { piece: "ferrous", sizeMm: 2, rejected: true },
        { piece: "ferrous", sizeMm: 2, rejected: true },
      ],
    });
    expect(one.success).toBe(false);
  });
});

describe("closing", () => {
  it("lists missing and failed checks, and works out reconciliation variance", () => {
    expect(packingRunGaps({ detectorRequired: false, nominalQuantity: null }, {})).toEqual([
      "No line clearance recorded",
      "No first-off label and code check recorded",
    ]);
    expect(
      packingRunGaps(
        { detectorRequired: false, nominalQuantity: null },
        { line_clearance: { passed: true }, first_off: { passed: true }, in_run_label: { passed: false } },
      ),
    ).toEqual(["The last in-run label and code check failed and no passing one has followed"]);
    expect(reconciliationVariance({ issued: 100, used: 90, wasted: 5, returned: 5 })).toBe(0);
    expect(reconciliationVariance({ issued: 100, used: 90, wasted: 5, returned: 0 })).toBe(5);
  });
});
