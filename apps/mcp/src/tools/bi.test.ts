import { afterEach, describe, expect, it } from "vitest";
import { connect } from "../testing/harness";
import { applyWidgetPatch } from "./bi";

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

describe("dashboard tools", () => {
  it("turns 'purchasing spend by supplier for the last 12 months, top 10, with a monthly trend' into a valid draft", async () => {
    const { call, fake } = await session();
    // The agent reads the catalogue, then the dataset, as the server instructions say.
    const list = await call("list_datasets", { workspace: "acme" });
    expect(list.data.datasets.find((d: { id: string }) => d.id === "purchase_orders").measures).toContain(
      "order_value",
    );
    const described = await call("describe_dataset", { workspace: "acme", dataset: "purchase_orders" });
    expect(described.data.dimensions.map((d: { id: string }) => d.id)).toEqual(
      expect.arrayContaining(["supplier", "ordered_on"]),
    );

    // It checks the number first.
    const top = {
      dataset: "purchase_orders",
      measures: ["order_value"],
      groupBy: [{ dim: "supplier" }],
      sort: [{ by: "order_value", dir: "desc" }],
      limit: 10,
    };
    const preview = await call("preview_query", {
      workspace: "acme",
      query: { ...top, period: { preset: "last_12_months" } },
    });
    expect(preview.isError).toBe(false);
    expect(preview.data.columns.map((c: { key: string }) => c.key)).toEqual(["supplier", "order_value"]);

    const created = await call("create_dashboard", {
      workspace: "acme",
      title: "Purchasing spend",
      spec: {
        params: { period: { preset: "last_12_months" } },
        sections: [
          {
            id: "spend",
            title: "Spend",
            widgets: [
              { id: "top", type: "bar", title: "Top 10 suppliers", query: top },
              {
                id: "trend",
                type: "line",
                title: "Spend by month",
                query: {
                  dataset: "purchase_orders",
                  measures: ["order_value"],
                  groupBy: [{ dim: "ordered_on", grain: "month" }],
                },
              },
            ],
          },
        ],
      },
    });
    expect(created.isError).toBe(false);
    expect(created.data).toMatchObject({ title: "Purchasing spend", status: "draft", version: 1 });
    expect(fake.biModule.dashboards).toHaveLength(1);

    const data = await call("get_dashboard_data", { workspace: "acme", dashboard: "Purchasing spend" });
    expect(
      data.data.widgets.map((w: { widgetId: string; status: string }) => [w.widgetId, w.status]),
    ).toEqual([
      ["top", "ok"],
      ["trend", "ok"],
    ]);
    // The dashboard period reached both widgets.
    expect(fake.biModule.queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dataset: "purchase_orders", period: { preset: "last_12_months" } }),
      ]),
    );
  });

  it("refuses what the catalogue doesn't have, with every problem and the nearest valid field", async () => {
    const { call } = await session();
    const typo = await call("preview_query", {
      workspace: "acme",
      query: { dataset: "purchase_orders", measures: ["order_value"], groupBy: [{ dim: "suplier" }] },
    });
    expect(typo.isError).toBe(true);
    expect(typo.data.error.message).toContain("groupBy[0].dim");
    expect(typo.data.error.message).toContain("(try 'supplier')");

    const invented = await call("create_dashboard", {
      workspace: "acme",
      title: "Profit",
      spec: {
        sections: [
          {
            id: "s",
            widgets: [
              {
                id: "margin",
                type: "kpi",
                title: "Gross margin",
                query: { dataset: "sales_orders", measures: ["gross_margin"] },
              },
              {
                id: "mix",
                type: "kpi",
                title: "Mixed",
                query: { dataset: "sales_orders", measures: ["sales_value"] },
              },
            ],
          },
        ],
      },
    });
    expect(invented.isError).toBe(true);
    // The unknown measure, the mixed-currency sum, and the KPI's need for one currency.
    expect(invented.data.error.message).toMatch(/^3 problems/);
    expect(invented.data.error.message).toContain("filter 'currency' to one currency");
    expect(invented.data.error.message).toContain(
      "spec.sections[0].widgets[0].query.measures[0]: unknown measure 'gross_margin'",
    );
    expect(invented.data.error.message).toContain("different currencies");
  });

  it("patches widgets by id and refuses a stale save", async () => {
    const { call } = await session();
    const created = await call("create_dashboard", {
      workspace: "acme",
      title: "Quality",
      spec: {
        sections: [
          {
            id: "q",
            widgets: [
              {
                id: "open",
                type: "kpi",
                title: "Open complaints",
                query: { dataset: "quality_complaints", measures: ["open_count"] },
              },
            ],
          },
        ],
      },
    });
    const updated = await call("update_dashboard", {
      workspace: "acme",
      dashboard: created.data.id,
      version: 1,
      upsert_widgets: [
        {
          section: "trend",
          section_title: "Trend",
          widget: {
            id: "by_month",
            type: "line",
            title: "Complaints by month",
            query: {
              dataset: "quality_complaints",
              measures: ["complaint_count"],
              groupBy: [{ dim: "received_on", grain: "month" }],
            },
          },
        },
        {
          section: "q",
          widget: {
            id: "open",
            type: "kpi",
            title: "Open now",
            query: { dataset: "quality_complaints", measures: ["open_count"] },
            display: { goodDirection: "down" },
          },
        },
      ],
    });
    expect(updated.data).toMatchObject({ version: 2 });
    const got = await call("get_dashboard", { workspace: "acme", dashboard: "Quality" });
    expect(got.data.spec.sections.map((s: { id: string }) => s.id)).toEqual(["q", "trend"]);
    expect(got.data.spec.sections[0].widgets[0].title).toBe("Open now");

    const stale = await call("update_dashboard", {
      workspace: "acme",
      dashboard: "Quality",
      version: 1,
      title: "Again",
    });
    expect(stale.isError).toBe(true);
    expect(stale.data.error.code).toBe("dashboard_conflict");
    const removed = await call("update_dashboard", {
      workspace: "acme",
      dashboard: "Quality",
      remove_widgets: ["by_month"],
    });
    expect(removed.data.version).toBe(3);
  });

  it("shows no data the user can't read, and no tools without the module; nothing publishes", async () => {
    const { call, fake, client } = await session();
    fake.biModule.hidden.add("purchase_orders");
    const refused = await call("preview_query", {
      workspace: "acme",
      query: { dataset: "purchase_orders", measures: ["order_value"] },
    });
    expect(refused.isError).toBe(true);
    expect(refused.data.error.code).toBe("module_forbidden");
    const list = await call("list_datasets", { workspace: "acme" });
    expect(list.data.datasets.map((d: { id: string }) => d.id)).not.toContain("purchase_orders");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["list_datasets", "preview_query", "create_dashboard", "update_dashboard"]),
    );
    expect(names.some((n) => n.includes("publish"))).toBe(false);

    const without = await session({ modules: ["tasks", "docs"] });
    const other = (await without.client.listTools()).tools.map((t) => t.name);
    expect(other).not.toContain("list_datasets");
    expect(other).not.toContain("create_dashboard");
  });

  it("passes the period and filter values to the data route, and reports widgets the user can't read", async () => {
    const { call, fake } = await session();
    await call("create_dashboard", {
      workspace: "acme",
      title: "Mixed",
      spec: {
        params: { filters: [{ id: "item", label: "Item", dim: "item" }] },
        sections: [
          {
            id: "s",
            widgets: [
              {
                id: "lots",
                type: "kpi",
                title: "Lots",
                query: { dataset: "stock_lots", measures: ["lot_count"] },
              },
              {
                id: "spend",
                type: "kpi",
                title: "Spend",
                query: { dataset: "purchase_orders", measures: ["order_value"] },
              },
            ],
          },
        ],
      },
    });
    fake.biModule.hidden.add("purchase_orders");
    const item = "00000000-0000-4000-8000-000000000001";
    const data = await call("get_dashboard_data", {
      workspace: "acme",
      dashboard: "Mixed",
      period: { preset: "this_month" },
      filters: { item },
    });
    expect(
      data.data.widgets.map((w: { widgetId: string; status: string }) => [w.widgetId, w.status]),
    ).toEqual([
      ["lots", "ok"],
      ["spend", "no_access"],
    ]);
    expect(fake.biModule.views.at(-1)).toEqual({ period: { preset: "this_month" }, filters: { item } });
  });

  it("can't change a published dashboard (a person publishes and unpublishes)", async () => {
    const { call, fake } = await session();
    const created = await call("create_dashboard", {
      workspace: "acme",
      title: "Board",
      spec: {
        sections: [
          {
            id: "s",
            widgets: [
              { id: "t", type: "kpi", title: "Tasks", query: { dataset: "tasks", measures: ["task_count"] } },
            ],
          },
        ],
      },
    });
    fake.biModule.publish(created.data.id);
    const refused = await call("update_dashboard", {
      workspace: "acme",
      dashboard: "Board",
      title: "Changed",
    });
    expect(refused.isError).toBe(true);
    expect(refused.data.error.code).toBe("token_not_allowed");
  });
});

