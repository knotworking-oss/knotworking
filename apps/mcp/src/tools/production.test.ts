import { newId } from "@knotworking/core";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeApi } from "../testing/fake-api";
import { connect } from "../testing/harness";

type Session = Awaited<ReturnType<typeof connect>>;
const open: Session[] = [];
async function session(options: Parameters<typeof connect>[0] = {}) {
  const s = await connect(options);
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/** A finished cake (450 g each) whose approved recipe makes 12 from 1.5 kg flour and 1 l milk. */
function seedCake(fake: FakeApi) {
  const items = fake.itemsModule.items;
  const cake = {
    ...items.find((i) => i.code === "BOX-12")!,
    id: newId(),
    code: "CAKE",
    name: "Cake",
    type: "finished",
    unitWeightG: 450,
  };
  items.push(cake);
  const flour = items.find((i) => i.code === "FLR-001")!;
  const milk = items.find((i) => i.code === "MLK-001")!;
  const line = (itemId: string, quantity: number, unit: string) => ({
    id: newId(),
    itemId,
    quantity,
    unit,
    note: null,
  });
  fake.recipesModule.recipes.push({
    id: newId(),
    code: "R-CAKE",
    name: "Cake",
    description: null,
    status: "active",
    outputItemId: cake.id,
    versions: [
      {
        id: newId(),
        versionNumber: 3,
        status: "approved",
        yieldQuantity: 12,
        yieldUnit: "each",
        method: null,
        changeNote: null,
        approvedAt: "2026-11-01T09:00:00.000Z",
        approvedBy: "Ada Lovelace",
        lines: [line(flour.id, 1.5, "kg"), line(milk.id, 1, "l")],
      },
    ],
  });
  return { cake, flour, milk };
}

describe("production tools", () => {
  it("offers nineteen production-named tools by default, none for recording output or consumption, cancelling or signing off a batch", async () => {
    const { client } = await session();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const production = names.filter((n) =>
      /production|material|trace|batches|reserv|assign_batch|non_working/.test(n),
    );
    expect(production.sort()).toEqual(
      [
        "list_production_batches",
        "get_production_batch",
        "plan_production_batch",
        "propose_batches_from_demand",
        "get_material_requirements",
        "trace_lot",
        "reserve_batch_ingredients",
        "unreserve_batch_ingredients",
        "list_production_lines",
        "get_production_schedule",
        "get_production_day_plan",
        "set_production_sequence",
        "get_production_daily_demand",
        "get_production_performance",
        "record_production_downtime",
        "list_production_devices",
        "assign_batch_line",
        "list_production_days_off",
        "set_non_working_days",
      ].sort(),
    );
    const propose = tools.find((t) => t.name === "propose_batches_from_demand")!;
    expect(propose.annotations).toMatchObject({ readOnlyHint: true });
    expect(names.join(" ")).not.toMatch(/complete|(?<![a-z])sign|start_batch|consum|record_output|cancel/);
    const plan = tools.find((t) => t.name === "plan_production_batch")!;
    expect(plan.description).toMatch(/done by people in the app/);
    expect(plan.description).toMatch(/unless an owner or admin allows it under Settings → API access/);
  });

  describe("reservations and lines", () => {
    const plan = (call: Session["call"], extra: object = {}) =>
      call("plan_production_batch", {
        workspace: "acme",
        recipe: "R-CAKE",
        planned_on: "2026-11-20",
        batches: 1,
        ...extra,
      });

    it("reserves a lot for a batch and releases it by hand", async () => {
      const { call, fake } = await session();
      const { flour } = seedCake(fake);
      const lot = (
        await call("receive_stock", {
          item: flour.code,
          quantity: 5,
          unit: "kg",
          location: "Dry store",
          received_on: "2026-11-11",
          lot_code: "FL-R1",
        })
      ).data;
      const batch = await plan(call);
      const res = await call("reserve_batch_ingredients", {
        workspace: "acme",
        batch: batch.data.batchCode,
        lines: [{ lot: lot.id, quantity: 4, unit: "kg" }],
      });
      expect(res.isError).toBe(false);
      expect(res.data.reservations).toHaveLength(1);
      expect(res.data.reservations[0]).toMatchObject({ lotCode: lot.lotCode, status: "active" });
      const again = await call("reserve_batch_ingredients", {
        workspace: "acme",
        batch: batch.data.batchCode,
        lines: [{ lot: lot.id, item: flour.code, quantity: 1, unit: "kg" }],
      });
      expect(again.isError).toBe(true);
      const released = await call("unreserve_batch_ingredients", {
        workspace: "acme",
        reservation: res.data.reservations[0].id,
      });
      expect(released.data.reservations[0].status).toBe("released");
    });

    it("assigns a batch to a line and reports the load and an overload warning", async () => {
      const { call, fake } = await session();
      seedCake(fake);
      const recipe = fake.recipesModule.recipes.find((r: any) => r.code === "R-CAKE")!;
      fake.productionModule.lines.push({
        id: newId(),
        name: "Line 1",
        active: true,
        hoursPerDay: 8,
        rates: { [recipe.id]: 12 },
      });
      const a = await plan(call, { batches: 5 });
      const b = await plan(call, { batches: 5 });
      const assigned = await call("assign_batch_line", {
        workspace: "acme",
        batch: a.data.batchCode,
        line: "Line 1",
      });
      expect(assigned.isError).toBe(false);
      expect(assigned.data.line).toBe("Line 1");
      await call("assign_batch_line", { workspace: "acme", batch: b.data.batchCode, line: "line 1" });
      const schedule = await call("get_production_schedule", {
        workspace: "acme",
        from: "2026-11-20",
        to: "2026-11-21",
      });
      const day = schedule.data.lines[0].days[0];
      expect(day).toMatchObject({ hours: 10, capacityHours: 8, overloaded: true });
      const dayPlan = await call("get_production_day_plan", {
        workspace: "acme",
        line: "Line 1",
        date: "2026-11-20",
      });
      expect(dayPlan.data.steps.length).toBeGreaterThan(0);
      const codes = dayPlan.data.steps.map((s: { batchCode: string }) => s.batchCode).reverse();
      const stale = await call("set_production_sequence", {
        workspace: "acme",
        line: "Line 1",
        date: "2026-11-20",
        batches: codes.slice(1),
      });
      expect(stale.isError).toBe(true);
      const applied = await call("set_production_sequence", {
        workspace: "acme",
        line: "Line 1",
        date: "2026-11-20",
        batches: codes,
      });
      expect(applied.data.steps.map((s: { batchCode: string }) => s.batchCode)).toEqual(codes);
      const daily = await call("get_production_daily_demand", { workspace: "acme", days: 7 });
      expect(daily.data.basis.weeklyDemandCombined).toBe(false);
      const down = await call("record_production_downtime", {
        workspace: "acme",
        line: "Line 1",
        date: "2026-11-20",
        minutes: 20,
        reason: "breakdown",
        batch: a.data.batchCode,
      });
      expect(down.data).toMatchObject({ minutes: 20, reason: "breakdown", category: "unplanned" });
      const badReason = await call("record_production_downtime", {
        workspace: "acme",
        line: "Line 1",
        date: "2026-11-20",
        minutes: 20,
        reason: "coffee",
      });
      expect(badReason.isError).toBe(true);
      const notStarted = await call("record_batch_rejects", {
        workspace: "acme",
        batch: a.data.batchCode,
        quantity: 2,
        unit: "each",
        reason: "damaged",
      });
      expect(notStarted.isError).toBe(true);
      const labour = await call("record_batch_labour", {
        workspace: "acme",
        batch: a.data.batchCode,
        people: 2,
        minutes: 30,
      });
      expect(labour.isError).toBe(true);
      const perf = await call("get_production_performance", {
        workspace: "acme",
        from: "2026-11-20",
        to: "2026-11-20",
      });
      expect(perf.data.definitions.version).toBe("oee-v1");
      const notStartedPack = await call("open_packing_run", {
        workspace: "acme",
        batch: a.data.batchCode,
        label: null,
        expected_date_code: "BB 24 NOV 26",
      });
      expect(notStartedPack.isError).toBe(true);
      const startedBatch = fake.productionModule.batches.find((x: any) => x.batchCode === b.data.batchCode)!;
      startedBatch.status = "in_progress";
      const opened = await call("open_packing_run", {
        workspace: "acme",
        batch: b.data.batchCode,
        label: null,
        expected_date_code: "BB 24 NOV 26",
        nominal_quantity: 250,
      });
      const run = opened.data.open.id;
      const badCheck = await call("record_packing_check", {
        workspace: "acme",
        run,
        check: { kind: "nonsense" },
      });
      expect(badCheck.isError).toBe(true);
      const failedNoAction = await call("record_packing_check", {
        workspace: "acme",
        run,
        check: { kind: "weight_sample", readings: [200] },
      });
      expect(failedNoAction.isError).toBe(true);
      const passed = await call("record_packing_check", {
        workspace: "acme",
        run,
        check: {
          kind: "first_off",
          labelCorrect: true,
          dateCodeSeen: "bb 24 nov 26",
          lotCodeSeen: b.data.batchCode,
          legible: true,
        },
      });
      expect(passed.data.open.checks[0]).toMatchObject({ kind: "first_off", passed: true });
      const packing = await call("get_batch_packing", { workspace: "acme", batch: b.data.batchCode });
      expect(packing.data.open.id).toBe(run);
      const deviceId = newId();
      fake.productionModule.devices.push({ id: deviceId, code: "SC-1", kind: "scale", unit: "kg" });
      const sent = await call("send_device_readings", {
        workspace: "acme",
        device: deviceId,
        readings: [
          { reading_id: "1", taken_at: "2026-11-20T08:00:00Z", value: 0.4, unit: "kg" },
          { reading_id: "1", taken_at: "2026-11-20T08:00:00Z", value: 0.4, unit: "kg" },
        ],
      });
      expect(sent.data).toMatchObject({ accepted: 1, duplicate: 1 });
      const resent = await call("send_device_readings", {
        workspace: "acme",
        device: deviceId,
        readings: [{ reading_id: "1", taken_at: "2026-11-20T08:05:00Z", value: 0.4, unit: "kg" }],
      });
      expect(resent.data).toMatchObject({ conflict: 1 });
      const read = await call("list_device_readings", { workspace: "acme", device: deviceId, unused: true });
      expect(read.data.readings).toHaveLength(1);
      const listed = await call("list_production_devices", { workspace: "acme" });
      expect(listed.data.devices[0].code).toBe("SC-1");
      const lines = await call("list_production_lines", { workspace: "acme" });
      expect(lines.data.lines[0].recipes[0].recipeCode).toBe("R-CAKE");
      const missing = await call("assign_batch_line", {
        workspace: "acme",
        batch: a.data.batchCode,
        line: "Nope",
      });
      expect(missing.isError).toBe(true);
    });
  });

  describe("cancel_production_batch (API access)", () => {
    const plan = (call: Session["call"]) =>
      call("plan_production_batch", {
        workspace: "acme",
        recipe: "R-CAKE",
        planned_on: "2026-11-20",
        batches: 1,
      });

    it("appears only when production.cancel is enabled", async () => {
      const off = await session();
      expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain(
        "cancel_production_batch",
      );
      const on = await session({ enable: ["production.cancel"] });
      const tool = (await on.client.listTools()).tools.find((t) => t.name === "cancel_production_batch")!;
      expect(tool.description).toMatch(/owner or admin allowed API tokens .* under Settings → API access/);
      expect(tool.description).toMatch(/write access.*manage access/);
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    });

    it("cancels a planned batch by code with a reason, and refuses a second cancel", async () => {
      const { call, fake } = await session({ enable: ["production.cancel"] });
      seedCake(fake);
      const planned = await plan(call);
      const res = await call("cancel_production_batch", {
        workspace: "acme",
        batch: planned.data.batchCode,
        reason: "Order withdrawn",
      });
      expect(res.isError).toBe(false);
      expect(res.data).toMatchObject({
        batchCode: planned.data.batchCode,
        status: "cancelled",
        cancelled: { reason: "Order withdrawn" },
      });
      expect(fake.requests.at(-1)).toMatchObject({ method: "POST" });
      expect(fake.requests.at(-1)!.path).toBe(
        `/v1/workspaces/acme/production/batches/${planned.data.id}/cancel`,
      );
      const again = await call("cancel_production_batch", {
        workspace: "acme",
        batch: planned.data.id,
        reason: "Again",
      });
      expect(again.data.error.code).toBe("invalid_batch_status");
    });

    it("surfaces a token_not_allowed refusal readably", async () => {
      const { call, fake } = await session({ enable: ["production.cancel"] });
      seedCake(fake);
      const planned = await plan(call);
      fake.tokenActions.clear();
      const res = await call("cancel_production_batch", {
        workspace: "acme",
        batch: planned.data.id,
        reason: "x",
      });
      expect(res.isError).toBe(true);
      expect(res.data.error).toMatchObject({ code: "token_not_allowed", status: 403 });
      expect(res.data.error.message).toMatch(/Cancel production batches/);
      expect(fake.productionModule.batches[0]!.status).toBe("planned");
    });
  });

  it("plans a batch by recipe code, by batches or by output, on the approved version", async () => {
    const { call, fake } = await session();
    const { cake } = seedCake(fake);
    const res = await call("plan_production_batch", {
      workspace: "acme",
      recipe: "r-cake",
      planned_on: "2026-11-12",
      batches: 2,
      output_location: "ds",
    });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({
      batchCode: "B261112-001",
      status: "planned",
      recipe: { code: "R-CAKE" },
      recipeVersion: { versionNumber: 3, status: "approved" },
      outputItem: { id: cake.id },
      batches: 2,
      planned: { base: 24, baseUnit: "each" },
      outputLocation: "Dry store",
      materials: [
        { item: { code: "FLR-001" }, required: { base: 3000, display: 3, displayUnit: "kg" } },
        { item: { code: "MLK-001" }, required: { base: 2000, baseUnit: "ml" } },
      ],
    });
    const byOutput = await call("plan_production_batch", {
      recipe: "R-CAKE",
      planned_on: "2026-11-13",
      output_quantity: 2.7,
      output_unit: "kg",
    });
    expect(byOutput.data).toMatchObject({ planned: { base: 6 }, batches: 0.5 });

    const both = await call("plan_production_batch", { recipe: "R-CAKE", planned_on: "2026-11-13" });
    expect(both.isError).toBe(true);
    expect(both.data.error.code).toBe("invalid_input");
    // The sponge's output (a box, no unit weight) can't take a 10 kg yield: the API says so.
    const sponge = await call("plan_production_batch", {
      recipe: "SPONGE",
      planned_on: "2026-11-13",
      batches: 1,
    });
    expect(sponge.data.error.code).toBe("unit_not_convertible");
    expect(fake.productionModule.batches).toHaveLength(2);
  });

  it("proposes batches from demand per item and week, and plans the proposal in one go", async () => {
    const { call, fake } = await session();
    const { cake } = seedCake(fake);
    // A second approved recipe for the cake: the agent must say which to use.
    const other = structuredClone(fake.recipesModule.recipes.find((r) => r.code === "R-CAKE")!);
    Object.assign(other, { id: newId(), code: "R-CAKE-SMALL", name: "Small cake" });
    Object.assign(other.versions[0]!, { id: newId(), yieldQuantity: 6 });
    fake.recipesModule.recipes.push(other);
    const demand = (itemId: string, periodStart: string, quantity: number) =>
      fake.demandModule.lines.push({ id: newId(), itemId, periodStart, customer: null, quantity });
    demand(cake.id, "2026-11-09", 30);
    demand(cake.id, "2026-11-16", 25);
    demand(fake.demandModule.products[0]!.id, "2026-11-09", 5); // CAKE-1: no recipe
    await call("plan_production_batch", { recipe: "R-CAKE", planned_on: "2026-11-12", batches: 1 });

    const ambiguous = await call("propose_batches_from_demand", { from: "2026-W46", to: "2026-W47" });
    expect(ambiguous.isError).toBe(false);
    expect(ambiguous.data.weeks).toEqual(["2026-W46", "2026-W47"]);
    expect(ambiguous.data.items.map((i: { item: { code: string } }) => i.item.code)).toEqual([
      "CAKE",
      "CAKE-1",
    ]);
    expect(ambiguous.data.items[0]).toMatchObject({ issue: "choose_recipe", recipe: null });
    expect(ambiguous.data.items[0].options.map((o: { code: string }) => o.code)).toEqual([
      "R-CAKE",
      "R-CAKE-SMALL",
    ]);
    expect(ambiguous.data.items[1]).toMatchObject({ issue: "no_recipe" });
    expect(ambiguous.data.plan).toEqual([]);

    const proposal = await call("propose_batches_from_demand", {
      from: "2026-11-09",
      to: "2026-W47",
      recipes: ["r-cake"],
    });
    const row = proposal.data.items[0];
    expect(row).toMatchObject({ recipe: { code: "R-CAKE", versionNumber: 3, perBatch: { base: 12 } } });
    expect(row.issue).toBeUndefined();
    expect(row.weeks).toMatchObject([
      {
        week: "2026-W46",
        demand: { base: 30 },
        planned: { base: 12 },
        gap: { base: 18 },
        suggestedBatches: 2,
        suggestedOutput: { base: 24 },
        batches: [{ batchCode: "B261112-001", status: "planned" }],
      },
      { week: "2026-W47", gap: { base: 25 }, suggestedBatches: 3 },
    ]);
    expect(proposal.data.plan).toEqual([
      { recipe: "R-CAKE", planned_on: "2026-11-09", batches: 2 },
      { recipe: "R-CAKE", planned_on: "2026-11-16", batches: 3 },
    ]);

    const planned = await call("plan_production_batch", { plan: proposal.data.plan });
    expect(planned.isError).toBe(false);
    expect(planned.data.planned).toBe(2);
    expect(planned.data.batches).toMatchObject([
      { batchCode: "B261109-001", batches: 2, planned: { base: 24 } },
      { batchCode: "B261116-001", batches: 3, planned: { base: 36 } },
    ]);
    expect(fake.productionModule.batches).toHaveLength(3);

    // Covered now: only the item without a recipe is left.
    const after = await call("propose_batches_from_demand", {
      from: "2026-W46",
      to: "2026-W47",
      recipes: ["R-CAKE"],
      gaps_only: true,
    });
    expect(after.data.items.map((i: { item: { code: string } }) => i.item.code)).toEqual(["CAKE-1"]);
    expect(after.data.plan).toEqual([]);
  });

  it("plans a list all or nothing, and refuses a list mixed with single-batch fields", async () => {
    const { call, fake } = await session();
    seedCake(fake);
    const refused = await call("plan_production_batch", {
      plan: [
        { recipe: "R-CAKE", planned_on: "2026-11-16", batches: 1 },
        { recipe: "SPONGE", planned_on: "2026-11-16", batches: 1 },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(refused.data.error.code).toBe("unit_not_convertible");
    expect(refused.data.error.message).toMatch(/^Batch 2 /);
    expect(fake.productionModule.batches).toHaveLength(0);

    const mixed = await call("plan_production_batch", {
      recipe: "R-CAKE",
      planned_on: "2026-11-16",
      plan: [{ recipe: "R-CAKE", planned_on: "2026-11-16", batches: 1 }],
    });
    expect(mixed.data.error.code).toBe("invalid_input");
    const unsized = await call("plan_production_batch", {
      plan: [{ recipe: "R-CAKE", planned_on: "2026-11-16" }],
    });
    expect(unsized.data.error.code).toBe("invalid_input");
    expect(unsized.data.error.message).toMatch(/plan\[0\]/);
    expect(fake.productionModule.batches).toHaveLength(0);
  });

  it("lists and gets batches by date, status and code", async () => {
    const { call, fake } = await session();
    seedCake(fake);
    await call("plan_production_batch", { recipe: "R-CAKE", planned_on: "2026-11-14", batches: 1 });
    await call("plan_production_batch", {
      recipe: "R-CAKE",
      planned_on: "2026-11-12",
      batches: 1,
      batch_code: "EARLY",
    });
    const list = await call("list_production_batches", {
      from: "2026-11-01",
      to: "2026-11-30",
      status: "open",
    });
    expect(list.data.batches.map((b: { batchCode: string }) => b.batchCode)).toEqual([
      "EARLY",
      "B261114-001",
    ]);
    expect(list.data).toMatchObject({ total: 2, hasMore: false });
    expect((await call("list_production_batches", { recipe: "R-CAKE", to: "2026-11-12" })).data.total).toBe(
      1,
    );
    const one = await call("get_production_batch", { batch: "early" });
    expect(one.data).toMatchObject({
      batchCode: "EARLY",
      materials: [{ consumed: { base: 0 } }, {}],
      records: [],
    });
    expect((await call("get_production_batch", { batch: "NOPE" })).data.error.code).toBe("not_found");
  });

  it("rolls up material requirements against stock, optionally shortfalls only", async () => {
    const { call, fake } = await session();
    const { flour } = seedCake(fake);
    await call("receive_stock", {
      item: "FLR-001",
      quantity: 4,
      unit: "kg",
      location: "Dry store",
      received_on: "2026-11-11",
    });
    await call("plan_production_batch", { recipe: "R-CAKE", planned_on: "2026-11-12", batches: 2 });
    const res = await call("get_material_requirements", { from: "2026-11-12", to: "2026-11-12" });
    expect(res.isError).toBe(false);
    expect(res.data.requirements).toMatchObject([
      { item: { id: flour.id }, required: { base: 3000 }, available: { base: 4000 }, shortfall: { base: 0 } },
      {
        item: { code: "MLK-001" },
        required: { base: 2000 },
        available: { base: 0 },
        shortfall: { base: 2000 },
      },
    ]);
    const short = await call("get_material_requirements", {
      from: "2026-11-12",
      to: "2026-11-12",
      shortfalls_only: true,
    });
    expect(short.data.requirements.map((r: { item: { code: string } }) => r.item.code)).toEqual(["MLK-001"]);
    expect(
      (await call("get_material_requirements", { from: "2026-11-12", to: "2026-11-01" })).data.error.code,
    ).toBe("invalid_input");
  });

  it("traces a lot forward and backward by lot code, with its mass balance", async () => {
    const { call, fake } = await session();
    const { cake } = seedCake(fake);
    const flourLot = (
      await call("receive_stock", {
        item: "FLR-001",
        quantity: 5,
        unit: "kg",
        location: "Dry store",
        received_on: "2026-11-11",
        lot_code: "FL-9",
        supplier: "Shipton Mill",
        supplier_lot_code: "SM-1",
      })
    ).data;
    const batch = (
      await call("plan_production_batch", { recipe: "R-CAKE", planned_on: "2026-11-11", batches: 1 })
    ).data;
    const cakeLot = {
      id: newId(),
      itemId: cake.id,
      lotCode: batch.batchCode,
      supplierId: null,
      supplierLotCode: null,
      receivedOn: "2026-11-11",
      expiresOn: "2026-11-16",
      expiryType: "best_before",
      status: "quarantine",
    };
    fake.stockModule.lots.push(cakeLot);
    fake.productionModule.record(batch.id, "consumption", flourLot.id, 1500);
    fake.productionModule.record(batch.id, "output", cakeLot.id, 12);

    const fwd = await call("trace_lot", { lot: "fl-9" });
    expect(fwd.isError).toBe(false);
    expect(fwd.data).toMatchObject({
      lot: { lotCode: "FL-9" },
      massBalance: { received: { base: 5000 }, consumed: { base: 1500 }, onHand: { base: 3500 } },
      forward: [
        {
          depth: 1,
          batch: { batchCode: batch.batchCode, recipe: "R-CAKE", recipeVersion: 3 },
          consumed: { lot: { lotCode: "FL-9" }, amount: { base: 1500 } },
          produced: [
            { lot: { lotCode: batch.batchCode, item: "CAKE", onHand: { base: 12 } }, amount: { base: 12 } },
          ],
        },
      ],
      backward: [],
    });
    const back = await call("trace_lot", { lot: batch.batchCode, item: "CAKE" });
    expect(back.data.backward[0]).toMatchObject({
      produced: { lot: { lotCode: batch.batchCode } },
      consumed: [{ lot: { lotCode: "FL-9", supplierLotCode: "SM-1" }, amount: { base: 1500 } }],
    });
    expect((await call("trace_lot", { lot: "NOPE" })).data.error.code).toBe("not_found");
  });
});
