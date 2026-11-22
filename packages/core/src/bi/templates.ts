import type { ModuleId } from "../modules";
import type { BiDashboardSpec, BiWidget } from "./dashboard";
import type { BiQuerySpec } from "./query";

/**
 * Starter dashboards shipped with the product, one per module that has datasets. A module's Dashboards page offers its template when it has none; anyone may also start
 * a new dashboard from one. They are plain specs, checked against the full catalogue in
 * `builder.test.ts`, and like every save they are validated again against what the person
 * creating the draft may read.
 */

export interface BiTemplate {
  id: string;
  module: ModuleId;
  title: string;
  description: string;
  spec: BiDashboardSpec;
}

type Q = Partial<BiQuerySpec> & Pick<BiQuerySpec, "dataset" | "measures">;
const q = (query: Q): BiQuerySpec => ({ groupBy: [], filters: [], sort: [], ...query });
const kpi = (id: string, title: string, query: Q, goodDirection: "up" | "down" = "up"): BiWidget => ({
  id,
  type: "kpi",
  title,
  query: q({ compare: "previous_period", ...query }),
  display: { goodDirection, width: 3 },
});
const month = (dim: string) => ({ dim, grain: "month" as const });
const spec = (
  preset: NonNullable<BiDashboardSpec["params"]["period"]>["preset"],
  sections: BiDashboardSpec["sections"],
): BiDashboardSpec => ({ params: { period: { preset }, filters: [] }, sections });

/**
 * The shipped templates. Money on a dataset with its own currencies (sales) is pinned to the
 * workspace currency, as every non-table widget must be.
 */
