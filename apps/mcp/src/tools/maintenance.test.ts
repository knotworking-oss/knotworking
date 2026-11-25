import { describe, expect, it } from "vitest";
import { connect } from "../testing/harness";

describe("Maintenance tools", () => {
  it("offers calibration links when HACCP is also readable", async () => {
    const session = await connect({ modules: ["assets", "maintenance", "haccp"] });
    try {
      const { call, client } = session;
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
        "link_maintenance_calibration",
      );
      const { data: equipment } = await call("save_asset", {
        asset: { kind: "equipment", name: "Lab scale" },
      });
      const { data: linked } = await call("link_maintenance_calibration", {
        asset_id: equipment.id,
        instrument_id: null,
      });
      expect(linked).toMatchObject({ id: equipment.id, calibrationInstrumentId: null });
    } finally {
      await session.close();
    }
  });

  it("offers scheduling and work orders with Assets and Maintenance alone", async () => {
    const session = await connect({ modules: ["assets", "maintenance"] });
    try {
      const { call, client } = session;
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("report_breakdown");
      expect(names).toContain("save_maintenance_task");
      expect(names).not.toContain("get_site_due");
      expect(names).not.toContain("complete_work_order");
      expect(names).not.toContain("link_maintenance_calibration");

      const { data: van } = await call("save_asset", {
        asset: { kind: "vehicle", name: "Delivery van", code: "VAN-PM" },
      });
      expect(van).toMatchObject({ created: true, name: "Delivery van" });
      const { data: task } = await call("save_maintenance_task", {
        asset: "VAN-PM",
        task: { title: "Check tyres", frequency: { every: 1, unit: "month" } },
      });
      expect(task).toMatchObject({ assetId: van.id, title: "Check tyres" });
      expect((await call("list_maintenance_tasks", {})).data.tasks).toHaveLength(1);
      const order = await call("report_breakdown", { asset: "VAN-PM", title: "Battery flat" });
      expect(order.data).toMatchObject({ title: "Battery flat", status: "requested" });
      expect((await call("get_maintenance_work_order", { work_order_id: order.data.id })).data).toMatchObject(
        {
          assetId: van.id,
          source: "api",
        },
      );
    } finally {
      await session.close();
    }
  });
});
