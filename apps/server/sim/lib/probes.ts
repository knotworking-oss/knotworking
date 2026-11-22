import { newId } from "@knotworking/core";
import type { World } from "./world";
import type { Plant } from "./plant";
import type { Master } from "./setup";

const rec = (w: World, what: string, detail?: unknown) =>
  w.findings.record({ kind: "invariant", day: w.day, who: "probe", what, detail });

/** Traceability: the server's backward trace and recipient lists must match what the plant really did. */
export async function traceProbe(w: World, plant: Plant) {
  const qa = w.people.get("qaMgr")!;
  let checked = 0;
  const sample = plant.batchLog
    .filter((b) => b.outputLotId)
    .filter((_, i) => i % Math.max(1, Math.floor(plant.batchLog.length / 25)) === 0);
  for (const b of sample) {
    const t = await w.call(qa, "GET", `/production/lots/${b.outputLotId}/trace?depth=1`);
    if (!t.ok) continue;
    const got = new Set<string>(
      (t.body.backward ?? []).flatMap((e: any) => (e.inputs ?? []).map((i: any) => i.lot?.id)),
    );
    const want = new Set(b.consumedLotIds);
    const missing = [...want].filter((x) => !got.has(x));
    const extra = [...got].filter((x) => !want.has(x));
    if (missing.length || extra.length)
      rec(w, "backward trace does not match the ingredient lots actually consumed", {
        batch: b.batchId,
        missing: missing.length,
        extra: extra.length,
      });
    checked++;
  }
  // Recall scope: from an ingredient lot, every customer that could have received it.
  const lotToBatches = new Map<string, typeof plant.batchLog>();
  for (const b of plant.batchLog)
    for (const l of b.consumedLotIds) lotToBatches.set(l, [...(lotToBatches.get(l) ?? []), b]);
  const outToCustomers = new Map<string, Set<string>>();
  for (const d of plant.despatchLog)
    for (const l of d.lotIds)
      outToCustomers.set(l, new Set([...(outToCustomers.get(l) ?? []), d.customerId]));
  let recalls = 0;
  for (const [ingLot, batches] of [...lotToBatches].filter((_, i) => i % 40 === 0).slice(0, 12)) {
    const want = new Set<string>();
    for (const b of batches)
      if (b.outputLotId) for (const c of outToCustomers.get(b.outputLotId) ?? []) want.add(c);
    // The delivery list is paged (50 by default): read every page, then compare with the server's own summary.
    let offset = 0;
    const seen = new Set<string>();
    let summary: any,
      coverage: any,
      total = 0;
    for (;;) {
      const r = await w.call(qa, "GET", `/despatch/lots/${ingLot}/impact?limit=200&offset=${offset}`);
      if (!r.ok) break;
      summary = r.body.summary;
      coverage = r.body.coverage;
      const lines: any[] = r.body.deliveries?.lines ?? [];
      lines.forEach((l) => seen.add(l.customerId));
      total += lines.length;
      if (lines.length < 200) break;
      offset += 200;
    }
    if (!summary) continue;
    const missing = [...want].filter((c) => !seen.has(c));
    if (coverage?.status !== "complete")
      rec(w, "recall impact coverage is not complete for a small data set", { lot: ingLot, coverage });
    if (missing.length || summary.customers !== seen.size)
      rec(w, "recall impact for an ingredient lot misses customers who received derived product", {
        lot: ingLot,
        expected: want.size,
        serverSummary: summary.customers,
        listed: seen.size,
        missing: missing.length,
        lines: total,
      });
    recalls++;
  }
  return { traced: checked, recallsChecked: recalls };
}

/** Destructive actions against records that have history must be refused (or at least not orphan data). */
export async function destructiveProbe(w: World, plant: Plant, m: Master) {
  const md = w.people.get("md")!;
  const report: Record<string, number> = {};
  const attempt = async (label: string, path: string) => {
    const r = await w.call(md, "DELETE", path, undefined, [409, 400, 403, 404, 422]);
    report[label] = r.status;
    if (r.status >= 200 && r.status < 300)
      rec(w, `DELETE ${label} with history succeeded`, { path, status: r.status });
  };
  const item = m.ingredients[0]!;
  await attempt("item with lots", `/items/${item.id}`);
  await attempt("finished item with sales/batches", `/items/${m.products[0]!.id}`);
  await attempt("supplier with POs", `/suppliers/${m.suppliers[0]!.id}`);
  await attempt("customer with orders", `/customers/${m.customers[0]!.id}`);
  await attempt("recipe with batches", `/recipes/${m.products[0]!.recipeId}`);
  // After every attempt the history must still be readable.
  const items = await w.call(md, "GET", `/items?limit=200`);
  const lots = await w.call(md, "GET", `/stock/lots?itemId=${item.id}&limit=5`);
  if (!lots.body?.lots?.length)
    rec(w, "lots unreadable after attempted item deletion", { status: lots.status });
  if (!items.ok) rec(w, "items list failed after destructive attempts");
  return report;
}

