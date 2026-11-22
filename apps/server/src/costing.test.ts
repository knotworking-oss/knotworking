import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { costingPeriodEnd, costingPeriodLabel, costingPeriodStart } from "@knotworking/core";
import { productionBatches } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

/** Today in the test workspaces' zone (the default, Europe/London), as the server decides it. */
const utcToday = () => todayInZone(DEFAULT_TIME_ZONE);

const WS = "/v1/workspaces/acme";

describe("costing module", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const today = utcToday();
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (path: string) =>
    ctx.req(`${WS}${path}`, { headers: { authorization: `Bearer ${token}`, origin: "" } });
  const grant = (moduleId: string, level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
  const ok = async (res: { status: number; json(): Promise<any> }, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const error = async (res: { status: number; json(): Promise<any> }, status: number) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body.error as { code: string; message: string };
  };

  // Fixtures.
  let flour: string; // kg, standard 0.80; bought at 0.90
  let sugar: string; // kg, standard 1.20; opening stock (no price)
  let eggs: string; // each, standard 0.25; bought at 0.30
  let dough: string; // WIP, kg, standard 1.50
  let bread: string; // finished, each
  let store: string;
  let poReference: string;
  let flourLot: string;
  let eggLot: string;
  let sugarLot: string;
  let doughRecipe: string;
  let breadRecipe: string;
  let doughBatch: { id: string; batchCode: string };
  let doughLot: string;
  let breadBatch: { id: string; batchCode: string };

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    marcus = {
      userId: members.find((x: { email: string }) => x.email === "marcus@knotworking.dev").userId,
      cookie: (await signIn(ctx, "marcus@knotworking.dev")).cookie,
    };
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "read" },
        })
      ).json()
    ).token;

    const mill = (await ok(await as(ada).send("POST", "/suppliers", { name: "Mill" }), 201)).id;
    await ok(await as(ada).send("POST", `/suppliers/${mill}/approval`, { status: "approved" }));
    const item = async (body: object) => (await ok(await as(ada).send("POST", "/items", body), 201)).id;
    flour = await item({ code: "FLR", name: "Flour", type: "ingredient", unit: "kg", standardCost: 0.8 });
    sugar = await item({ code: "SUG", name: "Sugar", type: "ingredient", unit: "kg", standardCost: 1.2 });
    eggs = await item({ code: "EGG", name: "Eggs", type: "ingredient", unit: "each", standardCost: 0.25 });
    dough = await item({ code: "DGH", name: "Dough", type: "wip", unit: "kg", standardCost: 1.5 });
    bread = await item({ code: "BRD", name: "Bread", type: "finished", unit: "each" });
    store = (await ok(await as(ada).send("POST", "/stock/locations", { name: "Store" }), 201)).id;

    // Flour and eggs bought against an order; sugar is opening stock with no price.
    const po = await ok(
      await as(ada).send("POST", "/purchasing/orders", {
        supplierId: mill,
        expectedOn: today,
        lines: [
          { itemId: flour, quantity: 25, unit: "kg", unitPrice: 0.9 },
          { itemId: eggs, quantity: 180, unit: "each", unitPrice: 0.3 },
        ],
      }),
      201,
    );
    poReference = po.reference;
    await ok(await as(ada).send("POST", `/purchasing/orders/${po.id}/send`, {}));
    const line = (itemId: string) => po.lines.find((l: { itemId: string }) => l.itemId === itemId).id;
    const received = await ok(
      await as(ada).send("POST", `/purchasing/orders/${po.id}/receipts`, {
        receivedOn: today,
        lines: [
          { lineId: line(flour), outcome: "accepted", quantity: 25, unit: "kg", locationId: store },
          { lineId: line(eggs), outcome: "accepted", quantity: 180, unit: "each", locationId: store },
        ],
      }),
      201,
    );
    const lotOf = (itemId: string) =>
      received.receipts.find((r: { item: { id: string } }) => r.item.id === itemId).lotId;
    flourLot = lotOf(flour);
    eggLot = lotOf(eggs);
    sugarLot = (
      await ok(
        await as(ada).send("POST", "/stock/receipts", {
          itemId: sugar,
          quantity: 5,
          unit: "kg",
          locationId: store,
          receivedOn: today,
          lotCode: "SUG-OPEN",
        }),
        201,
      )
    ).id;

    // Dough: 10 kg from 6 kg flour, 1 kg sugar and 20 eggs (standard 11.00). Bread: 10 from 5 kg dough.
    const recipe = async (code: string, outputItemId: string, draft: object) => {
      const id = (
        await ok(await as(ada).send("POST", "/recipes", { code, name: code, outputItemId, draft }), 201)
      ).id;
      await ok(await as(ada).send("POST", `/recipes/${id}/draft/approve`));
      return id as string;
    };
    doughRecipe = await recipe("R-DGH", dough, {
      yieldQuantity: 10,
      yieldUnit: "kg",
      lines: [
        { itemId: flour, quantity: 6, unit: "kg" },
        { itemId: sugar, quantity: 1000, unit: "g" },
        { itemId: eggs, quantity: 20, unit: "each" },
      ],
    });
    breadRecipe = await recipe("R-BRD", bread, {
      yieldQuantity: 10,
      yieldUnit: "each",
      lines: [{ itemId: dough, quantity: 5, unit: "kg" }],
    });

    const run = async (
      recipeId: string,
      consume: { lotId: string; quantity: number; unit: string }[],
      out: { quantity: number; unit: string },
    ) => {
      const batch = await ok(
        await as(ada).send("POST", "/production/batches", {
          recipeId,
          plannedOn: today,
          batches: 1,
          outputLocationId: store,
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/production/batches/${batch.id}/start`));
      await ok(
        await as(ada).send("POST", `/production/batches/${batch.id}/consumption`, {
          lines: consume.map((c) => ({ ...c, locationId: store })),
        }),
        201,
      );
      const made = await ok(await as(ada).send("POST", `/production/batches/${batch.id}/output`, out), 201);
      await ok(await as(ada).send("POST", `/production/batches/${batch.id}/complete`, {}));
      return {
        batch: { id: batch.id as string, batchCode: batch.batchCode as string },
        lot: made.outputs[0].lotId,
      };
    };
    // 22 eggs instead of 20, and 9.5 kg of dough instead of 10.
    const d = await run(
      doughRecipe,
      [
        { lotId: flourLot, quantity: 6, unit: "kg" },
        { lotId: sugarLot, quantity: 1, unit: "kg" },
        { lotId: eggLot, quantity: 22, unit: "each" },
      ],
      { quantity: 9.5, unit: "kg" },
    );
    doughBatch = d.batch;
    doughLot = d.lot;
    await ok(
      await as(ada).send("POST", `/stock/lots/${doughLot}/status`, {
        status: "available",
        note: "Passed QA",
      }),
    );
    breadBatch = (
      await run(breadRecipe, [{ lotId: doughLot, quantity: 5, unit: "kg" }], { quantity: 10, unit: "each" })
    ).batch;
  }, 120_000);
  afterAll(() => ctx.handle.close());

  describe("access", () => {
    it("is opt-in, needs its dependencies, and is read-only", async () => {
      const path = `/costing/batches/${doughBatch.id}`;
      expect((await error(await as(marcus.cookie).get(path), 403)).code).toBe("module_forbidden");
      await grant("costing", "read");
      // Costing depends on recipes, production and purchasing (and through them items, stock, demand).
      expect((await error(await as(marcus.cookie).get(path), 403)).code).toBe("module_forbidden");
      for (const id of ["items", "recipes", "stock", "demand", "production", "purchasing"])
        await grant(id, "read");
      await ok(await as(marcus.cookie).get(path));
      await ok(await as(marcus.cookie).get("/costing/report"));
      // Production readers without a costing grant don't see costs.
      await grant("costing", null);
      expect((await error(await as(marcus.cookie).get("/costing/report"), 403)).code).toBe(
        "module_forbidden",
      );
      // There is nothing to write.
      expect((await as(ada).send("POST", "/costing/batches", {})).status).toBe(404);
    });

    it("lets API tokens read", async () => {
      expect((await ok(await viaToken(`/costing/batches/${doughBatch.id}`))).actualCost).toBe(13.2);
    });

    it("is switched off with the module", async () => {
      const off = await makeApp({
        seed: true,
        activeModules: ["tasks", "docs", "items", "recipes", "stock", "demand", "production", "purchasing"],
      });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      expect((await error(await off.req(`${WS}/costing/report`, { cookie }), 404)).code).toBe(
        "module_inactive",
      );
      await off.handle.close();
    }, 60_000);
  });

  describe("batch cost", () => {
    it("values purchased lots at their receipt price and opening stock at standard, flagged", async () => {
      const cost = await ok(await as(ada).get(`/costing/batches/${doughBatch.id}`));
      expect(cost.batch).toMatchObject({
        id: doughBatch.id,
        batchCode: doughBatch.batchCode,
        status: "completed",
        completedOn: today,
        recipe: { code: "R-DGH" },
        recipeVersion: { versionNumber: 1 },
        outputItem: { code: "DGH" },
      });
      expect(cost).toMatchObject({
        actualCost: 13.2,
        estimatedCost: 1.2,
        estimatedPercent: 9.1,
        costComplete: true,
        provisional: false,
        planned: { base: 10_000, display: 10, displayUnit: "kg" },
        produced: { base: 9500, display: 9.5 },
        costPerUnit: 1.38947368,
        outputUnit: "kg",
        yield: { difference: { base: -500 }, percent: 95 },
        standard: {
          costPerUnit: 1.1,
          plannedCost: 11,
          producedCost: 10.45,
          inputsAtStandard: 11.5,
          complete: true,
        },
        variance: { price: 1.7, usage: 0.5, yield: 0.55, quantity: 1.05, total: 2.75 },
        variancePercent: 26.3,
      });
      const byItem = (code: string) =>
        cost.lines.find((l: { item: { code: string } }) => l.item.code === code);
      expect(byItem("FLR")).toMatchObject({
        source: "purchase",
        unitCost: 0.9,
        unit: "kg",
        cost: 5.4,
        quantity: { base: 6000, display: 6 },
        estimated: false,
        standardUnitCost: 0.8,
        sourceBatch: null,
      });
      expect(byItem("SUG")).toMatchObject({
        source: "standard",
        reason: "not_purchased",
        lotCode: "SUG-OPEN",
        unitCost: 1.2,
        estimated: true,
      });
      expect(byItem("EGG")).toMatchObject({ source: "purchase", unitCost: 0.3, cost: 6.6 });
      expect(cost.materials.find((m: { item: { code: string } }) => m.item.code === "EGG")).toMatchObject({
        required: { base: 20 },
        consumed: { base: 22 },
        priceVariance: 1.1,
        usageVariance: 0.5,
      });
    });

    it("carries a batch's cost per unit into the WIP it made", async () => {
      const cost = await ok(await as(ada).get(`/costing/batches/${breadBatch.id}`));
      expect(cost).toMatchObject({
        actualCost: 6.9474,
        estimatedPercent: 9.1,
        costPerUnit: 0.69473684,
        standard: { plannedCost: 7.5, costPerUnit: 0.75 },
        variance: { price: -0.5526, usage: 0, yield: 0, total: -0.5526 },
      });
      expect(cost.lines[0]).toMatchObject({
        source: "batch",
        unitCost: 1.38947368,
        sourceBatch: { id: doughBatch.id, batchCode: doughBatch.batchCode, status: "completed" },
      });
    });

    it("explains a lot's cost", async () => {
      expect(await ok(await as(ada).get(`/costing/lots/${flourLot}`))).toMatchObject({
        lot: { id: flourLot },
        item: { code: "FLR" },
        source: "purchase",
        unitCost: 0.9,
        standardCost: 0.8,
        receipts: [{ reference: poReference, unitPrice: 0.9, quantity: { display: 25 }, reversed: false }],
      });
      expect(await ok(await as(ada).get(`/costing/lots/${doughLot}`))).toMatchObject({
        source: "batch",
        sourceBatch: { batchCode: doughBatch.batchCode },
        unitCost: 1.38947368,
        estimated: true,
        receipts: [],
      });
      expect(await ok(await as(ada).get(`/costing/lots/${sugarLot}`))).toMatchObject({
        source: "standard",
        reason: "not_purchased",
      });
      expect(
        (await error(await as(ada).get("/costing/lots/00000000-0000-7000-8000-000000000000"), 404)).code,
      ).toBe("not_found");
    });

    it("is provisional while in progress, and nets off reversed consumption", async () => {
      const batch = await ok(
        await as(ada).send("POST", "/production/batches", {
          recipeId: doughRecipe,
          plannedOn: today,
          batches: 1,
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/production/batches/${batch.id}/start`));
      const consume = (quantity: number) =>
        as(ada).send("POST", `/production/batches/${batch.id}/consumption`, {
          lines: [{ lotId: flourLot, locationId: store, quantity, unit: "kg" }],
        });
      const first = await ok(await consume(1), 201);
      const record = first.records.find((r: { kind: string }) => r.kind === "consumption");
      await ok(
        await as(ada).send("POST", `/production/batches/${batch.id}/records/${record.id}/reverse`, {
          reason: "Wrong lot",
        }),
        201,
      );
      await ok(await consume(2), 201);
      const cost = await ok(await as(ada).get(`/costing/batches/${batch.id}`));
      expect(cost).toMatchObject({
        actualCost: 1.8,
        provisional: true,
        produced: { base: 0 },
        costPerUnit: null,
        lines: [{ quantity: { base: 2000 }, cost: 1.8 }],
      });
      const running = await ok(await as(ada).get("/costing/batches?status=in_progress"));
      expect(running.batches.map((b: { id: string }) => b.id)).toEqual([batch.id]);
      expect(running.batches[0]).toMatchObject({
        costingDate: today,
        cost: { actualCost: 1.8, provisional: true },
      });
      // A planned batch has nothing to cost: never listed.
      const planned = await ok(
        await as(ada).send("POST", "/production/batches", {
          recipeId: doughRecipe,
          plannedOn: today,
          batches: 1,
        }),
        201,
      );
      const all = await ok(await as(ada).get("/costing/batches?status=all"));
      expect(all.batches.map((b: { id: string }) => b.id)).not.toContain(planned.id);
      expect(all.total).toBe(3);
    });
  });

  describe("lists and reports", () => {
    it("lists completed batches with their headline cost", async () => {
      const list = await ok(await as(ada).get(`/costing/batches?from=${today}&to=${today}`));
      expect(list.total).toBe(2);
      const dough = list.batches.find((b: { id: string }) => b.id === doughBatch.id);
      expect(dough).toMatchObject({
        batchCode: doughBatch.batchCode,
        recipe: { code: "R-DGH" },
        costingDate: today,
        cost: {
          actualCost: 13.2,
          estimatedPercent: 9.1,
          yieldPercent: 95,
          costPerUnit: 1.38947368,
          standardCostPerUnit: 1.1,
          standardCost: 10.45,
          variance: 2.75,
          variancePercent: 26.3,
        },
      });
      const filtered = await ok(await as(ada).get(`/costing/batches?outputItemId=${bread}`));
      expect(filtered.batches.map((b: { id: string }) => b.id)).toEqual([breadBatch.id]);
      expect((await ok(await as(ada).get("/costing/batches?q=R-BRD"))).total).toBe(1);
    });

    it("orders by the costing date: the completion's date in the workspace zone against planned dates", async () => {
      const db = ctx.handle.db;
      const [breadRow] = await db
        .select()
        .from(productionBatches)
        .where(eq(productionBatches.id, breadBatch.id));
      const [doughRow] = await db
        .select()
        .from(productionBatches)
        .where(eq(productionBatches.id, doughBatch.id));
      const zone = await ok(await as(ada).send("PATCH", "/settings", { timeZone: "Pacific/Kiritimati" }));
      expect(zone.timeZone).toBe("Pacific/Kiritimati");
      try {
        // Bread completed at 23:30 UTC on the 10th: the 11th in Kiritimati (UTC+14). Dough is still in
        // progress, planned for the 11th. Same costing date, so the batch code breaks the tie (bread's
        // is higher); by instant the dough's midnight UTC on the 11th would have sorted first.
        await db
          .update(productionBatches)
          .set({ completedAt: new Date("2026-03-10T23:30:00Z") })
          .where(eq(productionBatches.id, breadBatch.id));
        await db
          .update(productionBatches)
          .set({ status: "in_progress", completedAt: null, plannedOn: "2026-03-11" })
          .where(eq(productionBatches.id, doughBatch.id));
        const list = await ok(await as(ada).get("/costing/batches?status=all"));
        const ours = list.batches.filter((b: { id: string }) =>
          [breadBatch.id, doughBatch.id].includes(b.id),
        );
        expect(ours.map((b: { id: string }) => b.id)).toEqual([breadBatch.id, doughBatch.id]);
        expect(ours.map((b: { costingDate: string }) => b.costingDate)).toEqual(["2026-03-11", "2026-03-11"]);
      } finally {
        await db
          .update(productionBatches)
          .set({ completedAt: breadRow!.completedAt })
          .where(eq(productionBatches.id, breadBatch.id));
        await db
          .update(productionBatches)
          .set({
            status: doughRow!.status,
            completedAt: doughRow!.completedAt,
            plannedOn: doughRow!.plannedOn,
          })
          .where(eq(productionBatches.id, doughBatch.id));
        await ok(await as(ada).send("PATCH", "/settings", { timeZone: DEFAULT_TIME_ZONE }));
      }
    });

    it("reports standard against actual by product and period", async () => {
      const report = await ok(await as(ada).get("/costing/report?period=week"));
      const week = costingPeriodStart(today, "week");
      expect(report).toMatchObject({ period: "week", to: costingPeriodEnd(today, "week") });
      expect(report.periods.at(-1)).toMatchObject({
        periodStart: week,
        period: costingPeriodLabel(week, "week"),
        totals: { batches: 2, incompleteBatches: 0, actualCost: 20.1474 },
      });
      expect(report.rows.map((r: { item: { code: string } }) => r.item.code)).toEqual(["BRD", "DGH"]);
      expect(report.rows[1]).toMatchObject({
        periodStart: week,
        batches: 1,
        planned: { display: 10 },
        produced: { display: 9.5 },
        yieldPercent: 95,
        actualCost: 13.2,
        standardCost: 10.45,
        costPerUnit: 1.38947368,
        standardCostPerUnit: 1.1,
        variance: { price: 1.7, usage: 0.5, yield: 0.55, quantity: 1.05, total: 2.75 },
      });
      expect(report.totals).toMatchObject({ batches: 2, variance: { total: 2.1974 } });

      const month = await ok(
        await as(ada).get(`/costing/report?from=${today.slice(0, 7)}&outputItemId=${dough}`),
      );
      expect(month).toMatchObject({ period: "month", from: `${today.slice(0, 7)}-01` });
      expect(month.rows.map((r: { item: { code: string } }) => r.item.code)).toEqual(["DGH"]);
      const byRecipe = await ok(await as(ada).get(`/costing/report?recipeId=${breadRecipe}`));
      expect(byRecipe.rows.map((r: { item: { code: string } }) => r.item.code)).toEqual(["BRD"]);
    });

    it("refuses bounds it can't read and windows over two years", async () => {
      expect((await error(await as(ada).get("/costing/report?from=soon"), 400)).message).toMatch(
        /not a date/,
      );
      expect(
        (await error(await as(ada).get("/costing/report?from=2020-01&to=2026-12"), 400)).message,
      ).toMatch(/two years/);
      expect((await error(await as(ada).get("/costing/report?period=year"), 400)).code).toBe("invalid_input");
    });
  });
});
