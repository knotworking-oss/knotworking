import { DEFAULT_TIME_ZONE, modules, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

/**
 * Soft dependencies (`enhancedBy`): HACCP works without Items, Recipes, Stock and Production;
 * Production without Demand; Quality without Items and Stock; Site and HSE permits with the asset
 * register but without HACCP. What needs the enhancing module is
 * refused (`404 module_inactive` when it is off, `403 module_forbidden` when the caller can't read
 * it) or left out of the response; everything else works.
 */

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
const UNKNOWN = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const ccp = {
  code: "CCP1",
  processStep: "Cooking",
  hazardType: "biological",
  hazard: "Survival of vegetative pathogens",
  limitType: "range",
  limitMin: 75,
  limitUnit: "°C",
  monitoringMethod: "Probe the core",
  frequency: { every: 1, unit: "day" },
  responsibleRole: "Cook",
  correctiveAction: "Keep cooking",
  verification: "Supervisor reviews the log",
};
const complaint = {
  receivedOn: today,
  source: "consumer",
  category: "quality",
  severity: "minor",
  reportedLotCode: "L-123",
  description: "Too salty",
};
const nonconformance = {
  raisedOn: today,
  source: "process",
  severity: "minor",
  title: "Door left open",
  description: "Chiller door found open",
};

async function ok(res: Res, status = 200) {
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  return body;
}
async function refused(res: Res, status: number, code: string) {
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  expect(body.error.code).toBe(code);
}

describe("soft dependencies: the enhancing modules switched off", () => {
  let ctx: TestCtx;
  let cookie: string;
  const get = (path: string) => ctx.req(`${WS}${path}`, { cookie });
  const send = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });

  beforeAll(async () => {
    ctx = await makeApp({
      seed: true,
      activeModules: ["tasks", "docs", "assets", "haccp", "quality"],
    });
    cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx?.handle.close());

  it("lists the modules with what enhances them", async () => {
    const { modules: listed } = await ok(await get("/modules"));
    const haccp = listed.find((m: { id: string }) => m.id === "haccp");
    expect(haccp).toMatchObject({ dependsOn: ["assets"], enhancedBy: modules.haccp.enhancedBy });
    expect(listed.find((m: { id: string }) => m.id === "quality").dependsOn).toEqual([]);
    expect(listed.map((m: { id: string }) => m.id)).not.toContain("items");
  });

  describe("HACCP without items, recipes, stock or production", () => {
    let ccpId: string;

    it("keeps plans under document control, refusing only a product or recipe scope", async () => {
      await refused(
        await send("POST", "/haccp/plans", {
          code: "HACCP-S1",
          name: "Kitchen",
          draft: { scope: { itemIds: [UNKNOWN] }, ccps: [ccp] },
        }),
        404,
        "module_inactive",
      );
      const plan = await ok(
        await send("POST", "/haccp/plans", { code: "HACCP-S1", name: "Kitchen", draft: { ccps: [ccp] } }),
        201,
      );
      expect(plan.draftVersion.scope).toMatchObject({ wholeSite: true, items: [], recipes: [] });
      await refused(
        await send("PUT", `/haccp/plans/${plan.id}/draft`, { scope: { recipeIds: [UNKNOWN] }, ccps: [ccp] }),
        404,
        "module_inactive",
      );
      const approved = await ok(await send("POST", `/haccp/plans/${plan.id}/draft/approve`, {}));
      ccpId = approved.ccps[0].id;
    });

    it("records readings and corrective actions, refusing a batch or lot link", async () => {
      await refused(
        await send("POST", "/haccp/logs", { ccpId, value: 80, batchId: UNKNOWN }),
        404,
        "module_inactive",
      );
      const log = await ok(await send("POST", "/haccp/logs", { ccpId, value: 70 }), 201);
      expect(log).toMatchObject({ withinLimits: false, batch: null });
      expect(log.correctiveActions).toHaveLength(1);
      await refused(
        await send("POST", "/haccp/corrective-actions", { title: "Quarantine", lotId: UNKNOWN }),
        404,
        "module_inactive",
      );
      const action = await ok(
        await send("POST", "/haccp/corrective-actions", { title: "Retrain cooks" }),
        201,
      );
      expect(action).toMatchObject({ batch: null, lot: null });
      await refused(
        await send("PATCH", `/haccp/corrective-actions/${action.id}`, { batchId: UNKNOWN }),
        404,
        "module_inactive",
      );
      await ok(await get("/haccp/deviations"));
    });

    it("works out what's due without batches, and has no batch records", async () => {
      const due = await ok(await get("/haccp/due?include=all"));
      expect(due.batchesInProgress).toEqual([]);
      expect(due.checks.some((c: { kind: string }) => c.kind === "ccp")).toBe(true);
      expect(due.checks.every((c: { batch?: unknown }) => !c.batch)).toBe(true);
      await refused(await get(`/haccp/batches/${UNKNOWN}`), 404, "module_inactive");
    });
  });

  describe("Quality without items or stock", () => {
    it("logs and works complaints and non-conformances with no item or lot", async () => {
      const created = await ok(await send("POST", "/quality/complaints", complaint), 201);
      expect(created).toMatchObject({
        itemId: null,
        lotId: null,
        item: null,
        lot: null,
        reportedLotCode: "L-123",
      });
      await refused(
        await send("POST", "/quality/complaints", { ...complaint, itemId: UNKNOWN }),
        404,
        "module_inactive",
      );
      await refused(
        await send("PATCH", `/quality/complaints/${created.id}`, { lotId: UNKNOWN }),
        404,
        "module_inactive",
      );
      await ok(await send("PATCH", `/quality/complaints/${created.id}`, { severity: "major" }));
      const nc = await ok(await send("POST", "/quality/nonconformances", nonconformance), 201);
      expect(nc).toMatchObject({ item: null, lot: null, supplier: null });
      await refused(
        await send("POST", "/quality/nonconformances", {
          ...nonconformance,
          source: "supplier",
          supplierId: UNKNOWN,
        }),
        404,
        "module_inactive",
      );
      expect((await ok(await get("/quality/complaints"))).total).toBeGreaterThan(0);
    });

    it("plans internal audits", async () => {
      await ok(
        await send("POST", "/quality/audits", { title: "Hygiene audit", scope: "Kitchen", plannedOn: today }),
        201,
      );
      expect((await ok(await get("/quality/audits"))).audits.length).toBeGreaterThan(0);
    });

    it("hides the item- and stock-centric parts", async () => {
      const summary = await ok(await get("/quality/summary"));
      expect(summary.recallTest).toBeNull();
      expect(summary.complaints).toBeTruthy();
      await refused(await get("/quality/recall-tests"), 404, "module_inactive");
      await refused(await get(`/quality/recall-tests/prefill?lotId=${UNKNOWN}`), 404, "module_inactive");
      await refused(await get("/quality/authenticity"), 404, "module_inactive");
      await refused(await get("/quality/trends"), 404, "module_inactive");
      await refused(await get("/quality/sales-volumes"), 404, "module_inactive");
      await refused(await get(`/quality/suppliers/${UNKNOWN}`), 404, "module_inactive");
    });
  });
});

