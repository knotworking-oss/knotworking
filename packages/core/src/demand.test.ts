import { describe, expect, it } from "vitest";
import {
  buildDemandSummary,
  demandAction,
  demandEntriesFromInput,
  demandKey,
  demandLinesSetSchema,
  demandRange,
  demandSummaryQuerySchema,
  formatWeek,
  isoWeekOf,
  normalizeCustomer,
  parseDemandCsv,
  parsePeriod,
  parseQuantityText,
  parseUnitText,
  resolveDemandEntries,
  weekStart,
  weekStartOf,
  weeksInRange,
  type DemandItem,
  type DemandItemSummary,
} from "./demand";

describe("ISO weeks", () => {
  it("finds the Monday of a date's week", () => {
    expect(weekStart("2026-11-09")).toBe("2026-11-09"); // Monday
    expect(weekStart("2026-11-11")).toBe("2026-11-09"); // Wednesday
    expect(weekStart("2026-11-15")).toBe("2026-11-09"); // Sunday
    expect(weekStart("2027-01-01")).toBe("2026-12-28"); // across the year end
  });

  it("numbers weeks the ISO way (the year of the week's Thursday)", () => {
    expect(isoWeekOf("2026-11-11")).toEqual({ year: 2026, week: 46 });
    expect(formatWeek("2026-11-09")).toBe("2026-W46");
    expect(formatWeek("2026-01-01")).toBe("2026-W01");
    expect(formatWeek("2025-12-29")).toBe("2026-W01");
    expect(formatWeek("2027-01-01")).toBe("2026-W53");
    expect(formatWeek("2024-12-30")).toBe("2025-W01");
  });

  it("turns a year and week back into a Monday, only for weeks the year has", () => {
    expect(weekStartOf(2026, 46)).toBe("2026-11-09");
    expect(weekStartOf(2026, 1)).toBe("2025-12-29");
    expect(weekStartOf(2026, 53)).toBe("2026-12-28");
    expect(weekStartOf(2025, 53)).toBeNull();
    expect(weekStartOf(2026, 0)).toBeNull();
  });

  it("reads ISO dates, UK dates and ISO weeks as the Monday of their week", () => {
    expect(parsePeriod("2026-11-12")).toBe("2026-11-09");
    expect(parsePeriod("12/11/2026")).toBe("2026-11-09"); // day first
    expect(parsePeriod("9/11/2026")).toBe("2026-11-09");
    expect(parsePeriod("2026-W46")).toBe("2026-11-09");
    expect(parsePeriod(" 2026w46 ")).toBe("2026-11-09");
    expect(parsePeriod("2026-W46-5")).toBe("2026-11-09");
    for (const bad of ["2026-02-30", "31/02/2026", "13/13/2026", "2026-W54", "next week", "", "11/2026"]) {
      expect(parsePeriod(bad), bad).toBeNull();
    }
  });

  it("lists the weeks of a range and defaults to twelve weeks from this one", () => {
    expect(weeksInRange("2026-11-11", "2026-11-23")).toEqual(["2026-11-09", "2026-11-16", "2026-11-23"]);
    expect(demandRange({}, "2026-11-11")).toEqual({ from: "2026-11-09", to: "2027-01-25" });
    expect(demandRange({ from: "2026-11-16", to: "2026-11-16" }, "2026-11-11")).toEqual({
      from: "2026-11-16",
      to: "2026-11-16",
    });
    expect(demandRange({ from: "2026-11-16", to: "2026-11-09" }, "2026-11-11")).toBeNull();
    expect(demandRange({ from: "2026-01-05", to: "2028-01-03" }, "2026-11-11")).toBeNull(); // 105 weeks
    expect(demandRange({ from: "2026-01-05", to: "2027-12-27" }, "2026-11-11")).not.toBeNull(); // 104
  });
});

