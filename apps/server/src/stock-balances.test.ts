import { DEFAULT_TIME_ZONE, todayInZone, newId, lotCodePrefix } from "@knotworking/core";
import { reconcileStockBalances, stockBalances, stockLots, workspaces } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

describe("stored stock balances", () => {
  let ctx: TestCtx, ada: string, workspaceId: string;
  let flour: string, sugar: string, store: string, chill: string;
  const call = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie: ada, json });
  const ok = async (r: Res, status = 200) => {
    const b = await r.json();
    expect(r.status, JSON.stringify(b)).toBe(status);
    return b;
  };
  const reconciled = async () => expect(await reconcileStockBalances(ctx.handle.db, workspaceId)).toEqual([]);

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    workspaceId = (await ctx.handle.db.select().from(workspaces).where(eq(workspaces.slug, "acme")))[0]!.id;
    flour = (
      await ok(
        await call("POST", "/items", { code: "FLR", name: "Flour", type: "ingredient", unit: "kg" }),
        201,
      )
    ).id;
    sugar = (
      await ok(
        await call("POST", "/items", { code: "SUG", name: "Sugar", type: "ingredient", unit: "kg" }),
        201,
      )
    ).id;
    store = (await ok(await call("POST", "/stock/locations", { name: "Store" }), 201)).id;
    chill = (await ok(await call("POST", "/stock/locations", { name: "Chiller" }), 201)).id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  const receive = async (itemId: string, kg: number, extra: object = {}) =>
    ok(
      await call("POST", "/stock/receipts", {
        itemId,
        locationId: store,
        receivedOn: today,
        quantity: kg,
        unit: "kg",
        ...extra,
      }),
      201,
    );

  it("tracks every kind of movement and always equals the ledger", async () => {
    const a = await receive(flour, 100);
    const b = await receive(sugar, 40);
    await reconciled();
    await ok(
      await call("POST", "/stock/transfers", {
        lotId: a.id,
        fromLocationId: store,
        toLocationId: chill,
        quantity: 30,
        unit: "kg",
      }),
      201,
    );
    await ok(
      await call("POST", "/stock/waste", {
        lotId: a.id,
        locationId: chill,
        quantity: 5,
        unit: "kg",
        reason: "Spilled",
      }),
      201,
    );
    await ok(
      await call("POST", "/stock/adjustments", {
        lotId: b.id,
        locationId: store,
        quantity: -2,
        unit: "kg",
        reason: "Recount",
      }),
      201,
    );
    await reconciled();
    // A reversal (a correction) and a stocktake.
    const movements = (await ok(await call("GET", `/stock/movements?lotId=${a.id}&limit=50`))).movements as {
      id: string;
      type: string;
    }[];
    const waste = movements.find((m) => m.type === "waste")!;
    await ok(await call("POST", `/stock/movements/${waste.id}/reverse`, { reason: "Entered in error" }), 201);
    await ok(
      await call("POST", "/stock/stocktakes", {
        counts: [{ lotId: b.id, locationId: store, countedQuantity: 37, unit: "kg" }],
      }),
      201,
    );
    await reconciled();

    // The stored balance is what the API reports.
    const lot = await ok(await call("GET", `/stock/lots/${a.id}`));
    expect(lot.onHand.display).toBe(100);
    expect(
      lot.balances
        .map((x: { amount: { display: number } }) => x.amount.display)
        .sort((x: number, y: number) => x - y),
    ).toEqual([30, 70]);
    const rows = await ctx.handle.db.select().from(stockBalances).where(eq(stockBalances.lotId, a.id));
    expect(rows.reduce((sum, r) => sum + r.quantity, 0)).toBe(100000);
  });

  it("lists levels, lots and locations from the balances, with correct totals", async () => {
    // A drained lot has a zero balance row but is not "in stock".
    const drained = await receive(flour, 1, { lotCode: "DRAINED" });
    await ok(
      await call("POST", "/stock/waste", {
        lotId: drained.id,
        locationId: store,
        quantity: 1,
        unit: "kg",
        reason: "Gone",
      }),
      201,
    );
    const lots = await ok(await call("GET", "/stock/lots?limit=50"));
    expect(lots.lots.some((l: { id: string }) => l.id === drained.id)).toBe(false);
    expect(
      (await ok(await call("GET", "/stock/lots?limit=50&includeEmpty=true"))).lots.some(
        (l: { id: string }) => l.id === drained.id,
      ),
    ).toBe(true);
    // Total: the page's own length on a short first page, a real count otherwise.
    expect(lots.total).toBe(lots.lots.length);
    const paged = await ok(await call("GET", "/stock/lots?limit=1"));
    expect(paged.lots).toHaveLength(1);
    expect(paged.total).toBe(lots.total);
    const second = await ok(await call("GET", `/stock/lots?limit=1&offset=${lots.total}`));
    expect(second.lots).toHaveLength(0);
    expect(second.total).toBe(lots.total);

    const levels = await ok(await call("GET", "/stock/levels"));
    const flourLevel = levels.levels.find((l: { item: { id: string } }) => l.item.id === flour);
    expect(flourLevel.onHand.display).toBe(100);
    expect(flourLevel.lotCount).toBe(1);
    expect(levels.total).toBe(levels.levels.length);
    expect((await ok(await call("GET", "/stock/levels?limit=1"))).total).toBe(levels.total);
    const atChill = await ok(await call("GET", `/stock/levels?locationId=${chill}`));
    expect(atChill.levels.map((l: { item: { id: string } }) => l.item.id)).toEqual([flour]);
    expect(atChill.levels[0].onHand.display).toBe(30);
    // Items with no stock appear only when asked for.
    expect(levels.levels.some((l: { item: { id: string } }) => l.item.id === sugar)).toBe(true);
    const nothing = (
      await ok(
        await call("POST", "/items", { code: "EMPTY", name: "Nothing yet", type: "ingredient", unit: "kg" }),
        201,
      )
    ).id;
    expect(
      (await ok(await call("GET", "/stock/levels"))).levels.some(
        (l: { item: { id: string } }) => l.item.id === nothing,
      ),
    ).toBe(false);
    expect(
      (await ok(await call("GET", "/stock/levels?includeZero=true"))).levels.some(
        (l: { item: { id: string } }) => l.item.id === nothing,
      ),
    ).toBe(true);

    const locations = (await ok(await call("GET", "/stock/locations"))).locations;
    expect(locations.find((l: { id: string }) => l.id === chill).lotCount).toBe(1);
    // A location holding stock can't be archived; an empty one can.
    expect((await call("PATCH", `/stock/locations/${chill}`, { status: "archived" })).status).toBe(409);
    const spare = (await ok(await call("POST", "/stock/locations", { name: "Spare" }), 201)).id;
    expect((await call("PATCH", `/stock/locations/${spare}`, { status: "archived" })).status).toBe(200);
  });

  it("generates consecutive lot codes for a day, case-insensitively, and never reuses one", async () => {
    const day = "2026-03-09";
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) codes.push((await receive(sugar, 1, { receivedOn: day })).lotCode);
    const prefix = lotCodePrefix(day);
    expect(codes).toEqual([`${prefix}001`, `${prefix}002`, `${prefix}003`]);
    // A hand-typed code in lower case still counts towards the sequence.
    await receive(flour, 1, { receivedOn: day, lotCode: `${prefix.toLowerCase()}007` });
    expect((await receive(sugar, 1, { receivedOn: day })).lotCode).toBe(`${prefix}008`);
    // Another day starts again.
    expect((await receive(sugar, 1, { receivedOn: "2026-03-10" })).lotCode).toBe(
      `${lotCodePrefix("2026-03-10")}001`,
    );
    const ids = (
      await ctx.handle.db
        .select({ id: stockLots.id })
        .from(stockLots)
        .where(eq(stockLots.workspaceId, workspaceId))
    ).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    await reconciled();
  });

  it("keeps balances right when several movements are posted at once", async () => {
    const lot = await receive(flour, 50);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        call("POST", "/stock/waste", {
          lotId: lot.id,
          locationId: store,
          quantity: 10,
          unit: "kg",
          reason: "Race",
          commandId: newId(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201).length).toBeLessThanOrEqual(5);
    const after = await ok(await call("GET", `/stock/lots/${lot.id}`));
    expect(after.onHand.display).toBeGreaterThanOrEqual(0);
    await reconciled();
  });
});
