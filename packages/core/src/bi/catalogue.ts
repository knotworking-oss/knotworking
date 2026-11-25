import type { ModuleAccessLevel, ModuleId } from "../modules";
import { workflowStateTypes } from "../enums";
import { baseUnits, itemTypes, unitCodes, unitDimension } from "../items";
import { productionBatchStatuses } from "../production";
import { purchaseInvoiceLineKinds, purchaseInvoiceStatuses } from "../purchase-invoices";
import { purchaseOrderLineKinds, purchaseOrderStatuses } from "../purchasing";
import {
  complaintCategories,
  complaintSources,
  complaintStatuses,
  nonconformanceSources,
  nonconformanceStatuses,
  qualitySeverities,
} from "../quality";
import { salesKinds, salesStatuses } from "../sales";
import { expiryTypes, lotStatuses, stockMovementTypes } from "../stock";
import { trainingOutcomes } from "../training";
import { correctiveActionStatuses, haccpSources } from "../haccp";
import { BI_METRICS_DATASET, BI_METRICS_PERIOD_DIM, biMetricMeasures } from "./metrics";

/**
 * The BI catalogue: every dataset a dashboard or an agent can query, as plain data. No SQL lives
 * here; the server compiles a query spec against these declarations (`apps/server/src/services/bi`)
 * and checks every table and column against the Drizzle schema in its tests. Names are SQL names
 * (`snake_case` tables and columns); ids are what query specs use.
 *
 * Rules a dataset follows (enforced by tests): its tables have `workspace_id` (except the platform
 * `users` table, reached only as a lookup by id); soft-deleted rows are excluded where the table
 * has `deleted_at`; nothing on the never-reportable list is touched; free-text columns are not
 * dimensions.
 */

/** How a dimension behaves: grouped and filtered as a category, a date (with grains), a number, … */
export type BiDimensionType = "category" | "date" | "number" | "boolean" | "reference";

/** `certified`: computed by a certified metric's service, never compiled to SQL (bi/metrics.ts). */
export type BiAggregate = "count" | "sum" | "avg" | "min" | "max" | "count_distinct" | "certified";

/**
 * What a measure's number is. `money` is in the dataset's currency (see `BiDataset.currency`);
 * `percent` is 0 to 100; `per_million` is a rate per million units.
 */
export type BiUnit = "count" | "money" | "quantity" | "minutes" | "number" | "percent" | "per_million";

/** A column on the dataset's base table, or on one of its declared joins. */
export interface BiColumnRef {
  /** A key of `BiDataset.joins`; omitted for the base table. */
  join?: string;
  column: string;
}

/** A fixed condition (dataset scope or a measure's own filter). Values are catalogue constants. */
export interface BiCondition extends BiColumnRef {
  op: "eq" | "neq" | "in" | "not_in" | "is_null" | "not_null" | "gt" | "lt";
  value?: string | number | boolean | readonly string[];
}

export interface BiJoin {
  table: string;
  /** The column holding the key: on the base table, or on another join (`fromJoin`). */
  from: string;
  fromJoin?: string;
  /** The key on the joined table (default `id`). */
  to?: string;
  /**
   * `parent`: the row belongs to it (an order line's order). Inner join; rows whose parent is
   * soft-deleted are excluded. `lookup`: reference data for labels (an item, a supplier). Left join;
   * a soft-deleted record still labels the rows that point at it.
   */
  kind: "parent" | "lookup";
  /** The module owning the joined table; the viewer needs `read` on it to use the join. Omit for platform tables. */
  module?: ModuleId;
}

export interface BiFieldRules {
  /** The viewer needs at least this level on the module owning the field (default `read`). */
  minLevel?: Exclude<ModuleAccessLevel, "none">;
  /** Guests (outside collaborators) never see it. */
  hideFromGuests?: boolean;
}

