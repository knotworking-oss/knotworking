import { describe, expect, it } from "vitest";
import {
  convertUnitPrice,
  lineReceiptState,
  outstanding,
  purchaseOrderCreateSchema,
  purchaseOrderListQuerySchema,
  purchaseOrderReference,
  purchaseOrderReferenceSequence,
  purchaseOrderState,
  purchaseOrderUpdateSchema,
  purchaseOrderValue,
  purchaseReceiptMovementReference,
  purchaseReceiveSchema,
  purchaseSuggestions,
  purchaseSuggestionsCreateSchema,
  purchaseSuggestionsQuerySchema,
  purchaseSuggestionsRange,
  suggestedSupplier,
  supplierPerformance,
  supplierPerformanceRange,
  notPurchasableReason,
  PRICE_DECIMALS,
  purchaseOrderLineSchema,
  type PerformanceLine,
  type PerformanceReceipt,
} from "./purchasing";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("references", () => {
  it("formats and parses PO-yyyy-nnn", () => {
    expect(purchaseOrderReference("2026-03-04", 7)).toBe("PO-2026-007");
    expect(purchaseOrderReference("2027-01-01", 1234)).toBe("PO-2027-1234");
    expect(purchaseOrderReferenceSequence("PO-2026-007")).toBe(7);
    expect(purchaseOrderReferenceSequence("PO-2026-1234")).toBe(1234);
    expect(purchaseOrderReferenceSequence("CMP-2026-007")).toBeNull();
    expect(purchaseOrderReferenceSequence("PO-2026-")).toBeNull();
  });

  it("names the order and the delivery note on the stock movement", () => {
    expect(purchaseReceiptMovementReference("PO-2026-001")).toBe("PO-2026-001");
    expect(purchaseReceiptMovementReference("PO-2026-001", null)).toBe("PO-2026-001");
    expect(purchaseReceiptMovementReference("PO-2026-001", "DN4471")).toBe("PO-2026-001 / DN4471");
  });
});

describe("line receipt state", () => {
  it("is none, partial, full or over", () => {
    expect(lineReceiptState(10, 0)).toBe("none");
    expect(lineReceiptState(10, 4)).toBe("partial");
    expect(lineReceiptState(10, 10)).toBe("full");
    expect(lineReceiptState(10, 12)).toBe("over");
  });

  it("compares after rounding to 4 decimals", () => {
    // 0.1 + 0.2 = 0.30000000000000004: still exactly the 0.3 ordered.
    expect(lineReceiptState(0.3, 0.1 + 0.2)).toBe("full");
    expect(lineReceiptState(1000, 999.99996)).toBe("full");
    expect(lineReceiptState(1000, 1000.00004)).toBe("full");
    expect(lineReceiptState(1000, 999.9999)).toBe("partial");
    expect(lineReceiptState(1000, 1000.0001)).toBe("over");
    expect(lineReceiptState(10, 0.00004)).toBe("none");
  });

  it("outstanding is never below zero", () => {
    expect(outstanding(10, 4)).toBe(6);
    expect(outstanding(10, 12)).toBe(0);
    expect(outstanding(0.3, 0.1)).toBe(0.2);
    expect(outstanding(0.3, 0.1 + 0.2)).toBe(0);
  });
});

