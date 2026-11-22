import { describe, expect, it } from "vitest";
import {
  biAddSection,
  biAddWidget,
  biChangeWidgetType,
  biDefaultQuery,
  biDataWidgetCount,
  biEmptySpec,
  biFitDisplay,
  biFitSpecToCatalogue,
  biIssuesByWidget,
  biMoveSection,
  biMoveWidget,
  biNewWidget,
  biRemoveSection,
  biRemoveWidget,
  biRestrictCatalogue,
  biUniqueId,
  BI_WIDGET_GROUPINGS,
} from "./builder";
import { biDataset, biDatasets } from "./catalogue";
import {
  biDashboardSpecSchema,
  checkBiDashboard,
  type BiDataWidget,
  type BiDashboardSpec,
} from "./dashboard";
import { biTemplates } from "./templates";

const ids = (spec: BiDashboardSpec) =>
  spec.sections.map((s) => `${s.id}:${s.widgets.map((w) => w.id).join(",")}`);

describe("builder helpers", () => {
  it("gives every new widget type a valid query on every dataset", () => {
    for (const dataset of biDatasets) {
      let spec = biEmptySpec();
      // Types needing two groupings only fit datasets with two fields to group by.
      const types = (Object.keys(BI_WIDGET_GROUPINGS) as Array<keyof typeof BI_WIDGET_GROUPINGS>).filter(
        (t) => dataset.dimensions.length >= BI_WIDGET_GROUPINGS[t][0],
      );
      for (const type of types) spec = biAddWidget(spec, "main", biNewWidget(spec, type, dataset));
      spec = biAddWidget(spec, "main", biNewWidget(spec, "text", undefined));
      expect(biDashboardSpecSchema.safeParse(spec).success).toBe(true);
      expect(checkBiDashboard(spec, biDatasets), dataset.id).toEqual([]);
      expect(new Set(spec.sections[0]!.widgets.map((w) => w.id)).size).toBe(types.length + 1);
    }
  });

  it("refits a query when the widget type changes, keeping filters and dropping stale display options", () => {
    const dataset = biDataset("quality_complaints")!;
    const spec = biEmptySpec();
    const line = biNewWidget(spec, "stacked_bar", dataset) as BiDataWidget;
    const withExtras: BiDataWidget = {
      ...line,
      query: {
        ...line.query,
        measures: ["complaint_count", "open_count"],
        filters: [{ dim: "severity", op: "eq", value: "major" }],
        sort: [{ by: "open_count", dir: "desc" }],
      },
      display: { x: "received_on", series: "source", width: 8 },
    };
    const kpi = biChangeWidgetType(withExtras, "kpi", dataset);
    expect(kpi.query.groupBy).toEqual([]);
    expect(kpi.query.filters).toHaveLength(1);
    expect(kpi.display).toEqual({ width: 8 });
    const donut = biChangeWidgetType(withExtras, "donut", dataset);
    expect(donut.query.measures).toEqual(["complaint_count"]);
    expect(donut.query.groupBy).toHaveLength(1);
    expect(donut.query.sort).toEqual([]);
    const pivot = biChangeWidgetType(kpi, "pivot", dataset);
    expect(pivot.query.groupBy).toHaveLength(2);
    const checked = biAddWidget(spec, "main", {
      ...pivot,
      query: { ...pivot.query, measures: ["complaint_count"] },
    });
    expect(checkBiDashboard(checked, biDatasets)).toEqual([]);
  });

  it("drops display options that no longer name a grouped field", () => {
    const dataset = biDataset("production_batches")!;
    const stacked = biNewWidget(biEmptySpec(), "stacked_bar", dataset) as BiDataWidget;
    const shown: BiDataWidget = {
      ...stacked,
      display: { x: stacked.query.groupBy[0]!.dim, series: stacked.query.groupBy[1]!.dim, width: 8 },
    };
    expect(biFitDisplay(shown)).toBe(shown);
    const oneGroup = { ...shown, query: { ...shown.query, groupBy: shown.query.groupBy.slice(0, 1) } };
    expect(biFitDisplay(oneGroup).display).toEqual({ x: shown.display!.x, width: 8 });
    const none = { ...shown, display: { series: "gone" } } as BiDataWidget;
    expect(biFitDisplay(none).display).toBeUndefined();
  });

  it("starts a line chart on the default date by month", () => {
    expect(biDefaultQuery("line", biDataset("purchase_orders")!).groupBy).toEqual([
      { dim: "ordered_on", grain: "month" },
    ]);
  });

  it("makes unique ids across sections, widgets and parameters", () => {
    let spec = biEmptySpec();
    expect(biUniqueId(spec, "Main")).toBe("main-2");
    expect(biUniqueId(spec, "Top suppliers!")).toBe("top-suppliers");
    spec = { ...spec, params: { filters: [{ id: "site", label: "Site", dim: "location" }] } };
    expect(biUniqueId(spec, "site")).toBe("site-2");
    expect(biUniqueId(spec, "!!!")).toBe("widget");
  });

  it("moves widgets within and across sections, and removes sections without losing widgets", () => {
    let spec = biEmptySpec();
    for (const id of ["a", "b", "c"]) spec = biAddWidget(spec, "main", { id, type: "text", text: id });
    spec = biAddSection(spec, "Second");
    expect(ids(spec)).toEqual(["main:a,b,c", "second:"]);
    expect(ids(biMoveWidget(spec, "c", "main", 0))).toEqual(["main:c,a,b", "second:"]);
    expect(ids(biMoveWidget(spec, "a", "main", 2))).toEqual(["main:b,c,a", "second:"]);
    spec = biMoveWidget(spec, "b", "second", 0);
    expect(ids(spec)).toEqual(["main:a,c", "second:b"]);
    expect(ids(biMoveSection(spec, "second", -1))).toEqual(["second:b", "main:a,c"]);
    expect(ids(biRemoveSection(spec, "second"))).toEqual(["main:a,c,b"]);
    expect(ids(biRemoveSection(spec, "main"))).toEqual(["second:a,c,b"]);
    expect(ids(biRemoveWidget(spec, "a"))).toEqual(["main:c", "second:b"]);
    expect(biMoveWidget(spec, "zzz", "main", 0)).toBe(spec);
  });

  it("cuts the catalogue to what the viewer's catalogue answer lists", () => {
    const restricted = biRestrictCatalogue(biDatasets, [
      {
        id: "training_records",
        dimensions: [{ id: "completed_on" }, { id: "course" }],
        measures: [{ id: "record_count" }],
      },
    ]);
    expect(restricted.map((d) => d.id)).toEqual(["training_records"]);
    expect(restricted[0]!.dimensions.map((d) => d.id)).toEqual(["completed_on", "course"]);
  });

  it("groups issues by widget", () => {
    let spec = biEmptySpec();
    spec = biAddWidget(spec, "main", { id: "x", type: "text", text: "" });
    const grouped = biIssuesByWidget(spec, [
      { path: "spec.sections[0].widgets[0].query.measures[0]", message: "bad" },
      { path: "params.filters[0].dim", message: "unknown" },
    ]);
    expect(grouped.get("x")).toEqual([{ path: "query.measures[0]", message: "bad" }]);
    expect(grouped.get("")).toEqual([{ path: "params.filters[0].dim", message: "unknown" }]);
  });
});