export interface BiDimension extends BiColumnRef, BiFieldRules {
  id: string;
  label: string;
  description?: string;
  type: BiDimensionType;
  /** For `date`: the column is a `timestamptz`, bucketed and filtered in the workspace time zone. */
  instant?: boolean;
  /** For `reference`: the column(s) on the same join (or base table) shown as its label, joined by spaces. */
  labelColumn?: string | readonly string[];
  /** For `category`: the values it can take, for pickers and agents. */
  values?: readonly (string | number)[];
  /**
   * For `category`: stored value → reported value, applied in SQL for grouping and filtering (an
   * item's unit `kg` → its base unit `g`). Stored values not listed pass through unchanged.
   */
  map?: Readonly<Record<string, string>>;
}

export interface BiMeasure extends BiFieldRules {
  id: string;
  label: string;
  description: string;
  agg: BiAggregate;
  /** The column aggregated; omitted only for `count` (counts rows). */
  of?: BiColumnRef;
  /** Multiply `of` by this column first (a line's value is quantity × unit price). */
  times?: BiColumnRef;
  /**
   * `of` is in the item's base unit and `times` is per `unit`: convert `of` into
   * `unit` first, through the item's density or unit weight across dimensions (as
   * `convertQuantity` does). Lines that can't be converted count as unknown (left out of sums).
   */
  convert?: { unit: BiColumnRef; itemJoin: string };
  /** Only rows matching all of these take part. */
  where?: readonly BiCondition[];
  unit: BiUnit;
  /** A module the viewer needs `read` on to use this measure, besides the dataset's own. */
  module?: ModuleId;
  /** Set on certified metrics: their definition version and whether they cover a period. */
  certified?: { version: string; kind: "period" | "point_in_time" };
  /**
   * The number only means something within one value of one of these dimensions: sums of money
   * per currency, quantities per item (items have different units). A query must group by one of
   * them or filter it to a single value; otherwise it is refused, never silently mixed.
   */
  splitBy?: readonly string[];
}

export interface BiDataset {
  id: string;
  label: string;
  description: string;
  /** What one row of the underlying data is ("one purchase order line"). */
  grain: string;
  /** The module that owns the data; the viewer always needs `read` on it. */
  module: ModuleId;
  table: string;
  joins: Readonly<Record<string, BiJoin>>;
  /** Conditions every query on the dataset applies (lines removed from an order, voided records). */
  scope?: readonly BiCondition[];
  dimensions: readonly BiDimension[];
  measures: readonly BiMeasure[];
  /** The date dimension a dashboard period applies to by default. */
  defaultDate: string;
  /** Where money's currency comes from: a dimension, or the workspace currency when omitted. */
  currencyDimension?: string;
  /**
   * Not a table: its measures are computed by services (the certified metrics). `table`, joins and
   * columns are unused, and the SQL compiler never sees it.
   */
  virtual?: boolean;
}

/**
 * Tables no dataset may read (prefixes and names): personal and HR data, confidential concerns,
 * private calendars and chats, the API audit and accounting integration records. A dataset that
 * touches one fails `bi-catalogue.test.ts`. If the board needs an aggregate of one (headcount,
 * absence rate) it is a separate decision: an aggregate-only dataset with `manage` and a minimum
 * group size.
 */
export const BI_NEVER_REPORTABLE: readonly string[] = [
  "attendance_*",
  "workforce_*",
  "governance_concerns",
  "calendar_*",
  "assistant_*",
  "api_token*",
  "accounting_*",
  // Sign-in and secrets: sessions, OAuth and password accounts, reset tokens, invitations.
  "sessions",
  "accounts",
  "verifications",
  "invitations",
  // Personal and internal platform records.
  "notification*",
  "member_module_access",
  "sync_changes",
];

/** Whether a table is on the never-reportable list (`*` at the end of a rule matches a prefix). */
export const isNeverReportable = (table: string) =>
  BI_NEVER_REPORTABLE.some((rule) =>
    rule.endsWith("*") ? table.startsWith(rule.slice(0, -1)) : table === rule,
  );

// ─── Shared fragments ────────────────────────────────────────────────────────

