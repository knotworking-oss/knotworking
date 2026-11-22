import { z } from "zod";

/**
 * GTIN (EAN-13) handling for product labels: check digit validation and the bar pattern of an
 * EAN-13 symbol, so a client can draw it as SVG. The module is pure arithmetic and strings (no DOM
 * or Node APIs). The product label stores GTIN-13; a 12-digit UPC-A is accepted and stored as the
 * 13-digit number with a leading zero, which is the same product and prints as the same bars.
 * GTIN-8 and GTIN-14 (trade-unit barcodes on cases) are not used on a pack label here.
 */

/** The check digit for the digits before it (GS1: weights 3, 1, 3, … from the rightmost). */
export function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export type GtinResult = { ok: true; gtin: string } | { ok: false; error: string };

/**
 * Reads a GTIN as people type it ("5 012345 678900", "5012345-678900"): 13 digits (EAN-13) or 12
 * (UPC-A, returned with a leading zero), with a correct check digit. `gtin` is always 13 digits.
 */
export function parseGtin(text: string): GtinResult {
  const digits = text.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) return { ok: false, error: "A barcode number is digits only" };
  if (digits.length !== 13 && digits.length !== 12) {
    return { ok: false, error: `An EAN-13 has 13 digits (a UPC-A 12); this has ${digits.length}` };
  }
  const gtin = digits.padStart(13, "0");
  const expected = gtinCheckDigit(gtin.slice(0, 12));
  if (Number(gtin[12]) !== expected) {
    return { ok: false, error: `The check digit should be ${expected}, not ${gtin[12]}` };
  }
  return { ok: true, gtin };
}

/** An EAN-13 number, stored as 13 digits; a 12-digit UPC-A gets its leading zero. */
export const gtinSchema = z
  .string()
  .trim()
  .max(40)
  .transform((value, ctx) => {
    const result = parseGtin(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.error });
      return z.NEVER;
    }
    return result.gtin;
  });

/** A GTIN field in a form: empty is no barcode (`null`), anything else must be a valid GTIN. */
export const optionalGtinSchema = z
  .string()
  .trim()
  .max(40)
  .transform((value, ctx) => {
    if (!value) return null;
    const result = parseGtin(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.error });
      return z.NEVER;
    }
    return result.gtin;
  })
  .nullable();

/** Left-hand digits, odd parity (L), right-hand digits (R) and even parity (G): 7 modules each. */
const L = [
  "0001101",
  "0011001",
  "0010011",
  "0111101",
  "0100011",
  "0110001",
  "0101111",
  "0111011",
  "0110111",
  "0001011",
];
const R = L.map((code) => [...code].map((bit) => (bit === "0" ? "1" : "0")).join(""));
const G = R.map((code) => [...code].reverse().join(""));

/** Which of L or G encodes each of the six left-hand digits, from the first (leading) digit. */
const PARITY = [
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

const START = "101";
const CENTRE = "01010";
const END = "101";

/** Modules in an EAN-13 symbol (without the quiet zones). */
export const EAN13_MODULES = 95;
/** Quiet zone before and after, in modules (GS1: 11 left, 7 right). */
export const EAN13_QUIET_LEFT = 11;
export const EAN13_QUIET_RIGHT = 7;

/**
 * The 95 modules of an EAN-13 as "1" (bar) and "0" (space): start guard, six digits, centre guard,
 * six digits, end guard. The leading digit is not drawn; it chooses the parity of the left digits.
 * Throws for anything `parseGtin` refuses (13 digits, or 12 as UPC-A, with a correct check digit).
 */
export function ean13Pattern(code: string): string {
  const parsed = parseGtin(code);
  if (!parsed.ok) throw new Error(parsed.error);
  const digits = [...parsed.gtin].map(Number);
  const parity = PARITY[digits[0]!]!;
  let out = START;
  for (let i = 0; i < 6; i++) out += (parity[i] === "L" ? L : G)[digits[i + 1]!]!;
  out += CENTRE;
  for (let i = 7; i < 13; i++) out += R[digits[i]!]!;
  return out + END;
}

export interface Ean13Bar {
  /** First module of the bar, from the left edge of the symbol (without the quiet zone). */
  x: number;
  /** Width in modules. */
  width: number;
  /** Start, centre and end guard bars, drawn taller than the rest. */
  guard: boolean;
}

export interface Ean13Layout {
  gtin: string;
  /** The leading digit, printed left of the symbol. */
  first: string;
  /** The next six digits, printed under the left half. */
  left: string;
  /** The last six digits, printed under the right half. */
  right: string;
  /** Total modules wide, including both quiet zones. */
  totalModules: number;
  quietLeft: number;
  /** Bars with `x` counted from the left edge of the quiet zone. */
  bars: Ean13Bar[];
}

/**
 * Where to draw each bar of an EAN-13 and where the digits go, in modules, so any client can scale
 * it: one module is `moduleWidth` pixels (GS1's nominal module is 0.33 mm).
 */
export function ean13Layout(code: string): Ean13Layout {
  const pattern = ean13Pattern(code);
  const gtin = parseGtin(code);
  if (!gtin.ok) throw new Error(gtin.error);
  const guardAt = (i: number) => i < 3 || (i >= 45 && i < 50) || i >= 92;
  const bars: Ean13Bar[] = [];
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] !== "1") {
      i++;
      continue;
    }
    let width = 1;
    while (pattern[i + width] === "1") width++;
    // A run is a guard when it lies in a guard position (guards are 1-0-1 and 0-1-0-1-0 around the centre).
    bars.push({ x: EAN13_QUIET_LEFT + i, width, guard: guardAt(i) && guardAt(i + width - 1) });
    i += width;
  }
  return {
    gtin: gtin.gtin,
    first: gtin.gtin[0]!,
    left: gtin.gtin.slice(1, 7),
    right: gtin.gtin.slice(7),
    totalModules: EAN13_QUIET_LEFT + EAN13_MODULES + EAN13_QUIET_RIGHT,
    quietLeft: EAN13_QUIET_LEFT,
    bars,
  };
}