describe("order state", () => {
  it("keeps the stored status for drafts, closed and cancelled orders", () => {
    const lines = [{ quantity: 10, received: 10 }];
    expect(purchaseOrderState({ status: "draft", lines })).toBe("draft");
    expect(purchaseOrderState({ status: "closed", lines })).toBe("closed");
    expect(purchaseOrderState({ status: "cancelled", lines: [] })).toBe("cancelled");
  });

  it("derives sent, part received and received", () => {
    expect(purchaseOrderState({ status: "sent", lines: [] })).toBe("sent");
    expect(
      purchaseOrderState({
        status: "sent",
        lines: [
          { quantity: 10, received: 0 },
          { quantity: 5, received: 0 },
        ],
      }),
    ).toBe("sent");
    expect(
      purchaseOrderState({
        status: "sent",
        lines: [
          { quantity: 10, received: 10 },
          { quantity: 5, received: 0 },
        ],
      }),
    ).toBe("part_received");
    expect(
      purchaseOrderState({
        status: "sent",
        lines: [
          { quantity: 10, received: 3 },
          { quantity: 5, received: 5 },
        ],
      }),
    ).toBe("part_received");
    expect(
      purchaseOrderState({
        status: "sent",
        lines: [
          { quantity: 10, received: 12 },
          { quantity: 0.3, received: 0.1 + 0.2 },
        ],
      }),
    ).toBe("received");
  });
});

describe("prices", () => {
  it("converts a price between units", () => {
    expect(convertUnitPrice(2, "kg", "g")).toBe(0.002);
    expect(convertUnitPrice(3.45, "kg", "g", {}, 8)).toBe(0.00345);
    expect(convertUnitPrice(0.002, "g", "kg")).toBe(2);
    // 1 l of a 1.2 g/ml liquid is 1200 g: £6 per litre is £0.005 per gram.
    expect(convertUnitPrice(6, "l", "g", { densityGPerMl: 1.2 }, 8)).toBe(0.005);
    expect(convertUnitPrice(6, "l", "g")).toBeNull();
  });

  it("values an order and says when a price is missing", () => {
    expect(
      purchaseOrderValue([
        { quantity: 2, unitPrice: 1.5 },
        { quantity: 3, unitPrice: 0.1 },
      ]),
    ).toEqual({ value: 3.3, complete: true });
    expect(
      purchaseOrderValue([
        { quantity: 2, unitPrice: 1.5 },
        { quantity: 3, unitPrice: null },
      ]),
    ).toEqual({ value: 3, complete: false });
    expect(purchaseOrderValue([])).toEqual({ value: 0, complete: true });
  });

  it("keeps 8 decimals on a price per gram, so a gram line values the same as a kilo line", () => {
    const perGram = convertUnitPrice(3.45, "kg", "g", {}, PRICE_DECIMALS);
    expect(PRICE_DECIMALS).toBe(8);
    expect(perGram).toBe(0.00345);
    expect(purchaseOrderValue([{ quantity: 25_000, unitPrice: perGram }]).value).toBe(86.25);
    expect(purchaseOrderValue([{ quantity: 25, unitPrice: 3.45 }]).value).toBe(86.25);
    // Prices are taken to 8 places.
    const line = purchaseOrderLineSchema.parse({
      itemId: uuid(1),
      quantity: 1,
      unit: "g",
      unitPrice: 0.123456789,
    });
    expect(line.unitPrice).toBe(0.12345679);
  });
});