describe("applyWidgetPatch", () => {
  const kpi = (id: string) => ({
    id,
    type: "kpi",
    title: id,
    query: { dataset: "tasks", measures: ["task_count"] },
  });
  const spec = () => ({
    sections: [
      { id: "a", title: "A", widgets: [kpi("one"), kpi("two")] },
      { id: "empty", title: "Placeholder", widgets: [] },
      { id: "b", title: "B", widgets: [kpi("three")] },
    ],
  });

  it("moves a widget to the named section, replaces in place, and keeps sections that were already empty", () => {
    const moved = applyWidgetPatch(spec(), {
      remove: [],
      upsert: [{ section: "b", widget: { ...kpi("one"), title: "moved" } }],
    });
    expect(moved.sections.map((s) => [s.id, s.widgets.map((w) => w.id)])).toEqual([
      ["a", ["two"]],
      ["empty", []],
      ["b", ["three", "one"]],
    ]);
    const replaced = applyWidgetPatch(spec(), {
      remove: [],
      upsert: [{ section: "a", widget: { ...kpi("two"), title: "new" } }],
    });
    expect(replaced.sections[0]!.widgets.map((w) => [w.id, w.title])).toEqual([
      ["one", "one"],
      ["two", "new"],
    ]);
  });

  it("drops only sections the patch emptied, and refuses unknown ids or removing everything", () => {
    const out = applyWidgetPatch(spec(), { remove: ["three"], upsert: [] });
    expect(out.sections.map((s) => s.id)).toEqual(["a", "empty"]);
    expect(() => applyWidgetPatch(spec(), { remove: ["nope"], upsert: [] })).toThrow(/No widget 'nope'/);
    expect(() => applyWidgetPatch(spec(), { remove: ["one", "two", "three"], upsert: [] })).toThrow(
      /at least one widget/,
    );
  });
});

