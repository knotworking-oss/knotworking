import { describe, expect, it } from "vitest";
import {
  biAnalysisCreateSchema,
  biExpectedMatches,
  checkBiAnalysis,
  evaluateBiFormula,
  parseBiFormula,
  resolveBiPath,
  type BiAnalysisCreateInput,
} from "./analysis";

const order = {
  id: "po-1",
  supplier: { name: "Millers Ltd" },
  lines: [
    { item: { code: "FLR-01" }, quantity: "500.000", unitPrice: 0.62 },
    { item: { code: "SUG-02" }, quantity: 200, unitPrice: 1.1 },
  ],
};

describe("analysis paths", () => {
  it("finds a value by key, index or matching field, and lists through [*]", () => {
    expect(resolveBiPath(order, "lines[0].quantity")).toEqual({ value: 500 });
    expect(resolveBiPath(order, "lines[item.code=SUG-02].unitPrice")).toEqual({ value: 1.1 });
    expect(resolveBiPath(order, "lines[*].quantity")).toEqual({ value: [500, 200] });
    expect(resolveBiPath([{ a: 1 }, { a: 2 }], "[*].a")).toEqual({ value: [1, 2] });
  });

  it("refuses what isn't there, isn't a number, is ambiguous, or is only part of a list", () => {
    expect(resolveBiPath(order, "lines[5].quantity")).toEqual({ error: "the list has 2 entries" });
    expect(resolveBiPath(order, "supplier.name")).toEqual({ error: "not a number" });
    expect(resolveBiPath(order, "lines[item.code=NOPE].quantity")).toMatchObject({ error: /no entry/ });
    expect(resolveBiPath({ rows: [{ x: 1 }, { x: 1 }] }, "rows[x=1].x")).toMatchObject({
      error: /2 entries/,
    });
    expect(resolveBiPath({ total: 40, orders: [{ v: 1 }] }, "orders[*].v")).toMatchObject({
      error: /only part of the answer/,
    });
    expect(resolveBiPath({ truncated: true, rows: [{ v: 1 }] }, "rows[*].v")).toMatchObject({
      error: /paged/,
    });
    expect(resolveBiPath(order, "lines[0")).toMatchObject({ error: /never closed/ });
  });

  it("never counts part of a list: no .length, every nested list checked, limits and partial coverage", () => {
    expect(resolveBiPath({ orders: [1, 2], total: 150 }, "orders.length")).toMatchObject({
      error: /no 'length'/,
    });
    expect(resolveBiPath({}, "constructor")).toMatchObject({ error: /no 'constructor'/ });
    // The first inner list is a page of 9: refused, even though the last one is complete.
    expect(
      resolveBiPath(
        {
          a: [
            { b: [1, 2], total: 9 },
            { b: [3], total: 1 },
          ],
        },
        "a[*].b[*]",
      ),
    ).toMatchObject({ error: /only part/ });
    expect(
      resolveBiPath(
        {
          a: [
            { b: [1, 2], total: 2 },
            { b: [3], total: 1 },
          ],
        },
        "a[*].b[*]",
      ),
    ).toEqual({
      value: [1, 2, 3],
    });
    // A source that asked for 2 rows and got 2 may have been capped.
    expect(resolveBiPath({ rows: [{ v: 1 }, { v: 2 }] }, "rows[*].v", { limit: 2 })).toMatchObject({
      error: /limited/,
    });
    expect(resolveBiPath({ rows: [{ v: 1 }] }, "rows[*].v", { limit: 2 })).toEqual({ value: [1] });
    expect(resolveBiPath({ coverage: { status: "partial" }, items: [{ q: 1 }] }, "items[*].q")).toMatchObject(
      { error: /only part/ },
    );
  });

  it("handles very long lists without overflowing the stack", () => {
    const rows = Array.from({ length: 300_000 }, (_, i) => ({ v: i % 7 }));
    const found = resolveBiPath({ rows }, "rows[*].v");
    expect("value" in found && Array.isArray(found.value) && found.value.length).toBe(300_000);
    const tree = parseBiFormula("max(q) + min(q) + sum(q)");
    if (typeof tree === "string") throw new Error(tree);
    expect(evaluateBiFormula(tree, { q: (found as { value: number[] }).value })).toMatchObject({
      value: expect.any(Number),
    });
  });
});