describe("supplier performance", () => {
  const period = { from: "2026-01-01", to: "2026-03-31", today: "2026-02-15" };
  let n = 0;
  const accepted = (receivedOn: string, quantity: number, deliveryId = `d${++n}`): PerformanceReceipt => ({
    outcome: "accepted",
    quantity,
    receivedOn,
    deliveryId,
  });
  const rejected = (receivedOn: string, quantity: number, deliveryId = `d${++n}`): PerformanceReceipt => ({
    outcome: "rejected",
    quantity,
    receivedOn,
    deliveryId,
  });
  const line = (over: Partial<PerformanceLine>): PerformanceLine => ({
    supplierId: "s1",
    lineId: `l${++n}`,
    promisedOn: "2026-02-01",
    quantity: 100,
    orderStatus: "sent",
    receipts: [],
    ...over,
  });
  const one = (lines: PerformanceLine[], p = period) => {
    const rows = supplierPerformance(lines, p);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };

  it("scores on time, in full and OTIF", () => {
    const row = one([
      // On time and in full in one delivery.
      line({ receipts: [accepted("2026-02-01", 100)] }),
      // On time but short; the rest came late: in full, not OTIF.
      line({ receipts: [accepted("2026-01-30", 60), accepted("2026-02-05", 40)] }),
      // Late but in full.
      line({ receipts: [accepted("2026-02-03", 100)] }),
      // Nothing yet, and due.
      line({}),
    ]);
    expect(row).toMatchObject({ linesDue: 4, onTime: 2, inFull: 3, otif: 1 });
    expect(row.onTimePercent).toBe(50);
    expect(row.inFullPercent).toBe(75);
    expect(row.otifPercent).toBe(25);
  });

  it("rounds percentages to one decimal", () => {
    const row = one([line({ receipts: [accepted("2026-02-01", 100)] }), line({}), line({})]);
    expect(row.otifPercent).toBe(33.3);
  });

  it("leaves out lines not yet due, outside the period, or without a date", () => {
    const rows = supplierPerformance(
      [
        line({ promisedOn: "2026-02-16" }), // after today
        line({ promisedOn: "2026-03-30" }), // in the period, but not yet due
        line({ promisedOn: "2025-12-31" }), // before the period
        line({ promisedOn: null }),
        line({ promisedOn: "2026-02-15", receipts: [accepted("2026-02-15", 100)] }), // due today
      ],
      period,
    );
    expect(rows).toEqual([expect.objectContaining({ linesDue: 1, onTime: 1, inFull: 1, otif: 1 })]);
  });

  it("caps the period at its end when today is later", () => {
    const row = one([line({ promisedOn: "2026-04-01" }), line({ promisedOn: "2026-03-31" })], {
      ...period,
      today: "2026-06-01",
    });
    expect(row.linesDue).toBe(1);
  });

  it("has null percentages when nothing was due", () => {
    const row = one([line({ promisedOn: "2026-03-01", receipts: [accepted("2026-02-10", 50)] })]);
    expect(row).toMatchObject({ linesDue: 0, deliveries: 1 });
    expect(row.onTimePercent).toBeNull();
    expect(row.inFullPercent).toBeNull();
    expect(row.otifPercent).toBeNull();
  });

  it("counts an order closed short as not in full, and over-delivery as in full", () => {
    const row = one([
      line({ orderStatus: "closed", receipts: [accepted("2026-01-31", 80)] }),
      line({ receipts: [accepted("2026-01-31", 120)] }),
    ]);
    expect(row).toMatchObject({ linesDue: 2, onTime: 2, inFull: 1, otif: 1 });
  });

  it("compares quantities after rounding", () => {
    const row = one([
      line({ quantity: 0.3, receipts: [accepted("2026-01-30", 0.1), accepted("2026-02-01", 0.2)] }),
    ]);
    expect(row).toMatchObject({ inFull: 1, otif: 1 });
  });

  it("leaves out draft orders; a cancelled order's lines are never due, but its deliveries count", () => {
    expect(supplierPerformance([line({ orderStatus: "draft" })], period)).toEqual([]);
    const row = one([
      line({ orderStatus: "cancelled", receipts: [rejected("2026-01-20", 100, "C1")] }),
      line({ orderStatus: "cancelled", receipts: [accepted("2026-01-21", 10, "C2")] }),
    ]);
    expect(row).toMatchObject({ linesDue: 0, deliveries: 2, rejectedDeliveries: 1 });
    expect(row.onTimePercent).toBeNull();
  });

  it("does not count rejected quantities as received, nor a rejection as on time", () => {
    const row = one([line({ receipts: [rejected("2026-01-30", 100), accepted("2026-02-05", 100)] })]);
    expect(row).toMatchObject({ linesDue: 1, onTime: 0, inFull: 1, otif: 0 });
  });

  it("counts deliveries and rejected deliveries by deliveryId, in the period by received date", () => {
    const row = one([
      // One delivery covering two lines: one accepted, one refused.
      line({ receipts: [accepted("2026-02-01", 100, "D1")] }),
      line({ receipts: [rejected("2026-02-01", 100, "D1"), accepted("2026-02-10", 100, "D2")] }),
      // Part accepted, part refused on one line in one delivery.
      line({ receipts: [accepted("2026-02-01", 50, "D3"), rejected("2026-02-01", 50, "D3")] }),
      // Before the period: not counted, though the line is due in it.
      line({ promisedOn: "2026-01-02", receipts: [rejected("2025-12-30", 100, "D4")] }),
      // A line not yet due still has its deliveries counted.
      line({ promisedOn: "2026-03-20", receipts: [rejected("2026-02-12", 10, "D5")] }),
    ]);
    expect(row.deliveries).toBe(4);
    expect(row.rejectedDeliveries).toBe(3);
  });

  it("returns one row per supplier", () => {
    const rows = supplierPerformance(
      [line({ supplierId: "a" }), line({ supplierId: "b" }), line({ supplierId: "a" })],
      period,
    );
    expect(rows.map((r) => [r.supplierId, r.linesDue])).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
  });
});

