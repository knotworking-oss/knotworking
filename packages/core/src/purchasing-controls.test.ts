import { describe, expect, it } from "vitest";
import {
  creditExcess,
  creditNoteTotals,
  creditTotals,
  purchaseCreditNoteCreateSchema,
} from "./purchase-credit-notes";
import { invoicePricePerBase, purchaseInvoiceCreateSchema } from "./purchase-invoices";
import {
  canApproveOrderSend,
  isOverDeliveryTolerance,
  overDeliveryLimit,
  priceInForce,
  purchaseOrderSettingsUpdateSchema,
  renderPurchaseOrderEmail,
  sendApprovalState,
  supplierPriceCreateSchema,
} from "./purchasing-controls";

const uuid = "01a1d7e3-af9b-7054-b6c9-68fe4530020e";

describe("send approval", () => {
  const base = { threshold: 100, createdBy: "a", approvedBy: null, approvedValue: null };
  it("is not required without a threshold or within it (the threshold itself is within)", () => {
    expect(sendApprovalState({ ...base, threshold: null, value: 1e9 })).toBe("not_required");
    expect(sendApprovalState({ ...base, value: 100 })).toBe("not_required");
    expect(sendApprovalState({ ...base, value: 100.0001 })).toBe("needed");
  });
  it("covers orders up to the approved value, by someone other than the creator", () => {
    const approved = { ...base, approvedBy: "b", approvedValue: 150 };
    expect(sendApprovalState({ ...approved, value: 150 })).toBe("approved");
    expect(sendApprovalState({ ...approved, value: 120 })).toBe("approved");
    expect(sendApprovalState({ ...approved, value: 150.01 })).toBe("stale");
    expect(sendApprovalState({ ...approved, approvedBy: "a", value: 150 })).toBe("stale");
  });
  it("keeps the creator from approving", () => {
    expect(canApproveOrderSend({ createdBy: "a", approverId: "a" })).toBe(false);
    expect(canApproveOrderSend({ createdBy: "a", approverId: "b" })).toBe(true);
    expect(canApproveOrderSend({ createdBy: null, approverId: "b" })).toBe(true);
  });
  it("validates settings", () => {
    expect(purchaseOrderSettingsUpdateSchema.safeParse({}).success).toBe(false);
    expect(purchaseOrderSettingsUpdateSchema.parse({ sendApprovalThreshold: null })).toEqual({
      sendApprovalThreshold: null,
    });
    expect(purchaseOrderSettingsUpdateSchema.safeParse({ overDeliveryTolerancePercent: -1 }).success).toBe(
      false,
    );
  });
});

describe("over-delivery tolerance", () => {
  it("allows exactly the limit and nothing when no tolerance is set", () => {
    expect(overDeliveryLimit(100000, 10)).toBe(110000);
    const over = (received: number, receiving: number, tolerancePercent: number | null) =>
      isOverDeliveryTolerance({ ordered: 100000, received, receiving, tolerancePercent });
    expect(over(0, 110000, 10)).toBe(false);
    expect(over(0, 110000.0001, 10)).toBe(true);
    expect(over(100000, 10001, 10)).toBe(true);
    expect(over(0, 5e9, null)).toBe(false);
    expect(over(0, 100001, 0)).toBe(true);
  });
});

describe("price list", () => {
  const e = (effectiveFrom: string, effectiveTo: string | null = null) => ({ effectiveFrom, effectiveTo });
  it("takes the entry in force, the latest to take effect when several overlap", () => {
    const list = [e("2026-01-01", "2026-03-31"), e("2026-02-01"), e("2026-06-01")];
    expect(priceInForce(list, "2025-12-31")).toBeNull();
    expect(priceInForce(list, "2026-01-15")).toBe(list[0]);
    expect(priceInForce(list, "2026-02-15")).toBe(list[1]);
    expect(priceInForce(list, "2026-03-31")).toBe(list[1]);
    expect(priceInForce(list, "2026-06-01")).toBe(list[2]);
    expect(priceInForce([e("2026-01-01", "2026-01-31")], "2026-02-01")).toBeNull();
  });
  it("validates the dates and rounds the price to 8 places", () => {
    const parsed = supplierPriceCreateSchema.parse({
      supplierId: uuid,
      itemId: uuid,
      unit: "kg",
      unitPrice: 1.123456789,
      effectiveFrom: "2026-01-01",
    });
    expect(parsed.unitPrice).toBe(1.12345679);
    expect(
      supplierPriceCreateSchema.safeParse({
        supplierId: uuid,
        itemId: uuid,
        unit: "kg",
        unitPrice: 1,
        effectiveFrom: "2026-02-01",
        effectiveTo: "2026-01-01",
      }).success,
    ).toBe(false);
  });
});

