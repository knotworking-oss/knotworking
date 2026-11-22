import { describe, expect, it } from "vitest";
import {
  defaultInvoiceTolerances,
  invoicePricePerBase,
  uninvoicedQuantity,
  matchInvoiceLine,
  purchaseInvoiceCreateSchema,
  purchaseInvoiceTotals,
  weightedInvoicePrice,
  worstMatchStatus,
  type InvoiceTolerances,
} from "./purchase-invoices";

const tol: InvoiceTolerances = { pricePercent: 2, priceAmount: 10, quantityPercent: 5, quantityAmount: 20 };
const line = (over: Partial<Parameters<typeof matchInvoiceLine>[0]> = {}) =>
  matchInvoiceLine(
    { quantity: 100, unitPrice: 1, orderUnitPrice: 1, received: 100, invoicedElsewhere: 0, ...over },
    tol,
  );

describe("three-way match: price", () => {
  it("is matched when the price is the order's", () => {
    expect(line()).toMatchObject({
      status: "matched",
      priceStatus: "matched",
      quantityStatus: "matched",
      priceVariance: 0,
      quantityVariance: 0,
      issues: [],
    });
  });

  it("is within tolerance at exactly the percentage, and a mismatch just past it", () => {
    // 2% of 1.00 on 100 units: 2.00 in value, well within 10.
    expect(line({ unitPrice: 1.02 })).toMatchObject({
      priceStatus: "within_tolerance",
      priceVariance: 0.02,
      priceVariancePercent: 2,
      priceVarianceValue: 2,
      status: "within_tolerance",
      issues: ["price_within_tolerance"],
    });
    expect(line({ unitPrice: 1.0201 })).toMatchObject({ priceStatus: "mismatch", status: "mismatch" });
    // Lower counts too.
    expect(line({ unitPrice: 0.98 })).toMatchObject({
      priceStatus: "within_tolerance",
      priceVariance: -0.02,
    });
    expect(line({ unitPrice: 0.97 })).toMatchObject({ priceStatus: "mismatch" });
  });

  it("is held by the amount on a large line, whatever the percentage", () => {
    // 1% on 1000 units at 1.00 is 10.00: exactly the amount.
    expect(line({ quantity: 1000, received: 1000, unitPrice: 1.01 })).toMatchObject({
      priceStatus: "within_tolerance",
      priceVarianceValue: 10,
    });
    // 1% on 1001 units is 10.01: past it.
    expect(line({ quantity: 1001, received: 1001, unitPrice: 1.01 })).toMatchObject({
      priceStatus: "mismatch",
      priceVarianceValue: 10.01,
    });
  });

  it("is a mismatch when the order line has no price", () => {
    expect(line({ orderUnitPrice: null })).toMatchObject({
      priceStatus: "mismatch",
      priceVariance: null,
      issues: ["no_order_price"],
    });
  });

  it("compares small per-gram prices at 8 places", () => {
    expect(
      line({ quantity: 25_000, received: 25_000, orderUnitPrice: 0.00345, unitPrice: 0.00345 }),
    ).toMatchObject({ priceStatus: "matched" });
  });
});

describe("three-way match: units", () => {
  it("is a mismatch on both counts when the line's units don't convert", () => {
    expect(line({ convertible: false })).toMatchObject({
      status: "mismatch",
      priceStatus: "mismatch",
      quantityStatus: "mismatch",
      issues: ["unit_not_convertible"],
    });
    expect(line({ convertible: true }).status).toBe("matched");
  });
});