const itemJoin: BiJoin = { table: "items", from: "item_id", kind: "lookup", module: "items" };
const itemDims = (join = "item"): BiDimension[] => [
  { id: "item", label: "Item", type: "reference", join, column: "id", labelColumn: "name" },
  { id: "item_type", label: "Item type", type: "category", join, column: "type", values: itemTypes },
];
/** The item's base unit, derived from its display unit. */
const baseUnitDim = (join = "item"): BiDimension => ({
  id: "base_unit",
  label: "Base unit",
  description: "The unit in which ledger quantities are stored.",
  type: "category",
  join,
  column: "unit",
  values: Object.values(baseUnits),
  map: Object.fromEntries(unitCodes.map((unit) => [unit, baseUnits[unitDimension(unit)]])),
});
/** Purchase orders that commit spend: sent or closed (drafts and cancelled orders never count). */
const committedOrders: readonly BiCondition[] = [
  { join: "order", column: "status", op: "in", value: ["sent", "closed"] },
];
const userJoin = (from: string): BiJoin => ({ table: "users", from, kind: "lookup" });
const count = (id: string, label: string, description: string): BiMeasure => ({
  id,
  label,
  description,
  agg: "count",
  unit: "count",
});

// ─── Datasets ────────────────────────────────────────────────────────────────

const stockMovements: BiDataset = {
  id: "stock_movements",
  label: "Stock movements",
  description:
    "The append-only stock ledger: goods in, transfers, adjustments, waste, stocktakes, despatches, consumption and production output. Quantities are signed (in is positive) and in each item's base unit.",
  grain: "one ledger movement",
  module: "stock",
  table: "stock_movements",
  joins: {
    item: itemJoin,
    location: { table: "stock_locations", from: "location_id", kind: "lookup", module: "stock" },
    lot: { table: "stock_lots", from: "lot_id", kind: "lookup", module: "stock" },
  },
  dimensions: [
    { id: "occurred_on", label: "Date", type: "date", column: "occurred_at", instant: true },
    { id: "type", label: "Movement type", type: "category", column: "type", values: stockMovementTypes },
    ...itemDims(),
    baseUnitDim(),
    {
      id: "location",
      label: "Location",
      type: "reference",
      join: "location",
      column: "id",
      labelColumn: "name",
    },
    { id: "lot", label: "Lot", type: "reference", join: "lot", column: "id", labelColumn: "lot_code" },
  ],
  measures: [
    count("movement_count", "Movements", "Number of ledger movements."),
    {
      id: "net_quantity",
      label: "Net quantity",
      description: "Sum of signed quantities (in minus out), in the item's base unit.",
      agg: "sum",
      of: { column: "quantity" },
      unit: "quantity",
      splitBy: ["item", "base_unit"],
    },
    {
      id: "quantity_in",
      label: "Quantity in",
      description: "Sum of positive movements, in the item's base unit.",
      agg: "sum",
      of: { column: "quantity" },
      where: [{ column: "quantity", op: "gt", value: 0 }],
      unit: "quantity",
      splitBy: ["item", "base_unit"],
    },
    {
      id: "quantity_out",
      label: "Quantity out",
      description: "Sum of negative movements as a negative number, in the item's base unit.",
      agg: "sum",
      of: { column: "quantity" },
      where: [{ column: "quantity", op: "lt", value: 0 }],
      unit: "quantity",
      splitBy: ["item", "base_unit"],
    },
  ],
  defaultDate: "occurred_on",
};

const stockLots: BiDataset = {
  id: "stock_lots",
  label: "Stock lots",
  description: "Lots received or produced, with their QA status, supplier and expiry.",
  grain: "one lot",
  module: "stock",
  table: "stock_lots",
  joins: {
    item: itemJoin,
    supplier: { table: "suppliers", from: "supplier_id", kind: "lookup", module: "items" },
  },
  dimensions: [
    { id: "received_on", label: "Received", type: "date", column: "received_on" },
    { id: "expires_on", label: "Expires", type: "date", column: "expires_on" },
    { id: "status", label: "QA status", type: "category", column: "status", values: lotStatuses },
    { id: "expiry_type", label: "Expiry type", type: "category", column: "expiry_type", values: expiryTypes },
    ...itemDims(),
    {
      id: "supplier",
      label: "Supplier",
      type: "reference",
      join: "supplier",
      column: "id",
      labelColumn: "name",
    },
  ],
  measures: [
    count("lot_count", "Lots", "Number of lots."),
    {
      id: "supplier_count",
      label: "Suppliers",
      description: "Number of different suppliers the lots came from.",
      agg: "count_distinct",
      of: { column: "supplier_id" },
      unit: "count",
    },
  ],
  defaultDate: "received_on",
};

