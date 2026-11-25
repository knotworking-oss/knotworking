import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

/**
 * Non-stock purchasing: order lines for services, subscriptions and goods not kept in stock work
 * without the stock module (purchasing depends only on items; stock enhances it). They are received
 * without a lot or stock movement, matched on invoices against what was received, credited, and
 * counted in supplier performance; costing never sees them. Stock lines need stock.
 */

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

async function ok(res: Res, status = 200) {
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  return body;
}
async function refused(res: Res, status: number, code?: string) {
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  if (code) expect(body.error.code).toBe(code);
  return body.error as { code: string; message: string };
}

const cleaning = {
  kind: "non_stock",
  description: "Window cleaning",
  quantity: 4,
  unit: "visit",
  unitPrice: 50,
  nominalCode: "7500",
};

describe("non-stock purchasing with only items and purchasing", () => {
  let ctx: TestCtx;
  let cookie: string;
  const get = (path: string) => ctx.req(`${WS}${path}`, { cookie });
  const send = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  let supplier: string;
  let po: string;
  let lineId: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, activeModules: ["tasks", "docs", "items", "purchasing"] });
    cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    supplier = (await ok(await send("POST", "/suppliers", { name: "Sparkle Cleaning" }), 201)).id;
  }, 60_000);
  afterAll(() => ctx?.handle.close());

  it("lists purchasing without stock, which only enhances it", async () => {
    const { modules: listed } = await ok(await get("/modules"));
    const purchasing = listed.find((m: { id: string }) => m.id === "purchasing");
    expect(purchasing).toMatchObject({ dependsOn: ["items"] });
    expect(purchasing.enhancedBy).toContain("stock");
    expect(listed.map((m: { id: string }) => m.id)).not.toContain("stock");
  });

  it("drafts and sends an order of non-stock lines", async () => {
    const created = await ok(
      await send("POST", "/purchasing/orders", {
        supplierId: supplier,
        expectedOn: today,
        lines: [cleaning],
      }),
      201,
    );
    po = created.id;
    const [line] = created.lines;
    lineId = line.id;
    expect(line).toMatchObject({
      kind: "non_stock",
      itemId: null,
      item: null,
      description: "Window cleaning",
      unit: null,
      unitLabel: "visit",
      nominalCode: "7500",
      quantity: 4,
      unitPrice: 50,
      ordered: { base: 4, display: 4, displayUnit: "visit", inLineUnit: 4 },
      lineValue: 200,
    });
    expect(created).toMatchObject({ value: 200, valueComplete: true, deliveryLocation: null });
    const sent = await ok(await send("POST", `/purchasing/orders/${po}/send`, {}));
    expect(sent).toMatchObject({ status: "sent", state: "sent" });
    expect(sent.lines[0].promisedOn).toBe(today);
  });

  it("refuses stock lines and delivery locations while stock is off", async () => {
    const items = await ok(
      await send("POST", "/items", { code: "FLR", name: "Flour", type: "ingredient", unit: "kg" }),
      201,
    );
    await refused(
      await send("POST", "/purchasing/orders", {
        supplierId: supplier,
        lines: [{ itemId: items.id, quantity: 1, unit: "kg" }],
      }),
      404,
      "module_inactive",
    );
    await refused(
      await send("POST", "/purchasing/orders", {
        supplierId: supplier,
        deliveryLocationId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      }),
      404,
      "module_inactive",
    );
    // An item may still be named on a non-stock line, as a reference.
    const referenced = await ok(
      await send("POST", "/purchasing/orders", {
        supplierId: supplier,
        lines: [{ kind: "non_stock", itemId: items.id, description: "Flour for the canteen", quantity: 2 }],
      }),
      201,
    );
    expect(referenced.lines[0]).toMatchObject({ kind: "non_stock", itemId: items.id, item: { code: "FLR" } });
    expect((await send("DELETE", `/purchasing/orders/${referenced.id}`)).status).toBe(204);
  });

  it("keeps omitted non-stock metadata on edits, including after receipt", async () => {
    const item = await ok(
      await send("POST", "/items", {
        code: "NS-EDIT",
        name: "Cleaning supplies",
        type: "packaging",
        unit: "each",
      }),
      201,
    );
    const other = await ok(await send("POST", "/suppliers", { name: "Service metadata supplier" }), 201);
    const draft = await ok(
      await send("POST", "/purchasing/orders", {
        supplierId: other.id,
        expectedOn: today,
        lines: [{ ...cleaning, itemId: item.id }],
      }),
      201,
    );
    const path = `/purchasing/orders/${draft.id}`;
    const id = draft.lines[0].id;
    const edit = { id, kind: "non_stock", description: "Updated cleaning", quantity: 5 };
    const revised = await ok(await send("PATCH", path, { lines: [edit] }));
    expect(revised.lines[0]).toMatchObject({ itemId: item.id, unitLabel: "visit", nominalCode: "7500" });
    await ok(await send("POST", `${path}/send`, {}));
    await ok(
      await send("POST", `${path}/receipts`, {
        receivedOn: today,
        lines: [{ lineId: id, quantity: 1, outcome: "accepted" }],
      }),
      201,
    );
    const revisedAgain = await ok(await send("PATCH", path, { lines: [{ ...edit, quantity: 6 }] }));
    expect(revisedAgain.lines[0]).toMatchObject({ itemId: item.id, unitLabel: "visit", nominalCode: "7500" });
    await refused(await send("PATCH", path, { lines: [{ ...edit, unit: null }] }), 409, "line_has_receipts");
    const cleared = await ok(
      await send("PATCH", path, { lines: [{ ...edit, itemId: null, nominalCode: null }] }),
    );
    expect(cleared.lines[0]).toMatchObject({ itemId: null, unitLabel: "visit", nominalCode: null });
  });

  it("receives in part and in full without lots, refusing stock fields", async () => {
    await refused(
      await send("POST", `/purchasing/orders/${po}/receipts`, {
        receivedOn: today,
        lines: [{ lineId, outcome: "accepted", quantity: 1, unit: "each" }],
      }),
      400,
    );
    await refused(
      await send("POST", `/purchasing/orders/${po}/receipts`, {
        receivedOn: today,
        lines: [
          { lineId, outcome: "accepted", quantity: 1, locationId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" },
        ],
      }),
      400,
    );
    const part = await ok(
      await send("POST", `/purchasing/orders/${po}/receipts`, {
        receivedOn: today,
        deliveryReference: "JOB-1",
        lines: [{ lineId, outcome: "accepted", quantity: 3 }],
      }),
      201,
    );
    expect(part.receipts[0]).toMatchObject({
      kind: "non_stock",
      outcome: "accepted",
      lotId: null,
      lotCode: null,
      stockMovementId: null,
      unitPrice: 50,
      quantity: { base: 3, displayUnit: "visit" },
    });
    expect(part.order.state).toBe("part_received");
    expect(part.order.lines[0]).toMatchObject({ state: "partial", outstanding: { base: 1 } });

    const rest = await ok(
      await send("POST", `/purchasing/orders/${po}/receipts`, {
        receivedOn: today,
        lines: [{ lineId, outcome: "accepted", quantity: 1 }],
      }),
      201,
    );
    expect(rest.order.state).toBe("received");
    expect(rest.order.lines[0]).toMatchObject({ state: "full", received: { base: 4 } });
    expect(rest.order.deliveries).toHaveLength(2);
  });

  it("voids a non-stock receipt recorded in error", async () => {
    const extra = await ok(
      await send("POST", `/purchasing/orders/${po}/receipts`, {
        receivedOn: today,
        lines: [{ lineId, outcome: "accepted", quantity: 2 }],
      }),
      201,
    );
    expect(extra.order.lines[0].state).toBe("over");
    const voided = await ok(
      await send("POST", `/purchasing/orders/${po}/receipts/${extra.receipts[0].id}/void`, {
        reason: "Recorded twice",
      }),
    );
    expect(voided.lines[0]).toMatchObject({ state: "full", received: { base: 4 } });
    expect(voided.state).toBe("received");
  });

  it("matches an invoice against what was received, approves and credits it", async () => {
    const invoice = await ok(
      await send("POST", "/purchasing/invoices", {
        supplierId: supplier,
        invoiceNumber: "SC-100",
        invoiceDate: today,
        vat: 40,
        lines: [{ kind: "order", orderLineId: lineId, quantity: 4, unitPrice: 50 }],
      }),
      201,
    );
    expect(invoice).toMatchObject({ net: 200, gross: 240, matchStatus: "matched" });
    expect(invoice.lines[0]).toMatchObject({
      kind: "order",
      unit: null,
      description: "Window cleaning",
      item: null,
      received: 4,
      invoicedElsewhere: 0,
      orderLine: { id: lineId, kind: "non_stock", unitLabel: "visit", nominalCode: "7500", unitPrice: 50 },
      match: { status: "matched" },
    });
    // Invoicing more than was received is a mismatch, as for stock lines.
    const over = await ok(
      await send("POST", "/purchasing/invoices", {
        supplierId: supplier,
        invoiceNumber: "SC-101",
        invoiceDate: today,
        lines: [{ kind: "order", orderLineId: lineId, quantity: 6, unitPrice: 50 }],
      }),
      201,
    );
    expect(over.lines[0].match.status).toBe("mismatch");
    expect((await send("DELETE", `/purchasing/invoices/${over.id}`)).status).toBe(204);

    const approved = await ok(await send("POST", `/purchasing/invoices/${invoice.id}/approve`, {}));
    expect(approved).toMatchObject({ status: "approved", approvedMatchStatus: "matched" });
    expect(approved.lines[0].match.status).toBe("matched");

    // The order line is now fixed like a received stock line.
    await refused(
      await send("PATCH", `/purchasing/orders/${po}`, {
        lines: [{ ...cleaning, id: lineId, unitPrice: 60 }],
      }),
      409,
      "line_invoiced",
    );

    const credit = await ok(
      await send("POST", "/purchasing/credit-notes", {
        invoiceId: invoice.id,
        creditNoteNumber: "CN-1",
        creditDate: today,
        lines: [
          {
            kind: "invoice_line",
            invoiceLineId: approved.lines[0].id,
            reason: "price",
            quantity: 4,
            unitPrice: 5,
          },
        ],
      }),
      201,
    );
    expect(credit.lines[0]).toMatchObject({
      unitLabel: "visit",
      value: 20,
      invoiceLine: { description: "Window cleaning" },
    });
  });

  it("counts non-stock lines in supplier performance", async () => {
    const perf = await ok(await get(`/purchasing/supplier-performance?supplierId=${supplier}`));
    expect(perf.suppliers).toHaveLength(1);
    expect(perf.suppliers[0]).toMatchObject({
      linesDue: 1,
      onTime: 1,
      inFull: 1,
      otif: 1,
      deliveries: 2,
      rejectedDeliveries: 0,
      qualityFlag: null,
    });
  });

  it("refuses suggestions: they come from production's shortfall", async () => {
    await refused(await get("/purchasing/suggestions"), 409, "production_unavailable");
  });
});

