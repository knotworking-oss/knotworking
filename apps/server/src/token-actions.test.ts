import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { addDays, personOnlyActions, tokenActionIds } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

/** Today in the test workspaces' zone (the default, Europe/London), as the server decides it. */
const utcToday = () => todayInZone(DEFAULT_TIME_ZONE);

const WS = "/v1/workspaces/acme";

describe("API access toggles (token actions)", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let adaToken: { token: string; id: string };
  let mill: string;
  let flour: string;
  const today = utcToday();

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
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const via = (token: string) => ({
    get: (path: string) =>
      ctx.req(`${WS}${path}`, { headers: { authorization: `Bearer ${token}`, origin: "" } }),
    send: (method: string, path: string, json?: unknown) =>
      ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json }),
  });
  const mint = async (cookie: string, body: object) =>
    (await ok(await ctx.req("/v1/me/api-tokens", { method: "POST", cookie, json: body }), 201)) as {
      token: string;
      apiToken: { id: string };
    };
  const toggle = (cookie: string, action: string, enabled: boolean) =>
    as(cookie).send("PUT", `/token-actions/${action}`, { enabled });
  const grant = (moduleId: string, level: string | null) =>
    as(ada).send("PUT", `/members/${marcus.userId}/module-access/${moduleId}`, { level });
  const draftOrder = async () =>
    (
      await ok(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId: mill,
          expectedOn: addDays(today, 3),
          lines: [{ itemId: flour, quantity: 5, unit: "kg" }],
        }),
        201,
      )
    ).id as string;
  const log = async (query = "") => ok(await as(ada).get(`/token-actions/log${query}`));

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    marcus = {
      userId: members.find((x: { email: string }) => x.email === "marcus@knotworking.dev").userId,
      cookie: (await signIn(ctx, "marcus@knotworking.dev")).cookie,
    };
    const minted = await mint(ada, {
      name: "Purchasing agent",
      scope: "write",
      tokenActions: [...tokenActionIds],
    });
    adaToken = { token: minted.token, id: minted.apiToken.id };
    mill = (await ok(await as(ada).send("POST", "/suppliers", { name: "Mill" }), 201)).id;
    await ok(await as(ada).send("POST", `/suppliers/${mill}/approval`, { status: "approved" }));
    flour = (
      await ok(
        await as(ada).send("POST", "/items", {
          code: "FLR",
          name: "Flour",
          type: "ingredient",
          unit: "kg",
          suppliers: [{ supplierId: mill, preferred: true }],
        }),
        201,
      )
    ).id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("lists every action as off, with the person-only list, to members and tokens alike", async () => {
    const list = await ok(await as(ada).get("/token-actions"));
    expect(list.canManage).toBe(true);
    expect(list.actions.map((a: { id: string }) => a.id)).toEqual([...tokenActionIds]);
    expect(list.actions[0]).toEqual({
      id: "purchasing.send",
      module: "purchasing",
      label: "Send purchase orders",
      description: expect.any(String),
      level: "manage",
      enabled: false,
      enabledBy: null,
      enabledAt: null,
      allowedForToken: null,
    });
    expect(list.personOnly).toEqual(personOnlyActions);
    expect(list.personOnly[0]).toMatchObject({
      module: "workforce",
      kind: "attestation",
      reason: expect.any(String),
    });

    const viaToken = await ok(await via(adaToken.token).get("/token-actions"));
    expect(viaToken.canManage).toBe(false);
    // A token also sees whether its own allowlist lets it use each action.
    expect(viaToken.actions).toEqual(list.actions.map((a: object) => ({ ...a, allowedForToken: true })));

    // A member sees only the modules they can read (purchasing and the rest are opt-in; dashboards
    // follow the role, so their publishing toggle is listed).
    const member = await ok(await as(marcus.cookie).get("/token-actions"));
    expect(member.canManage).toBe(false);
    expect(member.actions.map((a: { id: string }) => a.id)).toEqual(["bi.publish", "bi.board_packs"]);
    expect(member.personOnly.every((a: { module: string }) => ["items", "purchase_requests"].includes(a.module))).toBe(true);
  });

  it("refuses a token by default, naming the action and where to allow it", async () => {
    const po = await draftOrder();
    const refused = await error(
      await via(adaToken.token).send("POST", `/purchasing/orders/${po}/send`, {}),
      403,
    );
    expect(refused).toEqual({
      code: "token_not_allowed",
      message:
        'API tokens can\'t send purchase orders in this workspace unless an owner or admin allows "Send purchase orders" under Settings → API access',
      details: { action: "purchasing.send" },
    });
    // Refusals before the toggle lets a token through aren't audited.
    expect((await log()).total).toBe(0);
  });

  it("only an owner or admin, signed in with their own account, can switch an action", async () => {
    const byToken = await error(
      await via(adaToken.token).send("PUT", "/token-actions/purchasing.send", { enabled: true }),
      403,
    );
    expect(byToken.code).toBe("session_required");
    const byMember = await error(await toggle(marcus.cookie, "purchasing.send", true), 403);
    expect(byMember.code).toBe("forbidden");
    expect((await error(await toggle(ada, "purchasing.nope", true), 404)).code).toBe("not_found");
    expect(
      (await error(await as(ada).send("PUT", "/token-actions/purchasing.send", { enabled: "yes" }), 400))
        .code,
    ).toBe("invalid_input");
    // The audit is an admin's view too.
    expect((await error(await via(adaToken.token).get("/token-actions/log"), 403)).code).toBe(
      "session_required",
    );
    expect((await error(await as(marcus.cookie).get("/token-actions/log"), 403)).code).toBe("forbidden");
    expect((await ok(await as(ada).get("/token-actions"))).actions[0].enabled).toBe(false);
  });

  it("lets a token through once enabled, and audits each call with its status", async () => {
    const { cursor } = await ok(await as(ada).get("/bootstrap"));
    const on = await ok(await toggle(ada, "purchasing.send", true));
    expect(on).toMatchObject({ id: "purchasing.send", enabled: true, enabledBy: "Ada Park" });
    expect(Date.parse(on.enabledAt)).not.toBeNaN();
    // Switching it on again changes nothing.
    expect(await ok(await toggle(ada, "purchasing.send", true))).toEqual(on);

    // Recorded in the sync log as a platform change, once.
    const sync = await ok(await as(ada).get(`/sync?after=${cursor}`));
    const changes = sync.changes.filter((c: { entity: string }) => c.entity === "token_action");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      action: "upsert",
      data: { action: "purchasing.send", module: "purchasing", enabled: true, enabledBy: "Ada Park" },
    });
    // The same shape the list gives, so a client can apply it as it is.
    expect(changes[0].data.enabledAt).toBe(on.enabledAt);

    const po = await draftOrder();
    const sent = await ok(await via(adaToken.token).send("POST", `/purchasing/orders/${po}/send`, {}));
    expect(sent).toMatchObject({ status: "sent", sentByName: "Ada Park" });
    // A failed call is audited too, with its status (outside the handler's transaction).
    expect(
      (await error(await via(adaToken.token).send("POST", `/purchasing/orders/${po}/send`, {}), 409)).code,
    ).toBe("not_draft");
    // Sessions aren't audited: the toggle didn't let them through.
    await ok(await as(ada).send("POST", `/purchasing/orders/${await draftOrder()}/send`, {}));

    const audit = await log();
    expect(audit.total).toBe(2);
    expect(audit.entries).toHaveLength(2);
    // Newest first.
    expect(audit.entries[0]).toMatchObject({
      action: "purchasing.send",
      label: "Send purchase orders",
      method: "POST",
      path: `${WS}/purchasing/orders/${po}/send`,
      status: 409,
      tokenId: adaToken.id,
      tokenName: "Purchasing agent",
      userId: expect.any(String),
      userName: "Ada Park",
    });
    expect(audit.entries[1]).toMatchObject({ status: 200, tokenName: "Purchasing agent" });
    expect(Date.parse(audit.entries[0].createdAt)).not.toBeNaN();

    // Paged and filtered by token.
    const page = await log("?limit=1&offset=1");
    expect(page.entries.map((e: { status: number }) => e.status)).toEqual([200]);
    expect(page.total).toBe(2);
    expect((await log(`?tokenId=${adaToken.id}`)).total).toBe(2);
    expect((await log("?tokenId=00000000-0000-7000-8000-000000000000")).total).toBe(0);
  });

  it("still requires the token owner's module level", async () => {
    await ok(await grant("items", "read"));
    await ok(await grant("stock", "read"));
    await ok(await grant("purchasing", "write"));
    const marcusToken = (
      await mint(marcus.cookie, { name: "Marcus's agent", scope: "write", tokenActions: [...tokenActionIds] })
    ).token;
    const po = await draftOrder();
    // purchasing.send is on, but sending needs manage and Marcus has write.
    const refused = await error(
      await via(marcusToken).send("POST", `/purchasing/orders/${po}/send`, {}),
      403,
    );
    expect(refused.code).toBe("module_forbidden");
    // Write is enough to see the toggles of the module, but not to switch them.
    const list = await ok(await via(marcusToken).get("/token-actions"));
    expect(list.actions.map((a: { id: string }) => a.id)).toContain("purchasing.send");
    // The attempt was let through by the toggle, so it is audited with the refusal.
    const audit = await log();
    expect(audit.entries[0]).toMatchObject({
      status: 403,
      tokenName: "Marcus's agent",
      userName: "Marcus Chen",
    });
    // Refused by the module gate itself (waste needs write, Marcus has read on stock): audited too.
    await ok(await toggle(ada, "stock.waste", true));
    const gated = await error(await via(marcusToken).send("POST", "/stock/waste", {}), 403);
    expect(gated.code).toBe("module_forbidden");
    expect((await log()).entries[0]).toMatchObject({
      action: "stock.waste",
      status: 403,
      tokenName: "Marcus's agent",
    });
    await ok(await toggle(ada, "stock.waste", false));
    await ok(await grant("purchasing", "manage"));
    await ok(await via(marcusToken).send("POST", `/purchasing/orders/${po}/send`, {}));
    await ok(await grant("purchasing", null));
  });

  it("still applies the token's module allowlist", async () => {
    const stockOnly = (
      await mint(ada, {
        name: "Stock only",
        scope: "write",
        modules: ["items", "stock"],
        tokenActions: [...tokenActionIds],
      })
    ).token;
    const po = await draftOrder();
    const refused = await error(await via(stockOnly).send("POST", `/purchasing/orders/${po}/send`, {}), 403);
    expect(refused.code).toBe("module_forbidden");
    // Refused before the route, but through an enabled action: audited like any other refusal.
    expect((await log()).entries[0]).toMatchObject({
      action: "purchasing.send",
      status: 403,
      tokenName: "Stock only",
    });
    // Its view of the toggles is narrowed the same way.
    const list = await ok(await via(stockOnly).get("/token-actions"));
    expect(new Set(list.actions.map((a: { module: string }) => a.module))).toEqual(new Set(["stock"]));
    expect(list.personOnly.every((a: { module: string }) => ["items", "stock"].includes(a.module))).toBe(
      true,
    );
  });

  it("turns off again", async () => {
    const { cursor } = await ok(await as(ada).get("/bootstrap"));
    const off = await ok(await toggle(ada, "purchasing.send", false));
    expect(off).toMatchObject({ id: "purchasing.send", enabled: false, enabledBy: null, enabledAt: null });
    expect(await ok(await toggle(ada, "purchasing.send", false))).toEqual(off);
    const sync = await ok(await as(ada).get(`/sync?after=${cursor}`));
    expect(sync.changes.filter((c: { entity: string }) => c.entity === "token_action")).toMatchObject([
      { action: "upsert", data: { action: "purchasing.send", enabled: false } },
    ]);
    const po = await draftOrder();
    expect(
      (await error(await via(adaToken.token).send("POST", `/purchasing/orders/${po}/send`, {}), 403)).code,
    ).toBe("token_not_allowed");
  });

  it("opens one action at a time: others stay refused", async () => {
    await ok(await toggle(ada, "stock.waste", true));
    const po = await draftOrder();
    expect(
      (
        await error(
          await via(adaToken.token).send("POST", `/purchasing/orders/${po}/cancel`, { reason: "x" }),
          403,
        )
      ).code,
    ).toBe("token_not_allowed");
    // Waste is through to the handler (an unknown lot is the handler's own answer, and is audited).
    const waste = await via(adaToken.token).send("POST", "/stock/waste", {});
    expect(waste.status).not.toBe(403);
    expect((await log()).entries[0]).toMatchObject({ action: "stock.waste", status: waste.status });
    await ok(await toggle(ada, "stock.waste", false));
  });

  it("keeps the sync change from members who can't read the module", async () => {
    const { cursor } = await ok(await as(marcus.cookie).get("/bootstrap"));
    await ok(await toggle(ada, "attendance.events", true));
    await ok(await toggle(ada, "attendance.events", false));
    const sync = await ok(await as(marcus.cookie).get(`/sync?after=${cursor}`));
    expect(sync.changes.filter((c: { entity: string }) => c.entity === "token_action")).toEqual([]);
    const adaSync = await ok(await as(ada).get(`/sync?after=${cursor}`));
    expect(adaSync.changes.filter((c: { entity: string }) => c.entity === "token_action")).toHaveLength(2);
  });
});

describe("API access toggles with modules switched off", () => {
  let ctx: TestCtx;
  let ada: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, activeModules: ["tasks", "items", "stock"] });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("hides the actions of inactive modules and refuses to switch them (404 module_inactive)", async () => {
    const res = await ctx.req(`${WS}/token-actions`, { cookie: ada });
    const list = await res.json();
    expect(list.actions.map((a: { id: string }) => a.id)).toEqual([
      "stock.waste",
      "stock.adjust",
      "stock.stocktake",
    ]);
    expect(new Set(list.personOnly.map((a: { module: string }) => a.module))).toEqual(
      new Set(["items", "stock"]),
    );
    const put = await ctx.req(`${WS}/token-actions/purchasing.send`, {
      method: "PUT",
      cookie: ada,
      json: { enabled: true },
    });
    expect(put.status).toBe(404);
    expect((await put.json()).error.code).toBe("module_inactive");
    const active = await ctx.req(`${WS}/token-actions/stock.adjust`, {
      method: "PUT",
      cookie: ada,
      json: { enabled: true },
    });
    expect(active.status).toBe(200);
  });
});
