import { describe, expect, it } from "vitest";
import { biDatasets } from "./catalogue";
import {
  biCanEditDashboard,
  biCanReadDashboardHistory,
  biCanViewDashboard,
  biDashboardSpecSchema,
  biWidgetQuery,
  checkBiDashboard,
  type BiDashboardAccessFields,
  type BiDashboardSpecInput,
  type BiDataWidget,
} from "./dashboard";

const parse = (input: BiDashboardSpecInput) => biDashboardSpecSchema.parse(input);
const base = (
  widgets: BiDashboardSpecInput["sections"][number]["widgets"],
  params?: BiDashboardSpecInput["params"],
) => parse({ params, sections: [{ id: "s", widgets }] });

describe("dashboard specs", () => {
  it("applies the dashboard period unless a widget pins its own, and filters only widgets that have the dimension", () => {
    const spec = base(
      [
        {
          id: "a",
          type: "kpi",
          title: "A",
          query: {
            dataset: "tasks",
            measures: ["task_count"],
            period: { dim: "due_on", preset: "this_month" },
          },
        },
        {
          id: "b",
          type: "kpi",
          title: "B",
          pinPeriod: true,
          query: { dataset: "tasks", measures: ["task_count"], period: { preset: "this_year" } },
        },
        { id: "c", type: "kpi", title: "C", query: { dataset: "time_entries", measures: ["minutes"] } },
      ],
      { period: { preset: "last_30_days" }, filters: [{ id: "team", label: "Team", dim: "team" }] },
    );
    const [a, b, c] = spec.sections[0]!.widgets as BiDataWidget[];
    const view = { filters: { team: "0190a0a0-0000-7000-8000-000000000000" } };
    expect(biWidgetQuery(a!, spec, view).period).toEqual({ dim: "due_on", preset: "last_30_days" });
    expect(biWidgetQuery(a!, spec, view).filters).toEqual([
      { dim: "team", op: "eq", value: view.filters.team },
    ]);
    expect(biWidgetQuery(b!, spec, view).period).toEqual({ preset: "this_year" });
    // time_entries has no team dimension, so the filter doesn't apply.
    expect(biWidgetQuery(c!, spec, view).filters).toEqual([]);
    expect(
      biWidgetQuery(a!, spec, { period: { from: "2026-01-01", to: "2026-02-01" }, filters: {} }).period,
    ).toMatchObject({
      from: "2026-01-01",
      to: "2026-02-01",
      dim: "due_on",
    });
  });

  it("checks widget shapes against their chart type", () => {
    const issues = checkBiDashboard(
      base([
        {
          id: "k",
          type: "kpi",
          title: "K",
          query: { dataset: "tasks", measures: ["task_count"], groupBy: [{ dim: "team" }] },
        },
        { id: "l", type: "line", title: "L", query: { dataset: "tasks", measures: ["task_count"] } },
        {
          id: "d",
          type: "donut",
          title: "D",
          query: {
            dataset: "tasks",
            measures: ["task_count", "estimate_minutes"],
            groupBy: [{ dim: "team" }],
          },
        },
        {
          id: "x",
          type: "bar",
          title: "X",
          display: { x: "project" },
          query: { dataset: "tasks", measures: ["task_count"], groupBy: [{ dim: "team" }] },
        },
        { id: "t", type: "text", text: "Commentary" },
      ]),
      biDatasets,
    ).map((i) => i.path);
    expect(issues).toEqual([
      "sections[0].widgets[0].query.groupBy",
      "sections[0].widgets[1].query.groupBy",
      "sections[0].widgets[2].query.measures",
      "sections[0].widgets[3].display.x",
    ]);
  });

  it("refuses a widget that only breaks once the dashboard period applies", () => {
    const spec = base(
      [
        {
          id: "c",
          type: "kpi",
          title: "C",
          query: {
            dataset: "tasks",
            measures: ["task_count"],
            period: { from: "2026-01-01", to: "2026-02-01" },
            compare: "previous_period",
          },
        },
      ],
      { period: { from: "2026-01-01" }, filters: [] },
    );
    // The dashboard period has no end, so the comparison is dropped rather than made invalid.
    expect(checkBiDashboard(spec, biDatasets)).toEqual([]);
    expect(biWidgetQuery(spec.sections[0]!.widgets[0] as BiDataWidget, spec).compare).toBeUndefined();
  });

  it("caps groupings per widget type, so a chart never silently adds rows together", () => {
    const q = (groupBy: string[], measures = ["task_count"]) => ({
      dataset: "tasks",
      measures,
      groupBy: groupBy.map((dim) => ({ dim })),
    });
    const paths = checkBiDashboard(
      base([
        { id: "a", type: "bar", title: "", query: q(["team", "project", "state_type"]) },
        { id: "b", type: "donut", title: "", query: q(["team", "project"]) },
        { id: "c", type: "pivot", title: "", query: q(["team"]) },
        {
          id: "d",
          type: "pivot",
          title: "",
          query: q(["team", "project"], ["task_count", "estimate_minutes"]),
        },
        { id: "e", type: "line", title: "", query: q(["project", "team"]) },
        { id: "f", type: "table", title: "", query: q(["team", "project", "state_type"]) },
      ]),
      biDatasets,
    ).map((i) => i.path);
    expect(paths).toEqual([
      "sections[0].widgets[0].query.groupBy",
      "sections[0].widgets[1].query.groupBy",
      "sections[0].widgets[2].query.groupBy",
      "sections[0].widgets[3].query.measures",
    ]);
  });

  it("needs money from a multi-currency dataset filtered to one currency, except in a table", () => {
    type Widget = BiDashboardSpecInput["sections"][number]["widgets"][number];
    const sales = (type: "kpi" | "bar" | "table", filters: unknown[] = []): Widget =>
      ({
        id: type,
        type,
        title: "",
        query: {
          dataset: "sales_orders",
          measures: ["sales_value"],
          groupBy: [{ dim: "currency" }, ...(type === "bar" ? [{ dim: "customer" }] : [])].slice(
            type === "kpi" ? 1 : 0,
          ),
          filters,
        },
      }) as Widget;
    const gbp = [{ dim: "currency", op: "eq", value: "GBP" }];
    expect(checkBiDashboard(base([sales("kpi", gbp)]), biDatasets)).toEqual([]);
    expect(checkBiDashboard(base([sales("table")]), biDatasets)).toEqual([]);
    const bar = checkBiDashboard(base([sales("bar")]), biDatasets);
    expect(bar.map((i) => i.path)).toEqual(["sections[0].widgets[0].query.filters"]);
    expect(bar[0]!.message).toContain("one currency");
  });

  it("lets a widget compare periods over the dashboard's period", () => {
    const spec = base(
      [
        {
          id: "c",
          type: "kpi",
          title: "C",
          query: { dataset: "tasks", measures: ["task_count"], compare: "previous_period" },
        },
      ],
      { period: { preset: "last_30_days" }, filters: [] },
    );
    expect(checkBiDashboard(spec, biDatasets)).toEqual([]);
    const pinned = base(
      [
        {
          id: "c",
          type: "kpi",
          title: "C",
          pinPeriod: true,
          query: { dataset: "tasks", measures: ["task_count"], compare: "previous_period" },
        },
      ],
      { period: { preset: "last_30_days" }, filters: [] },
    );
    expect(checkBiDashboard(pinned, biDatasets).map((i) => i.path)).toEqual([
      "sections[0].widgets[0].query.compare",
    ]);
  });

  it("refuses datasets outside the author's catalogue, unknown filter dimensions and repeated ids", () => {
    const spec = base(
      [
        {
          id: "a",
          type: "kpi",
          title: "A",
          query: { dataset: "purchase_orders", measures: ["order_value"] },
        },
        { id: "a", type: "text", text: "" },
      ],
      { filters: [{ id: "f", label: "F", dim: "suplier" }] },
    );
    const onlyTasks = biDatasets.filter((d) => d.id === "tasks");
    const issues = checkBiDashboard(spec, onlyTasks);
    expect(issues.map((i) => i.path)).toEqual([
      "sections[0].widgets[1].id",
      "params.filters[0].dim",
      "sections[0].widgets[0].query.dataset",
    ]);
  });
});