describe("the order email", () => {
  const content = {
    workspaceName: "Acme <Foods>",
    reference: "PO-2026-001",
    supplierName: "Mill & Co",
    supplierReference: null,
    orderedOn: "2026-11-13",
    expectedOn: "2026-11-20",
    deliveryLocation: "Goods in",
    notes: null,
    message: null,
    senderName: "Ada",
    value: 125,
    complete: false,
    lines: [
      {
        lineNo: 1,
        code: "FLR",
        name: "Flour",
        quantity: 100,
        unit: "kg",
        unitPrice: 1.25,
        value: 125,
        expectedOn: null,
      },
      {
        lineNo: 2,
        code: "SUG",
        name: "Sugar",
        quantity: 5,
        unit: "kg",
        unitPrice: null,
        value: null,
        expectedOn: "2026-11-18",
      },
    ],
  };
  it("has plain text and escaped HTML with the same lines, and no links", () => {
    const { subject, text, html } = renderPurchaseOrderEmail(content);
    expect(subject).toBe("Purchase order PO-2026-001 from Acme <Foods>");
    expect(text).toContain("1. FLR Flour: 100 kg @ 1.25 = 125.00");
    expect(text).toContain("2. SUG Sugar: 5 kg - for 2026-11-18");
    expect(text).toContain("Total: 125.00 (lines without a price are not included)");
    expect(text).not.toContain("Your reference");
    expect(html).toContain("Acme &lt;Foods&gt;");
    expect(html).toContain("Mill &amp; Co");
    expect(`${text}${html}`).not.toMatch(/https?:|href=/);
  });
});

describe("credit notes", () => {
  const price = (quantity: number, unitPrice: number) => ({
    kind: "invoice_line" as const,
    reason: "price" as const,
    quantity,
    unitPrice,
  });
  const back = (quantity: number, unitPrice: number) => ({
    ...price(quantity, unitPrice),
    reason: "goods_returned" as const,
  });
  it("totals value and returned units", () => {
    expect(creditTotals([price(100, 0.08), back(20, 0.8)])).toEqual({ value: 24, returnedQuantity: 20 });
    expect(creditNoteTotals([price(100, 0.08)], 1.6)).toEqual({ net: 8, vat: 1.6, gross: 9.6 });
  });
  it("caps credit at what the line billed, by value then by quantity", () => {
    const line = { quantity: 100, unitPrice: 0.8 };
    const none = { value: 0, returnedQuantity: 0 };
    expect(creditExcess(line, none, { value: 80, returnedQuantity: 100 })).toBeNull();
    expect(
      creditExcess(line, { value: 20, returnedQuantity: 0 }, { value: 60.0001, returnedQuantity: 0 }),
    ).toBe("value");
    expect(creditExcess(line, none, { value: 8, returnedQuantity: 100.0001 })).toBe("quantity");
  });
  it("rejects the same line credited twice for the same reason", () => {
    const line = { kind: "invoice_line", invoiceLineId: uuid, reason: "price", quantity: 1, unitPrice: 1 };
    const make = (lines: object[]) =>
      purchaseCreditNoteCreateSchema.safeParse({
        invoiceId: uuid,
        creditNoteNumber: "CN-1",
        creditDate: "2026-11-13",
        lines,
      }).success;
    expect(make([line])).toBe(true);
    expect(make([line, line])).toBe(false);
    expect(make([line, { ...line, reason: "goods_returned" }])).toBe(true);
  });
});

describe("invoice prices net of credits", () => {
  const lines = [
    { quantity: 100, unitPrice: 0.8, approvedMatch: { orderUnitPrice: 0.8, basePerUnit: 1000 } },
  ];
  it("spreads a price credit over the quantity kept", () => {
    expect(invoicePricePerBase(lines, 0.0008, { value: 8, returnedQuantity: 0 })).toEqual({
      pricePerBase: 0.00072,
      unpriced: false,
    });
  });
  it("leaves the unit cost alone for goods returned at the invoice price", () => {
    expect(invoicePricePerBase(lines, 0.0008, { value: 16, returnedQuantity: 20 }).pricePerBase).toBe(0.0008);
    // Without the order price the conversion is used instead.
    const noOrder = [
      { quantity: 100, unitPrice: 0.8, approvedMatch: { orderUnitPrice: null, basePerUnit: 1000 } },
    ];
    expect(invoicePricePerBase(noOrder, null, { value: 8, returnedQuantity: 0 }).pricePerBase).toBe(0.00072);
  });
  it("has no price when everything was returned, and is unchanged without credits", () => {
    expect(invoicePricePerBase(lines, 0.0008, { value: 80, returnedQuantity: 100 })).toEqual({
      pricePerBase: null,
      unpriced: false,
    });
    expect(invoicePricePerBase(lines, 0.0008).pricePerBase).toBe(0.0008);
  });
});

describe("discount lines", () => {
  it("accepts a negative charge but not a negative order line", () => {
    const make = (line: object) =>
      purchaseInvoiceCreateSchema.safeParse({
        supplierId: uuid,
        invoiceNumber: "I-1",
        invoiceDate: "2026-11-13",
        lines: [line],
      }).success;
    expect(make({ kind: "charge", description: "Discount", unitPrice: -5 })).toBe(true);
    expect(make({ kind: "order", orderLineId: uuid, quantity: 1, unitPrice: -5 })).toBe(false);
  });
});
