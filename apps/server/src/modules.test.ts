import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { moduleOfRoute, workspaceSubPath } from "./modules/routes";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const json = async (res: { json(): Promise<any> }) => res.json();

describe("module route table", () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await makeApp({ seed: false });
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("classifies every registered workspace route", () => {
    const unclassified = [
      ...new Set(
        ctx.app.routes
          .filter((r) => r.method !== "ALL")
          .map((r) => workspaceSubPath(r.path))
          .filter((sub): sub is string => sub !== null && !moduleOfRoute(sub)),
      ),
    ];
    expect(
      unclassified,
      `Workspace route(s) with no owning module; add a rule in apps/server/src/modules/routes.ts:\n  ${unclassified.join("\n  ")}`,
    ).toEqual([]);
  });

  it("puts nested time routes in the time module, not tasks", () => {
    expect(moduleOfRoute("/tasks/:id/timer")).toBe("time");
    expect(moduleOfRoute("/tasks/:id/time-entries")).toBe("time");
    expect(moduleOfRoute("/projects/:id/time")).toBe("time");
    expect(moduleOfRoute("/tasks/:id/comments")).toBe("tasks");
    expect(moduleOfRoute("/teams/:id/states")).toBe("tasks");
    expect(moduleOfRoute("/teams/:id/members")).toBe("platform");
    expect(moduleOfRoute("/nope")).toBeUndefined();
  });
});

