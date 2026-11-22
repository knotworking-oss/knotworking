import { validSscc } from "./distribution";
/**
 * Code 128 and GS1-128 barcodes for stock lot labels, as plain data the web app draws in SVG. No
 * dependency: the symbology is a table of 107 patterns and a checksum. No DOM or Node APIs.
 *
 * - **Code 128**: ASCII 32..126 (subset B), with runs of digits packed in subset C where that
 *   makes the symbol shorter. The lot code is printed as it is, so a keyboard-wedge scanner types
 *   it into the consumption form's scan field.
 * - **GS1-128**: the same symbology with FNC1 first and Application Identifiers: (15) best before or
 *   (17) use by as YYMMDD, then (10) the lot number last (it has no fixed length, so nothing needs a
 *   separator after it). There is no GTIN: items have none yet, and a lot label for internal use does
 *   not need one. `parseGs1` reads what a scanner sends back (with or without the `]C1` prefix, group
 *   separators or the printed brackets), so the scan field finds the lot either way.
 */

/** Bar and space widths, alternating from a bar, of symbol values 0..106 (106 is the stop). */
const PATTERNS = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
  "2331112",
] as const;

const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;
const FNC1 = 102;
const STOP = 106;

/** The widest quiet zone a symbol needs on each side, in modules. */
export const BARCODE_QUIET_MODULES = 10;

/** One symbol: the module widths from the first bar (bar, space, bar …) and their total. */
export interface Barcode128 {
  /** Alternating bar and space widths in modules, starting with a bar. */
  widths: number[];
  /** Total width in modules, without the quiet zones. */
  modules: number;
  /** The symbol values, start and checksum included (for tests and debugging). */
  values: number[];
}

type Token = string | typeof FNC1_TOKEN;
const FNC1_TOKEN = Symbol("FNC1");
const isDigit = (t: Token) => typeof t === "string" && t >= "0" && t <= "9";

/** Whether every character can be drawn (printable ASCII). */
export const isCode128Text = (text: string): boolean => text.length > 0 && /^[\x20-\x7e]+$/.test(text);

function symbolValues(tokens: readonly Token[]): number[] {
  const out: number[] = [];
  let mode: "B" | "C" | null = null;
  let i = 0;
  const toB = () => {
    if (mode === "B") return;
    out.push(mode === null ? START_B : CODE_B);
    mode = "B";
  };
  while (i < tokens.length) {
    let run = 0;
    while (i + run < tokens.length && isDigit(tokens[i + run]!)) run++;
    const atEnd = i + run === tokens.length;
    // Pairs of digits in subset C are worth a switch for six or more, or four at either end.
    if (run >= 6 || (run >= 4 && (i === 0 || atEnd))) {
      let n = run;
      if (n % 2 === 1) {
        toB();
        out.push((tokens[i] as string).charCodeAt(0) - 32);
        i++;
        n--;
      }
      if (mode !== "C") {
        out.push(mode === null ? START_C : CODE_C);
        mode = "C";
      }
      for (let k = 0; k < n; k += 2)
        out.push(Number((tokens[i + k] as string) + (tokens[i + k + 1] as string)));
      i += n;
      continue;
    }
    toB();
    const t = tokens[i]!;
    out.push(t === FNC1_TOKEN ? FNC1 : (t as string).charCodeAt(0) - 32);
    i++;
  }
  return out;
}

function symbol(tokens: readonly Token[]): Barcode128 {
  const values = symbolValues(tokens);
  const sum = values.reduce((t, v, i) => t + (i === 0 ? v : v * i), 0);
  values.push(sum % 103, STOP);
  const widths = values.flatMap((v) => [...PATTERNS[v]!].map(Number));
  return { widths, modules: widths.reduce((t, w) => t + w, 0), values };
}

/** Code 128 for printable ASCII text (throws on anything else: check with `isCode128Text`). */
export function encodeCode128(text: string): Barcode128 {
  if (!isCode128Text(text)) throw new Error("Code 128 here takes printable ASCII text");
  return symbol([...text]);
}

// ─── GS1-128 ─────────────────────────────────────────────────────────────────

