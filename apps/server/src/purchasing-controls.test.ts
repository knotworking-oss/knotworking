import { DEFAULT_TIME_ZONE, addDays, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Mailer, MailMessage } from "./mailer";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

/** A mailer that can be made to fail, to show the order email survives a broken SMTP server. */
const mail = {
  configured: true,
  fail: false as boolean,
  sent: [] as MailMessage[],
  async send(message: MailMessage) {
    if (mail.fail) throw new Error("connect ECONNREFUSED 127.0.0.1:2525");
    mail.sent.push(message);
  },
} satisfies Mailer & { fail: boolean; sent: MailMessage[] };

describe("purchasing controls", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const today = todayInZone(DEFAULT_TIME_ZONE);
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

  let mill: string;
  let dairy: string;
  let flour: string; // kg, standard cost 0.8
  let store: string;
  const newOrder = async (supplierId: string, lines: object[], extra: object = {}) =>
    ok(
      await as(ada).send("POST", "/purchasing/orders", { supplierId, expectedOn: today, lines, ...extra }),
      201,
    );

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, mailer: mail });
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
    const supplier = async (name: string, email?: string) => {
      const id = (await ok(await as(ada).send("POST", "/suppliers", { name, email }), 201)).id;
      await ok(await as(ada).send("POST", `/suppliers/${id}/approval`, { status: "approved" }));
      return id as string;
    };
    mill = await supplier("Mill", "orders@mill.example");
    dairy = await supplier("Dairy");
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
    store = (await ok(await as(ada).send("POST", "/stock/locations", { name: "Store" }), 201)).id;
    await grant("items", "read");
    await grant("stock", "read");
    await grant("purchasing", "manage");
  }, 120_000);
  afterAll(() => ctx.handle.close());

  describe("approval to send", () => {
    it("is off until a manager sets a threshold, and only a person may set it", async () => {
      expect(await ok(await as(ada).get("/purchasing/settings"))).toEqual({
        sendApprovalThreshold: null,
        overDeliveryTolerancePercent: null,
      });
      expect(
        (await error(await viaToken("PUT", "/purchasing/settings", { sendApprovalThreshold: 1 }), 403)).code,
      ).toBe("token_not_allowed");
      await grant("purchasing", "write");
      expect(
        (
          await error(
            await as(marcus.cookie).send("PUT", "/purchasing/settings", { sendApprovalThreshold: 1 }),
            403,
          )
        ).code,
      ).toBe("module_forbidden");
      await grant("purchasing", "manage");
      // Without a threshold anything may be sent.
      const free = await newOrder(mill, [{ itemId: flour, quantity: 1000, unit: "kg", unitPrice: 5 }]);
      await ok(await as(ada).send("POST", `/purchasing/orders/${free.id}/send`, {}));
      await ok(await as(ada).send("PUT", "/purchasing/settings", { sendApprovalThreshold: 100 }));
      expect((await ok(await as(marcus.cookie).get("/purchasing/settings"))).sendApprovalThreshold).toBe(100);
    });

    it("needs a manager other than the creator before an order above it is sent", async () => {
      const small = await newOrder(mill, [{ itemId: flour, quantity: 100, unit: "kg", unitPrice: 1 }]);
      expect(small.sendApproval.state).toBe("not_required");
      await ok(await as(ada).send("POST", `/purchasing/orders/${small.id}/send`, {}));

      const big = await newOrder(mill, [{ itemId: flour, quantity: 100, unit: "kg", unitPrice: 2 }]);
      expect(big.sendApproval).toMatchObject({ state: "needed", threshold: 100 });
      expect(
        (await error(await as(ada).send("POST", `/purchasing/orders/${big.id}/send`, {}), 409)).code,
      ).toBe("approval_required");
      // The managers who may approve are told; the creator is not.
      const inbox = await ok(await as(marcus.cookie).get("/notifications"));
      expect(inbox.notifications.map((n: any) => [n.type, n.data.subjectId])).toContainEqual([
        "purchase_order_approval_needed",
        big.id,
      ]);
      const own = await ok(await as(ada).get("/notifications"));
      expect(own.notifications.map((n: any) => n.type)).not.toContain("purchase_order_approval_needed");

      // Not the creator, and never a token.
      expect(
        (await error(await as(ada).send("POST", `/purchasing/orders/${big.id}/approve`, {}), 403)).code,
      ).toBe("four_eyes");
      expect(
        (await error(await viaToken("POST", `/purchasing/orders/${big.id}/approve`, {}), 403)).code,
      ).toBe("token_not_allowed");
      const approved = await ok(
        await as(marcus.cookie).send("POST", `/purchasing/orders/${big.id}/approve`, {
          note: "Seen the quote",
        }),
      );
      expect(approved.sendApproval).toMatchObject({
        state: "approved",
        approvedBy: marcus.userId,
        approvedValue: 200,
        note: "Seen the quote",
      });
      expect(
        (await error(await as(marcus.cookie).send("POST", `/purchasing/orders/${big.id}/approve`, {}), 409))
          .code,
      ).toBe("already_approved");
      expect(
        (await error(await as(marcus.cookie).send("POST", `/purchasing/orders/${small.id}/approve`, {}), 409))
          .code,
      ).toBe("not_draft");

      // The approval covers up to what it was given for: a bigger order needs approving again.
      await ok(
        await as(ada).send("PATCH", `/purchasing/orders/${big.id}`, {
          lines: [{ id: big.lines[0].id, itemId: flour, quantity: 150, unit: "kg", unitPrice: 2 }],
        }),
      );
      const stale = await order(big.id);
      expect(stale.sendApproval.state).toBe("stale");
      expect(
        (await error(await as(ada).send("POST", `/purchasing/orders/${big.id}/send`, {}), 409)).details.state,
      ).toBe("stale");
      await ok(await as(marcus.cookie).send("POST", `/purchasing/orders/${big.id}/approve`, {}));
      // A smaller order is covered by the approval it has.
      await ok(
        await as(ada).send("PATCH", `/purchasing/orders/${big.id}`, {
          lines: [{ id: big.lines[0].id, itemId: flour, quantity: 120, unit: "kg", unitPrice: 2 }],
        }),
      );
      expect((await order(big.id)).sendApproval.state).toBe("approved");
      expect((await ok(await as(ada).send("POST", `/purchasing/orders/${big.id}/send`, {}))).status).toBe(
        "sent",
      );
    });

    it("refuses to approve an order within the threshold, and drops an approval when the supplier changes", async () => {
      const small = await newOrder(mill, [{ itemId: flour, quantity: 10, unit: "kg", unitPrice: 1 }]);
      expect(
        (await error(await as(marcus.cookie).send("POST", `/purchasing/orders/${small.id}/approve`, {}), 409))
          .code,
      ).toBe("approval_not_required");
      const big = await newOrder(mill, [{ itemId: flour, quantity: 100, unit: "kg", unitPrice: 2 }]);
      await ok(await as(marcus.cookie).send("POST", `/purchasing/orders/${big.id}/approve`, {}));
      await ok(await as(ada).send("PATCH", `/purchasing/orders/${big.id}`, { supplierId: dairy }));
      expect((await order(big.id)).sendApproval).toMatchObject({ state: "needed", approvedBy: null });
    });

    it("counts only priced lines, and a threshold of null switches it off again", async () => {
      const unpriced = await newOrder(dairy, [
        { itemId: flour, quantity: 100000, unit: "kg", unitPrice: null },
      ]);
      expect(unpriced.sendApproval.state).toBe("not_required");
      await ok(await as(ada).send("PUT", "/purchasing/settings", { sendApprovalThreshold: null }));
      const big = await newOrder(mill, [{ itemId: flour, quantity: 100, unit: "kg", unitPrice: 50 }]);
      expect(big.sendApproval.state).toBe("not_required");
      await ok(await as(ada).send("POST", `/purchasing/orders/${big.id}/send`, {}));
    });
  });

  const order = async (id: string) => ok(await as(ada).get(`/purchasing/orders/${id}`));

  describe("supplier price lists", () => {
    it("defaults a line's price to the price in force, ahead of the standard cost", async () => {
      const yesterday = addDays(today, -1);
      const entry = await ok(
        await viaToken("POST", "/purchasing/prices", {
          supplierId: mill,
          itemId: flour,
          unit: "kg",
          unitPrice: 1.5,
          effectiveFrom: addDays(today, -30),
          effectiveTo: addDays(today, -2),
        }),
        201,
      );
      expect(entry).toMatchObject({ inForce: false, item: { code: "FLR" }, supplier: { name: "Mill" } });
      const current = await ok(
        await as(ada).send("POST", "/purchasing/prices", {
          supplierId: mill,
          itemId: flour,
          unit: "kg",
          unitPrice: 1.25,
          effectiveFrom: yesterday,
        }),
        201,
      );
      expect(current.inForce).toBe(true);
      // A future price is not in force yet.
      await ok(
        await as(ada).send("POST", "/purchasing/prices", {
          supplierId: mill,
          itemId: flour,
          unit: "kg",
          unitPrice: 9,
          effectiveFrom: addDays(today, 10),
        }),
        201,
      );
      const o = await newOrder(mill, [
        { itemId: flour, quantity: 10, unit: "kg" },
        { itemId: flour, quantity: 1000, unit: "g" },
        { itemId: flour, quantity: 10, unit: "kg", unitPrice: 3 },
      ]);
      expect(o.lines.map((l: any) => l.unitPrice)).toEqual([1.25, 0.00125, 3]);
      // Another supplier has no list price: the standard cost.
      const other = await newOrder(dairy, [{ itemId: flour, quantity: 10, unit: "kg" }]);
      expect(other.lines[0].unitPrice).toBe(0.8);
      // Lines already on an order keep their price when the list changes.
      await ok(await as(ada).send("PATCH", `/purchasing/prices/${current.id}`, { unitPrice: 2, unit: "kg" }));
      expect((await order(o.id)).lines[0].unitPrice).toBe(1.25);
      expect((await newOrder(mill, [{ itemId: flour, quantity: 1, unit: "kg" }])).lines[0].unitPrice).toBe(2);
      // A new line added to a draft by an update gets the list price too.
      const edited = await ok(
        await as(ada).send("PATCH", `/purchasing/orders/${o.id}`, {
          lines: [
            ...o.lines.map((l: any) => ({
              id: l.id,
              itemId: l.itemId,
              quantity: l.ordered.inLineUnit,
              unit: l.unit,
            })),
            { itemId: flour, quantity: 5, unit: "kg" },
          ],
        }),
      );
      expect(edited.lines.at(-1).unitPrice).toBe(2);
    });

    it("lists, filters, refuses duplicates and bad units, and deletes entries", async () => {
      const list = await ok(await as(ada).get(`/purchasing/prices?supplierId=${mill}`));
      expect(list.total).toBe(3);
      expect(list.prices.filter((p: any) => p.inForce)).toHaveLength(1);
      const onDay = await ok(
        await as(ada).get(`/purchasing/prices?supplierId=${mill}&on=${addDays(today, -20)}`),
      );
      expect(onDay.prices.map((p: any) => p.unitPrice)).toEqual([1.5]);
      const dup = await error(
        await as(ada).send("POST", "/purchasing/prices", {
          supplierId: mill,
          itemId: flour,
          unit: "kg",
          unitPrice: 4,
          effectiveFrom: addDays(today, 10),
        }),
        409,
      );
      expect(dup.code).toBe("duplicate_price");
      // Each has no unit weight set, so it doesn't convert for flour.
      expect(
        (
          await error(
            await as(ada).send("POST", "/purchasing/prices", {
              supplierId: mill,
              itemId: flour,
              unit: "each",
              unitPrice: 1,
              effectiveFrom: today,
            }),
            400,
          )
        ).message,
      ).toMatch(/doesn't convert/);
      expect(
        (
          await error(
            await as(ada).send("POST", "/purchasing/prices", {
              supplierId: mill,
              itemId: flour,
              unit: "kg",
              unitPrice: 1,
              effectiveFrom: today,
              effectiveTo: addDays(today, -1),
            }),
            400,
          )
        ).code,
      ).toBe("invalid_input");
      const future = list.prices.find((p: any) => p.unitPrice === 9);
      expect((await as(ada).send("DELETE", `/purchasing/prices/${future.id}`)).status).toBe(204);
      expect((await ok(await as(ada).get(`/purchasing/prices?supplierId=${mill}`))).total).toBe(2);
      // Read access can't change the list.
      await grant("purchasing", "read");
      expect(
        (
          await as(marcus.cookie).send("POST", "/purchasing/prices", {
            supplierId: mill,
            itemId: flour,
            unit: "kg",
            unitPrice: 1,
            effectiveFrom: today,
          })
        ).status,
      ).toBe(403);
      await grant("purchasing", "manage");
    });
  });

  describe("over-delivery tolerance", () => {
    it("lets a delivery within the tolerance in and asks for a reason beyond it", async () => {
      await ok(await as(ada).send("PUT", "/purchasing/settings", { overDeliveryTolerancePercent: 10 }));
      const o = await newOrder(mill, [{ itemId: flour, quantity: 100, unit: "kg", unitPrice: 1 }]);
      await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/send`, {}));
      const lineId = o.lines[0].id;
      const receive = (quantity: number, extra: object = {}) =>
        as(ada).send("POST", `/purchasing/orders/${o.id}/receipts`, {
          receivedOn: today,
          lines: [{ lineId, outcome: "accepted", quantity, unit: "kg", locationId: store, ...extra }],
        });
      // 105 of 100 is within 10%.
      await ok(await receive(105), 201);
      // 115 in all is beyond the 110 limit.
      const refused = await error(await receive(10), 409);
      expect(refused.code).toBe("over_delivery_reason_required");
      expect(refused.details).toMatchObject({ lineId, tolerancePercent: 10 });
      const accepted = await ok(await receive(10, { overDeliveryReason: "Supplier's pallet was full" }), 201);
      expect(accepted.receipts[0].overDeliveryReason).toBe("Supplier's pallet was full");
      const detail = await order(o.id);
      expect(detail.lines[0].state).toBe("over");
      expect(detail.overDeliveryTolerancePercent).toBe(10);
      expect(detail.deliveries[1].receipts[0].overDeliveryReason).toBe("Supplier's pallet was full");
      // A reason on a delivery within the tolerance is not kept.
      const o2 = await newOrder(mill, [{ itemId: flour, quantity: 100, unit: "kg", unitPrice: 1 }]);
      await ok(await as(ada).send("POST", `/purchasing/orders/${o2.id}/send`, {}));
      const within = await ok(
        await as(ada).send("POST", `/purchasing/orders/${o2.id}/receipts`, {
          receivedOn: today,
          lines: [
            {
              lineId: o2.lines[0].id,
              outcome: "accepted",
              quantity: 110,
              unit: "kg",
              locationId: store,
              overDeliveryReason: "not needed",
            },
          ],
        }),
        201,
      );
      expect(within.receipts[0].overDeliveryReason).toBeNull();
      // Two entries for one line count together.
      const o3 = await newOrder(mill, [{ itemId: flour, quantity: 100, unit: "kg", unitPrice: 1 }]);
      await ok(await as(ada).send("POST", `/purchasing/orders/${o3.id}/send`, {}));
      const entry = (quantity: number) => ({
        lineId: o3.lines[0].id,
        outcome: "accepted",
        quantity,
        unit: "kg",
        locationId: store,
      });
      expect(
        (
          await error(
            await as(ada).send("POST", `/purchasing/orders/${o3.id}/receipts`, {
              receivedOn: today,
              lines: [entry(60), entry(51)],
            }),
            409,
          )
        ).code,
      ).toBe("over_delivery_reason_required");
    });

    it("is off with no tolerance: any quantity is accepted, as before", async () => {
      await ok(await as(ada).send("PUT", "/purchasing/settings", { overDeliveryTolerancePercent: null }));
      const o = await newOrder(mill, [{ itemId: flour, quantity: 10, unit: "kg", unitPrice: 1 }]);
      await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/send`, {}));
      await ok(
        await as(ada).send("POST", `/purchasing/orders/${o.id}/receipts`, {
          receivedOn: today,
          lines: [
            { lineId: o.lines[0].id, outcome: "accepted", quantity: 500, unit: "kg", locationId: store },
          ],
        }),
        201,
      );
    });
  });

  describe("correcting a rejected receipt", () => {
    it("voids a refusal recorded in error: it stays, struck through, and counts nowhere", async () => {
      const o = await newOrder(dairy, [{ itemId: flour, quantity: 50, unit: "kg", unitPrice: 1 }]);
      await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/send`, {}));
      const lineId = o.lines[0].id;
      const delivery = await ok(
        await as(ada).send("POST", `/purchasing/orders/${o.id}/receipts`, {
          receivedOn: today,
          lines: [
            { lineId, outcome: "rejected", quantity: 20, unit: "kg", reason: "Wrong pallet, my mistake" },
            { lineId, outcome: "accepted", quantity: 10, unit: "kg", locationId: store },
          ],
        }),
        201,
      );
      const rejected = delivery.receipts.find((r: any) => r.outcome === "rejected");
      const accepted = delivery.receipts.find((r: any) => r.outcome === "accepted");
      const perf = async () =>
        (await ok(await as(ada).get(`/purchasing/supplier-performance?supplierId=${dairy}`))).suppliers[0];
      expect((await perf()).rejectedDeliveries).toBe(1);
      expect((await order(o.id)).lines[0].rejected.base).toBe(20000);

      expect(
        (
          await error(
            await viaToken("POST", `/purchasing/orders/${o.id}/receipts/${rejected.id}/void`, {
              reason: "x",
            }),
            403,
          )
        ).code,
      ).toBe("token_not_allowed");
      await grant("purchasing", "write");
      expect(
        (
          await as(marcus.cookie).send("POST", `/purchasing/orders/${o.id}/receipts/${rejected.id}/void`, {
            reason: "x",
          })
        ).status,
      ).toBe(403);
      await grant("purchasing", "manage");
      expect(
        (
          await error(
            await as(ada).send("POST", `/purchasing/orders/${o.id}/receipts/${accepted.id}/void`, {
              reason: "x",
            }),
            409,
          )
        ).code,
      ).toBe("receipt_not_rejected");
      expect(
        (
          await error(
            await as(ada).send("POST", `/purchasing/orders/${o.id}/receipts/${rejected.id}/void`, {}),
            400,
          )
        ).code,
      ).toBe("invalid_input");

      const voided = await ok(
        await as(ada).send("POST", `/purchasing/orders/${o.id}/receipts/${rejected.id}/void`, {
          reason: "Recorded against the wrong order",
        }),
      );
      const row = voided.deliveries[0].receipts.find((r: any) => r.id === rejected.id);
      expect(row).toMatchObject({
        voided: true,
        voidReason: "Recorded against the wrong order",
        voidedByName: "Ada Park",
      });
      expect(voided.lines[0].rejected.base).toBe(0);
      // The delivery still happened (the accepted line), but with no refusal.
      expect((await perf()).rejectedDeliveries).toBe(0);
      expect(
        (
          await error(
            await as(ada).send("POST", `/purchasing/orders/${o.id}/receipts/${rejected.id}/void`, {
              reason: "again",
            }),
            409,
          )
        ).code,
      ).toBe("already_voided");
      expect(
        (
          await error(
            await as(ada).send("POST", `/purchasing/orders/${o.id}/receipts/${crypto.randomUUID()}/void`, {
              reason: "x",
            }),
            404,
          )
        ).code,
      ).toBe("not_found");
    });
  });

  describe("emailing an order", () => {
    it("sends a link-free summary to the supplier and logs it on the order", async () => {
      const o = await newOrder(mill, [{ itemId: flour, quantity: 100, unit: "kg", unitPrice: 1.25 }], {
        notes: "Deliver to <gate 2> & ring first",
        supplierReference: "SO-77",
      });
      expect(o.supplier.email).toBe("orders@mill.example");
      // A draft hasn't been committed to: it isn't emailed.
      expect(
        (await error(await as(ada).send("POST", `/purchasing/orders/${o.id}/email`, {}), 409)).code,
      ).toBe("order_not_sent");
      await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/send`, {}));
      mail.sent.length = 0;
      const sent = await ok(
        await as(ada).send("POST", `/purchasing/orders/${o.id}/email`, {
          message: "Thanks for the quick quote",
        }),
      );
      expect(sent).toMatchObject({ emailed: true, to: "orders@mill.example", email: { status: "sent" } });
      expect(mail.sent).toHaveLength(1);
      const message = mail.sent[0]!;
      expect(message.to).toBe("orders@mill.example");
      expect(message.subject).toContain(o.reference);
      expect(message.text).toContain("FLR Flour: 100 kg @ 1.25 = 125.00");
      expect(message.text).toContain("Thanks for the quick quote");
      expect(message.text).toContain("Your reference: SO-77");
      expect(message.text).not.toMatch(/https?:\/\//);
      expect(message.html).not.toMatch(/https?:\/\//);
      expect(message.html).not.toContain("<gate 2>");
      expect(message.html).toContain("&lt;gate 2&gt; &amp; ring first");
      expect(sent.order.emails).toHaveLength(1);
      expect(sent.order.emails[0]).toMatchObject({
        toEmail: "orders@mill.example",
        status: "sent",
        sentByName: "Ada Park",
      });
    });

    it("answers emailed:false instead of failing when the mail server is down, and still logs it", async () => {
      const o = await newOrder(mill, [{ itemId: flour, quantity: 10, unit: "kg", unitPrice: 1 }]);
      await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/send`, {}));
      mail.fail = true;
      try {
        const res = await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/email`, {}));
        expect(res.emailed).toBe(false);
        expect(res.mailError).toMatch(/couldn't be sent.*ECONNREFUSED/);
        expect(res.order.emails[0]).toMatchObject({ status: "failed" });
        expect(res.order.emails[0].error).toMatch(/ECONNREFUSED/);
      } finally {
        mail.fail = false;
      }
      // A retry sends, and both attempts are on the order.
      const again = await ok(
        await as(ada).send("POST", `/purchasing/orders/${o.id}/email`, { to: "other@mill.example" }),
      );
      expect(again.emailed).toBe(true);
      expect(again.order.emails.map((e: any) => [e.toEmail, e.status])).toEqual([
        ["other@mill.example", "sent"],
        ["orders@mill.example", "failed"],
      ]);
    });

    it("needs an address, manage access, and the send switch for tokens", async () => {
      const o = await newOrder(dairy, [{ itemId: flour, quantity: 10, unit: "kg", unitPrice: 1 }]);
      await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/send`, {}));
      const missing = await error(await as(ada).send("POST", `/purchasing/orders/${o.id}/email`, {}), 400);
      expect(missing.details).toMatchObject({ code: "no_supplier_email" });
      await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/email`, { to: "dairy@example.com" }));
      expect(
        (
          await error(
            await viaToken("POST", `/purchasing/orders/${o.id}/email`, { to: "dairy@example.com" }),
            403,
          )
        ).details.action,
      ).toBe("purchasing.send");
      await grant("purchasing", "write");
      expect(
        (
          await as(marcus.cookie).send("POST", `/purchasing/orders/${o.id}/email`, {
            to: "dairy@example.com",
          })
        ).status,
      ).toBe(403);
      await grant("purchasing", "manage");
      expect(
        (await as(ada).send("POST", `/purchasing/orders/${o.id}/email`, { to: "not an email" })).status,
      ).toBe(400);
    });
  });

  describe("supplier non-conformances", () => {
    it("flags the supplier on the order and in performance to people who can read quality, never blocking", async () => {
      const o = await newOrder(dairy, [{ itemId: flour, quantity: 10, unit: "kg", unitPrice: 1 }]);
      expect((await order(o.id)).supplierQuality).toEqual({
        open: 0,
        critical: 0,
        major: 0,
        overdue: 0,
        suggest: false,
        reasons: [],
      });
      await ok(
        await as(ada).send("POST", "/quality/nonconformances", {
          raisedOn: today,
          source: "supplier",
          severity: "major",
          title: "Foreign body in flour",
          description: "Metal found",
          supplierId: dairy,
        }),
        201,
      );
      const flagged = (await order(o.id)).supplierQuality;
      expect(flagged).toMatchObject({ open: 1, major: 1, suggest: true });
      expect(flagged.reasons[0]).toMatch(/major/);
      // The order can still be sent and received: it is a warning, never a block.
      await ok(await as(ada).send("POST", `/purchasing/orders/${o.id}/send`, {}));
      const perf = await ok(await as(ada).get(`/purchasing/supplier-performance?supplierId=${dairy}`));
      expect(perf.suppliers[0].qualityFlag).toMatchObject({ open: 1 });
      // Without quality access it is left out.
      await grant("quality", null);
      expect(
        (await ok(await as(marcus.cookie).get(`/purchasing/orders/${o.id}`))).supplierQuality,
      ).toBeNull();
    });
  });
});
