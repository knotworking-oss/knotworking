import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { addDays } from "@knotworking/core";
import { World } from "./lib/world";
import { createMaster, createPeople } from "./lib/setup";
import { Plant } from "./lib/plant";
import { makeRng } from "./lib/rng";
import { runDays } from "./lib/run";
import { Compliance } from "./lib/compliance";
import {
  destructiveProbe,
  idempotencyProbe,
  offboardingProbe,
  stockSafetyProbe,
  traceProbe,
} from "./lib/probes";

const WEEKS = Number(process.env.SIM_WEEKS ?? 4);
const END = process.env.SIM_END ?? "2026-11-13";

describe("adversarial probes after a run", () => {
  const w = new World();
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${addDays(END, -WEEKS * 7)}T06:00:00Z`));
    await w.boot();
  }, 120_000);
  afterAll(() => w.ctx.handle.close());
  it("probes", async () => {
    const rng = makeRng(7);
    const start = addDays(END, -WEEKS * 7);
    w.setDay(start);
    await createPeople(w);
    const master = await createMaster(w, rng);
    const plant = new Plant(w, master, rng);
    await plant.raiseOrders(start, 2.0, 0);
    await plant.goodsIn(start);
    await plant.qaRelease(start);
    const comp = new Compliance(w, master, rng);
    await comp.setup(start);
    await runDays(w, plant, addDays(start, 1), END, comp);
    w.setDay(END, 10);
    const results: Record<string, unknown> = {};
    results.trace = await traceProbe(w, plant);
    results.destructive = await destructiveProbe(w, plant, master);
    await idempotencyProbe(w, plant, master);
    results.stockSafety = await stockSafetyProbe(w, plant, master);
    results.offboarding = await offboardingProbe(w);
    await plant.checkInvariants(w.day);
    const summary = {
      weeks: WEEKS,
      requests: w.requests,
      stats: plant.stats,
      compliance: {
        stats: comp.stats,
        readings: comp.readingsLogged,
        deviations: comp.deviations,
        mismatch: comp.deviationMismatch,
        staff: comp.staff.length,
        courses: comp.courses.length,
        ccps: Object.keys(comp.ccpIds).length,
      },
      results,
      findings: w.findings.count(),
      serverErrors: w.findings.count("server_error"),
    };
    w.findings.save(`sim/out/probes.json`, summary);
    console.log("SUMMARY", JSON.stringify(summary));
    for (const f of w.findings.all)
      console.log("FINDING", f.kind, f.count, f.first, f.who, f.what, JSON.stringify(f.detail).slice(0, 400));
  }, 3_600_000);
});
