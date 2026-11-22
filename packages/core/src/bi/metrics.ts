import { financialQuarterOf, financialYearOf } from "../financial-year";
import type { ModuleId } from "../modules";
import { addDays } from "../stock";
import type { BiDataset, BiMeasure } from "./catalogue";
import type { BiDateRange, BiGrain, BiIssue, BiQuerySpec } from "./query";

/**
 * Certified metrics: numbers that can't be written as a SUM or COUNT over a
 * table (OEE, stock valuation, cost variance, complaint rate, training compliance), each computed by
 * the same service function its module's page uses, so a dashboard and the module always agree.
 *
 * They are offered as the measures of one catalogue dataset, `certified_metrics`, so dashboards,
 * the builder and agents use them like any other measure. The server runs them through its metric
 * registry instead of the SQL compiler (`apps/server/src/services/bi/metrics.ts`).
 *
 * - `period` metrics are worked out over the query's period, and can be trended by month, quarter
 *   or year and compared with an earlier period.
 * - `point_in_time` metrics are as at the moment they are computed (stock on hand, overdue work):
 *   they take no period, grouping or comparison.
 *
 * Change a metric's meaning only with a new `version`; board packs record the version they show.
 */
export interface BiCertifiedMetric {
  id: string;
  label: string;
  /** The definition shown on hover, in the glossary and in board pack appendices. */
  definition: string;
  version: string;
  kind: "period" | "point_in_time";
  unit: "percent" | "money" | "count" | "per_million";
  /** The module whose page shows the same figure; the viewer needs `read` on it. */
  module: ModuleId;
  /** Where the module shows it, for people checking a figure (relative to the workspace). */
  page: string;
  goodDirection: "up" | "down";
  /**
   * Worked out over whole calendar months (its module reports by month): the period is widened to
   * the months it touches, and a comparison uses the same number of whole months before.
   */
  wholeMonths?: boolean;
}

export const biCertifiedMetrics: readonly BiCertifiedMetric[] = [
  {
    id: "oee",
    label: "OEE (site)",
    definition:
      "Overall equipment effectiveness across every production line: ideal run time of the good output ÷ planned production time (capacity less planned downtime), as a percentage. Batches with no rate on their line are left out of performance and quality. The same figure as Production → Performance.",
    version: "oee-v1",
    kind: "period",
    unit: "percent",
    module: "production",
    page: "production/performance",
    goodDirection: "up",
  },
  {
    id: "batch_cost_variance",
    label: "Batch cost variance",
    definition:
      "Actual less standard cost of the batches completed in the calendar months the period touches, over complete batches only (positive is adverse: more than standard), in the workspace currency. The same total as Costing → Report for those months.",
    version: "cost-variance-v1",
    wholeMonths: true,
    kind: "period",
    unit: "money",
    module: "costing",
    page: "costing",
    goodDirection: "down",
  },
  {
    id: "complaint_rate",
    label: "Complaints per million units",
    definition:
      "Complaints received per million units sold, over the calendar months the period touches. Units are the sales volumes entered per product and month in Quality; a period with no units on record has no rate. The same figure as Quality → Trends.",
    version: "complaint-rate-v1",
    wholeMonths: true,
    kind: "period",
    unit: "per_million",
    module: "quality",
    page: "quality/trends",
    goodDirection: "down",
  },
  {
    id: "supplier_otif",
    label: "Supplier OTIF",
    definition:
      "Purchase order lines delivered on time and in full, as a percentage of the lines due in the period: each line against the date the supplier promised when the order was sent, across every supplier. Reversed receipts are left out. The same figure as Purchasing → Supplier performance.",
    version: "supplier-otif-v1",
    kind: "period",
    unit: "percent",
    module: "purchasing",
    page: "purchasing/supplier-performance",
    goodDirection: "up",
  },
  {
    id: "stock_value",
    label: "Stock value",
    definition:
      "Stock on hand valued at lot cost (invoice or purchase price, the batch that made it, or the standard cost where nothing else is known), materials only, in the workspace currency, as at the time it is computed. The same total as Costing → Valuation.",
    version: "stock-value-v1",
    kind: "point_in_time",
    unit: "money",
    module: "costing",
    page: "costing/valuation",
    goodDirection: "down",
  },
  {
    id: "training_compliance",
    label: "Training compliance",
    definition:
      "Of every course each person needs, the share they are currently competent in (current, or current but expiring soon), as a percentage, as at the time it is computed. Courses a person doesn't need are left out. The same counts as the Training matrix.",
    version: "training-compliance-v1",
    kind: "point_in_time",
    unit: "percent",
    module: "training",
    page: "training",
    goodDirection: "up",
  },
  {
    id: "overdue_nonconformances",
    label: "Overdue non-conformances",
    definition:
      "Non-conformances not yet closed whose due date has passed, as at the time it is computed. The same count as the Quality overview.",
    version: "overdue-ncs-v1",
    kind: "point_in_time",
    unit: "count",
    module: "quality",
    page: "quality",
    goodDirection: "down",
  },
  {
    id: "open_complaints",
    label: "Open complaints",
    definition:
      "Complaints that are open or being investigated, as at the time it is computed. The same count as the Quality overview (open plus investigating).",
    version: "open-complaints-v1",
    kind: "point_in_time",
    unit: "count",
    module: "quality",
    page: "quality",
    goodDirection: "down",
  },
];