/** Characters GS1 allows in a lot number (AI 10): digits, letters and `!"%&'()*+,-./:;<=>?_`. */
const GS1_LOT = /^[0-9A-Za-z!"%&'()*+,\-./:;<=>?_]{1,20}$/;

export const isGs1Lot = (lot: string): boolean => GS1_LOT.test(lot);

export interface Gs1LotInput {
  lot: string;
  /** `YYYY-MM-DD`; with `expiryType` it becomes AI 17 (use by) or AI 15 (best before). */
  expiresOn?: string | null;
  expiryType?: "use_by" | "best_before" | null;
}

/** `YYMMDD` of an ISO date, or `null`. */
const yymmdd = (iso: string): string | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[1]!.slice(2)}${m[2]}${m[3]}` : null;
};

/** The element string of a lot label: the AIs in order, with and without brackets. */
export function gs1LotElements(input: Gs1LotInput): { data: string; human: string } | null {
  if (!isGs1Lot(input.lot)) return null;
  const date = input.expiresOn ? yymmdd(input.expiresOn) : null;
  const ai = input.expiryType === "best_before" ? "15" : "17";
  const parts: [string, string][] = [];
  if (date) parts.push([ai, date]);
  parts.push(["10", input.lot]);
  return {
    data: parts.map(([a, v]) => a + v).join(""),
    human: parts.map(([a, v]) => `(${a})${v}`).join(""),
  };
}

/** GS1-128 for a lot (and its expiry): `null` when the lot code is not GS1-safe (use Code 128 then). */
export function encodeGs1Lot(input: Gs1LotInput): (Barcode128 & { human: string }) | null {
  const elements = gs1LotElements(input);
  if (!elements) return null;
  return { ...symbol([FNC1_TOKEN, ...elements.data]), human: elements.human };
}

/** GS1-128 SSCC (AI 00), with FNC1, never an ordinary Code 128 lookalike. */
export function encodeGs1Sscc(sscc: string): (Barcode128 & { human: string }) | null {
  if (!validSscc(sscc)) return null;
  return { ...symbol([FNC1_TOKEN, ...("00" + sscc)]), human: `(00)${sscc}` };
}

const GS1_FIXED: Record<string, number> = {
  "00": 18,
  "01": 14,
  "02": 14,
  "11": 6,
  "12": 6,
  "13": 6,
  "15": 6,
  "16": 6,
  "17": 6,
  "20": 2,
};
const GS1_VARIABLE: Record<string, number> = { "10": 20, "21": 20, "30": 8, "37": 8 };

export interface Gs1Data {
  sscc?: string;
  gtin?: string;
  lot?: string;
  /** AI 17 (use by) or AI 15 (best before), as an ISO date; the century is assumed to be 20xx. */
  expiry?: { type: "use_by" | "best_before"; date: string };
}

/**
 * Reads a scanned GS1 element string: with or without the `]C1` symbology prefix, group separators
 * (ASCII 29) between variable fields, or the human-readable brackets (`(17)261231(10)LOT`). `null`
 * when it is not one (an AI it does not know, a field too short, a stray character), so a plain lot
 * code is never mistaken for one.
 */
export function parseGs1(raw: string): Gs1Data | null {
  let text = raw.trim();
  if (text.startsWith("]C1")) text = text.slice(3);
  if (!text) return null;
  const out: Gs1Data = {};
  const GS = "\u001d";
  if (text.startsWith("(")) {
    // Bracketed: (AI)value(AI)value
    const re = /\((\d{2,4})\)([^(]*)/gy;
    let m: RegExpExecArray | null;
    let used = 0;
    while ((m = re.exec(text))) {
      used = re.lastIndex;
      if (!assign(out, m[1]!, m[2]!.replaceAll(GS, ""))) return null;
    }
    return used === text.length && used > 0 ? out : null;
  }
  let i = 0;
  while (i < text.length) {
    if (text[i] === GS) {
      i++;
      continue;
    }
    const ai = text.slice(i, i + 2);
    i += 2;
    const fixed = GS1_FIXED[ai];
    if (fixed !== undefined) {
      const value = text.slice(i, i + fixed);
      if (value.length !== fixed || !/^\d+$/.test(value)) return null;
      i += fixed;
      if (!assign(out, ai, value)) return null;
      continue;
    }
    const max = GS1_VARIABLE[ai];
    if (max === undefined) return null;
    let end = text.indexOf(GS, i);
    if (end === -1) end = text.length;
    const value = text.slice(i, end);
    if (value.length < 1 || value.length > max) return null;
    i = end;
    if (!assign(out, ai, value)) return null;
  }
  return out;
}

function assign(out: Gs1Data, ai: string, value: string): boolean {
  if (ai === "00") {
    if (!validSscc(value)) return false;
    out.sscc = value;
  } else if (ai === "10") out.lot = value;
  else if (ai === "01") out.gtin = value;
  else if (ai === "17" || ai === "15") {
    const date = `20${value.slice(0, 2)}-${value.slice(2, 4)}-${value.slice(4, 6)}`;
    out.expiry = { type: ai === "17" ? "use_by" : "best_before", date };
  }
  return true;
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

/**
 * The bars of a symbol as rectangles in module units (x, width), for drawing in SVG with a quiet zone
 * on each side. `viewBoxWidth` includes the quiet zones.
 */
export function barcodeBars(code: Pick<Barcode128, "widths" | "modules">): {
  bars: { x: number; width: number }[];
  viewBoxWidth: number;
} {
  const bars: { x: number; width: number }[] = [];
  let x = BARCODE_QUIET_MODULES;
  code.widths.forEach((w, i) => {
    if (i % 2 === 0) bars.push({ x, width: w });
    x += w;
  });
  return { bars, viewBoxWidth: code.modules + 2 * BARCODE_QUIET_MODULES };
}

export const lotBarcodeFormats = ["code128", "gs1-128"] as const;
export type LotBarcodeFormat = (typeof lotBarcodeFormats)[number];