describe("soft dependencies: production without demand", () => {
  let ctx: TestCtx;
  let cookie: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, activeModules: ["items", "recipes", "stock", "production"] });
    cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx?.handle.close());

  it("schedules and reports without demand, and refuses only planning from demand", async () => {
    const get = (path: string) => ctx.req(`${WS}${path}`, { cookie });
    await ok(await get("/production/batches"));
    const daily = await ok(await get("/production/daily-demand"));
    expect(daily.basis).toMatchObject({ weeklyDemand: false, stock: true });
    await refused(await get("/production/plan-from-demand"), 404, "module_inactive");
  });
});

describe("soft dependencies: site with the asset register but without HACCP", () => {
  let ctx: TestCtx;
  let cookie: string;
  const get = (path: string) => ctx.req(`${WS}${path}`, { cookie });
  const send = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, activeModules: ["tasks", "docs", "assets", "site"] });
    cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx?.handle.close());

  it("keeps areas, registers and planned maintenance on assets, and leaves calibration out", async () => {
    const { modules: listed } = await ok(await get("/modules"));
    expect(listed.find((m: { id: string }) => m.id === "site")).toMatchObject({
      dependsOn: ["assets"],
      enhancedBy: expect.arrayContaining(["haccp"]),
    });
    const area = await ok(await send("POST", "/assets", { kind: "area", code: "KIT", name: "Kitchen" }), 201);
    const oven = await ok(
      await send("POST", "/assets", { kind: "equipment", name: "Oven", parentAreaId: area.id }),
      201,
    );
    expect((await ok(await get("/site/areas"))).areas.map((a: { id: string }) => a.id)).toEqual([area.id]);
    await ok(
      await send("POST", "/site/glass/items", {
        areaId: area.id,
        kind: "glass",
        description: "Window",
        checkFrequency: { every: 1, unit: "month" },
      }),
      201,
    );
    const task = await ok(
      await send("POST", "/site/maintenance/tasks", {
        assetId: oven.id,
        title: "Clean the fan",
        frequency: { every: 1, unit: "month" },
        clearanceRequired: true,
      }),
      201,
    );
    expect(task.asset).toMatchObject({ id: oven.id, area: { id: area.id } });
    const { assets } = await ok(await get("/site/maintenance/assets"));
    expect(assets.find((a: { id: string }) => a.id === oven.id)).toMatchObject({
      areaId: area.id,
      calibrationInstrument: null,
    });
    await refused(await get("/site/calibration-instruments"), 404, "module_inactive");
    await refused(
      await send("PATCH", `/site/maintenance/assets/${oven.id}`, { calibrationInstrumentId: null }),
      404,
      "module_inactive",
    );
    await refused(await get("/haccp/assets"), 404, "module_inactive");
    await ok(await get("/site/due"));
  });
});

