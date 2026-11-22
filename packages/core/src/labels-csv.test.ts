import { describe, expect, it } from "vitest";
import { NUTRITION_CSV_TEMPLATE, parseNutrientCell, parseNutritionCsv } from "./labels-csv";

describe("nutrient cells", () => {
  it("reads numbers with units, traces and gaps", () => {
    expect(parseNutrientCell("12.5")).toBe(12.5);
    expect(parseNutrientCell(" 12.5 g ")).toBe(12.5);
    expect(parseNutrientCell("1,459")).toBe(1459);
    expect(parseNutrientCell("(0.3)")).toBe(0.3);
    expect(parseNutrientCell("Tr")).toBe(0);
    expect(parseNutrientCell("trace")).toBe(0);
    expect(parseNutrientCell("<0.1")).toBe(0);
    expect(parseNutrientCell("")).toBeUndefined();
    expect(parseNutrientCell("N")).toBeUndefined();
    expect(parseNutrientCell("n/a")).toBeUndefined();
    expect(parseNutrientCell("lots")).toBeNull();
    expect(parseNutrientCell("-3")).toBeNull();
  });
});

describe("nutrition CSV", () => {
  it("reads the template", () => {
    const r = parseNutritionCsv(NUTRITION_CSV_TEMPLATE);
    expect(r.errors).toEqual([]);
    expect(r.rowCount).toBe(1);
    expect(r.entries[0]).toMatchObject({
      row: 2,
      code: "FLOUR-01",
      basis: "100g",
      nutrition: {
        energyKj: 1459,
        energyKcal: 343,
        fat: 1.4,
        saturates: 0.3,
        carbohydrate: 72,
        sugars: 1.5,
        fibre: 3.1,
        protein: 10.5,
        salt: 0.01,
        polyols: 0,
      },
      nutritionSource: "Supplier specification v3",
    });
  });

  it("reads a specification sheet with units in its headers, matched by name", () => {
    const r = parseNutritionCsv(
      [
        "Product name,Energy kJ per 100g,Energy kcal per 100g,Fat g,of which saturates g,Carbohydrate g,of which sugars g,Protein g,Salt g,Polyols g,Alcohol g",
        "Rum syrup,1000,239,0.5,0.1,60,40,0.4,0.02,20,2",
      ].join("\n"),
    );
    expect(r.errors).toEqual([]);
    expect(r.entries[0]).toMatchObject({
      code: null,
      name: "Rum syrup",
      nutrition: { carbohydrate: 60, polyols: 20, alcohol: 2, erythritol: 0 },
    });
    expect(r.entries[0]!.basis).toBeUndefined();
  });

  it("reads McCance and Widdowson's columns: sodium in mg becomes salt, vitamins and minerals are kept", () => {
    const csv = [
      "Stock code,Food Code,Food Name,Water (g),Protein (g),Fat (g),Carbohydrate (g),Energy (kcal) (kcal),Energy (kJ) (kJ),Total sugars (g),AOAC fibre (g),Satd FA /100g fd (g),Satd FA /100g fat (g),Sodium (mg),Potassium (mg),Vitamin C (mg),Folate (µg),Vitamin B12 (µg)",
      'CHED-01,12-34,"Cheese, Cheddar",36.6,25.4,34.9,0.1,416,1725,0.1,0,21.7,62,723,75,0,31,1.1',
      'SPIN-01,13-99,"Spinach, boiled",91,3.3,0.8,1.4,19,79,0.6,2.1,0.2,Tr,Tr,330,17,66,0',
    ].join("\n");
    const r = parseNutritionCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.ignoredColumns).toEqual(
      expect.arrayContaining(["Food Code", "Water (g)", "Satd FA /100g fat (g)"]),
    );
    const [cheese, spinach] = r.entries;
    expect(cheese).toMatchObject({
      code: "CHED-01",
      nutrition: {
        energyKj: 1725,
        energyKcal: 416,
        fat: 34.9,
        saturates: 21.7,
        carbohydrate: 0.1,
        sugars: 0.1,
        fibre: 0,
        protein: 25.4,
        // 723 mg sodium x 2.5 = 1.8075 g salt.
        salt: 1.808,
      },
      micronutrients: { potassium: 75, vitaminC: 0, folate: 31, vitaminB12: 1.1 },
      derived: ["salt"],
    });
    expect(spinach).toMatchObject({ code: "SPIN-01", nutrition: { carbohydrate: 1.4, salt: 0 } });
  });

  it("completes energy from the one value given", () => {
    const r = parseNutritionCsv(
      "code,kcal,fat,saturates,carbohydrate,sugars,protein,salt\nA,100,1,0.5,20,5,3,0.1\n",
    );
    expect(r.errors).toEqual([]);
    expect(r.entries[0]).toMatchObject({
      nutrition: { energyKcal: 100, energyKj: 418 },
      derived: ["energyKj"],
    });
  });

  it("reports every problem with its row and column, and imports nothing from a bad file", () => {
    const r = parseNutritionCsv(
      [
        "code,basis,energy kj,energy kcal,fat,saturates,carbohydrate,sugars,protein,salt",
        "A,100g,1000,239,1,2,20,5,3,0.1", // saturates over fat
        "B,100g,1000,239,1,0.5,20,25,3,0.1", // sugars over carbohydrate
        "C,per pint,1000,239,1,0.5,20,5,3,0.1", // bad basis
        "D,100g,100,239,1,0.5,20,5,3,0.1", // kJ against kcal
        "E,100g,1000,239,lots,0.5,20,5,3,0.1", // not a number
        "F,100g,1000,239,1,0.5,20,5,3,", // no salt
        "A,100g,1000,239,1,0.5,20,5,3,0.1", // duplicate of A
        ",100g,1000,239,1,0.5,20,5,3,0.1", // no code
      ].join("\n"),
    );
    expect(r.entries).toEqual([]);
    expect(r.errors.map((e) => [e.row, e.column])).toEqual([
      [2, "saturates"],
      [3, "sugars"],
      [4, "basis"],
      [5, "energyKj"],
      [6, "fat"],
      [7, "salt"],
      [8, "code"],
      [9, "code"],
    ]);
  });

  it("needs a code or name column, and every mandatory nutrient", () => {
    expect(parseNutritionCsv("fat,protein\n1,2\n").errors[0]).toMatchObject({ column: "code" });
    const r = parseNutritionCsv("code,fat\nA,1\n");
    expect(r.errors.map((e) => e.column).sort()).toEqual(
      ["carbohydrate", "energyKj", "protein", "salt", "saturates", "sugars"].sort(),
    );
  });

  it("only changes vitamins and minerals when the file has columns for them", () => {
    const without = parseNutritionCsv(NUTRITION_CSV_TEMPLATE);
    expect(without.entries[0]!.micronutrients).toBeUndefined();
    const withVitamin = parseNutritionCsv(
      "code,kj,kcal,fat,saturates,carbohydrate,sugars,protein,salt,vitamin c\nA,100,24,0,0,5,1,1,0,12\nB,100,24,0,0,5,1,1,0,\n",
    );
    expect(withVitamin.errors).toEqual([]);
    expect(withVitamin.entries[0]!.micronutrients).toEqual({ vitaminC: 12 });
    expect(withVitamin.entries[1]!.micronutrients).toEqual({});
  });
});