/** The same command sent twice must act once; a different payload under the same key must be refused. */
export async function idempotencyProbe(w: World, plant: Plant, m: Master) {
  const gi = w.people.get("goodsIn1")!;
  const item = m.ingredients[1]!;
  const before = (await w.call(gi, "GET", `/stock/levels?limit=200`)).body.levels.find(
    (l: any) => l.item.id === item.id,
  ).onHand.base;
  const body = {
    commandId: newId(),
    itemId: item.id,
    locationId: m.locations.dry,
    receivedOn: w.day,
    quantity: 10,
    unit: "kg",
  };
  const [a, b] = await Promise.all([
    w.call(gi, "POST", "/stock/receipts", body),
    w.call(gi, "POST", "/stock/receipts", body),
  ]);
  if (a.body?.id !== b.body?.id)
    rec(w, "replayed receipt created two lots", { a: a.body?.id, b: b.body?.id });
  plant.model.set(item.id, (plant.model.get(item.id) ?? 0) + 10_000);
  const diff = await w.call(gi, "POST", "/stock/receipts", { ...body, quantity: 11 }, [409]);
  if (diff.status !== 409)
    rec(w, "command id reused for a different payload was not refused", { status: diff.status });
  const after = (await w.call(gi, "GET", `/stock/levels?limit=200`)).body.levels.find(
    (l: any) => l.item.id === item.id,
  ).onHand.base;
  if (after - before !== 10_000)
    rec(w, "idempotent replay changed stock by the wrong amount", { delta: after - before });
}

