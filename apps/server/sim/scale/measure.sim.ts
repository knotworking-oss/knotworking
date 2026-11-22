import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { addDays, newId } from "@knotworking/core";
import { World, PASSWORD, type Persona } from "../lib/world";
import { PERSONAS } from "../lib/personas";

const TIER = process.env.TIER ?? "A";
const base = JSON.parse(readFileSync("sim/out/scale-base.json", "utf8"));
const END = base.end as string;
const ms = (t0: number) => Math.round(performance.now() - t0);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const withTimeout = <T>(p: Promise<T>, label: string, t = 180_000) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${label}`)), t))]);

describe(`ledger scale, tier ${TIER}`, () => {
  const w = new World();
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${END}T09:00:00Z`));
    await w.boot();
  }, 120_000);
  afterAll(() => w.ctx.handle.close());

  it("measures", async () => {
    w.setDay(END, 9);
    for (const spec of PERSONAS) w.people.set(spec.key, { ...spec, userId: "", cookie: "" } as Persona);
    await w.signInAll();
    const md = w.people.get("md")!,
      gi = w.people.get("goodsIn1")!,
      prod = w.people.get("prodMgr")!,
      op = w.people.get("op1")!;
    const out: any = { tier: TIER, at: new Date().toISOString() };
    const get = async (who: Persona, path: string) => {
      const t0 = performance.now();
      try {
        const r = await withTimeout(w.ctx.req(`/v1/workspaces/acme${path}`, { cookie: who.cookie }), path);
        const text = await withTimeout(r.text(), path + " body");
        return { status: r.status, ms: ms(t0), bytes: text.length };
      } catch (e) {
        return { status: -1, ms: ms(t0), bytes: 0, err: String(e) };
      }
    };

    // 1. Every read route with no path parameters, twice (first call, then the median of two more).
    const routes = (w.ctx.app.routes as { method: string; path: string }[])
      .filter(
        (r) =>
          r.method === "GET" &&
          r.path.startsWith("/v1/workspaces/:slug/") &&
          !/:(?!slug)/.test(r.path) &&
          !/stream|\/events$/.test(r.path),
      )
      .map((r) => r.path.replace("/v1/workspaces/:slug", ""));
    const sweep: any[] = [];
    for (const p of [...new Set(routes)]) {
      const first = await get(md, p);
      if (first.status < 0) {
        sweep.push({ path: p, first: first.ms, median: first.ms, status: first.status, err: first.err });
        continue;
      }
      const again = [await get(md, p), await get(md, p)];
      sweep.push({
        path: p,
        first: first.ms,
        median: median(again.map((a) => a.ms)),
        status: first.status,
        bytes: first.bytes,
      });
    }
    out.sweepSlowest = sweep.sort((a, b) => b.median - a.median).slice(0, 14);
    out.sweepOver1s = sweep.filter((s) => s.median > 1000).map((s) => `${s.path} ${s.median}ms`);
    out.sweepErrors = sweep
      .filter((s) => s.status >= 500 || s.status < 0)
      .map((s) => `${s.path} ${s.status} ${s.err ?? ""}`);

    // 2. Targeted ledger reads.
    const lots = (await w.call(md, "GET", "/stock/lots?limit=50&status=available&expiry=expiring")).body;
    const sampleLot =
      (await w.call(md, "GET", `/stock/lots?limit=1&q=SYN${TIER}-1000`)).body?.lots?.[0]?.id ?? base.traceLot;
    const targeted = [
      "/stock/levels?limit=200",
      "/stock/levels?limit=200&locationId=" + base.locations.dry,
      "/stock/levels?limit=200&expiringWithinDays=14",
      "/stock/lots?limit=50",
      "/stock/lots?limit=50&status=quarantine",
      "/stock/lots?limit=50&itemId=" + base.ingredientIds[0],
      "/stock/lots?limit=50&q=SYN",
      `/stock/lots/${sampleLot}`,
      `/stock/lots/${base.traceLot}`,
      "/stock/movements?limit=200",
      "/stock/movements?limit=200&itemId=" + base.ingredientIds[0],
      `/stock/movements?limit=200&lotId=${sampleLot}`,
      `/production/lots/${base.traceLot}/trace`,
      `/despatch/lots/${base.traceLot}/impact?limit=200`,
      `/stock/lots/${base.traceLot}/release-check`,
      "/search?q=sourdough",
      "/search?q=SYN",
      "/bootstrap",
      `/sync?after=${base.requests}&limit=500`,
      "/sync?after=0&limit=500",
      "/purchasing/suggestions",
      "/production/requirements?from=2026-11-01&to=2026-11-30",
      "/costing/valuation",
    ];
    out.targeted = [];
    for (const p of targeted) {
      const a = await get(md, p),
        b = await get(md, p),
        c = await get(md, p);
      out.targeted.push({
        path: p.replace(sampleLot, ":lot").replace(base.traceLot, ":baseLot"),
        first: a.ms,
        median: median([a.ms, b.ms, c.ms]),
        status: a.status,
        bytes: a.bytes,
      });
    }
    out.targeted.sort((x: any, y: any) => y.median - x.median);

    // 3. Writes on the big ledger, one at a time.
    const kg = (qty: number) => ({ quantity: qty, unit: "g" });
    const timed = async (
      label: string,
      who: Persona,
      method: string,
      path: string,
      body: unknown,
      expect = [200, 201],
    ) => {
      const t0 = performance.now();
      const r = await w.call(who, method, path, body, expect);
      return { label, ms: ms(t0), status: r.status, body: r.body };
    };
    const writes: Record<string, number[]> = {};
    const rec = (label: string, v: number) => (writes[label] ??= []).push(v);
    const item = base.ingredientIds[0];
    for (let i = 0; i < 12; i++) {
      const r = await timed("receipt", gi, "POST", "/stock/receipts", {
        itemId: item,
        locationId: base.locations.dry,
        receivedOn: END,
        quantity: 50,
        unit: "kg",
        expiresOn: addDays(END, 90),
        expiryType: "best_before",
      });
      rec("receipt", r.ms);
      if (r.body?.id) {
        const t = await timed("transfer", gi, "POST", "/stock/transfers", {
          lotId: r.body.id,
          fromLocationId: base.locations.dry,
          toLocationId: base.locations.chill,
          quantity: 5000,
          unit: "g",
        });
        rec("transfer", t.ms);
        const ws = await timed("waste", w.people.get("qaMgr")!, "POST", "/stock/waste", {
          lotId: r.body.id,
          locationId: base.locations.chill,
          quantity: 100,
          unit: "g",
          reason: "Spillage",
        });
        rec("waste", ws.ms);
        const st = await timed(
          "status change",
          w.people.get("qaMgr")!,
          "POST",
          `/stock/lots/${r.body.id}/status`,
          { status: "quarantine", note: "Check" },
        );
        rec("lot status", st.ms);
      }
    }
    // A production batch end to end: receive exactly what the recipe needs, then consume, output, complete.
    const recipeProduct = base.productIds[0];
    const recipes = (await w.call(md, "GET", "/recipes?limit=100")).body?.recipes ?? [];
    const rcp =
      recipes.find((r: any) => r.outputItem?.id === recipeProduct || r.outputItemId === recipeProduct) ??
      recipes[0];
    const detail = (await w.call(md, "GET", `/recipes/${rcp.id}`)).body;
    for (let i = 0; i < 6; i++) {
      const lines: any[] = [];
      for (const l of detail.currentVersion.lines) {
        const grams = l.unit === "kg" ? Math.round(l.quantity * 1000) : l.quantity;
        const it = l.itemId ?? l.item?.id;
        const rc = await w.call(gi, "POST", "/stock/receipts", {
          itemId: it,
          locationId: base.locations.dry,
          receivedOn: END,
          quantity: grams,
          unit: l.unit === "kg" ? "g" : l.unit,
          expiresOn: addDays(END, 120),
          expiryType: "best_before",
        });
        if (rc.body?.id)
          lines.push({
            lotId: rc.body.id,
            locationId: base.locations.dry,
            quantity: grams,
            unit: l.unit === "kg" ? "g" : l.unit,
          });
      }
      const b = await timed(
        "batch create",
        w.people.get("planner")!,
        "POST",
        "/production/batches",
        { recipeId: rcp.id, plannedOn: END, batches: 1, outputLocationId: base.locations.finished },
        [201],
      );
      rec("batch create", b.ms);
      if (!b.body?.id) continue;
      rec(
        "batch start",
        (await timed("start", op, "POST", `/production/batches/${b.body.id}/start`, undefined)).ms,
      );
      rec(
        "consumption",
        (await timed("consume", op, "POST", `/production/batches/${b.body.id}/consumption`, { lines }, [201]))
          .ms,
      );
      rec(
        "output",
        (
          await timed(
            "output",
            op,
            "POST",
            `/production/batches/${b.body.id}/output`,
            { quantity: detail.currentVersion.yieldQuantity, unit: detail.currentVersion.yieldUnit },
            [201],
          )
        ).ms,
      );
      rec(
        "batch complete",
        (await timed("complete", prod, "POST", `/production/batches/${b.body.id}/complete`, { note: "ok" }))
          .ms,
      );
    }
    out.writes = Object.fromEntries(
      Object.entries(writes).map(([k, v]) => [
        k,
        { n: v.length, median: median(v), p95: pct(v, 0.95), max: Math.max(...v) },
      ]),
    );

    // 4. Concurrency: 20 people writing at once (the per-workspace sync-log lock serialises them), then 30 concurrent reads.
    const burst = async (n: number, fn: (i: number) => Promise<unknown>) => {
      const lat: number[] = [];
      const t0 = performance.now();
      await Promise.all(
        Array.from({ length: n }, async (_, i) => {
          const s = performance.now();
          await fn(i);
          lat.push(ms(s));
        }),
      );
      return { n, totalMs: ms(t0), median: median(lat), p95: pct(lat, 0.95), max: Math.max(...lat) };
    };
    const rounds = [];
    for (let r = 0; r < 3; r++)
      rounds.push(
        await burst(20, () =>
          w.call(gi, "POST", "/stock/receipts", {
            commandId: newId(),
            itemId: item,
            locationId: base.locations.dry,
            receivedOn: END,
            quantity: 1,
            unit: "kg",
          }),
        ),
      );
    out.concurrentWrites20 = rounds;
    out.concurrentReads30 = {
      levels: await burst(30, () => get(md, "/stock/levels?limit=200")),
      lots: await burst(30, () => get(md, "/stock/lots?limit=50")),
      bootstrap: await burst(30, () => get(md, "/bootstrap")),
    };
    // Mixed: 10 writers while 20 readers hit levels.
    const t0 = performance.now();
    const wl: number[] = [],
      rl: number[] = [];
    await Promise.all([
      ...Array.from({ length: 10 }, async () => {
        const s = performance.now();
        await w.call(gi, "POST", "/stock/receipts", {
          commandId: newId(),
          itemId: item,
          locationId: base.locations.dry,
          receivedOn: END,
          quantity: 1,
          unit: "kg",
        });
        wl.push(ms(s));
      }),
      ...Array.from({ length: 20 }, async () => {
        const s = performance.now();
        await get(md, "/stock/levels?limit=200");
        rl.push(ms(s));
      }),
    ]);
    out.mixed = {
      totalMs: ms(t0),
      writeMedian: median(wl),
      writeMax: Math.max(...wl),
      readMedian: median(rl),
      readMax: Math.max(...rl),
    };

    out.findings = w.findings.all.map((f) => `${f.kind} x${f.count} ${f.what}`).slice(0, 20);
    mkdirSync("sim/out", { recursive: true });
    writeFileSync(`sim/out/scale-${TIER}.json`, JSON.stringify(out, null, 2));
    console.log(
      "SCALE",
      JSON.stringify({
        tier: TIER,
        over1s: out.sweepOver1s,
        errors: out.sweepErrors,
        slowestTargeted: out.targeted.slice(0, 6),
        writes: out.writes,
        concurrentWrites20: out.concurrentWrites20,
        concurrentReads30: out.concurrentReads30,
        mixed: out.mixed,
        findings: out.findings,
      }),
    );
  }, 3_600_000);
});
