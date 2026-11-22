import { moduleIds } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

/** Board snapshots and packs. */
describe("BI board snapshots and packs", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let priya: { cookie: string; userId: string };
  let dashboardId: string;
  let teamId: string;

  const req = (cookie: string, method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie, ...(json === undefined ? {} : { json }) });
  const ok = async (res: { status: number; json(): Promise<any> }, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const kpi = (snapshot: { results: { widgets: Array<{ widgetId: string; result?: { rows: any[] } }> } }) =>
    snapshot.results.widgets.find((w) => w.widgetId === "tasks")!.result!.rows[0].task_count as number;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, activeModules: moduleIds });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const login = async (email: string) => ({
      userId: members.find((x: { email: string }) => x.email === email).userId,
      cookie: (await signIn(ctx, email)).cookie,
    });
    marcus = await login("marcus@knotworking.dev");
    priya = await login("priya@knotworking.dev");
    const dashboard = await ok(
      await req(ada, "POST", "/bi/dashboards", {
        title: "Board",
        spec: {
          sections: [
            {
              id: "s",
              widgets: [
                {
                  id: "tasks",
                  type: "kpi",
                  title: "Tasks",
                  query: { dataset: "tasks", measures: ["task_count"] },
                },
                {
                  id: "metric",
                  type: "kpi",
                  title: "Open complaints",
                  query: { dataset: "certified_metrics", measures: ["open_complaints"] },
                },
              ],
            },
          ],
        },
      }),
      201,
    );
    dashboardId = dashboard.id;
    teamId = (await (await ctx.req(`${WS}/bootstrap`, { cookie: ada })).json()).teams[0].id;
  }, 120_000);
  afterAll(() => ctx.handle.close());

  let first: { id: string };
  let second: { id: string };
  let packId: string;

  it("freezes a dashboard as at today, with definitions, and never re-queries it", async () => {
    first = await ok(await req(ada, "POST", `/bi/dashboards/${dashboardId}/snapshots`, {}), 201);
    expect(first).toMatchObject({ dashboardId, dashboardVersion: 1, catalogueVersion: expect.any(Number) });
    const frozen = await ok(await req(ada, "GET", `/bi/snapshots/${first.id}`));
    const before = kpi(frozen);
    expect(frozen.definitions["tasks.task_count"].definition).toBeTruthy();
    expect(frozen.definitions["certified_metrics.open_complaints"].version).toBe("open-complaints-v1");
    expect(frozen.previous).toBeNull();
    // New data changes the live dashboard, not the snapshot.
    await ok(await req(ada, "POST", "/tasks", { teamId, title: "After the snapshot" }), 201);
    const live = await ok(await req(ada, "GET", `/bi/dashboards/${dashboardId}/data`));
    expect(
      live.widgets.find((w: { widgetId: string }) => w.widgetId === "tasks").result.rows[0].task_count,
    ).toBe(before + 1);
    expect(kpi(await ok(await req(ada, "GET", `/bi/snapshots/${first.id}`)))).toBe(before);
    // The next snapshot compares with this one.
    second = await ok(
      await req(ada, "POST", `/bi/dashboards/${dashboardId}/snapshots`, { title: "November" }),
      201,
    );
    const latest = await ok(await req(ada, "GET", `/bi/snapshots/${second.id}`));
    expect(latest.title).toBe("November");
    expect(latest.previous.id).toBe(first.id);
    expect(kpi(latest)).toBe(before + 1);
  });

  it("keeps snapshots to people who manage dashboards", async () => {
    expect((await req(marcus.cookie, "POST", `/bi/dashboards/${dashboardId}/snapshots`, {})).status).toBe(
      403,
    );
    expect((await ok(await req(marcus.cookie, "GET", "/bi/snapshots"), 403)).error.code).toBe(
      "bi_pack_forbidden",
    );
    expect((await req(marcus.cookie, "GET", `/bi/snapshots/${first.id}`)).status).toBe(404);
    const listed = await ok(await req(ada, "GET", `/bi/snapshots?dashboardId=${dashboardId}`));
    expect(listed.snapshots.map((s: { id: string }) => s.id)).toEqual([second.id, first.id]);
    expect(listed.snapshots[0]).not.toHaveProperty("results");
  });

  it("builds a draft pack, issues it to named people, and never changes it after", async () => {
    const pack = await ok(
      await req(ada, "POST", "/bi/packs", {
        title: "Board, November",
        asAt: "2026-11-20",
        cover: "Monthly board meeting.",
        items: [{ snapshotId: second.id, commentary: "Tasks up on October." }],
      }),
      201,
    );
    packId = pack.id;
    expect(pack.status).toBe("draft");
    expect((await req(marcus.cookie, "GET", `/bi/packs/${packId}`)).status).toBe(404);
    await ok(
      await req(ada, "POST", "/bi/packs", {
        title: "Bad",
        asAt: "2026-11-20",
        items: [{ snapshotId: dashboardId }],
      }),
      400,
    );
    const edited = await ok(
      await req(ada, "PATCH", `/bi/packs/${packId}`, {
        cover: "Board meeting, 20 November.",
        expectedVersion: 1,
      }),
    );
    expect(edited.version).toBe(2);
    await ok(await req(ada, "PATCH", `/bi/packs/${packId}`, { title: "Stale", expectedVersion: 1 }), 409);
    await ok(
      await req(ada, "POST", `/bi/packs/${packId}/issue`, {
        audience: "members",
        memberIds: [marcus.userId],
      }),
    );
    // Marcus, in the audience, reads the pack and its snapshot; the earlier snapshot isn't his to compare with.
    const asMarcus = await ok(await req(marcus.cookie, "GET", `/bi/packs/${packId}`));
    expect(asMarcus).toMatchObject({
      status: "issued",
      canEdit: false,
      cover: "Board meeting, 20 November.",
    });
    expect(asMarcus.items[0].commentary).toBe("Tasks up on October.");
    expect(asMarcus.items[0].snapshot.id).toBe(second.id);
    // The comparison was frozen at issue (the snapshot before), and is shared with the audience.
    expect(asMarcus.items[0].previous.id).toBe(first.id);
    expect(asMarcus.definitions["tasks.task_count"]).toBeTruthy();
    await ok(await req(marcus.cookie, "GET", `/bi/snapshots/${second.id}`));
    await ok(await req(marcus.cookie, "GET", `/bi/snapshots/${first.id}`));
    // Ada, who manages dashboards, sees the comparison.
    expect((await ok(await req(ada, "GET", `/bi/packs/${packId}`))).items[0].previous.id).toBe(first.id);
    // Priya isn't in the audience.
    expect((await req(priya.cookie, "GET", `/bi/packs/${packId}`)).status).toBe(404);
    expect((await ok(await req(priya.cookie, "GET", "/bi/packs"))).packs).toEqual([]);
    expect((await req(priya.cookie, "GET", `/bi/snapshots/${second.id}`)).status).toBe(404);
    // Issued is final.
    expect(
      (await ok(await req(ada, "PATCH", `/bi/packs/${packId}`, { title: "Changed" }), 409)).error.code,
    ).toBe("pack_issued");
    await ok(await req(ada, "DELETE", `/bi/packs/${packId}`), 409);
  });

  it("keeps an issued pack's comparison fixed when later snapshots are taken", async () => {
    const third = await ok(await req(ada, "POST", `/bi/dashboards/${dashboardId}/snapshots`, {}), 201);
    const pack = await ok(await req(ada, "GET", `/bi/packs/${packId}`));
    expect(pack.items[0].previous.id).toBe(first.id);
    // A snapshot only the pack doesn't name stays closed to the audience.
    expect((await req(marcus.cookie, "GET", `/bi/snapshots/${third.id}`)).status).toBe(404);
  });

  it("shows managers and tokens only the figures their own access allows", async () => {
    const status = (snapshot: { results: { widgets: Array<{ widgetId: string; status: string }> } }) =>
      Object.fromEntries(snapshot.results.widgets.map((w) => [w.widgetId, w.status]));
    // Priya manages dashboards but can't read quality: the complaints metric is closed to her.
    await ok(await req(ada, "PUT", `/members/${priya.userId}/module-access/bi`, { level: "manage" }));
    await ok(await req(ada, "PUT", `/members/${priya.userId}/module-access/quality`, { level: "none" }));
    expect(status(await ok(await req(priya.cookie, "GET", `/bi/snapshots/${second.id}`)))).toEqual({
      tasks: "ok",
      metric: "no_access",
    });
    // A token's module allowlist applies, for a manager and for a member of the audience alike.
    const token = async (cookie: string) =>
      (
        await ok(
          await ctx.req("/v1/me/api-tokens", {
            method: "POST",
            cookie,
            json: { name: "reader", scope: "read", modules: ["bi", "tasks"] },
          }),
          201,
        )
      ).token as string;
    const read = async (t: string, path: string) =>
      ok(await ctx.req(`${WS}${path}`, { headers: { authorization: `Bearer ${t}`, origin: "" } }));
    expect(status(await read(await token(ada), `/bi/snapshots/${second.id}`))).toEqual({
      tasks: "ok",
      metric: "no_access",
    });
    const viaPack = await read(await token(marcus.cookie), `/bi/packs/${packId}`);
    expect(status(viaPack.items[0].snapshot)).toEqual({ tasks: "ok", metric: "no_access" });
    // In person, the audience sees the figures as issued.
    const inPerson = await ok(await req(marcus.cookie, "GET", `/bi/packs/${packId}`));
    expect(status(inPerson.items[0].snapshot)).toEqual({ tasks: "ok", metric: "ok" });
  });

  it("syncs pack headers to their readers and snapshot headers to managers, never figures", async () => {
    const sync = async (cookie: string) =>
      (await ok(await req(cookie, "GET", "/sync?after=0&limit=1000"))).changes as Array<{
        entity: string;
        entityId: string;
        action: string;
        data: Record<string, unknown> | null;
      }>;
    const forMarcus = await sync(marcus.cookie);
    const pack = forMarcus.filter((c) => c.entity === "bi_board_pack" && c.entityId === packId).at(-1)!;
    expect(pack.action).toBe("upsert");
    expect(pack.data).toMatchObject({ title: "Board, November", itemCount: 1 });
    expect(pack.data).not.toHaveProperty("items");
    expect(pack.data).not.toHaveProperty("cover");
    expect(forMarcus.filter((c) => c.entity === "bi_snapshot").every((c) => c.action === "delete")).toBe(
      true,
    );
    const forAda = await sync(ada);
    const snapshot = forAda.find((c) => c.entity === "bi_snapshot" && c.entityId === first.id)!;
    expect(snapshot.action).toBe("upsert");
    expect(snapshot.data).not.toHaveProperty("results");
    const packAndSnapshots = forAda.filter((c) => c.entity === "bi_snapshot" || c.entity === "bi_board_pack");
    expect(JSON.stringify(packAndSnapshots)).not.toMatch(/"rows"|"results"|"commentary"/);
  });

  it("lets a token build packs only with the bi.board_packs toggle", async () => {
    const tokenFor = async (body: object = {}) =>
      (
        await ok(
          await ctx.req("/v1/me/api-tokens", {
            method: "POST",
            cookie: ada,
            json: { name: "agent", scope: "write", ...body },
          }),
          201,
        )
      ).token as string;
    const asToken = (token: string, method: string, path: string, json?: unknown) =>
      ctx.req(`${WS}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, origin: "" },
        ...(json === undefined ? {} : { json }),
      });
    const plain = await tokenFor();
    expect((await asToken(plain, "POST", `/bi/dashboards/${dashboardId}/snapshots`, {})).status).toBe(403);
    expect((await asToken(plain, "POST", "/bi/packs", { title: "T", asAt: "2026-11-20" })).status).toBe(403);
    // Reading is fine for a manager's token.
    expect((await asToken(plain, "GET", `/bi/packs/${packId}`)).status).toBe(200);
    await ok(await req(ada, "PUT", "/token-actions/bi.board_packs", { enabled: true }));
    try {
      const allowed = await tokenFor({ tokenActions: ["bi.board_packs"] });
      expect((await asToken(allowed, "POST", `/bi/dashboards/${dashboardId}/snapshots`, {})).status).toBe(
        201,
      );
      const draft = await asToken(allowed, "POST", "/bi/packs", { title: "Agent pack", asAt: "2026-11-20" });
      expect(draft.status).toBe(201);
      const { id } = await draft.json();
      expect((await asToken(allowed, "DELETE", `/bi/packs/${id}`)).status).toBe(200);
    } finally {
      await ok(await req(ada, "PUT", "/token-actions/bi.board_packs", { enabled: false }));
    }
  });
});