describe("analysis formulas", () => {
  const run = (formula: string, values: Record<string, number | number[]>) => {
    const tree = parseBiFormula(formula);
    if (typeof tree === "string") return { parseError: tree };
    return evaluateBiFormula(tree, values);
  };

  it("does arithmetic with precedence, functions and lists", () => {
    expect(
      run("(onHand + incoming - po) / weekly", { onHand: 800, incoming: 700, po: 500, weekly: 250 }),
    ).toEqual({
      value: 4,
    });
    expect(run("sum(q) * 2 - -1", { q: [1, 2, 3] })).toEqual({ value: 13 });
    expect(run("round(a / 3, 2)", { a: 10 })).toEqual({ value: 3.33 });
    expect(run("max(a, b, 7)", { a: 3, b: 9 })).toEqual({ value: 9 });
    expect(run("count(q)", { q: [4, 5] })).toEqual({ value: 2 });
    expect(run("a / 0", { a: 1 })).toEqual({ value: null });
    expect(run("round(2.5) + round(-2.5)", {})).toEqual({ value: 0 });
    expect(run("round(-2.5)", {})).toEqual({ value: -3 });
    expect(run("round(1.005, 2)", {})).toEqual({ value: 1.01 });
    expect(run(".5 + +3", {})).toEqual({ value: 3.5 });
  });

  it("refuses lists outside an aggregate, unknown functions and broken syntax", () => {
    expect(run("q + 1", { q: [1, 2] })).toMatchObject({ error: /inside sum/ });
    expect(run("avg(q)", { q: [1] })).toMatchObject({ parseError: /unknown function/ });
    expect(run("(a + 1", { a: 1 })).toMatchObject({ parseError: /never closed/ });
    expect(run("a b", { a: 1, b: 2 })).toMatchObject({ parseError: /unexpected/ });
  });

  it("matches an expected figure within half a percent", () => {
    expect(biExpectedMatches(100, 100.4)).toBe(true);
    expect(biExpectedMatches(100, 101)).toBe(false);
    expect(biExpectedMatches(null, null)).toBe(true);
  });
});

describe("analysis structure", () => {
  const base = (): BiAnalysisCreateInput => ({
    title: "Cancel PO-2026-014",
    question: "What if we dropped the Millers order?",
    scenarios: [
      { id: "now", label: "As things stand", assumptions: "Every open order arrives as promised." },
      {
        id: "cancel",
        label: "Cancel PO-2026-014",
        assumptions: "PO-2026-014 is cancelled and not replaced.",
      },
    ],
    sources: [{ id: "po", path: "/purchasing/orders/0190a000-0000-7000-8000-000000000001" }],
    figures: [
      {
        id: "flour",
        label: "Flour arriving",
        unit: "g",
        values: {
          now: { formula: "q", inputs: { q: { source: "po", path: "lines[0].quantity" } } },
          cancel: { formula: "0" },
        },
      },
    ],
  });

  it("refuses a figure made only of typed-in numbers, and paths with dot segments", () => {
    const literal = base();
    literal.figures[0]!.values = { now: { formula: "12400" }, cancel: { formula: "0" } };
    expect(checkBiAnalysis(biAnalysisCreateSchema.parse(literal)).map((i) => i.path)).toEqual([
      "figures[0].values",
    ]);
    for (const path of ["/tasks/x/./time-entries", "/hse/./incidents", "/./stock", "/a/../b", "/stock/."]) {
      expect(
        biAnalysisCreateSchema.safeParse({ ...base(), sources: [{ id: "po", path }] }).success,
        path,
      ).toBe(false);
    }
    expect(
      biAnalysisCreateSchema.safeParse({ ...base(), sources: [{ id: "po", path: "/stock/levels.v2" }] })
        .success,
    ).toBe(true);
  });

  it("accepts a well-formed analysis", () => {
    expect(checkBiAnalysis(biAnalysisCreateSchema.parse(base()))).toEqual([]);
  });

  it("names every structural problem with its path", () => {
    const bad = base();
    bad.figures[0]!.values = {
      now: {
        formula: "q + extra",
        inputs: { q: { source: "nope", path: "lines[0].quantity" }, unused: { source: "po", path: "x" } },
      },
    };
    expect(checkBiAnalysis(biAnalysisCreateSchema.parse(bad)).map((i) => i.path)).toEqual([
      "figures[0].values",
      "figures[0].values.now.formula",
      "figures[0].values.now.inputs.q.source",
      "figures[0].values.now.inputs.unused",
    ]);
  });
});
