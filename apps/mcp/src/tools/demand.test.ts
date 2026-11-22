import { afterEach, describe, expect, it } from "vitest";
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

describe("demand tools", () => {
  it("offers ten tools, all in the demand module", async () => {
    const { client } = await session();
    const { tools } = await client.listTools();
    expect(
      tools
        // propose_batches_from_demand and get_production_daily_demand belong to the production module.
        .filter(
          (t) =>
            /demand|pack_units/.test(t.name) &&
            !["propose_batches_from_demand", "get_production_daily_demand"].includes(t.name),
        )
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      "copy_demand_forecast",
      "get_demand_capacity",
      "get_demand_coverage",
      "get_demand_forecast",
      "get_demand_summary",
      "import_demand_csv",
      "list_demand_lines",
      "list_pack_units",
      "set_demand",
      "set_pack_units",
    ]);
    const set = tools.find((t) => t.name === "set_demand")!;
    expect(set.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });

  it("sets demand by item code and week, idempotently, and removes with null", async () => {
    const { call, fake } = await session();
    const first = await call("set_demand", {
      workspace: "acme",
      lines: [
        { item: "cake-1", week: "2026-W47", quantity: 120 },
        {
          item: "CAKE-1",
          week: "2026-11-18",
          quantity: 9,
          unit: "kg",
          customer: "Tesco",
          external_ref: "SO-1",
        },
        { item: "SOUP-1", week: "2026-W48", quantity: 500, unit: "ml" },
      ],
    });
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({ created: 3, updated: 0, unchanged: 0 });
    expect(first.data.lines[1]).toMatchObject({
      action: "create",
      item: "CAKE-1",
      week: "2026-W47",
      customer: "Tesco",
      quantity: { base: 20, displayUnit: "each" }, // 9 kg at 450 g each
    });
    expect(fake.demandModule.lines[1]).toMatchObject({ externalRef: "SO-1", source: "api" });

    const again = await call("set_demand", {
      workspace: "acme",
      lines: [
        { item: "CAKE-1", week: "2026-W47", quantity: 120 },
        { item: "CAKE-1", week: "2026-W47", quantity: 25, customer: "tesco" },
        { item: "SOUP-1", week: "2026-W48", quantity: null },
      ],
    });
    expect(again.data).toMatchObject({ created: 0, updated: 1, removed: 1, unchanged: 1 });
    expect(again.data.lines[2]).toEqual({ action: "remove" });
  });

  it("reports every bad line and saves nothing", async () => {
    const { call, fake } = await session();
    const res = await call("set_demand", {
      workspace: "acme",
      lines: [
        { item: "CAKE-1", week: "2026-W47", quantity: 1 },
        { item: "FLR-001", week: "2026-W47", quantity: 1 },
        { item: "NOPE", week: "2026-W47", quantity: 1 },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe("invalid_rows");
    expect(res.data.error.message).toMatch(/Row 2 \(item\): FLR-001 is not a finished good/);
    expect(res.data.error.message).toMatch(/Row 3 \(item\): No item has the code "NOPE"/);
    expect(fake.demandModule.lines).toHaveLength(0);
  });

  it("summarises per item per week and lists lines", async () => {
    const { call } = await session();
    await call("set_demand", {
      workspace: "acme",
      lines: [
        { item: "CAKE-1", week: "2026-W47", quantity: 10 },
        { item: "CAKE-1", week: "2026-W47", quantity: 5, customer: "Asda" },
        { item: "CAKE-1", week: "2026-W49", quantity: 7 },
        { item: "SOUP-1", week: "2026-W47", quantity: 2 },
      ],
    });
    const summary = await call("get_demand_summary", { workspace: "acme", from: "2026-W47", to: "2026-W49" });
    expect(summary.data.weeks).toEqual(["2026-W47", "2026-W48", "2026-W49"]);
    expect(
      summary.data.rows.map((r: any) => [
        r.item.code,
        r.total.base,
        r.weeks.map((w: any) => [w.week, w.quantity.base]),
      ]),
    ).toEqual([
      [
        "CAKE-1",
        22,
        [
          ["2026-W47", 15],
          ["2026-W49", 7],
        ],
      ],
      ["SOUP-1", 2000, [["2026-W47", 2000]]],
    ]);
    expect(summary.data.rows[0].customer).toBeUndefined();

    const split = await call("get_demand_summary", {
      workspace: "acme",
      from: "2026-W47",
      to: "2026-W47",
      item: "CAKE-1",
      by_customer: true,
    });
    expect(split.data.rows.map((r: any) => [r.customer, r.total.base])).toEqual([
      [null, 10],
      ["Asda", 5],
    ]);

    const listed = await call("list_demand_lines", { workspace: "acme", customer: "asda" });
    expect(listed.data).toMatchObject({ total: 1, hasMore: false });
    expect(listed.data.lines[0]).toMatchObject({ item: { code: "CAKE-1" }, week: "2026-W47", source: "api" });
  });

  it("checks a CSV with a dry run, then imports it", async () => {
    const { call, fake } = await session();
    const csv = "item,week,qty,customer\nCAKE-1,16/11/2026,40,Tesco\nSOUP-1,2026-W47,3,\nBOX-12,2026-W47,1,";
    const bad = await call("import_demand_csv", { workspace: "acme", csv, dry_run: true });
    expect(bad.isError).toBe(false);
    expect(bad.data.errors).toEqual([
      { row: 4, column: "item", message: expect.stringMatching(/BOX-12 is not a finished good/) },
    ]);
    const refused = await call("import_demand_csv", { workspace: "acme", csv });
    expect(refused.isError).toBe(true);
    expect(refused.data.error.code).toBe("invalid_rows");
    expect(fake.demandModule.lines).toHaveLength(0);

    const good = csv.split("\n").slice(0, 3).join("\n");
    const preview = await call("import_demand_csv", { workspace: "acme", csv: good, dry_run: true });
    expect(preview.data).toMatchObject({ dryRun: true, rows: 2, created: 2, errors: [] });
    expect(preview.data.changes[0]).toMatchObject({
      row: 2,
      action: "create",
      item: "CAKE-1",
      week: "2026-W47",
    });
    const done = await call("import_demand_csv", { workspace: "acme", csv: good, file_name: "w47.csv" });
    expect(done.data).toMatchObject({ dryRun: false, created: 2 });
    expect(done.data.importId).toBeTruthy();
    expect(fake.demandModule.lines.map((l) => l.source)).toEqual(["import", "import"]);
  });

  it("replaces a horizon only with replace_horizon, previewing the removals", async () => {
    const { call, fake } = await session();
    await call("import_demand_csv", {
      workspace: "acme",
      csv: "item,week,qty\nCAKE-1,2026-W47,1\nSOUP-1,2026-W47,2\nSOUP-1,2026-W48,3\nSOUP-1,2026-W52,4",
    });
    const file = "item,week,qty\nCAKE-1,2026-W47,5\nCAKE-1,2026-W48,6";
    const plain = await call("import_demand_csv", { workspace: "acme", csv: file, dry_run: true });
    expect(plain.data.removed).toBeUndefined();
    const preview = await call("import_demand_csv", {
      workspace: "acme",
      csv: file,
      dry_run: true,
      replace_horizon: true,
    });
    expect(preview.data).toMatchObject({ removed: 2, horizon: "2026-W47 to 2026-W48" });
    expect(preview.data.changes.filter((c: any) => c.action === "remove").map((c: any) => c.week)).toEqual([
      "2026-W47",
      "2026-W48",
    ]);
    expect(fake.demandModule.lines.filter((l) => !l.deletedAt)).toHaveLength(4);
    await call("import_demand_csv", { workspace: "acme", csv: file, replace_horizon: true });
    expect(fake.demandModule.lines.filter((l) => !l.deletedAt)).toHaveLength(3); // cake W47, W48 and soup W52, outside the horizon
  });

  it("sets a pack unit and enters demand in it", async () => {
    const { call } = await session();
    const packs = await call("set_pack_units", {
      workspace: "acme",
      pack_units: [{ item: "cake-1", name: "case", size: 12 }],
    });
    expect(packs.data.results[0]).toMatchObject({ action: "create", item: "CAKE-1", name: "case" });
    const listed = await call("list_pack_units", { workspace: "acme", item: "CAKE-1" });
    expect(listed.data.packUnits).toHaveLength(1);
    const set = await call("set_demand", {
      workspace: "acme",
      lines: [{ item: "cake-1", week: "2026-W48", quantity: 5, unit: "case" }],
    });
    expect(set.data.lines[0].quantity.base).toBe(60);
  });
});