describe("soft dependencies: active but not readable", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: string;
  let itemId: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const marcusId = (await ok(await ctx.req("/v1/me", { cookie: marcus }))).user.id;
    for (const [module, level] of [
      ["quality", "write"],
      ["haccp", "write"],
      ["assets", "read"],
      ["items", "none"],
      ["stock", "none"],
      ["production", "none"],
    ] as const) {
      await ok(
        await ctx.req(`${WS}/members/${marcusId}/module-access/${module}`, {
          method: "PUT",
          cookie: ada,
          json: { level },
        }),
      );
    }
    itemId = (
      await ok(
        await as(ada).send("POST", "/items", { code: "SOUP", name: "Soup", type: "finished", unit: "l" }),
        201,
      )
    ).id;
  }, 60_000);
  afterAll(() => ctx?.handle.close());

  it("opens quality and haccp to a member who can't read items, stock or production", async () => {
    const { modules: listed } = await ok(await as(marcus).get("/modules"));
    const level = (id: string) => listed.find((m: { id: string }) => m.id === id)?.access;
    expect(level("quality")).toBe("write");
    expect(level("haccp")).toBe("write");
    expect(level("items")).toBe("none");
  });

  it("hides an item linked to a complaint and refuses linking one", async () => {
    const linked = await ok(await as(ada).send("POST", "/quality/complaints", { ...complaint, itemId }), 201);
    expect(linked.item).not.toBeNull();
    const seen = await ok(await as(marcus).get(`/quality/complaints/${linked.id}`));
    expect(seen).toMatchObject({ itemId, item: null });
    await refused(
      await as(marcus).send("POST", "/quality/complaints", { ...complaint, itemId }),
      403,
      "module_forbidden",
    );
    await refused(await as(marcus).get("/quality/recall-tests"), 403, "module_forbidden");
  });

  it("hides a plan's product scope, and lets the member keep but not widen it", async () => {
    const plan = await ok(
      await as(ada).send("POST", "/haccp/plans", {
        code: "HACCP-S2",
        name: "Products",
        draft: { scope: { itemIds: [itemId] }, ccps: [ccp] },
      }),
      201,
    );
    const seen = await ok(await as(marcus).get(`/haccp/plans/${plan.id}`));
    expect(seen.draftVersion.scope).toMatchObject({ itemIds: [itemId], items: [], wholeSite: false });
    await ok(
      await as(marcus).send("PUT", `/haccp/plans/${plan.id}/draft`, {
        scope: { itemIds: [itemId] },
        ccps: [ccp],
      }),
    );
    await refused(
      await as(marcus).send("PUT", `/haccp/plans/${plan.id}/draft`, {
        scope: { itemIds: [itemId, UNKNOWN] },
        ccps: [ccp],
      }),
      403,
      "module_forbidden",
    );
    const due = await ok(await as(marcus).get("/haccp/due?include=all"));
    expect(due.batchesInProgress).toEqual([]);
  });
});
