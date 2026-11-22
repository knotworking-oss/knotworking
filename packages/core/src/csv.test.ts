import { describe, expect, it } from "vitest";
import { csvCell, detectCsvSeparator, neutralizeFormula, parseCsv, toCsv } from "./csv";

describe("csv", () => {
  it("writes plain values as they are and empty values as nothing", () => {
    expect(csvCell("hello world")).toBe("hello world");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(1.5)).toBe("1.5");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell("")).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
  });

  it("quotes commas, quotes and line breaks, doubling quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("one\ntwo")).toBe('"one\ntwo"');
    expect(csvCell("one\r\ntwo")).toBe('"one\r\ntwo"');
  });

  it("neutralises anything a spreadsheet would read as a formula", () => {
    for (const bad of [
      "=1+1",
      "+1",
      "-1",
      "@SUM(A1)",
      "\tcmd",
      "\rcmd",
      "  =1+1",
      '=HYPERLINK("http://x")',
    ]) {
      expect(neutralizeFormula(bad), JSON.stringify(bad)).toBe(`'${bad}`);
    }
    expect(csvCell("=1+1")).toBe("'=1+1");
    // Quoting still applies on top, and the quote prefix goes inside the quotes.
    expect(csvCell('=A1,"x"')).toBe(`"'=A1,""x"""`);
    expect(csvCell("\r\nfoo")).toBe(`"'\r\nfoo"`); // a leading CR is neutralised too
  });

  it("leaves text that merely contains those characters alone", () => {
    for (const fine of ["a=b", "1+1", "x-y", "me@home", "2026-11-02", "'quoted'", "#tag"]) {
      expect(neutralizeFormula(fine), fine).toBe(fine);
    }
  });

  it("never prefixes numbers, even negative ones", () => {
    expect(csvCell(-5)).toBe("-5");
  });

  it("joins rows with CRLF and ends with one", () => {
    expect(
      toCsv([
        ["a", "b"],
        [1, "x,y"],
      ]),
    ).toBe('a,b\r\n1,"x,y"\r\n');
  });
});

describe("parseCsv", () => {
  it("reads fields and records, with CRLF, LF or CR line ends", () => {
    expect(parseCsv("a,b\r\n1,2\n3,4\r5,6")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ]);
    expect(parseCsv("a,b\r\n")).toEqual([["a", "b"]]);
    expect(parseCsv("")).toEqual([]);
  });

  it("handles quoted separators, line breaks and doubled quotes", () => {
    expect(parseCsv('name,note\r\n"Smith, J","said ""hi""\nthen left"\r\n')).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
    ]);
  });

  it("keeps empty fields and blank lines in place, and drops a byte-order mark", () => {
    expect(parseCsv("\uFEFFa,,c\n\n,x,")).toEqual([["a", "", "c"], [""], ["", "x", ""]]);
  });

  it("reads back what toCsv writes", () => {
    const rows = [
      ["code", "note"],
      ["A,1", 'with "quotes"'],
      ["B", "two\nlines"],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it("detects semicolon and tab separated files", () => {
    expect(detectCsvSeparator("item;period;quantity\nA;1;2")).toBe(";");
    expect(detectCsvSeparator("item\tperiod")).toBe("\t");
    expect(detectCsvSeparator('"a;b",c')).toBe(",");
    expect(parseCsv("item;qty\nA;1,5")).toEqual([
      ["item", "qty"],
      ["A", "1,5"],
    ]);
  });
});
