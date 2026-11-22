import { addDays, DEFAULT_TIME_ZONE, newId, todayInZone } from "@knotworking/core";
import { salesOrders, salesOrderLines, salesEvents, workspaces, customers } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareDespatch } from "./despatch-test-helpers";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";
const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

describe("sales ownership, pricing and order lifecycle", () => {
  let ctx: TestCtx, ada: string, marcus: string, memberId: string, token: string;
  let customer: string, product: string, location: string;
  const call = (method: string, path: string, json?: unknown, cookie = ada) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const ok = async (r: Res, status = 200) => {
    const b = await r.json();
    expect(r.status, JSON.stringify(b)).toBe(status);
    return b;
  };
  const denied = async (r: Res, status: number, code?: string) => {
    const b = await r.json();
    expect(r.status, JSON.stringify(b)).toBe(status);
    if (code) expect(b.error.code).toBe(code);
  };
  const document = (extra: object = {}) => ({
    customerId: customer,
    currency: "GBP",
    terms: "Net 30. Prices exclude tax.",
    lines: [{ itemId: product, quantity: 10, unit: "kg", dueOn: today, unitPrice: 3.45 }],
    ...extra,
  });
  const create = (extra: object = {}, kind = "order", commandId = newId()) =>
    call("POST", "/sales/orders", { commandId, kind, document: document(extra) });
  const action = (row: any, operation: string, commandId = newId()) =>
    call("POST", `/sales/orders/${row.id}/${operation}`, {
      commandId,
      expectedRevision: row.revision,
      reason: "Reviewed by commercial manager",
    });
  const docOf = (row: any) => ({
    customerId: row.customerId,
    deliverySiteId: row.deliverySiteId,
    customerReference: row.customerReference,
    currency: row.currency,
    validUntil: row.validUntil,
    terms: row.terms,
    notes: row.notes,
    lines: row.lines.map((l: any) => ({
      id: l.id,
      itemId: l.itemId,
      quantity: l.quantity,
      unit: l.unit,
      dueOn: l.dueOn,
      unitPrice: l.unitPrice,
      note: l.note,
    })),
  });
  const save = (row: any, doc: object, operation = "", expectedRevision = row.revision) =>
    call(operation ? "POST" : "PUT", `/sales/orders/${row.id}${operation ? `/${operation}` : ""}`, {
      commandId: newId(),
      expectedRevision,
      reason: "Customer requested amendment",
      document: doc,
    });
  const price = (extra: object = {}) => ({
    commandId: newId(),
    customerId: customer,
    itemId: product,
    currency: "GBP",
    unit: "kg",
    unitPrice: 3.45,
    validFrom: today,
    validTo: addDays(today, 30),
    contractReference: "AGREEMENT-1",
    ...extra,
  });
  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    memberId = (await ok(await ctx.req("/v1/me", { cookie: marcus }))).user.id;
    token = (
      await ok(
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "Sales adapter", scope: "write" },
        }),
        201,
      )
    ).token;
    customer = (
      await ok(
        await call("POST", "/customers", {
          code: "SALES-SHOP",
          name: "Sales Shop",
          address: "1 High Street",
        }),
        201,
      )
    ).id;
    product = (
      await ok(
        await call("POST", "/items", { code: "SALES-PRODUCT", name: "Soup", type: "finished", unit: "kg" }),
        201,
      )
    ).id;
    location = (
      await ok(
        await call("POST", "/stock/locations", { code: "SALES-FG", name: "Sales finished goods" }),
        201,
      )
    ).id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("is opt-in with dependencies, read-only and module-off boundaries", async () => {
    await denied(await call("GET", "/sales/orders", undefined, marcus), 403);
    for (const module of ["sales", "customers", "items"])
      await ok(await call("PUT", `/members/${memberId}/module-access/${module}`, { level: "read" }));
    await ok(await call("GET", "/sales/orders", undefined, marcus));
    await denied(
      await call(
        "POST",
        "/sales/orders",
        { commandId: newId(), kind: "order", document: document() },
        marcus,
      ),
      403,
    );
    const off = await makeApp({ seed: true, activeModules: ["customers", "items"] });
    const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
    await denied(await off.req(`${WS}/sales/orders`, { cookie }), 404, "module_inactive");
    await off.handle.close();
  }, 60_000);

  it("resolves a dated customer price in the entered unit, rejects overlaps and retains agreements", async () => {
    const p = await ok(await call("POST", "/sales/prices", price()), 201);
    await denied(await call("POST", "/sales/prices", price({ unit: "g", unitPrice: 0.00345 })), 409);
    const gramOrder = await ok(
      await create({ lines: [{ itemId: product, quantity: 1000, unit: "g", dueOn: today }] }),
      201,
    );
    expect(gramOrder.lines[0]).toMatchObject({
      quantity: 1000,
      baseQuantity: 1000,
      unitPrice: 0.00345,
      priceId: p.id,
      value: "3.45",
    });
    await denied(
      await create({ lines: [{ itemId: product, quantity: 1, unit: "kg", dueOn: addDays(today, 31) }] }),
      409,
    );
    await ok(
      await call("POST", `/sales/prices/${p.id}/archive`, {
        commandId: newId(),
        reason: "New annual contract",
      }),
    );
    expect(
      (await ok(await call("GET", "/sales/prices"))).prices.find((v: any) => v.id === p.id).archiveReason,
    ).toBe("New annual contract");
    expect((await ok(await call("GET", `/sales/orders/${gramOrder.id}`))).lines[0].unitPrice).toBe(0.00345);
    await ok(await call("POST", "/sales/prices", price({ unitPrice: 4 })), 201);
  });

  it("replays commands durably, rejects command reuse, zero-rounding, foreign and invalid units", async () => {
    const commandId = newId();
    const row = await ok(await create({}, "order", commandId), 201);
    expect((await ok(await create({}, "order", commandId), 201)).id).toBe(row.id);
    await denied(await create({ notes: "Changed" }, "order", commandId), 409, "command_conflict");
    await denied(
      await create({
        lines: [{ itemId: product, quantity: 0.000001, unit: "kg", dueOn: today, unitPrice: 1 }],
      }),
      400,
    );
    await denied(
      await create({ lines: [{ itemId: product, quantity: 1, unit: "l", dueOn: today, unitPrice: 1 }] }),
      400,
      "unit_not_convertible",
    );
    await denied(await create({ customerId: newId() }), 404);
    await denied(
      await create({ lines: [{ itemId: newId(), quantity: 1, unit: "kg", dueOn: today, unitPrice: 1 }] }),
      404,
    );
    const other = await ok(await create(), 201);
    await denied(await save(row, { ...docOf(row), lines: docOf(other).lines }), 400);
  });

  it("snapshots confirmation, signs amendments, rejects stale/concurrent edits and retains history", async () => {
    const row = await ok(await create(), 201);
    const confirmed = await ok(await action(row, "confirm"));
    await denied(await save(confirmed, docOf(confirmed)), 409);
    const amendedDoc = docOf(confirmed);
    amendedDoc.lines[0].quantity = 12;
    const amended = await ok(await save(confirmed, amendedDoc, "amend"));
    expect(amended.lines[0].id).toBe(confirmed.lines[0].id);
    expect(amended.lines[0].quantity).toBe(12);
    await denied(await save(confirmed, docOf(confirmed), "amend"), 409, "sales_conflict");
    const history = await ok(await call("GET", `/sales/orders/${row.id}/history?limit=1&offset=1`));
    expect(history.total).toBe(3);
    expect(history.events[0].snapshot.lines[0].quantity).toBe(10);
    expect(history.events[0]).toMatchObject({ action: "confirm", actorId: amended.signedBy });
    const contenders = await Promise.all([
      save(amended, docOf(amended), "amend"),
      save(amended, docOf(amended), "amend"),
    ]);
    expect(contenders.map((r) => r.status).sort()).toEqual([200, 409]);
    await ok(await call("PATCH", `/customers/${customer}`, { name: "Changed customer" }));
    expect((await ok(await call("GET", `/sales/orders/${row.id}`))).recipient.name).toBe("Sales Shop");
  });

  it("revalidates draft master data and quote expiry, converts once and cancels the balance", async () => {
    const draft = await ok(await create(), 201);
    await ok(await call("PATCH", `/customers/${customer}`, { address: "2 High Street" }));
    await denied(await action(draft, "confirm"), 409);
    const fresh = await ok(await save(draft, docOf(draft)));
    await ok(await action(fresh, "confirm"));
    const expired = await ok(await create({ validUntil: addDays(today, -1) }, "quote"), 201);
    await denied(await action(expired, "issue"), 409);
    const quote = await ok(await create({ validUntil: addDays(today, 10) }, "quote"), 201);
    const issued = await ok(await action(quote, "issue"));
    const converted = await ok(await action(issued, "convert"));
    expect(converted).toMatchObject({ kind: "order", status: "draft", sourceQuoteId: quote.id });
    await denied(await action(issued, "convert"), 409);
    const ordered = await ok(await action(converted, "confirm"));
    const cancelled = await ok(await action(ordered, "cancel"));
    expect(cancelled.status).toBe("cancelled");
    await denied(await action(cancelled, "confirm"), 409);
  });

  it("lets a quote convert again after its draft order is cancelled, and keeps the quote's customer on the draft", async () => {
    const quote = await ok(await create({ validUntil: addDays(today, 10) }, "quote"), 201);
    const issued = await ok(await action(quote, "issue"));
    const first = await ok(await action(issued, "convert"));
    // The draft keeps the quote's customer, site and currency.
    const elsewhere = (
      await ok(
        await call("POST", "/customers", { code: "SALES-OTHER", name: "Other Shop", address: "9 Low Road" }),
        201,
      )
    ).id;
    await denied(await save(first, { ...docOf(first), customerId: elsewhere }), 409);
    await denied(await save(first, { ...docOf(first), currency: "EUR" }), 409);
    // Cancelled by mistake: the quote isn't stuck, and only one live order exists for it.
    await ok(await action(first, "cancel"));
    const reloaded = await ok(await call("GET", `/sales/orders/${quote.id}`));
    expect(reloaded.convertedOrderId).toBeNull();
    const second = await ok(await action(reloaded, "convert"));
    expect(second).toMatchObject({ kind: "order", status: "draft", sourceQuoteId: quote.id });
    expect(second.id).not.toBe(first.id);
    await denied(await action(await ok(await call("GET", `/sales/orders/${quote.id}`)), "convert"), 409);
  });

  it("keeps an existing line's agreed price and its link through re-saves and amendments", async () => {
    // Priced from the current agreement (4.00 GBP/kg, set up earlier).
    const draft = await ok(
      await create({ lines: [{ itemId: product, quantity: 5, unit: "kg", dueOn: today }] }),
      201,
    );
    const priceId = draft.lines[0].priceId;
    expect(priceId).toEqual(expect.any(String));
    // The editor sends every line's price back: the link survives an unchanged price.
    const resaved = await ok(await save(draft, { ...docOf(draft), notes: "Gate code 1234" }));
    expect(resaved.lines[0]).toMatchObject({ unitPrice: draft.lines[0].unitPrice, priceId });
    const confirmed = await ok(await action(resaved, "confirm"));
    // The agreement is archived: an amendment that leaves the price out keeps the agreed price, not today's.
    await ok(
      await call("POST", `/sales/prices/${priceId}/archive`, { commandId: newId(), reason: "Superseded" }),
    );
    const doc = docOf(confirmed);
    doc.lines[0] = { ...doc.lines[0], quantity: 6, unitPrice: undefined };
    const amended = await ok(await save(confirmed, doc, "amend"));
    expect(amended.lines[0]).toMatchObject({ quantity: 6, unitPrice: draft.lines[0].unitPrice, priceId });
    // A different explicit price breaks the link.
    const repriced = docOf(amended);
    repriced.lines[0].unitPrice = 4.25;
    expect((await ok(await save(amended, repriced, "amend"))).lines[0]).toMatchObject({
      unitPrice: 4.25,
      priceId: null,
    });
    await ok(await call("POST", "/sales/prices", price({ unitPrice: 4 })), 201);
  });

  it("drops a kept price's agreement link once the agreement no longer applies, and re-prices blank draft lines", async () => {
    const draft = await ok(
      await create({ lines: [{ itemId: product, quantity: 5, unit: "kg", dueOn: today }] }),
      201,
    );
    const agreed = draft.lines[0];
    expect(agreed.priceId).toEqual(expect.any(String));
    // Another currency: the same number is no longer that agreement's price.
    const eur = await ok(await save(draft, { ...docOf(draft), currency: "EUR" }));
    expect(eur.lines[0]).toMatchObject({ unitPrice: agreed.unitPrice, priceId: null });
    // Back in GBP with the price left out: a draft line takes the agreement in force again.
    const blank = docOf(eur);
    blank.currency = "GBP";
    blank.lines[0].unitPrice = undefined;
    const repriced = await ok(await save(eur, blank));
    expect(repriced.lines[0]).toMatchObject({ unitPrice: agreed.unitPrice, priceId: agreed.priceId });
    // A delivery date beyond the agreement's validity keeps the price but not the claim.
    const later = docOf(repriced);
    later.lines[0].dueOn = addDays(today, 60);
    expect((await ok(await save(repriced, later))).lines[0]).toMatchObject({
      unitPrice: agreed.unitPrice,
      priceId: null,
    });
  });

  it("amends an unchanged line of an archived item, but not a changed one", async () => {
    const item = (
      await ok(
        await call("POST", "/items", { code: "SALES-OLD", name: "Old soup", type: "finished", unit: "kg" }),
        201,
      )
    ).id;
    const confirmed = await ok(
      await action(
        await ok(
          await create({
            lines: [
              { itemId: product, quantity: 2, unit: "kg", dueOn: today, unitPrice: 4 },
              { itemId: item, quantity: 5, unit: "kg", dueOn: today, unitPrice: 2 },
            ],
          }),
          201,
        ),
        "confirm",
      ),
    );
    await ok(await call("PATCH", `/items/${item}`, { status: "archived" }));
    const doc = docOf(confirmed);
    doc.lines[0].quantity = 3;
    const amended = await ok(await save(confirmed, doc, "amend"));
    expect(amended.lines.map((l: any) => l.quantity)).toEqual([3, 5]);
    const more = docOf(amended);
    more.lines[1].quantity = 6;
    await denied(await save(amended, more, "amend"), 409);
  });

  it("keeps a quote converted when its order was confirmed before being cancelled", async () => {
    const issued = await ok(
      await action(await ok(await create({ validUntil: addDays(today, 10) }, "quote"), 201), "issue"),
    );
    const order = await ok(await action(issued, "convert"));
    await ok(await action(await ok(await action(order, "confirm")), "cancel"));
    const quote = await ok(await call("GET", `/sales/orders/${issued.id}`));
    expect(quote.convertedOrderId).toBe(order.id);
    await denied(await action(quote, "convert"), 409);
  });

  it("allows tokens to prepare drafts and map external IDs, never to sign or set agreed prices", async () => {
    const via = (method: string, path: string, json?: unknown) =>
      ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
    const row = await ok(
      await via("POST", "/sales/orders", { commandId: newId(), kind: "order", document: document() }),
      201,
    );
    for (const op of ["confirm", "issue", "cancel", "convert", "amend", "fulfilments"])
      await denied(
        await via("POST", `/sales/orders/${row.id}/${op}`, {
          commandId: newId(),
          expectedRevision: row.revision,
          reason: "Agent",
        }),
        403,
        "token_not_allowed",
      );
    await denied(await via("POST", "/sales/prices", price()), 403, "token_not_allowed");
    const mapping = {
      commandId: newId(),
      system: "future-sales",
      entityType: "order",
      entityId: row.id,
      externalId: "EXT-123",
    };
    const saved = await ok(await via("POST", "/sales/integration/references", mapping), 201);
    expect(
      (await ok(await via("POST", "/sales/integration/references", { ...mapping, commandId: newId() }), 201))
        .id,
    ).toBe(saved.id);
    await denied(
      await via("POST", "/sales/integration/references", {
        ...mapping,
        commandId: newId(),
        externalId: "EXT-124",
      }),
      409,
    );
    const integration = await ok(await via("GET", "/sales/integration"));
    expect(integration).toMatchObject({ ownership: "teamflow", contractVersion: 1 });
    expect(integration.references.some((r: any) => r.externalId === "EXT-123")).toBe(true);
    await denied(
      await via("POST", "/sales/integration/references", {
        ...mapping,
        commandId: newId(),
        entityId: newId(),
        externalId: "MISSING",
      }),
      404,
    );
  });

  it("links a physical despatch once, respects remaining quantities and follows voids without posting sales stock", async () => {
    const lot = await ok(
      await call("POST", "/stock/receipts", {
        itemId: product,
        locationId: location,
        lotCode: `SALES-${newId()}`,
        quantity: 100,
        unit: "kg",
        receivedOn: today,
        reason: "Opening stock",
        expiresOn: addDays(today, 20),
        expiryType: "best_before",
      }),
      201,
    );
    const draft = await ok(
      await call("POST", "/despatch", {
        customerId: customer,
        despatchedOn: today,
        lines: [{ lotId: lot.id, locationId: location, quantity: 4, unit: "kg" }],
      }),
      201,
    );
    const row = await ok(await action(await ok(await create(), 201), "confirm"));
    const payload = {
      commandId: newId(),
      expectedRevision: row.revision,
      orderLineId: row.lines[0].id,
      despatchLineId: draft.lines[0].id,
      reason: "Fulfilled customer order",
    };
    await denied(await call("POST", `/sales/orders/${row.id}/fulfilments`, payload), 409);
    const prepared = await prepareDespatch(call, draft.id);
    expect(prepared.error).toBeUndefined();
    const shipped = await ok(
      await call("POST", `/despatch/${draft.id}/confirm`, {
        commandId: newId(),
        expectedUpdatedAt: prepared.stamp,
      }),
    );
    const linked = await ok(await call("POST", `/sales/orders/${row.id}/fulfilments`, payload));
    expect((await ok(await call("POST", `/sales/orders/${row.id}/fulfilments`, payload))).revision).toBe(
      linked.revision,
    );
    const fulfil = await ok(await call("GET", `/sales/orders/${row.id}/fulfilments`));
    expect(fulfil.lines[0]).toMatchObject({ shipped: 4000, outstanding: 6000, returned: 0 });
    const other = await ok(await action(await ok(await create(), 201), "confirm"));
    await denied(
      await call("POST", `/sales/orders/${other.id}/fulfilments`, {
        ...payload,
        commandId: newId(),
        expectedRevision: other.revision,
        orderLineId: other.lines[0].id,
      }),
      409,
    );
    const tooSmall = docOf(linked);
    tooSmall.lines[0].quantity = 3;
    await denied(await save(linked, tooSmall, "amend"), 409);
    const returnPayload = {
      commandId: newId(),
      lineId: shipped.lines[0].id,
      quantity: 1,
      unit: "kg",
      locationId: location,
      receivedOn: today,
      lotCode: `RETURN-${newId()}`,
      reason: "Customer physical return",
      condition: "Unopened",
    };
    await ok(await call("POST", `/despatch/${draft.id}/returns`, returnPayload), 201);
    expect((await ok(await call("GET", `/sales/orders/${row.id}/fulfilments`))).lines[0]).toMatchObject({
      shipped: 4000,
      outstanding: 6000,
      returned: 1000,
    });
    // Correcting only the sales assignment never alters the stock ledger or deletes return evidence.
    await ok(
      await call("POST", `/sales/orders/${row.id}/fulfilments/${fulfil.links[0].id}/void`, {
        commandId: newId(),
        expectedRevision: linked.revision,
        reason: "Assigned to wrong commercial order",
      }),
    );
    expect((await ok(await call("GET", `/sales/orders/${row.id}/fulfilments`))).lines[0]).toMatchObject({
      shipped: 0,
      outstanding: 10000,
    });
    // Linked again, then the order is cancelled: its delivery evidence can no longer be removed.
    const relinked = await ok(
      await call("POST", `/sales/orders/${row.id}/fulfilments`, {
        ...payload,
        commandId: newId(),
        expectedRevision: (await ok(await call("GET", `/sales/orders/${row.id}`))).revision,
      }),
    );
    const cancelled = await ok(await action(relinked, "cancel"));
    const live = (await ok(await call("GET", `/sales/orders/${row.id}/fulfilments`))).links.find(
      (l: any) => !l.voidedAt,
    );
    await denied(
      await call("POST", `/sales/orders/${row.id}/fulfilments/${live.id}/void`, {
        commandId: newId(),
        expectedRevision: cancelled.revision,
        reason: "Tidy up",
      }),
      409,
    );
  });

  it("closes a link to a voided despatch when its order line is removed", async () => {
    const lot = await ok(
      await call("POST", "/stock/receipts", {
        itemId: product,
        locationId: location,
        lotCode: `SALES-${newId()}`,
        quantity: 10,
        unit: "kg",
        receivedOn: today,
        reason: "Opening stock",
        expiresOn: addDays(today, 20),
        expiryType: "best_before",
      }),
      201,
    );
    const draft = await ok(
      await call("POST", "/despatch", {
        customerId: customer,
        despatchedOn: today,
        lines: [{ lotId: lot.id, locationId: location, quantity: 2, unit: "kg" }],
      }),
      201,
    );
    const prepared = await prepareDespatch(call, draft.id);
    expect(prepared.error).toBeUndefined();
    await ok(
      await call("POST", `/despatch/${draft.id}/confirm`, {
        commandId: newId(),
        expectedUpdatedAt: prepared.stamp,
      }),
    );
    const order = await ok(
      await action(
        await ok(
          await create({
            lines: [
              { itemId: product, quantity: 2, unit: "kg", dueOn: today, unitPrice: 4 },
              { itemId: product, quantity: 3, unit: "kg", dueOn: today, unitPrice: 4 },
            ],
          }),
          201,
        ),
        "confirm",
      ),
    );
    const linked = await ok(
      await call("POST", `/sales/orders/${order.id}/fulfilments`, {
        commandId: newId(),
        expectedRevision: order.revision,
        orderLineId: order.lines[0].id,
        despatchLineId: draft.lines[0].id,
        reason: "Delivered",
      }),
    );
    // While the despatch stands the line can't be removed.
    const without = { ...docOf(linked), lines: docOf(linked).lines.slice(1) };
    await denied(await save(linked, without, "amend"), 409);
    await ok(
      await call("POST", `/despatch/${draft.id}/void`, {
        commandId: newId(),
        reason: "Recorded against the wrong lot",
      }),
    );
    const removed = await ok(await save(linked, without, "amend"));
    expect(removed.lines).toHaveLength(1);
    const { links } = await ok(await call("GET", `/sales/orders/${order.id}/fulfilments`));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ voidReason: expect.stringContaining("removed") });
    expect(links[0].voidedAt).toBeTruthy();
  });

  it("keeps sales commitments separate from demand forecasts and commercial content out of general sync", async () => {
    await ok(
      await call("PUT", "/demand/lines", {
        lines: [{ itemId: product, period: today, customer: "Legacy forecast", quantity: 100, unit: "kg" }],
      }),
    );
    const before = await ok(await call("GET", `/demand/summary?from=${today}&to=${today}`));
    const draft = await ok(await create(), 201);
    const confirmed = await ok(await action(draft, "confirm"));
    const after = await ok(await call("GET", `/demand/summary?from=${today}&to=${today}`));
    expect(after).toEqual(before);
    const commitments = await ok(await call("GET", `/sales/commitments?from=${today}&to=${today}&limit=100`));
    expect(commitments).toMatchObject({ basis: "confirmed_sales_orders_only", forecastIncluded: false });
    expect(commitments.lines.some((l: any) => l.orderId === confirmed.id && l.outstanding === 10000)).toBe(
      true,
    );
    expect(JSON.stringify(commitments)).not.toContain("unitPrice");
    const sync = await ok(await call("GET", "/sync?after=0&limit=500"));
    const sales = sync.changes.filter((c: any) => c.entity.startsWith("sales_"));
    expect(sales.length).toBeGreaterThan(0);
    for (const event of sales)
      expect(Object.keys(event.data).every((k) => ["id", "revision"].includes(k))).toBe(true);
    const restricted = await ok(await call("GET", "/sync?after=0&limit=500", undefined, marcus));
    // Marcus may read sales here, but the payload is still metadata only.
    expect(
      JSON.stringify(restricted.changes.filter((c: any) => c.entity.startsWith("sales_"))),
    ).not.toContain("unitPrice");
  });

  it("compares recipient facts independently of JSON key order and revalidates converted quotes", async () => {
    const draft = await ok(await create(), 201);
    await ctx.handle.db
      .update(salesOrders)
      .set({
        recipient: Object.fromEntries(Object.entries(draft.recipient).reverse()) as typeof draft.recipient,
      })
      .where(eq(salesOrders.id, draft.id));
    const confirmed = await ok(await action(draft, "confirm"));
    await denied(
      await call(
        "POST",
        `/sales/orders/${confirmed.id}/cancel`,
        { commandId: newId(), expectedRevision: confirmed.revision, reason: "Reader cannot cancel" },
        marcus,
      ),
      403,
    );
    const quote = await ok(await action(await ok(await create({}, "quote"), 201), "issue"));
    await ok(await call("PATCH", `/customers/${customer}`, { address: "3 High Street" }));
    const converted = await ok(await action(quote, "convert"));
    expect(converted.recipient.address).toBe("2 High Street");
    expect((await ok(await call("GET", `/sales/orders/${quote.id}`))).convertedOrderId).toBe(converted.id);
    await denied(await action(converted, "confirm"), 409);
    const refreshed = await ok(await save(converted, docOf(converted)));
    expect((await ok(await action(refreshed, "confirm"))).recipient.address).toBe("3 High Street");
  });

  it("serializes duplicate creates and removes sales metadata when module access is revoked", async () => {
    const commandId = newId();
    const attempts = await Promise.all([create({}, "order", commandId), create({}, "order", commandId)]);
    const rows = await Promise.all(attempts.map((r) => ok(r, 201)));
    expect(rows[0].id).toBe(rows[1].id);
    await ok(await call("PUT", `/members/${memberId}/module-access/sales`, { level: "none" }));
    await denied(
      await call("GET", `/sales/orders/${rows[0].id}`, undefined, marcus),
      403,
      "module_forbidden",
    );
    const sync = await ok(await call("GET", "/sync?after=0&limit=500", undefined, marcus));
    expect(sync.changes.some((c: any) => c.entity.startsWith("sales_"))).toBe(false);
    const bootstrap = await ok(await call("GET", "/bootstrap", undefined, marcus));
    expect(JSON.stringify(bootstrap)).not.toContain("unitPrice");
  });

  it("enforces workspace isolation even when an ID exists in another workspace", async () => {
    const [foreignWs] = await ctx.handle.db
      .insert(workspaces)
      .values({ slug: `foreign-${newId()}`, name: "Foreign" })
      .returning();
    const [foreignCustomer] = await ctx.handle.db
      .insert(customers)
      .values({ workspaceId: foreignWs!.id, code: "F", name: "Foreign", address: "Foreign" })
      .returning();
    await denied(await create({ customerId: foreignCustomer!.id }), 404);
    const [foreignOrder] = await ctx.handle.db
      .insert(salesOrders)
      .values({
        workspaceId: foreignWs!.id,
        reference: "F-1",
        kind: "order",
        customerId: foreignCustomer!.id,
        currency: "GBP",
        recipient: {
          code: "F",
          name: "Foreign",
          address: "Foreign",
          deliveryAddress: "Foreign",
          deliverySiteCode: null,
          deliverySiteName: null,
        },
      })
      .returning();
    await denied(await call("GET", `/sales/orders/${foreignOrder!.id}`), 404);
    await denied(await call("GET", `/sales/orders/${foreignOrder!.id}/history`), 404);
  });
});
