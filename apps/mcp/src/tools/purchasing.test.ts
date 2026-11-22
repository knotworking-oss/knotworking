import { afterEach, describe, expect, it } from "vitest";
import { createFakeApi } from "../testing/fake-api";
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

const draft = (call: Session["call"], extra: Record<string, unknown> = {}) =>
  call("draft_purchase_order", {
    workspace: "acme",
    supplier: "ship",
    expected_on: "2026-11-14",
    lines: [
      { item: "flr-001", quantity: 25, unit: "kg", unit_price: 0.8 },
      { item: "BOX-12", quantity: 100, unit: "each" },
    ],
    ...extra,
  });

describe("purchasing tools", () => {
  it("offers no send, close or cancel tools until an owner or admin allows them", async () => {
    const { client } = await session();
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_purchase_orders",
        "get_purchase_order",
        "draft_purchase_order",
        "receive_purchase_order",
        "suggest_purchase_orders",
        "supplier_performance",
        "list_supplier_prices",
      ]),
    );
    expect(names.some((n) => /send|email|close|cancel/.test(n) && /purchase/.test(n))).toBe(false);
    const description = tools.find((t) => t.name === "draft_purchase_order")!.description!;
    expect(description).toMatch(/replaces the whole list/);
    expect(description).toMatch(/person/);
    expect(description).toMatch(/unless an owner or admin allows it under Settings → API access/);
  });

  describe("send, close and cancel (API access)", () => {
    const gated = [
      "send_purchase_order",
      "email_purchase_order",
      "close_purchase_order",
      "cancel_purchase_order",
    ];

    it("appear only for the actions that are enabled", async () => {
      const some = await session({ enable: ["purchasing.close"] });
      const names = (await some.client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("close_purchase_order");
      expect(names).not.toContain("send_purchase_order");
      expect(names).not.toContain("cancel_purchase_order");

      const all = await session({ enable: ["purchasing.send", "purchasing.close", "purchasing.cancel"] });
      const tools = (await all.client.listTools()).tools;
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(gated));
      for (const name of gated) {
        const t = tools.find((x) => x.name === name)!;
        expect(t.description, name).toMatch(
          /owner or admin allowed API tokens .* under Settings → API access/,
        );
        expect(t.annotations?.readOnlyHint, name).toBe(false);
      }
      expect(tools.find((t) => t.name === "send_purchase_order")!.description).toMatch(/manage access/);
      expect(tools.find((t) => t.name === "close_purchase_order")!.description).toMatch(/write access/);
    });

    it("hide the tools when the actions can't be read (fail closed)", async () => {
      const fake = createFakeApi();
      fake.tokenActions.add("purchasing.send");
      fake.hooks.failTokenActions = true;
      const { client } = await session({ fake });
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const name of gated) expect(names).not.toContain(name);
    });

    it("sends a draft by reference, with the date and the supplier's reference", async () => {
      const { call, fake } = await session({ enable: ["purchasing.send"] });
      await draft(call);
      const res = await call("send_purchase_order", {
        workspace: "acme",
        order_id: "po-2026-001",
        ordered_on: "2026-11-10",
        supplier_reference: "SO-77",
      });
      expect(res.isError).toBe(false);
      expect(res.data).toMatchObject({
        reference: "PO-2026-001",
        state: "sent",
        orderedOn: "2026-11-10",
        supplierReference: "SO-77",
      });
      expect(fake.requests.at(-1)).toMatchObject({
        method: "POST",
        path: `/v1/workspaces/acme/purchasing/orders/${fake.purchasingModule.orders[0]!.id}/send`,
      });
      const again = await call("send_purchase_order", { workspace: "acme", order_id: "PO-2026-001" });
      expect(again.data.error.code).toBe("not_draft");
    });

    it("closes a sent order and cancels a draft, each with its reason", async () => {
      const { call, fake } = await session({ enable: ["purchasing.close", "purchasing.cancel"] });
      await draft(call);
      await draft(call);
      const [first, second] = fake.purchasingModule.orders;
      fake.purchasingModule.send(first!.id);

      const closed = await call("close_purchase_order", {
        workspace: "acme",
        order_id: first!.id,
        reason: "Supplier short-shipped",
      });
      expect(closed.data).toMatchObject({
        reference: "PO-2026-001",
        state: "closed",
        closeReason: "Supplier short-shipped",
      });
      expect(
        (await call("close_purchase_order", { workspace: "acme", order_id: "PO-2026-002", reason: "x" })).data
          .error.code,
      ).toBe("order_not_open");

      const cancelled = await call("cancel_purchase_order", {
        workspace: "acme",
        order_id: "PO-2026-002",
        reason: "Ordered twice",
      });
      expect(cancelled.data).toMatchObject({
        reference: "PO-2026-002",
        state: "cancelled",
        cancelReason: "Ordered twice",
      });
      expect(second!.status).toBe("cancelled");
      expect(fake.requests.at(-1)).toMatchObject({ method: "POST" });
      expect(fake.requests.at(-1)!.path).toMatch(/\/purchasing\/orders\/[^/]+\/cancel$/);

      const noReason = await call("cancel_purchase_order", { workspace: "acme", order_id: "PO-2026-002" });
      expect(noReason.isError).toBe(true);
    });

    it("emails a sent order to the supplier's address or to another, and logs it", async () => {
      const { call, fake } = await session({ enable: ["purchasing.send"] });
      await draft(call);
      const order = fake.purchasingModule.orders[0]!;

      const early = await call("email_purchase_order", { workspace: "acme", order_id: "PO-2026-001" });
      expect(early.data.error.code).toBe("order_not_sent");

      fake.purchasingModule.send(order.id);
      const noAddress = await call("email_purchase_order", { workspace: "acme", order_id: "PO-2026-001" });
      expect(noAddress.data.error.code).toBe("no_supplier_email");

      const sent = await call("email_purchase_order", {
        workspace: "acme",
        order_id: "po-2026-001",
        to: "orders@shipton.example",
        message: "Please confirm the date",
      });
      expect(sent.isError).toBe(false);
      expect(sent.data).toMatchObject({
        emailed: true,
        to: "orders@shipton.example",
        order: "PO-2026-001",
        emails: [{ to: "orders@shipton.example", status: "sent" }],
      });
      expect(fake.requests.at(-1)).toMatchObject({
        method: "POST",
        path: `/v1/workspaces/acme/purchasing/orders/${order.id}/email`,
      });

      fake.purchasingModule.state.mailError = "The email couldn't be sent (connection refused).";
      const failed = await call("email_purchase_order", {
        workspace: "acme",
        order_id: "PO-2026-001",
        to: "orders@shipton.example",
      });
      expect(failed.isError).toBe(false);
      expect(failed.data).toMatchObject({
        emailed: false,
        problem: expect.stringContaining("connection refused"),
        emails: [{ status: "failed" }, { status: "sent" }],
      });
    });

    it("hides email_purchase_order without the send switch, and the switch gates the route", async () => {
      const without = await session({ enable: ["purchasing.close"] });
      expect((await without.client.listTools()).tools.map((t) => t.name)).not.toContain(
        "email_purchase_order",
      );
      const { call, fake } = await session({ enable: ["purchasing.send"] });
      await draft(call);
      fake.purchasingModule.send(fake.purchasingModule.orders[0]!.id);
      fake.tokenActions.delete("purchasing.send");
      const res = await call("email_purchase_order", {
        workspace: "acme",
        order_id: "PO-2026-001",
        to: "a@b.example",
      });
      expect(res.data.error.code).toBe("token_not_allowed");
    });

    it("surfaces the API's token_not_allowed refusal readably when the action was switched off", async () => {
      const { call, fake } = await session({ enable: ["purchasing.send"] });
      await draft(call);
      fake.tokenActions.delete("purchasing.send"); // an admin switched it off after the tool list was read
      const res = await call("send_purchase_order", { workspace: "acme", order_id: "PO-2026-001" });
      expect(res.isError).toBe(true);
      expect(res.data.error).toMatchObject({
        code: "token_not_allowed",
        status: 403,
        message: expect.stringContaining(
          'unless an owner or admin allows "Send purchase orders" under Settings → API access',
        ),
      });
      expect(fake.purchasingModule.orders[0]!.status).toBe("draft");
    });
  });

  it("lists supplier prices by supplier name and item code, and by date", async () => {
    const { call, fake } = await session();
    const supplier = fake.itemsModule.suppliers.find((x) => x.code === "SHIP")!;
    const item = fake.itemsModule.items.find((i) => i.code === "FLR-001")!;
    const entry = (over: Record<string, unknown>) => ({
      id: crypto.randomUUID(),
      supplier: { id: supplier.id, name: supplier.name },
      item: { id: item.id, code: item.code, name: item.name },
      unit: "kg",
      notes: null,
      ...over,
    });
    fake.purchasingModule.state.prices.push(
      entry({ unitPrice: 0.75, effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30", inForce: false }),
      entry({ unitPrice: 0.8, effectiveFrom: "2026-07-01", effectiveTo: null, inForce: true }),
    );
    const all = await call("list_supplier_prices", { workspace: "acme", supplier: "shipton mill" });
    expect(all.isError).toBe(false);
    expect(all.data.total).toBe(2);
    expect(all.data.prices[1]).toMatchObject({
      supplier: supplier.name,
      item: `${item.code} ${item.name}`,
      price: 0.8,
      unit: "kg",
      effectiveFrom: "2026-07-01",
      effectiveTo: null,
      inForce: true,
    });
    const onDate = await call("list_supplier_prices", {
      workspace: "acme",
      item: "flr-001",
      on: "2026-03-01",
    });
    expect(onDate.data.prices.map((p: { price: number }) => p.price)).toEqual([0.75]);
    const unknown = await call("list_supplier_prices", { workspace: "acme", supplier: "Nobody Ltd" });
    expect(unknown.data.error.code).toBe("not_found");
  });

  it("drafts an order by supplier name and item codes, then reads it back by reference", async () => {
    const { call } = await session();
    const res = await draft(call, { notes: "Urgent" });
    expect(res.data).toMatchObject({
      reference: "PO-2026-001",
      state: "draft",
      supplier: "Shipton Mill (SHIP)",
      expectedOn: "2026-11-14",
      lines: 2,
      value: 20,
      valueComplete: false,
      notes: "Urgent",
    });
    expect(res.data.orderLines[0]).toMatchObject({
      line: 1,
      item: "FLR-001 Strong white flour",
      ordered: "25 kg",
      outstanding: "25 kg",
      unitPrice: 0.8,
      supplierListed: true,
    });
    expect(res.data.orderLines[1]).toMatchObject({ item: "BOX-12 Cake box", supplierListed: false });

    const got = await call("get_purchase_order", { workspace: "acme", order_id: "po-2026-001" });
    expect(got.data.orderLines).toHaveLength(2);
    // Promised when a person sends it.
    expect(got.data.orderLines[0].promisedOn).toBeNull();
    const listed = await call("list_purchase_orders", { workspace: "acme", status: "draft" });
    expect(listed.data).toMatchObject({ total: 1, orders: [{ reference: "PO-2026-001", state: "draft" }] });
    expect((await call("list_purchase_orders", { workspace: "acme", supplier: "Dairy Co" })).data.total).toBe(
      0,
    );
    expect(
      (await call("get_purchase_order", { workspace: "acme", order_id: "PO-2026-099" })).data.error.code,
    ).toBe("not_found");
  });

  it("refuses bad drafts with the API's reason", async () => {
    const { call } = await session();
    expect((await call("draft_purchase_order", { workspace: "acme" })).data.error.code).toBe("invalid_input");
    expect((await draft(call, { lines: [{ item: "NOPE", quantity: 1, unit: "kg" }] })).data.error.code).toBe(
      "not_found",
    );
    expect(
      (await draft(call, { lines: [{ item: "FLR-001", quantity: 1, unit: "l" }] })).data.error.code,
    ).toBe("unit_not_convertible");
  });

  it("edits an order: lines replace the list and a line id keeps its line", async () => {
    const { call } = await session();
    const created = await draft(call);
    const flourId = created.data.orderLines[0].id;
    const edited = await call("draft_purchase_order", {
      workspace: "acme",
      order_id: "PO-2026-001",
      notes: "Changed",
      lines: [{ id: flourId, item: "FLR-001", quantity: 30, unit: "kg" }],
    });
    expect(edited.data).toMatchObject({ notes: "Changed", lines: 1 });
    expect(edited.data.orderLines[0]).toMatchObject({ id: flourId, ordered: "30 kg", unitPrice: 0.8 });

    const nothing = await call("draft_purchase_order", { workspace: "acme", order_id: "PO-2026-001" });
    expect(nothing.data.error.code).toBe("invalid_input");
    const withId = await call("draft_purchase_order", {
      workspace: "acme",
      supplier: "SHIP",
      lines: [{ id: flourId, item: "FLR-001", quantity: 1, unit: "kg" }],
    });
    expect(withId.data.error.code).toBe("invalid_input");
  });

  it("receives accepted and rejected lines, and a pending supplier only into quarantine", async () => {
    const { call, fake } = await session();
    await draft(call);
    const order = fake.purchasingModule.orders[0]!;

    expect(
      (
        await call("receive_purchase_order", {
          workspace: "acme",
          order_id: "PO-2026-001",
          received_on: "2026-11-11",
          lines: [{ line: 1, outcome: "accepted", quantity: 10, location: "DS" }],
        })
      ).data.error.code,
    ).toBe("order_not_open");

    fake.purchasingModule.send(order.id);
    const res = await call("receive_purchase_order", {
      workspace: "acme",
      order_id: "PO-2026-001",
      received_on: "2026-11-11",
      delivery_reference: "DN-1",
      lines: [
        { line: 1, outcome: "accepted", quantity: 10, location: "dry store", supplier_lot_code: "M-5" },
        { line: 2, outcome: "rejected", quantity: 20, reason: "Crushed" },
      ],
    });
    expect(res.data).toMatchObject({
      reference: "PO-2026-001",
      state: "part_received",
      received: [
        { line: 1, item: "FLR-001 Strong white flour", outcome: "accepted", quantity: "10 kg" },
        { line: 2, outcome: "rejected", quantity: "20 each", lot: null, reason: "Crushed" },
      ],
      outstanding: [
        { line: 1, outstanding: "15 kg" },
        { line: 2, outstanding: "100 each" },
      ],
    });
    expect(fake.stockModule.movements.at(-1)).toMatchObject({
      type: "receipt",
      reference: "PO-2026-001 / DN-1",
      quantity: 10000,
    });
    const lot = fake.stockModule.lots.at(-1)!;
    expect(lot).toMatchObject({ supplierLotCode: "M-5", status: "available" });

    const detail = await call("get_purchase_order", { workspace: "acme", order_id: "PO-2026-001" });
    expect(detail.data.deliveries[0]).toMatchObject({ deliveryReference: "DN-1" });
    expect(detail.data.deliveries[0].receipts).toHaveLength(2);
    expect(detail.data.orderLines[0].promisedOn).toBe(detail.data.orderLines[0].expectedOn);

    expect(
      (
        await call("receive_purchase_order", {
          workspace: "acme",
          order_id: "PO-2026-001",
          received_on: "2026-11-11",
          lines: [{ line: 9, outcome: "rejected", quantity: 1, reason: "x" }],
        })
      ).data.error.code,
    ).toBe("invalid_input");

    // A pending supplier (Dairy Co) must deliver into quarantine.
    const milk = await call("draft_purchase_order", {
      workspace: "acme",
      supplier: "Dairy Co",
      lines: [{ item: "MLK-001", quantity: 20, unit: "l" }],
    });
    fake.purchasingModule.send(milk.data.id);
    const receive = (quarantine?: boolean) =>
      call("receive_purchase_order", {
        workspace: "acme",
        order_id: "PO-2026-002",
        received_on: "2026-11-11",
        lines: [{ line: 1, outcome: "accepted", quantity: 20, location: "DS", quarantine }],
      });
    expect((await receive()).data.error.code).toBe("supplier_not_approved");
    expect((await receive(true)).isError).toBe(false);
    expect(fake.stockModule.lots.at(-1)).toMatchObject({ status: "quarantine" });
  });

  it("reads the shortfall proposal, and says when production is missing", async () => {
    const { call, fake } = await session();
    const flour = fake.itemsModule.items.find((i) => i.code === "FLR-001")!;
    const mill = fake.itemsModule.suppliers[0]!;
    const amountOf = (n: number) => ({ base: n * 1000, baseUnit: "g", display: n, displayUnit: "kg" });
    const base = {
      item: fake.purchasingModule.itemSummary(flour),
      shortfall: amountOf(30),
      onOrder: amountOf(15),
      onDraft: amountOf(0),
      toOrder: amountOf(15),
      quantity: 15,
      unit: "kg",
      unitPrice: 0.8,
      neededBy: "2026-11-15",
      expectedOn: "2026-11-15",
      incomplete: false,
      supplierId: mill.id,
      otherSuppliers: [],
      suppliers: [],
    };
    fake.purchasingModule.state.suggestions = {
      groups: [{ supplier: fake.purchasingModule.supplierSummary(mill.id), suggestions: [base] }],
      covered: [{ ...base, toOrder: amountOf(0), quantity: 0 }],
      notPurchasable: [
        {
          item: { ...fake.purchasingModule.itemSummary(flour), code: "DGH", name: "Dough", type: "wip" },
          shortfall: amountOf(5),
          reason: "made_in_house",
        },
      ],
    };
    const res = await call("suggest_purchase_orders", { workspace: "acme" });
    expect(res.data.groups).toEqual([
      {
        supplier: "Shipton Mill (SHIP)",
        suggestions: [
          expect.objectContaining({
            item: "FLR-001 Strong white flour",
            shortfall: "30 kg",
            onOrder: "15 kg",
            toOrder: "15 kg",
            quantity: 15,
            unit: "kg",
            expectedOn: "2026-11-15",
          }),
        ],
      },
    ]);
    expect(res.data.covered).toHaveLength(1);
    expect(res.data.notPurchasable).toEqual([
      { item: "DGH Dough", shortfall: "5 kg", reason: "made_in_house" },
    ]);

    fake.purchasingModule.state.productionAvailable = false;
    expect((await call("suggest_purchase_orders", { workspace: "acme" })).data.error.code).toBe(
      "production_unavailable",
    );
  });

  it("reads supplier performance", async () => {
    const { call, fake } = await session();
    const mill = fake.itemsModule.suppliers[0]!;
    fake.purchasingModule.state.performance = [
      {
        supplier: fake.purchasingModule.supplierSummary(mill.id),
        linesDue: 3,
        onTime: 1,
        inFull: 1,
        otif: 0,
        onTimePercent: 33.3,
        inFullPercent: 33.3,
        otifPercent: 0,
        deliveries: 2,
        rejectedDeliveries: 1,
      },
    ];
    const res = await call("supplier_performance", { workspace: "acme" });
    expect(res.data.suppliers[0]).toMatchObject({
      supplier: "Shipton Mill (SHIP)",
      linesDue: 3,
      otifPercent: 0,
      rejectedDeliveries: 1,
    });
    const none = await call("supplier_performance", { workspace: "acme", supplier: "Dairy Co" });
    expect(none.data.suppliers).toEqual([]);
  });
});