export function biTemplates(workspaceCurrency: string): BiTemplate[] {
  const gbp = { dim: "currency", op: "eq" as const, value: workspaceCurrency };
  return [
    {
      id: "stock-overview",
      module: "stock",
      title: "Stock overview",
      description: "Movements through the stores and the lots received, by type and status.",
      spec: spec("last_90_days", [
        {
          id: "activity",
          title: "Activity",
          widgets: [
            kpi("movements", "Stock movements", { dataset: "stock_movements", measures: ["movement_count"] }),
            kpi("lots-received", "Lots received", { dataset: "stock_lots", measures: ["lot_count"] }),
            kpi(
              "waste-movements",
              "Waste movements",
              {
                dataset: "stock_movements",
                measures: ["movement_count"],
                filters: [{ dim: "type", op: "eq", value: "waste" }],
              },
              "down",
            ),
            kpi("suppliers", "Suppliers delivering", { dataset: "stock_lots", measures: ["supplier_count"] }),
            {
              id: "movements-by-type",
              type: "stacked_bar",
              title: "Movements by type",
              query: q({
                dataset: "stock_movements",
                measures: ["movement_count"],
                groupBy: [month("occurred_on"), { dim: "type" }],
              }),
              display: { x: "occurred_on", series: "type", width: 8 },
            },
            {
              id: "lots-by-status",
              type: "donut",
              title: "Lots by status",
              query: q({ dataset: "stock_lots", measures: ["lot_count"], groupBy: [{ dim: "status" }] }),
              display: { width: 4 },
            },
          ],
        },
      ]),
    },
    {
      id: "purchasing-spend",
      module: "purchasing",
      title: "Purchasing spend",
      description: "Committed purchase order value by supplier and month, and invoices received.",
      spec: spec("last_12_months", [
        {
          id: "spend",
          title: "Spend",
          widgets: [
            kpi(
              "order-value",
              "Order value",
              { dataset: "purchase_orders", measures: ["order_value"] },
              "down",
            ),
            kpi("orders", "Orders placed", { dataset: "purchase_orders", measures: ["order_count"] }),
            kpi(
              "invoice-value",
              "Invoiced",
              { dataset: "purchase_invoices", measures: ["invoice_value"] },
              "down",
            ),
            kpi("invoices", "Invoices", { dataset: "purchase_invoices", measures: ["invoice_count"] }),
            {
              id: "spend-trend",
              type: "line",
              title: "Order value by month",
              query: q({
                dataset: "purchase_orders",
                measures: ["order_value"],
                groupBy: [month("ordered_on")],
              }),
              display: { width: 6 },
            },
            {
              id: "top-suppliers",
              type: "bar",
              title: "Top 10 suppliers",
              query: q({
                dataset: "purchase_orders",
                measures: ["order_value"],
                groupBy: [{ dim: "supplier" }],
                sort: [{ by: "order_value", dir: "desc" }],
                limit: 10,
              }),
              display: { width: 6 },
            },
          ],
        },
      ]),
    },
    {
      id: "sales-overview",
      module: "sales",
      title: "Sales overview",
      description: `Confirmed sales in ${workspaceCurrency} by month and customer, and the order book by status.`,
      spec: spec("last_12_months", [
        {
          id: "sales",
          title: "Sales",
          widgets: [
            kpi("sales-value", "Sales", {
              dataset: "sales_orders",
              measures: ["sales_value"],
              filters: [gbp],
            }),
            kpi("orders", "Orders", {
              dataset: "sales_orders",
              measures: ["order_count"],
              filters: [{ dim: "kind", op: "eq", value: "order" }],
            }),
            kpi("quotes", "Quoted", { dataset: "sales_orders", measures: ["quote_value"], filters: [gbp] }),
            {
              id: "sales-trend",
              type: "line",
              title: "Sales by month",
              query: q({
                dataset: "sales_orders",
                measures: ["sales_value"],
                groupBy: [month("created_on")],
                filters: [gbp],
              }),
              display: { width: 6 },
            },
            {
              id: "top-customers",
              type: "bar",
              title: "Top 10 customers",
              query: q({
                dataset: "sales_orders",
                measures: ["sales_value"],
                groupBy: [{ dim: "customer" }],
                filters: [gbp],
                sort: [{ by: "sales_value", dir: "desc" }],
                limit: 10,
              }),
              display: { width: 6 },
            },
            {
              id: "by-status",
              type: "table",
              title: "Orders and quotes by status",
              query: q({
                dataset: "sales_orders",
                measures: ["order_count"],
                groupBy: [{ dim: "kind" }, { dim: "status" }],
              }),
              display: { width: 12 },
            },
          ],
        },
      ]),
    },
    {
      id: "production-batches",
      module: "production",
      title: "Production batches",
      description: "Batches planned and completed, by month, status and line.",
      spec: spec("last_90_days", [
        {
          id: "batches",
          title: "Batches",
          widgets: [
            kpi("planned", "Batches planned", { dataset: "production_batches", measures: ["batch_count"] }),
            kpi("completed", "Batches completed", {
              dataset: "production_batches",
              measures: ["batch_count"],
              filters: [{ dim: "status", op: "eq", value: "completed" }],
            }),
            kpi(
              "cancelled",
              "Batches cancelled",
              {
                dataset: "production_batches",
                measures: ["batch_count"],
                filters: [{ dim: "status", op: "eq", value: "cancelled" }],
              },
              "down",
            ),
            {
              id: "by-status",
              type: "stacked_bar",
              title: "Batches by month and status",
              query: q({
                dataset: "production_batches",
                measures: ["batch_count"],
                groupBy: [month("planned_on"), { dim: "status" }],
              }),
              display: { x: "planned_on", series: "status", width: 8 },
            },
            {
              id: "by-line",
              type: "bar",
              title: "Batches by line",
              query: q({
                dataset: "production_batches",
                measures: ["batch_count"],
                groupBy: [{ dim: "line" }],
                sort: [{ by: "batch_count", dir: "desc" }],
              }),
              display: { width: 4 },
            },
          ],
        },
      ]),
    },
    {
      id: "quality-overview",
      module: "quality",
      title: "Quality overview",
      description: "Complaints and non-conformances: how many, what kind, and how many are still open.",
      spec: spec("last_12_months", [
        {
          id: "complaints",
          title: "Complaints",
          widgets: [
            kpi(
              "complaint-count",
              "Complaints",
              { dataset: "quality_complaints", measures: ["complaint_count"] },
              "down",
            ),
            kpi(
              "open-complaints",
              "Still open",
              { dataset: "quality_complaints", measures: ["open_count"] },
              "down",
            ),
            kpi(
              "ncs",
              "Non-conformances",
              { dataset: "quality_nonconformances", measures: ["nonconformance_count"] },
              "down",
            ),
            kpi(
              "open-ncs",
              "Non-conformances open",
              { dataset: "quality_nonconformances", measures: ["open_count"] },
              "down",
            ),
            {
              id: "complaints-trend",
              type: "line",
              title: "Complaints by month",
              query: q({
                dataset: "quality_complaints",
                measures: ["complaint_count"],
                groupBy: [month("received_on")],
              }),
              display: { width: 6 },
            },
            {
              id: "complaints-by-category",
              type: "bar",
              title: "Complaints by category",
              query: q({
                dataset: "quality_complaints",
                measures: ["complaint_count"],
                groupBy: [{ dim: "category" }],
                sort: [{ by: "complaint_count", dir: "desc" }],
              }),
              display: { width: 6 },
            },
            {
              id: "ncs-by-severity",
              type: "donut",
              title: "Non-conformances by severity",
              query: q({
                dataset: "quality_nonconformances",
                measures: ["nonconformance_count"],
                groupBy: [{ dim: "severity" }],
              }),
              display: { width: 6 },
            },
            {
              id: "ncs-by-source",
              type: "bar",
              title: "Non-conformances by source",
              query: q({
                dataset: "quality_nonconformances",
                measures: ["nonconformance_count"],
                groupBy: [{ dim: "source" }],
                sort: [{ by: "nonconformance_count", dir: "desc" }],
              }),
              display: { width: 6 },
            },
          ],
        },
      ]),
    },
    {
      id: "haccp-corrective-actions",
      module: "haccp",
      title: "HACCP corrective actions",
      description: "Corrective actions raised and still open.",
      spec: spec("last_12_months", [
        {
          id: "actions",
          title: "Corrective actions",
          widgets: [
            kpi(
              "raised",
              "Raised",
              { dataset: "haccp_corrective_actions", measures: ["action_count"] },
              "down",
            ),
            kpi("open", "Open", { dataset: "haccp_corrective_actions", measures: ["open_count"] }, "down"),
            {
              id: "trend",
              type: "stacked_bar",
              title: "Raised by month",
              query: q({
                dataset: "haccp_corrective_actions",
                measures: ["action_count"],
                groupBy: [month("raised_on"), { dim: "status" }],
              }),
              display: { x: "raised_on", series: "status", width: 12 },
            },
          ],
        },
      ]),
    },
    {
      id: "training-overview",
      module: "training",
      title: "Training overview",
      description: "Training completed, by course and outcome.",
      spec: spec("last_12_months", [
        {
          id: "training",
          title: "Training",
          widgets: [
            kpi("records", "Training records", { dataset: "training_records", measures: ["record_count"] }),
            kpi("people", "People trained", { dataset: "training_records", measures: ["people_trained"] }),
            {
              id: "by-course",
              type: "bar",
              title: "Records by course",
              query: q({
                dataset: "training_records",
                measures: ["record_count"],
                groupBy: [{ dim: "course" }],
                sort: [{ by: "record_count", dir: "desc" }],
                limit: 15,
              }),
              display: { width: 8 },
            },
            {
              id: "by-outcome",
              type: "donut",
              title: "Outcomes",
              query: q({
                dataset: "training_records",
                measures: ["record_count"],
                groupBy: [{ dim: "outcome" }],
              }),
              display: { width: 4 },
            },
          ],
        },
      ]),
    },
    {
      id: "tasks-throughput",
      module: "tasks",
      title: "Task throughput",
      description: "Tasks created and where they stand, by week and team.",
      spec: spec("last_90_days", [
        {
          id: "tasks",
          title: "Tasks",
          widgets: [
            kpi("created", "Tasks created", { dataset: "tasks", measures: ["task_count"] }),
            kpi("completed", "Completed", {
              dataset: "tasks",
              measures: ["task_count"],
              period: { dim: "completed_on", preset: "last_90_days" },
            }),
            {
              id: "by-week",
              type: "stacked_bar",
              title: "Created by week",
              query: q({
                dataset: "tasks",
                measures: ["task_count"],
                groupBy: [{ dim: "created_on", grain: "week" }, { dim: "state_type" }],
              }),
              display: { x: "created_on", series: "state_type", width: 8 },
            },
            {
              id: "by-team",
              type: "bar",
              title: "By team",
              query: q({
                dataset: "tasks",
                measures: ["task_count"],
                groupBy: [{ dim: "team" }],
                sort: [{ by: "task_count", dir: "desc" }],
              }),
              display: { width: 4 },
            },
          ],
        },
      ]),
    },
    {
      id: "time-logged",
      module: "time",
      title: "Time logged",
      description: "Time recorded by week and person.",
      spec: spec("last_90_days", [
        {
          id: "time",
          title: "Time",
          widgets: [
            kpi("minutes", "Time logged", { dataset: "time_entries", measures: ["minutes"] }),
            kpi("entries", "Entries", { dataset: "time_entries", measures: ["entry_count"] }),
            {
              id: "by-week",
              type: "line",
              title: "Time by week",
              query: q({
                dataset: "time_entries",
                measures: ["minutes"],
                groupBy: [{ dim: "entry_date", grain: "week" }],
              }),
              display: { width: 6 },
            },
            {
              id: "by-person",
              type: "bar",
              title: "Time by person",
              query: q({
                dataset: "time_entries",
                measures: ["minutes"],
                groupBy: [{ dim: "person" }],
                sort: [{ by: "minutes", dir: "desc" }],
              }),
              display: { width: 6 },
            },
          ],
        },
      ]),
    },
  ];
}

/** The shipped template for a module, if it has one. */
export const biModuleTemplate = (module: ModuleId, workspaceCurrency: string): BiTemplate | undefined =>
  biTemplates(workspaceCurrency).find((t) => t.module === module);
