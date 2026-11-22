import { describe, expect, it } from "vitest";
import { parseDateText, parseNumberText, readCsvTable, splitListText } from "./csv-import";
import { ITEM_CSV_TEMPLATE, parseAllergenText, parseItemsCsv } from "./items-csv";
import { parseStaffCsv, STAFF_CSV_TEMPLATE } from "./people-csv";
import { parseSuppliersCsv, SUPPLIER_CSV_TEMPLATE } from "./suppliers-csv";

describe("csv import cells", () => {
  it("reads dates day first", () => {
    expect(parseDateText("2026-11-12")).toBe("2026-11-12");
    expect(parseDateText("12/11/2026")).toBe("2026-11-12");
    expect(parseDateText("1.2.2027")).toBe("2027-02-01");
    expect(parseDateText("31/02/2026")).toBeNull();
    expect(parseDateText("next week")).toBeNull();
  });

  it("reads numbers as people type them", () => {
    expect(parseNumberText("1,200.5")).toBe(1200.5);
    expect(parseNumberText("£4.20")).toBe(4.2);
    expect(parseNumberText(" 0.85 ")).toBe(0.85);
    expect(parseNumberText("-1")).toBeNull();
    expect(parseNumberText("1.200,5")).toBeNull();
    expect(parseNumberText("abc")).toBeNull();
  });

  it("splits list cells", () => {
    expect(splitListText("a; b | c, d;;")).toEqual(["a", "b", "c", "d"]);
  });

  it("reports an empty file, a missing required column and a header without rows", () => {
    const spec = { columns: { code: ["sku"] }, required: ["code"] as const, template: "code" };
    expect(readCsvTable("", spec).errors).toEqual([{ row: 1, message: "The file is empty" }]);
    expect(readCsvTable("name\nx", spec).errors[0]).toMatchObject({ row: 1, column: "code" });
    expect(readCsvTable("SKU\n", spec).errors[0]).toMatchObject({ row: 2 });
    expect(readCsvTable("SKU\nA\n\nB", spec).rows.map((r) => r.row)).toEqual([2, 4]);
  });
});

describe("parseItemsCsv", () => {
  it("reads the template", () => {
    const res = parseItemsCsv(ITEM_CSV_TEMPLATE);
    expect(res.errors).toEqual([]);
    expect(res.entries).toEqual([
      {
        row: 2,
        code: "FLOUR-01",
        name: "Plain flour",
        type: "ingredient",
        unit: "kg",
        allergens: ["cereals_gluten"],
        mayContain: [],
        storage: "ambient",
        shelfLifeDays: 365,
        standardCost: 0.85,
      },
    ]);
  });

  it("reads columns in any order, semicolons, aliases and allergen names", () => {
    const res = parseItemsCsv(
      "Item name;SKU;Item Type;UOM;Contains;May contain;Storage condition;Std cost\n" +
        'Milk powder;MP-1;Raw material;Kgs;"Milk, soya";tree nuts|Sesame;Dry;£3.10\n',
    );
    expect(res.errors).toEqual([]);
    expect(res.entries[0]).toMatchObject({
      code: "MP-1",
      name: "Milk powder",
      type: "ingredient",
      unit: "kg",
      allergens: ["milk", "soybeans"],
      mayContain: ["nuts", "sesame"],
      storage: "ambient",
      standardCost: 3.1,
    });
  });

  it("leaves fields alone for a missing column or an empty name, type, unit or storage", () => {
    const res = parseItemsCsv("code,name,unit,description,standard cost\nA1,,,,\n");
    expect(res.entries[0]).toEqual({ row: 2, code: "A1", description: null, standardCost: null });
    expect("name" in res.entries[0]!).toBe(false);
    expect("allergens" in res.entries[0]!).toBe(false);
  });

  it("reports every problem with its row and column", () => {
    const res = parseItemsCsv(
      [
        "code,name,type,unit,allergens,storage,shelf life,standard cost,density",
        "A1,One,widget,kg,,,,,",
        "A2,Two,ingredient,stone,,,,,",
        "A3,Three,ingredient,kg,peanutz,,,,",
        "A4,Four,ingredient,kg,,warm,,,",
        "A5,Five,ingredient,kg,,,2 weeks,,",
        "A6,Six,ingredient,kg,,,,-3,",
        "A7,Seven,ingredient,kg,,,,,0",
        ",Eight,ingredient,kg,,,,,",
        "a1,Dup,ingredient,kg,,,,,",
        "A9,Nine,ingredient,kg,,,,,",
      ].join("\n"),
    );
    expect(res.rowCount).toBe(10);
    expect(res.errors.map((e) => [e.row, e.column])).toEqual([
      [2, "type"],
      [3, "unit"],
      [4, "allergens"],
      [5, "storage"],
      [6, "shelfLife"],
      [7, "standardCost"],
      [8, "density"],
      [9, "code"],
      [10, "code"],
    ]);
    expect(res.errors[8]!.message).toContain("row 2");
    expect(res.entries.map((e) => e.code)).toEqual(["A9"]);
  });

  it("accepts none for allergens and rejects unknown allergens", () => {
    expect(parseAllergenText("None")).toEqual({ codes: [] });
    expect(parseAllergenText("gluten; wheat; Eggs")).toEqual({ codes: ["cereals_gluten", "eggs"] });
    expect(parseAllergenText("kale")).toHaveProperty("error");
  });

  it("needs a code column", () => {
    expect(parseItemsCsv("name,type\nx,y").errors).toEqual([
      expect.objectContaining({ row: 1, column: "code" }),
    ]);
  });
});

