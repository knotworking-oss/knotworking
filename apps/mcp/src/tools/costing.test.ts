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

describe("costing tools", () => {
  it("are read-only tools of the costing module", async () => {
    const { client } = await session();
    const tools = (await client.listTools()).tools.filter((t) =>
      [
        "list_batch_costs",
        "get_batch_cost",
        "costing_report",
        "costing_valuation",
        "costing_write_offs",
      ].includes(t.name),
    );
    expect(tools).toHaveLength(5);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.description, t.name).toMatch(/positive is adverse/);
    }
  });

  it("lists batch costs, resolving a product by stock code", async () => {
    const { call, fake } = await session();
    const res = await call("list_batch_costs", { workspace: "acme" });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({
      total: 1,
      batches: [
        {
          batch: "B261110-001",
          status: "completed",
          date: "2026-11-10",
          recipe: "R-DGH Dough",
          product: "DGH-1 Dough",
          produced: "9.5 kg",
          yieldPercent: 95,
          actualCost: 13.2,
          estimatedPercent: 9.1,
          costPerUnit: 1.38947368,
          standardCostPerUnit: 1.1,
          variance: 2.75,
        },
      ],
    });
    await call("list_batch_costs", {
      workspace: "acme",
      product: "flr-001",
      status: "all",
      from: "2026-11-01",
    });
    const flour = fake.itemsModule.items.find((i) => i.code === "FLR-001")!;
    expect(fake.costingModule.state.listQueries.at(-1)).toMatchObject({
      outputItemId: flour.id,
      status: "all",
      from: "2026-11-01",
    });
    const unknown = await call("list_batch_costs", { workspace: "acme", product: "NOPE" });
    expect(unknown.isError).toBe(true);
    expect(unknown.data.error.message).toMatch(/No item has the code/);
  });

  it("explains one batch's cost by batch code", async () => {
    const { call } = await session();
    const res = await call("get_batch_cost", { workspace: "acme", batch: "b261110-001" });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({
      batch: "B261110-001",
      recipeVersion: 2,
      planned: "10 kg",
      produced: "9.5 kg",
      actualCost: 13.2,
      costPerUnit: 1.38947368,
      standardCostPerUnit: 1.1,
      perUnit: "per kg",
      variance: { price: 1.7, usage: 0.5, yield: 0.55, total: 2.75 },
      lots: [
        { lot: "FL-01", item: "FLR-001 Flour", quantity: "6 kg", unitCost: 0.9, source: "Purchase price" },
        {
          lot: "SUG-OPEN",
          source: "Standard cost (estimated)",
          why: "Not received against a purchase order",
        },
      ],
      materials: [{ item: "FLR-001 Flour", required: "6 kg", priceVariance: 0.6, usageVariance: 0 }],
    });
    expect(res.data.lots[0].why).toBeUndefined();
    const missing = await call("get_batch_cost", { workspace: "acme", batch: "B000000-001" });
    expect(missing.isError).toBe(true);
    expect(missing.data.error.message).toMatch(/nothing to cost yet/);
  });

  it("reports standard against actual and passes the period through", async () => {
    const fake = createFakeApi();
    const { call } = await session({ fake });
    const res = await call("costing_report", {
      workspace: "acme",
      period: "week",
      from: "2026-W40",
      to: "2026-W46",
    });
    expect(res.isError).toBe(false);
    expect(fake.costingModule.state.reportQueries.at(-1)).toEqual({
      period: "week",
      from: "2026-W40",
      to: "2026-W46",
    });
    expect(res.data).toMatchObject({
      totals: { batches: 1, incompleteBatches: 0, variance: { total: 2.75 } },
      rows: [
        {
          product: "DGH-1 Dough",
          period: "2026-11",
          produced: "9.5 kg",
          yieldPercent: 95,
          actualCost: 13.2,
          standardCost: 10.45,
          perUnit: "kg",
        },
      ],
    });
    const bad = await call("costing_report", { workspace: "acme", from: "soon" });
    expect(bad.isError).toBe(true);
    expect(bad.data.error.message).toMatch(/not a date/);
  });

  it("values stock and costs waste", async () => {
    const fake = createFakeApi();
    const { call } = await session({ fake });
    const v = await call("costing_valuation", { workspace: "acme", status: "available", lots: true });
    expect(v.isError).toBe(false);
    expect(fake.costingModule.state.valuationQueries.at(-1)).toEqual({ status: "available" });
    expect(v.data).toMatchObject({
      totals: { value: 22.5 },
      items: [{ item: "FLR-001 Flour", quantity: "25 kg", value: 22.5 }],
      lots: [{ lot: "FLR-L1", unitCost: 0.9, per: "kg", source: "purchase" }],
    });
    const a = await call("costing_write_offs", { workspace: "acme" });
    expect(a.data).toMatchObject({
      totals: { waste: 1.8 },
      lines: [{ type: "waste", item: "FLR-001 Flour", quantity: "-2 kg", cost: 1.8 }],
    });
  });
});
