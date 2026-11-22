import {
  BI_CATALOGUE_VERSION,
  BI_METRICS_PERIOD_DIM,
  addDays,
  biCertifiedMetric,
  biMetricBuckets,
  biMetricCompareRange,
  biMetricRange,
  comparisonRange,
  costingReportRange,
  costingValuationQuerySchema,
  resolveBiPeriod,
  trainingMatrixQuerySchema,
  type BiDataset,
  type BiDateRange,
  type BiQuerySpec,
} from "@knotworking/core";
import type { Database } from "@knotworking/db";
import { ApiError } from "../../errors";
import { getCostingReport, getStockValuation } from "../costing-reports";
import { getPerformance } from "../production-performance";
import { getSupplierPerformance } from "../purchasing";
import { qualitySummary } from "../quality";
import { complaintTrends } from "../quality-extras";
import { trainingMatrix } from "../training";
import type { BiQueryResult, BiValue, BiWorkspace } from "./query";

/**
 * The certified metrics (declarations in `@knotworking/core` bi/metrics.ts).
 * Each one calls the service its module's page calls, with the same arguments the page's route
 * passes, so a dashboard and the module show the same figure (`bi-metrics.test.ts` checks each
 * pair). A metric's module access is checked by the catalogue before it gets here.
 */
type MetricRun = (db: Database, ws: BiWorkspace, range: BiDateRange | null) => Promise<number | null>;

/** `[from, to)` as the inclusive dates module routes take. */
const lastDay = (range: BiDateRange) => addDays(range.to, -1);
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
const percent = (ratio: number | null) => (ratio === null ? null : round(ratio * 100, 1));

/** Months from `from`'s month to `to`'s month, inclusive. */
const monthsSpanned = (from: string, to: string) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
  Number(to.slice(5, 7)) -
  Number(from.slice(5, 7)) +
  1;

const runs: Record<string, MetricRun> = {
  // Production → Performance: `GET /production/performance?from=&to=`, its `site.oee`.
  async oee(db, ws, range) {
    const performance = await getPerformance(
      db,
      ws.id,
      { from: range!.from, to: lastDay(range!) },
      { costing: false },
    );
    return percent(performance.site.oee);
  },
  // Costing → Report: `GET /costing/report?from=&to=` (monthly), its `totals.variance.total`.
  async batch_cost_variance(db, ws, range) {
    const bounds = costingReportRange({ period: "month", from: range!.from, to: lastDay(range!) }, ws.today);
    if (bounds.error) {
      throw new ApiError(400, "invalid_query", `period: ${bounds.error}`, {
        issues: [{ path: "period", message: bounds.error }],
      });
    }
    const report = await getCostingReport(db, ws.id, { period: "month", from: bounds.from, to: bounds.to });
    return report.totals.standardCost === null ? null : report.totals.variance.total;
  },
  // Quality → Trends: `GET /quality/trends?months=`, its `overall.total.perMillion`, over the
  // calendar months the period touches.
  async complaint_rate(db, ws, range) {
    const end = lastDay(range!);
    const trends = await complaintTrends(db, ws.id, monthsSpanned(range!.from, end), end);
    return trends.overall.total.perMillion === null ? null : round(trends.overall.total.perMillion, 1);
  },
  // Purchasing → Supplier performance: `GET /purchasing/supplier-performance?from=&to=`, its
  // `totals.otifPercent`.
  async supplier_otif(db, ws, range) {
    const performance = await getSupplierPerformance(
      db,
      ws.id,
      { from: range!.from, to: lastDay(range!) },
      ws.today,
    );
    return performance.totals.otifPercent;
  },
  // Costing → Valuation: `GET /costing/valuation`, its `totals.value`.
  async stock_value(db, ws) {
    const valuation = await getStockValuation(db, ws.id, costingValuationQuerySchema.parse({}), ws.today);
    return valuation.totals.value;
  },
  // Training matrix: `GET /training/matrix`, current (and expiring) over every required cell.
  async training_compliance(db, ws) {
    const { summary } = await trainingMatrix(db, ws.id, trainingMatrixQuerySchema.parse({}), ws.today);
    const required = Object.values(summary).reduce((t, n) => t + n, 0);
    return required ? round(((summary.current + summary.expiring) / required) * 100, 1) : null;
  },
  // Quality overview: `GET /quality/summary`.
  async overdue_nonconformances(db, ws) {
    return (await qualitySummary(db, ws.id, ws.today)).nonconformances.overdue;
  },
  async open_complaints(db, ws) {
    const { complaints } = await qualitySummary(db, ws.id, ws.today);
    return complaints.open + complaints.investigating;
  },
};