describe("verified analyses", () => {
  const ORDER = "0190a000-0000-7000-8000-0000000000aa";
  const order = {
    id: ORDER,
    reference: "PO-2026-014",
    supplier: { name: "Millers Ltd" },
    lines: [
      { item: { code: "FLR-01" }, quantity: 500, unitPrice: 0.62 },
      { item: { code: "SUG-02" }, quantity: 200, unitPrice: 1.1 },
    ],
  };
  const requirements = { items: [{ item: { code: "FLR-01" }, required: 1200, onHand: 400, incoming: 900 }] };

  it("answers 'what if we dropped the Millers order over the next 6 months' with a verified two-scenario analysis", async () => {
    const { call, fake } = await session();
    fake.biModule.sources[`/purchasing/orders/${ORDER}`] = order;
    fake.biModule.sources["/production/requirements"] = requirements;
    // The agent reads its sources exactly as it will cite them.
    const read = await call("read_analysis_source", {
      workspace: "acme",
      path: `/purchasing/orders/${ORDER}`,
    });
    expect(read.data.answer.lines).toHaveLength(2);
    const created = await call("create_analysis", {
      workspace: "acme",
      title: "Dropping PO-2026-014 (Millers Ltd)",
      question: "What would the comparison be if we dropped PO-2026-014 from Millers over the next 6 months?",
      summary: "Without the order, flour falls short of what production needs.",
      scenarios: [
        { id: "now", label: "As things stand", assumptions: "Every open order arrives as promised." },
        { id: "drop", label: "Drop PO-2026-014", assumptions: "PO-2026-014 is cancelled and not replaced." },
      ],
      sources: [
        { id: "po", path: `/purchasing/orders/${ORDER}`, note: "The Millers order" },
        { id: "req", path: "/production/requirements", query: { from: "2026-11-18", to: "2027-05-18" } },
      ],
      figures: [
        {
          id: "spend",
          label: "Spend with Millers on this order",
          unit: "GBP",
          values: {
            now: {
              formula: "a * pa + b * pb",
              inputs: {
                a: { source: "po", path: "lines[0].quantity" },
                pa: { source: "po", path: "lines[0].unitPrice" },
                b: { source: "po", path: "lines[1].quantity" },
                pb: { source: "po", path: "lines[1].unitPrice" },
              },
              expected: 530,
            },
            drop: { formula: "0", expected: 0 },
          },
        },
        {
          id: "flour_gap",
          label: "Flour short of requirements",
          unit: "kg",
          values: {
            now: {
              formula: "max(0, need - onHand - incoming)",
              inputs: {
                need: { source: "req", path: "items[item.code=FLR-01].required" },
                onHand: { source: "req", path: "items[item.code=FLR-01].onHand" },
                incoming: { source: "req", path: "items[item.code=FLR-01].incoming" },
              },
              expected: 0,
            },
            drop: {
              formula: "max(0, need - onHand - (incoming - po))",
              inputs: {
                need: { source: "req", path: "items[item.code=FLR-01].required" },
                onHand: { source: "req", path: "items[item.code=FLR-01].onHand" },
                incoming: { source: "req", path: "items[item.code=FLR-01].incoming" },
                po: { source: "po", path: "lines[item.code=FLR-01].quantity" },
              },
              expected: 400,
            },
          },
        },
      ],
    });
    expect(created.isError).toBe(false);
    expect(created.data.page).toBe(`/acme/dashboards/snapshots/${created.data.id}`);
    expect(created.data.figures).toEqual([
      {
        figure: "Spend with Millers on this order",
        unit: "GBP",
        "As things stand": 530,
        "Drop PO-2026-014": 0,
        "change: Drop PO-2026-014": -530,
      },
      {
        figure: "Flour short of requirements",
        unit: "kg",
        "As things stand": 0,
        "Drop PO-2026-014": 400,
        "change: Drop PO-2026-014": 400,
      },
    ]);
    const got = await call("get_analysis", { workspace: "acme", analysis: created.data.id });
    expect(got.data.figures[1].values.drop.inputs.po).toEqual({
      source: "po",
      path: "lines[item.code=FLR-01].quantity",
    });
    expect((await call("list_analyses", { workspace: "acme" })).data.analyses).toHaveLength(1);
  });

  it("refuses a misread value or a wrong sum with every problem listed", async () => {
    const { call, fake } = await session();
    fake.biModule.sources[`/purchasing/orders/${ORDER}`] = order;
    const res = await call("create_analysis", {
      workspace: "acme",
      title: "Bad",
      question: "?",
      scenarios: [{ id: "now", label: "Now", assumptions: "As is." }],
      sources: [{ id: "po", path: `/purchasing/orders/${ORDER}` }],
      figures: [
        {
          id: "a",
          label: "Lines",
          values: {
            now: {
              formula: "count(q)",
              inputs: { q: { source: "po", path: "lines[*].quantity" } },
              expected: 3,
            },
          },
        },
        {
          id: "b",
          label: "Missing",
          values: { now: { formula: "q", inputs: { q: { source: "po", path: "lines[7].quantity" } } } },
        },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.data.error.message).toContain("2 problems");
    expect(res.data.error.message).toContain("figures[0].values.now.expected");
    expect(res.data.error.message).toContain("figures[1].values.now.inputs.q");
    expect(fake.biModule.analyses).toHaveLength(0);
  });
});