const purchaseOrders: BiDataset = {
  id: "purchase_orders",
  label: "Purchase orders",
  description:
    "Purchase order lines with their order's supplier, status and dates. Order value is each stock line's quantity in its order unit × its unit price, in the workspace currency, for sent and closed orders; unpriced lines, lines whose unit can't be converted and non-stock lines (services, subscriptions) are left out.",
  grain: "one purchase order line",
  module: "purchasing",
  table: "purchase_order_lines",
  joins: {
    order: { table: "purchase_orders", from: "purchase_order_id", kind: "parent", module: "purchasing" },
    supplier: {
      table: "suppliers",
      from: "supplier_id",
      fromJoin: "order",
      kind: "lookup",
      module: "items",
    },
    item: itemJoin,
  },
  dimensions: [
    { id: "ordered_on", label: "Ordered", type: "date", join: "order", column: "ordered_on" },
    { id: "expected_on", label: "Expected", type: "date", column: "expected_on" },
    {
      id: "status",
      label: "Order status",
      description:
        "Drafts and cancelled orders are counted only by 'Orders (any status)'; every other measure counts sent and closed orders.",
      type: "category",
      join: "order",
      column: "status",
      values: purchaseOrderStatuses,
    },
    {
      id: "supplier",
      label: "Supplier",
      type: "reference",
      join: "supplier",
      column: "id",
      labelColumn: "name",
    },
    ...itemDims(),
    { id: "order_unit", label: "Order unit", type: "category", column: "unit" },
    baseUnitDim(),
    {
      id: "line_kind",
      label: "Line kind",
      description: "Stock items, or non-stock lines (services, subscriptions, goods not kept in stock).",
      type: "category",
      column: "kind",
      values: purchaseOrderLineKinds,
    },
  ],
  measures: [
    {
      id: "order_value",
      label: "Order value",
      description:
        "Committed spend: sum of quantity × unit price over the lines of sent and closed orders (drafts and cancelled orders left out), in the workspace currency.",
      agg: "sum",
      of: { column: "quantity" },
      convert: { unit: { column: "unit" }, itemJoin: "item" },
      times: { column: "unit_price" },
      where: committedOrders,
      unit: "money",
    },
    {
      id: "order_count",
      label: "Orders",
      description:
        "Number of different purchase orders placed: sent and closed orders, the same ones order value counts (drafts and cancelled orders left out).",
      agg: "count_distinct",
      of: { column: "purchase_order_id" },
      where: committedOrders,
      unit: "count",
    },
    {
      id: "orders_any_status",
      label: "Orders (any status)",
      description:
        "Number of different purchase orders in any status, drafts and cancelled ones included: for counting orders by status. Every other measure here counts only sent and closed orders.",
      agg: "count_distinct",
      of: { column: "purchase_order_id" },
      unit: "count",
    },
    {
      ...count(
        "line_count",
        "Order lines",
        "Number of purchase order lines on sent and closed orders (drafts and cancelled orders left out).",
      ),
      where: committedOrders,
    },
    {
      id: "ordered_quantity",
      label: "Ordered quantity",
      description:
        "Sum of stock line quantities on sent and closed orders, in the item's base unit. Non-stock lines are left out.",
      agg: "sum",
      of: { column: "quantity" },
      where: [...committedOrders, { column: "kind", op: "eq", value: "stock" }],
      unit: "quantity",
      splitBy: ["item", "base_unit"],
    },
  ],
  defaultDate: "ordered_on",
};