export const biCertifiedMetric = (id: string) => biCertifiedMetrics.find((m) => m.id === id);

/** The id of the catalogue dataset holding the certified metrics. */
export const BI_METRICS_DATASET = "certified_metrics";
/** Its one dimension: the start of each period bucket when a metric is trended. */
export const BI_METRICS_PERIOD_DIM = "period_on";
/** Grains a certified metric can be trended by (each bucket is one service call). */
export const BI_METRIC_GRAINS: readonly BiGrain[] = [
  "month",
  "quarter",
  "year",
  "financial_quarter",
  "financial_year",
];
/** Buckets one trended query may compute. */
export const BI_METRIC_MAX_BUCKETS = 36;

/** The certified metrics as catalogue measures. */
export const biMetricMeasures = (): BiMeasure[] =>
  biCertifiedMetrics.map((m) => ({
    id: m.id,
    label: m.label,
    description: m.definition,
    agg: "certified",
    unit: m.unit,
    module: m.module,
    certified: { version: m.version, kind: m.kind },
  }));

/** Extra checks for a query on the certified metrics dataset (after the general ones). */
export function checkBiMetricQuery(spec: BiQuerySpec, dataset: BiDataset): BiIssue[] {
  if (dataset.id !== BI_METRICS_DATASET) return [];
  const issues: BiIssue[] = [];
  const metrics = spec.measures.map((id) => biCertifiedMetric(id)).filter((m) => m !== undefined);
  const pointInTime = metrics.filter((m) => m.kind === "point_in_time");
  const periodic = metrics.filter((m) => m.kind === "period");
  if (pointInTime.length && periodic.length) {
    issues.push({
      path: "measures",
      message: `ask for metrics as at now (${pointInTime.map((m) => m.id).join(", ")}) and metrics over a period (${periodic.map((m) => m.id).join(", ")}) in separate widgets`,
    });
  }
  if (spec.filters.length) {
    issues.push({
      path: "filters",
      message: "certified metrics take no filters: they cover the whole workspace",
    });
  }
  spec.groupBy.forEach((g, i) => {
    if (g.grain && !BI_METRIC_GRAINS.includes(g.grain)) {
      issues.push({
        path: `groupBy[${i}].grain`,
        message: `certified metrics trend by ${BI_METRIC_GRAINS.join(", ")}`,
        suggestion: "month",
      });
    }
  });
  if (pointInTime.length && periodic.length === 0) {
    if (spec.groupBy.length)
      issues.push({ path: "groupBy", message: "metrics as at now can't be trended: remove the grouping" });
    if (spec.compare)
      issues.push({ path: "compare", message: "metrics as at now have no earlier period to compare with" });
  }
  if (periodic.length && !spec.period) {
    issues.push({
      path: "period",
      message: "metrics over a period need a period",
      suggestion: "last_12_months",
    });
  } else if (periodic.length && spec.period && !spec.period.preset && !(spec.period.from && spec.period.to)) {
    issues.push({ path: "period", message: "metrics over a period need a preset or both from and to" });
  } else if (
    periodic.length &&
    spec.period?.from &&
    spec.period.to &&
    !spec.groupBy.length &&
    daysBetween(spec.period.from, spec.period.to) > BI_METRIC_MAX_DAYS
  ) {
    // Each figure is a full module report; past a year, trend it so each bucket stays bounded.
    issues.push({
      path: "period",
      message: `a metric over more than ${BI_METRIC_MAX_DAYS} days must be trended: group by period_on (month, quarter or year)`,
      suggestion: "year",
    });
  }
  return issues;
}

