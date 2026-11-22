import {
  addDays,
  DEFAULT_TIME_ZONE,
  generateBatchCode,
  parseActiveModules,
  todayInZone,
} from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
const tomorrow = addDays(today, 1);

describe("production module", () => {
  let ctx: TestCtx;
  let ada: string;
  let adaId: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
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
  const onHand = async (lotId: string) =>
    (await (await as(ada).get(`/stock/lots/${lotId}`)).json()).onHand.base as number;

  // Fixtures.
  let flour: string; // ingredient, kg
  let sugar: string; // ingredient, kg
  let salt: string; // ingredient, not in the cake recipe
  let cake: string; // finished, each, 450 g each, shelf life 5 days
  let box: string; // finished, each: a box of 6 cakes
  let cakeRecipe: string;
  let cakeV1: string;
  let boxRecipe: string;
  let store: string;
  let packing: string;
  let flourEarly: string; // expires first
  let flourLate: string;
  let flourHeld: string; // quarantine
  let sugarLot: string;
  let saltLot: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    adaId = (await (await ctx.req("/v1/me", { cookie: ada })).json()).user.id;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "t", scope: "write" },
        })
      ).json()
    ).token;

    const item = async (body: object) => (await ok(await as(ada).send("POST", "/items", body), 201)).id;
    flour = await item({ code: "FLR", name: "Flour", type: "ingredient", unit: "kg" });
    sugar = await item({ code: "SUG", name: "Sugar", type: "ingredient", unit: "kg" });
    salt = await item({ code: "SLT", name: "Salt", type: "ingredient", unit: "kg" });
    cake = await item({
      code: "CAKE",
      name: "Cake",
      type: "finished",
      unit: "each",
      unitWeightG: 450,
      shelfLifeDays: 5,
    });
    box = await item({ code: "BOX6", name: "Cake box", type: "finished", unit: "each" });

    const recipe = async (code: string, outputItemId: string, draft: object) => {
      const r = await ok(
        await as(ada).send("POST", "/recipes", { code, name: code, outputItemId, draft }),
        201,
      );
      return r.id as string;
    };
    cakeRecipe = await recipe("R-CAKE", cake, {
      yieldQuantity: 12,
      yieldUnit: "each",
      lines: [
        { itemId: flour, quantity: 1.5, unit: "kg" },
        { itemId: sugar, quantity: 500, unit: "g" },
      ],
    });
    boxRecipe = await recipe("R-BOX", box, {
      yieldQuantity: 1,
      yieldUnit: "each",
      lines: [{ itemId: cake, quantity: 6, unit: "each" }],
    });
    // The box recipe is approved up front; the cake recipe in the planning tests.
    await ok(await as(ada).send("POST", `/recipes/${boxRecipe}/draft/approve`));

    const location = async (name: string) =>
      (await ok(await as(ada).send("POST", "/stock/locations", { name }), 201)).id;
    store = await location("Dry store");
    packing = await location("Packing");
    const receive = async (body: object) =>
      (
        await ok(
          await as(ada).send("POST", "/stock/receipts", { locationId: store, receivedOn: today, ...body }),
          201,
        )
      ).id as string;
    flourEarly = await receive({
      itemId: flour,
      quantity: 2,
      unit: "kg",
      lotCode: "FL-EARLY",
      expiresOn: addDays(today, 10),
      expiryType: "best_before",
    });
    flourLate = await receive({
      itemId: flour,
      quantity: 5,
      unit: "kg",
      lotCode: "FL-LATE",
      expiresOn: addDays(today, 60),
      expiryType: "best_before",
    });
    flourHeld = await receive({
      itemId: flour,
      quantity: 10,
      unit: "kg",
      lotCode: "FL-HELD",
      status: "quarantine",
    });
    sugarLot = await receive({ itemId: sugar, quantity: 3, unit: "kg", lotCode: "SG-1" });
    saltLot = await receive({ itemId: salt, quantity: 1, unit: "kg", lotCode: "SL-1" });
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("access", () => {
    it("is opt-in, and needs recipes, stock and demand too", async () => {
      expect((await as(marcus.cookie).get("/production/batches")).status).toBe(403);
      await grant("production", "write");
      expect((await as(marcus.cookie).get("/production/batches")).status).toBe(403);
      await grant("items", "read");
      await grant("recipes", "read");
      expect((await as(marcus.cookie).get("/production/batches")).status).toBe(403);
      await grant("stock", "read");
      expect((await as(marcus.cookie).get("/production/batches")).status).toBe(403);
      await grant("demand", "read");
      expect((await as(marcus.cookie).get("/production/batches")).status).toBe(200);
    });

    it("is switched off with the module, and can't be on without recipes, stock and demand", async () => {
      const off = await makeApp({
        seed: true,
        activeModules: ["tasks", "docs", "items", "recipes", "stock"],
      });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const res = await off.req(`${WS}/production/batches`, { cookie });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("module_inactive");
      await off.handle.close();
      expect(() => parseActiveModules("items,stock,demand,production")).toThrow(/needs "recipes"/);
      expect(() => parseActiveModules("items,recipes,stock,production")).toThrow(/needs "demand"/);
    }, 60_000);
  });

  describe("planning", () => {
    it("needs an approved recipe version", async () => {
      const res = await as(ada).send("POST", "/production/batches", {
        recipeId: cakeRecipe,
        plannedOn: today,
        batches: 1,
      });
      expect(await error(res, 409)).toBe("no_approved_version");
      const approved = await ok(await as(ada).send("POST", `/recipes/${cakeRecipe}/draft/approve`));
      cakeV1 = approved.id;
    });

    it("plans by batches or by output, pins the version and generates a code", async () => {
      const batch = await ok(
        await as(marcus.cookie).send("POST", "/production/batches", {
          recipeId: cakeRecipe,
          plannedOn: today,
          batches: 2,
          outputLocationId: packing,
        }),
        201,
      );
      expect(batch).toMatchObject({
        batchCode: generateBatchCode(today, 1),
        status: "planned",
        recipe: { id: cakeRecipe, code: "R-CAKE" },
        recipeVersion: { id: cakeV1, versionNumber: 1, status: "approved" },
        outputItem: { id: cake },
        outputLocation: { id: packing, name: "Packing" },
        planned: { base: 24, baseUnit: "each" },
        batches: 2,
        produced: { base: 0 },
        createdBy: marcus.userId,
      });
      expect(batch.materials).toMatchObject([
        {
          item: { id: flour },
          required: { base: 3000, display: 3 },
          consumed: { base: 0 },
          outstanding: { base: 3000 },
        },
        { item: { id: sugar }, required: { base: 1000 }, outstanding: { base: 1000 } },
      ]);
      // By output: 18 cakes is 1.5 batches; 9 kg of cake is 20 (450 g each).
      const byOutput = await ok(
        await as(ada).send("POST", "/production/batches", {
          recipeId: cakeRecipe,
          plannedOn: tomorrow,
          outputQuantity: 9,
          outputUnit: "kg",
          batchCode: "CAKE-TMRW",
        }),
        201,
      );
      expect(byOutput).toMatchObject({ planned: { base: 20 }, batches: 1.6667, batchCode: "CAKE-TMRW" });
      const dupe = await as(ada).send("POST", "/production/batches", {
        recipeId: cakeRecipe,
        plannedOn: tomorrow,
        batches: 1,
        batchCode: "cake-tmrw",
      });
      expect(await error(dupe, 409)).toBe("code_taken");
      const bad = await as(ada).send("POST", "/production/batches", {
        recipeId: cakeRecipe,
        plannedOn: today,
        outputQuantity: 1,
        outputUnit: "l",
      });
      expect(await error(bad, 400)).toBe("unit_not_convertible");
    });

    it("lists the schedule by date with filters", async () => {
      const all = await ok(await as(ada).get("/production/batches"));
      expect(all.batches.map((b: { batchCode: string }) => b.batchCode)).toEqual([
        generateBatchCode(today, 1),
        "CAKE-TMRW",
      ]);
      expect(all.total).toBe(2);
      const day = await ok(await as(ada).get(`/production/batches?from=${tomorrow}&to=${tomorrow}`));
      expect(day.batches.map((b: { batchCode: string }) => b.batchCode)).toEqual(["CAKE-TMRW"]);
      const byVersion = await ok(await as(ada).get(`/production/batches?recipeVersionId=${cakeV1}`));
      expect(byVersion.total).toBe(2);
      expect((await ok(await as(ada).get("/production/batches?q=tmrw"))).total).toBe(1);
      expect((await ok(await as(ada).get("/production/batches?status=completed"))).total).toBe(0);
      expect((await as(ada).get(`/production/batches?from=${tomorrow}&to=${today}`)).status).toBe(400);
    });

    it("rolls up material requirements against usable stock", async () => {
      const res = await ok(await as(ada).get(`/production/requirements?from=${today}&to=${tomorrow}`));
      expect(res.batches).toHaveLength(2);
      // 2 + 1.6667 batches: flour 3000 + 2500 g; sugar 1000 + 833.3333 g.
      const [f, s] = res.requirements;
      expect(f).toMatchObject({
        item: { id: flour },
        required: { base: 5500 },
        outstanding: { base: 5500 },
        // The quarantined lot doesn't count as available, but is reported.
        available: { base: 7000 },
        quarantine: { base: 10000 },
        shortfall: { base: 0 },
      });
      expect(f.batches).toHaveLength(2);
      expect(s).toMatchObject({ item: { id: sugar }, required: { base: 1833.3333 }, shortfall: { base: 0 } });
      // Only the window's batches.
      const one = await ok(await as(ada).get(`/production/requirements?from=${tomorrow}&to=${tomorrow}`));
      expect(one.requirements[0].required.base).toBe(2500);
    });

    it("reschedules and resizes only while planned; a new approved version must be adopted before starting", async () => {
      const { batches } = await ok(await as(ada).get("/production/batches?q=tmrw"));
      const id = batches[0].id;
      const resized = await ok(
        await as(ada).send("PATCH", `/production/batches/${id}`, { batches: 1, notes: "Small" }),
      );
      expect(resized).toMatchObject({ planned: { base: 12 }, batches: 1, notes: "Small" });
      // A new version of the cake recipe is approved: the planned batch keeps v1, now superseded.
      await ok(
        await as(ada).send("PUT", `/recipes/${cakeRecipe}/draft`, {
          yieldQuantity: 12,
          yieldUnit: "each",
          changeNote: "Less sugar",
          lines: [
            { itemId: flour, quantity: 1.5, unit: "kg" },
            { itemId: sugar, quantity: 400, unit: "g" },
          ],
        }),
      );
      const v2 = (await ok(await as(ada).send("POST", `/recipes/${cakeRecipe}/draft/approve`))).id;
      expect(await error(await as(ada).send("POST", `/production/batches/${id}/start`), 409)).toBe(
        "version_superseded",
      );
      expect(
        await error(
          await as(ada).send("PATCH", `/production/batches/${id}`, { recipeVersionId: cakeV1 }),
          409,
        ),
      ).toBe("version_not_approved");
      const moved = await ok(
        await as(ada).send("PATCH", `/production/batches/${id}`, { recipeVersionId: v2 }),
      );
      expect(moved).toMatchObject({ recipeVersion: { id: v2, versionNumber: 2 }, planned: { base: 12 } });
      expect(moved.materials[1]).toMatchObject({ item: { id: sugar }, required: { base: 400 } });
      // Batches planned from now on use v2.
      expect((await ok(await as(ada).get(`/production/batches?recipeVersionId=${v2}`))).total).toBe(1);
    });

    it("cancels a planned batch with a reason, as a person", async () => {
      const { batches } = await ok(await as(ada).get("/production/batches?q=tmrw"));
      const id = batches[0].id;
      expect(
        await error(await viaToken("POST", `/production/batches/${id}/cancel`, { reason: "x" }), 403),
      ).toBe("token_not_allowed");
      const cancelled = await ok(
        await as(marcus.cookie).send("POST", `/production/batches/${id}/cancel`, { reason: "No orders" }),
      );
      expect(cancelled).toMatchObject({
        status: "cancelled",
        cancelReason: "No orders",
        cancelledBy: marcus.userId,
      });
      expect(await error(await as(ada).send("PATCH", `/production/batches/${id}`, { notes: "x" }), 409)).toBe(
        "invalid_batch_status",
      );
      const open = await ok(await as(ada).get(`/production/requirements?from=${today}&to=${tomorrow}`));
      expect(open.batches).toHaveLength(1);
    });
  });

  describe("batch records", () => {
    let batch: string; // 2 batches of v1 (24 cakes)
    let cakeLot: string;

    beforeAll(async () => {
      const { batches } = await ok(await as(ada).get(`/production/batches?from=${today}&to=${today}`));
      batch = batches[0].id;
    });

    it("records consumption only once started", async () => {
      const body = { lines: [{ lotId: flourEarly, locationId: store, quantity: 1, unit: "kg" }] };
      expect(
        await error(
          await as(marcus.cookie).send("POST", `/production/batches/${batch}/consumption`, body),
          409,
        ),
      ).toBe("invalid_batch_status");
      // This batch was planned on v1 before v2 was approved: move it to v2 first.
      expect(
        await error(await as(marcus.cookie).send("POST", `/production/batches/${batch}/start`), 409),
      ).toBe("version_superseded");
      const { currentVersion } = await ok(await as(ada).get(`/recipes/${cakeRecipe}`));
      await ok(
        await as(marcus.cookie).send("PATCH", `/production/batches/${batch}`, {
          recipeVersionId: currentVersion.id,
        }),
      );
      const started = await ok(await as(marcus.cookie).send("POST", `/production/batches/${batch}/start`));
      expect(started).toMatchObject({ status: "in_progress", startedBy: marcus.userId });
      expect(started.startedAt).toBeTruthy();
      // Started batches can't be resized.
      expect(
        await error(await as(ada).send("PATCH", `/production/batches/${batch}`, { batches: 3 }), 409),
      ).toBe("invalid_batch_status");
    });

    it("suggests a FEFO pick for what is outstanding", async () => {
      const pick = await ok(await as(ada).get(`/production/batches/${batch}/pick`));
      const flourPick = pick.materials.find((m: { item: { id: string } }) => m.item.id === flour);
      expect(
        flourPick.allocations.map((a: { lotCode: string; amount: { base: number } }) => [
          a.lotCode,
          a.amount.base,
        ]),
      ).toEqual([
        ["FL-EARLY", 2000],
        ["FL-LATE", 1000],
      ]);
      expect(flourPick.shortfall.base).toBe(0);
    });

    it("refuses items outside the recipe, unreleased lots and more than is there", async () => {
      const post = (lines: object[]) =>
        as(marcus.cookie).send("POST", `/production/batches/${batch}/consumption`, { lines });
      const line = (lotId: string, quantity: number) => ({ lotId, locationId: store, quantity, unit: "kg" });
      expect(await error(await post([line(saltLot, 0.1)]), 409)).toBe("not_in_recipe");
      expect(await error(await post([line(flourHeld, 1)]), 409)).toBe("lot_not_available");
      expect(await error(await post([line(flourEarly, 2.5)]), 409)).toBe("insufficient_stock");
      // Nothing was posted by the failed requests (one transaction).
      expect(await onHand(flourEarly)).toBe(2000);
    });

    it("posts consumption movements and links them to the batch", async () => {
      const res = await ok(
        await as(marcus.cookie).send("POST", `/production/batches/${batch}/consumption`, {
          lines: [
            { lotId: flourEarly, locationId: store, quantity: 2, unit: "kg" },
            { lotId: flourLate, locationId: store, quantity: 1000, unit: "g" },
            { lotId: sugarLot, locationId: store, quantity: 0.8, unit: "kg", note: "Weighed twice" },
          ],
        }),
        201,
      );
      expect(res.materials).toMatchObject([
        { item: { id: flour }, required: { base: 3000 }, consumed: { base: 3000 }, outstanding: { base: 0 } },
        { item: { id: sugar }, required: { base: 800 }, consumed: { base: 800 }, outstanding: { base: 0 } },
      ]);
      expect(res.records).toHaveLength(3);
      expect(res.records[0]).toMatchObject({
        kind: "consumption",
        lotCode: "FL-EARLY",
        quantity: 2000,
        actorId: marcus.userId,
      });
      expect(await onHand(flourEarly)).toBe(0);
      expect(await onHand(flourLate)).toBe(4000);
      const lot = await ok(await as(ada).get(`/stock/lots/${flourLate}`));
      expect(lot.movements.at(-1)).toMatchObject({
        type: "consumption",
        quantity: -1000,
        reference: res.batchCode,
      });
    });

    it("records output into a new quarantined lot named after the batch, then adds to it", async () => {
      const noWhere = await ok(
        await as(ada).send("POST", "/production/batches", {
          recipeId: cakeRecipe,
          plannedOn: today,
          batches: 1,
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/production/batches/${noWhere.id}/start`));
      expect(
        await error(
          await as(ada).send("POST", `/production/batches/${noWhere.id}/output`, {
            quantity: 1,
            unit: "each",
          }),
          400,
        ),
      ).toBe("invalid_input");
      await ok(await as(ada).send("POST", `/production/batches/${noWhere.id}/cancel`, { reason: "Test" }));

      const res = await ok(
        await as(marcus.cookie).send("POST", `/production/batches/${batch}/output`, {
          quantity: 20,
          unit: "each",
        }),
        201,
      );
      expect(res.outputs).toHaveLength(1);
      expect(res.outputs[0]).toMatchObject({
        lotCode: res.batchCode,
        status: "quarantine",
        expiresOn: addDays(today, 5),
        expiryType: "best_before",
        produced: { base: 20 },
      });
      cakeLot = res.outputs[0].lotId;
      const more = await ok(
        await as(marcus.cookie).send("POST", `/production/batches/${batch}/output`, {
          quantity: 1.8,
          unit: "kg",
          lotId: cakeLot,
        }),
        201,
      );
      expect(more.outputs[0].produced.base).toBe(24);
      expect(more.produced.base).toBe(24);
      const lot = await ok(await as(ada).get(`/stock/lots/${cakeLot}`));
      expect(lot).toMatchObject({ status: "quarantine", onHand: { base: 24 }, receivedOn: today });
      expect(lot.balances[0]).toMatchObject({ locationId: packing });
      expect(lot.movements.map((m: { type: string }) => m.type)).toEqual(["production", "production"]);
      expect(
        await error(
          await as(ada).send("POST", `/production/batches/${batch}/output`, {
            quantity: 1,
            unit: "each",
            lotId: flourLate,
          }),
          409,
        ),
      ).toBe("lot_not_from_batch");
    });

    it("corrects a record with a reversal, once, as a person; stock can't reverse it directly", async () => {
      const detail = await ok(await as(ada).get(`/production/batches/${batch}`));
      const sugarRecord = detail.records.find((r: { lotCode: string }) => r.lotCode === "SG-1");
      const path = `/production/batches/${batch}/records/${sugarRecord.id}/reverse`;
      expect(await error(await viaToken("POST", path, { reason: "Wrong lot" }), 403)).toBe(
        "token_not_allowed",
      );
      expect(
        await error(
          await as(ada).send("POST", `/stock/movements/${sugarRecord.movementId}/reverse`, { reason: "x" }),
          409,
        ),
      ).toBe("production_movement");
      const reversed = await ok(await as(marcus.cookie).send("POST", path, { reason: "Wrong scale" }), 201);
      expect(reversed.materials[1]).toMatchObject({ consumed: { base: 0 }, outstanding: { base: 800 } });
      const reversal = reversed.records.at(-1);
      expect(reversal).toMatchObject({
        reversesRecordId: sugarRecord.id,
        quantity: -800,
        note: "Wrong scale",
      });
      expect(reversed.records.find((r: { id: string }) => r.id === sugarRecord.id).reversed).toBe(true);
      expect(await onHand(sugarLot)).toBe(3000);
      expect(await error(await as(marcus.cookie).send("POST", path, { reason: "Again" }), 409)).toBe(
        "already_reversed",
      );
      expect(
        await error(
          await as(marcus.cookie).send(
            "POST",
            `/production/batches/${batch}/records/${reversal.id}/reverse`,
            { reason: "x" },
          ),
          409,
        ),
      ).toBe("not_reversible");
      await ok(
        await as(marcus.cookie).send("POST", `/production/batches/${batch}/consumption`, {
          lines: [{ lotId: sugarLot, locationId: store, quantity: 800, unit: "g" }],
        }),
        201,
      );
    });

    it("completes only as a person with manage, recording who and when; the record is then closed", async () => {
      const path = `/production/batches/${batch}/complete`;
      expect(await error(await as(marcus.cookie).send("POST", path, {}), 403)).toBe("module_forbidden");
      expect(await error(await viaToken("POST", path, {}), 403)).toBe("token_not_allowed");
      const done = await ok(await as(ada).send("POST", path, { note: "Good bake" }));
      expect(done).toMatchObject({
        status: "completed",
        completedBy: adaId,
        completedByName: "Ada Park",
        completionNote: "Good bake",
      });
      expect(done.completedAt).toBeTruthy();
      expect(await error(await as(ada).send("POST", path, {}), 409)).toBe("invalid_batch_status");
      expect(
        await error(
          await as(marcus.cookie).send("POST", `/production/batches/${batch}/consumption`, {
            lines: [{ lotId: flourLate, locationId: store, quantity: 1, unit: "kg" }],
          }),
          409,
        ),
      ).toBe("invalid_batch_status");
      // A correction on a closed record needs manage.
      const flourRecord = done.records.find((r: { lotCode: string }) => r.lotCode === "FL-LATE");
      const reverse = `/production/batches/${batch}/records/${flourRecord.id}/reverse`;
      expect(await error(await as(marcus.cookie).send("POST", reverse, { reason: "x" }), 403)).toBe(
        "module_forbidden",
      );
      await ok(await as(ada).send("POST", reverse, { reason: "Recount: used 1 kg less" }), 201);
      expect(await onHand(flourLate)).toBe(5000);
    });

    it("can't complete without output, and cancelling a started batch needs manage", async () => {
      const started = await ok(
        await as(marcus.cookie).send("POST", "/production/batches", {
          recipeId: cakeRecipe,
          plannedOn: today,
          batches: 1,
        }),
        201,
      );
      await ok(await as(marcus.cookie).send("POST", `/production/batches/${started.id}/start`));
      expect(
        await error(await as(ada).send("POST", `/production/batches/${started.id}/complete`, {}), 409),
      ).toBe("no_output");
      expect(
        await error(
          await as(marcus.cookie).send("POST", `/production/batches/${started.id}/cancel`, {
            reason: "Oven down",
          }),
          403,
        ),
      ).toBe("module_forbidden");
      expect(
        (
          await ok(
            await as(ada).send("POST", `/production/batches/${started.id}/cancel`, { reason: "Oven down" }),
          )
        ).status,
      ).toBe("cancelled");
    });

    it("traces lots forward and backward through batches, with a mass balance", async () => {
      // QA releases the cakes (a stock sign-off), and a box batch consumes some of them.
      await ok(
        await as(ada).send("POST", `/stock/lots/${cakeLot}/status`, {
          status: "available",
          note: "Passed QA",
        }),
      );
      const boxBatch = await ok(
        await as(ada).send("POST", "/production/batches", {
          recipeId: boxRecipe,
          plannedOn: today,
          batches: 2,
          outputLocationId: packing,
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/production/batches/${boxBatch.id}/start`));
      await ok(
        await as(ada).send("POST", `/production/batches/${boxBatch.id}/consumption`, {
          lines: [{ lotId: cakeLot, locationId: packing, quantity: 12, unit: "each" }],
        }),
        201,
      );
      const boxed = await ok(
        await as(ada).send("POST", `/production/batches/${boxBatch.id}/output`, {
          quantity: 2,
          unit: "each",
          lotCode: "BX-1",
        }),
        201,
      );
      const boxLot = boxed.outputs[0].lotId;

      // Forward from a flour lot: the cake batch, its cakes, then the box batch and its boxes.
      const fwd = await ok(await as(ada).get(`/production/lots/${flourEarly}/trace`));
      expect(fwd.lot).toMatchObject({ lotCode: "FL-EARLY", item: { id: flour } });
      expect(
        fwd.forward.map((s: { depth: number; batch: { batchCode: string } }) => [s.depth, s.batch.batchCode]),
      ).toEqual([
        [1, generateBatchCode(today, 1)],
        [2, boxBatch.batchCode],
      ]);
      expect(fwd.forward[0]).toMatchObject({
        batch: { recipe: { code: "R-CAKE" }, recipeVersion: { versionNumber: 2 }, status: "completed" },
        consumed: { lot: { lotCode: "FL-EARLY" }, amount: { base: 2000 } },
        outputs: [{ lot: { id: cakeLot, onHand: { base: 12 } }, amount: { base: 24 } }],
      });
      expect(fwd.forward[1].outputs[0]).toMatchObject({ lot: { lotCode: "BX-1" }, amount: { base: 2 } });
      expect(fwd.backward).toEqual([]);
      expect(fwd.massBalance).toMatchObject({
        received: { base: 2000 },
        consumed: { base: 2000 },
        onHand: { base: 0 },
      });
      // One level only when asked.
      expect(
        (await ok(await as(ada).get(`/production/lots/${flourEarly}/trace?depth=1`))).forward,
      ).toHaveLength(1);

      // Backward from the boxes: the cakes, then the flour and sugar lots the cakes were made from.
      const back = await ok(await as(ada).get(`/production/lots/${boxLot}/trace`));
      expect(back.backward[0]).toMatchObject({
        depth: 1,
        inputs: [{ lot: { id: cakeLot }, amount: { base: 12 } }],
      });
      const cakeInputs = back.backward[1].inputs.map(
        (i: { lot: { lotCode: string }; amount: { base: number } }) => [i.lot.lotCode, i.amount.base],
      );
      // FL-LATE's consumption was reversed after completion: it drops out of the trace.
      expect(cakeInputs.sort()).toEqual([
        ["FL-EARLY", 2000],
        ["SG-1", 800],
      ]);
      // The cake lot's mass balance: 24 produced, 12 consumed, 12 on hand.
      const mid = await ok(await as(ada).get(`/production/lots/${cakeLot}/trace`));
      expect(mid.massBalance).toMatchObject({
        produced: { base: 24 },
        consumed: { base: 12 },
        onHand: { base: 12 },
        adjustedPercent: 0,
      });
      expect(mid.backward).toHaveLength(1);
      expect(mid.forward).toHaveLength(1);
    });
  });

  it("lets only one of two concurrent consumptions spend the same stock", async () => {
    const batch = await ok(
      await as(ada).send("POST", "/production/batches", {
        recipeId: cakeRecipe,
        plannedOn: today,
        batches: 3,
      }),
      201,
    );
    await ok(await as(ada).send("POST", `/production/batches/${batch.id}/start`));
    const take = () =>
      as(ada).send("POST", `/production/batches/${batch.id}/consumption`, {
        lines: [{ lotId: flourLate, locationId: store, quantity: 3, unit: "kg" }],
      });
    const statuses = (await Promise.all([take(), take()])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(await onHand(flourLate)).toBe(2000);
  });

  it("won't add output to a lot QA has already released or rejected", async () => {
    const batch = await ok(
      await as(ada).send("POST", "/production/batches", {
        recipeId: cakeRecipe,
        plannedOn: today,
        batches: 1,
        outputLocationId: packing,
      }),
      201,
    );
    await ok(await as(ada).send("POST", `/production/batches/${batch.id}/start`));
    const output = (body: object) => as(ada).send("POST", `/production/batches/${batch.id}/output`, body);
    const lotId = (await ok(await output({ quantity: 4, unit: "each" }), 201)).outputs[0].lotId as string;
    // Still in quarantine: more output goes into the same lot.
    await ok(await output({ quantity: 2, unit: "each", lotId }), 201);
    await ok(await as(ada).send("POST", `/stock/lots/${lotId}/status`, { status: "available", note: "QA" }));
    // The batch page releases through that same stock endpoint, and its detail shows the result.
    const released = await ok(await as(ada).get(`/production/batches/${batch.id}`));
    expect(released.outputs).toEqual([expect.objectContaining({ lotId, status: "available" })]);
    expect(await error(await output({ quantity: 1, unit: "each", lotId }), 409)).toBe("lot_released");
    expect(await onHand(lotId)).toBe(6);
    await ok(
      await as(ada).send("POST", `/stock/lots/${lotId}/status`, { status: "rejected", note: "Recall" }),
    );
    expect(await error(await output({ quantity: 1, unit: "each", lotId }), 409)).toBe("lot_rejected");
    // A new lot is fine.
    expect((await ok(await output({ quantity: 1, unit: "each" }), 201)).outputs).toHaveLength(2);
  });

  it("lets tokens read, plan and record, but not sign off", async () => {
    expect((await viaToken("GET", "/production/batches")).status).toBe(200);
    expect((await viaToken("GET", `/production/requirements?from=${today}&to=${today}`)).status).toBe(200);
    const planned = await ok(
      await viaToken("POST", "/production/batches", {
        recipeId: cakeRecipe,
        plannedOn: tomorrow,
        batches: 1,
      }),
      201,
    );
    expect(planned.createdBy).toBe(adaId);
    expect((await viaToken("POST", `/production/batches/${planned.id}/start`)).status).toBe(200);
    expect((await viaToken("POST", `/production/batches/${planned.id}/complete`, {})).status).toBe(403);
  });

  it("writes the sync log, hidden from members without the module", async () => {
    const sync = async (cookie: string) =>
      (await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie })).json()).changes.map(
        (c: { entity: string }) => c.entity,
      ) as string[];
    const entities = ["production_batch", "production_record"];
    const seen = await sync(ada);
    for (const entity of entities) expect(seen).toContain(entity);
    expect(await sync(marcus.cookie)).toContain("production_record");
    await grant("production", "none");
    const hidden = await sync(marcus.cookie);
    for (const entity of entities) expect(hidden).not.toContain(entity);
    // The stock movements production posted stay visible to stock readers.
    expect(hidden).toContain("stock_movement");
    const bootstrap = await (await ctx.req(`${WS}/bootstrap`, { cookie: ada })).json();
    expect(Object.keys(bootstrap).some((k) => k.toLowerCase().includes("production"))).toBe(false);
    await grant("production", "write");
  });
  it("retries consumption and output without duplicating either ledger", async () => {
    const batch = await ok(
      await as(ada).send("POST", "/production/batches", {
        recipeId: cakeRecipe,
        plannedOn: today,
        batches: 1,
        outputLocationId: packing,
      }),
      201,
    );
    await ok(await as(ada).send("POST", `/production/batches/${batch.id}/start`));
    const receipt = await ok(
      await as(ada).send("POST", "/stock/receipts", {
        itemId: flour,
        locationId: store,
        receivedOn: today,
        quantity: 2,
        unit: "kg",
      }),
      201,
    );
    const commandId = crypto.randomUUID();
    const input = { commandId, lines: [{ lotId: receipt.id, locationId: store, quantity: 1, unit: "kg" }] };
    const consume = () => as(ada).send("POST", `/production/batches/${batch.id}/consumption`, input);
    expect(await ok(await consume(), 201)).toEqual(await ok(await consume(), 201));
    expect(await onHand(receipt.id)).toBe(1000);
    const outputInput = { commandId: crypto.randomUUID(), quantity: 3, unit: "each" };
    const output = () => as(ada).send("POST", `/production/batches/${batch.id}/output`, outputInput);
    expect(await ok(await output(), 201)).toEqual(await ok(await output(), 201));
    const result = await ok(await as(ada).get(`/production/batches/${batch.id}`));
    expect(result.outputs).toHaveLength(1);
    expect(await onHand(result.outputs[0].lotId)).toBe(3);
    const readiness = await ok(await as(ada).get(`/production/batches/${batch.id}/readiness`));
    expect(readiness.checked).toBe(true);
    // Production readers without HACCP access get an explicit unknown, never private counts.
    const hidden = await ok(await as(marcus.cookie).get(`/production/batches/${batch.id}/readiness`));
    expect(hidden).toEqual({ batchId: batch.id, checked: false, ready: null, issues: [] });
  });
});
