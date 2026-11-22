import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("supplier credit notes and discount lines", () => {
  let ctx: TestCtx;
  let ada: string;
  let token: string;
  const today = todayInZone(DEFAULT_TIME_ZONE);
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
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

  let mill: string;
  let flour: string;
  let orderLine: string;
  let lot: string;
  let inv: any; // approved: 100 kg at 0.80 and 10 carriage
  let invLine: string;
  let carriageLine: string;
  const unitCost = async () => (await ok(await as(ada).get(`/costing/lots/${lot}`))).unitCost;
  const creditNote = (number: string, lines: object[], extra: object = {}) =>
    as(ada).send("POST", "/purchasing/credit-notes", {
      invoiceId: inv.id,
      creditNoteNumber: number,
      creditDate: today,
      lines,
      ...extra,
    });
  const priceCredit = (quantity: number, unitPrice: number) => ({
    kind: "invoice_line",
    invoiceLineId: invLine,
    reason: "price",
    quantity,
    unitPrice,
  });
  const returned = (quantity: number, unitPrice = 0.8) => ({
    kind: "invoice_line",
    invoiceLineId: invLine,
    reason: "goods_returned",
    quantity,
    unitPrice,
  });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write" },
        })
      ).json()
    ).token;
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
        }),
        201,
      )
    ).id;
    const store = (await ok(await as(ada).send("POST", "/stock/locations", { name: "Store" }), 201)).id;
    const po = await ok(
      await as(ada).send("POST", "/purchasing/orders", {
        supplierId: mill,
        expectedOn: today,
        lines: [{ itemId: flour, quantity: 100, unit: "kg", unitPrice: 0.8 }],
      }),
      201,
    );
    await ok(await as(ada).send("POST", `/purchasing/orders/${po.id}/send`, {}));
    orderLine = po.lines[0].id;
    const received = await ok(
      await as(ada).send("POST", `/purchasing/orders/${po.id}/receipts`, {
        receivedOn: today,
        lines: [{ lineId: orderLine, outcome: "accepted", quantity: 100, unit: "kg", locationId: store }],
      }),
      201,
    );
    lot = received.receipts[0].lotId;
  }, 120_000);
  afterAll(() => ctx.handle.close());

  describe("discount lines on invoices", () => {
    it("takes a negative charge off the net, and refuses an invoice that totals less than nothing", async () => {
      const draft = await ok(
        await viaToken("POST", "/purchasing/invoices", {
          supplierId: mill,
          invoiceNumber: "INV-DISC",
          invoiceDate: today,
          lines: [
            { kind: "order", orderLineId: orderLine, quantity: 50, unitPrice: 0.8 },
            { kind: "charge", description: "Carriage", unitPrice: 10 },
            { kind: "charge", description: "Settlement discount", unitPrice: -3.5 },
          ],
        }),
        201,
      );
      expect(draft).toMatchObject({ net: 46.5, gross: 46.5 });
      expect(draft.lines.at(-1)).toMatchObject({ kind: "charge", unitPrice: -3.5, value: -3.5 });
      const refused = await error(
        await as(ada).send("PATCH", `/purchasing/invoices/${draft.id}`, {
          lines: [
            { kind: "order", orderLineId: orderLine, quantity: 1, unitPrice: 0.8 },
            { kind: "charge", description: "Rebate", unitPrice: -100 },
          ],
        }),
        400,
      );
      expect(refused.message).toMatch(/less than nothing/);
      // The refused edit left the draft as it was.
      expect((await ok(await as(ada).get(`/purchasing/invoices/${draft.id}`))).net).toBe(46.5);
      await as(ada).send("DELETE", `/purchasing/invoices/${draft.id}`);
    });
  });

  describe("credit notes", () => {
    it("are against an approved invoice only", async () => {
      const draft = await ok(
        await as(ada).send("POST", "/purchasing/invoices", {
          supplierId: mill,
          invoiceNumber: "INV-1",
          invoiceDate: today,
          lines: [
            { kind: "order", orderLineId: orderLine, quantity: 100, unitPrice: 0.8 },
            { kind: "charge", description: "Carriage", unitPrice: 10 },
          ],
        }),
        201,
      );
      invLine = draft.lines.find((l: any) => l.kind === "order").id;
      carriageLine = draft.lines.find((l: any) => l.kind === "charge").id;
      const cn = {
        invoiceId: draft.id,
        creditNoteNumber: "CN-0",
        creditDate: today,
        lines: [
          { kind: "invoice_line", invoiceLineId: invLine, reason: "price", quantity: 1, unitPrice: 0.1 },
        ],
      };
      expect((await error(await as(ada).send("POST", "/purchasing/credit-notes", cn), 409)).code).toBe(
        "invoice_not_creditable",
      );
      inv = await ok(await as(ada).send("POST", `/purchasing/invoices/${draft.id}/approve`, {}));
      expect(inv.status).toBe("approved");
      expect(await unitCost()).toBe(0.8);
    });

    it("lets an agent draft one; only a person approves it; costing moves once it is approved", async () => {
      const draft = await ok(
        await viaToken("POST", "/purchasing/credit-notes", {
          invoiceId: inv.id,
          creditNoteNumber: "CN-1",
          creditDate: today,
          vat: 1.6,
          lines: [priceCredit(100, 0.08)],
        }),
        201,
      );
      expect(draft).toMatchObject({
        status: "draft",
        net: 8,
        gross: 9.6,
        supplier: { name: "Mill" },
        invoice: { invoiceNumber: "INV-1", status: "approved" },
        lines: [{ kind: "invoice_line", reason: "price", unit: "kg", value: 8, invoiceLine: { lineNo: 1 } }],
      });
      expect(await unitCost()).toBe(0.8);
      expect(
        (await error(await viaToken("POST", `/purchasing/credit-notes/${draft.id}/approve`), 403)).code,
      ).toBe("token_not_allowed");
      expect(
        (await error(await as(ada).send("POST", "/purchasing/credit-notes", { invoiceId: inv.id }), 400))
          .code,
      ).toBe("invalid_input");
      const approved = await ok(await as(ada).send("POST", `/purchasing/credit-notes/${draft.id}/approve`));
      expect(approved).toMatchObject({ status: "approved", approvedByName: "Ada Park" });
      // 80.00 invoiced less 8.00 credited over the 100 kg kept.
      expect(await unitCost()).toBe(0.72);
      expect((await ok(await as(ada).get(`/costing/lots/${lot}`))).source).toBe("invoice");
      const detail = await ok(await as(ada).get(`/purchasing/invoices/${inv.id}`));
      expect(detail).toMatchObject({ creditedNet: 8, netAfterCredits: 82 });
      expect(detail.creditNotes).toMatchObject([{ creditNoteNumber: "CN-1", status: "approved", net: 8 }]);
      // Approved is immutable.
      expect(
        (
          await error(
            await as(ada).send("PATCH", `/purchasing/credit-notes/${draft.id}`, { notes: "x" }),
            409,
          )
        ).code,
      ).toBe("credit_note_not_draft");
      expect(
        (await error(await as(ada).send("DELETE", `/purchasing/credit-notes/${draft.id}`), 409)).code,
      ).toBe("credit_note_not_draft");
      expect(
        (await error(await as(ada).send("POST", `/purchasing/credit-notes/${draft.id}/approve`), 409)).code,
      ).toBe("credit_note_not_draft");
    });

    it("credit returned goods without changing the cost of what was kept, and are capped by what was billed", async () => {
      const dup = await error(await creditNote("cn-1", [priceCredit(1, 0.01)]), 409);
      expect(dup.code).toBe("duplicate_credit_note_number");
      const back = await ok(await creditNote("CN-2", [returned(20)]), 201);
      await ok(await as(ada).send("POST", `/purchasing/credit-notes/${back.id}/approve`));
      // 80.00 - 8.00 - 16.00 = 56.00 over the 80 kg kept.
      expect(await unitCost()).toBe(0.7);
      // 100 kg billed at 0.80 = 80.00: 24.00 is credited, so another 60.00 of returns is over.
      const over = await error(await creditNote("CN-3", [returned(75)]), 409);
      expect(over.code).toBe("over_credited");
      expect(over.details).toMatchObject({ excess: "value" });
      // Quantity: price credits of any quantity within the value, but never more units back than billed.
      const overQty = await error(await creditNote("CN-3", [returned(81, 0.1)]), 409);
      expect(overQty.details).toMatchObject({ excess: "quantity" });
      // A line of another invoice can't be credited.
      expect(
        (
          await error(
            await creditNote("CN-4", [{ ...priceCredit(1, 0.1), invoiceLineId: carriageLine }]),
            400,
          )
        ).code,
      ).toBe("invalid_input");
      // A charge is credited as a free-standing line, within the invoice's net.
      const carriage = await ok(
        await creditNote("CN-5", [{ kind: "charge", description: "Carriage refunded", unitPrice: 10 }]),
        201,
      );
      await ok(await as(ada).send("POST", `/purchasing/credit-notes/${carriage.id}/approve`));
      expect(await unitCost()).toBe(0.7);
      const tooMuch = await error(
        await creditNote("CN-6", [{ kind: "charge", description: "Goodwill", unitPrice: 60 }]),
        409,
      );
      expect(tooMuch.details).toMatchObject({ invoiceNet: 90 });
    });

    it("can be voided by a person: the credit stops counting and the number is free again", async () => {
      const list = await ok(await as(ada).get(`/purchasing/credit-notes?invoiceId=${inv.id}`));
      expect(list.creditNotes.map((n: any) => n.creditNoteNumber).sort()).toEqual(["CN-1", "CN-2", "CN-5"]);
      const cn2 = list.creditNotes.find((n: any) => n.creditNoteNumber === "CN-2");
      expect(
        (await error(await viaToken("POST", `/purchasing/credit-notes/${cn2.id}/void`, { reason: "x" }), 403))
          .code,
      ).toBe("token_not_allowed");
      expect(
        (await error(await as(ada).send("POST", `/purchasing/credit-notes/${cn2.id}/void`, {}), 400)).code,
      ).toBe("invalid_input");
      const voided = await ok(
        await as(ada).send("POST", `/purchasing/credit-notes/${cn2.id}/void`, {
          reason: "The goods weren't sent back",
        }),
      );
      expect(voided).toMatchObject({
        status: "voided",
        voidReason: "The goods weren't sent back",
        voidedByName: "Ada Park",
      });
      expect(await unitCost()).toBe(0.72);
      expect(
        (
          await error(
            await as(ada).send("POST", `/purchasing/credit-notes/${cn2.id}/void`, { reason: "again" }),
            409,
          )
        ).code,
      ).toBe("credit_note_not_approved");
      const current = await ok(await as(ada).get(`/purchasing/credit-notes?invoiceId=${inv.id}`));
      expect(current.creditNotes.map((n: any) => n.creditNoteNumber).sort()).toEqual(["CN-1", "CN-5"]);
      expect((await ok(await as(ada).get(`/purchasing/credit-notes?status=voided`))).total).toBe(1);
      await ok(await creditNote("CN-2", [returned(5)]), 201);
    });

    it("edits and deletes drafts, re-checks the cap when approving, and follows a revised invoice", async () => {
      const draft = await ok(await creditNote("CN-7", [priceCredit(10, 0.1)]), 201);
      const edited = await ok(
        await as(ada).send("PATCH", `/purchasing/credit-notes/${draft.id}`, {
          notes: "Quality claim",
          lines: [priceCredit(10, 0.2)],
        }),
      );
      expect(edited).toMatchObject({ notes: "Quality claim", net: 2, linesCount: 1 });
      expect((await as(ada).send("DELETE", `/purchasing/credit-notes/${draft.id}`)).status).toBe(204);
      expect((await as(ada).get(`/purchasing/credit-notes/${draft.id}`)).status).toBe(404);

      // Two drafts each within the cap on their own; approving the second finds it over.
      const a = await ok(await creditNote("CN-8", [priceCredit(1, 40)]), 201);
      const b = await ok(await creditNote("CN-9", [priceCredit(1, 40)]), 201);
      await ok(await as(ada).send("POST", `/purchasing/credit-notes/${a.id}/approve`));
      expect(
        (await error(await as(ada).send("POST", `/purchasing/credit-notes/${b.id}/approve`), 409)).code,
      ).toBe("over_credited");
      expect(
        (
          await error(
            await as(ada).send(
              "POST",
              `/purchasing/credit-notes/${(await ok(await creditNote("CN-10", []), 201)).id}/approve`,
            ),
            400,
          )
        ).code,
      ).toBe("invalid_input");

      // Revising the invoice supersedes it: it can no longer be credited, and its draft credit
      // notes can't be approved against it.
      const revision = await ok(await as(ada).send("POST", `/purchasing/invoices/${inv.id}/revise`), 201);
      await ok(
        await as(ada).send("POST", `/purchasing/invoices/${revision.id}/approve`, { reason: "Corrected" }),
      );
      expect((await error(await creditNote("CN-11", [priceCredit(1, 0.1)]), 409)).code).toBe(
        "invoice_not_creditable",
      );
      expect(
        (await error(await as(ada).send("POST", `/purchasing/credit-notes/${b.id}/approve`), 409)).code,
      ).toBe("invoice_not_creditable");
      // The approved credits stay on the order line: costing still nets them off.
      expect(await unitCost()).toBeLessThan(0.72);
    });
  });
});
