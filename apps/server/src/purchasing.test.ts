import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { addDays } from "@knotworking/core";
import { items } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

/** Today in the test workspaces' zone (the default, Europe/London), as the server decides it. */
const utcToday = () => todayInZone(DEFAULT_TIME_ZONE);

const WS = "/v1/workspaces/acme";

describe("purchasing module", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const today = utcToday();
  const year = today.slice(0, 4);
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  const grant = (moduleId: string, level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
  const ok = async (res: { status: number; json(): Promise<any> }, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const error = async (res: { status: number; json(): Promise<any> }, status: number) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body.error as { code: string; message: string; details?: any };
  };
  const order = async (id: string) => ok(await as(ada).get(`/purchasing/orders/${id}`));
  const lineOf = (o: any, itemId: string) => o.lines.find((l: { itemId: string }) => l.itemId === itemId);

  // Fixtures.
  let flour: string; // ingredient, kg, standard cost 0.8 per kg
  let sugar: string; // ingredient, kg, no standard cost
  let box: string; // packaging, each
  let cake: string; // finished: not purchasable
  let oldSalt: string; // archived ingredient
  let mill: string; // approved
  let dairy: string; // pending
  let bad: string; // suspended
  let store: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    marcus = {
      userId: members.find((x: { email: string }) => x.email === "marcus@knotworking.dev").userId,
      cookie: (await signIn(ctx, "marcus@knotworking.dev")).cookie,
    };
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write" },
        })
      ).json()
    ).token;
    const supplier = async (name: string, status?: string) => {
      const id = (await ok(await as(ada).send("POST", "/suppliers", { name }), 201)).id;
      if (status) await ok(await as(ada).send("POST", `/suppliers/${id}/approval`, { status }));
      return id as string;
    };
    mill = await supplier("Mill", "approved");
    dairy = await supplier("New Dairy");
    bad = await supplier("Bad Farm", "suspended");
    const item = async (body: object) => (await ok(await as(ada).send("POST", "/items", body), 201)).id;
    flour = await item({
      code: "FLR",
      name: "Flour",
      type: "ingredient",
      unit: "kg",
      standardCost: 0.8,
      shelfLifeDays: 270,
      suppliers: [{ supplierId: mill, preferred: true }],
    });
    sugar = await item({ code: "SUG", name: "Sugar", type: "ingredient", unit: "kg" });
    box = await item({ code: "BOX", name: "Box", type: "packaging", unit: "each" });
    cake = await item({ code: "CAKE", name: "Cake", type: "finished", unit: "each" });
    oldSalt = await item({ code: "SLT", name: "Old salt", type: "ingredient", unit: "kg" });
    await ok(await as(ada).send("PATCH", `/items/${oldSalt}`, { status: "archived" }));
    store = (await ok(await as(ada).send("POST", "/stock/locations", { name: "Store" }), 201)).id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("access", () => {
    it("is opt-in: members need a grant, read can't write, and it needs items and stock", async () => {
      expect((await error(await as(marcus.cookie).get("/purchasing/orders"), 403)).code).toBe(
        "module_forbidden",
      );
      await grant("purchasing", "read");
      // Purchasing depends on items and stock.
      expect((await as(marcus.cookie).get("/purchasing/orders")).status).toBe(403);
      await grant("items", "read");
      await grant("stock", "read");
      await ok(await as(marcus.cookie).get("/purchasing/orders"));
      const write = await as(marcus.cookie).send("POST", "/purchasing/orders", { supplierId: mill });
      expect((await error(write, 403)).code).toBe("module_forbidden");
      await grant("purchasing", "write");
      // Write drafts an order, but sending it (a commitment to buy) needs manage: refused before
      // the order is even looked up.
      const send = await as(marcus.cookie).send(
        "POST",
        "/purchasing/orders/00000000-0000-7000-8000-000000000000/send",
        {},
      );
      expect((await error(send, 403)).code).toBe("module_forbidden");
    });

    it("is switched off with the module", async () => {
      const off = await makeApp({ seed: true, activeModules: ["tasks", "docs", "items", "stock"] });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const res = await off.req(`${WS}/purchasing/orders`, { cookie });
      expect((await error(res, 404)).code).toBe("module_inactive");
      await off.handle.close();
    }, 60_000);
  });

  describe("orders", () => {
    let po: string;
    let reference: string;
    let firstFlourReceipt: { lotId: string; stockMovementId: string };

    it("drafts an order (agents may), with a yearly reference and prices from the standard cost", async () => {
      const created = await ok(
        await viaToken("POST", "/purchasing/orders", {
          supplierId: mill,
          deliveryLocationId: store,
          supplierReference: "MILL-77",
          lines: [
            { itemId: flour, quantity: 25, unit: "kg" },
            { itemId: sugar, quantity: 10_000, unit: "g", unitPrice: 0.002 },
            { itemId: box, quantity: 100, unit: "each" },
          ],
        }),
        201,
      );
      po = created.id;
      reference = created.reference;
      expect(created).toMatchObject({
        reference: `PO-${year}-001`,
        status: "draft",
        state: "draft",
        supplier: { id: mill, name: "Mill", approvalStatus: "approved" },
        deliveryLocation: { id: store, name: "Store" },
        linesCount: 3,
        // 25 kg × 0.8 + 10 000 g × 0.002; the box has no price.
        value: 40,
        valueComplete: false,
        deliveries: [],
      });
      expect(lineOf(created, flour)).toMatchObject({
        lineNo: 1,
        quantity: 25_000,
        unit: "kg",
        unitPrice: 0.8,
        ordered: { base: 25_000, baseUnit: "g", display: 25, displayUnit: "kg", inLineUnit: 25 },
        state: "none",
        lineValue: 20,
        supplierListed: true,
        hasReceipts: false,
      });
      expect(lineOf(created, sugar)).toMatchObject({
        unitPrice: 0.002,
        supplierListed: false,
        lineValue: 20,
      });
      expect(lineOf(created, box)).toMatchObject({ unitPrice: null, lineValue: null });
      expect(created.workspaceId).toBeUndefined();
    });

    it("refuses items that aren't bought, archived items, unit mismatches and blocked suppliers", async () => {
      const create = (body: object) =>
        as(ada).send("POST", "/purchasing/orders", { supplierId: mill, ...body });
      const line = (itemId: string, unit = "kg") => ({ lines: [{ itemId, quantity: 1, unit }] });
      expect((await error(await create(line(cake, "each")), 409)).code).toBe("item_not_purchasable");
      expect((await error(await create(line(oldSalt)), 409)).code).toBe("item_archived");
      expect((await error(await create(line(flour, "l")), 400)).code).toBe("unit_not_convertible");
      expect(
        (await error(await as(ada).send("POST", "/purchasing/orders", { supplierId: bad }), 409)).code,
      ).toBe("supplier_not_approved");
    });

    it("edits a draft: header, quantities and prices; left-out prices are kept", async () => {
      const current = await order(po);
      const [f, s, b] = current.lines;
      const edited = await ok(
        await as(ada).send("PATCH", `/purchasing/orders/${po}`, {
          expectedOn: addDays(today, 7),
          lines: [
            { id: f.id, itemId: flour, quantity: 30, unit: "kg" },
            { id: s.id, itemId: sugar, quantity: 10, unit: "kg", unitPrice: 2 },
            { id: b.id, itemId: box, quantity: 100, unit: "each", unitPrice: 0.5 },
          ],
        }),
      );
      expect(edited.expectedOn).toBe(addDays(today, 7));
      expect(lineOf(edited, flour)).toMatchObject({ quantity: 30_000, unitPrice: 0.8, id: f.id });
      expect(lineOf(edited, sugar)).toMatchObject({ quantity: 10_000, unit: "kg", unitPrice: 2 });
      expect(edited).toMatchObject({ value: 24 + 20 + 50, valueComplete: true });
    });

    it("sends: a person's act, needing lines and an expected date", async () => {
      expect((await error(await viaToken("POST", `/purchasing/orders/${po}/send`, {}), 403)).code).toBe(
        "token_not_allowed",
      );
      const future = await as(ada).send("POST", `/purchasing/orders/${po}/send`, {
        orderedOn: addDays(today, 1),
      });
      expect((await error(future, 400)).code).toBe("invalid_input");

      const empty = await ok(await as(ada).send("POST", "/purchasing/orders", { supplierId: mill }), 201);
      expect(empty.reference).toBe(`PO-${year}-002`);
      expect(
        (await error(await as(ada).send("POST", `/purchasing/orders/${empty.id}/send`, {}), 400)).message,
      ).toMatch(/at least one line/);
      await ok(
        await as(ada).send("PATCH", `/purchasing/orders/${empty.id}`, {
          lines: [{ itemId: flour, quantity: 1, unit: "kg" }],
        }),
      );
      expect(
        (await error(await as(ada).send("POST", `/purchasing/orders/${empty.id}/send`, {}), 400)).message,
      ).toMatch(/expected delivery date/);

      const sent = await ok(await as(ada).send("POST", `/purchasing/orders/${po}/send`, {}));
      expect(sent).toMatchObject({ status: "sent", state: "sent", orderedOn: today, sentByName: "Ada Park" });
      expect(sent.sentAt).toBeTruthy();
      expect((await error(await as(ada).send("POST", `/purchasing/orders/${po}/send`, {}), 409)).code).toBe(
        "not_draft",
      );
    });

    it("receives part of the order: a lot and a receipt movement named after the order", async () => {
      const res = await ok(
        await viaToken("POST", `/purchasing/orders/${po}/receipts`, {
          receivedOn: today,
          deliveryReference: "DN-1",
          lines: [
            {
              lineId: lineOf(await order(po), flour).id,
              outcome: "accepted",
              quantity: 10,
              unit: "kg",
              locationId: store,
              supplierLotCode: "M-1",
            },
            {
              lineId: lineOf(await order(po), sugar).id,
              outcome: "rejected",
              quantity: 2,
              unit: "kg",
              reason: "Wet bags",
            },
          ],
        }),
        201,
      );
      expect(res.deliveryId).toBeTruthy();
      const [accepted, rejected] = res.receipts;
      expect(accepted).toMatchObject({
        outcome: "accepted",
        quantity: { base: 10_000, inLineUnit: 10 },
        // 0.8 per kg is 0.0008 per g.
        unitPrice: 0.0008,
      });
      expect(accepted.lotCode).toBeTruthy();
      expect(rejected).toMatchObject({
        outcome: "rejected",
        lotId: null,
        stockMovementId: null,
        reason: "Wet bags",
      });
      firstFlourReceipt = accepted;

      const lot = await ok(await as(ada).get(`/stock/lots/${accepted.lotId}`));
      expect(lot).toMatchObject({
        supplierLotCode: "M-1",
        status: "available",
        supplier: { id: mill },
        onHand: { base: 10_000 },
        expiryType: "best_before",
      });
      expect(lot.movements).toEqual([
        expect.objectContaining({ type: "receipt", reference: `${reference} / DN-1` }),
      ]);

      const o = res.order;
      expect(o.state).toBe("part_received");
      expect(lineOf(o, flour)).toMatchObject({
        state: "partial",
        received: { base: 10_000 },
        outstanding: { base: 20_000, inLineUnit: 20 },
        hasReceipts: true,
      });
      // A refusal at the door moves no stock and receives nothing.
      expect(lineOf(o, sugar)).toMatchObject({
        state: "none",
        received: { base: 0 },
        rejected: { base: 2000 },
      });
      expect(o.deliveries).toHaveLength(1);
      expect(o.deliveries[0]).toMatchObject({
        deliveryReference: "DN-1",
        receivedOn: today,
        actorName: "Ada Park",
      });
      expect(o.deliveries[0].receipts.map((r: { reversed: boolean }) => r.reversed)).toEqual([false, false]);
    });

    it("refuses deliveries in the future, to lines of other orders, and into archived locations", async () => {
      const flourLine = lineOf(await order(po), flour).id;
      const receive = (body: object) =>
        as(ada).send("POST", `/purchasing/orders/${po}/receipts`, { receivedOn: today, ...body });
      const accept = { lineId: flourLine, outcome: "accepted", quantity: 1, unit: "kg", locationId: store };
      expect((await error(await receive({ receivedOn: addDays(today, 1), lines: [accept] }), 400)).code).toBe(
        "invalid_input",
      );
      const other = await ok(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId: mill,
          lines: [{ itemId: flour, quantity: 1, unit: "kg" }],
        }),
        201,
      );
      expect(
        (await error(await receive({ lines: [{ ...accept, lineId: other.lines[0].id }] }), 400)).code,
      ).toBe("invalid_input");
      // Drafts can't be received against.
      const draft = await as(ada).send("POST", `/purchasing/orders/${other.id}/receipts`, {
        receivedOn: today,
        lines: [{ ...accept, lineId: other.lines[0].id }],
      });
      expect((await error(draft, 409)).code).toBe("order_not_open");
    });

    it("over-delivers: the line is over and the order received; an invoice price is per its unit", async () => {
      const o = await order(po);
      const res = await ok(
        await as(ada).send("POST", `/purchasing/orders/${po}/receipts`, {
          receivedOn: today,
          lines: [
            {
              lineId: lineOf(o, flour).id,
              outcome: "accepted",
              quantity: 21,
              unit: "kg",
              locationId: store,
            },
            {
              lineId: lineOf(o, sugar).id,
              outcome: "accepted",
              quantity: 10,
              unit: "kg",
              locationId: store,
              unitPrice: 2.5,
            },
            {
              lineId: lineOf(o, box).id,
              outcome: "accepted",
              quantity: 100,
              unit: "each",
              locationId: store,
            },
          ],
        }),
        201,
      );
      expect(res.receipts.map((r: { unitPrice: number }) => r.unitPrice)).toEqual([0.0008, 0.0025, 0.5]);
      const lot = await ok(await as(ada).get(`/stock/lots/${res.receipts[0].lotId}`));
      expect(lot.movements[0].reference).toBe(reference);
      expect(res.order.state).toBe("received");
      expect(lineOf(res.order, flour)).toMatchObject({ state: "over", outstanding: { base: 0 } });
      expect(res.order.deliveries).toHaveLength(2);
    });

    it("counts a receipt reversed in stock as never received", async () => {
      await ok(
        await as(ada).send("POST", `/stock/movements/${firstFlourReceipt.stockMovementId}/reverse`, {
          reason: "Booked against the wrong order",
        }),
        201,
      );
      const o = await order(po);
      expect(o.state).toBe("part_received");
      expect(lineOf(o, flour)).toMatchObject({
        state: "partial",
        received: { base: 21_000 },
        outstanding: { base: 9000 },
      });
      const reversed = o.deliveries[0].receipts.find(
        (r: { lotId: string | null }) => r.lotId === firstFlourReceipt.lotId,
      );
      expect(reversed.reversed).toBe(true);
    });

    it("limits edits once sent", async () => {
      const o = await order(po);
      const [f, s, b] = o.lines;
      const keep = [
        { id: f.id, itemId: flour, quantity: 30, unit: "kg" },
        { id: s.id, itemId: sugar, quantity: 10, unit: "kg" },
        { id: b.id, itemId: box, quantity: 100, unit: "each" },
      ];
      const patch = (body: object) => as(ada).send("PATCH", `/purchasing/orders/${po}`, body);
      // A line with receipts (even only a refused one) can't be removed.
      expect((await error(await patch({ lines: [keep[0], keep[2]] }), 409)).code).toBe("line_has_receipts");
      // Nor go below what was accepted (21 kg).
      const below = await error(
        await patch({ lines: [{ ...keep[0], quantity: 20 }, keep[1], keep[2]] }),
        409,
      );
      expect(below.code).toBe("below_received");
      expect(below.details).toMatchObject({ lineId: f.id, received: { base: 21_000 } });
      expect((await error(await patch({ supplierId: dairy }), 409)).code).toBe("not_draft");
      // Lines may be added, re-priced, re-dated and resized.
      const edited = await ok(
        await patch({
          supplierReference: "MILL-78",
          lines: [
            { ...keep[0], quantity: 21, unitPrice: 0.75, expectedOn: addDays(today, 3) },
            keep[1],
            keep[2],
            { itemId: sugar, quantity: 5, unit: "kg", unitPrice: 2 },
          ],
        }),
      );
      expect(edited.supplierReference).toBe("MILL-78");
      expect(edited.lines.map((l: { lineNo: number }) => l.lineNo)).toEqual([1, 2, 3, 4]);
      expect(edited.lines[0]).toMatchObject({ quantity: 21_000, unitPrice: 0.75, state: "full" });
      expect(edited.lines[3]).toMatchObject({
        itemId: sugar,
        state: "none",
        effectiveExpectedOn: addDays(today, 7),
      });
      expect(edited.state).toBe("part_received");
      // Removing the new line again is fine: nothing was received against it.
      const back = await ok(
        await patch({ lines: keep.map((l, i) => (i === 0 ? { ...l, quantity: 21 } : l)) }),
      );
      expect(back.lines).toHaveLength(3);
      expect(back.state).toBe("received");
    });

    it("closes and cancels: people only; cancelling is refused once goods have been accepted", async () => {
      const cancel = await as(ada).send("POST", `/purchasing/orders/${po}/cancel`, {
        reason: "Changed mind",
      });
      expect((await error(cancel, 409)).code).toBe("has_receipts");
      expect(
        (await error(await viaToken("POST", `/purchasing/orders/${po}/close`, { reason: "Done" }), 403)).code,
      ).toBe("token_not_allowed");
      expect(
        (await error(await viaToken("POST", `/purchasing/orders/${po}/cancel`, { reason: "x" }), 403)).code,
      ).toBe("token_not_allowed");
      const closed = await ok(
        await as(ada).send("POST", `/purchasing/orders/${po}/close`, { reason: "Short shipped, no more" }),
      );
      expect(closed).toMatchObject({
        status: "closed",
        state: "closed",
        closeReason: "Short shipped, no more",
        closedByName: "Ada Park",
      });
      expect(
        (await error(await as(ada).send("PATCH", `/purchasing/orders/${po}`, { notes: "x" }), 409)).code,
      ).toBe("order_closed");
      const flourLine = lineOf(closed, flour).id;
      const receive = await as(ada).send("POST", `/purchasing/orders/${po}/receipts`, {
        receivedOn: today,
        lines: [{ lineId: flourLine, outcome: "accepted", quantity: 1, unit: "kg", locationId: store }],
      });
      expect((await error(receive, 409)).code).toBe("order_not_open");
      expect(
        (await error(await as(ada).send("POST", `/purchasing/orders/${po}/close`, { reason: "x" }), 409))
          .code,
      ).toBe("order_not_open");
      expect(
        (await error(await as(ada).send("POST", `/purchasing/orders/${po}/cancel`, { reason: "x" }), 409))
          .code,
      ).toBe("order_closed");
      expect((await error(await as(ada).send("DELETE", `/purchasing/orders/${po}`), 409)).code).toBe(
        "not_draft",
      );
    });

    it("cancels a sent order with only refused deliveries, and a draft; deletes drafts", async () => {
      const sent = await ok(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId: mill,
          expectedOn: today,
          lines: [{ itemId: box, quantity: 10, unit: "each" }],
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/purchasing/orders/${sent.id}/send`, {}));
      await ok(
        await as(ada).send("POST", `/purchasing/orders/${sent.id}/receipts`, {
          receivedOn: today,
          lines: [
            { lineId: sent.lines[0].id, outcome: "rejected", quantity: 10, unit: "each", reason: "Crushed" },
          ],
        }),
        201,
      );
      const cancelled = await ok(
        await as(ada).send("POST", `/purchasing/orders/${sent.id}/cancel`, {
          reason: "Supplier can't resend",
        }),
      );
      expect(cancelled).toMatchObject({
        status: "cancelled",
        state: "cancelled",
        cancelReason: "Supplier can't resend",
      });

      const draft = await ok(await as(ada).send("POST", "/purchasing/orders", { supplierId: mill }), 201);
      const gone = await ok(await as(ada).send("POST", "/purchasing/orders", { supplierId: mill }), 201);
      await ok(await as(ada).send("POST", `/purchasing/orders/${draft.id}/cancel`, { reason: "Not needed" }));
      expect((await as(ada).send("DELETE", `/purchasing/orders/${gone.id}`)).status).toBe(204);
      expect((await as(ada).get(`/purchasing/orders/${gone.id}`)).status).toBe(404);
      // References are never reused, deleted orders included.
      const next = await ok(await as(ada).send("POST", "/purchasing/orders", { supplierId: mill }), 201);
      expect(Number(next.reference.slice(-3))).toBe(Number(gone.reference.slice(-3)) + 1);
      await as(ada).send("DELETE", `/purchasing/orders/${next.id}`);
    });
  });

  describe("supplier approval", () => {
    it("lets a pending supplier be ordered from, but their goods go into quarantine", async () => {
      const o = await ok(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId: dairy,
          expectedOn: today,
          lines: [{ itemId: sugar, quantity: 5, unit: "kg" }],
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/send`, {}));
      const line = { lineId: o.lines[0].id, outcome: "accepted", quantity: 5, unit: "kg", locationId: store };
      const receive = (extra: object) =>
        as(ada).send("POST", `/purchasing/orders/${o.id}/receipts`, {
          receivedOn: today,
          lines: [{ ...line, ...extra }],
        });
      expect((await error(await receive({}), 409)).code).toBe("supplier_not_approved");
      const res = await ok(await receive({ status: "quarantine" }), 201);
      const lot = await ok(await as(ada).get(`/stock/lots/${res.receipts[0].lotId}`));
      expect(lot).toMatchObject({ status: "quarantine", supplier: { id: dairy } });
    });

    it("refuses a supplier suspended after ordering: edit-to, send, more on order and accepted goods", async () => {
      const flaky = (await ok(await as(ada).send("POST", "/suppliers", { name: "Flaky" }), 201)).id;
      await ok(await as(ada).send("POST", `/suppliers/${flaky}/approval`, { status: "approved" }));
      const body = {
        supplierId: flaky,
        expectedOn: today,
        lines: [{ itemId: box, quantity: 10, unit: "each" }],
      };
      const sent = await ok(await as(ada).send("POST", "/purchasing/orders", body), 201);
      await ok(await as(ada).send("POST", `/purchasing/orders/${sent.id}/send`, {}));
      const draft = await ok(await as(ada).send("POST", "/purchasing/orders", body), 201);
      const other = await ok(
        await as(ada).send("POST", "/purchasing/orders", { ...body, supplierId: mill }),
        201,
      );
      await ok(
        await as(ada).send("POST", `/suppliers/${flaky}/approval`, {
          status: "suspended",
          note: "Audit failed",
        }),
      );

      expect(
        (await error(await as(ada).send("POST", `/purchasing/orders/${draft.id}/send`, {}), 409)).code,
      ).toBe("supplier_not_approved");
      expect(
        (
          await error(
            await as(ada).send("PATCH", `/purchasing/orders/${other.id}`, { supplierId: flaky }),
            409,
          )
        ).code,
      ).toBe("supplier_not_approved");

      // Nothing more may be ordered from them: no new lines, no larger quantities.
      const lineId = sent.lines[0].id;
      const patch = (lines: object[]) => as(ada).send("PATCH", `/purchasing/orders/${sent.id}`, { lines });
      const keep = { id: lineId, itemId: box, unit: "each" };
      expect(
        (
          await error(
            await patch([
              { ...keep, quantity: 10 },
              { itemId: box, quantity: 1, unit: "each" },
            ]),
            409,
          )
        ).code,
      ).toBe("supplier_not_approved");
      expect((await error(await patch([{ ...keep, quantity: 11 }]), 409)).code).toBe("supplier_not_approved");
      // Less, later and notes are still fine.
      const lowered = await ok(
        await patch([{ ...keep, quantity: 6, expectedOn: addDays(today, 2), notes: "Only 6 now" }]),
      );
      expect(lowered.lines[0]).toMatchObject({
        quantity: 6,
        expectedOn: addDays(today, 2),
        notes: "Only 6 now",
      });

      // Accepted goods are refused; a refusal at the door is recorded.
      const receive = (line: object) =>
        as(ada).send("POST", `/purchasing/orders/${sent.id}/receipts`, { receivedOn: today, lines: [line] });
      const accepted = { lineId, outcome: "accepted", quantity: 1, unit: "each", locationId: store };
      expect((await error(await receive(accepted), 409)).code).toBe("supplier_not_approved");
      expect((await error(await receive({ ...accepted, status: "quarantine" }), 409)).code).toBe(
        "supplier_not_approved",
      );
      const refused = await ok(
        await receive({
          lineId,
          outcome: "rejected",
          quantity: 6,
          unit: "each",
          reason: "Supplier suspended",
        }),
        201,
      );
      expect(refused.receipts[0]).toMatchObject({ outcome: "rejected", lotId: null });

      await as(ada).send("DELETE", `/purchasing/orders/${draft.id}`);
      await as(ada).send("DELETE", `/purchasing/orders/${other.id}`);
      await ok(await as(ada).send("POST", `/purchasing/orders/${sent.id}/cancel`, { reason: "Suspended" }));
    });
  });

  describe("listing", () => {
    it("filters by state, supplier, item and text, with totals", async () => {
      const list = async (query: string) => ok(await as(marcus.cookie).get(`/purchasing/orders?${query}`));
      const all = await list("status=all");
      expect(all.total).toBe(all.orders.length);
      const refs = (page: { orders: { reference: string }[] }) => page.orders.map((o) => o.reference);

      // PO-001 closed; the pending dairy order received in full.
      const open = await list("status=open");
      expect(open.orders.every((o: { state: string }) => ["sent", "part_received"].includes(o.state))).toBe(
        true,
      );
      expect(refs(await list("status=closed"))).toEqual([`PO-${year}-001`]);
      const received = await list("status=received");
      expect(received.orders.map((o: { supplier: { id: string } }) => o.supplier.id)).toEqual([dairy]);
      expect(received.orders[0]).toMatchObject({ linesCount: 1, receivedLines: 1, outstandingLines: 0 });
      const cancelled = await list("status=cancelled");
      expect(cancelled.total).toBeGreaterThanOrEqual(2);

      expect((await list(`supplierId=${dairy}`)).total).toBe(1);
      const withFlour = await list(`itemId=${flour}`);
      expect(refs(withFlour)).toContain(`PO-${year}-001`);
      expect(withFlour.orders.every((o: { supplier: { id: string } }) => o.supplier.id === mill)).toBe(true);
      expect(refs(await list("q=mill-78"))).toEqual([`PO-${year}-001`]);
      expect(refs(await list(`q=PO-${year}-001`))).toEqual([`PO-${year}-001`]);
      expect(
        (await list("q=dairy")).orders.map((o: { supplier: { name: string } }) => o.supplier.name),
      ).toEqual(["New Dairy"]);
      const paged = await list("status=all&limit=2&offset=1");
      expect(paged.orders).toHaveLength(2);
      expect(paged.total).toBe(all.total);
      // An expected-date window, on the earliest line date: PO-001's header says +7, but its first
      // line was re-dated to +3.
      expect(refs(await list(`from=${addDays(today, 3)}&to=${addDays(today, 3)}`))).toEqual([
        `PO-${year}-001`,
      ]);
      expect(refs(await list(`from=${addDays(today, 6)}&to=${addDays(today, 8)}`))).toEqual([]);
    });

    it("flags an open order past its expected date as overdue", async () => {
      const late = await ok(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId: mill,
          expectedOn: addDays(today, -2),
          lines: [{ itemId: box, quantity: 5, unit: "each" }],
        }),
        201,
      );
      const sent = await ok(await as(ada).send("POST", `/purchasing/orders/${late.id}/send`, {}));
      expect(sent).toMatchObject({ overdue: true, state: "sent" });
      expect(sent.lines[0].overdue).toBe(true);
      await ok(await as(ada).send("POST", `/purchasing/orders/${late.id}/cancel`, { reason: "Test" }));
    });
  });

  describe("supplier performance", () => {
    it("counts on time, in full, OTIF and rejected deliveries; reversed receipts don't count", async () => {
      const perf = (await ok(await as(ada).send("POST", "/suppliers", { name: "Perf Foods" }), 201)).id;
      await ok(await as(ada).send("POST", `/suppliers/${perf}/approval`, { status: "approved" }));
      const due = addDays(today, -5);
      const o = await ok(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId: perf,
          expectedOn: due,
          lines: [
            { itemId: flour, quantity: 10, unit: "kg" },
            { itemId: sugar, quantity: 4, unit: "kg" },
            { itemId: box, quantity: 10, unit: "each" },
            // Not due yet: left out.
            { itemId: box, quantity: 10, unit: "each", expectedOn: addDays(today, 3) },
          ],
        }),
        201,
      );
      await ok(
        await as(ada).send("POST", `/purchasing/orders/${o.id}/send`, { orderedOn: addDays(today, -10) }),
      );
      const [flourLine, sugarLine, boxLine] = o.lines;
      const receive = async (receivedOn: string, lines: object[]) =>
        ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/receipts`, { receivedOn, lines }), 201);
      const accept = (lineId: string, quantity: number, unit: string) => ({
        lineId,
        outcome: "accepted",
        quantity,
        unit,
        locationId: store,
      });
      // Flour: 4 kg on time, the rest late → on time, in full, not OTIF.
      await receive(addDays(today, -6), [accept(flourLine.id, 4, "kg")]);
      await receive(addDays(today, -2), [
        accept(flourLine.id, 6, "kg"),
        { lineId: boxLine.id, outcome: "rejected", quantity: 10, unit: "each", reason: "Damaged" },
      ]);
      // Sugar: in full on time, but reversed in stock → nothing received.
      const sugarDelivery = await receive(due, [accept(sugarLine.id, 4, "kg")]);
      await ok(
        await as(ada).send("POST", `/stock/movements/${sugarDelivery.receipts[0].stockMovementId}/reverse`, {
          reason: "Wrong supplier",
        }),
        201,
      );

      const page = await ok(
        await as(marcus.cookie).get(
          `/purchasing/supplier-performance?supplierId=${perf}&from=${addDays(today, -30)}`,
        ),
      );
      expect(page).toMatchObject({ from: addDays(today, -30), to: today });
      expect(page.suppliers).toEqual([
        {
          supplier: { id: perf, name: "Perf Foods", code: null, approvalStatus: "approved" },
          linesDue: 3,
          onTime: 1,
          inFull: 1,
          otif: 0,
          onTimePercent: 33.3,
          inFullPercent: 33.3,
          otifPercent: 0,
          // The reversed sugar delivery is left out; one of the other two had a refusal.
          deliveries: 2,
          rejectedDeliveries: 1,
          qualityFlag: null,
        },
      ]);
      // Default period, all suppliers, sorted by name.
      const all = await ok(await as(ada).get("/purchasing/supplier-performance"));
      const names = all.suppliers.map((s: { supplier: { name: string } }) => s.supplier.name);
      expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b)));
      expect(names).toContain("Perf Foods");
    });
  });

  describe("suggestions", () => {
    let butter: string;
    let eggs: string;

    beforeAll(async () => {
      const item = async (body: object) => (await ok(await as(ada).send("POST", "/items", body), 201)).id;
      butter = await item({
        code: "BUT",
        name: "Butter",
        type: "ingredient",
        unit: "kg",
        standardCost: 5,
        suppliers: [{ supplierId: dairy }, { supplierId: mill, preferred: true }, { supplierId: bad }],
      });
      eggs = await item({ code: "EGG", name: "Eggs", type: "ingredient", unit: "each" });
      // In the shortfall, but not bought: made in house, and archived since the recipe was approved.
      const dough = await item({ code: "DGH", name: "Dough", type: "wip", unit: "kg" });
      const yeast = await item({ code: "YST", name: "Yeast", type: "ingredient", unit: "g" });
      const brioche = await item({ code: "BRI", name: "Brioche", type: "finished", unit: "each" });
      const recipe = await ok(
        await as(ada).send("POST", "/recipes", {
          code: "R-BRI",
          name: "Brioche",
          outputItemId: brioche,
          draft: {
            yieldQuantity: 1,
            yieldUnit: "each",
            lines: [
              { itemId: butter, quantity: 2, unit: "kg" },
              { itemId: eggs, quantity: 10, unit: "each" },
              { itemId: dough, quantity: 1, unit: "kg" },
              { itemId: yeast, quantity: 5, unit: "g" },
            ],
          },
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/recipes/${recipe.id}/draft/approve`));
      await ok(
        await as(ada).send("POST", "/production/batches", {
          recipeId: recipe.id,
          plannedOn: addDays(today, 3),
          batches: 5,
        }),
        201,
      );
      await ok(await as(ada).send("PATCH", `/items/${yeast}`, { status: "archived" }));
      // 4 kg on a sent order (subtracted), 1 kg on a draft (shown only).
      const sent = await ok(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId: dairy,
          expectedOn: addDays(today, 30),
          lines: [{ itemId: butter, quantity: 4, unit: "kg" }],
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/purchasing/orders/${sent.id}/send`, {}));
      await ok(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId: mill,
          lines: [{ itemId: butter, quantity: 1, unit: "kg" }],
        }),
        201,
      );
    }, 60_000);

    it("needs production on and readable", async () => {
      // Marcus can use purchasing, but not production.
      const res = await as(marcus.cookie).get("/purchasing/suggestions");
      expect((await error(res, 409)).code).toBe("production_unavailable");

      const off = await makeApp({
        seed: true,
        activeModules: ["tasks", "docs", "items", "stock", "purchasing"],
      });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const offRes = await off.req(`${WS}/purchasing/suggestions`, { cookie });
      expect((await error(offRes, 409)).code).toBe("production_unavailable");
      await off.handle.close();
    }, 60_000);

    it("turns the shortfall into what to order, by suggested supplier", async () => {
      const page = await ok(await viaToken("GET", "/purchasing/suggestions"));
      expect(page).toMatchObject({ from: today, to: addDays(today, 28) });
      const groups = page.groups.map((g: any) => ({
        supplier: g.supplier?.name ?? null,
        items: g.suggestions.map((s: any) => s.item.code),
      }));
      expect(groups).toEqual([
        { supplier: "Mill", items: ["BUT"] },
        { supplier: null, items: ["EGG"] },
      ]);
      // Work in progress and archived items are listed apart: they can't be ordered.
      expect(
        page.notPurchasable.map((r: any) => [r.item.code, r.reason, r.shortfall.base, r.shortfall.baseUnit]),
      ).toEqual([
        ["DGH", "made_in_house", 5000, "g"],
        ["YST", "archived", 25, "g"],
      ]);
      const butterRow = page.groups[0].suggestions[0];
      expect(butterRow).toMatchObject({
        item: { id: butter },
        shortfall: { base: 10_000 },
        onOrder: { base: 4000 },
        onDraft: { base: 1000 },
        toOrder: { base: 6000, display: 6, displayUnit: "kg" },
        quantity: 6,
        unit: "kg",
        unitPrice: 5,
        neededBy: addDays(today, 3),
        expectedOn: addDays(today, 3),
        supplierId: mill,
      });
      // The suspended supplier is never offered.
      expect(butterRow.otherSuppliers.map((s: { id: string }) => s.id)).toEqual([dairy]);
      expect(page.groups[1].suggestions[0]).toMatchObject({
        toOrder: { base: 50 },
        supplierId: null,
        unitPrice: null,
      });

      // A window longer than a year.
      const long = await as(ada).get(`/purchasing/suggestions?to=${addDays(today, 400)}`);
      expect((await error(long, 400)).code).toBe("invalid_input");
    });

    it("creates the chosen drafts all or nothing, naming the order a refusal is about", async () => {
      const before = (await ok(await as(ada).get("/purchasing/orders?status=draft"))).total;
      const orders = [
        {
          supplierId: mill,
          expectedOn: addDays(today, 3),
          lines: [{ itemId: butter, quantity: 6, unit: "kg" }],
        },
        {
          supplierId: dairy,
          lines: [
            { itemId: eggs, quantity: 50, unit: "each" },
            { itemId: cake, quantity: 1, unit: "each" },
          ],
        },
      ];
      const refused = await error(await viaToken("POST", "/purchasing/suggestions", { orders }), 409);
      expect(refused.code).toBe("item_not_purchasable");
      expect(refused.message).toMatch(/^Order 2 \(New Dairy\): .*Nothing was created\.$/);
      expect(refused.details).toMatchObject({ index: 1 });
      expect((await ok(await as(ada).get("/purchasing/orders?status=draft"))).total).toBe(before);

      orders[1]!.lines.pop();
      const created = await ok(await viaToken("POST", "/purchasing/suggestions", { orders }), 201);
      expect(created.orders.map((o: any) => [o.supplier.name, o.status, o.linesCount])).toEqual([
        ["Mill", "draft", 1],
        ["New Dairy", "draft", 1],
      ]);
      expect((await ok(await as(ada).get("/purchasing/orders?status=draft"))).total).toBe(before + 2);
      // Drafts are shown, not subtracted.
      const page = await ok(await as(ada).get("/purchasing/suggestions"));
      expect(page.groups[0].suggestions[0]).toMatchObject({
        onDraft: { base: 7000 },
        toOrder: { base: 6000 },
      });
    });
  });

  describe("prices, promised dates and edge cases", () => {
    let cocoa: string;
    let perf: string;
    const newSupplier = async (name: string) => {
      const id = (await ok(await as(ada).send("POST", "/suppliers", { name }), 201)).id as string;
      await ok(await as(ada).send("POST", `/suppliers/${id}/approval`, { status: "approved" }));
      return id;
    };
    const sentOrder = async (body: object, orderedOn?: string) => {
      const o = await ok(await as(ada).send("POST", "/purchasing/orders", body), 201);
      return ok(
        await as(ada).send("POST", `/purchasing/orders/${o.id}/send`, orderedOn ? { orderedOn } : {}),
      );
    };

    beforeAll(async () => {
      cocoa = (
        await ok(
          await as(ada).send("POST", "/items", {
            code: "COC",
            name: "Cocoa",
            type: "ingredient",
            unit: "kg",
            standardCost: 3.45,
          }),
          201,
        )
      ).id;
      perf = await newSupplier("Promise Keepers");
    });

    it("keeps 8 decimals on a price per gram: a gram line values the same as a kilo line", async () => {
      const o = await sentOrder({
        supplierId: mill,
        expectedOn: today,
        lines: [
          { itemId: cocoa, quantity: 25_000, unit: "g" },
          { itemId: cocoa, quantity: 25, unit: "kg" },
        ],
      });
      expect(o.lines.map((l: any) => [l.unitPrice, l.lineValue])).toEqual([
        [0.00345, 86.25],
        [3.45, 86.25],
      ]);
      expect(o.value).toBe(172.5);
      const res = await ok(
        await as(ada).send("POST", `/purchasing/orders/${o.id}/receipts`, {
          receivedOn: today,
          lines: o.lines.map((l: any) => ({
            lineId: l.id,
            outcome: "accepted",
            quantity: l.ordered.inLineUnit,
            unit: l.unit,
            locationId: store,
          })),
        }),
        201,
      );
      expect(res.receipts.map((r: any) => r.unitPrice)).toEqual([0.00345, 0.00345]);
    });

    it("refuses a quantity too large to store with 400, on lines and receipts", async () => {
      const huge = await as(ada).send("POST", "/purchasing/orders", {
        supplierId: mill,
        lines: [{ itemId: cocoa, quantity: 10_000_000, unit: "kg" }],
      });
      expect((await error(huge, 400)).message).toMatch(/too large/);
      const o = await sentOrder({
        supplierId: mill,
        expectedOn: today,
        lines: [{ itemId: cocoa, quantity: 1, unit: "kg" }],
      });
      const receive = await as(ada).send("POST", `/purchasing/orders/${o.id}/receipts`, {
        receivedOn: today,
        lines: [{ lineId: o.lines[0].id, outcome: "rejected", quantity: 2_000_000, unit: "kg", reason: "x" }],
      });
      expect((await error(receive, 400)).message).toMatch(/too large/);
      await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/cancel`, { reason: "Test" }));
    });

    it("keeps a sent order sendable: a line, and an expected date for every line", async () => {
      const o = await sentOrder({
        supplierId: mill,
        expectedOn: today,
        lines: [{ itemId: cocoa, quantity: 1, unit: "kg" }],
      });
      const patch = (body: object) => as(ada).send("PATCH", `/purchasing/orders/${o.id}`, body);
      expect((await error(await patch({ expectedOn: null }), 400)).message).toMatch(/expected delivery date/);
      expect((await error(await patch({ lines: [] }), 400)).message).toMatch(/at least one line/);
      // Clearing the header's date is fine once every line has its own.
      const lineDated = await ok(
        await patch({
          expectedOn: null,
          lines: [
            { id: o.lines[0].id, itemId: cocoa, quantity: 1, unit: "kg", expectedOn: addDays(today, 1) },
          ],
        }),
      );
      expect(lineDated.expectedOn).toBeNull();
      await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/cancel`, { reason: "Test" }));
    });

    it("promises each line its date when sent; re-dating doesn't move the promise", async () => {
      const due = addDays(today, -5);
      const draft = await ok(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId: perf,
          expectedOn: due,
          lines: [
            { itemId: cocoa, quantity: 10, unit: "kg" },
            { itemId: cocoa, quantity: 5, unit: "kg", expectedOn: addDays(today, -3) },
          ],
        }),
        201,
      );
      expect(draft.lines.map((l: any) => l.promisedOn)).toEqual([null, null]);
      const o = await ok(
        await as(ada).send("POST", `/purchasing/orders/${draft.id}/send`, { orderedOn: addDays(today, -10) }),
      );
      expect(o.lines.map((l: any) => l.promisedOn)).toEqual([due, addDays(today, -3)]);
      expect(o.lines.map((l: any) => l.promiseMoved)).toEqual([false, false]);

      // Late: the first line is re-dated to next week, and a line is added to the sent order.
      const [a, b] = o.lines;
      const edited = await ok(
        await as(ada).send("PATCH", `/purchasing/orders/${o.id}`, {
          lines: [
            { id: a.id, itemId: cocoa, quantity: 10, unit: "kg", expectedOn: addDays(today, 7) },
            { id: b.id, itemId: cocoa, quantity: 5, unit: "kg" },
            { itemId: cocoa, quantity: 1, unit: "kg" },
          ],
        }),
      );
      expect(edited.lines.map((l: any) => [l.promisedOn, l.effectiveExpectedOn, l.promiseMoved])).toEqual([
        [due, addDays(today, 7), true],
        [addDays(today, -3), addDays(today, -3), false],
        [due, due, false],
      ]);
      // Overdue follows the current date: the re-dated line no longer is.
      expect(edited.lines.map((l: any) => l.overdue)).toEqual([false, true, true]);

      // Received today: late against the promise, whatever the line says now.
      await ok(
        await as(ada).send("POST", `/purchasing/orders/${o.id}/receipts`, {
          receivedOn: today,
          lines: [{ lineId: a.id, outcome: "accepted", quantity: 10, unit: "kg", locationId: store }],
        }),
        201,
      );
      const page = await ok(await as(ada).get(`/purchasing/supplier-performance?supplierId=${perf}`));
      expect(page.suppliers[0]).toMatchObject({ linesDue: 3, onTime: 0, inFull: 1, otif: 0 });
    });

    it("still counts a cancelled order's refused delivery in performance", async () => {
      const rotten = await newSupplier("Rotten Veg");
      const o = await sentOrder({
        supplierId: rotten,
        expectedOn: today,
        lines: [{ itemId: cocoa, quantity: 10, unit: "kg" }],
      });
      await ok(
        await as(ada).send("POST", `/purchasing/orders/${o.id}/receipts`, {
          receivedOn: today,
          lines: [{ lineId: o.lines[0].id, outcome: "rejected", quantity: 10, unit: "kg", reason: "Mouldy" }],
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/cancel`, { reason: "Refused" }));
      const page = await ok(await as(ada).get(`/purchasing/supplier-performance?supplierId=${rotten}`));
      expect(page.suppliers).toEqual([
        expect.objectContaining({ linesDue: 0, deliveries: 1, rejectedDeliveries: 1, otifPercent: null }),
      ]);
    });

    it("promises lines their own dates when the order has none", async () => {
      const o = await sentOrder({
        supplierId: perf,
        lines: [{ itemId: cocoa, quantity: 1, unit: "kg", expectedOn: addDays(today, 4) }],
      });
      expect(o.lines[0].promisedOn).toBe(addDays(today, 4));
      await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/cancel`, { reason: "Test" }));
    });

    it("defaults performance to exactly the last 90 days", async () => {
      const page = await ok(await as(ada).get("/purchasing/supplier-performance"));
      expect(page).toMatchObject({ from: addDays(today, -89), to: today });
    });

    it("applies goods-in's item rule at receipt: archived and non-receivable items are refused", async () => {
      const item = async (code: string) =>
        (
          await ok(
            await as(ada).send("POST", "/items", { code, name: code, type: "ingredient", unit: "kg" }),
            201,
          )
        ).id as string;
      const salt = await item("SALT2");
      const malt = await item("MALT");
      const o = await sentOrder({
        supplierId: mill,
        expectedOn: today,
        lines: [
          { itemId: salt, quantity: 5, unit: "kg" },
          { itemId: malt, quantity: 5, unit: "kg" },
        ],
      });
      await ok(await as(ada).send("PATCH", `/items/${salt}`, { status: "archived" }));
      await ok(await as(ada).send("PATCH", `/items/${malt}`, { type: "finished" }));
      const receive = (line: object) =>
        as(ada).send("POST", `/purchasing/orders/${o.id}/receipts`, { receivedOn: today, lines: [line] });
      const accept = (lineId: string) => ({
        lineId,
        outcome: "accepted",
        quantity: 1,
        unit: "kg",
        locationId: store,
      });
      expect((await error(await receive(accept(o.lines[0].id)), 409)).code).toBe("item_archived");
      expect((await error(await receive(accept(o.lines[1].id)), 403)).code).toBe("item_not_receivable");
      // Refusing them at the door moves no stock, so it is recorded.
      await ok(
        await receive({
          lineId: o.lines[0].id,
          outcome: "rejected",
          quantity: 5,
          unit: "kg",
          reason: "Not needed",
        }),
        201,
      );
      // The order stays editable with the archived item on it.
      await ok(
        await as(ada).send("PATCH", `/purchasing/orders/${o.id}`, {
          lines: o.lines.map((l: any) => ({ id: l.id, itemId: l.itemId, quantity: 4, unit: "kg" })),
        }),
      );
      await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/cancel`, { reason: "Test" }));
    });

    it("keeps an order with a since-deleted item readable and editable; receiving it is refused", async () => {
      const gone = (
        await ok(
          await as(ada).send("POST", "/items", {
            code: "GONE",
            name: "Gone",
            type: "packaging",
            unit: "each",
          }),
          201,
        )
      ).id;
      const o = await sentOrder({
        supplierId: mill,
        expectedOn: today,
        lines: [{ itemId: gone, quantity: 5, unit: "each" }],
      });
      // Deleting an item on an order is refused now (`item_in_use`), but items deleted before that
      // rule may still sit on orders, so soft-delete it underneath the API.
      expect((await error(await as(ada).send("DELETE", `/items/${gone}`), 409)).code).toBe("item_in_use");
      await ctx.handle.db.update(items).set({ deletedAt: new Date() }).where(eq(items.id, gone));
      const read = await ok(await as(ada).get(`/purchasing/orders/${o.id}`));
      expect(read.lines[0].item.code).toBe("GONE");
      await ok(
        await as(ada).send("PATCH", `/purchasing/orders/${o.id}`, {
          lines: [{ id: o.lines[0].id, itemId: gone, quantity: 3, unit: "each" }],
        }),
      );
      const receive = await as(ada).send("POST", `/purchasing/orders/${o.id}/receipts`, {
        receivedOn: today,
        lines: [{ lineId: o.lines[0].id, outcome: "accepted", quantity: 3, unit: "each", locationId: store }],
      });
      expect((await error(receive, 409)).code).toBe("item_archived");
      // A new line still needs a live item.
      const add = await as(ada).send("PATCH", `/purchasing/orders/${o.id}`, {
        lines: [
          { id: o.lines[0].id, itemId: gone, quantity: 3, unit: "each" },
          { itemId: gone, quantity: 1, unit: "each" },
        ],
      });
      expect((await error(add, 404)).code).toBe("not_found");
      await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/cancel`, { reason: "Test" }));
    });

    it("filters the list by the earliest line date, as nextExpectedOn shows it", async () => {
      const day = addDays(today, 40);
      const o = await ok(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId: perf,
          expectedOn: addDays(today, 60),
          lines: [
            { itemId: cocoa, quantity: 1, unit: "kg", expectedOn: day },
            { itemId: cocoa, quantity: 1, unit: "kg" },
          ],
        }),
        201,
      );
      expect(o.nextExpectedOn).toBe(day);
      const found = await ok(await as(ada).get(`/purchasing/orders?from=${day}&to=${day}`));
      expect(found.orders.map((x: { id: string }) => x.id)).toEqual([o.id]);
      const later = await ok(
        await as(ada).get(`/purchasing/orders?from=${addDays(today, 59)}&to=${addDays(today, 61)}`),
      );
      expect(later.orders.map((x: { id: string }) => x.id)).not.toContain(o.id);
      await as(ada).send("DELETE", `/purchasing/orders/${o.id}`);
    });
  });

  describe("sync log", () => {
    it("records orders, lines and receipts, for members who can read purchasing", async () => {
      const entities = async (cookie: string) => {
        const seen = new Set<string>();
        for (let after = "0", more = true; more;) {
          const page = await ok(await as(cookie).get(`/sync?after=${after}&limit=1000`));
          for (const c of page.changes) seen.add(c.entity);
          ({ cursor: after, hasMore: more } = page);
        }
        return seen;
      };
      const forAda = await entities(ada);
      for (const entity of ["purchase_order", "purchase_order_line", "purchase_receipt", "stock_lot"]) {
        expect(forAda.has(entity), entity).toBe(true);
      }
      await grant("purchasing", null);
      const forMarcus = await entities(marcus.cookie);
      expect(forMarcus.has("purchase_order")).toBe(false);
      expect(forMarcus.has("purchase_receipt")).toBe(false);
      expect(forMarcus.has("stock_lot")).toBe(true);
    });
  });
  describe("deleting items and suppliers on orders", () => {
    it("refuses to delete an item on an order line, or the order's supplier", async () => {
      const item = (
        await ok(
          await as(ada).send("POST", "/items", {
            code: "PO-DEL",
            name: "Rye",
            type: "ingredient",
            unit: "kg",
          }),
          201,
        )
      ).id;
      const supplier = (await ok(await as(ada).send("POST", "/suppliers", { name: "Del Rye Mill" }), 201)).id;
      await ok(await as(ada).send("POST", `/suppliers/${supplier}/approval`, { status: "approved" }));
      await ok(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId: supplier,
          lines: [{ itemId: item, quantity: 1, unit: "kg" }],
        }),
        201,
      );
      expect((await error(await as(ada).send("DELETE", `/items/${item}`), 409)).code).toBe("item_in_use");
      expect((await error(await as(ada).send("DELETE", `/suppliers/${supplier}`), 409)).code).toBe(
        "supplier_in_use",
      );
    });
  });
  it("replays a delivery's original receipt without creating another lot", async () => {
    const draft = await ok(
      await as(ada).send("POST", "/purchasing/orders", {
        supplierId: mill,
        expectedOn: today,
        lines: [{ itemId: flour, quantity: 2, unit: "kg", unitPrice: 1 }],
      }),
      201,
    );
    const sent = await ok(
      await as(ada).send("POST", `/purchasing/orders/${draft.id}/send`, { orderedOn: today }),
    );
    const input = {
      commandId: crypto.randomUUID(),
      receivedOn: today,
      lines: [
        {
          lineId: sent.lines[0].id,
          outcome: "accepted",
          quantity: 1,
          unit: "kg",
          locationId: store,
        },
      ],
    };
    const receive = () => as(ada).send("POST", `/purchasing/orders/${draft.id}/receipts`, input);
    const first = await ok(await receive(), 201);
    expect(await ok(await receive(), 201)).toEqual(first);
    expect((await order(draft.id)).deliveries).toHaveLength(1);
  });
});
