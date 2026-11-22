import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { addDays } from "@knotworking/core";
import { World } from "../lib/world";
import { createMaster, createPeople } from "../lib/setup";
import { Plant } from "../lib/plant";
import { Compliance } from "../lib/compliance";
import { makeRng } from "../lib/rng";
import { runDays } from "../lib/run";

/** Builds the real base data (people, master data, one week of activity) in an empty Postgres database. */
describe("scale base data", () => {
  const w = new World();
  const END = "2026-11-13";
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${addDays(END, -14)}T06:00:00Z`));
    await w.boot();
  }, 120_000);
  afterAll(() => w.ctx.handle.close());
  it("builds", async () => {
    const rng = makeRng(11);
    const start = addDays(END, -14);
    w.setDay(start);
    await createPeople(w);
    const master = await createMaster(w, rng);
    const plant = new Plant(w, master, rng);
    const comp = new Compliance(w, master, rng);
    await comp.setup(start);
    await plant.raiseOrders(start, 2, 0);
    await plant.goodsIn(start);
    await plant.qaRelease(start);
    await runDays(w, plant, addDays(start, 1), END, comp);
    const md = w.people.get("md")!;
    const boot = await w.call(md, "GET", "/bootstrap");
    const batch = plant.batchLog.find((b) => b.outputLotId && b.consumedLotIds.length)!;
    mkdirSync("sim/out", { recursive: true });
    writeFileSync(
      "sim/out/scale-base.json",
      JSON.stringify({
        workspaceId: boot.body.workspace.id,
        end: END,
        requests: w.requests,
        findings: w.findings.count(),
        traceLot: batch.consumedLotIds[0],
        outputLot: batch.outputLotId,
        batchId: batch.batchId,
        ingredientIds: master.ingredients.map((i) => i.id),
        productIds: master.products.map((p) => p.id),
        locations: master.locations,
        supplierIds: master.suppliers.map((s) => s.id),
        actorId: md.userId,
      }),
    );
    console.log(
      "BASE",
      JSON.stringify({ requests: w.requests, findings: w.findings.count(), stats: plant.stats }),
    );
  }, 1_800_000);
});