describe("shipped templates", () => {
  it("leaves out widgets a person can't build when fitted to their catalogue", () => {
    const purchasing = biTemplates("GBP").find((t) => t.module === "purchasing")!;
    // Purchasing without the items module: no supplier names, so the top-suppliers bar goes.
    const catalogue = biRestrictCatalogue(biDatasets, [
      {
        id: "purchase_orders",
        dimensions: [{ id: "ordered_on" }, { id: "status" }],
        measures: [{ id: "order_value" }, { id: "order_count" }],
      },
    ]);
    const fitted = biFitSpecToCatalogue(purchasing.spec, catalogue);
    expect(fitted.sections[0]!.widgets.map((w) => w.id)).toEqual(["order-value", "orders", "spend-trend"]);
    expect(checkBiDashboard(fitted, catalogue)).toEqual([]);
    expect(biDataWidgetCount(biFitSpecToCatalogue(purchasing.spec, []))).toBe(0);
    // A section of commentary only stays; one emptied by the cut goes.
    const withNotes: BiDashboardSpec = {
      ...purchasing.spec,
      sections: [
        ...purchasing.spec.sections,
        { id: "notes", title: "Notes", widgets: [{ id: "n", type: "text", text: "Hi" }] },
      ],
    };
    expect(biFitSpecToCatalogue(withNotes, []).sections.map((s) => s.id)).toEqual(["notes"]);
  });

  it.each(biTemplates("GBP").map((t) => [t.id, t] as const))("%s is valid against the catalogue", (_, t) => {
    expect(biDashboardSpecSchema.safeParse(t.spec).success).toBe(true);
    expect(checkBiDashboard(biDashboardSpecSchema.parse(t.spec), biDatasets)).toEqual([]);
    // A module template uses only that module's own datasets.
    for (const section of t.spec.sections)
      for (const w of section.widgets)
        if (w.type !== "text") expect(biDataset(w.query.dataset)!.module).toBe(t.module);
  });

  it("has one template per module and pins sales money to the workspace currency", () => {
    const templates = biTemplates("EUR");
    expect(new Set(templates.map((t) => t.module)).size).toBe(templates.length);
    const sales = templates.find((t) => t.module === "sales")!;
    expect(JSON.stringify(sales.spec)).toContain('"value":"EUR"');
  });
});
