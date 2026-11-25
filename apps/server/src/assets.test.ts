import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("assets module", () => {
  let ctx: TestCtx;
  let ada: string; // admin
  let marcus: { cookie: string; userId: string }; // member
  let agentToken: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${agentToken}`, origin: "" }, json });
  const grant = (moduleId: string, level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
  const ok = async (res: Awaited<ReturnType<TestCtx["req"]>>, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const error = async (res: Awaited<ReturnType<TestCtx["req"]>>, status: number) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body.error.code as string;
  };

  let hall: string;
  let van: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    agentToken = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write" },
        })
      ).json()
    ).token as string;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("is opt-in for members: read lists, write adds, manage archives", async () => {
    expect(await error(await as(marcus.cookie).get("/assets"), 403)).toBe("module_forbidden");
    await grant("assets", "read");
    await ok(await as(marcus.cookie).get("/assets"));
    expect(
      await error(await as(marcus.cookie).send("POST", "/assets", { kind: "tool", name: "Drill" }), 403),
    ).toBe("module_forbidden");
    await grant("assets", "write");
    hall = (
      await ok(
        await as(marcus.cookie).send("POST", "/assets", { kind: "area", code: "HALL", name: "Packing hall" }),
        201,
      )
    ).id;
    expect(await error(await as(marcus.cookie).send("POST", `/assets/${hall}/archive`), 403)).toBe(
      "module_forbidden",
    );
  });

  it("keeps one register of every kind, with make, purchase, warranty and custodian", async () => {
    const created = await ok(
      await as(ada).send("POST", "/assets", {
        kind: "vehicle",
        code: "VAN-1",
        name: "Delivery van",
        parentAreaId: hall,
        manufacturer: "Ford",
        model: "Transit",
        serialNumber: "WF0XXXTTGXKA12345",
        purchasedOn: "2024-03-01",
        purchaseCost: 28500.5,
        warrantyExpiresOn: "2027-03-01",
        custodianId: marcus.userId,
        notes: "Keys in the office",
      }),
      201,
    );
    van = created.id;
    expect(created).toMatchObject({
      kind: "vehicle",
      status: "active",
      revision: 1,
      purchaseCost: 28500.5,
      parentArea: { id: hall, name: "Packing hall" },
      custodianName: expect.any(String),
    });
    expect(created).not.toHaveProperty("workspaceId");
    const area = await ok(await as(ada).get(`/assets/${hall}`));
    expect(area.assetsInside).toBe(1);
  });

  it("refuses a used code, a parent that isn't an area, a loop and a stranger as custodian", async () => {
    expect(
      await error(await as(ada).send("POST", "/assets", { kind: "tool", name: "X", code: "van-1" }), 409),
    ).toBe("code_taken");
    expect(
      await error(await as(ada).send("POST", "/assets", { kind: "tool", name: "X", parentAreaId: van }), 404),
    ).toBe("not_found");
    const inner = (
      await ok(
        await as(ada).send("POST", "/assets", { kind: "area", name: "Cold room", parentAreaId: hall }),
        201,
      )
    ).id;
    expect(await error(await as(ada).send("PATCH", `/assets/${hall}`, { parentAreaId: inner }), 400)).toBe(
      "invalid_input",
    );
    expect(await error(await as(ada).send("PATCH", `/assets/${hall}`, { parentAreaId: hall }), 400)).toBe(
      "invalid_input",
    );
    expect(
      await error(
        await as(ada).send("POST", "/assets", {
          kind: "tool",
          name: "X",
          custodianId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
        }),
        400,
      ),
    ).toBe("invalid_input");
  });

  it("updates with an optional revision check; an area stays an area", async () => {
    const updated = await ok(
      await as(ada).send("PATCH", `/assets/${van}`, { name: "Van 1", expectedRevision: 1 }),
    );
    expect(updated).toMatchObject({ name: "Van 1", revision: 2 });
    expect(
      await error(await as(ada).send("PATCH", `/assets/${van}`, { name: "Van", expectedRevision: 1 }), 409),
    ).toBe("asset_changed");
    expect(await ok(await as(ada).send("PATCH", `/assets/${van}`, { kind: "equipment" }))).toMatchObject({
      kind: "equipment",
    });
    expect(await error(await as(ada).send("PATCH", `/assets/${hall}`, { kind: "equipment" }), 409)).toBe(
      "kind_fixed",
    );
    expect(await error(await as(ada).send("PATCH", `/assets/${van}`, { kind: "area" }), 409)).toBe(
      "kind_fixed",
    );
  });

  it("keeps equipment with HACCP schedules or history in the register", async () => {
    const instrument = await ok(
      await as(ada).send("POST", "/assets", { kind: "equipment", name: "Probe" }),
      201,
    );
    const path = `/assets/${instrument.id}`;
    const schedule = `/haccp/assets/${instrument.id}`;
    await ok(await as(ada).send("PATCH", schedule, { cleaningFrequency: { every: 1, unit: "day" } }));
    expect(await error(await as(ada).send("PATCH", path, { kind: "tool" }), 409)).toBe("kind_fixed");
    await ok(await as(ada).send("POST", "/haccp/cleaning", { assetId: instrument.id }), 201);
    await ok(await as(ada).send("PATCH", schedule, { cleaningFrequency: null }));
    expect(await error(await as(ada).send("PATCH", path, { kind: "tool" }), 409)).toBe("kind_fixed");
  });

  it("rejects reparenting below a descendant beyond fifty levels", async () => {
    const root = await ok(await as(ada).send("POST", "/assets", { kind: "area", name: "Deep root" }), 201);
    let parent = root.id as string;
    for (let level = 0; level < 51; level++) {
      const area = await ok(
        await as(ada).send("POST", "/assets", {
          kind: "area",
          name: `Nested area ${level}`,
          parentAreaId: parent,
        }),
        201,
      );
      parent = area.id;
    }
    expect(
      await error(await as(ada).send("PATCH", `/assets/${root.id}`, { parentAreaId: parent }), 400),
    ).toBe("invalid_input");
  });

  it("lists by kind, area, status and text, a page at a time", async () => {
    await ok(
      await as(ada).send("POST", "/assets", { kind: "it", name: "Office laptop", serialNumber: "SN-777" }),
      201,
    );
    const byKind = await ok(await as(ada).get("/assets?kind=it"));
    expect(byKind.assets.map((a: { name: string }) => a.name)).toEqual(["Office laptop"]);
    const byText = await ok(await as(ada).get("/assets?q=sn-7"));
    expect(byText.assets.map((a: { name: string }) => a.name)).toEqual(["Office laptop"]);
    // `%` is literal in a search.
    expect((await ok(await as(ada).get("/assets?q=%25"))).assets).toEqual([]);
    const inHall = await ok(await as(ada).get(`/assets?areaId=${hall}`));
    expect(inHall.assets.map((a: { id: string }) => a.id)).toContain(van);
    const paged = await ok(await as(ada).get("/assets?limit=1&offset=1"));
    expect(paged).toMatchObject({ limit: 1, offset: 1 });
    expect(paged.assets).toHaveLength(1);
    expect(paged.total).toBeGreaterThanOrEqual(4);
  });

  it("archives and restores (manage); archived assets leave the default list", async () => {
    await grant("assets", "manage");
    expect(await ok(await as(marcus.cookie).send("POST", `/assets/${van}/archive`))).toMatchObject({
      status: "archived",
    });
    expect((await ok(await as(ada).get("/assets"))).assets.map((a: { id: string }) => a.id)).not.toContain(
      van,
    );
    expect(
      (await ok(await as(ada).get("/assets?status=archived"))).assets.map((a: { id: string }) => a.id),
    ).toEqual([van]);
    expect(await ok(await as(marcus.cookie).send("POST", `/assets/${van}/restore`))).toMatchObject({
      status: "active",
    });
    await grant("assets", "write");
  });

  it("lets an agent keep the register", async () => {
    const tool = await ok(await viaToken("POST", "/assets", { kind: "tool", name: "Torque wrench" }), 201);
    expect(await ok(await viaToken("PATCH", `/assets/${tool.id}`, { code: "TW-1" }))).toMatchObject({
      code: "TW-1",
    });
  });

  it("syncs metadata only, and nothing to members without access", async () => {
    const changes = async (cookie: string) =>
      (await ok(await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie }))).changes.filter(
        (c: { entity: string }) => c.entity === "asset",
      );
    const seen = await changes(ada);
    expect(seen.length).toBeGreaterThan(0);
    for (const c of seen) {
      expect(Object.keys(c.data).sort()).toEqual(
        ["code", "id", "kind", "name", "parentAreaId", "revision", "status", "updatedAt"].sort(),
      );
    }
    await grant("assets", null);
    expect(await changes(marcus.cookie)).toEqual([]);
    await grant("assets", "write");
  });

  it("answers 404 when the module is switched off", async () => {
    const off = await makeApp({ seed: true, activeModules: ["tasks", "docs"] });
    try {
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const res = await off.req(`${WS}/assets`, { cookie });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("module_inactive");
    } finally {
      await off.handle.close();
    }
  }, 60_000);
});