describe("purchase suggestions", () => {
  it("only offers active ingredients and packaging", () => {
    expect(notPurchasableReason({ type: "ingredient", status: "active" })).toBeNull();
    expect(notPurchasableReason({ type: "packaging", status: "active" })).toBeNull();
    expect(notPurchasableReason({ type: "wip", status: "active" })).toBe("made_in_house");
    expect(notPurchasableReason({ type: "finished", status: "archived" })).toBe("made_in_house");
    expect(notPurchasableReason({ type: "ingredient", status: "archived" })).toBe("archived");
    expect(notPurchasableReason({ type: "ingredient", status: "active", deleted: true })).toBe("archived");
  });

  it("suggests the preferred supplier, else the only one, else none", () => {
    expect(
      suggestedSupplier([
        { supplierId: "a", preferred: false },
        { supplierId: "b", preferred: true },
      ]),
    ).toEqual({ supplierId: "b", otherSupplierIds: ["a"] });
    expect(suggestedSupplier([{ supplierId: "a", preferred: false }])).toEqual({
      supplierId: "a",
      otherSupplierIds: [],
    });
    expect(
      suggestedSupplier([
        { supplierId: "a", preferred: false },
        { supplierId: "b", preferred: false },
      ]),
    ).toEqual({ supplierId: null, otherSupplierIds: ["a", "b"] });
    expect(suggestedSupplier([])).toEqual({ supplierId: null, otherSupplierIds: [] });
  });

  it("never suggests or offers a suspended or rejected supplier", () => {
    expect(
      suggestedSupplier([
        { supplierId: "a", preferred: true, status: "suspended" },
        { supplierId: "b", preferred: false, status: "pending" },
        { supplierId: "c", preferred: false, status: "rejected" },
      ]),
    ).toEqual({ supplierId: "b", otherSupplierIds: [] });
  });

  it("subtracts sent orders, lists drafts, and never goes below zero", () => {
    const result = purchaseSuggestions(
      [
        { itemId: "flour", shortfall: 1000, neededBy: "2026-02-01" },
        { itemId: "sugar", shortfall: 500 },
        { itemId: "salt", shortfall: 0 },
      ],
      [
        { itemId: "flour", status: "sent", outstanding: 300 },
        { itemId: "flour", status: "sent", outstanding: 200 },
        { itemId: "flour", status: "draft", outstanding: 400 },
        { itemId: "flour", status: "closed", outstanding: 1000 },
        { itemId: "flour", status: "cancelled", outstanding: 1000 },
        { itemId: "sugar", status: "sent", outstanding: 800 },
      ],
      { flour: [{ supplierId: "mill", preferred: true }] },
    );
    expect(result.groups).toEqual([
      {
        supplierId: "mill",
        suggestions: [
          {
            requirement: { itemId: "flour", shortfall: 1000, neededBy: "2026-02-01" },
            itemId: "flour",
            shortfall: 1000,
            onOrder: 500,
            onDraft: 400,
            toOrder: 500,
            supplierId: "mill",
            otherSupplierIds: [],
          },
        ],
      },
    ]);
    expect(result.covered).toEqual([
      expect.objectContaining({ itemId: "sugar", onOrder: 800, toOrder: 0, supplierId: null }),
    ]);
  });

  it("groups by suggested supplier, with items to choose a supplier for last", () => {
    const result = purchaseSuggestions(
      [
        { itemId: "i1", shortfall: 1 },
        { itemId: "i2", shortfall: 2 },
        { itemId: "i3", shortfall: 3 },
        { itemId: "i4", shortfall: 4 },
      ],
      [],
      {
        i2: [{ supplierId: "s1", preferred: false }],
        i3: [{ supplierId: "s2", preferred: true }],
        i4: [
          { supplierId: "s1", preferred: true },
          { supplierId: "s2", preferred: false },
        ],
      },
    );
    expect(result.groups.map((g) => [g.supplierId, g.suggestions.map((s) => s.itemId)])).toEqual([
      ["s1", ["i2", "i4"]],
      ["s2", ["i3"]],
      [null, ["i1"]],
    ]);
    expect(result.groups[0]!.suggestions[1]!.otherSupplierIds).toEqual(["s2"]);
  });

  it("rounds what to order", () => {
    const result = purchaseSuggestions(
      [{ itemId: "i", shortfall: 0.3 }],
      [{ itemId: "i", status: "sent", outstanding: 0.1 }],
      {},
    );
    expect(result.groups[0]!.suggestions[0]!.toOrder).toBe(0.2);
  });
});