describe("validation", () => {
  it("normalises periods and customers, and needs an item id or code", () => {
    const parsed = demandLinesSetSchema.parse({
      lines: [{ itemCode: "CAKE", period: "2026-W46", quantity: 12, customer: "  Tesco   Express " }],
    });
    expect(demandEntriesFromInput(parsed)).toEqual([
      {
        row: 1,
        itemId: undefined,
        itemCode: "CAKE",
        periodStart: "2026-11-09",
        quantity: 12,
        unit: null,
        customer: "Tesco Express",
        note: undefined,
        externalRef: undefined,
      },
    ]);
    expect(demandLinesSetSchema.safeParse({ lines: [{ period: "2026-W46", quantity: 1 }] }).success).toBe(
      false,
    );
    const both = {
      itemCode: "A",
      itemId: "0190a0b0-0000-7000-8000-000000000000",
      period: "2026-W46",
      quantity: 1,
    };
    expect(demandLinesSetSchema.safeParse({ lines: [both] }).success).toBe(false);
    const bad = demandLinesSetSchema.safeParse({ lines: [{ itemCode: "A", period: "soon", quantity: 1 }] });
    expect(bad.error?.issues[0]?.message).toMatch(/not a date or week/);
    expect(
      demandLinesSetSchema.safeParse({ lines: [{ itemCode: "A", period: "2026-W46", quantity: -1 }] })
        .success,
    ).toBe(false);
  });

  it("refuses a summary range that ends before it starts", () => {
    expect(demandSummaryQuerySchema.safeParse({ from: "2026-W47", to: "2026-W46" }).success).toBe(false);
    expect(demandSummaryQuerySchema.parse({ from: "2026-W46", byCustomer: "true" })).toEqual({
      from: "2026-11-09",
      byCustomer: true,
    });
  });

  it("compares customers without case or extra spaces", () => {
    expect(normalizeCustomer("   ")).toBeNull();
    expect(demandKey("i", "2026-11-09", "TESCO")).toBe(demandKey("i", "2026-11-09", " tesco "));
    expect(demandKey("i", "2026-11-09", null)).toBe(demandKey("i", "2026-11-09", ""));
  });
});

describe("parseDemandCsv", () => {
  it("reads rows by header name in any order, skipping blank rows and unknown columns", () => {
    const csv = [
      "Week commencing,Product code,Description,Qty,UOM,Customer,Notes",
      '09/11/2026,CAKE-1,Lemon cake,"1,200",each,Tesco,promo week',
      "",
      "2026-W47,cake-1,Lemon cake,40.5,kg,,",
    ].join("\r\n");
    const result = parseDemandCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.rowCount).toBe(2);
    expect(result.ignoredColumns).toEqual(["Description"]);
    expect(result.entries).toEqual([
      {
        row: 2,
        itemCode: "CAKE-1",
        periodStart: "2026-11-09",
        quantity: 1200,
        unit: "each",
        customer: "Tesco",
        note: "promo week",
      },
      {
        row: 4,
        itemCode: "cake-1",
        periodStart: "2026-11-16",
        quantity: 40.5,
        unit: "kg",
        customer: null,
        note: null,
      },
    ]);
  });

  it("reports every bad cell with its row and column, and keeps the good rows", () => {
    const csv =
      "item,period,quantity,unit\nA,2026-W46,10,\n,someday,-3,tonnes\nB,2026-02-30,,kg\nC,2026-W46,abc,";
    const { entries, errors } = parseDemandCsv(csv);
    expect(entries.map((e) => e.row)).toEqual([2]);
    expect(errors).toEqual([
      { row: 3, column: "item", message: "The item code is missing" },
      { row: 3, column: "period", message: expect.stringMatching(/"someday" is not a date or week/) },
      { row: 3, column: "quantity", message: '"-3" is not a quantity of 0 or more' },
      { row: 4, column: "period", message: expect.stringMatching(/2026-02-30/) },
      { row: 4, column: "quantity", message: "The quantity is missing (use 0 for no demand)" },
      { row: 5, column: "quantity", message: '"abc" is not a quantity of 0 or more' },
    ]);
  });

  it("names the missing columns, and refuses empty files", () => {
    const { errors } = parseDemandCsv("sku,amount\nA,1");
    expect(errors.map((e) => e.column)).toEqual(["period"]);
    expect(parseDemandCsv("").errors[0]?.message).toBe("The file is empty");
    expect(parseDemandCsv("item,period,quantity\n\n").errors[0]?.message).toMatch(/no rows/);
  });

  it("reads semicolon-separated files", () => {
    const { entries } = parseDemandCsv("item;period;quantity\nA;2026-11-09;3");
    expect(entries[0]).toMatchObject({ itemCode: "A", quantity: 3 });
  });

  it("parses quantities and units as people write them", () => {
    expect(parseQuantityText("1,234.5")).toBe(1234.5);
    expect(parseQuantityText(" 7 ")).toBe(7);
    expect(parseQuantityText(".5")).toBe(0.5);
    expect(parseQuantityText("1.200,5")).toBeNull();
    expect(parseQuantityText("12,34")).toBeNull();
    expect(parseQuantityText("1e3")).toBeNull();
    expect(parseUnitText("Kgs")).toBe("kg");
    expect(parseUnitText("litres")).toBe("l");
    expect(parseUnitText("ea")).toBe("each");
    expect(parseUnitText("tonnes")).toBeNull();
  });
});