/** Every declared metric has an implementation (checked at start-up and in tests). */
export const certifiedMetricIds = Object.keys(runs);

/**
 * Each metric over the range (whole-month metrics over the months it touches), or with `compare`
 * over its comparison range: for whole-month metrics the same number of whole months before, so
 * the two never overlap.
 */
async function compute(
  db: Database,
  ws: BiWorkspace,
  ids: readonly string[],
  range: BiDateRange | null,
  compare?: "previous_period" | "previous_year",
) {
  const out: Record<string, BiValue> = {};
  // One at a time: each is a full module report, and the analytic gate doesn't cover services.
  for (const id of ids) {
    const run = runs[id];
    const metric = biCertifiedMetric(id);
    if (!run || !metric)
      throw new ApiError(500, "internal", `Certified metric '${id}' has no implementation`);
    let own = range;
    if (range && compare) own = biMetricCompareRange(metric, range, compare, comparisonRange(range, compare));
    else if (range) own = biMetricRange(metric, range);
    out[id] = await run(db, ws, own);
  }
  return out;
}

/**
 * Runs a (checked) query on the certified metrics dataset: one row for the period, or one per
 * bucket when grouped by the period, with the comparison period for ungrouped queries. The result
 * has the same shape as any other query's.
 */
export async function runCertifiedQuery(
  db: Database,
  ws: BiWorkspace,
  dataset: BiDataset,
  spec: BiQuerySpec,
): Promise<BiQueryResult> {
  const periodic = spec.measures.some((id) => biCertifiedMetric(id)?.kind === "period");
  const range: BiDateRange | null =
    periodic && spec.period
      ? spec.period.preset
        ? resolveBiPeriod(spec.period.preset, ws.today, ws.financialYearStartMonth)
        : { from: spec.period.from!, to: spec.period.to! }
      : null;
  const grouping = spec.groupBy[0];
  let rows: Record<string, BiValue>[];
  if (grouping && range) {
    const buckets = biMetricBuckets(range, grouping.grain!, ws.financialYearStartMonth);
    if (!buckets) {
      throw new ApiError(400, "invalid_query", "groupBy[0].grain: too many periods: use a longer grain", {
        issues: [{ path: "groupBy[0].grain", message: "too many periods to compute: use a longer grain" }],
      });
    }
    rows = [];
    for (const b of buckets)
      rows.push({ [BI_METRICS_PERIOD_DIM]: b.bucket, ...(await compute(db, ws, spec.measures, b)) });
    rows.sort((a, b) => {
      for (const { by, dir } of spec.sort) {
        const x = a[by] ?? null;
        const y = b[by] ?? null;
        if (x === y) continue;
        if (x === null) return 1;
        if (y === null) return -1;
        return (x < y ? -1 : 1) * (dir === "asc" ? 1 : -1);
      }
      return 0;
    });
  } else {
    rows = [await compute(db, ws, spec.measures, range)];
  }
  let comparePeriod: BiDateRange | null = null;
  if (spec.compare && range && !grouping) {
    comparePeriod = comparisonRange(range, spec.compare);
    const before = await compute(db, ws, spec.measures, range, spec.compare);
    for (const id of spec.measures) rows[0]![`${id}__compare`] = before[id] ?? null;
  }
  const limit = spec.limit ?? rows.length;
  const measures = new Map(dataset.measures.map((m) => [m.id, m]));
  return {
    dataset: dataset.id,
    catalogueVersion: BI_CATALOGUE_VERSION,
    columns: [
      ...(grouping
        ? [
            {
              key: BI_METRICS_PERIOD_DIM,
              label: "Period",
              kind: "dimension" as const,
              type: "date" as const,
              grain: grouping.grain,
            },
          ]
        : []),
      ...spec.measures.map((id) => ({
        key: id,
        label: measures.get(id)!.label,
        kind: "measure" as const,
        unit: measures.get(id)!.unit,
        ...(comparePeriod ? { compareKey: `${id}__compare` } : {}),
      })),
    ],
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    period: range ? { dim: BI_METRICS_PERIOD_DIM, ...range } : null,
    comparePeriod,
    compareTruncated: false,
    currency: ws.currency,
  };
}
