import { addDays, DEFAULT_TIME_ZONE, todayInZone, tokenActionIds } from "@knotworking/core";
import { apiTokens, notifications } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

/** Per-token action allowlists, the order-value cap, and the notification a token's use sends. */
describe("what a token may do through person-only actions", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let mill: string;
  let flour: string;
  const today = todayInZone(DEFAULT_TIME_ZONE);

  const body = async (res: { status: number; json(): Promise<any> }, status = 200) => {
    const b = await res.json();
    expect(res.status, JSON.stringify(b)).toBe(status);
    return b;
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
  const mint = async (json: object) =>
    (await body(await ctx.req("/v1/me/api-tokens", { method: "POST", cookie: ada, json }), 201)) as {
      token: string;
      apiToken: { id: string; tokenActions: string[] | null; maxOrderValue: number | null };
    };
  const draftOrder = async (unitPrice: number | null = 10, quantity = 5) =>
    (
      await body(
        await as(ada).send("POST", "/purchasing/orders", {
          supplierId: mill,
          expectedOn: addDays(today, 3),
          lines: [{ itemId: flour, quantity, unit: "kg", ...(unitPrice === null ? {} : { unitPrice }) }],
        }),
        201,
      )
    ).id as string;
  const log = async () => (await body(await as(ada).get("/token-actions/log"))).entries;
  const inbox = async (cookie: string) =>
    (await body(await ctx.req(`${WS}/notifications?unread=true`, { cookie }))).notifications as {
      id: string;
      type: string;
      data: Record<string, any>;
    }[];

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await body(await ctx.req(`${WS}/members`, { cookie: ada }));
    marcus = {
      userId: members.find((x: { email: string }) => x.email === "marcus@knotworking.dev").userId,
      cookie: (await signIn(ctx, "marcus@knotworking.dev")).cookie,
    };
    mill = (await body(await as(ada).send("POST", "/suppliers", { name: "Mill" }), 201)).id;
    await body(await as(ada).send("POST", `/suppliers/${mill}/approval`, { status: "approved" }));
    flour = (
      await body(
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
    await body(await as(ada).send("PUT", "/token-actions/purchasing.send", { enabled: true }));
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("gives a new token no person-only action unless it is asked for", async () => {
    const none = await mint({ name: "Nothing", scope: "write" });
    expect(none.apiToken).toMatchObject({ tokenActions: [], maxOrderValue: null });
    const po = await draftOrder();
    const refused = await body(await via(none.token).send("POST", `/purchasing/orders/${po}/send`, {}), 403);
    expect(refused.error).toMatchObject({
      code: "token_not_allowed",
      details: { action: "purchasing.send", reason: "token_allowlist" },
    });
    expect(refused.error.message).toContain("Settings → API tokens");
    // The listing tells the token (and so the MCP server) what it may use.
    const list = await body(await via(none.token).get("/token-actions"));
    expect(list.actions.find((a: { id: string }) => a.id === "purchasing.send")).toMatchObject({
      enabled: true,
      allowedForToken: false,
    });
    // The refusal is audited, with the reason, because the workspace had the action on.
    expect((await log())[0]).toMatchObject({
      status: 403,
      tokenName: "Nothing",
      note: expect.stringContaining("isn't allowed"),
    });
  });

  it("lets a token use exactly the actions on its allowlist", async () => {
    const sender = await mint({ name: "Sender", scope: "write", tokenActions: ["purchasing.send"] });
    const po = await draftOrder();
    await body(await via(sender.token).send("POST", `/purchasing/orders/${po}/send`, {}));
    // Another action the workspace has on is still refused to it.
    await body(await as(ada).send("PUT", "/token-actions/purchasing.close", { enabled: true }));
    const refused = await body(
      await via(sender.token).send("POST", `/purchasing/orders/${po}/close`, {}),
      403,
    );
    expect(refused.error.details).toEqual({ action: "purchasing.close", reason: "token_allowlist" });
    // And an action on its list is no use while the workspace has it off.
    await body(await as(ada).send("PUT", "/token-actions/purchasing.close", { enabled: false }));
    const off = await body(await via(sender.token).send("POST", `/purchasing/orders/${po}/close`, {}), 403);
    expect(off.error.details).toEqual({ action: "purchasing.close" });
  });

  it("keeps a token made before allowlists unrestricted until it is edited", async () => {
    const old = await mint({ name: "Old", scope: "write" });
    await ctx.handle.db
      .update(apiTokens)
      .set({ tokenActions: null })
      .where(eq(apiTokens.id, old.apiToken.id));
    const list = await body(await via(old.token).get("/token-actions"));
    expect(list.actions.every((a: { allowedForToken: boolean }) => a.allowedForToken)).toBe(true);
    const po = await draftOrder();
    await body(await via(old.token).send("POST", `/purchasing/orders/${po}/send`, {}));
    // Editing it restricts it to what is sent.
    const edited = await body(
      await ctx.req(`/v1/me/api-tokens/${old.apiToken.id}`, {
        method: "PATCH",
        cookie: ada,
        json: { tokenActions: ["stock.waste"] },
      }),
    );
    expect(edited.apiToken.tokenActions).toEqual(["stock.waste"]);
    const next = await draftOrder();
    await body(await via(old.token).send("POST", `/purchasing/orders/${next}/send`, {}), 403);
  });

  it("edits the allowlist and the cap on your own token only, and never by token", async () => {
    const t = await mint({ name: "Editable", scope: "write", tokenActions: ["purchasing.send"] });
    const patch = (cookie: string | undefined, json: unknown, headers: Record<string, string> = {}) =>
      ctx.req(`/v1/me/api-tokens/${t.apiToken.id}`, {
        method: "PATCH",
        ...(cookie ? { cookie } : {}),
        headers,
        json,
      });
    const set = await body(await patch(ada, { maxOrderValue: 250.5 }));
    expect(set.apiToken).toMatchObject({ maxOrderValue: 250.5, tokenActions: ["purchasing.send"] });
    expect((await body(await patch(ada, { maxOrderValue: null }))).apiToken.maxOrderValue).toBeNull();
    expect((await body(await patch(ada, {}), 400)).error.code).toBe("invalid_input");
    expect((await body(await patch(ada, { tokenActions: ["nope"] }), 400)).error.code).toBe("invalid_input");
    expect((await body(await patch(ada, { maxOrderValue: -1 }), 400)).error.code).toBe("invalid_input");
    // Someone else's token is not found.
    expect((await body(await patch(marcus.cookie, { maxOrderValue: 5 }), 404)).error.code).toBe("not_found");
    // A token can't widen itself.
    const byToken = await patch(
      undefined,
      { tokenActions: [...tokenActionIds] },
      {
        authorization: `Bearer ${t.token}`,
        origin: "",
      },
    );
    expect((await body(byToken, 403)).error.code).toBe("session_required");
    // Listed with its settings.
    const listed = (await body(await ctx.req("/v1/me/api-tokens", { cookie: ada }))).apiTokens;
    expect(listed.find((x: { id: string }) => x.id === t.apiToken.id)).toMatchObject({
      tokenActions: ["purchasing.send"],
      maxOrderValue: null,
    });
  });

  it("refuses an order over the token's cap with a clear 403, audited, and sends one within it", async () => {
    const capped = await mint({
      name: "Capped",
      scope: "write",
      tokenActions: ["purchasing.send"],
      maxOrderValue: 100,
    });
    const big = await draftOrder(30, 5); // 150
    const refused = await body(
      await via(capped.token).send("POST", `/purchasing/orders/${big}/send`, {}),
      403,
    );
    expect(refused.error).toMatchObject({
      code: "token_limit_exceeded",
      details: { action: "purchasing.send", limit: 100, value: 150, valueComplete: true },
    });
    expect(refused.error.message).toMatch(/150\.00.*100\.00/);
    // Still a draft: nothing was sent.
    expect((await body(await as(ada).get(`/purchasing/orders/${big}`))).status).toBe("draft");
    expect((await log())[0]).toMatchObject({
      status: 403,
      tokenName: "Capped",
      note: expect.stringContaining("over this API token's limit"),
    });

    // Exactly the cap is fine.
    const exact = await draftOrder(20, 5); // 100
    expect(
      (await body(await via(capped.token).send("POST", `/purchasing/orders/${exact}/send`, {}))).status,
    ).toBe("sent");
    // An order with an unpriced line can't be checked, so it is refused too.
    const unpriced = await draftOrder(null);
    const unknown = await body(
      await via(capped.token).send("POST", `/purchasing/orders/${unpriced}/send`, {}),
      403,
    );
    expect(unknown.error.code).toBe("token_limit_exceeded");
    expect(unknown.error.message).toContain("no price");
    // A person is not capped, and the same big order goes through them.
    expect((await body(await as(ada).send("POST", `/purchasing/orders/${big}/send`, {}))).status).toBe(
      "sent",
    );
    // Raising the cap lets the token send what it was refused.
    await body(
      await ctx.req(`/v1/me/api-tokens/${capped.apiToken.id}`, {
        method: "PATCH",
        cookie: ada,
        json: { maxOrderValue: 1000 },
      }),
    );
    const again = await draftOrder(30, 5);
    expect(
      (await body(await via(capped.token).send("POST", `/purchasing/orders/${again}/send`, {}))).status,
    ).toBe("sent");
  });

  it("tells the token's owner and the admins when a token used an action, once while unread", async () => {
    await ctx.handle.db.delete(notifications);
    const t = await mint({ name: "Notifier", scope: "write", tokenActions: ["purchasing.send"] });
    // Marcus owns this token but is no admin; he needs purchasing manage to send.
    await body(
      await as(ada).send("PUT", `/members/${marcus.userId}/module-access/purchasing`, { level: "manage" }),
    );
    for (const module of ["items", "stock"]) {
      await body(
        await as(ada).send("PUT", `/members/${marcus.userId}/module-access/${module}`, { level: "read" }),
      );
    }
    const minted = (await (
      await ctx.req("/v1/me/api-tokens", {
        method: "POST",
        cookie: marcus.cookie,
        json: { name: "Marcus agent", scope: "write", tokenActions: ["purchasing.send"] },
      })
    ).json()) as { token: string };

    await body(await via(minted.token).send("POST", `/purchasing/orders/${await draftOrder()}/send`, {}));
    // A refused call tells nobody.
    const refusedPo = await draftOrder();
    await body(
      await via(t.token).send("POST", `/purchasing/orders/${refusedPo}/send`, { orderedOn: "2999-01-01" }),
      400,
    );

    const forAda = (await inbox(ada)).filter((n) => n.type === "token_action_used");
    const forMarcus = (await inbox(marcus.cookie)).filter((n) => n.type === "token_action_used");
    expect(forAda).toHaveLength(1);
    expect(forMarcus).toHaveLength(1);
    expect(forAda[0]!.data).toMatchObject({
      tokenName: "Marcus agent",
      tokenAction: "purchasing.send",
      ownerName: expect.any(String),
      uses: 1,
    });

    // A second use while unread raises the count instead of adding an entry.
    await body(await via(minted.token).send("POST", `/purchasing/orders/${await draftOrder()}/send`, {}));
    const after = (await inbox(ada)).filter((n) => n.type === "token_action_used");
    expect(after).toHaveLength(1);
    expect(after[0]!.data.uses).toBe(2);

    // Once read, the next use notifies again.
    await body(await ctx.req(`${WS}/notifications/${after[0]!.id}/read`, { method: "POST", cookie: ada }));
    await body(await via(minted.token).send("POST", `/purchasing/orders/${await draftOrder()}/send`, {}));
    expect((await inbox(ada)).filter((n) => n.type === "token_action_used")).toHaveLength(1);
    // Sessions never notify.
    await ctx.handle.db.delete(notifications);
    await body(await as(ada).send("POST", `/purchasing/orders/${await draftOrder()}/send`, {}));
    expect(await inbox(ada)).toEqual([]);
  });
});
