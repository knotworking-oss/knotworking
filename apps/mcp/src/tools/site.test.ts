import { afterEach, describe, expect, it } from "vitest";
import { createFakeApi } from "../testing/fake-api";
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

const TOOLS = [
  "get_site_due",
  "list_site_registers",
  "list_site_records",
  "record_pest_visit",
  "record_storage_readings",
  "save_site_register_entry",
  "report_glass_breakage",
  "get_pest_trends",
  "propose_site_action",
];

describe("site programme tools", () => {
  it("offer nothing for sign-offs or corrections", async () => {
    const { client } = await session();
    const tools = (await client.listTools()).tools;
    expect(tools.filter((t) => TOOLS.includes(t.name)).map((t) => t.name)).toEqual(TOOLS);
    const names = tools.map((t) => t.name);
    expect(
      names.filter((n) =>
        /sign_off|release_|clearance|approve|close_site|correct_|review_(reading|storage)/.test(n),
      ),
    ).toEqual([]);
    for (const name of ["record_storage_readings", "record_pest_visit", "report_glass_breakage"]) {
      const description = tools.find((t) => t.name === name)!.description!;
      expect(description, name).toMatch(/signed by people in the app/);
    }
    expect(tools.find((t) => t.name === "record_storage_readings")!.description).toMatch(/NOT approved/);
  });

  describe("get_site_due", () => {
    it("lists what is overdue or due, and counts what waits for a person", async () => {
      const { call } = await session();
      const res = await call("get_site_due", { workspace: "acme" });
      expect(res.isError).toBe(false);
      expect(res.data.items.map((i: { programme: string }) => i.programme)).toEqual(["pest", "storage"]);
      expect(res.data.counts).toMatchObject({ overdue: 1, awaitingReview: 0, openBreakages: 0 });
      const all = await call("get_site_due", { workspace: "acme", include: "all", programme: "checklist" });
      expect(all.data.items).toHaveLength(1);
      expect(all.data.items[0]).toMatchObject({ what: "Line 1 pre-start", state: "ok" });
    });
  });

  describe("list_site_registers", () => {
    it("lists areas, devices, storage units and checklists", async () => {
      const { call } = await session();
      expect(
        (await call("list_site_registers", { workspace: "acme", kind: "areas" })).data.map(
          (a: { name: string }) => a.name,
        ),
      ).toEqual(["Packing hall", "Dispatch"]);
      expect(
        (await call("list_site_registers", { workspace: "acme", kind: "pest_devices" })).data[0],
      ).toMatchObject({ code: "RB-01", area: "Dispatch" });
      const units = (await call("list_site_registers", { workspace: "acme", kind: "storage_units" })).data;
      expect(units.map((u: { limits: string }) => u.limits)).toEqual(["0 to 5 °C", "≤ -18 °C"]);
      const lists = (await call("list_site_registers", { workspace: "acme", kind: "checklists" })).data;
      expect(lists[0]).toMatchObject({
        name: "Line 1 pre-start",
        frequency: "Daily",
        items: [{ prompt: "Metal detector tested" }],
      });
    });
  });

  describe("record_pest_visit", () => {
    it("records a service report with findings by device code", async () => {
      const { call, fake } = await session();
      const res = await call("record_pest_visit", {
        workspace: "acme",
        contractor: "Pestaway",
        visited_on: "2026-11-10",
        next_visit_on: "2026-12-08",
        recommendations: "Fit a door sweep",
        findings: [
          { device: "rb-01", activity: "moderate", pest: "mice", count: 3, action: "Rebaited" },
          { location: "Goods-in corridor", activity: "none" },
        ],
      });
      expect(res.isError).toBe(false);
      expect(res.data).toMatchObject({
        contractor: "Pestaway",
        highestActivity: "moderate",
        findings: 2,
        nextVisitOn: "2026-12-08",
      });
      expect(fake.siteModule.visits[0]!.findings[0].device).toMatchObject({ code: "RB-01" });
      const bad = await call("record_pest_visit", {
        workspace: "acme",
        contractor: "Pestaway",
        visited_on: "2026-11-10",
        findings: [{ device: "NOPE", activity: "none" }],
      });
      expect(bad.data.error.code).toBe("not_found");
    });

    it("is listed with its findings and filtered to visits with activity", async () => {
      const { call } = await session();
      const res = await call("list_site_records", { workspace: "acme", kind: "pest_visits" });
      expect(res.data.visits[0]).toMatchObject({
        contractor: "Pestaway",
        findings: [{ device: "RB-01", activity: "low" }],
      });
      expect(res.data).toMatchObject({ total: 1, hasMore: false });
    });
  });

  describe("record_storage_readings", () => {
    it("records readings pending review, flagging and opening an action for an out-of-limit one", async () => {
      const { call, fake } = await session();
      const res = await call("record_storage_readings", {
        workspace: "acme",
        readings: [
          { unit: "CH-1", value: 3.5 },
          { unit: "Chiller 1", value: 8.5, note: "Door left open", action_taken: "Product probed and moved" },
          { unit: "Freezer 1", value: -20 },
        ],
      });
      expect(res.isError).toBe(false);
      expect(res.data).toMatchObject({ recorded: 3, failed: 0, outOfLimits: 1 });
      expect(res.data.readings[0]).toMatchObject({
        unit: "Chiller 1",
        reading: "3.5 °C",
        withinLimits: true,
        reviewStatus: "pending",
      });
      expect(res.data.readings[1]).toMatchObject({
        withinLimits: false,
        deviationReason: "above_max",
        correctiveAction: { status: "open" },
      });
      expect(res.data.note).toMatch(/await review/);
      expect(fake.siteModule.actions[0]!.actionTaken).toBe("Product probed and moved");

      const pending = await call("list_site_records", {
        workspace: "acme",
        kind: "storage_readings",
        review: "pending",
      });
      expect(pending.data.readings).toHaveLength(3);
      const out = await call("list_site_records", {
        workspace: "acme",
        kind: "storage_readings",
        out_of_limits: true,
        unit: "CH-1",
      });
      expect(out.data.readings.map((r: { reading: string }) => r.reading)).toEqual(["8.5 °C"]);
    });

    it("resolves every unit before recording anything, and reports a refused reading with the others", async () => {
      const { call, fake } = await session();
      const unknown = await call("record_storage_readings", {
        workspace: "acme",
        readings: [
          { unit: "CH-1", value: 3 },
          { unit: "Nope", value: 3 },
        ],
      });
      expect(unknown.data.error.code).toBe("not_found");
      expect(fake.siteModule.readings).toHaveLength(0);
      const future = await call("record_storage_readings", {
        workspace: "acme",
        readings: [
          { unit: "CH-1", value: 3 },
          { unit: "CH-1", value: 4, checked_at: "2999-01-01T00:00:00Z" },
        ],
      });
      expect(future.data).toMatchObject({ recorded: 1, failed: 1 });
      expect(future.data.readings[1]).toMatchObject({ recorded: false, error: { code: "invalid_input" } });
    });
  });

  describe("save_site_register_entry", () => {
    it("creates and updates entries, naming the area and asset instead of ids", async () => {
      const { call, fake } = await session();
      const device = await call("save_site_register_entry", {
        workspace: "acme",
        kind: "pest_device",
        entry: { kind: "rodent_trap", code: "RT-02", location: "Packing hall door", area: "Packing hall" },
      });
      expect(device.data).toMatchObject({ created: true, kind: "pest_device" });
      expect(fake.siteModule.devices.at(-1)).toMatchObject({
        code: "RT-02",
        areaId: fake.siteModule.areas[0]!.id,
      });

      // Assets are added to the register (Assets module); Site only links one to an instrument.
      const refused = await call("save_site_register_entry", {
        workspace: "acme",
        kind: "maintenance_asset",
        entry: { code: "OV-1", name: "Oven 1", area: "dsp" },
      });
      expect(refused.data.error.code).toBe("invalid_input");
      const asset = await call("save_asset", {
        workspace: "acme",
        asset: { kind: "equipment", code: "OV-1", name: "Oven 1", area: "dsp" },
      });
      expect(asset.data).toMatchObject({ created: true, name: "Oven 1" });
      const linked = await call("save_site_register_entry", {
        workspace: "acme",
        kind: "maintenance_asset",
        id: asset.data.id,
        entry: { calibrationInstrumentId: null },
      });
      expect(linked.data).toMatchObject({ created: false });
      const task = await call("save_site_register_entry", {
        workspace: "acme",
        kind: "maintenance_task",
        entry: {
          asset: "OV-1",
          title: "Replace door seals",
          frequency: { every: 3, unit: "month" },
          clearanceRequired: true,
        },
      });
      expect(task.data).toMatchObject({ created: true, name: "Replace door seals" });
      const archived = await call("save_site_register_entry", {
        workspace: "acme",
        kind: "maintenance_task",
        id: task.data.id,
        entry: { status: "archived" },
      });
      expect(archived.data).toMatchObject({ created: false, status: "archived" });

      const unit = await call("save_site_register_entry", {
        workspace: "acme",
        kind: "storage_unit",
        entry: { name: "Chiller 2", kind: "chiller", limitMax: 5 },
      });
      expect(unit.data).toMatchObject({ created: true, name: "Chiller 2" });
      const checklist = await call("save_site_register_entry", {
        workspace: "acme",
        kind: "checklist",
        entry: {
          name: "Allergen changeover",
          kind: "allergen_changeover",
          items: [{ prompt: "Line stripped" }, { prompt: "Swab negative" }],
        },
      });
      expect(checklist.data).toMatchObject({ created: true });
      const item = await call("save_site_register_entry", {
        workspace: "acme",
        kind: "glass_item",
        entry: { area: "Packing hall", kind: "glass", description: "East window" },
      });
      expect(item.data).toMatchObject({ created: true, kind: "glass_item" });
    });

    it("checks the entry like the app does, and says which fields a kind takes", async () => {
      const { call } = await session();
      const bad = await call("save_site_register_entry", {
        workspace: "acme",
        kind: "storage_unit",
        entry: { name: "No limits", kind: "chiller" },
      });
      expect(bad.data.error.code).toBe("invalid_input");
      expect(bad.data.error.message).toMatch(/minimum, a maximum or both/);
      expect(bad.data.error.message).toMatch(/Fields for storage_unit/);
      const noArea = await call("save_site_register_entry", {
        workspace: "acme",
        kind: "pest_device",
        entry: { kind: "rodent_trap", code: "X", location: "y", area: "Atlantis" },
      });
      expect(noArea.data.error.code).toBe("not_found");
    });
  });

  describe("report_glass_breakage", () => {
    it("holds the area, takes the clean-down on update, and never releases it", async () => {
      const { call, fake } = await session();
      const made = await call("report_glass_breakage", {
        workspace: "acme",
        area: "Packing hall",
        description: "Diffuser fell onto line 1",
        quarantined: "Line 1 product 09:00 to 09:40",
      });
      expect(made.data).toMatchObject({ area: "Packing hall", status: "open", cleanDownRecorded: false });
      expect(made.data.note).toMatch(/person with manage access releases the area/);
      const updated = await call("report_glass_breakage", {
        workspace: "acme",
        breakage: made.data.id,
        clean_down: "Line stripped and swabbed",
      });
      expect(updated.data).toMatchObject({ status: "open", cleanDownRecorded: true });
      expect(fake.siteModule.breakages).toHaveLength(1);
      const open = await call("list_site_records", {
        workspace: "acme",
        kind: "glass_breakages",
        status: "open",
      });
      expect(open.data.breakages[0]).toMatchObject({
        status: "open",
        source: "api",
        cleanDown: "Line stripped and swabbed",
      });
      expect(
        (await call("report_glass_breakage", { workspace: "acme", area: "Packing hall" })).data.error.code,
      ).toBe("invalid_input");
      expect(
        (await call("report_glass_breakage", { workspace: "acme", breakage: made.data.id, area: "Dispatch" }))
          .data.error.code,
      ).toBe("invalid_input");
    });
  });

  describe("report_breakdown", () => {
    it("raises a breakdown on a named asset, updates it while open, and leaves completing to a person", async () => {
      const { call } = await session();
      await call("save_asset", {
        workspace: "acme",
        asset: { kind: "equipment", code: "MX-1", name: "Mixer", area: "Packing hall" },
      });
      const raised = await call("report_breakdown", {
        workspace: "acme",
        asset: "MX-1",
        title: "Mixer seized",
        priority: "urgent",
        stops_production: true,
      });
      expect(raised.data).toMatchObject({ kind: "breakdown", priority: "urgent", status: "requested" });
      expect(raised.data.note).toMatch(/person completes/);
      const started = await call("report_breakdown", {
        workspace: "acme",
        work_order: raised.data.id,
        status: "in_progress",
        spares_used: "Drive belt",
        parts_cost: 12.5,
      });
      expect(started.data.status).toBe("in_progress");
      const open = await call("list_site_records", { workspace: "acme", kind: "work_orders" });
      expect(open.data.workOrders).toHaveLength(1);
      expect(open.data.workOrders[0]).toMatchObject({
        title: "Mixer seized",
        asset: "Mixer",
        sparesUsed: "Drive belt",
        partsCost: 12.5,
        totalCost: 12.5,
        source: "api",
      });
      expect(
        (await call("list_site_records", { workspace: "acme", kind: "work_orders", status: "completed" }))
          .data.workOrders,
      ).toEqual([]);
      expect((await call("get_site_due", { workspace: "acme" })).data.counts.openWorkOrders).toBe(1);
      expect((await call("report_breakdown", { workspace: "acme", title: "x" })).data.error.code).toBe(
        "invalid_input",
      );
      expect(
        (await call("report_breakdown", { workspace: "acme", work_order: raised.data.id, asset: "MX-1" }))
          .data.error.code,
      ).toBe("invalid_input");
    });
  });

  describe("get_pest_trends and storage measures", () => {
    it("reads trends, and stores a humidity unit with its own unit", async () => {
      const { call } = await session();
      const trends = await call("get_pest_trends", { workspace: "acme", group_by: "area" });
      expect(trends.data).toMatchObject({ groupBy: "area", series: [] });
      const saved = await call("save_site_register_entry", {
        workspace: "acme",
        kind: "storage_unit",
        entry: { name: "Dry store", kind: "ambient", measure: "humidity", limitMin: 40, limitMax: 65 },
      });
      expect(saved.isError).toBe(false);
      const units = (await call("list_site_registers", { workspace: "acme", kind: "storage_units" })).data;
      expect(units.find((u: { name: string }) => u.name === "Dry store")).toMatchObject({
        measure: "humidity",
        unit: "%RH",
        limits: "40 to 65 %RH",
      });
      const bad = await call("save_site_register_entry", {
        workspace: "acme",
        kind: "storage_unit",
        entry: { name: "Wet", kind: "ambient", measure: "humidity", limitMax: 140 },
      });
      expect(bad.data.error.code).toBe("invalid_input");
    });
  });

  describe("propose_site_action", () => {
    it("raises an action and fills in the one an excursion opened", async () => {
      const { call } = await session();
      const recorded = await call("record_storage_readings", {
        workspace: "acme",
        readings: [{ unit: "CH-1", value: 9 }],
      });
      const actionId = recorded.data.readings[0].correctiveAction.id;
      const filled = await call("propose_site_action", {
        workspace: "acme",
        corrective_action: actionId,
        root_cause: "Door left ajar",
        preventive_action: "Door closer fitted",
        action_taken: "Product probed",
      });
      expect(filled.data).toMatchObject({ id: actionId, status: "open", missing: [] });
      expect(filled.data.note).toMatch(/closes it/);
      const raised = await call("propose_site_action", {
        workspace: "acme",
        title: "Chiller 1 seal worn",
      });
      expect(raised.data).toMatchObject({
        status: "open",
        missing: ["actionTaken", "rootCause", "preventiveAction"],
      });
      expect((await call("propose_site_action", { workspace: "acme" })).data.error.code).toBe(
        "invalid_input",
      );
      const open = await call("list_site_records", {
        workspace: "acme",
        kind: "corrective_actions",
        status: "open",
      });
      expect(open.data.actions).toHaveLength(2);
    });
  });
});
