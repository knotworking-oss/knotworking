import { describe, expect, it } from "vitest";
import {
  EAN13_MODULES,
  ean13Layout,
  ean13Pattern,
  gtinCheckDigit,
  gtinSchema,
  optionalGtinSchema,
  parseGtin,
} from "./barcode";

// Real, published numbers: GS1's own example 5901234123457, and 4006381333931 (a Stabilo pen).
const VALID = ["5901234123457", "4006381333931", "5000169005743"];

describe("GTIN check digit", () => {
  it("computes the GS1 check digit", () => {
    expect(gtinCheckDigit("590123412345")).toBe(7);
    expect(gtinCheckDigit("400638133393")).toBe(1);
    expect(gtinCheckDigit("500016900574")).toBe(3);
    // GTIN-12 (UPC-A): 03600029145 → 2
    expect(gtinCheckDigit("03600029145")).toBe(2);
  });

  it("accepts valid numbers, with spaces and hyphens", () => {
    for (const gtin of VALID) expect(parseGtin(gtin)).toEqual({ ok: true, gtin });
    expect(parseGtin("5 901234 123457")).toEqual({ ok: true, gtin: "5901234123457" });
    expect(parseGtin("5901234-123457")).toEqual({ ok: true, gtin: "5901234123457" });
  });

  it("stores a UPC-A as the 13-digit number with a leading zero", () => {
    expect(parseGtin("036000291452")).toEqual({ ok: true, gtin: "0036000291452" });
  });

  it("refuses a wrong check digit, the wrong length and letters", () => {
    expect(parseGtin("5901234123456")).toEqual({ ok: false, error: "The check digit should be 7, not 6" });
    expect(parseGtin("590123412345")).toMatchObject({ ok: false });
    expect(parseGtin("59012341234")).toMatchObject({ ok: false, error: expect.stringContaining("11") });
    expect(parseGtin("5901234ABC457")).toMatchObject({ ok: false });
    expect(parseGtin("")).toMatchObject({ ok: false });
  });

  it("has form schemas", () => {
    expect(gtinSchema.parse(" 5901234123457 ")).toBe("5901234123457");
    expect(gtinSchema.safeParse("5901234123450").success).toBe(false);
    expect(optionalGtinSchema.parse("")).toBeNull();
    expect(optionalGtinSchema.parse(null)).toBeNull();
    expect(optionalGtinSchema.parse("5 901234 123457")).toBe("5901234123457");
    expect(optionalGtinSchema.safeParse("123").success).toBe(false);
  });
});

/** Reads the digits back from a pattern, with the tables written out independently of the code. */
function decode(pattern: string): string {
  const L: Record<string, number> = {
    "0001101": 0,
    "0011001": 1,
    "0010011": 2,
    "0111101": 3,
    "0100011": 4,
    "0110001": 5,
    "0101111": 6,
    "0111011": 7,
    "0110111": 8,
    "0001011": 9,
  };
  const G: Record<string, number> = {
    "0100111": 0,
    "0110011": 1,
    "0011011": 2,
    "0100001": 3,
    "0011101": 4,
    "0111001": 5,
    "0000101": 6,
    "0010001": 7,
    "0001001": 8,
    "0010111": 9,
  };
  const R: Record<string, number> = {
    "1110010": 0,
    "1100110": 1,
    "1101100": 2,
    "1000010": 3,
    "1011100": 4,
    "1001110": 5,
    "1010000": 6,
    "1000100": 7,
    "1001000": 8,
    "1110100": 9,
  };
  const parity = [
    "LLLLLL",
    "LLGLGG",
    "LLGGLG",
    "LLGGGL",
    "LGLLGG",
    "LGGLLG",
    "LGGGLL",
    "LGLGLG",
    "LGLGGL",
    "LGGLGL",
  ];
  const left = pattern.slice(3, 45);
  const right = pattern.slice(50, 92);
  let kinds = "";
  let digits = "";
  for (let i = 0; i < 6; i++) {
    const code = left.slice(i * 7, i * 7 + 7);
    if (code in L) {
      kinds += "L";
      digits += L[code];
    } else {
      kinds += "G";
      digits += G[code];
    }
  }
  const first = parity.indexOf(kinds);
  for (let i = 0; i < 6; i++) digits += R[right.slice(i * 7, i * 7 + 7)];
  return `${first}${digits}`;
}

describe("EAN-13 bars", () => {
  it("is 95 modules: start guard, 6 digits, centre guard, 6 digits, end guard", () => {
    for (const gtin of VALID) {
      const p = ean13Pattern(gtin);
      expect(p).toHaveLength(EAN13_MODULES);
      expect(p.slice(0, 3)).toBe("101");
      expect(p.slice(45, 50)).toBe("01010");
      expect(p.slice(92)).toBe("101");
      expect(decode(p)).toBe(gtin);
    }
  });

  it("encodes a known number exactly", () => {
    // 4006381333931: leading 4 → parity LGLLGG; digits 0 0 6 3 8 1 left, 3 3 3 9 3 1 right.
    expect(ean13Pattern("4006381333931")).toBe(
      "101" +
        "0001101" + // 0 (L)
        "0100111" + // 0 (G)
        "0101111" + // 6 (L)
        "0111101" + // 3 (L)
        "0001001" + // 8 (G)
        "0110011" + // 1 (G)
        "01010" +
        "1000010" +
        "1000010" +
        "1000010" +
        "1110100" +
        "1000010" +
        "1100110" +
        "101",
    );
  });

  it("draws a UPC-A as the EAN-13 with a leading zero", () => {
    expect(ean13Pattern("036000291452")).toBe(ean13Pattern("0036000291452"));
  });

  it("refuses an invalid number", () => {
    expect(() => ean13Pattern("5901234123450")).toThrow(/check digit/);
    expect(() => ean13Pattern("123")).toThrow();
  });

  it("lays out the bars, with taller guards, and splits the digits for printing", () => {
    const layout = ean13Layout("5901234123457");
    expect(layout).toMatchObject({ first: "5", left: "901234", right: "123457", quietLeft: 11 });
    expect(layout.totalModules).toBe(11 + 95 + 7);
    // Start guard, centre guard (two bars) and end guard (two bars) are the guard bars.
    expect(layout.bars.filter((b) => b.guard).map((b) => b.x - 11)).toEqual([0, 2, 46, 48, 92, 94]);
    // Every bar sits on a "1" of the pattern and the bars cover exactly the "1" modules.
    const pattern = ean13Pattern("5901234123457");
    let covered = "";
    for (let i = 0; i < pattern.length; i++) {
      covered += layout.bars.some((b) => i >= b.x - 11 && i < b.x - 11 + b.width) ? "1" : "0";
    }
    expect(covered).toBe(pattern);
  });
});