const purchaseInvoices: BiDataset = {
  id: "purchase_invoices",
  label: "Purchase invoices",
  description:
    "Current supplier invoice lines (superseded versions excluded) with the invoice's supplier, status and dates. Values are quantity × unit price before VAT, in the workspace currency.",
  grain: "one purchase invoice line",
  module: "purchasing",
  table: "purchase_invoice_lines",
  joins: {
    invoice: { table: "purchase_invoices", from: "invoice_id", kind: "parent", module: "purchasing" },
    supplier: {
      table: "suppliers",
      from: "supplier_id",
      fromJoin: "invoice",
      kind: "lookup",
      module: "items",
    },
    item: itemJoin,
  },
  scope: [{ join: "invoice", column: "status", op: "neq", value: "superseded" }],
  dimensions: [
    { id: "invoice_date", label: "Invoice date", type: "date", join: "invoice", column: "invoice_date" },
    { id: "due_date", label: "Due", type: "date", join: "invoice", column: "due_date" },
    {
      id: "status",
      label: "Invoice status",
      type: "category",
      join: "invoice",
      column: "status",
      values: purchaseInvoiceStatuses.filter((s) => s !== "superseded"),
    },
    {
      id: "line_kind",
      label: "Line kind",
      type: "category",
      column: "kind",
      values: purchaseInvoiceLineKinds,
    },
    {
      id: "supplier",
      label: "Supplier",
      type: "reference",
      join: "supplier",
      column: "id",
      labelColumn: "name",
    },
    ...itemDims(),
  ],
  measures: [
    {
      id: "invoice_value",
      label: "Invoiced value (net)",
      description:
        "Sum of quantity × unit price over the lines (draft and approved invoices; filter on status for approved only), before VAT, in the workspace currency.",
      agg: "sum",
      of: { column: "quantity" },
      times: { column: "unit_price" },
      unit: "money",
    },
    {
      id: "invoice_count",
      label: "Invoices",
      description: "Number of different invoices.",
      agg: "count_distinct",
      of: { column: "invoice_id" },
      unit: "count",
    },
  ],
  defaultDate: "invoice_date",
};

const salesOrders: BiDataset = {
  id: "sales_orders",
  label: "Sales orders and quotes",
  description:
    "Sales document lines (removed lines excluded) with the document's kind, status, customer and currency. Values are quantity × unit price in the document's currency, so money is always split by currency. Order value counts confirmed orders only; quote value issued quotes only.",
  grain: "one sales document line",
  module: "sales",
  table: "sales_order_lines",
  joins: {
    order: { table: "sales_orders", from: "order_id", kind: "parent", module: "sales" },
    customer: {
      table: "customers",
      from: "customer_id",
      fromJoin: "order",
      kind: "lookup",
      module: "customers",
    },
    item: itemJoin,
  },
  scope: [{ column: "removed_at", op: "is_null" }],
  dimensions: [
    { id: "created_on", label: "Created", type: "date", join: "order", column: "created_at", instant: true },
    {
      id: "confirmed_on",
      label: "Confirmed",
      type: "date",
      join: "order",
      column: "confirmed_at",
      instant: true,
    },
    { id: "due_on", label: "Due", type: "date", column: "due_on" },
    { id: "kind", label: "Kind", type: "category", join: "order", column: "kind", values: salesKinds },
    {
      id: "status",
      label: "Status",
      type: "category",
      join: "order",
      column: "status",
      values: salesStatuses,
    },
    { id: "currency", label: "Currency", type: "category", join: "order", column: "currency" },
    {
      id: "customer",
      label: "Customer",
      type: "reference",
      join: "customer",
      column: "id",
      labelColumn: "name",
    },
    ...itemDims(),
    {
      id: "base_unit",
      label: "Base unit",
      type: "category",
      column: "base_unit",
      values: Object.values(baseUnits),
    },
  ],
  measures: [
    {
      id: "sales_value",
      label: "Order value",
      description:
        "Sum of quantity × unit price over the lines of confirmed orders, in the document's currency.",
      agg: "sum",
      of: { column: "quantity" },
      times: { column: "unit_price" },
      where: [
        { join: "order", column: "kind", op: "eq", value: "order" },
        { join: "order", column: "status", op: "eq", value: "confirmed" },
      ],
      unit: "money",
      splitBy: ["currency"],
    },
    {
      id: "quote_value",
      label: "Quote value",
      description:
        "Sum of quantity × unit price over the lines of issued quotes, in the document's currency.",
      agg: "sum",
      of: { column: "quantity" },
      times: { column: "unit_price" },
      where: [
        { join: "order", column: "kind", op: "eq", value: "quote" },
        { join: "order", column: "status", op: "eq", value: "issued" },
      ],
      unit: "money",
      splitBy: ["currency"],
    },
    {
      id: "order_count",
      label: "Documents",
      description: "Number of different quotes or orders.",
      agg: "count_distinct",
      of: { column: "order_id" },
      unit: "count",
    },
    {
      id: "base_quantity",
      label: "Quantity",
      description: "Sum of line quantities in the item's base unit.",
      agg: "sum",
      of: { column: "base_quantity" },
      unit: "quantity",
      splitBy: ["item", "base_unit"],
    },
  ],
  defaultDate: "created_on",
  currencyDimension: "currency",
};

