import { afterEach, describe, expect, it } from "vitest";
import { connect } from "../testing/harness";

type Session = Awaited<ReturnType<typeof connect>>;
const open: Session[] = [];
async function session(options: Parameters<typeof connect>[0] = {}) {
  const s = await connect(options);
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/** A sent order for 25 kg of flour at 0.80 and 100 boxes at 0.50, with 20 kg of flour received. */
async function sentOrder({ call, fake }: Session) {
  await call("draft_purchase_order", {
    workspace: "acme",
    supplier: "ship",
    expected_on: "2026-11-14",
    lines: [
      { item: "flr-001", quantity: 25, unit: "kg", unit_price: 0.8 },
      { item: "BOX-12", quantity: 100, unit: "each", unit_price: 0.5 },
    ],
  });
  const order = fake.purchasingModule.orders[0]!;
  fake.purchasingModule.send(order.id);
  const flourLine = fake.purchasingModule.lines.find(
    (l) => l.lineNo === 1 && l.purchaseOrderId === order.id,
  )!;
  fake.purchasingModule.receipts.push({
    id: "r1",
    lineId: flourLine.id,
    outcome: "accepted",
    quantity: 20_000,
  });
  return order;
}

describe("supplier invoice tools", () => {
  it("lists, gets and drafts invoices, and has no approval tool", async () => {
    const { client } = await session();
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["list_purchase_invoices", "get_purchase_invoice", "draft_purchase_invoice"]),
    );
    expect(names.some((n) => /approve/.test(n) && /invoice/.test(n))).toBe(false);
    expect(tools.find((t) => t.name === "draft_purchase_invoice")!.description).toMatch(/person's act/);
    expect(tools.find((t) => t.name === "list_purchase_invoices")!.annotations?.readOnlyHint).toBe(true);
  });

  it("drafts an invoice by order reference and line number, and reports the match", async () => {
    const s = await session();
    await sentOrder(s);
    const res = await s.call("draft_purchase_invoice", {
      workspace: "acme",
      supplier: "ship",
      invoice_number: "SI-1001",
      invoice_date: "2026-11-12",
      vat: 4,
      lines: [
        // 25 kg invoiced, 20 kg received: over-invoiced.
        { order: "po-2026-001", order_line: 1, quantity: 25, unit_price: 0.8 },
        { charge: "Carriage", unit_price: 12 },
      ],
    });
    expect(res.isError, JSON.stringify(res.data)).toBe(false);
    expect(res.data).toMatchObject({
      invoiceNumber: "SI-1001",
      status: "draft",
      net: 32,
      gross: 36,
      match: "mismatch",
      orders: ["PO-2026-001"],
    });
    expect(res.data.lines[0]).toMatchObject({
      order: "PO-2026-001",
      orderLine: 1,
      invoiced: 25,
      received: 20,
      match: "mismatch",
      quantityVariance: 5,
      issues: ["Invoiced more than received beyond tolerance"],
    });
    expect(res.data.lines[1]).toMatchObject({ charge: "Carriage", quantity: 1, value: 12 });

    // Edit by invoice number: lines are replaced.
    const edited = await s.call("draft_purchase_invoice", {
      workspace: "acme",
      invoice_id: res.data.id,
      lines: [{ order: "PO-2026-001", order_line: 1, quantity: 20, unit_price: 0.8 }],
    });
    expect(edited.data).toMatchObject({ match: "matched", net: 16 });

    const got = await s.call("get_purchase_invoice", { workspace: "acme", invoice: "si-1001" });
    expect(got.data).toMatchObject({ id: res.data.id, match: "matched" });
    const listed = await s.call("list_purchase_invoices", { workspace: "acme", order: "PO-2026-001" });
    expect(listed.data).toMatchObject({ total: 1, invoices: [{ invoiceNumber: "SI-1001" }] });
  });

  it("corrects an approved invoice as a new version", async () => {
    const s = await session();
    await sentOrder(s);
    const created = await s.call("draft_purchase_invoice", {
      workspace: "acme",
      supplier: "ship",
      invoice_number: "SI-2",
      invoice_date: "2026-11-12",
      lines: [{ order: "PO-2026-001", order_line: 1, quantity: 20, unit_price: 0.8 }],
    });
    s.fake.purchaseInvoicesModule.approve(created.data.id);
    const refused = await s.call("draft_purchase_invoice", {
      workspace: "acme",
      invoice_id: created.data.id,
      notes: "x",
    });
    expect(refused.data.error.code).toBe("invoice_not_draft");
    const corrected = await s.call("draft_purchase_invoice", {
      workspace: "acme",
      invoice_id: created.data.id,
      correct: true,
      lines: [{ order: "PO-2026-001", order_line: 1, quantity: 20, unit_price: 0.79 }],
    });
    expect(corrected.data).toMatchObject({ version: 2, status: "draft", invoiceNumber: "SI-2" });
    expect(corrected.data.lines[0]).toMatchObject({ unitPrice: 0.79, priceVariance: -0.01 });
  });

  it("leaves no orphan correction when the changes are refused, and retries onto a pending one", async () => {
    const s = await session();
    const order = await sentOrder(s);
    const created = await s.call("draft_purchase_invoice", {
      workspace: "acme",
      supplier: "ship",
      invoice_number: "SI-4",
      invoice_date: "2026-11-12",
      lines: [{ order: "PO-2026-001", order_line: 1, quantity: 20, unit_price: 0.8 }],
    });
    s.fake.purchaseInvoicesModule.approve(created.data.id);
    const drafts = () => s.fake.purchaseInvoicesModule.invoices.filter((i) => i.status === "draft");

    // The order is cancelled meanwhile: the PATCH is refused after the revision was drafted.
    s.fake.purchasingModule.orders.find((o) => o.id === order.id)!.status = "cancelled";
    const refused = await s.call("draft_purchase_invoice", {
      workspace: "acme",
      invoice_id: created.data.id,
      correct: true,
      lines: [{ order_line_id: s.fake.purchasingModule.lines[0]!.id, quantity: 20, unit_price: 0.79 }],
    });
    expect(refused.data.error.code).toBe("order_not_invoiceable");
    expect(drafts()).toHaveLength(0);

    // A correction already pending (an earlier attempt that got further) takes the changes.
    s.fake.purchasingModule.orders.find((o) => o.id === order.id)!.status = "sent";
    const first = await s.call("draft_purchase_invoice", {
      workspace: "acme",
      invoice_id: created.data.id,
      correct: true,
      notes: "first try",
    });
    expect(first.data).toMatchObject({ version: 2, status: "draft" });
    const retry = await s.call("draft_purchase_invoice", {
      workspace: "acme",
      invoice_id: created.data.id,
      correct: true,
      lines: [{ order: "PO-2026-001", order_line: 1, quantity: 20, unit_price: 0.79 }],
    });
    expect(retry.isError, JSON.stringify(retry.data)).toBe(false);
    expect(retry.data).toMatchObject({ id: first.data.id, version: 2, notes: "first try" });
    expect(drafts()).toHaveLength(1);
  });

  it("keeps no stray revision when a correction can't be applied", async () => {
    const s = await session();
    await sentOrder(s);
    const created = await s.call("draft_purchase_invoice", {
      workspace: "acme",
      supplier: "ship",
      invoice_number: "SI-4",
      invoice_date: "2026-11-12",
      lines: [{ order: "PO-2026-001", order_line: 1, quantity: 20, unit_price: 0.8 }],
    });
    s.fake.purchaseInvoicesModule.approve(created.data.id);
    const renamed = await s.call("draft_purchase_invoice", {
      workspace: "acme",
      invoice_id: created.data.id,
      correct: true,
      invoice_number: "SI-5",
    });
    expect(renamed.data.error.code).toBe("invalid_input");
    const failed = await s.call("draft_purchase_invoice", {
      workspace: "acme",
      invoice_id: created.data.id,
      correct: true,
      lines: [{ order_line_id: "00000000-0000-0000-0000-000000000000", quantity: 1, unit_price: 1 }],
    });
    expect(failed.data.error.code).toBe("not_found");
    expect(s.fake.purchaseInvoicesModule.invoices.filter((i) => i.invoiceNumber === "SI-4")).toHaveLength(1);
  });

  it("explains what a line needs", async () => {
    const s = await session();
    const res = await s.call("draft_purchase_invoice", {
      workspace: "acme",
      supplier: "ship",
      invoice_number: "SI-3",
      invoice_date: "2026-11-12",
      lines: [{ quantity: 1, unit_price: 1 }],
    });
    expect(res.data.error.code).toBe("invalid_input");
  });
});
