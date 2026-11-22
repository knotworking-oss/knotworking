import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

/**
 * What an invoice is matched and costed against stays put: invoiced order lines are fixed, an
 * approved invoice's match is frozen at approval, units that don't convert are flagged, and lot
 * costs don't drift with an item's conversions.
 */
describe("supplier invoices: integrity of the match and costing", () => {
  let ctx: TestCtx;
  let ada: string;
  const today = todayInZone(DEFAULT_TIME_ZONE);
  const get = (path: string) => ctx.req(`${WS}${path}`, { cookie: ada });
  const send = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie: ada, json });
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
  const lineFor = (inv: any, itemId: string) => inv.lines.find((l: any) => l.item?.id === itemId);

  let mill: string;
  let store: string;
  const item = async (body: object) => (await ok(await send("POST", "/items", body), 201)).id as string;
  let n = 0;
  /** A sent order with these lines. */
  const sentOrder = async (lines: object[]) => {
    const created = await ok(
      await send("POST", "/purchasing/orders", { supplierId: mill, expectedOn: today, lines }),
      201,
    );
    await ok(await send("POST", `/purchasing/orders/${created.id}/send`, {}));
    return created;
  };
  const receive = async (orderId: string, lineId: string, quantity: number, unit: string) =>
    (
      await ok(
        await send("POST", `/purchasing/orders/${orderId}/receipts`, {
          receivedOn: today,
          lines: [{ lineId, outcome: "accepted", quantity, unit, locationId: store }],
        }),
        201,
      )
    ).receipts[0];
  const invoice = async (lines: object[]) =>
    ok(
      await send("POST", "/purchasing/invoices", {
        supplierId: mill,
        invoiceNumber: `T-${++n}`,
        invoiceDate: today,
        lines,
      }),
      201,
    );
  const approve = async (id: string, reason?: string) =>
    ok(await send("POST", `/purchasing/invoices/${id}/approve`, reason ? { reason } : {}));

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    mill = (await ok(await send("POST", "/suppliers", { name: "Mill" }), 201)).id;
    await ok(await send("POST", `/suppliers/${mill}/approval`, { status: "approved" }));
    store = (await ok(await send("POST", "/stock/locations", { name: "Store" }), 201)).id;
  }, 120_000);
  afterAll(() => ctx.handle.close());

  describe("invoiced order lines", () => {
    it("can't be removed, re-itemed, re-united or repriced, on a draft invoice or an approved one", async () => {
      const sugar = await item({
        code: "SUG",
        name: "Sugar",
        type: "ingredient",
        unit: "kg",
        standardCost: 0.5,
      });
      const butter = await item({
        code: "BUT",
        name: "Butter",
        type: "ingredient",
        unit: "kg",
        standardCost: 6,
      });
      const flour = await item({
        code: "FL1",
        name: "Flour",
        type: "ingredient",
        unit: "kg",
        standardCost: 0.8,
      });
      const po = await sentOrder([
        { itemId: sugar, quantity: 50, unit: "kg", unitPrice: 0.5 },
        { itemId: flour, quantity: 100, unit: "kg", unitPrice: 0.8 },
      ]);
      const sl = po.lines.find((l: any) => l.itemId === sugar);
      const fl = po.lines.find((l: any) => l.itemId === flour);
      const both = (sugarLine: object) => ({
        lines: [sugarLine, { id: fl.id, itemId: flour, quantity: 100, unit: "kg", unitPrice: 0.8 }],
      });
      const sugarAsIs = { id: sl.id, itemId: sugar, quantity: 50, unit: "kg", unitPrice: 0.5 };

      // A draft invoice already fixes the line (nothing received yet).
      const draft = await invoice([{ kind: "order", orderLineId: sl.id, quantity: 50, unitPrice: 0.5 }]);
      const attempts = {
        removed: { lines: [{ id: fl.id, itemId: flour, quantity: 100, unit: "kg", unitPrice: 0.8 }] },
        "re-itemed": both({ ...sugarAsIs, itemId: butter, unitPrice: 6 }),
        "re-united": both({ ...sugarAsIs, quantity: 50_000, unit: "g", unitPrice: 0.0005 }),
        repriced: both({ ...sugarAsIs, unitPrice: 0.4 }),
      };
      for (const [what, body] of Object.entries(attempts)) {
        const refused = await error(await send("PATCH", `/purchasing/orders/${po.id}`, body), 409);
        expect(refused.code, what).toBe("line_invoiced");
      }
      // The quantity, date and the other lines still change; the order view says it is invoiced.
      const edited = await ok(
        await send("PATCH", `/purchasing/orders/${po.id}`, {
          lines: [
            { ...sugarAsIs, quantity: 60 },
            { id: fl.id, itemId: flour, quantity: 90, unit: "kg", unitPrice: 0.7 },
          ],
        }),
      );
      expect(edited.lines.map((l: any) => [l.itemId, l.invoiced])).toEqual([
        [sugar, true],
        [flour, false],
      ]);

      // Approved: still fixed. Deleting the draft would free it, so approve it instead.
      await approve(draft.id, "Paid ahead of delivery");
      // The order view says how much approved invoices bill (what entering an invoice starts from).
      const viewed = await ok(await get(`/purchasing/orders/${po.id}`));
      expect(viewed.lines.map((l: any) => [l.itemId, l.invoicedQuantity])).toEqual([
        [sugar, 50],
        [flour, 0],
      ]);
      expect(
        (await error(await send("PATCH", `/purchasing/orders/${po.id}`, attempts["re-itemed"]), 409)).code,
      ).toBe("line_invoiced");
      expect(
        (await error(await send("PATCH", `/purchasing/orders/${po.id}`, attempts.removed), 409)).code,
      ).toBe("line_invoiced");

      // A deleted draft no longer holds a line.
      const other = await invoice([{ kind: "order", orderLineId: fl.id, quantity: 1, unitPrice: 0.7 }]);
      expect((await send("DELETE", `/purchasing/invoices/${other.id}`)).status).toBe(204);
      await ok(
        await send("PATCH", `/purchasing/orders/${po.id}`, {
          lines: [
            { ...sugarAsIs, quantity: 60 },
            { id: fl.id, itemId: flour, quantity: 90, unit: "kg", unitPrice: 0.75 },
          ],
        }),
      );
    });
  });

  describe("approval", () => {
    it("refuses lines whose order has since been cancelled", async () => {
      const yeast = await item({
        code: "YST",
        name: "Yeast",
        type: "ingredient",
        unit: "kg",
        standardCost: 4,
      });
      const po = await sentOrder([{ itemId: yeast, quantity: 5, unit: "kg", unitPrice: 4 }]);
      const draft = await invoice([
        { kind: "order", orderLineId: po.lines[0].id, quantity: 5, unitPrice: 4 },
      ]);
      await ok(await send("POST", `/purchasing/orders/${po.id}/cancel`, { reason: "Not needed" }));
      const refused = await error(
        await send("POST", `/purchasing/invoices/${draft.id}/approve`, { reason: "Pay it anyway" }),
        409,
      );
      expect(refused.code).toBe("order_not_invoiceable");
      expect(refused.details).toMatchObject({ lineNo: 1, purchaseOrderId: po.id });
      expect((await ok(await get(`/purchasing/invoices/${draft.id}`))).status).toBe("draft");
    });
  });

  describe("the match of an approved invoice", () => {
    let salt: string;
    let saltLine: string;
    let saltLot: string;
    let saltMovement: string;
    let saltOrder: any;
    let approvedId: string;

    it("is frozen at approval: tolerances and unit conversions changed later don't re-grade it", async () => {
      // Salt is costed per kg and bought in 25 kg sacks.
      salt = await item({
        code: "SLT",
        name: "Salt",
        type: "ingredient",
        unit: "kg",
        standardCost: 0.8,
        unitWeightG: 25_000,
      });
      saltOrder = await sentOrder([{ itemId: salt, quantity: 4, unit: "each", unitPrice: 20 }]);
      saltLine = saltOrder.lines[0].id;
      const receipt = await receive(saltOrder.id, saltLine, 4, "each");
      saltLot = receipt.lotId;
      saltMovement = receipt.stockMovementId;
      // 20.30 a sack: 1.5% over, 1.20 in value; within the default 2% and 10.00.
      const draft = await invoice([{ kind: "order", orderLineId: saltLine, quantity: 4, unitPrice: 20.3 }]);
      expect(draft.lines[0]).toMatchObject({ received: 4, now: null, match: { status: "within_tolerance" } });
      const approved = await approve(draft.id);
      approvedId = approved.id;
      expect(approved).toMatchObject({
        matchStatus: "within_tolerance",
        matchStatusNow: "within_tolerance",
        approvedMatchStatus: "within_tolerance",
        approvedTolerances: { pricePercent: 2, priceAmount: 10, quantityPercent: 2, quantityAmount: 10 },
      });

      // Tighter tolerances: drafts re-grade, the approved invoice doesn't.
      await ok(await send("PUT", "/purchasing/invoice-settings", { pricePercent: 1 }));
      // Sacks re-weighed at 50 kg: 100 kg received is now 2 sacks by today's conversion.
      await ok(await send("PATCH", `/items/${salt}`, { unitWeightG: 50_000 }));
      const after = await ok(await get(`/purchasing/invoices/${approvedId}`));
      expect(after).toMatchObject({
        status: "approved",
        matchStatus: "within_tolerance",
        matchStatusNow: "within_tolerance",
        tolerances: { pricePercent: 2 },
      });
      expect(after.lines[0]).toMatchObject({
        received: 4,
        orderLine: { unitPrice: 20, quantity: 4 },
        match: { status: "within_tolerance", priceStatus: "within_tolerance", quantityStatus: "matched" },
        now: { received: 4, match: { status: "within_tolerance" } },
      });
      const listed = await ok(
        await get(`/purchasing/invoices?status=approved&purchaseOrderId=${saltOrder.id}`),
      );
      expect(listed.invoices.map((i: any) => i.matchStatus)).toEqual(["within_tolerance"]);
      // The lot's cost doesn't drift with the new sack weight: 20.30 a 25 kg sack is 0.812 a kg.
      expect(await ok(await get(`/costing/lots/${saltLot}`))).toMatchObject({
        source: "invoice",
        unitCost: 0.812,
      });
      await ok(
        await send("PUT", "/purchasing/invoice-settings", {
          pricePercent: 2,
          priceAmount: 10,
          quantityPercent: 2,
          quantityAmount: 10,
        }),
      );
    });

    it("shows now what has been reversed since, without changing the status it was approved at", async () => {
      expect(saltMovement).toEqual(expect.any(String));
      await ok(await send("POST", `/stock/movements/${saltMovement}/reverse`, { reason: "Wrong salt" }), 201);
      const after = await ok(await get(`/purchasing/invoices/${approvedId}`));
      expect(after).toMatchObject({ matchStatus: "within_tolerance", matchStatusNow: "mismatch" });
      expect(after.lines[0].now).toMatchObject({ received: 0, match: { quantityStatus: "mismatch" } });
    });

    it("flags a unit that no longer converts as a mismatch, not a comparison of kilos with sacks", async () => {
      await ok(await send("PATCH", `/items/${salt}`, { unitWeightG: null }));
      const draft = await invoice([{ kind: "order", orderLineId: saltLine, quantity: 1, unitPrice: 20 }]);
      expect(draft.matchStatus).toBe("mismatch");
      expect(draft.lines[0]).toMatchObject({
        received: null,
        // Lines in the same unit need no conversion: the approved invoice's 4 sacks.
        invoicedElsewhere: 4,
        orderLine: { quantity: null },
        match: {
          status: "mismatch",
          quantityStatus: "mismatch",
          uninvoiced: null,
          quantityVariance: null,
          issues: ["unit_not_convertible"],
        },
      });
      // The approved one still reads as approved.
      const approved = await ok(await get(`/purchasing/invoices/${approvedId}`));
      expect(approved.lines[0]).toMatchObject({ received: 4, match: { status: "within_tolerance" } });
      // Nor is the lot's invoice price dropped: it was priced from what approval stored.
      expect(await ok(await get(`/costing/lots/${saltLot}`))).toMatchObject({
        source: "invoice",
        unitCost: 0.812,
      });
      expect((await send("DELETE", `/purchasing/invoices/${draft.id}`)).status).toBe(204);
      await ok(await send("PATCH", `/items/${salt}`, { unitWeightG: 25_000 }));
    });
  });

  describe("costing", () => {
    it("never silently drops an invoice it can't price: the lot says why", async () => {
      // Bought by the tub with no price on the order; the tub weight is cleared before approval.
      const honey = await item({
        code: "HNY",
        name: "Honey",
        type: "ingredient",
        unit: "kg",
        standardCost: 5,
        unitWeightG: 7_000,
      });
      const po = await sentOrder([{ itemId: honey, quantity: 2, unit: "each", unitPrice: null }]);
      const lot = (await receive(po.id, po.lines[0].id, 2, "each")).lotId;
      const draft = await invoice([
        { kind: "order", orderLineId: po.lines[0].id, quantity: 2, unitPrice: 30 },
      ]);
      await ok(await send("PATCH", `/items/${honey}`, { unitWeightG: null }));
      await approve(draft.id, "Price agreed by phone");
      const cost = await ok(await get(`/costing/lots/${lot}`));
      expect(cost).toMatchObject({ source: "standard", unitCost: 5, reason: "invoice_unpriced" });
      expect(cost.receipts[0]).toMatchObject({
        invoicePrice: null,
        invoiceUnpriced: true,
        invoices: [{ id: draft.id }],
      });
    });
  });
});