describe("three-way match: quantity", () => {
  it("accepts a part invoice: less than received is matched", () => {
    expect(line({ quantity: 40 })).toMatchObject({
      quantityStatus: "matched",
      quantityVariance: -60,
      uninvoiced: 100,
    });
  });

  it("measures against what was received, not what was ordered (partial deliveries)", () => {
    // Ordered 100, 60 delivered so far: invoicing all 100 is over-invoicing by 40.
    expect(line({ received: 60 })).toMatchObject({
      quantityStatus: "mismatch",
      quantityVariance: 40,
      issues: ["over_invoiced"],
    });
    expect(line({ received: 60, quantity: 60 })).toMatchObject({ quantityStatus: "matched" });
  });

  it("is within tolerance at exactly the percentage, and a mismatch past it", () => {
    // 5% over on 100 received at 1.00: 5.00 in value.
    expect(line({ quantity: 105 })).toMatchObject({
      quantityStatus: "within_tolerance",
      quantityVariance: 5,
      quantityVariancePercent: 5,
      quantityVarianceValue: 5,
      issues: ["over_invoiced_within_tolerance"],
    });
    expect(line({ quantity: 105.01 })).toMatchObject({ quantityStatus: "mismatch" });
  });

  it("is held by the amount: over-invoicing worth more than it is a mismatch", () => {
    // 4% over, but 4 × 6.00 = 24.00 is past 20.
    expect(line({ quantity: 104, unitPrice: 6, orderUnitPrice: 6 })).toMatchObject({
      quantityStatus: "mismatch",
      quantityVarianceValue: 24,
    });
  });

  it("subtracts what other approved invoices already billed (invoicing the same delivery twice)", () => {
    expect(line({ invoicedElsewhere: 100 })).toMatchObject({
      uninvoiced: 0,
      quantityVariance: 100,
      quantityVariancePercent: null,
      quantityStatus: "mismatch",
    });
    expect(line({ invoicedElsewhere: 60, quantity: 40 })).toMatchObject({ quantityStatus: "matched" });
  });

  it("is a mismatch when nothing has been received at all", () => {
    expect(line({ received: 0, quantity: 1 })).toMatchObject({ quantityStatus: "mismatch" });
  });

  it("with zero tolerances accepts only exact matches", () => {
    const zero = { pricePercent: 0, priceAmount: 0, quantityPercent: 0, quantityAmount: 0 };
    const input = { quantity: 100, unitPrice: 1, orderUnitPrice: 1, received: 100, invoicedElsewhere: 0 };
    expect(matchInvoiceLine(input, zero).status).toBe("matched");
    expect(matchInvoiceLine({ ...input, unitPrice: 1.0001 }, zero).status).toBe("mismatch");
    expect(matchInvoiceLine({ ...input, quantity: 100.0001 }, zero).status).toBe("mismatch");
  });
});

