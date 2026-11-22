import { prepareDespatch } from "./despatch-test-helpers";
import { DEFAULT_TIME_ZONE, newId, todayInZone } from "@knotworking/core";
import { items, stockLots, workspaces } from "@knotworking/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { traceForwardProduction } from "./services/ports/production";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
describe("forward distribution impact", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: string;
  let marcusId: string;
  let store: string;
  let raw: string;
  let mix: string;
  let cake: string;
  let soup: string;
  let rawRecipe: string;
  let root: string;
  let other: string;
  let wipA: string;
  let wipB: string;
  let cakeLot: string;
  let soupLot: string;
  let firstDespatch: string;
  let shopA: string;
  let seq = 0;
  const call = (method: string, path: string, json?: unknown, cookie = ada) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const ok = async (res: Res, status = 200) => {
    const b = await res.json();
    expect(res.status, JSON.stringify(b)).toBe(status);
    return b;
  };
  const receive = async () =>
    (
      await ok(
        await call("POST", "/stock/receipts", {
          itemId: raw,
          quantity: 10,
          unit: "kg",
          locationId: store,
          receivedOn: today,
          lotCode: `RAW-${++seq}`,
        }),
        201,
      )
    ).id as string;
  const item = async (code: string, type: string, unit: string) =>
    (await ok(await call("POST", "/items", { code, name: code, type, unit }), 201)).id as string;
  const recipe = async (
    code: string,
    outputItemId: string,
    quantity: number,
    unit: string,
    input: string,
    inputQty: number,
  ) => {
    const r = await ok(
      await call("POST", "/recipes", {
        code,
        name: code,
        outputItemId,
        draft: {
          yieldQuantity: quantity,
          yieldUnit: unit,
          lines: [{ itemId: input, quantity: inputQty, unit: "kg" }],
        },
      }),
      201,
    );
    await ok(await call("POST", `/recipes/${r.id}/draft/approve`, {}));
    return r.id as string;
  };
  const start = async (recipeId: string) => {
    const b = await ok(
      await call("POST", "/production/batches", {
        recipeId,
        plannedOn: today,
        batches: 1,
        outputLocationId: store,
      }),
      201,
    );
    await ok(await call("POST", `/production/batches/${b.id}/start`, {}));
    return b.id as string;
  };
  const consume = async (batch: string, inputs: { lotId: string; quantity: number }[]) =>
    ok(
      await call("POST", `/production/batches/${batch}/consumption`, {
        lines: inputs.map((l) => ({ ...l, locationId: store, unit: "kg" })),
      }),
      201,
    );
  const output = async (batch: string, quantity: number, unit: string) => {
    const b = await ok(
      await call("POST", `/production/batches/${batch}/output`, {
        quantity,
        unit,
        locationId: store,
        lotCode: `OUT-${++seq}`,
      }),
      201,
    );
    const record = b.records
      .filter(
        (r: { kind: string; reversesRecordId: string | null }) => r.kind === "output" && !r.reversesRecordId,
      )
      .at(-1);
    return { lotId: record.lotId as string, recordId: record.id as string };
  };
  const release = async (lot: string) =>
    ok(
      await call("POST", `/stock/lots/${lot}/status`, {
        status: "available",
        note: "QA release for trace exercise",
      }),
    );
  const finish = async (batch: string) =>
    ok(await call("POST", `/production/batches/${batch}/complete`, { note: "Trace exercise" }));
  const ship = async (
    customerId: string,
    lines: { lotId: string; quantity: number; unit: string }[],
    confirm = true,
  ) => {
    const d = await ok(
      await call("POST", "/despatch", {
        customerId,
        despatchedOn: today,
        lines: lines.map((l) => ({ ...l, locationId: store })),
      }),
      201,
    );
    if (confirm) {
      const prepared = await prepareDespatch(call, d.id, d.updatedAt);
      if (prepared.error) await ok(prepared.error);
      await ok(
        await call("POST", `/despatch/${d.id}/confirm`, {
          commandId: newId(),
          expectedUpdatedAt: prepared.stamp,
        }),
      );
    }
    return d.id as string;
  };
  const report = async (lot = root, query = "") =>
    ok(await call("GET", `/despatch/lots/${lot}/impact${query}`));

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    marcusId = (await ok(await ctx.req("/v1/me", { cookie: marcus }))).user.id;
    store = (await ok(await call("POST", "/stock/locations", { name: "Impact store" }), 201)).id;
    raw = await item("IM-RAW", "ingredient", "kg");
    mix = await item("IM-MIX", "wip", "kg");
    cake = await item("IM-CAKE", "finished", "each");
    soup = await item("IM-SOUP", "finished", "l");
    rawRecipe = await recipe("IM-R-MIX", mix, 2, "kg", raw, 2);
    const cakeRecipe = await recipe("IM-R-CAKE", cake, 10, "each", mix, 1);
    const soupRecipe = await recipe("IM-R-SOUP", soup, 2, "l", mix, 0.5);
    root = await receive();
    other = await receive();
    const m = await start(rawRecipe);
    await consume(m, [{ lotId: root, quantity: 2 }]);
    wipA = (await output(m, 1, "kg")).lotId;
    wipB = (await output(m, 1, "kg")).lotId;
    await finish(m);
    await release(wipA);
    await release(wipB);
    const c = await start(cakeRecipe);
    await consume(c, [
      { lotId: wipA, quantity: 0.5 },
      { lotId: wipB, quantity: 0.5 },
    ]);
    cakeLot = (await output(c, 10, "each")).lotId;
    await finish(c);
    await release(cakeLot);
    const s = await start(soupRecipe);
    await consume(s, [{ lotId: wipA, quantity: 0.5 }]);
    soupLot = (await output(s, 2, "l")).lotId;
    await finish(s);
    await release(soupLot);
    shopA = (
      await ok(
        await call("POST", "/customers", {
          code: "IM-A",
          name: "=1+1",
          address: "1 Original Road",
          email: "buyer@example.test",
        }),
        201,
      )
    ).id;
    const shopB = (
      await ok(
        await call("POST", "/customers", { code: "IM-B", name: "Shop B", address: "2 Market Street" }),
        201,
      )
    ).id;
    firstDespatch = await ship(shopA, [
      { lotId: cakeLot, quantity: 2, unit: "each" },
      { lotId: soupLot, quantity: 0.5, unit: "l" },
    ]);
    await ship(shopB, [{ lotId: cakeLot, quantity: 3, unit: "each" }]);
    await ship(shopA, [{ lotId: cakeLot, quantity: 1, unit: "each" }], false);
    const voided = await ship(shopA, [{ lotId: soupLot, quantity: 0.25, unit: "l" }]);
    await ok(
      await call("POST", `/despatch/${voided}/void`, { commandId: newId(), reason: "Entry correction" }),
    );
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("follows split WIP and reconverging paths once, includes whole deliveries and keeps units separate", async () => {
    const before = await ok(await call("GET", "/sync?after=0&limit=1000"));
    const r = await report();
    expect(r.coverage).toMatchObject({ status: "complete", reasons: [] });
    expect(r.summary).toEqual({ lots: 5, batches: 3, despatches: 2, customers: 2, deliveryLines: 3 });
    expect(r.lots.map((l: { id: string }) => l.id).sort()).toEqual(
      [root, wipA, wipB, cakeLot, soupLot].sort(),
    );
    expect(new Set(r.batches.map((b: { id: string }) => b.id)).size).toBe(3);
    expect(
      r.deliveries.lines.filter((l: { despatchId: string }) => l.despatchId === firstDespatch),
    ).toHaveLength(2);
    expect(
      r.deliveries.lines.map((l: { amount: { display: number; displayUnit: string } }) => [
        l.amount.display,
        l.amount.displayUnit,
      ]),
    ).toEqual([
      [2, "each"],
      [0.5, "l"],
      [3, "each"],
    ]);
    const after = await ok(await call("GET", "/sync?after=0&limit=1000"));
    expect(after.cursor).toBe(before.cursor);
  });

  it("only follows descendants of the actual lot and does not trace back through sibling inputs", async () => {
    expect((await report(other)).summary).toMatchObject({ lots: 1, batches: 0, deliveryLines: 0 });
    expect((await report(cakeLot)).summary).toMatchObject({ lots: 1, batches: 0, deliveryLines: 2 });
    const wip = await report(wipA);
    expect(wip.summary.lots).toBe(3);
    expect(wip.lots.some((l: { id: string }) => [root, wipB].includes(l.id))).toBe(false);
  });

  it("reports depth truncation even when no deliveries have yet been found, and recognises true leaf coverage", async () => {
    const limited = await report(root, "?depth=1");
    expect(limited.coverage).toMatchObject({ status: "partial", reasons: ["depth_limit"] });
    expect(limited.deliveries.total).toBe(0);
    expect((await report(root, "?depth=2")).coverage.status).toBe("complete");
    for (const depth of ["0", "21", "bad"])
      expect((await call("GET", `/despatch/lots/${root}/impact?depth=${depth}`)).status).toBe(400);
  });

  it("surfaces lot, batch and output-link caps instead of silently losing paths", async () => {
    for (const [limits, reason] of [
      [{ lots: 2, batches: 20, links: 20 }, "lot_limit"],
      [{ lots: 20, batches: 1, links: 20 }, "batch_limit"],
      [{ lots: 20, batches: 20, links: 1 }, "link_limit"],
    ] as const) {
      const result = await traceForwardProduction(
        ctx.handle.db,
        (await ok(await call("GET", "/bootstrap"))).workspace.id,
        root,
        10,
        limits,
      );
      expect(result.reasons).toContain(reason);
      expect(result.lots.size).toBeLessThanOrEqual(limits.lots);
      expect(result.batches.length).toBeLessThanOrEqual(limits.batches);
    }
  });

  it("pages delivery lines with stable counts and exports all contacts, original details and coverage safely", async () => {
    await ok(
      await call("PATCH", `/customers/${shopA}`, {
        address: "99 Changed Road",
        email: "changed@example.test",
      }),
    );
    const first = await report(root, "?limit=1");
    const next = await report(root, "?limit=1&offset=1");
    expect(first.deliveries.total).toBe(3);
    expect(first.deliveries.lines).toHaveLength(1);
    expect(next.deliveries.lines[0].lineId).not.toBe(first.deliveries.lines[0].lineId);
    const res = await call("GET", `/despatch/lots/${root}/impact.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const csv = await res.text();
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("buyer@example.test");
    expect(csv).not.toContain("changed@example.test");
    expect(csv).toContain("1 Original Road");
    expect(csv).toContain("3 / 3");
    expect(csv).toContain("Recorded trace coverage,complete");
    const partial = await (await call("GET", `/despatch/lots/${root}/impact.csv?depth=1`)).text();
    expect(partial).toContain("Recorded trace coverage,partial");
    expect(partial).toContain("further production or customer-return links remain");
  });

  it("requires production and despatch access for JSON and CSV, including API-token allowlists", async () => {
    const grant = async (module: string, level: string) =>
      ok(await call("PUT", `/members/${marcusId}/module-access/${module}`, { level }));
    for (const m of ["items", "stock", "customers", "despatch"]) await grant(m, "read");
    for (const suffix of ["impact", "impact.csv"])
      expect((await call("GET", `/despatch/lots/${root}/${suffix}`, undefined, marcus)).status).toBe(403);
    for (const m of ["recipes", "demand", "production"]) await grant(m, "read");
    expect((await call("GET", `/despatch/lots/${root}/impact`, undefined, marcus)).status).toBe(200);
    const token = (
      await ok(
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: {
            name: "Distribution only",
            scope: "read",
            modules: ["items", "stock", "customers", "despatch"],
          },
        }),
        201,
      )
    ).token;
    const hidden = await ctx.req(`${WS}/despatch/lots/${root}/impact`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(hidden.status).toBe(403);
    expect(await hidden.text()).not.toContain("buyer@example.test");
    await grant("despatch", "none");
    expect((await call("GET", `/despatch/lots/${root}/impact`, undefined, marcus)).status).toBe(403);
  });

  it("refuses inactive production explicitly, while direct lot-recipient routes remain independent", async () => {
    const off = await makeApp({ seed: true, activeModules: ["items", "stock", "customers", "despatch"] });
    try {
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const impact = await off.req(`${WS}/despatch/lots/${root}/impact`, { cookie });
      expect(impact.status).toBe(404);
      expect((await impact.json()).error.code).toBe("module_inactive");
      const direct = await off.req(`${WS}/despatch/lots/${root}/recipients`, { cookie });
      expect((await direct.json()).error.code).toBe("not_found");
    } finally {
      await off.handle.close();
    }
  }, 60_000);

  it("rejects foreign-workspace lot references without exposing their product details", async () => {
    const [ws] = await ctx.handle.db
      .insert(workspaces)
      .values({ name: "Private", slug: "impact-private" })
      .returning();
    const [i] = await ctx.handle.db
      .insert(items)
      .values({
        workspaceId: ws!.id,
        code: "PRIVATE",
        name: "Hidden product",
        type: "ingredient",
        unit: "kg",
      })
      .returning();
    const [lot] = await ctx.handle.db
      .insert(stockLots)
      .values({ workspaceId: ws!.id, itemId: i!.id, lotCode: "HIDDEN", receivedOn: today })
      .returning();
    const r = await call("GET", `/despatch/lots/${lot!.id}/impact`);
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("Hidden product");
  });

  it("ignores corrected consumption and warns about open production and reversed output", async () => {
    const original = await receive();
    const corrected = await receive();
    const batch = await start(rawRecipe);
    const used = await consume(batch, [{ lotId: original, quantity: 1 }]);
    const rec = used.records.find((r: { kind: string }) => r.kind === "consumption");
    await ok(
      await call("POST", `/production/batches/${batch}/records/${rec.id}/reverse`, {
        reason: "Wrong input lot",
      }),
      201,
    );
    await consume(batch, [{ lotId: corrected, quantity: 1 }]);
    expect((await report(original)).summary.batches).toBe(0);
    const incomplete = await report(corrected);
    expect(incomplete.coverage.reasons).toEqual(expect.arrayContaining(["open_batches", "missing_output"]));
    const made = await output(batch, 1, "kg");
    expect((await report(corrected)).lots.some((l: { id: string }) => l.id === made.lotId)).toBe(true);
    await ok(
      await call("POST", `/production/batches/${batch}/records/${made.recordId}/reverse`, {
        reason: "Output entry correction",
      }),
      201,
    );
    const reversed = await report(corrected);
    expect(reversed.summary.lots).toBe(1);
    expect(reversed.coverage.reasons).toContain("missing_output");
    await output(batch, 1, "kg");
    await finish(batch);
    expect((await report(corrected)).coverage).toMatchObject({ status: "complete", reasons: [] });
  });
});
