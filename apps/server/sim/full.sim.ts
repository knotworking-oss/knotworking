import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { addDays } from "@knotworking/core";
import { World } from "./lib/world";
import { checkPersonaAccess, createMaster, createPeople } from "./lib/setup";
import { Plant } from "./lib/plant";
import { Compliance } from "./lib/compliance";
import { Events } from "./lib/events";
import { makeRng } from "./lib/rng";
import { dow, runDays } from "./lib/run";
import {
  destructiveProbe,
  fulfilmentProbe,
  idempotencyProbe,
  offboardingProbe,
  scaleProbe,
  stockSafetyProbe,
  traceProbe,
} from "./lib/probes";

const SEED = Number(process.env.SIM_SEED ?? 1);
const WEEKS = Number(process.env.SIM_WEEKS ?? 52);
const END = process.env.SIM_END ?? "2026-11-13";

describe(`full year (seed ${SEED}, ${WEEKS} weeks)`, () => {
  const w = new World();
  const t0 = performance.now();
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${addDays(END, -WEEKS * 7)}T06:00:00Z`));
    await w.boot();
  }, 120_000);
  afterAll(() => w.ctx.handle.close());
  it("runs", async () => {
    const rng = makeRng(SEED);
    const start = addDays(END, -WEEKS * 7);
    w.setDay(start);
    await createPeople(w);
    const master = await createMaster(w, rng);
    const plant = new Plant(w, master, rng);
    const comp = new Compliance(w, master, rng);
    const ev = new Events(w, master, rng);
    await comp.setup(start);
    await ev.staggerSupplierReviews(start);
    await plant.raiseOrders(start, 2.0, 0);
    await plant.goodsIn(start);
    await plant.qaRelease(start);
    await ev.priceAgreements(start);

    // Run week by week so periodic events fire on the right days.
    let weekStart = addDays(start, 1);
    let week = 0;
    const progress: string[] = [];
    while (weekStart <= END) {
      const weekEnd = addDays(weekStart, 6) > END ? END : addDays(weekStart, 6);
      await runDays(w, plant, weekStart, weekEnd, comp);
      w.setDay(weekEnd, 16);
      await ev.supplierReviews(weekEnd);
      if (week % 6 === 3) await ev.lapsedSupplierOrder(weekEnd);
      await ev.cancelSomeOrders(weekEnd, plant);
      if (week % 5 === 2) await ev.recordReversal(weekEnd, plant);
      if (week === 20 || week === 38) await ev.leaverAndJoiner(weekEnd);
      if (week === 26) await ev.priceAgreements(weekEnd);
      week++;
      if (week % 4 === 0)
        progress.push(
          `w${week} ${Math.round((performance.now() - t0) / 1000)}s req=${w.requests} findings=${w.findings.count()}`,
        );
      if (week % 4 === 0) console.log("PROGRESS", progress.at(-1));
      weekStart = addDays(weekEnd, 1);
    }
    w.setDay(END, 10);
    const results: Record<string, unknown> = { personaCutoffs: checkPersonaAccess(w) };
    results.scale = await scaleProbe(w, plant, master);
    results.fulfilment = await fulfilmentProbe(w, plant);
    results.trace = await traceProbe(w, plant);
    results.destructive = await destructiveProbe(w, plant, master);
    await idempotencyProbe(w, plant, master);
    results.stockSafety = await stockSafetyProbe(w, plant, master);
    results.offboarding = await offboardingProbe(w);
    await plant.checkInvariants(w.day);
    const summary = {
      seed: SEED,
      weeks: WEEKS,
      seconds: Math.round((performance.now() - t0) / 1000),
      requests: w.requests,
      statuses: w.statuses,
      plant: plant.stats,
      compliance: {
        ...comp.stats,
        readings: comp.readingsLogged,
        deviations: comp.deviations,
        mismatch: comp.deviationMismatch,
      },
      events: ev.stats,
      results,
      findings: w.findings.count(),
      serverErrors: w.findings.count("server_error"),
    };
    w.findings.save(`sim/out/full-seed${SEED}-w${WEEKS}.json`, summary);
    console.log("SUMMARY", JSON.stringify(summary));
    for (const f of w.findings.all)
      console.log("FINDING", f.kind, f.count, f.first, f.who, f.what, JSON.stringify(f.detail).slice(0, 300));
  }, 7_200_000);
});
