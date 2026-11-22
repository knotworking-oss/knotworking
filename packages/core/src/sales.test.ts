import { describe, expect, it } from "vitest";
import { newId } from "./ids";
import { salesDocumentSchema, salesLineValue, salesTotal, salesPriceSchema } from "./sales";
describe("sales contracts", () => {
  it("rounds line money once with exact decimal multiplication", () => {
    expect(salesLineValue(1000, 0.00345)).toBe("3.45");
    expect(salesLineValue(3, 0.335)).toBe("1.01");
    expect(salesLineValue(0.1, 0.2)).toBe("0.02");
    expect(salesLineValue(1, 0)).toBe("0.00");
    expect(salesTotal(["0.10", "0.20", "1.01"])).toBe("1.31");
    expect(salesLineValue(3, 0.5, 0)).toBe("2");
  });
  it("refuses invalid calendar dates, rounded-away amounts and duplicate line IDs", () => {
    const id = newId();
    const line = { id, itemId: newId(), quantity: 1, unit: "kg", dueOn: "2026-11-15", unitPrice: 0 };
    const doc = { customerId: newId(), currency: "GBP", lines: [line] };
    expect(salesDocumentSchema.safeParse(doc).success).toBe(true);
    for (const lines of [
      [{ ...line, dueOn: "2026-02-30" }],
      [{ ...line, quantity: 0.0000001 }],
      [line, line],
    ])
      expect(salesDocumentSchema.safeParse({ ...doc, lines }).success).toBe(false);
    expect(
      salesPriceSchema.safeParse({
        commandId: newId(),
        customerId: newId(),
        itemId: newId(),
        currency: "GBP",
        unit: "kg",
        unitPrice: 1,
        contractReference: "C",
        validFrom: "2026-12-01",
        validTo: "2026-11-01",
      }).success,
    ).toBe(false);
  });
});
