import { z } from "zod";
import {
  combineTotals,
  costingPeriodEnd,
  costingPeriodLabel,
  costingPeriods,
  costingPeriodStart,
  parseCostingBound,
  type CostingPeriod,
  type CostingReport,
  type CostingReportRow,
  type CostingTotals,
} from "./costing";
import type { AdjustmentCostLine, AdjustmentCostTotals } from "./costing-valuation";
import type { ItemStatus, ItemType, UnitCode } from "./items";
import type { StockAmount } from "./stock";

/**
 * Closing a costing period. Costs are computed on read (see docs/modules.md), so a past period's
 * figures can move when a standard cost changes or a record is corrected. Closing freezes them:
 * a person with `manage` signs the period off and the figures at that moment are stored (the
 * snapshot, written through `recordChanges`); the report then shows the snapshot for that period
 * and says how far today's figures have drifted from it. Reopening needs `manage` and a reason and
 * leaves the closed record in place (marked reopened, with who and why), so the history of closes
 * is an audit trail. No DOM or Node APIs.
 */

export const costingCloseStatuses = ["closed", "reopened"] as const;
export type CostingCloseStatus = (typeof costingCloseStatuses)[number];
export const costingCloseStatusLabels: Record<CostingCloseStatus, string> = {
  closed: "Closed",
  reopened: "Reopened",
};

/** A product's row in the frozen report, with the item it is for and its quantities as the report shows them. */
export type CostingReportRowView = Omit<CostingReportRow, "planned" | "produced"> & {
  item: { id: string; code: string; name: string; type: ItemType; unit: UnitCode; status: ItemStatus };
  planned: StockAmount;
  produced: StockAmount;
};

/** One completed batch in the frozen period. */
export interface FrozenBatch {
  id: string;
  batchCode: string;
  outputItemId: string;
  outputItemCode: string;
  outputItemName: string;
  unit: UnitCode;
  /** In the output item's own unit. */
  planned: number;
  produced: number;
  completedOn: string;
  actualCost: number;
  estimatedCost: number;
  costComplete: boolean;
  labour: number;
  overhead: number;
  standardCost: number | null;
  variance: number | null;
}

export interface FrozenAdjustments {
  totals: AdjustmentCostTotals;
  lines: (AdjustmentCostLine & { itemCode: string; itemName: string })[];
}

/** Everything the period showed when it was closed. */
export interface CostingCloseSnapshot {
  version: 1;
  currency: string;
  period: CostingPeriod;
  periodStart: string;
  periodEnd: string;
  totals: CostingTotals;
  rows: CostingReportRowView[];
  batches: FrozenBatch[];
  adjustments: FrozenAdjustments;
}

/** The headline figures of a close, small enough for lists and the sync log. */
export interface CostingCloseSummary {
  batches: number;
  incompleteBatches: number;
  materialCost: number;
  labourCost: number;
  overheadCost: number;
  totalCost: number;
  standardCost: number | null;
  variance: number | null;
  wasteAndAdjustments: number;
}

export const closeSummary = (snapshot: CostingCloseSnapshot): CostingCloseSummary => ({
  batches: snapshot.totals.batches,
  incompleteBatches: snapshot.totals.incompleteBatches,
  materialCost: snapshot.totals.actualCost,
  labourCost: snapshot.totals.conversion.labour,
  overheadCost: snapshot.totals.conversion.overhead,
  totalCost: snapshot.totals.totalCost,
  standardCost: snapshot.totals.standardCost,
  variance: snapshot.totals.variance.total,
  wasteAndAdjustments: snapshot.adjustments.totals.total,
});

/** How far today's live figures are from the frozen ones for the same period. */
export interface CostingDrift {
  /** Live minus frozen. */
  batches: number;
  actualCost: number;
  /** Anything differs: a record was corrected, a batch backdated, a standard cost changed. */
  changed: boolean;
}

