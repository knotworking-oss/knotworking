import { suppliers } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { makeApp, signIn, type TestCtx } from "./test-utils";

/** Today in the demo workspace's zone (the default), as the server decides it. */
const utcToday = () => todayInZone(DEFAULT_TIME_ZONE);

const WS = "/v1/workspaces/acme";

describe("supplier invoices and three-way match", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const today = utcToday();
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
  const lineFor = (inv: any, itemId: string) => inv.lines.find((l: any) => l.item?.id === itemId);

  // Fixtures.
  let mill: string;
  let dairy: string;
  let flour: string; // kg, ordered 100 kg at 0.80; 60 kg received so far
  let eggs: string; // each, ordered 200 at 0.30; all received
  let po: any;
  let flourLine: string;
  let eggLine: string;
  let flourLot: string;
  let draftPo: any; // never sent
  let dairyPo: any; // another supplier's
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
    const supplier = async (name: string) => {
      const id = (await ok(await as(ada).send("POST", "/suppliers", { name }), 201)).id;
      await ok(await as(ada).send("POST", `/suppliers/${id}/approval`, { status: "approved" }));
      return id as string;
    };
    mill = await supplier("Mill");
    dairy = await supplier("Dairy");
    const item = async (body: object) => (await ok(await as(ada).send("POST", "/items", body), 201)).id;
    flour = await item({ code: "FLR", name: "Flour", type: "ingredient", unit: "kg", standardCost: 0.8 });
    eggs = await item({ code: "EGG", name: "Eggs", type: "ingredient", unit: "each", standardCost: 0.3 });
    store = (await ok(await as(ada).send("POST", "/stock/locations", { name: "Store" }), 201)).id;

    const order = async (supplierId: string, send = true) => {
      const created = await ok(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId,
          expectedOn: today,
          lines: [
            { itemId: flour, quantity: 100, unit: "kg", unitPrice: 0.8 },
            { itemId: eggs, quantity: 200, unit: "each", unitPrice: 0.3 },
          ],
        }),
        201,
      );
      if (send) await ok(await as(ada).send("POST", `/purchasing/orders/${created.id}/send`, {}));
      return created;
    };
    po = await order(mill);
    draftPo = await order(mill, false);
    dairyPo = await order(dairy);
    flourLine = po.lines.find((l: any) => l.itemId === flour).id;
    eggLine = po.lines.find((l: any) => l.itemId === eggs).id;
    // A part delivery of flour; all the eggs.
    const received = await ok(
      await as(ada).send("POST", `/purchasing/orders/${po.id}/receipts`, {
        receivedOn: today,
        lines: [
          { lineId: flourLine, outcome: "accepted", quantity: 60, unit: "kg", locationId: store },
          { lineId: eggLine, outcome: "accepted", quantity: 200, unit: "each", locationId: store },
        ],
      }),
      201,
    );
    flourLot = received.receipts.find((r: any) => r.item.id === flour).lotId;
  }, 120_000);
  afterAll(() => ctx.handle.close());

  let inv1: string;

  describe("entering", () => {
    it("lets an agent draft an invoice, matched line by line, with a carriage charge", async () => {
      const created = await ok(
        await viaToken("POST", "/purchasing/invoices", {
          supplierId: mill,
          invoiceNumber: "INV-1",
          invoiceDate: today,
          vat: 24.72,
          lines: [
            // 1.25% over the order price, 0.60 in value: within the default 2% and 10.00.
            { kind: "order", orderLineId: flourLine, quantity: 60, unitPrice: 0.81 },
            { kind: "order", orderLineId: eggLine, quantity: 200, unitPrice: 0.3 },
            { kind: "charge", description: "Carriage", unitPrice: 15 },
          ],
        }),
        201,
      );
      inv1 = created.id;
      expect(created).toMatchObject({
        status: "draft",
        version: 1,
        supplier: { id: mill, name: "Mill" },
        net: 123.6,
        vat: 24.72,
        gross: 148.32,
        matchStatus: "within_tolerance",
        mismatchedLines: 0,
        orders: [{ id: po.id, reference: po.reference }],
        tolerances: { pricePercent: 2, priceAmount: 10, quantityPercent: 2, quantityAmount: 10 },
      });
      expect(lineFor(created, flour)).toMatchObject({
        unit: "kg",
        received: 60,
        invoicedElsewhere: 0,
        orderLine: { lineNo: 1, quantity: 100, unitPrice: 0.8 },
        match: {
          status: "within_tolerance",
          priceStatus: "within_tolerance",
          priceVariance: 0.01,
          priceVariancePercent: 1.25,
          priceVarianceValue: 0.6,
          quantityStatus: "matched",
          quantityVariance: 0,
        },
      });
      expect(lineFor(created, eggs).match.status).toBe("matched");
      expect(created.lines[2]).toMatchObject({
        kind: "charge",
        description: "Carriage",
        quantity: 1,
        match: null,
      });
      expect(created.workspaceId).toBeUndefined();
    });

    it("keeps invoice numbers unique per supplier", async () => {
      const again = await as(ada).send("POST", "/purchasing/invoices", {
        supplierId: mill,
        invoiceNumber: "inv-1",
        invoiceDate: today,
      });
      expect((await error(again, 409)).code).toBe("duplicate_invoice_number");
      const other = await ok(
        await as(ada).send("POST", "/purchasing/invoices", {
          supplierId: dairy,
          invoiceNumber: "INV-1",
          invoiceDate: today,
        }),
        201,
      );
      expect((await as(ada).send("DELETE", `/purchasing/invoices/${other.id}`)).status).toBe(204);
    });

    it("refuses another supplier's order lines and orders not sent", async () => {
      const make = (orderLineId: string) =>
        as(ada).send("POST", "/purchasing/invoices", {
          supplierId: mill,
          invoiceNumber: "INV-X",
          invoiceDate: today,
          lines: [{ kind: "order", orderLineId, quantity: 1, unitPrice: 0.8 }],
        });
      expect((await error(await make(dairyPo.lines[0].id), 409)).code).toBe("wrong_supplier");
      expect((await error(await make(draftPo.lines[0].id), 409)).code).toBe("order_not_invoiceable");
    });

    it("measures quantity against what was received (a part delivery), and edits drafts", async () => {
      const draft = await ok(
        await as(ada).send("POST", "/purchasing/invoices", {
          supplierId: mill,
          invoiceNumber: "INV-ALL",
          invoiceDate: today,
          lines: [{ kind: "order", orderLineId: flourLine, quantity: 100, unitPrice: 0.8 }],
        }),
        201,
      );
      // Ordered 100 kg, 60 received: invoicing 100 is over-invoicing by 40.
      expect(draft.matchStatus).toBe("mismatch");
      expect(draft.lines[0].match).toMatchObject({
        quantityStatus: "mismatch",
        quantityVariance: 40,
        issues: ["over_invoiced"],
      });
      const edited = await ok(
        await viaToken("PATCH", `/purchasing/invoices/${draft.id}`, {
          lines: [{ kind: "order", orderLineId: flourLine, quantity: 60, unitPrice: 0.8 }],
        }),
      );
      expect(edited.matchStatus).toBe("matched");
      expect((await viaToken("DELETE", `/purchasing/invoices/${draft.id}`)).status).toBe(204);
      expect((await as(ada).get(`/purchasing/invoices/${draft.id}`)).status).toBe(404);
    });
  });

  describe("approval", () => {
    it("is a person's, with manage: tokens and write access are refused", async () => {
      const byToken = await viaToken("POST", `/purchasing/invoices/${inv1}/approve`, {});
      expect((await error(byToken, 403)).code).toBe("token_not_allowed");
      await grant("items", "read");
      await grant("stock", "read");
      await grant("purchasing", "write");
      const byWriter = await as(marcus.cookie).send("POST", `/purchasing/invoices/${inv1}/approve`, {});
      expect((await error(byWriter, 403)).code).toBe("module_forbidden");
      // Write may still draft.
      await ok(await as(marcus.cookie).get(`/purchasing/invoices/${inv1}`));
    });

    it("approves an invoice within tolerance without a reason, and records the match", async () => {
      const approved = await ok(await as(ada).send("POST", `/purchasing/invoices/${inv1}/approve`, {}));
      expect(approved).toMatchObject({
        status: "approved",
        approvedMatchStatus: "within_tolerance",
        approvalReason: null,
        approvedByName: expect.any(String),
      });
      expect(approved.approvedAt).toBeTruthy();
    });

    it("makes an approved invoice immutable", async () => {
      const patch = await as(ada).send("PATCH", `/purchasing/invoices/${inv1}`, { notes: "changed" });
      expect((await error(patch, 409)).code).toBe("invoice_not_draft");
      expect((await error(await as(ada).send("DELETE", `/purchasing/invoices/${inv1}`), 409)).code).toBe(
        "invoice_not_draft",
      );
      const twice = await as(ada).send("POST", `/purchasing/invoices/${inv1}/approve`, {});
      expect((await error(twice, 409)).code).toBe("invoice_not_draft");
    });

    it("feeds costing: the lot is costed at the invoice price", async () => {
      const cost = await ok(await as(ada).get(`/costing/lots/${flourLot}`));
      expect(cost).toMatchObject({ source: "invoice", unitCost: 0.81 });
      expect(cost.receipts[0]).toMatchObject({
        unitPrice: 0.8,
        invoicePrice: 0.81,
        invoices: [{ id: inv1, invoiceNumber: "INV-1", version: 1 }],
      });
    });

    it("flags invoicing the same delivery twice, and approves a mismatch only with a reason", async () => {
      const second = await ok(
        await as(ada).send("POST", "/purchasing/invoices", {
          supplierId: mill,
          invoiceNumber: "INV-2",
          invoiceDate: today,
          lines: [{ kind: "order", orderLineId: eggLine, quantity: 10, unitPrice: 0.3 }],
        }),
        201,
      );
      expect(second.lines[0]).toMatchObject({ received: 200, invoicedElsewhere: 200 });
      expect(second.lines[0].match).toMatchObject({ uninvoiced: 0, quantityStatus: "mismatch" });
      const bare = await as(ada).send("POST", `/purchasing/invoices/${second.id}/approve`, {});
      const refusal = await error(bare, 409);
      expect(refusal.code).toBe("reason_required");
      expect(refusal.details).toMatchObject({ matchStatus: "mismatch", mismatchedLines: 1 });
      const approved = await ok(
        await as(ada).send("POST", `/purchasing/invoices/${second.id}/approve`, {
          reason: "Ten more eggs arrived on a separate van; delivery note to follow",
        }),
      );
      expect(approved).toMatchObject({ status: "approved", approvedMatchStatus: "mismatch" });
      // The earlier invoice's match reads as it did when it was approved.
      expect((await ok(await as(ada).get(`/purchasing/invoices/${inv1}`))).matchStatus).toBe(
        "within_tolerance",
      );
    });
  });

  describe("corrections", () => {
    it("revises an approved invoice as a new version, which supersedes it once approved", async () => {
      const revision = await ok(await viaToken("POST", `/purchasing/invoices/${inv1}/revise`), 201);
      expect(revision).toMatchObject({
        status: "draft",
        version: 2,
        supersedesId: inv1,
        invoiceNumber: "INV-1",
      });
      expect(revision.lines).toHaveLength(3);
      // The revision is matched without the version it replaces.
      expect(lineFor(revision, flour)).toMatchObject({ invoicedElsewhere: 0 });
      expect((await error(await as(ada).send("POST", `/purchasing/invoices/${inv1}/revise`), 409)).code).toBe(
        "revision_exists",
      );
      const locked = await as(ada).send("PATCH", `/purchasing/invoices/${revision.id}`, {
        invoiceNumber: "INV-9",
      });
      expect((await error(locked, 409)).code).toBe("revision_locked");
      // The credit: the flour at the order price.
      const lines = revision.lines.map((l: any) =>
        l.kind === "order"
          ? {
              kind: "order",
              orderLineId: l.orderLine.id,
              quantity: l.quantity,
              unitPrice: l.item.id === flour ? 0.8 : l.unitPrice,
            }
          : { kind: "charge", description: l.description, quantity: l.quantity, unitPrice: l.unitPrice },
      );
      const edited = await ok(await as(ada).send("PATCH", `/purchasing/invoices/${revision.id}`, { lines }));
      expect(lineFor(edited, flour).match.status).toBe("matched");
      // INV-2 (approved since) billed 10 of the eggs, so the copied egg line now over-invoices.
      expect(lineFor(edited, eggs)).toMatchObject({ invoicedElsewhere: 10, match: { status: "mismatch" } });
      // Until it is approved, the original stays in force.
      expect((await ok(await as(ada).get(`/costing/lots/${flourLot}`))).unitCost).toBe(0.81);
      await ok(
        await as(ada).send("POST", `/purchasing/invoices/${revision.id}/approve`, {
          reason: "Credit for the flour price; the extra eggs are on INV-2",
        }),
      );
      const original = await ok(await as(ada).get(`/purchasing/invoices/${inv1}`));
      expect(original).toMatchObject({ status: "superseded", supersededById: revision.id });
      expect(original.versions.map((v: any) => [v.version, v.status])).toEqual([
        [1, "superseded"],
        [2, "approved"],
      ]);
      expect((await ok(await as(ada).get(`/costing/lots/${flourLot}`))).unitCost).toBe(0.8);
      expect((await ok(await as(ada).get(`/costing/lots/${flourLot}`))).source).toBe("invoice");
      expect((await error(await as(ada).send("POST", `/purchasing/invoices/${inv1}/revise`), 409)).code).toBe(
        "invoice_not_approved",
      );
      // Superseded versions are left out of the default list.
      const listed = await ok(await as(ada).get("/purchasing/invoices"));
      expect(listed.invoices.map((i: any) => i.id)).not.toContain(inv1);
      const all = await ok(await as(ada).get(`/purchasing/invoices?status=all&purchaseOrderId=${po.id}`));
      expect(all.invoices.map((i: any) => i.id)).toContain(inv1);
    });
  });

  describe("guards", () => {
    it("keeps an invoiced order line's item, and an approved one's line, on the order", async () => {
      const created = await ok(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId: mill,
          expectedOn: today,
          lines: [
            { itemId: flour, quantity: 10, unit: "kg", unitPrice: 0.8 },
            { itemId: eggs, quantity: 5, unit: "each", unitPrice: 0.3 },
          ],
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/purchasing/orders/${created.id}/send`, {}));
      const [f, e] = created.lines;
      const draft = await ok(
        await as(ada).send("POST", "/purchasing/invoices", {
          supplierId: mill,
          invoiceNumber: "G-1",
          invoiceDate: today,
          lines: [{ kind: "order", orderLineId: e.id, quantity: 5, unitPrice: 0.3 }],
        }),
        201,
      );
      const swap = await as(ada).send("PATCH", `/purchasing/orders/${created.id}`, {
        lines: [
          { id: f.id, itemId: flour, quantity: 10, unit: "kg" },
          { id: e.id, itemId: flour, quantity: 5, unit: "kg" },
        ],
      });
      expect((await error(swap, 409)).code).toBe("line_invoiced");
      await ok(
        await as(ada).send("POST", `/purchasing/invoices/${draft.id}/approve`, { reason: "Paid on order" }),
      );
      const remove = await as(ada).send("PATCH", `/purchasing/orders/${created.id}`, {
        lines: [{ id: f.id, itemId: flour, quantity: 10, unit: "kg" }],
      });
      expect((await error(remove, 409)).code).toBe("line_invoiced");
    });

    it("refuses approving against a cancelled order", async () => {
      const created = await ok(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId: mill,
          expectedOn: today,
          lines: [{ itemId: flour, quantity: 10, unit: "kg", unitPrice: 0.8 }],
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/purchasing/orders/${created.id}/send`, {}));
      const draft = await ok(
        await as(ada).send("POST", "/purchasing/invoices", {
          supplierId: mill,
          invoiceNumber: "G-2",
          invoiceDate: today,
          lines: [{ kind: "order", orderLineId: created.lines[0].id, quantity: 10, unitPrice: 0.8 }],
        }),
        201,
      );
      await ok(
        await as(ada).send("POST", `/purchasing/orders/${created.id}/cancel`, { reason: "Not needed" }),
      );
      const approve = await as(ada).send("POST", `/purchasing/invoices/${draft.id}/approve`, { reason: "x" });
      expect((await error(approve, 409)).code).toBe("order_not_invoiceable");
    });

    it("needs a reason for an invoice of charges only, and a supplier still on file", async () => {
      const charges = await ok(
        await as(ada).send("POST", "/purchasing/invoices", {
          supplierId: mill,
          invoiceNumber: "G-3",
          invoiceDate: today,
          lines: [{ kind: "charge", description: "Carriage", quantity: 1, unitPrice: 500 }],
        }),
        201,
      );
      const bare = await as(ada).send("POST", `/purchasing/invoices/${charges.id}/approve`, {});
      expect((await error(bare, 409)).code).toBe("reason_required");
      await ok(
        await as(ada).send("POST", `/purchasing/invoices/${charges.id}/approve`, {
          reason: "Pallet delivery agreed by phone",
        }),
      );

      const gone = (await ok(await as(ada).send("POST", "/suppliers", { name: "Gone" }), 201)).id;
      const draft = await ok(
        await as(ada).send("POST", "/purchasing/invoices", {
          supplierId: gone,
          invoiceNumber: "G-4",
          invoiceDate: today,
          lines: [{ kind: "charge", description: "Carriage", quantity: 1, unitPrice: 5 }],
        }),
        201,
      );
      // The API refuses to delete a supplier on an invoice (`supplier_in_use`); one deleted before that
      // rule can still sit on a draft, so soft-delete it underneath.
      expect((await error(await as(ada).send("DELETE", `/suppliers/${gone}`), 409)).code).toBe(
        "supplier_in_use",
      );
      await ctx.handle.db.update(suppliers).set({ deletedAt: new Date() }).where(eq(suppliers.id, gone));
      const approve = await as(ada).send("POST", `/purchasing/invoices/${draft.id}/approve`, { reason: "x" });
      expect((await error(approve, 404)).message).toMatch(/Supplier/);
    });
  });

  describe("tolerances", () => {
    it("are a person's to change, with manage, and move the match", async () => {
      expect(
        (await error(await viaToken("PUT", "/purchasing/invoice-settings", { pricePercent: 1 }), 403)).code,
      ).toBe("token_not_allowed");
      const draft = await ok(
        await as(ada).send("POST", "/purchasing/invoices", {
          supplierId: dairy,
          invoiceNumber: "D-1",
          invoiceDate: today,
          lines: [{ kind: "order", orderLineId: dairyPo.lines[0].id, quantity: 1, unitPrice: 0.81 }],
        }),
        201,
      );
      // Nothing received from the dairy: over-invoiced, whatever the price.
      expect(draft.lines[0].match.quantityStatus).toBe("mismatch");
      expect(draft.lines[0].match.priceStatus).toBe("within_tolerance");
      await ok(await as(ada).send("PUT", "/purchasing/invoice-settings", { pricePercent: 1 }));
      expect((await ok(await as(ada).get("/purchasing/invoice-settings"))).pricePercent).toBe(1);
      const after = await ok(await as(ada).get(`/purchasing/invoices/${draft.id}`));
      expect(after.lines[0].match.priceStatus).toBe("mismatch");
      // Exactly at the tolerance is within it.
      await ok(await as(ada).send("PUT", "/purchasing/invoice-settings", { pricePercent: 1.25 }));
      const at = await ok(await as(ada).get(`/purchasing/invoices/${draft.id}`));
      expect(at.lines[0].match.priceStatus).toBe("within_tolerance");
    });
  });

  describe("sync log", () => {
    it("records invoices, lines and settings for members who can read purchasing", async () => {
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
      for (const entity of ["purchase_invoice", "purchase_invoice_line", "purchasing_settings"]) {
        expect(forAda.has(entity), entity).toBe(true);
      }
      await grant("purchasing", null);
      expect((await entities(marcus.cookie)).has("purchase_invoice")).toBe(false);
    });
  });
});
