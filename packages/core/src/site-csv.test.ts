import { describe, expect, it } from "vitest";
import { GLASS_CSV_TEMPLATE, parseFrequencyText, parseGlassCsv, parseGlassKindText } from "./site-csv";

describe("check frequencies as people write them", () => {
  it.each([
    ["monthly", { every: 1, unit: "month" }],
    ["Weekly", { every: 1, unit: "week" }],
    ["quarterly", { every: 3, unit: "month" }],
    ["annually", { every: 12, unit: "month" }],
    ["every 2 weeks", { every: 2, unit: "week" }],
    ["3 months", { every: 3, unit: "month" }],
    ["every day", { every: 1, unit: "day" }],
    ["every-6-hours", { every: 6, unit: "hour" }],
  ])("reads %s", (text, expected) => {
    expect(parseFrequencyText(text)).toEqual(expected);
  });
  it.each(["", "sometimes", "months", "every 0 days", "every 5000 days", "2"])("refuses %j", (text) => {
    expect(parseFrequencyText(text)).toBeNull();
  });
});

describe("glass kinds", () => {
  it("reads kinds and common words", () => {
    expect(parseGlassKindText("Glass")).toBe("glass");
    expect(parseGlassKindText("brittle plastic")).toBe("brittle_plastic");
    expect(parseGlassKindText("Hard plastic")).toBe("brittle_plastic");
    expect(parseGlassKindText("brittle_plastic")).toBe("brittle_plastic");
    expect(parseGlassKindText("wood")).toBeNull();
  });
});

describe("glass register CSV", () => {
  it("reads the template", () => {
    const result = parseGlassCsv(GLASS_CSV_TEMPLATE);
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([
      {
        row: 2,
        area: "Packing hall",
        description: "Window on east wall",
        kind: "glass",
        quantity: 2,
        location: "East wall",
        checkFrequency: { every: 1, unit: "month" },
      },
      {
        row: 3,
        area: "Packing hall",
        description: "Light diffuser over line 2",
        kind: "brittle_plastic",
        quantity: 6,
        location: "Ceiling",
        checkFrequency: { every: 3, unit: "month" },
      },
    ]);
  });
  it("needs the area and description columns and reports each bad row", () => {
    expect(parseGlassCsv("area,kind\r\nPacking,glass\r\n").errors[0]).toMatchObject({
      column: "description",
    });
    const result = parseGlassCsv(
      [
        "area,description,kind,quantity,check frequency,status",
        ",Window,glass,1,monthly,",
        "Hall,Window,wood,1,monthly,",
        "Hall,Light,glass,0,sometimes,gone",
        "Hall,Lamp,glass,1,,",
        "Hall,LAMP,glass,1,,",
      ].join("\r\n"),
    );
    expect(result.entries).toEqual([
      { row: 5, area: "Hall", description: "Lamp", kind: "glass", quantity: 1 },
    ]);
    expect(result.errors.map((e) => [e.row, e.column])).toEqual([
      [2, "area"],
      [3, "kind"],
      [4, "quantity"],
      [4, "checkFrequency"],
      [4, "status"],
      [6, "description"],
    ]);
  });
  it("leaves unknown columns out and reports them", () => {
    const result = parseGlassCsv("area,description,owner\r\nHall,Window,Sam\r\n");
    expect(result.ignoredColumns).toEqual(["owner"]);
    expect(result.entries).toEqual([{ row: 2, area: "Hall", description: "Window" }]);
  });
});