export const costingDrift = (frozen: CostingTotals, live: CostingTotals): CostingDrift => {
  const batches = live.batches - frozen.batches;
  const actualCost = Math.round((live.actualCost - frozen.actualCost) * 10_000) / 10_000;
  const variance = (live.variance.total ?? 0) - (frozen.variance.total ?? 0);
  return { batches, actualCost, changed: batches !== 0 || actualCost !== 0 || Math.abs(variance) >= 0.00005 };
};

/** Who closed a period and when, for the report to show beside the frozen figures. */
export interface FrozenPeriodInfo {
  closeId: string;
  closedAt: string;
  closedBy: { id: string; name: string } | null;
  note: string | null;
  drift: CostingDrift;
}

/**
 * The report with frozen periods swapped in: each closed period shows the snapshot's totals and
 * rows instead of today's, the window's total is rebuilt from the periods, and every swapped
 * period says so (`frozen`). `liveRows` is the report's own rows, kept for periods that aren't closed.
 */
export function applyFrozenPeriods<Row extends { periodStart: string }>(
  report: Pick<CostingReport, "periods" | "totals">,
  rows: readonly Row[],
  frozen: ReadonlyMap<string, { snapshot: CostingCloseSnapshot; info: Omit<FrozenPeriodInfo, "drift"> }>,
): {
  periods: (CostingReport["periods"][number] & { frozen: FrozenPeriodInfo | null })[];
  rows: (Row | CostingReportRowView)[];
  totals: CostingTotals;
} {
  if (frozen.size === 0) {
    return {
      periods: report.periods.map((p) => ({ ...p, frozen: null })),
      rows: [...rows],
      totals: report.totals,
    };
  }
  const periods = report.periods.map((p) => {
    const close = frozen.get(p.periodStart);
    if (!close) return { ...p, frozen: null };
    return {
      ...p,
      totals: close.snapshot.totals,
      frozen: { ...close.info, drift: costingDrift(close.snapshot.totals, p.totals) },
    };
  });
  const merged: (Row | CostingReportRowView)[] = rows.filter((r) => !frozen.has(r.periodStart));
  for (const close of frozen.values()) merged.push(...close.snapshot.rows);
  return {
    periods,
    rows: merged,
    totals: combineTotals(periods.map((p) => p.totals)),
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** A date, ISO week (`2026-W46`) or month (`2026-11`): the period it falls in. */
const periodBound = z.string().trim().min(1).max(20);

/** The first and last day of the period a bound (date, week or month) falls in; `null` when unreadable. */
export function costingPeriodOf(
  period: CostingPeriod,
  bound: string,
): { periodStart: string; periodEnd: string; label: string } | null {
  const first = parseCostingBound(bound, "start");
  if (!first) return null;
  const periodStart = costingPeriodStart(first, period);
  return {
    periodStart,
    periodEnd: costingPeriodEnd(periodStart, period),
    label: costingPeriodLabel(periodStart, period),
  };
}

/**
 * `POST /costing/closes`: close the period `of` falls in. A period can be closed once it has
 * ended. `acknowledgeGaps` signs it off although batches in it have incomplete or provisional
 * costs (they stay incomplete in the snapshot).
 */
export const costingCloseSchema = z.object({
  period: z.enum(costingPeriods),
  of: periodBound,
  note: z.string().trim().max(500).nullish(),
  acknowledgeGaps: z.boolean().default(false),
});
export type CostingCloseInput = z.infer<typeof costingCloseSchema>;

/** `POST /costing/closes/:id/reopen`: why a closed period is being reopened (kept on the record). */
export const costingReopenSchema = z.object({
  reason: z.string().trim().min(3, "Say why the period is being reopened").max(500),
});
export type CostingReopenInput = z.infer<typeof costingReopenSchema>;

export const costingCloseListQuerySchema = z.object({
  period: z.enum(costingPeriods).optional(),
  status: z.enum(costingCloseStatuses).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type CostingCloseListQuery = z.infer<typeof costingCloseListQuerySchema>;
