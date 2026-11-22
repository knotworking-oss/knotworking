import { z } from "zod";
import { costingPeriods, type CostingPeriod } from "./costing";
import { toCsv } from "./csv";
import type { AdjustmentCostType } from "./costing-valuation";
import { adjustmentCostTypeLabels } from "./costing-valuation";
import { lotStatuses } from "./stock";

/**
 * Generic CSV exports of the costing figures, for an accountant to load into whatever they use
 * (there are no Sage or Xero connections). Plain columns, one amount per line, a currency column,
 * ISO dates (`2026-11-30`: the format spreadsheets and accounting imports parse without guessing),
 * numbers as numbers. A period that was closed exports its frozen figures (`status` says which).
 * Pure; the server builds the rows from the same views the report and the valuation return.
 */

export const costingExportKinds = ["journal", "batches", "valuation", "adjustments"] as const;
export type CostingExportKind = (typeof costingExportKinds)[number];
export const costingExportKindLabels: Record<CostingExportKind, string> = {
  journal: "Cost journal by period",
  batches: "Batches",
  valuation: "Stock valuation",
  adjustments: "Waste and adjustments",
};

/** `GET /costing/export.csv`: `from`/`to` take a date, week or month, as the report does. */
export const costingExportQuerySchema = z.object({
  kind: z.enum(costingExportKinds).default("journal"),
  period: z.enum(costingPeriods).default("month"),
  from: z.string().trim().min(1).max(20).optional(),
  to: z.string().trim().min(1).max(20).optional(),
  /** Valuation only. */
  status: z.enum(lotStatuses).optional(),
});
export type CostingExportQuery = z.infer<typeof costingExportQuerySchema>;

type Cell = string | number | null;
type Rows = Cell[][];

export interface JournalPeriod {
  periodStart: string;
  periodEnd: string;
  /** `2026-11` or `2026-W46`. */
  label: string;
  frozen: boolean;
  rows: {
    itemCode: string;
    itemName: string;
    unit: string;
    /** Display unit. */
    produced: number;
    batches: number;
    materials: number;
    labour: number;
    overhead: number;
  }[];
  adjustments: Record<AdjustmentCostType, number>;
}

/**
 * One line per product and kind of cost, and one per period for waste and adjustments. Amounts are
 * costs (positive: money spent or lost; a stock gain is negative).
 */
export function journalCsv(input: {
  currency: string;
  period: CostingPeriod;
  periods: readonly JournalPeriod[];
}) {
  const rows: Rows = [
    [
      "Date",
      "Period",
      "Reference",
      "Cost type",
      "Product code",
      "Product",
      "Quantity made",
      "Unit",
      "Batches",
      "Amount",
      "Currency",
      "Status",
    ],
  ];
  for (const p of input.periods) {
    const reference = `COST-${p.label}`;
    const status = p.frozen ? "Closed" : "Open";
    const line = (type: string, amount: number, product?: JournalPeriod["rows"][number]) =>
      rows.push([
        p.periodEnd,
        p.label,
        reference,
        type,
        product?.itemCode ?? "",
        product?.itemName ?? "",
        product?.produced ?? null,
        product?.unit ?? "",
        product?.batches ?? null,
        amount,
        input.currency,
        status,
      ]);
    for (const r of p.rows) {
      line("Materials", r.materials, r);
      if (r.labour) line("Labour absorbed", r.labour, r);
      if (r.overhead) line("Overhead absorbed", r.overhead, r);
    }
    for (const type of ["waste", "adjustment", "stocktake"] as const) {
      if (p.adjustments[type]) line(adjustmentCostTypeLabels[type], p.adjustments[type]);
    }
  }
  return toCsv(rows);
}

export interface BatchExportRow {
  batchCode: string;
  completedOn: string;
  itemCode: string;
  itemName: string;
  unit: string;
  produced: number;
  planned: number;
  materials: number;
  labour: number;
  overhead: number;
  standardCost: number | null;
  variance: number | null;
  costComplete: boolean;
}

export function batchesCsv(input: { currency: string; batches: readonly BatchExportRow[] }) {
  return toCsv([
    [
      "Batch",
      "Completed",
      "Product code",
      "Product",
      "Planned",
      "Produced",
      "Unit",
      "Materials",
      "Labour absorbed",
      "Overhead absorbed",
      "Total cost",
      "Standard cost",
      "Variance",
      "Cost complete",
      "Currency",
    ],
    ...input.batches.map((b): Cell[] => [
      b.batchCode,
      b.completedOn,
      b.itemCode,
      b.itemName,
      b.planned,
      b.produced,
      b.unit,
      b.materials,
      b.labour,
      b.overhead,
      Math.round((b.materials + b.labour + b.overhead) * 10_000) / 10_000,
      b.standardCost,
      b.variance,
      b.costComplete ? "Yes" : "No",
      input.currency,
    ]),
  ]);
}

export interface ValuationExportRow {
  itemCode: string;
  itemName: string;
  lotCode: string;
  status: string;
  receivedOn: string;
  expiresOn: string | null;
  /** In the item's unit. */
  quantity: number;
  unit: string;
  unitCost: number | null;
  value: number | null;
  /** `invoice`, `purchase`, `batch`, `standard` or `missing`. */
  source: string;
  estimatedPercent: number;
}

export function valuationCsv(input: { currency: string; asOf: string; lots: readonly ValuationExportRow[] }) {
  return toCsv([
    [
      "As at",
      "Product code",
      "Product",
      "Lot",
      "Status",
      "Received",
      "Expires",
      "Quantity",
      "Unit",
      "Unit cost",
      "Value",
      "Cost source",
      "Estimated %",
      "Currency",
    ],
    ...input.lots.map((l): Cell[] => [
      input.asOf,
      l.itemCode,
      l.itemName,
      l.lotCode,
      l.status,
      l.receivedOn,
      l.expiresOn,
      l.quantity,
      l.unit,
      l.unitCost,
      l.value,
      l.source,
      l.estimatedPercent,
      input.currency,
    ]),
  ]);
}

export interface AdjustmentExportRow {
  type: AdjustmentCostType;
  itemCode: string;
  itemName: string;
  /** In the item's unit, signed. */
  quantity: number;
  unit: string;
  loss: number;
  movements: number;
  /** Quantity on lots with no cost (not in `loss`), in the item's unit. */
  unvaluedQuantity: number;
}

export function adjustmentsCsv(input: {
  currency: string;
  from: string;
  to: string;
  lines: readonly AdjustmentExportRow[];
}) {
  return toCsv([
    [
      "From",
      "To",
      "Type",
      "Product code",
      "Product",
      "Quantity",
      "Unit",
      "Movements",
      "Cost (loss positive)",
      "Quantity with no cost",
      "Currency",
    ],
    ...input.lines.map((l): Cell[] => [
      input.from,
      input.to,
      adjustmentCostTypeLabels[l.type],
      l.itemCode,
      l.itemName,
      l.quantity,
      l.unit,
      l.movements,
      l.loss,
      l.unvaluedQuantity,
      input.currency,
    ]),
  ]);
}