const productionBatches: BiDataset = {
  id: "production_batches",
  label: "Production batches",
  description: "Batches on the production schedule with their line, product, status and dates.",
  grain: "one batch",
  module: "production",
  table: "production_batches",
  joins: {
    item: { table: "items", from: "output_item_id", kind: "lookup", module: "items" },
    line: { table: "production_lines", from: "line_id", kind: "lookup", module: "production" },
  },
  dimensions: [
    { id: "planned_on", label: "Planned", type: "date", column: "planned_on" },
    { id: "completed_on", label: "Completed", type: "date", column: "completed_at", instant: true },
    {
      id: "status",
      label: "Status",
      type: "category",
      column: "status",
      values: productionBatchStatuses,
    },
    { id: "line", label: "Line", type: "reference", join: "line", column: "id", labelColumn: "name" },
    ...itemDims(),
    baseUnitDim(),
  ],
  measures: [
    count("batch_count", "Batches", "Number of batches."),
    {
      id: "planned_quantity",
      label: "Planned quantity",
      description: "Sum of planned output, in the product's base unit.",
      agg: "sum",
      of: { column: "planned_quantity" },
      unit: "quantity",
      splitBy: ["item", "base_unit"],
    },
  ],
  defaultDate: "planned_on",
};

const qualityComplaints: BiDataset = {
  id: "quality_complaints",
  label: "Complaints",
  description: "Customer and consumer complaints with their category, severity, source and status.",
  grain: "one complaint",
  module: "quality",
  table: "quality_complaints",
  joins: { item: itemJoin },
  dimensions: [
    { id: "received_on", label: "Received", type: "date", column: "received_on" },
    { id: "closed_on", label: "Closed", type: "date", column: "closed_at", instant: true },
    { id: "source", label: "Source", type: "category", column: "source", values: complaintSources },
    { id: "category", label: "Category", type: "category", column: "category", values: complaintCategories },
    { id: "severity", label: "Severity", type: "category", column: "severity", values: qualitySeverities },
    { id: "status", label: "Status", type: "category", column: "status", values: complaintStatuses },
    { id: "justified", label: "Justified", type: "boolean", column: "justified" },
    ...itemDims(),
  ],
  measures: [
    count("complaint_count", "Complaints", "Number of complaints."),
    {
      id: "open_count",
      label: "Open complaints",
      description: "Complaints not yet closed.",
      agg: "count",
      where: [{ column: "status", op: "neq", value: "closed" }],
      unit: "count",
    },
  ],
  defaultDate: "received_on",
};

const qualityNonconformances: BiDataset = {
  id: "quality_nonconformances",
  label: "Non-conformances (CAPA)",
  description: "Non-conformances with their source, severity, status, supplier and due date.",
  grain: "one non-conformance",
  module: "quality",
  table: "quality_nonconformances",
  joins: {
    item: itemJoin,
    supplier: { table: "suppliers", from: "supplier_id", kind: "lookup", module: "items" },
  },
  dimensions: [
    { id: "raised_on", label: "Raised", type: "date", column: "raised_on" },
    { id: "due_on", label: "Due", type: "date", column: "due_on" },
    { id: "closed_on", label: "Closed", type: "date", column: "closed_at", instant: true },
    { id: "source", label: "Source", type: "category", column: "source", values: nonconformanceSources },
    { id: "severity", label: "Severity", type: "category", column: "severity", values: qualitySeverities },
    { id: "status", label: "Status", type: "category", column: "status", values: nonconformanceStatuses },
    {
      id: "supplier",
      label: "Supplier",
      type: "reference",
      join: "supplier",
      column: "id",
      labelColumn: "name",
    },
    ...itemDims(),
  ],
  measures: [
    count("nonconformance_count", "Non-conformances", "Number of non-conformances."),
    {
      id: "open_count",
      label: "Open non-conformances",
      description: "Non-conformances not yet closed.",
      agg: "count",
      where: [{ column: "status", op: "neq", value: "closed" }],
      unit: "count",
    },
  ],
  defaultDate: "raised_on",
};