describe("environment activation", () => {
  let ctx: TestCtx;
  let ada: string;
  beforeAll(async () => {
    ctx = await makeApp({ seed: true, activeModules: ["docs"] });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("answers 404 module_inactive on an inactive module's routes, even for the owner", async () => {
    for (const path of [
      "tasks",
      "projects",
      "customers",
      "despatch",
      "sales",
      "time-report?from=2026-01-01&to=2026-01-31",
      "meetings/x",
    ]) {
      const res = await ctx.req(`/v1/workspaces/acme/${path}`, { cookie: ada });
      expect(res.status, path).toBe(404);
      expect((await json(res)).error.code, path).toBe("module_inactive");
    }
    const write = await ctx.req("/v1/workspaces/acme/tasks", { method: "POST", cookie: ada, json: {} });
    expect(write.status).toBe(404);
  });

  it("shuts the connected-calendar routes with the calendar module", async () => {
    const res = await ctx.req("/v1/calendar/connections", { cookie: ada });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("module_inactive");
  });

  it("keeps active modules working and lists only them", async () => {
    expect((await ctx.req("/v1/workspaces/acme/documents", { cookie: ada })).status).toBe(200);
    const { modules } = await json(await ctx.req("/v1/workspaces/acme/modules", { cookie: ada }));
    expect(modules.map((m: { id: string }) => m.id)).toEqual(["docs"]);
  });

  it("leaves inactive modules out of the bootstrap, the sync log and search", async () => {
    const boot = await json(await ctx.req("/v1/workspaces/acme/bootstrap", { cookie: ada }));
    expect(boot.documents.length).toBeGreaterThan(0);
    expect(boot.tasks).toEqual([]);
    expect(boot.projects).toEqual([]);
    expect(boot.timeEntries).toEqual([]);
    expect(boot.meetings).toEqual([]);
    expect(boot.users.length).toBeGreaterThan(0);
    const sync = await json(await ctx.req("/v1/workspaces/acme/sync?after=0&limit=1000", { cookie: ada }));
    const entities = new Set(sync.changes.map((c: { entity: string }) => c.entity));
    for (const hidden of ["task", "project", "label", "workflow_state", "time_entry", "meeting", "comment"])
      expect(entities.has(hidden), hidden).toBe(false);
    const found = await json(await ctx.req("/v1/workspaces/acme/search?q=a", { cookie: ada }));
    expect(found.tasks).toEqual([]);
  });
});

describe("member module access", () => {
  let ctx: TestCtx;
  let ada: string;
  let member: { cookie: string; userId: string };
  let guest: { cookie: string; userId: string };
  const setLevel = (userId: string, moduleId: string, level: string | null, cookie = ada) =>
    ctx.req(`/v1/workspaces/acme/members/${userId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie,
      json: { level },
    });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await json(await ctx.req("/v1/workspaces/acme/members", { cookie: ada }));
    const others = members.filter((m: { role: string }) => m.role === "member");
    const login = async (m: { userId: string; email: string }) => ({
      userId: m.userId,
      cookie: (await signIn(ctx, m.email)).cookie,
    });
    member = await login(others[0]);
    // The seed has no guest: demote a second member.
    const demoted = await ctx.req(`/v1/workspaces/acme/members/${others[1].userId}`, {
      method: "PATCH",
      cookie: ada,
      json: { role: "guest" },
    });
    expect(demoted.status).toBe(200);
    guest = await login(others[1]);
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("defaults to the role: members write, guests read, admins manage", async () => {
    const level = async (cookie: string) =>
      Object.fromEntries(
        (await json(await ctx.req("/v1/workspaces/acme/modules", { cookie }))).modules.map(
          (m: { id: string; access: string }) => [m.id, m.access],
        ),
      );
    expect(await level(ada)).toEqual({
      tasks: "manage",
      docs: "manage",
      time: "manage",
      calendar: "manage",
      assets: "manage",
      maintenance: "manage",
      checklists: "manage",
      items: "manage",
      food_items: "manage",
      recipes: "manage",
      sops: "manage",
      stock: "manage",
      customers: "manage",
      despatch: "manage",
      sales: "manage",
      demand: "manage",
      production: "manage",
      haccp: "manage",
      people: "manage",
      training: "manage",
      attendance: "manage",
      quality: "manage",
      purchasing: "manage",
      costing: "manage",
      site: "manage",
      labels: "manage",
      specifications: "manage",
      testing: "manage",
      npd: "manage",
      defence: "manage",
      governance: "manage",
      hse: "manage",
      hse_incidents: "manage",
      assistant: "manage",
      accounting: "manage",
      workforce: "manage",
      workforce_hr: "manage",
      bi: "manage",
      purchase_requests: "manage",
      client_services: "manage",
      crm: "manage",
    });
    // New modules are opt-in: members have nothing until an admin grants it.
    expect((await level(member.cookie)).items).toBe("none");
    expect((await level(member.cookie)).tasks).toBe("write");
    expect((await level(guest.cookie)).tasks).toBe("read");
    // Dashboards follow the role, by default.
    expect((await level(member.cookie)).bi).toBe("write");
    expect((await level(guest.cookie)).bi).toBe("read");
  });

  it("only lets admins read or change module access", async () => {
    expect(
      (await ctx.req("/v1/workspaces/acme/members/module-access", { cookie: member.cookie })).status,
    ).toBe(403);
    expect((await setLevel(member.userId, "docs", "manage", member.cookie)).status).toBe(403);
    const list = await json(await ctx.req("/v1/workspaces/acme/members/module-access", { cookie: ada }));
    expect(list.modules.map((m: { id: string }) => m.id)).toEqual([
      "tasks",
      "docs",
      "time",
      "calendar",
      "assets",
      "maintenance",
      "checklists",
      "items",
      "food_items",
      "recipes",
      "sops",
      "stock",
      "customers",
      "despatch",
      "sales",
      "demand",
      "production",
      "haccp",
      "people",
      "training",
      "attendance",
      "quality",
      "purchasing",
      "costing",
      "site",
      "labels",
      "specifications",
      "testing",
      "npd",
      "defence",
      "governance",
      "hse",
      "hse_incidents",
      "assistant",
      "accounting",
      "workforce",
      "workforce_hr",
      "bi",
      "purchase_requests",
      "client_services",
      "crm",
    ]);
    const row = list.members.find((m: { userId: string }) => m.userId === member.userId);
    expect(row.access.docs).toEqual({ grant: null, effective: "write" });
  });

  it("changes workspace activation without deleting data or rewriting member grants", async () => {
    const base = "/v1/workspaces/acme";
    const patch = (modules: string[] | null, cookie = ada) =>
      ctx.req(`${base}/module-settings`, { method: "PATCH", cookie, json: { modules } });
    const before = await json(await ctx.req(`${base}/bootstrap`, { cookie: ada }));
    expect(before.tasks.length).toBeGreaterThan(0);
    expect((await json(await ctx.req(`${base}/module-settings`, { cookie: ada }))).followsServer).toBe(true);
    expect((await patch(["docs"], member.cookie)).status).toBe(403);
    expect((await patch(["time"])).status).toBe(400);

    await setLevel(member.userId, "items", "read");
    try {
      expect((await patch(["docs"])).status).toBe(200);
      const inactive = await ctx.req(`${base}/tasks`, { cookie: ada });
      expect(inactive.status).toBe(404);
      expect((await json(inactive)).error.code).toBe("module_inactive");
      const hidden = await json(await ctx.req(`${base}/bootstrap`, { cookie: ada }));
      expect(hidden.tasks).toEqual([]);
      expect(hidden.modules.map((m: { id: string }) => m.id)).toEqual(["docs"]);
      const changes = await json(
        await ctx.req(`${base}/sync?after=${before.cursor}`, { cookie: member.cookie }),
      );
      expect(changes.changes).toEqual(
        expect.arrayContaining([expect.objectContaining({ entity: "workspace_modules" })]),
      );
      expect((await ctx.req(`${base}/items`, { cookie: member.cookie })).status).toBe(404);

      expect((await patch(null)).status).toBe(200);
      const restored = await json(await ctx.req(`${base}/bootstrap`, { cookie: ada }));
      expect(restored.tasks).toEqual(before.tasks);
      expect((await ctx.req(`${base}/items`, { cookie: member.cookie })).status).toBe(200);
    } finally {
      await patch(null);
      await setLevel(member.userId, "items", null);
    }
  });

  it("refuses to edit admins, to give guests write, and unknown modules", async () => {
    const me = (await json(await ctx.req("/v1/me", { cookie: ada }))).user.id;
    expect((await json(await setLevel(me, "docs", "none"))).error.code).toBe("always_full_access");
    expect((await json(await setLevel(guest.userId, "docs", "write"))).error.code).toBe("guest_read_only");
    expect((await setLevel(member.userId, "nonexistent", "read")).status).toBe(404);
    expect((await setLevel(member.userId, "docs", "everything")).status).toBe(400);
  });

  it("read-only access blocks writes; none blocks the module and hides its data everywhere", async () => {
    expect((await setLevel(member.userId, "docs", "read")).status).toBe(200);
    expect((await ctx.req("/v1/workspaces/acme/documents", { cookie: member.cookie })).status).toBe(200);
    const write = await ctx.req("/v1/workspaces/acme/documents", {
      method: "POST",
      cookie: member.cookie,
      json: { title: "Nope" },
    });
    expect(write.status).toBe(403);
    expect((await json(write)).error.code).toBe("module_forbidden");

    const before = await json(await ctx.req("/v1/workspaces/acme/bootstrap", { cookie: member.cookie }));
    expect(before.tasks.length).toBeGreaterThan(0);

    const res = await setLevel(member.userId, "tasks", "none");
    expect(await json(res)).toMatchObject({ moduleId: "tasks", grant: "none", effective: "none" });

    for (const path of [
      "tasks",
      "projects",
      `tasks/${before.tasks[0].id}`,
      `tasks/${before.tasks[0].id}/attachments`,
    ]) {
      const blocked = await ctx.req(`/v1/workspaces/acme/${path}`, { cookie: member.cookie });
      expect(blocked.status, path).toBe(403);
      expect((await json(blocked)).error.code, path).toBe("module_forbidden");
    }
    // Time depends on tasks, so it closes too.
    expect(
      (
        await ctx.req(`/v1/workspaces/acme/tasks/${before.tasks[0].id}/time-entries`, {
          cookie: member.cookie,
        })
      ).status,
    ).toBe(403);

    const boot = await json(await ctx.req("/v1/workspaces/acme/bootstrap", { cookie: member.cookie }));
    expect(boot.tasks).toEqual([]);
    expect(boot.projects).toEqual([]);
    expect(boot.timeEntries).toEqual([]);
    expect(boot.documents.length).toBeGreaterThan(0);
    expect(boot.modules.find((m: { id: string }) => m.id === "tasks").access).toBe("none");
    expect(boot.modules.find((m: { id: string }) => m.id === "time").access).toBe("none");

    // Someone else writes a task: the member's sync feed must not carry it, but the cursor moves on.
    const team = before.teams[0].id;
    const created = await ctx.req("/v1/workspaces/acme/tasks", {
      method: "POST",
      cookie: ada,
      json: { title: "Secret launch plan", teamId: team },
    });
    expect(created.status).toBe(201);
    const sync = await json(
      await ctx.req(`/v1/workspaces/acme/sync?after=${before.cursor}`, { cookie: member.cookie }),
    );
    expect(sync.changes.some((c: { entity: string }) => c.entity === "task")).toBe(false);
    expect(BigInt(sync.cursor)).toBeGreaterThan(BigInt(before.cursor));
    // …but it does carry their own access change, so the client knows to reload.
    expect(
      sync.changes.some(
        (c: { entity: string; data: { userId: string; moduleId: string; level: string } }) =>
          c.entity === "module_access" && c.data.userId === member.userId && c.data.level === "none",
      ),
    ).toBe(true);

    const found = await json(
      await ctx.req("/v1/workspaces/acme/search?q=Secret%20launch", { cookie: member.cookie }),
    );
    expect(found.tasks).toEqual([]);
    const adaFound = await json(
      await ctx.req("/v1/workspaces/acme/search?q=Secret%20launch", { cookie: ada }),
    );
    expect(adaFound.tasks.length).toBe(1);
  });

  it("clearing a grant returns to the role default", async () => {
    const res = await json(await setLevel(member.userId, "tasks", null));
    expect(res).toMatchObject({ grant: null, effective: "write" });
    expect((await ctx.req("/v1/workspaces/acme/tasks", { cookie: member.cookie })).status).toBe(200);
  });

  it("applies to API tokens: a token acts with its owner's module access", async () => {
    const minted = await json(
      await ctx.req("/v1/me/api-tokens", {
        method: "POST",
        cookie: member.cookie,
        json: { name: "t", scope: "write" },
      }),
    );
    const headers = { authorization: `Bearer ${minted.token}`, origin: "" };
    expect((await ctx.req("/v1/workspaces/acme/documents", { headers })).status).toBe(200);
    await setLevel(member.userId, "docs", "none");
    const blocked = await ctx.req("/v1/workspaces/acme/documents", { headers });
    expect(blocked.status).toBe(403);
    expect((await json(blocked)).error.code).toBe("module_forbidden");
    await setLevel(member.userId, "docs", null);
  });

  it("limits a token to its module allowlist, even for an owner, and closes dependants", async () => {
    const mint = async (modules: string[] | undefined) =>
      (
        await json(
          await ctx.req("/v1/me/api-tokens", {
            method: "POST",
            cookie: ada,
            json: { name: "scoped", scope: "write", modules },
          }),
        )
      ).token as string;
    const levels = async (token: string) =>
      Object.fromEntries(
        (
          await json(
            await ctx.req("/v1/workspaces/acme/modules", {
              headers: { authorization: `Bearer ${token}`, origin: "" },
            }),
          )
        ).modules.map((m: { id: string; access: string }) => [m.id, m.access]),
      );
    expect(await levels(await mint(undefined))).toMatchObject({ tasks: "manage", docs: "manage" });
    const docsOnly = await mint(["docs"]);
    expect(await levels(docsOnly)).toEqual({
      tasks: "none",
      docs: "manage",
      time: "none",
      calendar: "none",
      assets: "none",
      maintenance: "none",
      checklists: "none",
      items: "none",
      food_items: "none",
      recipes: "none",
      sops: "none",
      stock: "none",
      customers: "none",
      despatch: "none",
      sales: "none",
      demand: "none",
      production: "none",
      haccp: "none",
      people: "none",
      training: "none",
      attendance: "none",
      quality: "none",
      purchasing: "none",
      costing: "none",
      site: "none",
      labels: "none",
      specifications: "none",
      testing: "none",
      npd: "none",
      defence: "none",
      governance: "none",
      hse: "none",
      hse_incidents: "none",
      assistant: "none",
      accounting: "none",
      workforce: "none",
      workforce_hr: "none",
      bi: "none",
      purchase_requests: "none",
      client_services: "none",
      crm: "none",
    });
    const headers = { authorization: `Bearer ${docsOnly}`, origin: "" };
    expect((await ctx.req("/v1/workspaces/acme/documents", { headers })).status).toBe(200);
    const blocked = await ctx.req("/v1/workspaces/acme/tasks", { headers });
    expect(blocked.status).toBe(403);
    expect((await json(await ctx.req("/v1/workspaces/acme/bootstrap", { headers }))).tasks).toEqual([]);
    // time needs tasks: a token for time alone can't use it.
    expect((await levels(await mint(["time"]))).time).toBe("none");
    const bad = await ctx.req("/v1/me/api-tokens", {
      method: "POST",
      cookie: ada,
      json: { name: "x", scope: "read", modules: ["nope"] },
    });
    expect(bad.status).toBe(400);
  });
});
