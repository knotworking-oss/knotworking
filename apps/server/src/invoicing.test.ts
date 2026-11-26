import { addDays, DEFAULT_TIME_ZONE, newId, todayInZone, type ModuleId } from "@knotworking/core";
import { memberModuleAccess, users, workspaces } from "@knotworking/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareDespatch } from "./despatch-test-helpers";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const ws = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
type Doc = { id: string; revision: number; lines: { id: string; unitPrice: string }[] };

describe("Invoicing: customer invoices and credit notes", () => {
  let ctx: TestCtx, owner: string, member: string, memberId: string, workspaceId: string;
  let locationId: string, token: string;
  const send = (method: string, path: string, json?: unknown, cookie = owner) =>
    ctx.req(ws + path, { method, json, cookie });
  const ok = async (res: Promise<Res>, status = 200) => {
    const response = await res;
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const setModules = (enabledModules: ModuleId[] | null) =>
    ctx.handle.db.update(workspaces).set({ enabledModules }).where(eq(workspaces.id, workspaceId));
  const grant = async (level: "read" | "write" | "manage" | null) => {
    await ctx.handle.db
      .delete(memberModuleAccess)
      .where(
        and(
          eq(memberModuleAccess.workspaceId, workspaceId),
          eq(memberModuleAccess.userId, memberId),
          eq(memberModuleAccess.moduleId, "invoicing"),
        ),
      );
    if (level)
      await ctx.handle.db
        .insert(memberModuleAccess)
        .values({ workspaceId, userId: memberId, moduleId: "invoicing", level });
  };
  const terms = (date = today) => ({ commandId: newId(), date, dueDate: addDays(date, 30) });
  const customer = async (code: string) =>
    (await ok(send("POST", "/customers", { code, name: `Customer ${code}`, address: "1 Fixture Road" }), 201))
      .id as string;
  const manual = (
    customerId: string,
    lines: { quantity: string; unitPrice: string; taxRate: number; description?: string }[],
    { currency = "GBP", date = today } = {},
  ) => ({
    ...terms(date),
    kind: "manual",
    customerId,
    currency,
    lines: lines.map((line, i) => ({ description: `Line ${i + 1}`, unit: "", ...line })),
  });
  const decide = (doc: { id: string; revision: number }, action = "issue", cookie = owner) =>
    send(
      "POST",
      `/invoicing/${doc.id}/decision`,
      { action, commandId: newId(), expectedRevision: doc.revision, reason: "Checked" },
      cookie,
    );
  const draft = (kind: string, sourceId: string) =>
    send("POST", "/invoicing", { ...terms(), kind, sourceId });
  const credit = (invoice: { id: string }, lineIds: string[], date = today) =>
    send("POST", "/invoicing", {
      kind: "credit",
      sourceId: invoice.id,
      commandId: newId(),
      date,
      reason: "Customer dispute",
      lineIds,
    });
  const price = (doc: Doc, unitPrice?: string, taxRate = 20) =>
    ok(
      send("PATCH", `/invoicing/${doc.id}`, {
        ...terms(),
        expectedRevision: doc.revision,
        pricing: doc.lines.map((line) => ({ id: line.id, unitPrice: unitPrice ?? line.unitPrice, taxRate })),
      }),
    );

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    owner = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    member = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const [row] = await ctx.handle.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, "acme"));
    workspaceId = row!.id;
    const [m] = await ctx.handle.db.select().from(users).where(eq(users.email, "marcus@knotworking.dev"));
    memberId = m!.id;
    token = (
      await ok(
        ctx.req("/v1/me/api-tokens", {
          method: "POST",
          json: { name: "Agent", scope: "write" },
          cookie: owner,
        }),
        201,
      )
    ).token;
    await setModules(["customers", "invoicing"]);
    // Invoicing depends on Customers: without Customers read, no invoicing level applies.
    await ctx.handle.db
      .insert(memberModuleAccess)
      .values({ workspaceId, userId: memberId, moduleId: "customers", level: "read" })
      .onConflictDoNothing();
    locationId = "";
  }, 120_000);
  afterAll(() => ctx?.handle.close());

  it("numbers issued invoices and credit notes in separate gap-free sequences", async () => {
    const id = await customer("NUMBERS");
    const discarded = await ok(
      send("POST", "/invoicing", manual(id, [{ quantity: "1", unitPrice: "10", taxRate: 0 }])),
      201,
    );
    expect(await ok(decide(discarded, "discard"))).toMatchObject({ status: "discarded", number: null });
    const first = await ok(
      decide(
        await ok(
          send("POST", "/invoicing", manual(id, [{ quantity: "1", unitPrice: "10", taxRate: 20 }])),
          201,
        ),
      ),
    );
    const second = await ok(
      decide(
        await ok(
          send("POST", "/invoicing", manual(id, [{ quantity: "2", unitPrice: "10", taxRate: 20 }])),
          201,
        ),
      ),
    );
    expect([first.number, second.number]).toEqual(["INV-000001", "INV-000002"]);
    const note = await ok(decide(await ok(credit(first, [first.lines[0].id]), 201)));
    expect(note).toMatchObject({ kind: "credit", number: "CN-000001", gross: "12.00", creditOf: first.id });
    const third = await ok(
      decide(
        await ok(
          send("POST", "/invoicing", manual(id, [{ quantity: "1", unitPrice: "1", taxRate: 0 }])),
          201,
        ),
      ),
    );
    expect(third.number).toBe("INV-000003");
    // Issued documents are immutable and can't be decided twice.
    await ok(decide(first), 409);
    await ok(send("PATCH", `/invoicing/${first.id}`, { ...terms(), expectedRevision: first.revision }), 409);
  });

  it("separates draft, decision and token rights", async () => {
    const id = await customer("RIGHTS");
    const body = () => manual(id, [{ quantity: "1", unitPrice: "5", taxRate: 0 }]);
    await grant(null);
    await ok(send("GET", "/invoicing", undefined, member), 403);
    await ok(send("POST", "/invoicing", body(), member), 403);
    await grant("read");
    await ok(send("GET", "/invoicing", undefined, member));
    await ok(send("POST", "/invoicing", body(), member), 403);
    await grant("write");
    const drafted = await ok(send("POST", "/invoicing", body(), member), 201);
    await ok(decide(drafted, "issue", member), 403);
    await ok(decide(drafted, "discard", member), 403);
    const viaToken = await ctx.req(`${ws}/invoicing/${drafted.id}/decision`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      json: { action: "issue", commandId: newId(), expectedRevision: drafted.revision, reason: "Agent" },
    });
    expect(viaToken.status).toBe(403);
    await grant("manage");
    expect(await ok(decide(drafted, "issue", member))).toMatchObject({ status: "issued" });
  });

  it("snapshots the seller's and customer's tax numbers onto new drafts", async () => {
    const setting = (taxRegistrationNumber: string | null, cookie = owner) =>
      send("PUT", "/invoicing/settings", { taxRegistrationNumber }, cookie);
    await grant("write");
    await ok(setting("GB123456789", member), 403);
    expect(await ok(setting("  GB123456789 "))).toEqual({ taxRegistrationNumber: "GB123456789" });
    expect(await ok(send("GET", "/invoicing/settings", undefined, member))).toEqual({
      taxRegistrationNumber: "GB123456789",
    });
    const id = (
      await ok(
        send("POST", "/customers", {
          code: "TAXNO",
          name: "Łódź Spółka – Кириллица",
          address: "ul. Piotrkowska 1",
          taxNumber: "PL5260250995",
        }),
        201,
      )
    ).id;
    const drafted = await ok(
      send("POST", "/invoicing", manual(id, [{ quantity: "1", unitPrice: "1", taxRate: 0 }])),
      201,
    );
    expect(drafted).toMatchObject({
      issuer: { taxNumber: "GB123456789" },
      customer: { name: "Łódź Spółka – Кириллица", taxNumber: "PL5260250995" },
    });
    // Clearing the setting leaves existing drafts and issued documents unchanged.
    expect(await ok(setting(""))).toEqual({ taxRegistrationNumber: null });
    const issued = await ok(decide(drafted));
    expect(issued.issuer.taxNumber).toBe("GB123456789");
    const pdf = await send("GET", `/invoicing/${issued.id}/pdf`);
    expect(pdf.status).toBe(200);
    const later = await ok(
      send("POST", "/invoicing", manual(id, [{ quantity: "1", unitPrice: "1", taxRate: 0 }])),
      201,
    );
    expect(later.issuer).not.toHaveProperty("taxNumber");
  });

  it("rounds half up per line in 0-, 2- and 3-decimal currencies", async () => {
    const id = await customer("ROUNDING");
    const yen = await ok(
      send(
        "POST",
        "/invoicing",
        manual(id, [{ quantity: "3", unitPrice: "33.5", taxRate: 10 }], { currency: "JPY" }),
      ),
      201,
    );
    expect(yen).toMatchObject({ currency: "JPY", net: "101", tax: "10", gross: "111" });
    const dinar = await ok(
      send(
        "POST",
        "/invoicing",
        manual(
          id,
          [
            { quantity: "1", unitPrice: "1.2345", taxRate: 5 },
            { quantity: "2", unitPrice: "0.0005", taxRate: 0 },
          ],
          { currency: "KWD" },
        ),
      ),
      201,
    );
    expect(dinar.lines.map((line: { net: string; tax: string }) => [line.net, line.tax])).toEqual([
      ["1.235", "0.062"],
      ["0.001", "0.000"],
    ]);
    expect(dinar).toMatchObject({ net: "1.236", tax: "0.062", gross: "1.298" });
    const pounds = await ok(
      send(
        "POST",
        "/invoicing",
        manual(id, [
          { quantity: "1", unitPrice: "0.125", taxRate: 20 },
          { quantity: "1000000", unitPrice: "1.23456789", taxRate: 17.5 },
        ]),
      ),
      201,
    );
    expect(pounds.lines.map((line: { net: string; tax: string }) => [line.net, line.tax])).toEqual([
      ["0.13", "0.03"],
      ["1234567.89", "216049.38"],
    ]);
    expect(pounds).toMatchObject({ net: "1234568.02", tax: "216049.41", gross: "1450617.43" });
  });

  it("refuses future-dated issue, a due date before the invoice date and a draft PDF", async () => {
    const id = await customer("DATES");
    await ok(
      send("POST", "/invoicing", {
        ...manual(id, [{ quantity: "1", unitPrice: "1", taxRate: 0 }]),
        dueDate: addDays(today, -1),
      }),
      400,
    );
    const future = await ok(
      send(
        "POST",
        "/invoicing",
        manual(id, [{ quantity: "1", unitPrice: "1", taxRate: 0 }], { date: addDays(today, 1) }),
      ),
      201,
    );
    await ok(send("GET", `/invoicing/${future.id}/pdf`), 400);
    expect((await ok(decide(future), 400)).error.message).toContain("future");
    const zero = await ok(
      send("POST", "/invoicing", manual(id, [{ quantity: "1", unitPrice: "0", taxRate: 0 }])),
      201,
    );
    expect((await ok(decide(zero), 400)).error.message).toContain("positive total");
  });

  it("credits whole lines once, never before the invoice date, and frees lines when a credit draft is discarded", async () => {
    const id = await customer("CREDITS");
    const invoice = await ok(
      decide(
        await ok(
          send(
            "POST",
            "/invoicing",
            manual(
              id,
              [
                { quantity: "1", unitPrice: "100", taxRate: 20 },
                { quantity: "1", unitPrice: "50", taxRate: 0 },
              ],
              { date: addDays(today, -5) },
            ),
          ),
          201,
        ),
      ),
    );
    const [a, b] = invoice.lines.map((line: { id: string }) => line.id);
    expect((await ok(credit(invoice, [a], addDays(today, -6)), 400)).error.message).toContain("predate");
    await ok(credit(invoice, [a, a]), 400);
    const pending = await ok(credit(invoice, [a]), 201);
    expect(pending).toMatchObject({ net: "100.00", tax: "20.00", gross: "120.00", status: "draft" });
    // A draft credit already reserves the line.
    await ok(credit(invoice, [a, b]), 409);
    await ok(decide(pending, "discard"));
    const issued = await ok(decide(await ok(credit(invoice, [a, b]), 201)));
    expect(issued).toMatchObject({ gross: "170.00", number: expect.stringMatching(/^CN-/) });
    await ok(credit(invoice, [b]), 409);
    await ok(credit(issued, [issued.lines[0].id]), 409);
    expect(await ok(send("GET", `/invoicing/${invoice.id}`))).toMatchObject({
      creditedLineIds: expect.arrayContaining([a, b]),
    });
  });

  it("edits manual drafts only and keeps source quantities and locked prices fixed", async () => {
    await setModules(["customers", "items", "sales", "invoicing"]);
    const id = await customer("EDITS");
    const drafted = await ok(
      send("POST", "/invoicing", manual(id, [{ quantity: "1", unitPrice: "10", taxRate: 20 }])),
      201,
    );
    const edited = await ok(
      send("PATCH", `/invoicing/${drafted.id}`, {
        ...terms(),
        expectedRevision: drafted.revision,
        lines: [{ description: "Rewritten", unit: "h", quantity: "2", unitPrice: "15", taxRate: 0 }],
      }),
    );
    expect(edited).toMatchObject({ revision: drafted.revision + 1, net: "30.00", tax: "0.00" });
    await ok(
      send("PATCH", `/invoicing/${drafted.id}`, { ...terms(), expectedRevision: drafted.revision }),
      409,
    );

    const { order } = await salesOrder(id, 4, 2.5);
    const fromSales = await ok(draft("sales", order.id), 201);
    expect(fromSales.lines[0]).toMatchObject({ priceLocked: true, taxPending: true, taxRate: 0 });
    expect(
      (await ok(send("POST", "/invoicing", { ...terms(), kind: "sales", sourceId: order.id }), 409)).error
        .message,
    ).toContain("no unbilled");
    await ok(
      send("PATCH", `/invoicing/${fromSales.id}`, {
        ...terms(),
        expectedRevision: fromSales.revision,
        lines: [{ description: "Extra", unit: "", quantity: "1", unitPrice: "1", taxRate: 0 }],
      }),
      400,
    );
    expect(
      (
        await ok(
          send("PATCH", `/invoicing/${fromSales.id}`, {
            ...terms(),
            expectedRevision: fromSales.revision,
            pricing: [{ id: fromSales.lines[0].id, unitPrice: "3", taxRate: 20 }],
          }),
          400,
        )
      ).error.message,
    ).toContain("fixed by its source");
    // N1: the 0% default is not a tax decision.
    expect((await ok(decide(fromSales), 400)).error.message).toContain("tax rate");
    const reviewed = await price(fromSales, undefined, 0);
    expect(reviewed.lines[0]).toMatchObject({ taxPending: false, taxRate: 0 });
    expect(await ok(decide(reviewed))).toMatchObject({ status: "issued", net: "10.00", tax: "0.00" });
  });

  async function salesOrder(customerId: string, quantity: number, unitPrice: number) {
    const item = await ok(
      send("POST", "/items", {
        code: `FG-${newId().slice(-8)}`,
        name: "Fixture tea",
        type: "finished",
        unit: "kg",
      }),
      201,
    );
    const order = await ok(
      send("POST", "/sales/orders", {
        commandId: newId(),
        kind: "order",
        document: {
          customerId,
          currency: "GBP",
          lines: [{ itemId: item.id, quantity, unit: "kg", unitPrice, dueOn: today }],
        },
      }),
      201,
    );
    const confirmed = await ok(
      send("POST", `/sales/orders/${order.id}/confirm`, {
        commandId: newId(),
        expectedRevision: order.revision,
        reason: "Reviewed",
      }),
    );
    return { item, order: confirmed };
  }

  async function shipment(customerId: string, quantity: number) {
    if (!locationId)
      locationId = (await ok(send("POST", "/stock/locations", { name: "Invoicing warehouse" }), 201)).id;
    const item = await ok(
      send("POST", "/items", {
        code: `SH-${newId().slice(-8)}`,
        name: "Shipped tea",
        type: "finished",
        unit: "kg",
      }),
      201,
    );
    const lot = await ok(
      send("POST", "/stock/receipts", {
        itemId: item.id,
        locationId,
        lotCode: `LOT-${newId().slice(-8)}`,
        quantity: 20,
        unit: "kg",
        receivedOn: today,
        reason: "Fixture stock",
        expiresOn: addDays(today, 30),
        expiryType: "best_before",
      }),
      201,
    );
    const delivery = await ok(
      send("POST", "/despatch", {
        customerId,
        despatchedOn: today,
        lines: [{ lotId: lot.id, locationId, quantity, unit: "kg" }],
      }),
      201,
    );
    const ready = await prepareDespatch(send, delivery.id);
    expect(ready.error).toBeUndefined();
    return ok(
      send("POST", `/despatch/${delivery.id}/confirm`, {
        commandId: newId(),
        expectedUpdatedAt: ready.stamp,
      }),
    );
  }

  it("releases each kind of source reservation on discard and blocks resizing a reserved order line", async () => {
    await setModules(["customers", "items", "sales", "invoicing"]);
    const id = await customer("RELEASE");
    // Sales without Despatch reserves the order line itself.
    const { item, order } = await salesOrder(id, 2, 5);
    const salesDraft = await ok(draft("sales", order.id), 201);
    await ok(draft("sales", order.id), 409);
    const amend = (quantity: number, revision: number) =>
      send("POST", `/sales/orders/${order.id}/amend`, {
        commandId: newId(),
        expectedRevision: revision,
        document: {
          customerId: id,
          currency: "GBP",
          lines: [
            { id: order.lines[0].id, itemId: item.id, quantity, unit: "kg", unitPrice: 5, dueOn: today },
          ],
        },
        reason: "Customer asked for more",
      });
    expect((await ok(amend(3, order.revision), 409)).error.message).toContain("A reserved sales line");
    await ok(decide(salesDraft, "discard"));
    const amended = await ok(amend(3, order.revision));
    expect(await ok(draft("sales", order.id), 201)).toMatchObject({ net: "15.00" });
    expect(amended.revision).toBeGreaterThan(order.revision);

    // A standalone despatch reserves its lines.
    await setModules(["customers", "items", "stock", "despatch", "invoicing"]);
    const delivery = await shipment(id, 3);
    const despatchDraft = await ok(draft("despatch", delivery.id), 201);
    expect(despatchDraft.lines[0]).toMatchObject({ pricePending: true, taxPending: true, quantity: "3000" });
    await ok(draft("despatch", delivery.id), 409);
    await ok(decide(despatchDraft, "discard"));
    await ok(decide(await ok(draft("despatch", delivery.id), 201), "discard"));

    // A signed-off fixed-fee service quote reserves the quote.
    await setModules(["tasks", "time", "customers", "client_services", "invoicing"]);
    const boot = await ok(send("GET", "/bootstrap"));
    const { user } = await ok(ctx.req("/v1/me", { cookie: owner }));
    const quote = await ok(
      send("POST", "/client-services", {
        commandId: newId(),
        customerId: id,
        title: "Fixed audit",
        scope: "Fixture scope",
        currency: "GBP",
        unitPrice: 250,
        quotedMinutes: null,
        deliveryDate: today,
      }),
      201,
    );
    let revision = quote.revision;
    for (const [action, more] of [
      ["issue", {}],
      ["accept", { teamId: boot.teams[0].id, leadId: user.id }],
      ["deliver", { approvedMinutes: null }],
    ] as const)
      revision = (
        await ok(
          send("POST", `/client-services/${quote.id}/decision`, {
            commandId: newId(),
            expectedRevision: revision,
            action,
            reason: "Fixture sign-off",
            ...more,
          }),
        )
      ).revision;
    const serviceDraft = await ok(draft("service", quote.id), 201);
    expect(serviceDraft).toMatchObject({ net: "250.00", lines: [{ taxPending: true }] });
    await ok(draft("service", quote.id), 409);
    await ok(decide(serviceDraft, "discard"));
    await ok(draft("service", quote.id), 201);
  });

  it("refuses to void a reserved return receipt until its invoice line is credited", async () => {
    await setModules(["customers", "items", "stock", "despatch", "invoicing"]);
    const id = await customer("RETURNS");
    const delivery = await shipment(id, 5);
    const returned = await ok(
      send("POST", `/despatch/${delivery.id}/returns`, {
        commandId: newId(),
        lineId: delivery.lines[0].id,
        quantity: 1,
        unit: "kg",
        locationId,
        receivedOn: today,
        reason: "Damaged case",
        condition: "Damaged",
      }),
      201,
    );
    const returnId = returned.returns?.[0]?.id ?? returned.id;
    const voidReturn = () =>
      send("POST", `/despatch/${delivery.id}/returns/${returnId}/void`, {
        commandId: newId(),
        reason: "Recorded against the wrong delivery",
      });
    const drafted = await ok(draft("despatch", delivery.id), 201);
    expect(drafted.lines[0]).toMatchObject({ quantity: "4000" });
    expect((await ok(voidReturn(), 409)).error.message).toContain("Discard the invoice draft");
    const invoice = await ok(decide(await price(drafted, "0.01")));
    expect(invoice).toMatchObject({ net: "40.00", tax: "8.00" });
    expect((await ok(voidReturn(), 409)).error.message).toContain("Issue a credit note");
    const voidDelivery = () =>
      send("POST", `/despatch/${delivery.id}/void`, { commandId: newId(), reason: "Recording correction" });
    expect((await ok(voidDelivery(), 409)).error.message).toContain("Issue a credit note");
    await ok(decide(await ok(credit(invoice, [invoice.lines[0].id]), 201)));
    await ok(voidReturn());
    // Credits keep the reservation: the corrected quantity is not billable again from Despatch.
    await ok(draft("despatch", delivery.id), 409);
  });

  it("sells, despatches and invoices a spare part from Sales and from Despatch", async () => {
    await setModules(["customers", "items", "stock", "sales", "despatch", "invoicing"]);
    const id = await customer("SPARES");
    if (!locationId)
      locationId = (await ok(send("POST", "/stock/locations", { name: "Invoicing warehouse" }), 201)).id;
    const spare = await ok(
      send("POST", "/items", {
        code: `SP-${newId().slice(-8)}`,
        name: "Spare belt",
        type: "spare_part",
        unit: "each",
      }),
      201,
    );
    const lot = await ok(
      send("POST", "/stock/receipts", {
        itemId: spare.id,
        locationId,
        quantity: 10,
        unit: "each",
        receivedOn: today,
        reason: "Fixture stock",
      }),
      201,
    );
    const placed = await ok(
      send("POST", "/sales/orders", {
        commandId: newId(),
        kind: "order",
        document: {
          customerId: id,
          currency: "GBP",
          lines: [{ itemId: spare.id, quantity: 3, unit: "each", unitPrice: 4, dueOn: today }],
        },
      }),
      201,
    );
    const order = await ok(
      send("POST", `/sales/orders/${placed.id}/confirm`, {
        commandId: newId(),
        expectedRevision: placed.revision,
        reason: "Reviewed",
      }),
    );
    const despatchOf = async (quantity: number) => {
      const delivery = await ok(
        send("POST", "/despatch", {
          customerId: id,
          despatchedOn: today,
          lines: [{ lotId: lot.id, locationId, quantity, unit: "each" }],
        }),
        201,
      );
      const ready = await prepareDespatch(send, delivery.id);
      expect(ready.error).toBeUndefined();
      return ok(
        send("POST", `/despatch/${delivery.id}/confirm`, {
          commandId: newId(),
          expectedUpdatedAt: ready.stamp,
        }),
      );
    };
    const shipped = await despatchOf(3);
    // Confirming the despatch takes the spare parts out of stock.
    expect(await ok(send("GET", `/stock/lots/${lot.id}`))).toMatchObject({ onHand: { base: 7 } });
    await ok(
      send("POST", `/sales/orders/${order.id}/fulfilments`, {
        commandId: newId(),
        expectedRevision: order.revision,
        orderLineId: order.lines[0].id,
        despatchLineId: shipped.lines[0].id,
        reason: "Fulfilled customer order",
      }),
    );
    const fromSales = await ok(draft("sales", order.id), 201);
    expect(fromSales).toMatchObject({ net: "12.00", lines: [{ quantity: "3" }] });
    expect(await ok(decide(await price(fromSales)))).toMatchObject({ status: "issued", gross: "14.40" });

    const standalone = await despatchOf(2);
    const fromDespatch = await ok(draft("despatch", standalone.id), 201);
    expect(fromDespatch.lines[0]).toMatchObject({ pricePending: true, quantity: "2" });
    expect(await ok(decide(await price(fromDespatch, "5")))).toMatchObject({
      status: "issued",
      net: "10.00",
    });
  });
});
