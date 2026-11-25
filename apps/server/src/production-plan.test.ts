import { addDays, addWeeks, DEFAULT_TIME_ZONE, formatWeek, todayInZone, weekStart } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const W0 = weekStart(todayInZone(DEFAULT_TIME_ZONE));
const W1 = addWeeks(W0, 1);

/** Production → plan batches from demand: the proposal (`GET`) and creating batches from it (`POST`). */
describe("production: planning batches from demand", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let writeToken: string;
  let readToken: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (token: string, method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
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
  const mint = async (scope: "read" | "write") =>
    (
      await ok(
        await ctx.req("/v1/me/api-tokens", { method: "POST", cookie: ada, json: { name: scope, scope } }),
        201,
      )
    ).token as string;
  const proposal = async (query = "", cookie = ada) =>
    ok(await as(cookie).get(`/production/plan-from-demand?from=${W0}&to=${W1}${query}`));
  type Row = { item: { code: string }; [key: string]: any };
  const rowOf = (plan: { rows: Row[] }, code: string) => plan.rows.find((r) => r.item.code === code)!;
  const batchCount = async () =>
    (await ok(await as(ada).get("/production/batches?limit=200"))).total as number;

  // Fixtures.
  let cakeRecipe: string; // 12 cakes a batch, approved
  let pieA: string; // 4 pies a batch, approved
  let pieB: string; // 6 pies a batch, approved
  let soupRecipe: string; // draft only
  let existing: { id: string; batchCode: string };

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    writeToken = await mint("write");
    readToken = await mint("read");

    const item = async (body: object) => (await ok(await as(ada).send("POST", "/items", body), 201)).id;
    const flour = await item({ code: "FLR", name: "Flour", type: "ingredient", unit: "kg" });
    const cake = await item({ code: "CAKE", name: "Cake", type: "finished", unit: "each", unitWeightG: 450 });
    const pie = await item({ code: "PIE", name: "Pie", type: "finished", unit: "each" });
    const soup = await item({ code: "SOUP", name: "Soup", type: "finished", unit: "l" });
    await item({ code: "BREAD", name: "Bread", type: "finished", unit: "each" });

    const recipe = async (code: string, outputItemId: string, yieldQuantity: number, approve = true) => {
      const r = await ok(
        await as(ada).send("POST", "/recipes", {
          code,
          name: code,
          outputItemId,
          draft: {
            yieldQuantity,
            yieldUnit: "each",
            lines: [{ itemId: flour, quantity: 1, unit: "kg" }],
          },
        }),
        201,
      );
      if (approve) await ok(await as(ada).send("POST", `/recipes/${r.id}/draft/approve`));
      return r.id as string;
    };
    cakeRecipe = await recipe("R-CAKE", cake, 12);
    pieA = await recipe("R-PIE-A", pie, 4);
    pieB = await recipe("R-PIE-B", pie, 6);
    soupRecipe = await ok(
      await as(ada).send("POST", "/recipes", {
        code: "R-SOUP",
        name: "Soup",
        outputItemId: soup,
        draft: { yieldQuantity: 40, yieldUnit: "l", lines: [{ itemId: flour, quantity: 1, unit: "kg" }] },
      }),
      201,
    ).then((r) => r.id);

    await ok(
      await as(ada).send("PUT", "/demand/lines", {
        lines: [
          { itemCode: "CAKE", period: W0, quantity: 30 },
          { itemCode: "CAKE", period: W1, quantity: 20, customer: "Shop" },
          { itemCode: "CAKE", period: W1, quantity: 5, customer: "Online" },
          { itemCode: "PIE", period: formatWeek(W1), quantity: 10 },
          { itemCode: "SOUP", period: W0, quantity: 50 },
          { itemCode: "BREAD", period: W0, quantity: 5 },
        ],
      }),
    );
    // One batch of cakes is already planned this week, and a cancelled one doesn't count.
    existing = await ok(
      await as(ada).send("POST", "/production/batches", {
        recipeId: cakeRecipe,
        plannedOn: addDays(W0, 2),
        batches: 1,
      }),
      201,
    );
    const cancelled = await ok(
      await as(ada).send("POST", "/production/batches", { recipeId: cakeRecipe, plannedOn: W0, batches: 5 }),
      201,
    );
    await ok(
      await as(ada).send("POST", `/production/batches/${cancelled.id}/cancel`, { reason: "Line down" }),
    );
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("the proposal", () => {
    it("shows demand, what is planned, the gap and whole batches per item and week", async () => {
      const plan = await proposal();
      expect(plan.from).toBe(W0);
      expect(plan.to).toBe(W1);
      expect(plan.weeks.map((w: { periodStart: string }) => w.periodStart)).toEqual([W0, W1]);
      expect(plan.rows.map((r: Row) => r.item.code)).toEqual(["BREAD", "CAKE", "PIE", "SOUP"]);

      const cake = rowOf(plan, "CAKE");
      expect(cake.issue).toBeNull();
      expect(cake.recipe).toMatchObject({ id: cakeRecipe, code: "R-CAKE", version: { versionNumber: 1 } });
      expect(cake.perBatch).toMatchObject({ base: 12, baseUnit: "each" });
      const [w0, w1] = cake.cells;
      expect(w0).toMatchObject({
        periodStart: W0,
        week: formatWeek(W0),
        demand: { base: 30 },
        planned: { base: 12 },
        gap: { base: 18 },
        suggestedBatches: 2,
        suggestedOutput: { base: 24 },
      });
      expect(w0.batches.map((b: { batchCode: string }) => b.batchCode)).toEqual([existing.batchCode]);
      expect(w1).toMatchObject({
        demand: { base: 25 },
        planned: { base: 0 },
        gap: { base: 25 },
        suggestedBatches: 3,
        suggestedOutput: { base: 36 },
        batches: [],
      });
      expect(cake.totals).toMatchObject({ demand: { base: 55 }, gap: { base: 43 }, suggestedBatches: 5 });
    });

    it("flags items without a recipe or an approved version, and asks which of several recipes to use", async () => {
      const plan = await proposal();
      expect(rowOf(plan, "BREAD")).toMatchObject({ issue: "no_recipe", recipe: null, options: [] });
      expect(rowOf(plan, "SOUP")).toMatchObject({ issue: "no_approved_version", recipe: null, options: [] });
      const pie = rowOf(plan, "PIE");
      expect(pie).toMatchObject({ issue: "choose_recipe", recipe: null, perBatch: null });
      expect(pie.options.map((o: { id: string }) => o.id)).toEqual([pieA, pieB]);
      expect(pie.options.map((o: { perBatch: { base: number } }) => o.perBatch.base)).toEqual([4, 6]);
      expect(pie.cells[1]).toMatchObject({ gap: { base: 10 }, suggestedBatches: 0 });

      const chosen = rowOf(await proposal(`&recipeIds=${pieB},${soupRecipe}`), "PIE");
      expect(chosen).toMatchObject({ issue: null, recipe: { id: pieB } });
      expect(chosen.cells[1]).toMatchObject({ suggestedBatches: 2, suggestedOutput: { base: 12 } });
    });

    it("takes ISO weeks, defaults to 12 weeks from this one, and refuses a bad range", async () => {
      const byWeek = await ok(
        await as(ada).get(`/production/plan-from-demand?from=${formatWeek(W0)}&to=${formatWeek(W1)}`),
      );
      expect(byWeek.weeks).toHaveLength(2);
      const byDefault = await ok(await as(ada).get("/production/plan-from-demand"));
      expect(byDefault.from).toBe(W0);
      expect(byDefault.weeks).toHaveLength(12);
      expect((await as(ada).get(`/production/plan-from-demand?from=${W1}&to=${W0}`)).status).toBe(400);
      expect((await as(ada).get(`/production/plan-from-demand?recipeIds=nope`)).status).toBe(400);
      expect(
        (await as(ada).get(`/production/plan-from-demand?from=${W0}&to=${addWeeks(W0, 200)}`)).status,
      ).toBe(400);
    });
  });

  describe("creating the batches", () => {
    it("creates them all in one go through the batch create path, with codes and the sync log", async () => {
      const before = await batchCount();
      const { batches } = await ok(
        await as(ada).send("POST", "/production/plan-from-demand", {
          batches: [
            { recipeId: cakeRecipe, plannedOn: addDays(W0, 2), batches: 2 },
            { recipeId: cakeRecipe, plannedOn: W1, outputQuantity: 36, outputUnit: "each" },
            { recipeId: pieB, plannedOn: W1, batches: 2, notes: "From demand" },
          ],
        }),
        201,
      );
      expect(await batchCount()).toBe(before + 3);
      expect(batches.map((b: { status: string }) => b.status)).toEqual(["planned", "planned", "planned"]);
      // Codes follow the per-day sequence: the existing batch on that day was -001.
      const day = existing.batchCode.slice(0, -3);
      expect(batches[0]).toMatchObject({ batchCode: `${day}002`, batches: 2, planned: { base: 24 } });
      expect(batches[1]).toMatchObject({ plannedOn: W1, batches: 3, planned: { base: 36 } });
      expect(batches[2]).toMatchObject({ recipe: { id: pieB }, notes: "From demand", batches: 2 });
      expect(batches[2].recipeVersion.status).toBe("approved");

      const { changes } = await ok(await as(ada).get("/sync?after=0&limit=1000"));
      const synced = changes
        .filter((c: { entity: string }) => c.entity === "production_batch")
        .map((c: { entityId: string }) => c.entityId);
      for (const b of batches) expect(synced).toContain(b.id);

      // The gaps are now covered.
      const plan = await proposal(`&recipeIds=${pieB}`);
      expect(rowOf(plan, "CAKE").cells.map((c: { gap: { base: number } }) => c.gap.base)).toEqual([0, 0]);
      expect(rowOf(plan, "CAKE").totals.suggestedBatches).toBe(0);
      expect(rowOf(plan, "PIE").cells[1]).toMatchObject({ planned: { base: 12 }, suggestedBatches: 0 });
    });

    it("is all or nothing, and names the batch that was refused", async () => {
      const before = await batchCount();
      const res = await as(ada).send("POST", "/production/plan-from-demand", {
        batches: [
          { recipeId: cakeRecipe, plannedOn: W1, batches: 1 },
          { recipeId: soupRecipe, plannedOn: W1, batches: 1 },
        ],
      });
      expect(res.status).toBe(409);
      const { error } = await res.json();
      expect(error.code).toBe("no_approved_version");
      expect(error.message).toMatch(/^Batch 2 /);
      expect(error.details).toMatchObject({ index: 1 });
      expect(await batchCount()).toBe(before);

      // The same checks as one batch at a time: a code can't be used twice, even within the list.
      const dup = await as(ada).send("POST", "/production/plan-from-demand", {
        batches: [
          { recipeId: cakeRecipe, plannedOn: W1, batches: 1, batchCode: "PLAN-1" },
          { recipeId: cakeRecipe, plannedOn: W1, batches: 1, batchCode: "plan-1" },
        ],
      });
      expect(dup.status).toBe(409);
      expect((await dup.json()).error.code).toBe("code_taken");
      expect(await batchCount()).toBe(before);

      for (const body of [
        { batches: [] },
        { batches: [{ recipeId: cakeRecipe, plannedOn: W1 }] },
        {
          batches: [
            { recipeId: cakeRecipe, plannedOn: W1, batches: 1, outputQuantity: 2, outputUnit: "each" },
          ],
        },
      ]) {
        expect((await as(ada).send("POST", "/production/plan-from-demand", body)).status).toBe(400);
      }
    });
  });

  describe("access", () => {
    it("needs production (and so demand) to read the proposal, and write to create", async () => {
      expect((await as(marcus.cookie).get("/production/plan-from-demand")).status).toBe(403);
      await grant("items", "read");
      await grant("recipes", "read");
      await grant("stock", "read");
      await grant("production", "read");
      // Production without demand is no production at all: the demand figures can't leak.
      expect((await as(marcus.cookie).get("/production/plan-from-demand")).status).toBe(403);
      await grant("demand", "read");
      const plan = await proposal("", marcus.cookie);
      expect(rowOf(plan, "CAKE").cells[0].demand.base).toBe(30);
      const create = () =>
        as(marcus.cookie).send("POST", "/production/plan-from-demand", {
          batches: [{ recipeId: cakeRecipe, plannedOn: W1, batches: 1 }],
        });
      expect((await create()).status).toBe(403);
      await grant("production", "write");
      // Planning needs write on production only; reading demand is enough.
      expect((await create()).status).toBe(201);
      await grant("demand", "none");
      expect((await as(marcus.cookie).get("/production/plan-from-demand")).status).toBe(403);
      // Demand is a soft dependency: planning batches reads nothing from it.
      expect((await create()).status).toBe(201);
    });

    it("lets write tokens read and plan, and read tokens only read: planning is not a sign-off", async () => {
      expect((await viaToken(readToken, "GET", "/production/plan-from-demand")).status).toBe(200);
      const body = { batches: [{ recipeId: cakeRecipe, plannedOn: W1, batches: 1 }] };
      expect((await viaToken(readToken, "POST", "/production/plan-from-demand", body)).status).toBe(403);
      expect((await viaToken(writeToken, "GET", "/production/plan-from-demand")).status).toBe(200);
      expect((await viaToken(writeToken, "POST", "/production/plan-from-demand", body)).status).toBe(201);
    });
  });
});