describe("stock and non-stock lines with every module on", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  let mill: string;
  let flour: string;
  let store: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await ok(await ctx.req(`${WS}/members`, { cookie: ada }));
    marcus = {
      userId: members.find((x: { email: string }) => x.email === "marcus@knotworking.dev").userId,
      cookie: (await signIn(ctx, "marcus@knotworking.dev")).cookie,
    };
    mill = (await ok(await as(ada).send("POST", "/suppliers", { name: "Mill" }), 201)).id;
    await ok(await as(ada).send("POST", `/suppliers/${mill}/approval`, { status: "approved" }));
    flour = (
      await ok(
        await as(ada).send("POST", "/items", {
          code: "FLR",
          name: "Flour",
          type: "ingredient",
          unit: "kg",
          standardCost: 0.8,
          shelfLifeDays: 270,
        }),
        201,
      )
    ).id;
    store = (await ok(await as(ada).send("POST", "/stock/locations", { name: "Store" }), 201)).id;
  }, 60_000);
  afterAll(() => ctx?.handle.close());

  it("refuses stock lines to a member who can't read stock; non-stock lines are fine", async () => {
    const grant = (moduleId: string, level: string | null) =>
      as(ada).send("PUT", `/members/${marcus.userId}/module-access/${moduleId}`, { level });
    await ok(await grant("items", "read"));
    await ok(await grant("purchasing", "write"));
    await refused(
      await as(marcus.cookie).send("POST", "/purchasing/orders", {
        supplierId: mill,
        lines: [{ itemId: flour, quantity: 1, unit: "kg" }],
      }),
      403,
      "module_forbidden",
    );
    const created = await ok(
      await as(marcus.cookie).send("POST", "/purchasing/orders", { supplierId: mill, lines: [cleaning] }),
      201,
    );
    expect(created.lines[0].kind).toBe("non_stock");
  });

  it("receives a mixed order: the stock line into a lot, the non-stock line without one", async () => {
    const created = await ok(
      await as(ada).send("POST", "/purchasing/orders", {
        supplierId: mill,
        expectedOn: today,
        deliveryLocationId: store,
        lines: [
          { itemId: flour, quantity: 25, unit: "kg" },
          { kind: "non_stock", itemId: flour, description: "Flour haulage", quantity: 1, unitPrice: 30 },
        ],
      }),
      201,
    );
    const [stockLine, haulage] = created.lines;
    expect(stockLine).toMatchObject({ kind: "stock", quantity: 25_000, unit: "kg", unitPrice: 0.8 });
    expect(haulage).toMatchObject({ kind: "non_stock", quantity: 1, unit: null, unitLabel: null });
    expect(created.value).toBe(50);
    await ok(await as(ada).send("POST", `/purchasing/orders/${created.id}/send`, {}));

    // The location defaults to the order's and the unit to the line's.
    const received = await ok(
      await as(ada).send("POST", `/purchasing/orders/${created.id}/receipts`, {
        receivedOn: today,
        lines: [
          { lineId: stockLine.id, outcome: "accepted", quantity: 25 },
          { lineId: haulage.id, outcome: "accepted", quantity: 1 },
        ],
      }),
      201,
    );
    const [lotReceipt, haulageReceipt] = received.receipts;
    expect(lotReceipt).toMatchObject({ kind: "stock", quantity: { base: 25_000, inLineUnit: 25 } });
    expect(lotReceipt.lotId).toBeTruthy();
    expect(haulageReceipt).toMatchObject({ kind: "non_stock", lotId: null, stockMovementId: null });
    expect(received.order.state).toBe("received");

    // Stock receipts are corrected in stock, never voided.
    await refused(
      await as(ada).send("POST", `/purchasing/orders/${created.id}/receipts/${lotReceipt.id}/void`, {
        reason: "Wrong",
      }),
      409,
      "receipt_not_rejected",
    );

    // Costing only sees the lot: the haulage line, invoiced at a different price, never reaches it.
    const before = await ok(await as(ada).get(`/costing/lots/${lotReceipt.lotId}`));
    const invoice = await ok(
      await as(ada).send("POST", "/purchasing/invoices", {
        supplierId: mill,
        invoiceNumber: "M-1",
        invoiceDate: today,
        lines: [
          { kind: "order", orderLineId: stockLine.id, quantity: 25, unitPrice: 0.8 },
          { kind: "order", orderLineId: haulage.id, quantity: 1, unitPrice: 45 },
        ],
      }),
      201,
    );
    expect(invoice.lines[1]).toMatchObject({ received: 1, item: { id: flour } });
    expect(invoice.lines[1].match.priceStatus).toBe("mismatch");
    await ok(
      await as(ada).send("POST", `/purchasing/invoices/${invoice.id}/approve`, { reason: "Fuel surcharge" }),
    );
    const after = await ok(await as(ada).get(`/costing/lots/${lotReceipt.lotId}`));
    expect(after.receipts).toHaveLength(1);
    expect(after.receipts[0]).toMatchObject({ unitPrice: 0.8, invoicePrice: 0.8 });
    expect(after.unitCost).toBe(0.8);
    expect(before.receipts).toHaveLength(1);
  });

  it("finds orders by an item a non-stock line names", async () => {
    const { lines } = await ok(
      await as(ada).send("POST", "/purchasing/orders", {
        supplierId: mill,
        lines: [{ kind: "non_stock", itemId: flour, description: "Flour sample", quantity: 1000 }],
      }),
      201,
    );
    expect(lines[0].kind).toBe("non_stock");
    const listed = await ok(await as(ada).get(`/purchasing/orders?itemId=${flour}&status=draft`));
    expect(listed.total).toBeGreaterThan(0);
  });

  it("changes a line between kinds only while nothing refers to it", async () => {
    const draft = await ok(
      await as(ada).send("POST", "/purchasing/orders", { supplierId: mill, lines: [cleaning] }),
      201,
    );
    const line = draft.lines[0];
    const changed = await ok(
      await as(ada).send("PATCH", `/purchasing/orders/${draft.id}`, {
        lines: [{ id: line.id, itemId: flour, quantity: 2, unit: "kg" }],
      }),
    );
    expect(changed.lines[0]).toMatchObject({
      id: line.id,
      kind: "stock",
      quantity: 2000,
      description: null,
      unitLabel: null,
      nominalCode: null,
    });
  });
});