describe("resolveDemandEntries", () => {
  const item = (fields: Partial<DemandItem>): DemandItem => ({
    id: fields.code!.toLowerCase(),
    code: "",
    name: fields.code!,
    type: "finished",
    unit: "each",
    status: "active",
    ...fields,
  });
  const items = [
    item({ code: "CAKE", unitWeightG: 450 }),
    item({ code: "DOUGH", type: "wip", unit: "kg" }),
    item({ code: "FLOUR", type: "ingredient", unit: "kg" }),
    item({ code: "OLD", status: "archived" }),
  ];
  const find = ({ itemId, itemCode }: { itemId?: string | undefined; itemCode?: string | undefined }) =>
    items.find((i) => i.id === itemId || i.code.toLowerCase() === itemCode?.toLowerCase());
  const entry = (row: number, itemCode: string, quantity: number | null, extra: object = {}) => ({
    row,
    itemCode,
    periodStart: "2026-11-09",
    quantity,
    unit: null,
    customer: null,
    ...extra,
  });

  it("converts to the base unit and checks item, type, status, unit and duplicates", () => {
    const { resolved, errors } = resolveDemandEntries(
      [
        entry(1, "cake", 10),
        entry(2, "CAKE", 9, { customer: "Tesco" }),
        entry(3, "DOUGH", 1.5),
        entry(4, "dough", 2, { unit: "g" }),
        entry(5, "CAKE", 0.9, { unit: "kg", customer: "Asda" }),
        entry(6, "DOUGH", 3, { unit: "each", periodStart: "2026-11-16" }),
        entry(7, "FLOUR", 1),
        entry(8, "OLD", 1),
        entry(9, "NOPE", 1),
        entry(10, "OLD", null),
        entry(11, "CAKE", 5, { customer: "TESCO" }),
      ],
      find,
    );
    expect(resolved.map((r) => [r.row, r.item.code, r.quantity, r.customer])).toEqual([
      [1, "CAKE", 10, null],
      [2, "CAKE", 9, "Tesco"],
      [3, "DOUGH", 1500, null],
      [5, "CAKE", 2, "Asda"], // 900 g at 450 g each
      [10, "OLD", null, null], // removing a line only needs the item to exist
    ]);
    expect(errors.map((e) => [e.row, e.column, e.message])).toEqual([
      [4, "item", expect.stringMatching(/Same item, week and customer as row 3 \(DOUGH, 2026-W46\)/)],
      [6, "unit", expect.stringMatching(/DOUGH is measured in kg; each can't be converted/)],
      [7, "item", expect.stringMatching(/FLOUR is not a finished good or work in progress/)],
      [8, "item", expect.stringMatching(/OLD is archived/)],
      [9, "item", 'No item has the code "NOPE"'],
      [11, "item", expect.stringMatching(/as row 2 \(CAKE, 2026-W46, TESCO\)/)],
    ]);
  });

  it("enters quantities in an item's pack units and keeps what was typed", () => {
    const withPacks: DemandItem[] = [
      item({
        code: "BAR",
        packUnits: [
          { name: "Case", size: 12 },
          { name: "pallet", size: 600 },
        ],
      }),
    ];
    const lookup = ({ itemCode }: { itemId?: string | undefined; itemCode?: string | undefined }) =>
      withPacks.find((i) => i.code === itemCode);
    const { resolved, errors } = resolveDemandEntries(
      [
        entry(1, "BAR", 5, { unit: "case" }),
        entry(2, "BAR", 2, { unit: "PALLET", customer: "Tesco" }),
        entry(3, "BAR", 7, { customer: "Asda" }),
        entry(4, "BAR", 1, { unit: "tray", customer: "Co-op" }),
      ],
      lookup,
    );
    expect(resolved.map((r) => [r.row, r.quantity, r.entered])).toEqual([
      [1, 60, { quantity: 5, unit: "Case" }],
      [2, 1200, { quantity: 2, unit: "pallet" }],
      [3, 7, null],
    ]);
    expect(errors).toEqual([
      {
        row: 4,
        column: "unit",
        message: expect.stringMatching(/"tray" is not a unit or a pack unit of BAR/),
      },
    ]);
  });

  it("says what applying an entry does", () => {
    const current = { quantity: 10, note: "x", externalRef: null };
    expect(demandAction({ quantity: 10 }, undefined)).toBe("create");
    expect(demandAction({ quantity: 10 }, current)).toBe("unchanged");
    expect(demandAction({ quantity: 10, note: "x" }, current)).toBe("unchanged");
    expect(demandAction({ quantity: 10, note: null }, current)).toBe("update");
    expect(demandAction({ quantity: 11 }, current)).toBe("update");
    expect(demandAction({ quantity: null }, current)).toBe("remove");
    expect(demandAction({ quantity: null }, undefined)).toBe("unchanged");
  });
});

describe("buildDemandSummary", () => {
  const cake: DemandItemSummary = {
    id: "c",
    code: "CAKE",
    name: "Cake",
    type: "finished",
    unit: "each",
    status: "active",
  };
  const dough: DemandItemSummary = {
    ...cake,
    id: "d",
    code: "DOUGH",
    name: "Dough",
    type: "wip",
    unit: "kg",
  };
  const items = new Map([
    [cake.id, cake],
    [dough.id, dough],
  ]);
  const cells = [
    { itemId: "d", periodStart: "2026-11-16", customer: null, quantity: 2500, lineCount: 1 },
    { itemId: "c", periodStart: "2026-11-09", customer: "Tesco", quantity: 10, lineCount: 1 },
    { itemId: "c", periodStart: "2026-11-09", customer: null, quantity: 5, lineCount: 1 },
    { itemId: "c", periodStart: "2026-11-16", customer: "tesco", quantity: 4, lineCount: 1 },
    { itemId: "c", periodStart: "2026-12-28", customer: null, quantity: 99, lineCount: 1 }, // out of range
    { itemId: "x", periodStart: "2026-11-09", customer: null, quantity: 1, lineCount: 1 }, // unknown item
  ];

  it("totals per item per week, in item code order, with every week of the range listed", () => {
    const summary = buildDemandSummary({
      from: "2026-11-09",
      to: "2026-11-23",
      byCustomer: false,
      cells,
      items,
    });
    expect(summary.weeks).toEqual([
      { periodStart: "2026-11-09", week: "2026-W46" },
      { periodStart: "2026-11-16", week: "2026-W47" },
      { periodStart: "2026-11-23", week: "2026-W48" },
    ]);
    expect(summary.rows.map((r) => r.item.code)).toEqual(["CAKE", "DOUGH"]);
    expect(summary.rows[0]).toMatchObject({
      customer: null,
      total: { base: 19, baseUnit: "each" },
      periods: [
        { periodStart: "2026-11-09", week: "2026-W46", quantity: { base: 15 }, lineCount: 2 },
        { periodStart: "2026-11-16", quantity: { base: 4 }, lineCount: 1 },
      ],
    });
    expect(summary.rows[1]?.total).toEqual({ base: 2500, baseUnit: "g", display: 2.5, displayUnit: "kg" });
  });

  it("splits by customer when asked, merging customer names case-insensitively", () => {
    const summary = buildDemandSummary({
      from: "2026-11-09",
      to: "2026-11-23",
      byCustomer: true,
      cells,
      items,
    });
    expect(summary.rows.map((r) => [r.item.code, r.customer, r.total.base])).toEqual([
      ["CAKE", null, 5],
      ["CAKE", "Tesco", 14],
      ["DOUGH", null, 2500],
    ]);
  });
});