/** Stock safety: unreleased, rejected or expired lots must not be consumed or despatched; no overdraw even under concurrency. */
export async function stockSafetyProbe(w: World, plant: Plant, m: Master) {
  const op = w.people.get("op1")!,
    desp = w.people.get("desp1")!,
    gi = w.people.get("goodsIn1")!,
    qa = w.people.get("qaMgr")!;
  const prod = m.products[0]!;
  const flour = m.ingredients[0]!;
  const mk = async (
    status: "quarantine" | "available",
    days: number,
    qty = 50,
    type: "use_by" | "best_before" = "best_before",
  ) => {
    const r = await w.call(gi, "POST", "/stock/receipts", {
      itemId: flour.id,
      locationId: m.locations.dry,
      receivedOn: w.day,
      quantity: qty,
      unit: "kg",
      expiresOn: new Date(Date.parse(w.day) + days * 864e5).toISOString().slice(0, 10),
      expiryType: type,
      status,
    });
    plant.model.set(flour.id, (plant.model.get(flour.id) ?? 0) + qty * 1000);
    return r.body?.id as string;
  };
  const startBatch = async () => {
    const b = await w.call(
      w.people.get("planner")!,
      "POST",
      "/production/batches",
      { recipeId: prod.recipeId, plannedOn: w.day, batches: 1, outputLocationId: m.locations.finished },
      [201],
    );
    await w.call(op, "POST", `/production/batches/${b.body.id}/start`, undefined, [200]);
    return b.body.id as string;
  };
  const batch = await startBatch();
  const flourLine = prod.lines.find((l) => l.itemId === flour.id) ?? {
    itemId: flour.id,
    quantity: 1,
    unit: "kg",
  };
  const consume = (lotId: string, grams: number) =>
    w.call(
      op,
      "POST",
      `/production/batches/${batch}/consumption`,
      { lines: [{ lotId, locationId: m.locations.dry, quantity: grams, unit: "g" }] },
      [201, 400, 409],
    );
  const held = await mk("quarantine", 100);
  const r1 = await consume(held, 1000);
  if (r1.status === 201) rec(w, "quarantined lot was consumed in production", { lot: held });
  // Expired lot: received yesterday-dated expiry is impossible, so receive with a tiny life then advance the clock.
  const shortLife = await mk("available", 1, 50, "use_by");
  const shortBb = await mk("available", 1, 50, "best_before");
  w.setDay(new Date(Date.parse(w.day) + 3 * 864e5).toISOString().slice(0, 10));
  const r2 = await consume(shortLife, 1000);
  if (r2.status === 201) rec(w, "use-by expired lot was consumed in production", { lot: shortLife });
  const r3 = await consume(shortBb, 1000);
  if (r3.status === 201) plant.model.set(flour.id, (plant.model.get(flour.id) ?? 0) - 1000);
  const dd = await w.call(
    desp,
    "POST",
    "/despatch",
    {
      customerId: m.customers[0]!.id,
      despatchedOn: w.day,
      lines: [{ lotId: shortLife, locationId: m.locations.dry, quantity: 1000, unit: "g" }],
    },
    [201, 400, 409],
  );
  if (dd.status === 201)
    rec(w, "draft despatch accepted an expired ingredient lot (check confirm blocks it)", { lot: shortLife });
  // Concurrency: five simultaneous consumptions each wanting 60% of the lot.
  const lot = await mk("available", 60, 10);
  const results = await Promise.all(Array.from({ length: 5 }, () => consume(lot, 6000)));
  const wins = results.filter((r) => r.status === 201).length;
  if (wins > 1) rec(w, "concurrent consumption overdrew a lot", { wins, onHand: 10_000, tried: 5 * 6000 });
  const lv = await w.call(qa, "GET", `/stock/lots/${lot}`);
  if (lv.body?.onHand?.base < 0)
    rec(w, "lot went negative under concurrent consumption", { onHand: lv.body.onHand.base });
  plant.model.set(flour.id, (plant.model.get(flour.id) ?? 0) - wins * 6000);
  await w.call(
    w.people.get("prodMgr")!,
    "POST",
    `/production/batches/${batch}/cancel`,
    { reason: "Probe batch" },
    [200, 409],
  );
  return {
    quarantineConsume: r1.status,
    expiredUseByConsume: r2.status,
    pastBestBeforeConsume: r3.status,
    expiredDespatchDraft: dd.status,
    concurrentWins: wins,
  };
}

/** A deactivated person must lose access at once; their records must remain. */
export async function offboardingProbe(w: World) {
  const md = w.people.get("md")!,
    op = w.people.get("op3")!;
  const before = await w.call(op, "GET", "/stock/levels?limit=1");
  const d = await w.call(md, "POST", `/members/${op.userId}/deactivate`, {}, [200, 204]);
  const after = await w.call(op, "GET", "/stock/levels?limit=1", undefined, [401, 403]);
  if (after.status === 200)
    rec(w, "deactivated member's existing session still works", {
      before: before.status,
      deactivate: d.status,
    });
  const login = await w.ctx.req("/api/auth/sign-in/email", {
    method: "POST",
    json: { email: op.email, password: op.password },
  });
  if (login.status === 200) {
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const again = await w.ctx.req(`/v1/workspaces/acme/stock/levels?limit=1`, { cookie });
    if (again.status === 200) rec(w, "deactivated member can sign in again and use the workspace", {});
  }
  await w.call(md, "POST", `/members/${op.userId}/reactivate`, {}, [200, 204]);
  return { sessionAfterDeactivate: after.status, signIn: login.status };
}

