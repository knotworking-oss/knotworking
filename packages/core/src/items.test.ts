import { describe, expect, it } from "vitest";
import {
  allergenCodes,
  convertQuantity,
  itemCreateSchema,
  itemUpdateSchema,
  sortAllergens,
  supplierCreateSchema,
} from "./items";

describe("convertQuantity", () => {
  it("converts within a dimension", () => {
    expect(convertQuantity(2.5, "kg", "g")).toBe(2500);
    expect(convertQuantity(250, "ml", "l")).toBe(0.25);
    expect(convertQuantity(500, "mg", "g")).toBe(0.5);
    expect(convertQuantity(3, "each", "each")).toBe(3);
  });

  it("crosses dimensions only with the item's density or unit weight", () => {
    expect(convertQuantity(1, "l", "kg")).toBeNull();
    expect(convertQuantity(1, "l", "kg", { densityGPerMl: 1.03 })).toBeCloseTo(1.03);
    expect(convertQuantity(515, "g", "ml", { densityGPerMl: 1.03 })).toBeCloseTo(500);
    expect(convertQuantity(12, "each", "kg", { unitWeightG: 60 })).toBeCloseTo(0.72);
    expect(convertQuantity(1, "each", "ml", { unitWeightG: 60 })).toBeNull();
    expect(convertQuantity(2, "each", "ml", { unitWeightG: 60, densityGPerMl: 1.2 })).toBeCloseTo(100);
  });
});

describe("allergens", () => {
  it("are the 14 declarable allergens, kept in declaration order", () => {
    expect(allergenCodes).toHaveLength(14);
    expect(sortAllergens(["soybeans", "milk", "milk", "celery"])).toEqual(["celery", "milk", "soybeans"]);
  });
});

describe("item schemas", () => {
  it("trims, normalises empty text to null and sorts allergens", () => {
    const item = itemCreateSchema.parse({
      code: " FLR-1 ",
      name: "Flour",
      type: "ingredient",
      unit: "kg",
      description: "  ",
      allergens: ["sesame", "cereals_gluten"],
    });
    expect(item).toMatchObject({ code: "FLR-1", description: null, allergens: ["cereals_gluten", "sesame"] });
  });

  it("refuses bad numbers, duplicate suppliers and empty updates", () => {
    const base = { code: "A", name: "A", type: "ingredient", unit: "kg" };
    expect(itemCreateSchema.safeParse({ ...base, densityGPerMl: 0 }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ ...base, standardCost: -1 }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ ...base, shelfLifeDays: 1.5 }).success).toBe(false);
    const id = "00000000-0000-7000-8000-000000000000";
    expect(
      itemCreateSchema.safeParse({ ...base, suppliers: [{ supplierId: id }, { supplierId: id }] }).success,
    ).toBe(false);
    expect(itemUpdateSchema.safeParse({}).success).toBe(false);
    expect(itemUpdateSchema.safeParse({ status: "archived" }).success).toBe(true);
  });

  it("accepts an empty email as none and checks dates", () => {
    expect(supplierCreateSchema.parse({ name: "Mill", email: "" }).email).toBeNull();
    expect(supplierCreateSchema.safeParse({ name: "Mill", certificateExpiresOn: "31/03/2027" }).success).toBe(
      false,
    );
  });
});