describe("date ranges", () => {
  it("defaults supplier performance to the last 90 days", () => {
    // 90 days, both ends included.
    expect(supplierPerformanceRange({}, "2026-04-01")).toEqual({ from: "2026-01-02", to: "2026-04-01" });
    expect(supplierPerformanceRange({ from: "2026-03-01" }, "2026-04-01")).toEqual({
      from: "2026-03-01",
      to: "2026-04-01",
    });
  });

  it("defaults suggestions to the next 28 days, at most a year", () => {
    expect(purchaseSuggestionsRange({}, "2026-02-01")).toEqual({
      from: "2026-02-01",
      to: "2026-03-01",
      error: null,
    });
    expect(purchaseSuggestionsRange({ to: "2026-01-15" }, "2026-02-01")).toMatchObject({
      from: "2026-01-15",
      error: null,
    });
    expect(purchaseSuggestionsRange({ to: "2028-01-01" }, "2026-02-01").error).toMatch(/year/);
    expect(purchaseSuggestionsQuerySchema.safeParse({ from: "2026-01-01", to: "2027-06-01" }).success).toBe(
      false,
    );
    expect(purchaseSuggestionsQuerySchema.safeParse({ from: "2026-02-01", to: "2026-01-01" }).success).toBe(
      false,
    );
    expect(purchaseSuggestionsQuerySchema.safeParse({ from: "2026-01-01", to: "2026-12-31" }).success).toBe(
      true,
    );
  });
});