/** What a year of data does to the main reads: timings, payload sizes, and whether the sync log still replays. */
export async function scaleProbe(w: World, plant: Plant, m: Master) {
  const md = w.people.get("md")!,
    qa = w.people.get("qaMgr")!;
  const rows: { path: string; ms: number; bytes: number; status: number }[] = [];
  const lot = plant.batchLog.find((b) => b.consumedLotIds.length)?.consumedLotIds[0];
  const targets = [
    "/bootstrap",
    "/stock/levels?limit=200",
    "/stock/lots?limit=200",
    "/stock/lots?status=quarantine&limit=200",
    "/stock/movements?limit=200",
    "/sales/orders?limit=100",
    "/sales/commitments?from=2026-01-01&to=2026-12-31",
    "/production/batches?limit=200",
    "/purchasing/orders?limit=200",
    "/purchasing/suggestions",
    "/purchasing/supplier-performance",
    "/quality/summary",
    "/quality/trends",
    "/quality/complaints?limit=200",
    "/haccp/due",
    "/haccp/logs?limit=200",
    "/haccp/deviations",
    "/training/matrix",
    "/training/due",
    "/despatch?limit=200",
    "/search?q=sourdough",
    "/customers",
    "/suppliers/compliance",
    ...(lot
      ? [`/production/lots/${lot}/trace`, `/despatch/lots/${lot}/impact?limit=200`, `/stock/lots/${lot}`]
      : []),
  ];
  for (const t of targets) {
    const t0 = performance.now();
    const res = await w.ctx.req(`/v1/workspaces/acme${t}`, { cookie: md.cookie });
    const text = await res.text();
    const ms = Math.round(performance.now() - t0);
    rows.push({ path: t.replace(lot ?? "~", ":lot"), ms, bytes: text.length, status: res.status });
    if (res.status >= 500)
      w.findings.record({
        kind: "server_error",
        day: w.day,
        who: "scale",
        what: `GET ${t.replace(lot ?? "~", ":lot")} -> ${res.status} at one-year volume`,
        detail: text.slice(0, 300),
      });
    else if (res.status >= 400)
      w.findings.record({
        kind: "unexpected_status",
        day: w.day,
        who: "scale",
        what: `GET ${t.replace(lot ?? "~", ":lot")} -> ${res.status}`,
        detail: text.slice(0, 200),
      });
    if (ms > 2000)
      w.findings.record({
        kind: "scenario",
        day: w.day,
        who: "scale",
        what: `slow read at one-year volume: GET ${t.replace(lot ?? "~", ":lot")}`,
        detail: { ms },
      });
  }
  // Full sync replay: what a new device does on first connect.
  let after = "0",
    pages = 0,
    changes = 0;
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) {
    const r = await w.call(md, "GET", `/sync?after=${after}&limit=500`);
    if (!r.ok) break;
    pages++;
    changes += r.body.changes.length;
    after = r.body.cursor;
    if (!r.body.hasMore) break;
  }
  const replayMs = Math.round(performance.now() - t0);
  // Replay must reach the head: cursor at the end equals the bootstrap cursor.
  const boot = await w.call(md, "GET", "/bootstrap");
  if (String(boot.body?.cursor) !== String(after) && changes > 0)
    w.findings.record({
      kind: "invariant",
      day: w.day,
      who: "scale",
      what: "sync replay does not end at the bootstrap cursor",
      detail: { after, bootstrap: boot.body?.cursor },
    });
  return {
    reads: rows.sort((a, b) => b.ms - a.ms).slice(0, 8),
    bootstrapBytes: rows.find((r) => r.path === "/bootstrap")?.bytes,
    syncReplay: { pages, changes, ms: replayMs },
  };
}

/** Orders: the server's shipped/outstanding must agree with what the plant shipped, and nothing ships more than ordered. */
export async function fulfilmentProbe(w: World, plant: Plant) {
  const sales = w.people.get("salesMgr")!;
  let checked = 0,
    over = 0,
    mismatch = 0;
  const sample = plant.allOrders.filter(
    (_, i) => i % Math.max(1, Math.floor(plant.allOrders.length / 60)) === 0,
  );
  for (const o of sample) {
    const r = await w.call(sales, "GET", `/sales/orders/${o.id}/fulfilments`, undefined, [200, 404]);
    if (!r.ok) continue;
    checked++;
    for (const l of o.lines) {
      const sl = (r.body.lines ?? []).find(
        (x: any) => x.orderLineId === l.lineId || x.lineId === l.lineId || x.id === l.lineId,
      );
      if (!sl) continue;
      if (sl.shipped > l.qty + 1e-6) {
        over++;
        w.findings.record({
          kind: "invariant",
          day: w.day,
          who: "fulfilment",
          what: "order line shipped more than ordered",
          detail: { ordered: l.qty, shipped: sl.shipped },
        });
      }
      if (Math.abs(sl.shipped - l.shipped) > 1e-6) {
        mismatch++;
        w.findings.record({
          kind: "invariant",
          day: w.day,
          who: "fulfilment",
          what: "server shipped quantity differs from what was despatched",
          detail: { model: l.shipped, server: sl.shipped },
        });
      }
    }
  }
  return { checked, over, mismatch };
}
