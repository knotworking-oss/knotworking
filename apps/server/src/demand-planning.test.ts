import { addWeeks, DEFAULT_TIME_ZONE, todayInZone, weekStart } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const W0 = weekStart(todayInZone(DEFAULT_TIME_ZONE));

describe("demand: units of sale, forecast and coverage", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const ok = async (res: Awaited<ReturnType<TestCtx["req"]>>, status = 200) => {
    const body = res.status === 204 ? null : await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const grant = (moduleId: string, level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
  let bar: string;
  let cake: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    const item = async (body: object) => (await ok(await as(ada).send("POST", "/items", body), 201)).id;
    bar = await item({ code: "BAR", name: "Oat bar", type: "finished", unit: "each" });
    cake = await item({ code: "CAKE", name: "Cake", type: "finished", unit: "each" });
    const flour = await item({ code: "FLR", name: "Flour", type: "ingredient", unit: "kg" });
    const r = await ok(
      await as(ada).send("POST", "/recipes", {
        code: "R-CAKE",
        name: "Cake",
        outputItemId: cake,
        draft: { yieldQuantity: 12, yieldUnit: "each", lines: [{ itemId: flour, quantity: 1, unit: "kg" }] },
      }),
      201,
    );
    await ok(await as(ada).send("POST", `/recipes/${r.id}/draft/approve`));
    // One batch of 12 cakes planned this week.
    await ok(
      await as(ada).send("POST", "/production/batches", { recipeId: r.id, plannedOn: W0, batches: 1 }),
      201,
    );
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("units of sale", () => {
    it("sets, resizes and removes pack units", async () => {
      const set = await ok(
        await as(ada).send("PUT", "/demand/pack-units", {
          packUnits: [
            { itemCode: "BAR", name: "case", size: 12 },
            { itemCode: "BAR", name: "Pallet", size: 600 },
          ],
        }),
      );
      expect(set.results.map((r: { action: string }) => r.action)).toEqual(["create", "create"]);
      const again = await ok(
        await as(ada).send("PUT", "/demand/pack-units", {
          packUnits: [{ itemCode: "BAR", name: "case", size: 12 }],
        }),
      );
      expect(again.results[0].action).toBe("unchanged");
      const list = await ok(await as(ada).get("/demand/pack-units?itemCode=BAR"));
      expect(list.packUnits.map((p: { name: string; size: number }) => [p.name, p.size])).toEqual([
        ["Pallet", 600],
        ["case", 12],
      ]);
    });

    it("refuses a pack named like a unit, and one for an ingredient", async () => {
      expect(
        (
          await as(ada).send("PUT", "/demand/pack-units", {
            packUnits: [{ itemCode: "BAR", name: "kg", size: 2 }],
          })
        ).status,
      ).toBe(400);
      const res = await as(ada).send("PUT", "/demand/pack-units", {
        packUnits: [{ itemCode: "FLR", name: "sack", size: 25 }],
      });
      expect(res.status).toBe(400);
    });

    it("stores demand entered in a pack in base units and keeps what was typed", async () => {
      const set = await ok(
        await as(ada).send("PUT", "/demand/lines", {
          lines: [{ itemCode: "BAR", period: W0, quantity: 5, unit: "Case" }],
        }),
      );
      const line = set.lines[0].line;
      expect(line.quantity).toBe(60);
      expect(line).toMatchObject({ enteredQuantity: 5, enteredUnit: "case" });
      // Same demand typed in each: the base quantity is unchanged, so nothing changes.
      const same = await ok(
        await as(ada).send("PUT", "/demand/lines", {
          lines: [{ itemCode: "BAR", period: W0, quantity: 60 }],
        }),
      );
      expect(same.unchanged).toBe(1);
      const history = await ok(await as(ada).get(`/demand/lines/${line.id}/history`));
      expect(history.history[0]).toMatchObject({ enteredQuantity: 5, enteredUnit: "case" });
      // A new quantity in plain units drops the pack note.
      const typed = await ok(
        await as(ada).send("PUT", "/demand/lines", {
          lines: [{ itemCode: "BAR", period: W0, quantity: 100 }],
        }),
      );
      expect(typed.lines[0].line).toMatchObject({ quantity: 100, enteredQuantity: null, enteredUnit: null });
      const bad = await as(ada).send("PUT", "/demand/lines", {
        lines: [{ itemCode: "BAR", period: W0, quantity: 1, unit: "tray" }],
      });
      expect(bad.status).toBe(400);
    });

    it("reads packs in a CSV import", async () => {
      const res = await ok(
        await as(ada).send("POST", "/demand/imports", {
          csv: `item,period,quantity,unit\nBAR,${addWeeks(W0, 1)},3,pallet\n`,
        }),
        201,
      );
      expect(res.created).toBe(1);
      const lines = await ok(
        await as(ada).get(`/demand/lines?itemCode=BAR&from=${addWeeks(W0, 1)}&to=${addWeeks(W0, 1)}`),
      );
      expect(lines.lines[0]).toMatchObject({ quantity: 1800, enteredQuantity: 3, enteredUnit: "Pallet" });
    });
  });

  describe("forecast", () => {
    it("averages past weeks, and copies only empty weeks as source forecast", async () => {
      const lines = [1, 2, 3, 4].map((i) => ({ itemCode: "CAKE", period: addWeeks(W0, -i), quantity: 100 }));
      await ok(await as(ada).send("PUT", "/demand/lines", { lines }));
      const f = await ok(await as(ada).get(`/demand/forecast?from=${W0}&to=${addWeeks(W0, 3)}&window=4`));
      const row = f.rows.find((r: { item: { code: string } }) => r.item.code === "CAKE");
      expect(row.periods.map((p: { quantity: { base: number } }) => p.quantity.base)).toEqual([
        100, 100, 100, 100,
      ]);
      expect(row.periods[0].explanation).toMatch(/Average of the last 4 weeks/);
      // A real order this week stays; the others are filled.
      await ok(
        await as(ada).send("PUT", "/demand/lines", {
          lines: [{ itemCode: "CAKE", period: W0, quantity: 7 }],
        }),
      );
      const applied = await ok(
        await as(ada).send("POST", "/demand/forecast/apply", {
          from: W0,
          to: addWeeks(W0, 3),
          window: 4,
          itemCode: "CAKE",
        }),
      );
      expect(applied.created).toBe(3);
      expect(applied.skipped).toEqual([expect.objectContaining({ reason: "Already has demand" })]);
      const written = await ok(await as(ada).get(`/demand/lines?itemCode=CAKE&source=forecast`));
      expect(written.total).toBe(3);
      // Forecast lines are not history: the forecast doesn't feed on itself.
      const after = await ok(
        await as(ada).get(`/demand/forecast?from=${W0}&to=${W0}&window=4&itemCode=CAKE`),
      );
      expect(after.rows[0].periods[0].quantity.base).toBe(100);
      // overwrite replaces them.
      const over = await ok(
        await as(ada).send("POST", "/demand/forecast/apply", {
          from: W0,
          to: W0,
          window: 4,
          itemCode: "CAKE",
          overwrite: true,
        }),
      );
      expect(over.updated).toBe(1);
    });

    it("forecasts and copies by customer without doubling a total", async () => {
      const lines = [1, 2].flatMap((i) => [
        { itemCode: "BAR", period: addWeeks(W0, -i), quantity: 10, customer: "Tesco" },
        { itemCode: "BAR", period: addWeeks(W0, -i), quantity: 30, customer: "Asda" },
      ]);
      await ok(await as(ada).send("PUT", "/demand/lines", { lines }));
      const target = addWeeks(W0, 5);
      await ok(
        await as(ada).send("PUT", "/demand/lines", {
          lines: [{ itemCode: "BAR", period: target, quantity: 1000 }],
        }),
      );
      const applied = await ok(
        await as(ada).send("POST", "/demand/forecast/apply", {
          from: addWeeks(W0, 4),
          to: target,
          window: 2,
          byCustomer: true,
          itemCode: "BAR",
        }),
      );
      // Week +4 gets both customers; week +5 already has a total without a customer.
      expect(applied.created).toBe(2);
      expect(applied.skipped.map((s: { reason: string }) => s.reason)).toEqual([
        "The week already has a total without a customer",
        "The week already has a total without a customer",
      ]);
      const totalMode = await ok(
        await as(ada).send("POST", "/demand/forecast/apply", {
          from: addWeeks(W0, 4),
          to: addWeeks(W0, 4),
          window: 2,
          itemCode: "BAR",
          overwrite: true,
        }),
      );
      expect(totalMode.created + totalMode.updated).toBe(0);
      expect(totalMode.skipped[0].reason).toMatch(/Customers already have demand/);
    });

    it("needs demand write to copy", async () => {
      await grant("items", "read");
      await grant("demand", "read");
      expect((await as(marcus.cookie).get(`/demand/forecast?itemCode=CAKE`)).status).toBe(200);
      expect((await as(marcus.cookie).send("POST", "/demand/forecast/apply", {})).status).toBe(403);
    });
  });

  describe("coverage", () => {
    it("counts planned batches for people who can read production, and leaves them out otherwise", async () => {
      const full = await ok(await as(ada).get(`/demand/coverage?itemCode=CAKE&to=${addWeeks(W0, 1)}`));
      expect(full.basis).toEqual({ stock: true, production: true });
      const row = full.rows[0];
      expect(row.stock.base).toBe(0);
      expect(row.periods[0]).toMatchObject({
        planned: expect.objectContaining({ base: 12 }),
        status: "short",
      });
      // Demand this week is 7 (a real order, then overwritten by forecast 100): 12 planned falls short.
      expect(row.periods[0].shortfall.base).toBeGreaterThan(0);

      const limited = await ok(
        await as(marcus.cookie).get(`/demand/coverage?itemCode=CAKE&to=${addWeeks(W0, 1)}`),
      );
      expect(limited.basis).toEqual({ stock: false, production: false });
      expect(limited.rows[0].planned).toBeUndefined();
      expect(limited.rows[0].periods[0]).toMatchObject({ planned: null, projected: null, status: "unknown" });
      expect(limited.rows[0].stock).toBeNull();

      await grant("stock", "read");
      const stockOnly = await ok(await as(marcus.cookie).get(`/demand/coverage?itemCode=CAKE`));
      expect(stockOnly.basis).toEqual({ stock: true, production: false });
      expect(stockOnly.rows[0].periods[0].planned).toBeNull();
    });
  });
});
