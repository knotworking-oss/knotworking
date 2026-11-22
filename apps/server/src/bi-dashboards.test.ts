import { moduleIds, type BiDashboardSpecInput } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

/** A small dashboard over the seeded tasks, plus a purchasing widget and some commentary. */
const spec = (extra: Partial<BiDashboardSpecInput> = {}): BiDashboardSpecInput => ({
  params: { period: { preset: "last_12_months" }, filters: [{ id: "team", label: "Team", dim: "team" }] },
  sections: [
    {
      id: "overview",
      title: "Overview",
      widgets: [
        { id: "open", type: "kpi", title: "Tasks", query: { dataset: "tasks", measures: ["task_count"] } },
        {
          id: "by_state",
          type: "bar",
          title: "By state",
          query: { dataset: "tasks", measures: ["task_count"], groupBy: [{ dim: "state_type" }] },
        },
        { id: "note", type: "text", title: "Commentary", text: "Figures are live." },
      ],
    },
  ],
  ...extra,
});

describe("BI dashboards", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let priya: { cookie: string; userId: string };
  let draftId: string;

  const req = (cookie: string, method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie, ...(json === undefined ? {} : { json }) });
  const ok = async (res: { status: number; json(): Promise<any> }, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const listIds = async (cookie: string) =>
    (await ok(await req(cookie, "GET", "/bi/dashboards"))).dashboards.map((d: { id: string }) => d.id);

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
  }, 120_000);
  afterAll(() => ctx.handle.close());

  describe("drafts", () => {
    it("lets a member save a draft that only they (and admins) can see", async () => {
      const created = await ok(
        await req(marcus.cookie, "POST", "/bi/dashboards", { title: "Ops", spec: spec() }),
        201,
      );
      draftId = created.id;
      expect(created).toMatchObject({
        status: "draft",
        version: 1,
        ownerId: marcus.userId,
        scope: "workspace",
      });
      expect(await listIds(marcus.cookie)).toContain(draftId);
      expect(await listIds(ada)).toContain(draftId);
      expect(await listIds(priya.cookie)).not.toContain(draftId);
      expect((await req(priya.cookie, "GET", `/bi/dashboards/${draftId}`)).status).toBe(404);
      expect((await ok(await req(marcus.cookie, "GET", `/bi/dashboards/${draftId}`))).canEdit).toBe(true);
    });

    it("refuses an invalid spec with the full path and the nearest field", async () => {
      const bad = spec();
      (bad.sections[0]!.widgets[1] as { query: { groupBy: { dim: string }[] } }).query.groupBy = [
        { dim: "stat_type" },
      ];
      const body = await ok(
        await req(marcus.cookie, "POST", "/bi/dashboards", { title: "Bad", spec: bad }),
        400,
      );
      expect(body.error.code).toBe("invalid_dashboard");
      expect(body.error.details.issues[0]).toMatchObject({
        path: "spec.sections[0].widgets[1].query.groupBy[0].dim",
        suggestion: "state_type",
      });
      const structural = await ok(
        await req(marcus.cookie, "POST", "/bi/dashboards", { title: "Bad", spec: { sections: [] } }),
        400,
      );
      expect(structural.error.details.issues[0].path).toBe("spec.sections");
      const dupe = spec();
      dupe.sections[0]!.widgets[1]!.id = "open";
      expect(
        (await ok(await req(marcus.cookie, "POST", "/bi/dashboards", { title: "Bad", spec: dupe }), 400))
          .error.details.issues[0].path,
      ).toBe("spec.sections[0].widgets[1].id");
      const kpi = spec();
      (kpi.sections[0]!.widgets[0] as { query: object }).query = {
        dataset: "tasks",
        measures: ["task_count"],
        groupBy: [{ dim: "team" }],
      };
      expect(
        (await ok(await req(marcus.cookie, "POST", "/bi/dashboards", { title: "Bad", spec: kpi }), 400)).error
          .details.issues[0].path,
      ).toBe("spec.sections[0].widgets[0].query.groupBy");
    });

    it("refuses widgets on data the author can't read, and module scopes they can't read", async () => {
      const purchasing = spec();
      purchasing.sections[0]!.widgets.push({
        id: "spend",
        type: "kpi",
        title: "Spend",
        query: { dataset: "purchase_orders", measures: ["order_value"] },
      });
      const body = await ok(
        await req(marcus.cookie, "POST", "/bi/dashboards", { title: "Spend", spec: purchasing }),
        400,
      );
      expect(body.error.details.issues[0].path).toBe("spec.sections[0].widgets[3].query.dataset");
      expect(
        (
          await ok(
            await req(marcus.cookie, "POST", "/bi/dashboards", {
              title: "P",
              scope: "module:purchasing",
              spec: spec(),
            }),
            403,
          )
        ).error.code,
      ).toBe("module_forbidden");
    });

    it("keeps a version per save, and refuses a stale save", async () => {
      const updated = await ok(
        await req(marcus.cookie, "PATCH", `/bi/dashboards/${draftId}`, {
          title: "Operations",
          expectedVersion: 1,
        }),
      );
      expect(updated).toMatchObject({ title: "Operations", version: 2 });
      const stale = await ok(
        await req(marcus.cookie, "PATCH", `/bi/dashboards/${draftId}`, {
          title: "Again",
          expectedVersion: 1,
        }),
        409,
      );
      expect(stale.error.code).toBe("dashboard_conflict");
      const { versions } = await ok(await req(marcus.cookie, "GET", `/bi/dashboards/${draftId}/versions`));
      expect(versions.map((v: { version: number; title: string }) => [v.version, v.title])).toEqual([
        [2, "Operations"],
        [1, "Ops"],
      ]);
    });
  });

  describe("publishing", () => {
    it("needs manage and a person (or the bi.publish toggle)", async () => {
      expect(
        (await ok(await req(marcus.cookie, "POST", `/bi/dashboards/${draftId}/publish`, {}), 403)).error.code,
      ).toBe("module_forbidden");
      const token = (
        await ok(
          await ctx.req("/v1/me/api-tokens", {
            method: "POST",
            cookie: ada,
            json: { name: "bi", scope: "write" },
          }),
          201,
        )
      ).token;
      const viaToken = await ctx.req(`${WS}/bi/dashboards/${draftId}/publish`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin: "" },
        json: {},
      });
      expect(viaToken.status).toBe(403);
      expect((await viaToken.json()).error.code).toBe("token_not_allowed");
    });

    it("shows a published dashboard to its audience only", async () => {
      await ok(
        await req(ada, "POST", `/bi/dashboards/${draftId}/publish`, {
          audience: "members",
          memberIds: [marcus.userId],
        }),
      );
      expect(await listIds(priya.cookie)).not.toContain(draftId);
      const published = await ok(
        await req(ada, "POST", `/bi/dashboards/${draftId}/publish`, { audience: "workspace" }),
      );
      expect(published).toMatchObject({ status: "published", audience: "workspace", audienceUserIds: [] });
      expect(await listIds(priya.cookie)).toContain(draftId);
      expect((await ok(await req(priya.cookie, "GET", `/bi/dashboards/${draftId}`))).canEdit).toBe(false);
      const stranger = await ok(
        await req(ada, "POST", `/bi/dashboards/${draftId}/publish`, {
          audience: "members",
          memberIds: ["00000000-0000-4000-8000-000000000000"],
        }),
        400,
      );
      expect(stranger.error.details.issues[0].path).toBe("memberIds[0]");
    });

    it("is changed only by a manager once published; others duplicate it", async () => {
      const refused = await ok(
        await req(marcus.cookie, "PATCH", `/bi/dashboards/${draftId}`, { title: "Mine" }),
        403,
      );
      expect(refused.error.message).toContain("Duplicate");
      const copy = await ok(await req(priya.cookie, "POST", `/bi/dashboards/${draftId}/duplicate`, {}), 201);
      expect(copy).toMatchObject({
        title: "Copy of Operations",
        status: "draft",
        ownerId: priya.userId,
        version: 1,
      });
      await ok(await req(ada, "PATCH", `/bi/dashboards/${draftId}`, { description: "Weekly ops review" }));
    });
  });

  describe("tokens and history", () => {
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
    const viaToken = (token: string, method: string, path: string, json?: unknown) =>
      ctx.req(`${WS}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, origin: "" },
        ...(json === undefined ? {} : { json }),
      });

    it("never lets a token change, archive or restore a published dashboard, even a manager's", async () => {
      const token = await tokenFor();
      for (const [method, path, body] of [
        ["PATCH", `/bi/dashboards/${draftId}`, { title: "Rewritten by an agent" }],
        ["POST", `/bi/dashboards/${draftId}/archive`, undefined],
        ["POST", `/bi/dashboards/${draftId}/restore`, undefined],
      ] as const) {
        const res = await viaToken(token, method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect((await res.json()).error.code).toBe("token_not_allowed");
      }
      expect((await ok(await req(ada, "GET", `/bi/dashboards/${draftId}`))).title).toBe("Operations");
    });

    it("lets a token publish and take back only with the bi.publish toggle and its own allowlist, version-checked", async () => {
      await ok(await req(ada, "PUT", "/token-actions/bi.publish", { enabled: true }));
      try {
        const withoutList = await tokenFor();
        expect((await viaToken(withoutList, "POST", `/bi/dashboards/${draftId}/unpublish`)).status).toBe(403);
        const token = await tokenFor({ tokenActions: ["bi.publish"] });
        await ok(await viaToken(token, "POST", `/bi/dashboards/${draftId}/unpublish`));
        // Back to a draft, the token may now edit it.
        const edited = await ok(
          await viaToken(token, "PATCH", `/bi/dashboards/${draftId}`, { description: "Agent edit" }),
        );
        const stale = await ok(
          await viaToken(token, "POST", `/bi/dashboards/${draftId}/publish`, {
            expectedVersion: edited.version - 1,
          }),
          409,
        );
        expect(stale.error.code).toBe("dashboard_conflict");
        await ok(
          await viaToken(token, "POST", `/bi/dashboards/${draftId}/publish`, {
            expectedVersion: edited.version,
          }),
        );
      } finally {
        await ok(await req(ada, "PUT", "/token-actions/bi.publish", { enabled: false }));
      }
    });

    it("shows version history only to people who may edit, not to the audience", async () => {
      expect((await req(priya.cookie, "GET", `/bi/dashboards/${draftId}`)).status).toBe(200);
      const refused = await ok(await req(priya.cookie, "GET", `/bi/dashboards/${draftId}/versions`), 403);
      expect(refused.error.code).toBe("dashboard_forbidden");
      await ok(await req(marcus.cookie, "GET", `/bi/dashboards/${draftId}/versions`));
    });
  });

  describe("data", () => {
    it("runs every widget as the viewer, with view parameters, and an error tile instead of a failed page", async () => {
      // Ada adds a purchasing widget; Marcus can open the dashboard but not purchasing.
      const current = await ok(await req(ada, "GET", `/bi/dashboards/${draftId}`));
      const next = structuredClone(current.spec);
      next.sections[0].widgets.push({
        id: "spend",
        type: "kpi",
        title: "Spend",
        query: { dataset: "purchase_orders", measures: ["order_value"] },
      });
      await ok(await req(ada, "PATCH", `/bi/dashboards/${draftId}`, { spec: next }));

      const asMarcus = await ok(await req(marcus.cookie, "GET", `/bi/dashboards/${draftId}/data`));
      const byId = Object.fromEntries(asMarcus.widgets.map((w: { widgetId: string }) => [w.widgetId, w]));
      expect(Object.keys(byId)).toEqual(["open", "by_state", "spend"]);
      expect(byId.open.status).toBe("ok");
      expect(byId.open.result.period).toMatchObject({ dim: "created_on" });
      expect(byId.spend).toMatchObject({ status: "no_access" });
      const asAda = await ok(await req(ada, "GET", `/bi/dashboards/${draftId}/data`));
      expect(asAda.widgets.find((w: { widgetId: string }) => w.widgetId === "spend").status).toBe("ok");

      // The viewer's period and filter values apply to every widget that has the dimension.
      const all = byId.open.result.rows[0].task_count;
      const teams = await ok(
        await req(
          ada,
          "GET",
          `/bi/query?spec=${encodeURIComponent(JSON.stringify({ dataset: "tasks", measures: ["task_count"], groupBy: [{ dim: "team" }], period: { preset: "last_12_months" } }))}`,
        ),
      );
      const team = teams.rows.find((r: { team__id: string | null }) => r.team__id);
      const params = encodeURIComponent(JSON.stringify({ filters: { team: team.team__id } }));
      const filtered = await ok(
        await req(marcus.cookie, "GET", `/bi/dashboards/${draftId}/data?params=${params}`),
      );
      expect(filtered.widgets[0].result.rows[0].task_count).toBe(team.task_count);
      expect(team.task_count).toBeLessThan(all);
      const old = encodeURIComponent(JSON.stringify({ period: { from: "2000-01-01", to: "2000-02-01" } }));
      const empty = await ok(await req(marcus.cookie, "GET", `/bi/dashboards/${draftId}/data?params=${old}`));
      expect(empty.widgets[0].result.rows[0].task_count).toBe(0);
    });
  });

  describe("sync log", () => {
    it("sends dashboards to their audience, tombstones to everyone else, and history to editors only", async () => {
      const draft = await ok(
        await req(marcus.cookie, "POST", "/bi/dashboards", { title: "Private", spec: spec() }),
        201,
      );
      const sync = async (cookie: string) =>
        (await ok(await req(cookie, "GET", "/sync?after=0&limit=1000"))).changes as Array<{
          entity: string;
          entityId: string;
          action: string;
          data: Record<string, unknown> | null;
        }>;
      const forPriya = await sync(priya.cookie);
      const privateChanges = forPriya.filter((c) => c.entityId === draft.id);
      expect(privateChanges.length).toBeGreaterThan(0);
      expect(privateChanges.every((c) => c.action === "delete" && c.data === null)).toBe(true);
      expect(
        forPriya.some((c) => c.entity === "bi_dashboard_version" && c.data?.dashboardId === draft.id),
      ).toBe(false);
      // The published one reaches her in full, without its history.
      expect(forPriya.some((c) => c.entityId === draftId && c.action === "upsert")).toBe(true);
      expect(
        forPriya.some((c) => c.entity === "bi_dashboard_version" && c.data?.dashboardId === draftId),
      ).toBe(false);
      const forMarcus = await sync(marcus.cookie);
      expect(forMarcus.some((c) => c.entityId === draft.id && c.action === "upsert")).toBe(true);
      expect(
        forMarcus.some((c) => c.entity === "bi_dashboard_version" && c.data?.dashboardId === draft.id),
      ).toBe(true);
    });
  });

  describe("templates", () => {
    const templateIds = async (cookie: string) =>
      (await ok(await req(cookie, "GET", "/bi/dashboards?template=true"))).dashboards.map(
        (d: { id: string }) => d.id,
      );

    it("saves a dashboard as a template, lists templates, and starts module drafts from one", async () => {
      const own = await ok(
        await req(priya.cookie, "POST", "/bi/dashboards", { title: "Weekly tasks", spec: spec() }),
        201,
      );
      expect(own.template).toBe(false);
      const marked = await ok(
        await req(priya.cookie, "PATCH", `/bi/dashboards/${own.id}`, { template: true, expectedVersion: 1 }),
      );
      expect(marked).toMatchObject({ template: true, version: 2 });
      expect(await templateIds(priya.cookie)).toEqual([own.id]);
      const others = await ok(await req(priya.cookie, "GET", "/bi/dashboards?template=false"));
      expect(others.dashboards.map((d: { id: string }) => d.id)).not.toContain(own.id);
      // Starting from a template keeps its title, takes the scope asked for, and is no template itself.
      const copy = await ok(
        await req(priya.cookie, "POST", `/bi/dashboards/${own.id}/duplicate`, { scope: "module:tasks" }),
        201,
      );
      expect(copy).toMatchObject({
        title: "Weekly tasks",
        scope: "module:tasks",
        template: false,
        omittedWidgets: 0,
      });
      expect(
        (await ok(await req(priya.cookie, "GET", "/bi/dashboards?scope=module:tasks"))).dashboards.map(
          (d: { id: string }) => d.id,
        ),
      ).toContain(copy.id);
      // A non-template copy is called a copy.
      expect(
        (await ok(await req(priya.cookie, "POST", `/bi/dashboards/${copy.id}/duplicate`, {}), 201)).title,
      ).toBe("Copy of Weekly tasks");
      // A draft template is its owner's: not listed for other members, nor offered to an admin.
      expect(await templateIds(marcus.cookie)).not.toContain(own.id);
      expect(await templateIds(ada)).not.toContain(own.id);
      await ok(
        await req(priya.cookie, "POST", `/bi/dashboards/${own.id}/duplicate`, { scope: "module:nope" }),
        400,
      );
    });

    it("only lets people who may edit a dashboard change its template flag", async () => {
      const own = await ok(
        await req(priya.cookie, "POST", "/bi/dashboards", { title: "Priya's", spec: spec() }),
        201,
      );
      // Another member with write, on someone else's draft; and on a published dashboard.
      expect(
        (await ok(await req(marcus.cookie, "PATCH", `/bi/dashboards/${own.id}`, { template: true }), 404))
          .error.code,
      ).toBe("not_found");
      await ok(await req(ada, "POST", `/bi/dashboards/${own.id}/publish`, {}));
      expect(
        (await ok(await req(priya.cookie, "PATCH", `/bi/dashboards/${own.id}`, { template: true }), 403))
          .error.code,
      ).toBe("dashboard_forbidden");
      // A token, even a manager's, never changes a published dashboard.
      const token = (
        await ok(
          await ctx.req("/v1/me/api-tokens", {
            method: "POST",
            cookie: ada,
            json: { name: "agent", scope: "write" },
          }),
          201,
        )
      ).token as string;
      const res = await ctx.req(`${WS}/bi/dashboards/${own.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, origin: "" },
        json: { template: true },
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("token_not_allowed");
    });

    it("offers published templates to their audience, leaves out widgets a member can't read, and hides archived ones", async () => {
      const body = spec();
      body.sections[0]!.widgets.push({
        id: "spend",
        type: "kpi",
        title: "Spend",
        query: { dataset: "purchase_orders", measures: ["order_value"] },
      });
      const template = await ok(
        await req(ada, "POST", "/bi/dashboards", { title: "Ops pack", spec: body }),
        201,
      );
      await ok(await req(ada, "PATCH", `/bi/dashboards/${template.id}`, { template: true }));
      expect(await templateIds(marcus.cookie)).not.toContain(template.id);
      await ok(await req(ada, "POST", `/bi/dashboards/${template.id}/publish`, {}));
      expect(await templateIds(marcus.cookie)).toContain(template.id);
      // Marcus can't read purchasing: his copy leaves the spend widget out instead of failing.
      const copy = await ok(
        await req(marcus.cookie, "POST", `/bi/dashboards/${template.id}/duplicate`, {}),
        201,
      );
      expect(copy.omittedWidgets).toBe(1);
      expect(copy.spec.sections[0].widgets.map((w: { id: string }) => w.id)).toEqual([
        "open",
        "by_state",
        "note",
      ]);
      // ... and he can't put a copy under a module he can't read.
      expect(
        (
          await ok(
            await req(marcus.cookie, "POST", `/bi/dashboards/${template.id}/duplicate`, {
              scope: "module:purchasing",
            }),
            403,
          )
        ).error.code,
      ).toBe("module_forbidden");
      await ok(await req(ada, "POST", `/bi/dashboards/${template.id}/archive`));
      expect(await templateIds(marcus.cookie)).not.toContain(template.id);
      expect(await templateIds(ada)).not.toContain(template.id);
    });
  });

  describe("archiving", () => {
    it("lets the owner archive a draft and hides it from the list; a manager can unpublish", async () => {
      const draft = await ok(
        await req(priya.cookie, "POST", "/bi/dashboards", { title: "Scratch", spec: spec() }),
        201,
      );
      await ok(await req(priya.cookie, "POST", `/bi/dashboards/${draft.id}/archive`));
      expect(await listIds(priya.cookie)).not.toContain(draft.id);
      const archived = await ok(await req(priya.cookie, "GET", "/bi/dashboards?archived=true"));
      expect(archived.dashboards.map((d: { id: string }) => d.id)).toContain(draft.id);
      expect((await req(priya.cookie, "POST", `/bi/dashboards/${draftId}/archive`)).status).toBe(403);
      await ok(await req(ada, "POST", `/bi/dashboards/${draftId}/unpublish`));
      expect(await listIds(priya.cookie)).not.toContain(draftId);
    });
  });
});
