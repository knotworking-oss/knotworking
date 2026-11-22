"use client";

import type { BiWidget } from "@knotworking/core";
import { DashboardWidget, type WidgetData } from "@/components/dashboard-widgets";
import type { BiColumn, BiResult } from "@/lib/bi-format";

/** Sample results for every widget type, as `/design` shows them (light and dark). */
const month: BiColumn = {
  key: "ordered_on",
  label: "Ordered",
  kind: "dimension",
  type: "date",
  grain: "month",
};
const supplier: BiColumn = {
  key: "supplier",
  label: "Supplier",
  kind: "dimension",
  type: "reference",
  idKey: "supplier__id",
};
const severity: BiColumn = { key: "severity", label: "Severity", kind: "dimension", type: "category" };
const spend: BiColumn = { key: "order_value", label: "Order value", kind: "measure", unit: "money" };
const months = ["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"];
const suppliers = ["Millers Ltd", "Sweet Co", "Pack Right"];

const ok = (
  id: string,
  result: Omit<BiResult, "dataset" | "truncated" | "period" | "comparePeriod" | "currency"> &
    Partial<BiResult>,
): WidgetData => ({
  widgetId: id,
  status: "ok",
  result: {
    dataset: "purchase_orders",
    truncated: false,
    period: null,
    comparePeriod: null,
    currency: "GBP",
    ...result,
  },
});

const q = { dataset: "purchase_orders", measures: ["order_value"], groupBy: [], filters: [], sort: [] };
const samples: Array<{ widget: BiWidget; data?: WidgetData }> = [
  {
    widget: { id: "kpi", type: "kpi", title: "Spend, last 30 days", query: q, display: { width: 3 } },
    data: ok("kpi", {
      columns: [{ ...spend, compareKey: "order_value__compare" }],
      rows: [{ order_value: 48210.5, order_value__compare: 41980 }],
    }),
  },
  {
    widget: {
      id: "kpi_down",
      type: "kpi",
      title: "Open complaints",
      query: q,
      display: { width: 3, goodDirection: "down" },
    },
    data: ok("kpi_down", {
      columns: [
        {
          key: "open_count",
          label: "Open complaints",
          kind: "measure",
          unit: "count",
          compareKey: "open_count__compare",
        },
      ],
      rows: [{ open_count: 7, open_count__compare: 5 }],
    }),
  },
  {
    widget: { id: "noaccess", type: "kpi", title: "Batch cost variance", query: q, display: { width: 3 } },
    data: { widgetId: "noaccess", status: "no_access", message: "" },
  },
  {
    widget: { id: "error", type: "kpi", title: "Training compliance", query: q, display: { width: 3 } },
    data: {
      widgetId: "error",
      status: "error",
      code: "query_timeout",
      message: "This query took too long and was stopped.",
    },
  },
  {
    widget: { id: "line", type: "line", title: "Spend by month", query: q },
    data: ok("line", {
      columns: [month, spend],
      rows: months.map((m, i) => ({ ordered_on: m, order_value: 18000 + i * 900 + (i % 2) * 1500 })),
    }),
  },
  {
    widget: { id: "stacked", type: "stacked_bar", title: "Spend by supplier and month", query: q },
    data: ok("stacked", {
      columns: [month, supplier, spend],
      rows: months.flatMap((m, i) =>
        suppliers.map((s, j) => ({
          ordered_on: m,
          supplier: s,
          supplier__id: `s${j}`,
          order_value: 4000 + j * 2500 + i * 300,
        })),
      ),
    }),
  },
  {
    widget: { id: "bar", type: "bar", title: "Top suppliers", query: q },
    data: ok("bar", {
      columns: [supplier, spend],
      rows: suppliers.map((s, j) => ({ supplier: s, supplier__id: `s${j}`, order_value: 30000 - j * 8000 })),
    }),
  },
  {
    widget: { id: "donut", type: "donut", title: "Complaints by severity", query: q },
    data: ok("donut", {
      columns: [severity, { key: "complaint_count", label: "Complaints", kind: "measure", unit: "count" }],
      rows: [
        { severity: "minor", complaint_count: 14 },
        { severity: "major", complaint_count: 5 },
        { severity: "critical", complaint_count: 1 },
      ],
    }),
  },
  {
    widget: { id: "table", type: "table", title: "Suppliers", query: q },
    data: ok("table", {
      columns: [supplier, { ...spend, compareKey: "order_value__compare" }],
      rows: suppliers.map((s, j) => ({
        supplier: s,
        supplier__id: `s${j}`,
        order_value: 30000 - j * 8000,
        order_value__compare: 28000 - j * 7000,
      })),
    }),
  },
  {
    widget: { id: "pivot", type: "pivot", title: "Supplier by month", query: q },
    data: ok("pivot", {
      columns: [supplier, month, spend],
      rows: suppliers.flatMap((s, j) =>
        months.slice(3).map((m, i) => ({
          supplier: s,
          supplier__id: `s${j}`,
          ordered_on: m,
          order_value: 3000 + i * 400 + j * 900,
        })),
      ),
    }),
  },
  {
    widget: { id: "empty", type: "bar", title: "Waste by line", query: q },
    data: ok("empty", { columns: [supplier, spend], rows: [] }),
  },
  {
    widget: {
      id: "text",
      type: "text",
      title: "Commentary",
      text: "Spend rose in September with the new packaging supplier.\nFigures above are computed live; this note is not.",
    },
  },
];

export function DashboardWidgetsDemo() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
      {samples.map(({ widget, data }) => (
        <DashboardWidget key={widget.id} widget={widget} data={data} base="/design" workspaceCurrency="GBP" />
      ))}
      <DashboardWidget
        widget={{ id: "loading", type: "kpi", title: "Loading", query: { ...q }, display: { width: 3 } }}
        loading
        base="/design"
        workspaceCurrency="GBP"
      />
    </div>
  );
}