/** Longest period one certified metric figure covers (one module report). */
export const BI_METRIC_MAX_DAYS = 366;

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** The first day of the month after `date`'s. */
const nextMonthStart = (date: string) => `${addDays(`${date.slice(0, 7)}-01`, 32).slice(0, 7)}-01`;

/**
 * The range a metric is worked out over: the period itself, or for `wholeMonths` metrics the
 * calendar months it touches (`[first of from's month, first of the month after to's last day)`).
 */
export function biMetricRange(metric: BiCertifiedMetric, range: BiDateRange): BiDateRange {
  if (!metric.wholeMonths) return range;
  return { from: `${range.from.slice(0, 7)}-01`, to: nextMonthStart(addDays(range.to, -1)) };
}

/** Months in a whole-month range. */
const monthCount = (range: BiDateRange) =>
  (Number(range.to.slice(0, 4)) - Number(range.from.slice(0, 4))) * 12 +
  Number(range.to.slice(5, 7)) -
  Number(range.from.slice(5, 7));

/** Shifts a whole-month range back by some months. */
function monthsBefore(range: BiDateRange, months: number): BiDateRange {
  const shift = (date: string) => {
    const y = Number(date.slice(0, 4));
    const m = Number(date.slice(5, 7)) - 1 - months;
    const year = y + Math.floor(m / 12);
    return `${year}-${String((((m % 12) + 12) % 12) + 1).padStart(2, "0")}-01`;
  };
  return { from: shift(range.from), to: shift(range.to) };
}

/**
 * The comparison range for a metric: for `wholeMonths` metrics the same number of whole months
 * just before (or twelve months earlier), so the two never overlap; otherwise `fallback`.
 */
export function biMetricCompareRange(
  metric: BiCertifiedMetric,
  range: BiDateRange,
  compare: "previous_period" | "previous_year",
  fallback: BiDateRange,
): BiDateRange {
  if (!metric.wholeMonths) return fallback;
  const months = biMetricRange(metric, range);
  return monthsBefore(months, compare === "previous_year" ? 12 : monthCount(months));
}

/** The start of the bucket `date` falls in, for a metric grain. */
export function biMetricBucketStart(date: string, grain: BiGrain, financialYearStartMonth: number): string {
  const month = `${date.slice(0, 7)}-01`;
  switch (grain) {
    case "month":
      return month;
    case "quarter": {
      const m = Math.floor((Number(date.slice(5, 7)) - 1) / 3) * 3 + 1;
      return `${date.slice(0, 4)}-${String(m).padStart(2, "0")}-01`;
    }
    case "year":
      return `${date.slice(0, 4)}-01-01`;
    case "financial_quarter":
      return financialQuarterOf(date, financialYearStartMonth).start;
    case "financial_year":
      return financialYearOf(date, financialYearStartMonth).start;
    default:
      return date;
  }
}

/**
 * A period cut into the buckets of a grain, each clipped to the period: `[from, to)` ranges in
 * order. Refuses (returns null) past `BI_METRIC_MAX_BUCKETS`.
 */
export function biMetricBuckets(
  range: BiDateRange,
  grain: BiGrain,
  financialYearStartMonth: number,
): Array<BiDateRange & { bucket: string }> | null {
  const out: Array<BiDateRange & { bucket: string }> = [];
  // Every metric grain starts on the first of a month, so buckets end on a month start.
  const nextMonth = (date: string) => `${addDays(`${date.slice(0, 7)}-01`, 32).slice(0, 7)}-01`;
  let cursor = range.from;
  while (cursor < range.to) {
    const bucket = biMetricBucketStart(cursor, grain, financialYearStartMonth);
    let next = nextMonth(cursor);
    while (next < range.to && biMetricBucketStart(next, grain, financialYearStartMonth) === bucket) {
      next = nextMonth(next);
    }
    out.push({ bucket, from: cursor, to: next < range.to ? next : range.to });
    if (out.length > BI_METRIC_MAX_BUCKETS) return null;
    cursor = next;
  }
  return out;
}
