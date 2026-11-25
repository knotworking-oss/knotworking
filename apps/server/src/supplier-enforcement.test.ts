import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

/**
 * Supplier control enforcement (closing a 3.2.4 gap): a workspace setting turns open control
 * issues from a report into a block on supplier approval and order sending, with a person's
 * recorded override.
 */
describe("supplier control enforcement", () => {
  let ctx: TestCtx;
  let ada: string;
  let token: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  const ok = async (res: Response, status = 200): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const fails = async (res: Response, status: number, code?: string): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    if (code) expect(body.error?.code).toBe(code);
    return body;
  };

  const today = new Date().toISOString().slice(0, 10);
  const nextYear = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
  let mill: string;
  let flour: string;
  let store: string;
  const approve = (supplierId: string, extra: Record<string, unknown> = {}) =>
    as(ada).send("POST", `/suppliers/${supplierId}/approval`, {
      status: "approved",
      reviewDueOn: nextYear,
      ...extra,
    });
  const draftOrder = async () =>
    (
      await ok(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId: mill,
          deliveryLocationId: store,
          expectedOn: today,
          lines: [{ itemId: flour, quantity: 25, unit: "kg", unitPrice: 0.5 }],
        }),
        201,
      )
    ).id as string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "t", scope: "write", tokenActions: ["purchasing.send"] },
        })
      ).json()
    ).token;
    mill = (await ok(await as(ada).send("POST", "/suppliers", { name: "Enforced Mill" }), 201)).id;
    flour = (
      await ok(
        await as(ada).send("POST", "/items", {
          code: "EFL",
          name: "Enforced flour",
          type: "ingredient",
          unit: "kg",
          suppliers: [{ supplierId: mill }],
        }),
        201,
      )
    ).id;
    store = (await ok(await as(ada).send("POST", "/stock/locations", { name: "Goods-in" }), 201)).id;
  });

  afterAll(() => ctx.handle.close());

  it("only reports by default: an unassessed supplier is approved and ordered from as before", async () => {
    expect(await ok(await as(ada).get("/suppliers/control-settings"))).toEqual({ enforcement: "report" });
    const { suppliers } = await ok(await as(ada).get("/suppliers/compliance"));
    expect(suppliers.find((s: { supplierId: string }) => s.supplierId === mill).actionCount).toBeGreaterThan(
      0,
    );
    const approved = await ok(await approve(mill));
    expect(approved).toMatchObject({ approvalStatus: "approved", approvalControlsOverride: null });
    const sent = await ok(await as(ada).send("POST", `/purchasing/orders/${await draftOrder()}/send`, {}));
    expect(sent).toMatchObject({ status: "sent", sendControlsOverride: null });
  });

  it("is changed by a person with Items manage, never a token", async () => {
    expect((await viaToken("PUT", "/suppliers/control-settings", { enforcement: "block" })).status).toBe(403);
    await fails(await as(ada).send("PUT", "/suppliers/control-settings", { enforcement: "strict" }), 400);
    expect(
      await ok(await as(ada).send("PUT", "/suppliers/control-settings", { enforcement: "block" })),
    ).toEqual({ enforcement: "block" });
    // The setting is in the sync log as Items reference data.
    const { changes } = await ok(await ctx.req(`${WS}/sync?since=0`, { cookie: ada }));
    expect(
      changes.some(
        (c: { entity: string; data: { enforcement?: string } }) =>
          c.entity === "supplier_control_settings" && c.data?.enforcement === "block",
      ),
    ).toBe(true);
  });

  it("blocks approval and sending while issues are open, unless a person records an override", async () => {
    // Approval is refused with the issues listed.
    const refused = await fails(await approve(mill), 409, "supplier_controls_open");
    expect(refused.error.details.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("No risk assessment")]),
    );
    // An override is recorded with the issues it overrode.
    const overridden = await ok(await approve(mill, { controlsOverride: "Sole UK source; audit booked" }));
    expect(overridden.approvalControlsOverride).toEqual({
      reason: "Sole UK source; audit booked",
      issues: refused.error.details.issues,
    });
    // Suspending is never blocked, and clears the override.
    expect(
      (await ok(await as(ada).send("POST", `/suppliers/${mill}/approval`, { status: "suspended" })))
        .approvalControlsOverride,
    ).toBeNull();
    await ok(await approve(mill, { controlsOverride: "Sole UK source; audit booked" }));

    // Sending: refused, then sent with a recorded override.
    const order = await draftOrder();
    const blocked = await fails(
      await as(ada).send("POST", `/purchasing/orders/${order}/send`, {}),
      409,
      "supplier_controls_open",
    );
    expect(blocked.error.details.issues.length).toBeGreaterThan(0);
    const sent = await ok(
      await as(ada).send("POST", `/purchasing/orders/${order}/send`, {
        controlsOverride: "Urgent: line stops without flour",
      }),
    );
    expect(sent.status).toBe("sent");
    expect(sent.sendControlsOverride).toMatchObject({ reason: "Urgent: line stops without flour" });

    // A token can send where the workspace allows it, but never override.
    await ok(await as(ada).send("PUT", "/token-actions/purchasing.send", { enabled: true }));
    const viaAgent = await draftOrder();
    await fails(
      await viaToken("POST", `/purchasing/orders/${viaAgent}/send`, {}),
      409,
      "supplier_controls_open",
    );
    await fails(
      await viaToken("POST", `/purchasing/orders/${viaAgent}/send`, { controlsOverride: "Agent says so" }),
      403,
      "override_not_allowed",
    );
  });

  it("lets only a person with Items manage override on send", async () => {
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    const marcus = (await signIn(ctx, m.email)).cookie;
    const grant = (moduleId: string, level: string) =>
      ctx.req(`${WS}/members/${m.userId}/module-access/${moduleId}`, {
        method: "PUT",
        cookie: ada,
        json: { level },
      });
    // A buyer: Purchasing manage, but only Items read.
    await ok(await grant("items", "read"));
    await ok(await grant("stock", "read"));
    await ok(await grant("purchasing", "manage"));
    const order = await draftOrder();
    await fails(
      await as(marcus).send("POST", `/purchasing/orders/${order}/send`, {}),
      409,
      "supplier_controls_open",
    );
    await fails(
      await as(marcus).send("POST", `/purchasing/orders/${order}/send`, {
        controlsOverride: "Need it today",
      }),
      403,
      "override_not_allowed",
    );
    await ok(await grant("items", "manage"));
    const sent = await ok(
      await as(marcus).send("POST", `/purchasing/orders/${order}/send`, {
        controlsOverride: "Need it today",
      }),
    );
    expect(sent.sendControlsOverride).toMatchObject({ reason: "Need it today" });
  });

  it("enforces required supplier specifications while Specifications is hidden in the workspace", async () => {
    await ok(
      await as(ada).send("POST", `/suppliers/${mill}/risk-assessments`, {
        riskLevel: "medium",
        rationale: "Review the supplier specification before buying",
        controls: ["specification"],
        reviewDueOn: nextYear,
      }),
      201,
    );
    const order = await draftOrder();
    const settings = (modules: string[] | null) => as(ada).send("PATCH", "/module-settings", { modules });
    try {
      await ok(await settings(["items", "stock", "purchasing"]));
      expect((await as(ada).get("/specifications")).status).toBe(404);
      const result = await ok(await as(ada).get(`/suppliers/${mill}/controls`));
      expect(result.assessments[0].controlStates).toEqual(
        expect.arrayContaining([expect.objectContaining({ control: "specification", state: "missing" })]),
      );
      const approveResult = await fails(await approve(mill), 409, "supplier_controls_open");
      expect(approveResult.error.message).toContain("No approved specification");
      const sendResult = await fails(
        await as(ada).send("POST", `/purchasing/orders/${order}/send`, {}),
        409,
        "supplier_controls_open",
      );
      expect(sendResult.error.message).toContain("No approved specification");
    } finally {
      await ok(await settings(null));
    }
  });

  it("stops blocking once the controls are met", async () => {
    await ok(
      await as(ada).send("POST", `/suppliers/${mill}/risk-assessments`, {
        riskLevel: "low",
        hazards: ["physical"],
        rationale: "Sealed sacks from a certified mill",
        controls: ["coa_each_delivery"],
        reviewDueOn: nextYear,
      }),
      201,
    );
    const { suppliers } = await ok(await as(ada).get("/suppliers/compliance"));
    expect(suppliers.find((s: { supplierId: string }) => s.supplierId === mill).actionCount).toBe(0);
    expect((await ok(await approve(mill))).approvalControlsOverride).toBeNull();
    const sent = await ok(await as(ada).send("POST", `/purchasing/orders/${await draftOrder()}/send`, {}));
    expect(sent).toMatchObject({ status: "sent", sendControlsOverride: null });
  });
});
