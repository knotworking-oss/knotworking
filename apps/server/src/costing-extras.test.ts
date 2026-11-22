import {
  DEFAULT_TIME_ZONE,
  addDays,
  costingPeriodEnd,
  costingPeriodStart,
  todayInZone,
} from "@knotworking/core";
import { costingPeriodCloses, productionBatches } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

/**
 * Costing's second half: the workspace currency, standard cost history, mix variance, absorbed
 * labour and overhead, the stock valuation, waste and adjustment costs, closing a period and the
 * accounting CSV. One batch (backdated into last month so the period can be closed) carries most.
 */
describe("costing: periods, history and valuation", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const today = todayInZone(DEFAULT_TIME_ZONE);
  const thisMonth = costingPeriodStart(today, "month");
  const lastMonthStart = costingPeriodStart(addDays(thisMonth, -1), "month");
  const lastMonth = lastMonthStart.slice(0, 7);
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, json, headers: { authorization: `Bearer ${token}`, origin: "" } });
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

  let flour: string;
  let sugar: string;
  let eggs: string;
  let dough: string;
  let store: string;
  let flourLot: string;
  let batchId: string;
  let doughLot: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    marcus = {
      userId: members.find((x: { email: string }) => x.email === "marcus@knotworking.dev").userId,
      cookie: (await signIn(ctx, "marcus@knotworking.dev")).cookie,
    };
    token = (
      await ok(
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write" },
        }),
        201,
      )
    ).token;

    const mill = (await ok(await as(ada).send("POST", "/suppliers", { name: "Mill" }), 201)).id;
    await ok(await as(ada).send("POST", `/suppliers/${mill}/approval`, { status: "approved" }));
    const item = async (body: object) => (await ok(await as(ada).send("POST", "/items", body), 201)).id;
    flour = await item({ code: "FLR", name: "Flour", type: "ingredient", unit: "kg", standardCost: 0.8 });
    sugar = await item({ code: "SUG", name: "Sugar", type: "ingredient", unit: "kg", standardCost: 1.2 });
    eggs = await item({ code: "EGG", name: "Eggs", type: "ingredient", unit: "each", standardCost: 0.25 });
    dough = await item({ code: "DGH", name: "Dough", type: "wip", unit: "kg", standardCost: 1.5 });
    store = (await ok(await as(ada).send("POST", "/stock/locations", { name: "Store" }), 201)).id;
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
    const eggLot = lotOf(eggs);
    const sugarLot = (
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
    const recipeId = (
      await ok(
        await as(ada).send("POST", "/recipes", {
          code: "R-DGH",
          name: "Dough",
          outputItemId: dough,
          draft: {
            yieldQuantity: 10,
            yieldUnit: "kg",
            lines: [
              { itemId: flour, quantity: 6, unit: "kg" },
              { itemId: sugar, quantity: 1, unit: "kg" },
              { itemId: eggs, quantity: 20, unit: "each" },
            ],
          },
        }),
        201,
      )
    ).id;
    await ok(await as(ada).send("POST", `/recipes/${recipeId}/draft/approve`));
    const batch = await ok(
      await as(ada).send("POST", "/production/batches", {
        recipeId,
        plannedOn: today,
        batches: 1,
        outputLocationId: store,
      }),
      201,
    );
    batchId = batch.id;
    await ok(await as(ada).send("POST", `/production/batches/${batchId}/start`));
    // The plan is 6 kg flour and 1 kg sugar; this batch used 5 and 2: the same total, another mix.
    await ok(
      await as(ada).send("POST", `/production/batches/${batchId}/consumption`, {
        lines: [
          { lotId: flourLot, quantity: 5, unit: "kg", locationId: store },
          { lotId: sugarLot, quantity: 2, unit: "kg", locationId: store },
          { lotId: eggLot, quantity: 20, unit: "each", locationId: store },
        ],
      }),
      201,
    );
    const made = await ok(
      await as(ada).send("POST", `/production/batches/${batchId}/output`, { quantity: 10, unit: "kg" }),
      201,
    );
    doughLot = made.outputs[0].lotId;
    await ok(await as(ada).send("POST", `/production/batches/${batchId}/complete`, {}));
    // Into last month, so that period has ended: ran three hours.
    await ctx.handle.db
      .update(productionBatches)
      .set({
        startedAt: new Date(`${lastMonth}-15T09:00:00Z`),
        completedAt: new Date(`${lastMonth}-15T12:00:00Z`),
      })
      .where(eq(productionBatches.id, batchId));
  }, 120_000);
  afterAll(() => ctx.handle.close());

  describe("the financial year start month", () => {
    it("defaults to January, is changed by owners and admins only, and is on the bootstrap", async () => {
      expect(await ok(await as(marcus.cookie).get("/settings"))).toMatchObject({
        financialYearStartMonth: 1,
      });
      expect(
        (await error(await as(marcus.cookie).send("PATCH", "/settings", { financialYearStartMonth: 4 }), 403))
          .code,
      ).toBe("forbidden");
      expect((await viaToken("PATCH", "/settings", { financialYearStartMonth: 4 })).status).toBe(403);
      for (const bad of [0, 13, 4.5, "4"]) {
        expect(
          (await error(await as(ada).send("PATCH", "/settings", { financialYearStartMonth: bad }), 400)).code,
        ).toBe("invalid_input");
      }
      expect(
        await ok(await as(ada).send("PATCH", "/settings", { financialYearStartMonth: 4 })),
      ).toMatchObject({
        financialYearStartMonth: 4,
        currency: "GBP",
      });
      expect((await ok(await as(ada).get("/bootstrap"))).workspace.financialYearStartMonth).toBe(4);
      await ok(await as(ada).send("PATCH", "/settings", { financialYearStartMonth: 1 }));
    });
  });

  describe("the workspace currency", () => {
    it("defaults to GBP, is changed by owners and admins only, and is on the bootstrap", async () => {
      expect(await ok(await as(marcus.cookie).get("/settings"))).toMatchObject({ currency: "GBP" });
      expect((await ok(await as(ada).get("/bootstrap"))).workspace.currency).toBe("GBP");
      expect(
        (await error(await as(marcus.cookie).send("PATCH", "/settings", { currency: "EUR" }), 403)).code,
      ).toBe("forbidden");
      expect((await viaToken("PATCH", "/settings", { currency: "EUR" })).status).toBe(403);
      expect((await error(await as(ada).send("PATCH", "/settings", { currency: "ZZZ" }), 400)).code).toBe(
        "invalid_input",
      );
      expect((await error(await as(ada).send("PATCH", "/settings", { currency: "pounds" }), 400)).code).toBe(
        "invalid_input",
      );
      expect(await ok(await as(ada).send("PATCH", "/settings", { currency: "eur" }))).toMatchObject({
        currency: "EUR",
        timeZone: DEFAULT_TIME_ZONE,
      });
      expect((await ok(await as(ada).get("/bootstrap"))).workspace.currency).toBe("EUR");
      await ok(await as(ada).send("PATCH", "/settings", { currency: "GBP" }));
    });
  });

  describe("standard cost history", () => {
    it("keeps a changed standard cost with the day it took effect", async () => {
      const before = await ok(await as(ada).get(`/costing/standard-costs/${flour}`));
      expect(before.entries).toEqual([]);
      await ok(await as(ada).send("PATCH", `/items/${flour}`, { standardCost: 0.85 }));
      const after = await ok(await as(ada).get(`/costing/standard-costs/${flour}`));
      expect(after.entries).toMatchObject([{ effectiveFrom: today, cost: 0.85 }]);
      await ok(await as(ada).send("PATCH", `/items/${flour}`, { standardCost: 0.8 }));
      expect((await ok(await as(ada).get(`/costing/standard-costs/${flour}`))).entries).toMatchObject([
        { effectiveFrom: today, cost: 0.8 },
      ]);
    });

    it("prices the standard side of a batch at the cost in force on its completion date", async () => {
      const now = await ok(await as(ada).get(`/costing/batches/${batchId}`));
      // Plan 6 kg flour (0.80), 1 kg sugar (1.20), 20 eggs (0.25) = 11.00 at today's standard costs.
      expect(now.standard).toMatchObject({ plannedCost: 11, producedCost: 11 });
      expect(now.actualCost).toBe(12.9);
      expect(now.variance).toMatchObject({ price: 1.5, usage: 0.4, total: 1.9 });

      // Flour was 0.70 from the start of last month until today's change.
      const history = await ok(
        await as(ada).send("PUT", "/costing/standard-costs", {
          itemId: flour,
          effectiveFrom: lastMonthStart,
          cost: 0.7,
          note: "Last year's price list",
        }),
      );
      expect(
        history.entries.map((e: { effectiveFrom: string; cost: number }) => [e.effectiveFrom, e.cost]),
      ).toEqual([
        [today, 0.8],
        [lastMonthStart, 0.7],
      ]);
      // The item's own (current) cost is the one in force today.
      expect((await ok(await as(ada).get(`/items/${flour}`))).standardCost).toBe(0.8);

      const then = await ok(await as(ada).get(`/costing/batches/${batchId}`));
      expect(then.standard).toMatchObject({ plannedCost: 10.4, producedCost: 10.4, inputsAtStandard: 10.9 });
      expect(then.variance).toMatchObject({ price: 2, usage: 0.5, yield: 0, total: 2.5 });
    });

    it("refuses future dates, a bad item, and API tokens; and needs manage", async () => {
      const tomorrow = addDays(today, 1);
      expect(
        (
          await error(
            await as(ada).send("PUT", "/costing/standard-costs", {
              itemId: flour,
              effectiveFrom: tomorrow,
              cost: 1,
            }),
            400,
          )
        ).message,
      ).toMatch(/future/);
      expect(
        (
          await error(
            await as(ada).send("PUT", "/costing/standard-costs", {
              itemId: crypto.randomUUID(),
              effectiveFrom: today,
              cost: 1,
            }),
            404,
          )
        ).code,
      ).toBe("not_found");
      expect(
        (await viaToken("PUT", "/costing/standard-costs", { itemId: flour, effectiveFrom: today, cost: 1 }))
          .status,
      ).toBe(403);
      expect((await viaToken("GET", `/costing/standard-costs/${flour}`)).status).toBe(200);
    });
  });

  describe("mix variance", () => {
    it("splits the usage variance into mix and total input, apart from yield", async () => {
      const cost = await ok(await as(ada).get(`/costing/batches/${batchId}`));
      // Used 5 kg flour and 2 kg sugar for a plan of 6 and 1: more of the dearer one, same total.
      expect(cost.variance).toMatchObject({ usage: 0.5, mix: 0.5, inputQuantity: 0, yield: 0 });
      const byItem = Object.fromEntries(
        cost.materials.map((m: { item: { code: string }; mixVariance: number }) => [
          m.item.code,
          m.mixVariance,
        ]),
      );
      expect(byItem).toMatchObject({ FLR: -0.7, SUG: 1.2, EGG: 0 });
    });
  });

  describe("labour and overhead", () => {
    it("is absorbed per batch hour and per kilogram, apart from materials", async () => {
      expect((await ok(await as(ada).get(`/costing/batches/${batchId}`))).conversion).toMatchObject({
        rated: false,
        total: 0,
      });
      const set = await ok(
        await as(ada).send("PUT", "/costing/rates", {
          lineId: null,
          effectiveFrom: lastMonthStart,
          labourPerHour: 10,
          labourPerKg: 0.5,
          overheadPerHour: 4,
        }),
      );
      expect(set.rates).toHaveLength(1);
      // Replacing the same date edits it rather than adding another.
      expect(
        (
          await ok(
            await as(ada).send("PUT", "/costing/rates", {
              effectiveFrom: lastMonthStart,
              labourPerHour: 10,
              labourPerKg: 0.5,
              overheadPerHour: 4,
            }),
          )
        ).rates,
      ).toHaveLength(1);
      const cost = await ok(await as(ada).get(`/costing/batches/${batchId}`));
      // 3 hours and 10 kg: labour 30 + 5, overhead 12. Materials are unchanged.
      expect(cost.conversion).toMatchObject({
        hours: 3,
        kg: 10,
        labour: 35,
        overhead: 12,
        total: 47,
        complete: true,
      });
      expect(cost.actualCost).toBe(12.9);

      const report = await ok(await as(ada).get(`/costing/report?from=${lastMonth}&to=${lastMonth}`));
      expect(report.totals).toMatchObject({
        actualCost: 12.9,
        conversion: { labour: 35, overhead: 12, total: 47 },
        totalCost: 59.9,
      });
      expect(report.rows[0]).toMatchObject({ conversion: { labour: 35, overhead: 12 } });
    });

    it("needs a real line, a person and manage", async () => {
      expect(
        (
          await error(
            await as(ada).send("PUT", "/costing/rates", {
              lineId: crypto.randomUUID(),
              effectiveFrom: today,
              labourPerHour: 1,
            }),
            404,
          )
        ).code,
      ).toBe("not_found");
      expect(
        (await viaToken("PUT", "/costing/rates", { effectiveFrom: today, labourPerHour: 1 })).status,
      ).toBe(403);
      expect((await viaToken("GET", "/costing/rates")).status).toBe(200);
      expect(
        (
          await error(
            await as(ada).send("PUT", "/costing/rates", { effectiveFrom: today, labourPerHour: -1 }),
            400,
          )
        ).code,
      ).toBe("invalid_input");
    });
  });

  describe("stock valuation", () => {
    it("values stock on hand at lot cost, with estimates flagged, and exports it", async () => {
      const v = await ok(await as(ada).get("/costing/valuation"));
      const lot = (code: string) => v.lots.find((l: { item: { code: string } }) => l.item.code === code);
      // 20 kg flour at 0.90, 3 kg sugar at its 1.20 standard (opening stock), 160 eggs at 0.30,
      // 10 kg dough at the batch's 12.90 ÷ 10.
      expect(lot("FLR")).toMatchObject({ value: 18, source: "purchase" });
      expect(lot("SUG")).toMatchObject({ value: 3.6, source: "standard", estimatedPercent: 100 });
      expect(lot("EGG")).toMatchObject({ value: 48 });
      expect(lot("DGH")).toMatchObject({ value: 12.9, source: "batch" });
      expect(v.totals).toMatchObject({ value: 82.5, unvaluedLots: 0, lots: 4 });
      expect(v.totals.estimatedValue).toBeCloseTo(6, 2);
      expect(v.items.map((i: { item: { code: string } }) => i.item.code)).toEqual([
        "DGH",
        "EGG",
        "FLR",
        "SUG",
      ]);
      expect((await ok(await as(ada).get("/costing/valuation?itemType=ingredient"))).totals.lots).toBe(3);
      expect((await ok(await as(ada).get("/costing/valuation?q=flour"))).lots).toHaveLength(1);

      const res = await as(ada).get("/costing/export.csv?kind=valuation");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/csv/);
      expect(res.headers.get("content-disposition")).toMatch(/stock-valuation-/);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // a byte order mark, for Excel
      const csv = new TextDecoder().decode(bytes);
      expect(csv).toContain("Product code,Product,Lot");
      expect(csv).toMatch(
        new RegExp(`${today},FLR,Flour,[^,]+,[a-z]+,${today},,20,kg,0.9,18,purchase,0,GBP`),
      );
    });
  });

  describe("waste and adjustments", () => {
    it("costs what was written off in a period, in the report and on its own", async () => {
      await ok(
        await as(ada).send("POST", "/stock/waste", {
          lotId: flourLot,
          locationId: store,
          quantity: 2,
          unit: "kg",
          reason: "Spilled",
        }),
        201,
      );
      await ok(
        await as(ada).send("POST", "/stock/adjustments", {
          lotId: flourLot,
          locationId: store,
          quantity: 1,
          unit: "kg",
          reason: "Found on a shelf",
        }),
        201,
      );
      const a = await ok(await as(ada).get(`/costing/adjustments?from=${thisMonth}`));
      expect(a.totals).toMatchObject({
        waste: 1.8,
        adjustment: -0.9,
        stocktake: 0,
        total: 0.9,
        incomplete: false,
      });
      expect(a.lines.map((l: { type: string; loss: number }) => [l.type, l.loss])).toEqual([
        ["waste", 1.8],
        ["adjustment", -0.9],
      ]);
      expect(a.lines[0]).toMatchObject({ item: { code: "FLR" }, amount: { display: -2 } });
      const report = await ok(await as(ada).get(`/costing/report?from=${thisMonth}`));
      const current = report.periods.find((p: { periodStart: string }) => p.periodStart === thisMonth);
      expect(current.adjustments).toMatchObject({ waste: 1.8, adjustment: -0.9, total: 0.9 });
      expect(report.adjustments.total).toBe(0.9);
      const csv = await (await as(ada).get(`/costing/export.csv?kind=adjustments&from=${thisMonth}`)).text();
      expect(csv).toContain("Waste,FLR,Flour,-2,kg,1,1.8,0,GBP");
    });
  });

  describe("closing a period", () => {
    let closeId: string;

    it("refuses a period that hasn't ended, tokens, and anyone below manage", async () => {
      expect(
        (await error(await as(ada).send("POST", "/costing/closes", { period: "month", of: today }), 409))
          .code,
      ).toBe("period_not_ended");
      expect((await viaToken("POST", "/costing/closes", { period: "month", of: lastMonth })).status).toBe(
        403,
      );
      for (const id of ["items", "recipes", "stock", "demand", "production", "purchasing"])
        await ok(
          await ctx.req(`${WS}/members/${marcus.userId}/module-access/${id}`, {
            method: "PUT",
            cookie: ada,
            json: { level: "read" },
          }),
        );
      await ok(
        await ctx.req(`${WS}/members/${marcus.userId}/module-access/costing`, {
          method: "PUT",
          cookie: ada,
          json: { level: "write" },
        }),
      );
      expect(
        (
          await error(
            await as(marcus.cookie).send("POST", "/costing/closes", { period: "month", of: lastMonth }),
            403,
          )
        ).code,
      ).toBe("module_forbidden");
      await ok(await as(marcus.cookie).get("/costing/closes"));
      expect(
        (await error(await as(ada).send("POST", "/costing/closes", { period: "month", of: "never" }), 400))
          .message,
      ).toMatch(/not a date/);
    });

    it("freezes the period's figures, and the report shows them frozen while live ones move", async () => {
      const closed = await ok(
        await as(ada).send("POST", "/costing/closes", { period: "month", of: lastMonth, note: "Month end" }),
        201,
      );
      closeId = closed.id;
      expect(closed).toMatchObject({
        status: "closed",
        period: "month",
        periodStart: lastMonthStart,
        periodEnd: costingPeriodEnd(lastMonthStart, "month"),
        note: "Month end",
        summary: {
          batches: 1,
          materialCost: 12.9,
          labourCost: 35,
          overheadCost: 12,
          totalCost: 59.9,
          variance: 2.5,
        },
        snapshot: {
          currency: "GBP",
          batches: [{ batchCode: expect.any(String), actualCost: 12.9, labour: 35 }],
        },
      });
      expect(closed.closedByName).toBeTruthy();
      expect(closed.snapshot.rows[0]).toMatchObject({ item: { code: "DGH" }, actualCost: 12.9 });
      expect(
        (await error(await as(ada).send("POST", "/costing/closes", { period: "month", of: lastMonth }), 409))
          .code,
      ).toBe("period_closed");

      // Flour's standard cost for last month is corrected: live figures move, the closed ones don't.
      await ok(
        await as(ada).send("PUT", "/costing/standard-costs", {
          itemId: flour,
          effectiveFrom: lastMonthStart,
          cost: 0.6,
        }),
      );
      const live = await ok(await as(ada).get(`/costing/batches/${batchId}`));
      expect(live.variance.total).toBe(3.1);
      const report = await ok(await as(ada).get(`/costing/report?from=${lastMonth}&to=${lastMonth}`));
      const period = report.periods[0];
      expect(period.frozen).toMatchObject({
        closeId,
        closedBy: { name: expect.any(String) },
        note: "Month end",
      });
      expect(period.frozen.drift.changed).toBe(true);
      expect(period.totals.variance.total).toBe(2.5);
      expect(report.totals.variance.total).toBe(2.5);
      expect(report.rows[0].variance.total).toBe(2.5);
      // A product filter shows live figures (a close is for the whole period).
      const filtered = await ok(
        await as(ada).get(`/costing/report?from=${lastMonth}&to=${lastMonth}&outputItemId=${dough}`),
      );
      expect(filtered.periods[0].frozen).toBeNull();
      expect(filtered.totals.variance.total).toBe(3.1);

      // The accounting CSV carries the frozen figures and says so.
      const csv = await (await as(ada).get(`/costing/export.csv?from=${lastMonth}&to=${lastMonth}`)).text();
      expect(csv).toContain(`COST-${lastMonth},Materials,DGH,Dough,10,kg,1,12.9,GBP,Closed`);
      expect(csv).toContain("Labour absorbed,DGH,Dough,10,kg,1,35,GBP,Closed");
      const batches = await (
        await as(ada).get(`/costing/export.csv?kind=batches&from=${lastMonth}&to=${lastMonth}`)
      ).text();
      expect(batches).toMatch(/,10,kg,12.9,35,12,59.9,10.4,2.5,Yes,GBP/);
    });

    it("lists closes and reads one, without the snapshot in the list", async () => {
      const list = await ok(await as(ada).get("/costing/closes"));
      expect(list.closes).toHaveLength(1);
      expect(list.closes[0]).not.toHaveProperty("snapshot");
      expect(list.closes[0]).toMatchObject({ id: closeId, closedByName: expect.any(String) });
      expect((await ok(await viaToken("GET", `/costing/closes/${closeId}`))).snapshot.batches).toHaveLength(
        1,
      );
    });

    it("is reopened by a person with manage and a reason, and the close stays on record", async () => {
      expect(
        (await error(await as(ada).send("POST", `/costing/closes/${closeId}/reopen`, { reason: "" }), 400))
          .code,
      ).toBe("invalid_input");
      expect(
        (await viaToken("POST", `/costing/closes/${closeId}/reopen`, { reason: "Because" })).status,
      ).toBe(403);
      expect(
        (await as(marcus.cookie).send("POST", `/costing/closes/${closeId}/reopen`, { reason: "Because" }))
          .status,
      ).toBe(403);
      const reopened = await ok(
        await as(ada).send("POST", `/costing/closes/${closeId}/reopen`, { reason: "Flour price corrected" }),
      );
      expect(reopened).toMatchObject({
        status: "reopened",
        reopenReason: "Flour price corrected",
        reopenedByName: expect.any(String),
      });
      expect(
        (
          await error(
            await as(ada).send("POST", `/costing/closes/${closeId}/reopen`, { reason: "Again" }),
            409,
          )
        ).code,
      ).toBe("not_closed");
      const report = await ok(await as(ada).get(`/costing/report?from=${lastMonth}&to=${lastMonth}`));
      expect(report.periods[0].frozen).toBeNull();
      expect(report.totals.variance.total).toBe(3.1);
      // Closing again adds a new close; both stay in the history.
      const again = await ok(
        await as(ada).send("POST", "/costing/closes", { period: "month", of: lastMonth }),
        201,
      );
      expect(again.summary.variance).toBe(3.1);
      const list = await ok(await as(ada).get("/costing/closes"));
      expect(list.closes.map((c: { status: string }) => c.status).sort()).toEqual(["closed", "reopened"]);
      expect(await ctx.handle.db.select().from(costingPeriodCloses)).toHaveLength(2);
    });

    it("writes the close to the sync log without its snapshot", async () => {
      const sync = await ok(await as(ada).get("/sync?cursor=0&limit=1000"));
      const closes = sync.changes.filter((c: { entity: string }) => c.entity === "costing_period_close");
      expect(closes.length).toBeGreaterThanOrEqual(2);
      expect(closes[0].data).toMatchObject({ summary: { batches: 1 } });
      expect(closes[0].data).not.toHaveProperty("snapshot");
      expect(sync.changes.some((c: { entity: string }) => c.entity === "costing_standard_cost")).toBe(true);
      expect(sync.changes.some((c: { entity: string }) => c.entity === "costing_absorption_rate")).toBe(true);
    });

    it("asks for an acknowledgement when batches in the period have gaps", async () => {
      // An item with no cost at all leaves a batch incomplete: here, the dough batch's sugar lot.
      const db = ctx.handle.db;
      await ok(
        await as(ada).send(
          "POST",
          `/costing/closes/${(await ok(await as(ada).get("/costing/closes?status=closed"))).closes[0].id}/reopen`,
          { reason: "Test gaps" },
        ),
      );
      await ok(await as(ada).send("PATCH", `/items/${sugar}`, { standardCost: null }));
      await ok(
        await as(ada).send("PUT", "/costing/standard-costs", {
          itemId: sugar,
          effectiveFrom: lastMonthStart,
          cost: null,
        }),
      );
      const err = await error(
        await as(ada).send("POST", "/costing/closes", { period: "month", of: lastMonth }),
        409,
      );
      expect(err.code).toBe("period_has_gaps");
      const forced = await ok(
        await as(ada).send("POST", "/costing/closes", {
          period: "month",
          of: lastMonth,
          acknowledgeGaps: true,
        }),
        201,
      );
      expect(forced.summary.incompleteBatches).toBe(1);
      void db;
      void doughLot;
    });
  });
});
