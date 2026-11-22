import { addDays, DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
const tomorrow = addDays(today, 1);

describe("production reservations, lines and scanning", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  const api = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const ok = async (res: Awaited<ReturnType<TestCtx["req"]>>, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const code = async (res: Awaited<ReturnType<TestCtx["req"]>>, status: number) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body.error.code as string;
  };
  const A = () => api(ada);

  let flour: string;
  let sugar: string;
  let cake: string;
  let recipe: string;
  let store: string;
  let early: string; // 2 kg, expires first
  let late: string; // 5 kg
  let held: string; // quarantine
  let sugarLot: string;

  const plan = async (body: object = {}) =>
    ok(
      await A().send("POST", "/production/batches", {
        recipeId: recipe,
        plannedOn: today,
        ...("outputQuantity" in body ? {} : { batches: 1 }),
        ...body,
      }),
      201,
    );
  const availability = async (itemId: string) =>
    (await ok(await A().get(`/production/availability?itemIds=${itemId}`))).items[0];

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    const item = async (body: object) => (await ok(await A().send("POST", "/items", body), 201)).id as string;
    flour = await item({ code: "FLR", name: "Flour", type: "ingredient", unit: "kg" });
    sugar = await item({ code: "SUG", name: "Sugar", type: "ingredient", unit: "kg" });
    cake = await item({ code: "CAKE", name: "Cake", type: "finished", unit: "each", unitWeightG: 450 });
    recipe = (
      await ok(
        await A().send("POST", "/recipes", {
          code: "R-CAKE",
          name: "Cake",
          outputItemId: cake,
          draft: {
            yieldQuantity: 12,
            yieldUnit: "each",
            lines: [
              { itemId: flour, quantity: 3, unit: "kg" },
              { itemId: sugar, quantity: 1, unit: "kg" },
            ],
          },
        }),
        201,
      )
    ).id;
    await ok(await A().send("POST", `/recipes/${recipe}/draft/approve`));
    store = (await ok(await A().send("POST", "/stock/locations", { name: "Dry store" }), 201)).id;
    const receive = async (body: object) =>
      (
        await ok(
          await A().send("POST", "/stock/receipts", { locationId: store, receivedOn: today, ...body }),
          201,
        )
      ).id as string;
    early = await receive({
      itemId: flour,
      quantity: 2,
      unit: "kg",
      lotCode: "FL-EARLY",
      expiresOn: addDays(today, 10),
      expiryType: "best_before",
    });
    late = await receive({
      itemId: flour,
      quantity: 5,
      unit: "kg",
      lotCode: "FL-LATE",
      expiresOn: addDays(today, 60),
      expiryType: "best_before",
    });
    held = await receive({
      itemId: flour,
      quantity: 9,
      unit: "kg",
      lotCode: "FL-HELD",
      status: "quarantine",
    });
    sugarLot = await receive({ itemId: sugar, quantity: 3, unit: "kg", lotCode: "SG-1" });
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("reservations", () => {
    it("reserves a lot, lowers availability and shows on the batch", async () => {
      expect((await availability(flour)).available.base).toBe(7000);
      const batch = await plan();
      const res = await ok(
        await A().send("POST", `/production/batches/${batch.id}/reservations`, {
          lines: [{ lotId: early, quantity: 1.5, unit: "kg" }],
        }),
        201,
      );
      expect(res.reservations).toHaveLength(1);
      expect(res.reservations[0]).toMatchObject({ lotCode: "FL-EARLY", status: "active" });
      expect(res.reservations[0].held.base).toBe(1500);
      expect(res.materials.find((m: { item: { id: string } }) => m.item.id === flour).reserved.base).toBe(
        1500,
      );
      const av = await availability(flour);
      expect(av.usable.base).toBe(7000);
      expect(av.reserved.base).toBe(1500);
      expect(av.available.base).toBe(5500);
      // Another batch can't take more of the lot than is free.
      const other = await plan();
      expect(
        await code(
          await A().send("POST", `/production/batches/${other.id}/reservations`, {
            lines: [{ lotId: early, quantity: 1, unit: "kg" }],
          }),
          409,
        ),
      ).toBe("insufficient_unreserved_stock");
      // FEFO picking skips what is held: 0.5 kg of the early lot, then the late one.
      const pick = await ok(await A().get(`/production/batches/${other.id}/pick`));
      const flourPick = pick.materials.find((m: { item: { id: string } }) => m.item.id === flour);
      expect(flourPick.allocations.map((a: { lotCode: string }) => a.lotCode)).toEqual([
        "FL-EARLY",
        "FL-LATE",
      ]);
      expect(flourPick.allocations[0].amount.base).toBe(500);
      // Release by hand frees the stock.
      const rel = await ok(
        await A().send("POST", `/production/reservations/${res.reservations[0].id}/release`, {
          note: "Changed plan",
        }),
      );
      expect(rel.reservations[0]).toMatchObject({ status: "released", releaseReason: "manual" });
      expect((await availability(flour)).available.base).toBe(7000);
      expect(
        await code(
          await A().send("POST", `/production/reservations/${res.reservations[0].id}/release`, {}),
          409,
        ),
      ).toBe("reservation_released");
      await A().send("POST", `/production/batches/${batch.id}/cancel`, { reason: "test" });
      await A().send("POST", `/production/batches/${other.id}/cancel`, { reason: "test" });
    });

    it("picks an item's quantity first expired first out, never from quarantine", async () => {
      const batch = await plan();
      const res = await ok(
        await A().send("POST", `/production/batches/${batch.id}/reservations`, { allOutstanding: true }),
        201,
      );
      const flourRows = res.reservations.filter((r: { item: { id: string } }) => r.item.id === flour);
      expect(flourRows.map((r: { lotCode: string }) => r.lotCode).sort()).toEqual(["FL-EARLY", "FL-LATE"]);
      expect(flourRows.reduce((t: number, r: { held: { base: number } }) => t + r.held.base, 0)).toBe(3000);
      expect(res.shortfalls).toEqual([]);
      // The batch needs 3 kg flour and holds 3 kg: reserving more is refused.
      expect(
        await code(
          await A().send("POST", `/production/batches/${batch.id}/reservations`, {
            lines: [{ lotId: late, quantity: 1, unit: "kg" }],
          }),
          409,
        ),
      ).toBe("over_reserved");
      expect(
        await code(
          await A().send("POST", `/production/batches/${batch.id}/reservations`, {
            lines: [{ lotId: held, quantity: 1, unit: "kg" }],
          }),
          409,
        ),
      ).toBe("lot_not_available");
      await A().send("POST", `/production/batches/${batch.id}/cancel`, { reason: "test" });
    });

    it("is fulfilled by consumption, released on completion, and consumption works without one", async () => {
      const batch = await plan();
      await ok(
        await A().send("POST", `/production/batches/${batch.id}/reservations`, {
          lines: [
            { lotId: late, quantity: 3, unit: "kg" },
            { lotId: sugarLot, quantity: 1, unit: "kg" },
          ],
        }),
        201,
      );
      await ok(await A().send("POST", `/production/batches/${batch.id}/start`));
      // Consume 2 kg of the reserved lot, and sugar from a lot nobody reserved for it (the other one).
      const after = await ok(
        await A().send("POST", `/production/batches/${batch.id}/consumption`, {
          lines: [{ lotId: late, locationId: store, quantity: 2, unit: "kg" }],
        }),
        201,
      );
      const r = after.reservations.find((x: { lotCode: string }) => x.lotCode === "FL-LATE");
      expect(r).toMatchObject({ status: "active" });
      expect(r.held.base).toBe(1000);
      const full = await ok(
        await A().send("POST", `/production/batches/${batch.id}/consumption`, {
          lines: [
            { lotId: late, locationId: store, quantity: 1, unit: "kg" },
            { lotId: early, locationId: store, quantity: 0.5, unit: "kg" },
          ],
        }),
        201,
      );
      expect(full.reservations.find((x: { lotCode: string }) => x.lotCode === "FL-LATE")).toMatchObject({
        status: "released",
        releaseReason: "consumed",
      });
      // Sugar is still held; completing releases it.
      expect(full.reservations.find((x: { lotCode: string }) => x.lotCode === "SG-1").status).toBe("active");
      await ok(
        await A().send("POST", `/production/batches/${batch.id}/output`, {
          quantity: 12,
          unit: "each",
          locationId: store,
        }),
        201,
      );
      const done = await ok(await A().send("POST", `/production/batches/${batch.id}/complete`, {}));
      expect(done.reservations.find((x: { lotCode: string }) => x.lotCode === "SG-1")).toMatchObject({
        status: "released",
        releaseReason: "completed",
      });
      expect((await availability(sugar)).reserved.base).toBe(0);
    });

    it("is released when the batch is cancelled, and counts in requirements and the trace of availability", async () => {
      const batch = await plan({ plannedOn: tomorrow });
      await ok(
        await A().send("POST", `/production/batches/${batch.id}/reservations`, {
          lines: [{ lotId: sugarLot, quantity: 1, unit: "kg" }],
        }),
        201,
      );
      const req = await ok(await A().get(`/production/requirements?from=${tomorrow}&to=${tomorrow}`));
      const row = req.requirements.find((x: { item: { id: string } }) => x.item.id === sugar);
      expect(row.reserved.base).toBe(1000);
      // Stock reserved for a batch outside the range is not available to the range.
      const other = await ok(
        await A().get(`/production/requirements?from=${addDays(today, 5)}&to=${addDays(today, 6)}`),
      );
      expect(other.requirements).toEqual([]);
      const cancelled = await ok(
        await A().send("POST", `/production/batches/${batch.id}/cancel`, { reason: "No order" }),
      );
      expect(cancelled.reservations[0]).toMatchObject({ status: "released", releaseReason: "cancelled" });
    });

    it("lists reservations for a lot and refuses reserving on a closed batch", async () => {
      const batch = await plan();
      await ok(
        await A().send("POST", `/production/batches/${batch.id}/reservations`, {
          lines: [{ lotId: early, quantity: 1, unit: "kg" }],
        }),
        201,
      );
      const list = await ok(await A().get(`/production/reservations?lotId=${early}`));
      expect(list.reservations).toHaveLength(1);
      expect(list.reservations[0]).toMatchObject({ batchCode: batch.batchCode, lotCode: "FL-EARLY" });
      await A().send("POST", `/production/batches/${batch.id}/cancel`, { reason: "x" });
      expect(
        await code(
          await A().send("POST", `/production/batches/${batch.id}/reservations`, { allOutstanding: true }),
          409,
        ),
      ).toBe("invalid_batch_status");
    });
  });

  describe("scanning a lot code", () => {
    it("resolves a typed or scanned code, case-insensitively, and says what is wrong with it", async () => {
      const batch = await plan();
      await A().send("POST", `/production/batches/${batch.id}/start`);
      const res = await ok(await A().get(`/production/batches/${batch.id}/scan?code=fl-late`));
      expect(res.matches).toHaveLength(1);
      expect(res.matches[0]).toMatchObject({ lotId: late, inRecipe: true, problem: null });
      expect(res.matches[0].balances[0].locationName).toBe("Dry store");
      const quarantined = await ok(await A().get(`/production/batches/${batch.id}/scan?code=FL-HELD`));
      expect(quarantined.matches[0].problem).toBe("lot_not_available");
      expect((await ok(await A().get(`/production/batches/${batch.id}/scan?code=NOPE`))).matches).toEqual([]);
      await A().send("POST", `/production/batches/${batch.id}/cancel`, { reason: "x" });
    });
  });

  describe("lines and capacity", () => {
    let line: string;
    it("needs manage to configure a line; reading needs read", async () => {
      await ctx.req(`${WS}/members/${marcus.userId}/module-access/production`, {
        method: "PUT",
        cookie: ada,
        json: { level: "write" },
      });
      for (const m of ["items", "recipes", "stock", "demand"]) {
        await ctx.req(`${WS}/members/${marcus.userId}/module-access/${m}`, {
          method: "PUT",
          cookie: ada,
          json: { level: "read" },
        });
      }
      const body = { name: "Line 1", hoursPerDay: 8 };
      expect(await code(await api(marcus.cookie).send("POST", "/production/lines", body), 403)).toBe(
        "module_forbidden",
      );
      line = (await ok(await A().send("POST", "/production/lines", body), 201)).id;
      expect((await api(marcus.cookie).get("/production/lines")).status).toBe(200);
      expect(await code(await A().send("POST", "/production/lines", { name: "line 1" }), 409)).toBe(
        "name_taken",
      );
    });

    it("sets a rate per recipe in the item's own unit", async () => {
      const res = await ok(
        await A().send("PUT", `/production/lines/${line}/recipes/${recipe}`, { rate: 12, unit: "each" }),
      );
      expect(res.recipes[0]).toMatchObject({ recipeCode: "R-CAKE" });
      expect(res.recipes[0].ratePerHour.base).toBe(12);
    });

    it("loads batches against capacity, warns when overloaded and never blocks", async () => {
      const day = addDays(today, 3);
      // 12 cakes per hour: 60 cakes is 5 h; two such batches is 10 h against 8 h.
      const a = await plan({ plannedOn: day, outputQuantity: 60, outputUnit: "each", lineId: line });
      expect(a.line).toMatchObject({ id: line, name: "Line 1" });
      expect(a.lineCheck).toMatchObject({ hours: 5, dayHours: 5, overloaded: false, warnings: [] });
      const b = await plan({ plannedOn: day, outputQuantity: 60, outputUnit: "each", lineId: line });
      expect(b.lineCheck.overloaded).toBe(true);
      expect(b.lineCheck.warnings[0]).toMatch(/overloaded/);
      const noLine = await plan({ plannedOn: day, batches: 1 });
      const schedule = await ok(await A().get(`/production/schedule?from=${day}&to=${addDays(day, 1)}`));
      const l = schedule.lines.find((x: { id: string }) => x.id === line);
      expect(l.days[0]).toMatchObject({ date: day, hours: 10, capacityHours: 8, overloaded: true });
      expect(l.days[0].loadPercent).toBe(125);
      expect(l.days[0].batches).toHaveLength(2);
      expect(l.days[1]).toMatchObject({ hours: 0, overloaded: false });
      expect(l.overloadedDays).toBe(1);
      expect(schedule.unassigned.map((x: { id: string }) => x.id)).toContain(noLine.id);
      // Moving a batch off the line clears the overload; cancelled batches don't count.
      await ok(await A().send("PATCH", `/production/batches/${b.id}`, { lineId: null }));
      expect((await ok(await A().get(`/production/batches/${a.id}`))).lineCheck.overloaded).toBe(false);
    });

    it("flags a batch whose recipe the line has no rate for, and refuses an inactive line", async () => {
      const second = (await ok(await A().send("POST", "/production/lines", { name: "Line 2" }), 201)).id;
      const b = await plan({ plannedOn: addDays(today, 4), lineId: second });
      expect(b.lineCheck.hours).toBeNull();
      expect(b.lineCheck.warnings[0]).toMatch(/no rate/);
      await ok(await A().send("PATCH", `/production/lines/${second}`, { active: false }));
      const third = await plan({ plannedOn: addDays(today, 4) });
      expect(
        await code(await A().send("PATCH", `/production/batches/${third.id}`, { lineId: second }), 409),
      ).toBe("line_inactive");
      expect(
        await code(
          await A().send("POST", "/production/batches", {
            recipeId: recipe,
            plannedOn: today,
            batches: 1,
            lineId: second,
          }),
          409,
        ),
      ).toBe("line_inactive");
    });
  });
});