describe("parseSuppliersCsv", () => {
  it("reads the template", () => {
    const res = parseSuppliersCsv(SUPPLIER_CSV_TEMPLATE);
    expect(res.errors).toEqual([]);
    expect(res.entries[0]).toMatchObject({
      code: "MILL01",
      name: "Eastern Mills Ltd",
      contactName: "Sam Baker",
      address: null,
      certification: "BRCGS Food Safety AA",
      certificateExpiresOn: "2027-03-31",
    });
  });

  it("never reads an approval status, and says it was ignored", () => {
    const res = parseSuppliersCsv("name,approval status,status,approved\nAcme,approved,approved,yes\n");
    expect(res.errors).toEqual([]);
    expect(res.ignoredColumns).toEqual(["approval status", "status", "approved"]);
    expect(Object.keys(res.entries[0]!).sort()).toEqual(["name", "row"]);
  });

  it("accepts a file with only a code, or only a name, column", () => {
    expect(parseSuppliersCsv("code,phone\nA,1\n").errors).toEqual([]);
    expect(parseSuppliersCsv("name\nAcme\n").errors).toEqual([]);
    expect(parseSuppliersCsv("phone\n1\n").errors[0]).toMatchObject({ row: 1 });
  });

  it("reports bad emails, dates, missing identity and repeats", () => {
    const res = parseSuppliersCsv(
      [
        "code,name,email,certificate expiry",
        "A,Acme,not-an-email,",
        "B,Beta,b@example.com,31/02/2027",
        ",,c@example.com,",
        "a,Again,,",
        ",Gamma,,",
        ",gamma,,",
      ].join("\n"),
    );
    expect(res.errors.map((e) => [e.row, e.column])).toEqual([
      [2, "email"],
      [3, "certificateExpiresOn"],
      [4, "code"],
      [5, "code"],
      [7, "name"],
    ]);
  });

  it("reads UK dates and clears empty cells", () => {
    const res = parseSuppliersCsv("code,certificate expiry,phone\nA,31/03/2027,\n");
    expect(res.entries[0]).toMatchObject({ certificateExpiresOn: "2027-03-31", phone: null });
  });
});

describe("parseStaffCsv", () => {
  it("reads the template", () => {
    const res = parseStaffCsv(STAFF_CSV_TEMPLATE);
    expect(res.errors).toEqual([]);
    expect(res.entries[0]).toEqual({
      row: 2,
      staffNumber: "100001",
      firstName: "Ada",
      lastName: "Lovelace",
      jobTitle: "Line operative",
      department: "Production",
      jobRoleNames: ["Line operative", "Hygiene"],
      startDate: "2026-01-05",
      payrollReference: "E1234",
    });
  });

  it("never reads a PIN column", () => {
    const res = parseStaffCsv("staff number,first name,last name,PIN,kiosk pin\n100002,A,B,123456,654321\n");
    expect(res.errors).toEqual([]);
    expect(res.ignoredColumns).toEqual(["PIN", "kiosk pin"]);
    expect(JSON.stringify(res.entries)).not.toContain("123456");
    expect(JSON.stringify(res.entries)).not.toContain("654321");
  });

  it("keeps staff numbers as text and rejects ones a spreadsheet mangled", () => {
    const res = parseStaffCsv(
      [
        "staff number,first name,last name,start date,end date,status",
        "000123,A,A,,,",
        "1234,B,B,,,",
        "100003,C,C,5/1/2026,1/1/2026,",
        "100004,D,D,soon,,",
        "100005,E,E,,,retired",
        "000123,F,F,,,",
        ",G,G,,,",
        "100008,H,H,01/02/2026,,leaver",
      ].join("\n"),
    );
    expect(res.entries.map((e) => e.staffNumber)).toEqual(["000123", "100008"]);
    expect(res.errors.map((e) => [e.row, e.column])).toEqual([
      [3, "staffNumber"],
      [4, "endDate"],
      [5, "startDate"],
      [6, "status"],
      [7, "staffNumber"],
      [8, "staffNumber"],
    ]);
    expect(res.errors[0]!.message).toContain("leading zero");
    expect(res.entries[1]).toMatchObject({ startDate: "2026-02-01", status: "leaver" });
  });

  it("reads job roles, clearing them with an empty cell", () => {
    const res = parseStaffCsv(
      "staff number,job roles\n100001,Hygiene; hygiene | Packer\n100002,\n100003,None\n",
    );
    expect(res.entries.map((e) => e.jobRoleNames)).toEqual([["Hygiene", "Packer"], [], []]);
  });
});