const haccpCorrectiveActions: BiDataset = {
  id: "haccp_corrective_actions",
  label: "HACCP corrective actions",
  description:
    "Corrective actions raised from CCP deviations, calibration failures and other food safety records.",
  grain: "one corrective action",
  module: "haccp",
  table: "haccp_corrective_actions",
  joins: {},
  dimensions: [
    { id: "raised_on", label: "Raised", type: "date", column: "created_at", instant: true },
    { id: "closed_on", label: "Closed", type: "date", column: "closed_at", instant: true },
    { id: "status", label: "Status", type: "category", column: "status", values: correctiveActionStatuses },
    { id: "source", label: "Source", type: "category", column: "source", values: haccpSources },
  ],
  measures: [
    count("action_count", "Corrective actions", "Number of corrective actions."),
    {
      id: "open_count",
      label: "Open corrective actions",
      description: "Corrective actions not yet closed.",
      agg: "count",
      where: [{ column: "status", op: "eq", value: "open" }],
      unit: "count",
    },
  ],
  defaultDate: "raised_on",
};

const trainingRecords: BiDataset = {
  id: "training_records",
  label: "Training records",
  description:
    "Training completed by people on the staff register (voided records excluded), by course and outcome.",
  grain: "one training record",
  module: "training",
  table: "training_records",
  joins: {
    course: { table: "training_courses", from: "course_id", kind: "lookup", module: "training" },
    staff: { table: "staff", from: "staff_id", kind: "lookup", module: "people" },
  },
  scope: [{ column: "voided_at", op: "is_null" }],
  dimensions: [
    { id: "completed_on", label: "Completed", type: "date", column: "completed_on" },
    { id: "expires_on", label: "Expires", type: "date", column: "expires_on" },
    { id: "outcome", label: "Outcome", type: "category", column: "outcome", values: trainingOutcomes },
    { id: "course", label: "Course", type: "reference", join: "course", column: "id", labelColumn: "title" },
    {
      id: "person",
      label: "Person",
      type: "reference",
      join: "staff",
      column: "id",
      labelColumn: ["first_name", "last_name"],
      hideFromGuests: true,
    },
  ],
  measures: [
    count("record_count", "Training records", "Number of training records."),
    {
      id: "people_trained",
      label: "People trained",
      description: "Number of different people with a record.",
      agg: "count_distinct",
      of: { column: "staff_id" },
      unit: "count",
    },
  ],
  defaultDate: "completed_on",
};

const tasks: BiDataset = {
  id: "tasks",
  label: "Tasks",
  description: "Tasks with their workflow state, priority, assignee, project and dates.",
  grain: "one task",
  module: "tasks",
  table: "tasks",
  joins: {
    state: { table: "workflow_states", from: "state_id", kind: "lookup", module: "tasks" },
    project: { table: "projects", from: "project_id", kind: "lookup", module: "tasks" },
    team: { table: "teams", from: "team_id", kind: "lookup" },
    assignee: userJoin("assignee_id"),
  },
  dimensions: [
    { id: "created_on", label: "Created", type: "date", column: "created_at", instant: true },
    { id: "completed_on", label: "Completed", type: "date", column: "completed_at", instant: true },
    { id: "due_on", label: "Due", type: "date", column: "due_date" },
    { id: "state", label: "State", type: "reference", join: "state", column: "id", labelColumn: "name" },
    {
      id: "state_type",
      label: "State type",
      type: "category",
      join: "state",
      column: "type",
      values: workflowStateTypes,
    },
    { id: "priority", label: "Priority", type: "category", column: "priority", values: [0, 1, 2, 3, 4] },
    {
      id: "assignee",
      label: "Assignee",
      type: "reference",
      join: "assignee",
      column: "id",
      labelColumn: "name",
    },
    {
      id: "project",
      label: "Project",
      type: "reference",
      join: "project",
      column: "id",
      labelColumn: "name",
    },
    { id: "team", label: "Team", type: "reference", join: "team", column: "id", labelColumn: "name" },
  ],
  measures: [
    count("task_count", "Tasks", "Number of tasks."),
    {
      id: "estimate_minutes",
      label: "Estimate",
      description: "Sum of estimates, in minutes.",
      agg: "sum",
      of: { column: "estimate_minutes" },
      unit: "minutes",
    },
  ],
  defaultDate: "created_on",
};