describe("schemas", () => {
  const line = { itemId: uuid(1), quantity: 5, unit: "kg" };

  it("creates a draft with or without lines", () => {
    expect(purchaseOrderCreateSchema.parse({ supplierId: uuid(9) }).lines).toEqual([]);
    const parsed = purchaseOrderCreateSchema.parse({
      supplierId: uuid(9),
      supplierReference: "  ",
      lines: [{ ...line, unitPrice: null }],
    });
    expect(parsed.supplierReference).toBeNull();
    expect(parsed.lines[0]!.unitPrice).toBeNull();
    expect(
      purchaseOrderCreateSchema.safeParse({ supplierId: uuid(9), lines: [{ ...line, quantity: 0 }] }).success,
    ).toBe(false);
    expect(
      purchaseOrderCreateSchema.safeParse({ supplierId: uuid(9), lines: [{ ...line, unitPrice: -1 }] })
        .success,
    ).toBe(false);
    expect(
      purchaseOrderCreateSchema.safeParse({ supplierId: uuid(9), lines: Array(201).fill(line) }).success,
    ).toBe(false);
  });

  it("needs something to update and refuses a line listed twice", () => {
    expect(purchaseOrderUpdateSchema.safeParse({}).success).toBe(false);
    expect(purchaseOrderUpdateSchema.safeParse({ notes: "x" }).success).toBe(true);
    expect(purchaseOrderUpdateSchema.safeParse({ lines: [] }).success).toBe(true);
    expect(
      purchaseOrderUpdateSchema.safeParse({
        lines: [
          { ...line, id: uuid(2) },
          { ...line, id: uuid(2) },
        ],
      }).success,
    ).toBe(false);
    expect(
      purchaseOrderUpdateSchema.safeParse({ lines: [line, line, { ...line, id: uuid(2) }] }).success,
    ).toBe(true);
  });

  it("receives accepted and rejected lines with the stock expiry rules", () => {
    const base = { receivedOn: "2026-02-01" };
    const accepted = { lineId: uuid(1), outcome: "accepted", quantity: 5, unit: "kg", locationId: uuid(3) };
    const rejectedLine = { lineId: uuid(1), outcome: "rejected", quantity: 1, unit: "kg", reason: "Damaged" };
    expect(purchaseReceiveSchema.safeParse({ ...base, lines: [accepted, rejectedLine] }).success).toBe(true);
    expect(purchaseReceiveSchema.safeParse({ ...base, lines: [] }).success).toBe(false);
    expect(
      purchaseReceiveSchema.safeParse({ ...base, lines: [{ ...rejectedLine, reason: " " }] }).success,
    ).toBe(false);
    // A rejected line needs no location.
    expect(
      purchaseReceiveSchema.safeParse({ ...base, lines: [{ ...accepted, locationId: undefined }] }).success,
    ).toBe(false);
    const expiry = (over: object) =>
      purchaseReceiveSchema.safeParse({ ...base, lines: [{ ...accepted, ...over }] });
    expect(expiry({ expiresOn: "2026-03-01" }).success).toBe(false);
    expect(expiry({ expiryType: "use_by" }).success).toBe(false);
    expect(expiry({ expiresOn: "2026-01-31", expiryType: "use_by" }).success).toBe(false);
    expect(expiry({ expiresOn: "2026-02-01", expiryType: "use_by", status: "quarantine" }).success).toBe(
      true,
    );
    const issue = expiry({ expiresOn: "2026-01-31", expiryType: "use_by" }).error!.issues[0]!;
    expect(issue.path).toEqual(["lines", 0, "expiresOn"]);
  });

  it("lists orders by state, open by default all", () => {
    expect(purchaseOrderListQuerySchema.parse({}).status).toBe("all");
    expect(purchaseOrderListQuerySchema.parse({ status: "open", limit: "20" })).toMatchObject({ limit: 20 });
    expect(purchaseOrderListQuerySchema.safeParse({ status: "part_received" }).success).toBe(true);
    expect(purchaseOrderListQuerySchema.safeParse({ status: "bogus" }).success).toBe(false);
    expect(purchaseOrderListQuerySchema.safeParse({ from: "2026-02-01", to: "2026-01-01" }).success).toBe(
      false,
    );
  });

  it("creates draft orders from suggestions, each with lines", () => {
    expect(purchaseSuggestionsCreateSchema.safeParse({ orders: [] }).success).toBe(false);
    expect(
      purchaseSuggestionsCreateSchema.safeParse({ orders: [{ supplierId: uuid(9), lines: [] }] }).success,
    ).toBe(false);
    expect(
      purchaseSuggestionsCreateSchema.safeParse({ orders: [{ supplierId: uuid(9), lines: [line] }] }).success,
    ).toBe(true);
  });
});