describe("invoice helpers", () => {
  it("takes the worst status", () => {
    expect(worstMatchStatus([])).toBe("matched");
    expect(worstMatchStatus(["matched", "within_tolerance"])).toBe("within_tolerance");
    expect(worstMatchStatus(["mismatch", "within_tolerance", "matched"])).toBe("mismatch");
  });

  it("totals the lines with VAT", () => {
    expect(
      purchaseInvoiceTotals(
        [
          { quantity: 25, unitPrice: 0.84 },
          { quantity: 1, unitPrice: 12.5 },
        ],
        6.7,
      ),
    ).toEqual({ net: 33.5, vat: 6.7, gross: 40.2 });
  });

  it("weights invoice prices by quantity", () => {
    expect(
      weightedInvoicePrice([
        { quantity: 10, unitPrice: 1 },
        { quantity: 30, unitPrice: 2 },
      ]),
    ).toBe(1.75);
    expect(weightedInvoicePrice([])).toBeNull();
  });

  it("has sensible default tolerances", () => {
    expect(defaultInvoiceTolerances).toEqual({
      pricePercent: 2,
      priceAmount: 10,
      quantityPercent: 2,
      quantityAmount: 10,
    });
  });

  it("validates an invoice: lines per order line once, due after invoice date, charges", () => {
    const base = {
      supplierId: "0190a8e0-0000-7000-8000-000000000001",
      invoiceNumber: " INV-1 ",
      invoiceDate: "2026-11-01",
    };
    const orderLineId = "0190a8e0-0000-7000-8000-000000000002";
    const parsed = purchaseInvoiceCreateSchema.parse({
      ...base,
      lines: [
        { kind: "order", orderLineId, quantity: 25, unitPrice: 0.84 },
        { kind: "charge", description: "Carriage", unitPrice: 12.5 },
      ],
    });
    expect(parsed.invoiceNumber).toBe("INV-1");
    expect(parsed.vat).toBe(0);
    expect(parsed.lines[1]).toMatchObject({ kind: "charge", quantity: 1 });
    expect(
      purchaseInvoiceCreateSchema.safeParse({
        ...base,
        lines: [
          { kind: "order", orderLineId, quantity: 1, unitPrice: 1 },
          { kind: "order", orderLineId, quantity: 1, unitPrice: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(purchaseInvoiceCreateSchema.safeParse({ ...base, dueDate: "2026-10-01" }).success).toBe(false);
    expect(
      purchaseInvoiceCreateSchema.safeParse({ ...base, lines: [{ kind: "charge", unitPrice: 1 }] }).success,
    ).toBe(false);
  });
});

describe("what is left to invoice", () => {
  it("is received less already invoiced, never below zero", () => {
    expect(uninvoicedQuantity(60, 0)).toBe(60);
    expect(uninvoicedQuantity(60, 40)).toBe(20);
    expect(uninvoicedQuantity(60, 60)).toBe(0);
    expect(uninvoicedQuantity(60, 70)).toBe(0);
    expect(uninvoicedQuantity(0.3, 0.1)).toBe(0.2);
    expect(uninvoicedQuantity(null, 0)).toBeNull();
  });
});

describe("invoice price per base unit, for costing", () => {
  const at = (orderUnitPrice: number | null, basePerUnit: number | null) => ({ orderUnitPrice, basePerUnit });

  it("scales the receipt's frozen price by the invoice-to-order ratio, whatever the conversion today", () => {
    // 4 sacks ordered at 20.00, invoiced at 20.30; the receipt froze 20/25000 per gram.
    const price = invoicePricePerBase(
      [{ quantity: 4, unitPrice: 20.3, approvedMatch: at(20, 25_000) }],
      20 / 25_000,
    );
    expect(price).toEqual({ pricePerBase: 0.000812, unpriced: false });
  });

  it("weights several invoices by quantity", () => {
    const price = invoicePricePerBase(
      [
        { quantity: 10, unitPrice: 1.1, approvedMatch: at(1, 1000) },
        { quantity: 30, unitPrice: 0.9, approvedMatch: at(1, 1000) },
      ],
      0.001,
    );
    // (11 + 27) / 40 = 0.95 of the order price.
    expect(price.pricePerBase).toBeCloseTo(0.00095, 10);
  });

  it("uses the conversion stored at approval when there is no order (or receipt) price", () => {
    expect(
      invoicePricePerBase([{ quantity: 4, unitPrice: 20, approvedMatch: at(null, 25_000) }], null),
    ).toEqual({ pricePerBase: 0.0008, unpriced: false });
  });

  it("can't price it without either, and says so rather than dropping it", () => {
    expect(
      invoicePricePerBase([{ quantity: 4, unitPrice: 20, approvedMatch: at(null, null) }], 0.0008),
    ).toEqual({
      pricePerBase: null,
      unpriced: true,
    });
    expect(invoicePricePerBase([], 0.0008)).toEqual({ pricePerBase: null, unpriced: false });
  });
});

describe("three-way match: units that don't convert", () => {
  it("is a mismatch, never a comparison of grams with sacks", () => {
    const m = matchInvoiceLine(
      { quantity: 4, unitPrice: 20, orderUnitPrice: 20, received: null, invoicedElsewhere: 0 },
      tol,
    );
    expect(m).toMatchObject({
      status: "mismatch",
      priceStatus: "matched",
      quantityStatus: "mismatch",
      uninvoiced: null,
      quantityVariance: null,
      issues: ["unit_not_convertible"],
    });
  });

  it("says so for an order price in a unit that doesn't convert, rather than no price", () => {
    const m = matchInvoiceLine(
      {
        quantity: 1,
        unitPrice: 20,
        orderUnitPrice: null,
        orderPriceNotConvertible: true,
        received: 1,
        invoicedElsewhere: 0,
      },
      tol,
    );
    expect(m).toMatchObject({ priceStatus: "mismatch", issues: ["unit_not_convertible"] });
  });
});
