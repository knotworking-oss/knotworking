import { describe, expect, it } from "vitest";
import {
  barcodeBars,
  BARCODE_QUIET_MODULES,
  encodeCode128,
  encodeGs1Lot,
  encodeGs1Sscc,
  gs1LotElements,
  isCode128Text,
  isGs1Lot,
  parseGs1,
} from "./lot-barcode";

/** Decodes the symbol values back to text (subsets B and C only), checking start, checksum and stop. */
function decode(values: number[]): string {
  const [start, ...rest] = values;
  const stop = rest.pop();
  const check = rest.pop()!;
  expect(stop).toBe(106);
  let sum = start!;
  rest.forEach((v, i) => (sum += v * (i + 1)));
  expect(sum % 103).toBe(check);
  let mode = start === 105 ? "C" : "B";
  let out = "";
  for (const v of rest) {
    if (v === 99) mode = "C";
    else if (v === 100) mode = "B";
    else if (v === 102) out += "<FNC1>";
    else if (mode === "C") out += String(v).padStart(2, "0");
    else out += String.fromCharCode(v + 32);
  }
  return out;
}

describe("Code 128", () => {
  it("encodes text with a valid checksum, start and stop that decodes back", () => {
    for (const text of ["Hello", "L261113001", "B-2026/11 x~", "12345678", "AB12345678CD", "9", "A1234"]) {
      expect(decode(encodeCode128(text).values), text).toBe(text);
    }
  });

  it("uses the known symbol for a simple string", () => {
    // "A" in subset B: start B (104), "A" (33), checksum (104 + 33) mod 103 = 34, stop.
    expect(encodeCode128("A").values).toEqual([104, 33, 34, 106]);
    // 11 modules per symbol, 13 for the stop.
    expect(encodeCode128("A").modules).toBe(11 * 3 + 13);
  });

  it("packs digits in subset C when that is shorter", () => {
    expect(encodeCode128("12345678").values[0]).toBe(105);
    expect(encodeCode128("12345678").values).toHaveLength(1 + 4 + 2);
    expect(encodeCode128("AB").values[0]).toBe(104);
  });

  it("takes printable ASCII only", () => {
    expect(isCode128Text("Lot 1/A")).toBe(true);
    expect(isCode128Text("")).toBe(false);
    expect(isCode128Text("café")).toBe(false);
    expect(() => encodeCode128("café")).toThrow();
  });

  it("lays out bars with a quiet zone on each side", () => {
    const code = encodeCode128("A");
    const { bars, viewBoxWidth } = barcodeBars(code);
    expect(viewBoxWidth).toBe(code.modules + 2 * BARCODE_QUIET_MODULES);
    expect(bars[0]!.x).toBe(BARCODE_QUIET_MODULES);
    const last = bars.at(-1)!;
    expect(last.x + last.width).toBe(BARCODE_QUIET_MODULES + code.modules);
  });
});

describe("GS1-128 lot labels", () => {
  it("writes the expiry (use by 17, best before 15) before the lot number", () => {
    expect(gs1LotElements({ lot: "L261113001", expiresOn: "2026-12-31", expiryType: "use_by" })).toEqual({
      data: "17261231" + "10L261113001",
      human: "(17)261231(10)L261113001",
    });
    expect(gs1LotElements({ lot: "A1", expiresOn: "2027-01-05", expiryType: "best_before" })?.human).toBe(
      "(15)270105(10)A1",
    );
    expect(gs1LotElements({ lot: "A1" })?.human).toBe("(10)A1");
  });

  it("starts with FNC1 and decodes back", () => {
    const code = encodeGs1Lot({ lot: "FL-1", expiresOn: "2026-12-31", expiryType: "use_by" })!;
    expect(decode(code.values)).toBe("<FNC1>17261231" + "10FL-1");
    expect(code.human).toBe("(17)261231(10)FL-1");
  });

  it("refuses lot numbers GS1 can't carry", () => {
    expect(isGs1Lot("L261113001")).toBe(true);
    expect(isGs1Lot("x".repeat(21))).toBe(false);
    expect(isGs1Lot("lot #1")).toBe(false);
    expect(encodeGs1Lot({ lot: "lot #1" })).toBeNull();
  });

  it("reads what a scanner sends", () => {
    const want = { lot: "FL-1", expiry: { type: "use_by", date: "2026-12-31" } };
    expect(parseGs1("17261231" + "10FL-1")).toEqual(want);
    expect(parseGs1("]C1" + "17261231" + "10FL-1")).toEqual(want);
    expect(parseGs1("(17)261231(10)FL-1")).toEqual(want);
    expect(parseGs1("10FL-1\u001d17261231")).toEqual(want);
    expect(parseGs1("(10)FL-1")).toEqual({ lot: "FL-1" });
    expect(parseGs1("0112345678901231" + "10X")).toEqual({ gtin: "12345678901231", lot: "X" });
  });

  it("does not mistake a plain lot code for one", () => {
    for (const plain of ["FL-1", "L261113001", "B26111", "", "1", "12", "9912345"]) {
      expect(parseGs1(plain), plain).toBeNull();
    }
  });
});

describe("GS1 SSCC handling-unit labels", () => {
  it("encodes FNC1 and AI 00 with valid symbology checksum and scanner round-trip", () => {
    const sscc = "000000000000000017";
    const code = encodeGs1Sscc(sscc)!;
    expect(decode(code.values)).toBe("<FNC1>00" + sscc);
    expect(code.human).toBe("(00)" + sscc);
    expect(parseGs1("]C100" + sscc)).toEqual({ sscc });
    expect(parseGs1("(00)" + sscc)).toEqual({ sscc });
  });
  it("refuses malformed or incorrect SSCC check digits", () => {
    expect(encodeGs1Sscc("000000000000000018")).toBeNull();
    expect(encodeGs1Sscc("123")).toBeNull();
    expect(parseGs1("(00)000000000000000018")).toBeNull();
  });
});