describe("dashboard visibility", () => {
  const owner = "u-owner";
  const draft: BiDashboardAccessFields = {
    ownerId: owner,
    scope: "workspace",
    status: "draft",
    audience: "workspace",
    audienceUserIds: [],
    archivedAt: null,
  };
  const member = (userId: string, bi: "read" | "write" | "manage" = "write", extra = {}) => ({
    userId,
    role: "member" as const,
    modules: { bi, ...extra },
  });

  it("shows drafts to their owner, managers and admins only", () => {
    expect(biCanViewDashboard(draft, member(owner))).toBe(true);
    expect(biCanViewDashboard(draft, member("other"))).toBe(false);
    expect(biCanViewDashboard(draft, member("other", "manage"))).toBe(true);
    expect(biCanViewDashboard(draft, { userId: "a", role: "admin", modules: { bi: "manage" } })).toBe(true);
  });

  it("shows published dashboards to their audience, and module dashboards to readers of the module", () => {
    const published = { ...draft, status: "published" as const };
    expect(biCanViewDashboard(published, member("other", "read"))).toBe(true);
    expect(
      biCanViewDashboard({ ...published, audience: "members", audienceUserIds: ["x"] }, member("other")),
    ).toBe(false);
    expect(
      biCanViewDashboard({ ...published, audience: "members", audienceUserIds: ["x"] }, member("x")),
    ).toBe(true);
    expect(biCanViewDashboard({ ...published, scope: "module:stock" }, member("other"))).toBe(false);
    expect(
      biCanViewDashboard({ ...published, scope: "module:stock" }, member("other", "read", { stock: "read" })),
    ).toBe(true);
    expect(biCanViewDashboard({ ...published, archivedAt: new Date() }, member("other"))).toBe(false);
    expect(biCanViewDashboard(published, { userId: "g", role: "guest", modules: {} })).toBe(false);
  });

  it("keeps version history to people who may edit, and module dashboards to readers of the module", () => {
    expect(biCanReadDashboardHistory(draft, member(owner))).toBe(true);
    expect(biCanReadDashboardHistory(draft, member("other", "read"))).toBe(false);
    expect(biCanReadDashboardHistory(draft, member("other", "manage"))).toBe(true);
    expect(biCanReadDashboardHistory({ ...draft, scope: "module:quality" }, member("other", "manage"))).toBe(
      false,
    );
    expect(
      biCanReadDashboardHistory(
        { ...draft, scope: "module:quality" },
        member("other", "manage", { quality: "read" }),
      ),
    ).toBe(true);
  });

  it("never lets a token change a published dashboard", () => {
    const published = { ...draft, status: "published" as const };
    expect(biCanEditDashboard(published, member("m", "manage"))).toBe(true);
    expect(biCanEditDashboard(published, { ...member("m", "manage"), viaToken: true })).toBe(false);
    expect(biCanEditDashboard(draft, { ...member(owner), viaToken: true })).toBe(true);
  });

  it("lets writers edit only their own drafts; managers edit anything they can see", () => {
    expect(biCanEditDashboard(draft, member(owner))).toBe(true);
    expect(biCanEditDashboard(draft, member(owner, "read"))).toBe(false);
    expect(biCanEditDashboard({ ...draft, status: "published" }, member(owner))).toBe(false);
    expect(biCanEditDashboard({ ...draft, status: "published" }, member("m", "manage"))).toBe(true);
  });
});