const timeEntries: BiDataset = {
  id: "time_entries",
  label: "Time entries",
  description: "Time logged against tasks, by person and date.",
  grain: "one time entry",
  module: "time",
  table: "time_entries",
  joins: { person: userJoin("user_id") },
  dimensions: [
    { id: "entry_date", label: "Date", type: "date", column: "entry_date" },
    { id: "person", label: "Person", type: "reference", join: "person", column: "id", labelColumn: "name" },
  ],
  measures: [
    {
      id: "minutes",
      label: "Time logged",
      description: "Sum of logged minutes.",
      agg: "sum",
      of: { column: "minutes" },
      unit: "minutes",
    },
    count("entry_count", "Entries", "Number of time entries."),
  ],
  defaultDate: "entry_date",
};

/** The certified metrics (bi/metrics.ts), offered as the measures of one dataset. */
const certifiedMetrics: BiDataset = {
  id: BI_METRICS_DATASET,
  label: "Certified metrics",
  description:
    "Governed figures computed by the same code as their module's page (OEE, cost variance, complaint rate, stock value, training compliance, overdue work), each with a definition and version. Metrics over a period can be trended by month, quarter or year; metrics as at now take no period.",
  grain: "one value per metric, per period bucket when trended",
  module: "bi",
  table: "",
  joins: {},
  virtual: true,
  dimensions: [
    {
      id: BI_METRICS_PERIOD_DIM,
      label: "Period",
      description: "The start of each bucket when a metric is trended.",
      type: "date",
      column: BI_METRICS_PERIOD_DIM,
    },
  ],
  measures: biMetricMeasures(),
  defaultDate: BI_METRICS_PERIOD_DIM,
};

/** Every dataset, in catalogue order. */
export const biDatasets: readonly BiDataset[] = [
  stockMovements,
  stockLots,
  purchaseOrders,
  purchaseInvoices,
  salesOrders,
  productionBatches,
  qualityComplaints,
  qualityNonconformances,
  haccpCorrectiveActions,
  trainingRecords,
  tasks,
  timeEntries,
  certifiedMetrics,
];

/** The catalogue version: bumped whenever a dataset's meaning changes (board packs record it). */
export const BI_CATALOGUE_VERSION = 4;

const byId = new Map(biDatasets.map((d) => [d.id, d]));
export const biDataset = (id: string): BiDataset | undefined => byId.get(id);

/** The modules a set of joins needs, besides the dataset's own (joins via `fromJoin` included). */
export function biJoinModules(dataset: BiDataset, joins: Iterable<string>): ModuleId[] {
  const out = new Set<ModuleId>([dataset.module]);
  const visit = (name: string) => {
    const join = dataset.joins[name];
    if (!join) return;
    if (join.module) out.add(join.module);
    if (join.fromJoin) visit(join.fromJoin);
  };
  for (const name of joins) visit(name);
  return [...out];
}

/** The join a dimension or measure reads through, if any. */
export const biFieldJoins = (field: BiDimension | BiMeasure): string[] => {
  if ("type" in field) return field.join ? [field.join] : [];
  return [
    field.of?.join,
    field.times?.join,
    field.convert?.unit.join,
    field.convert?.itemJoin,
    ...(field.where ?? []).map((w) => w.join),
  ].filter((j): j is string => Boolean(j));
};
