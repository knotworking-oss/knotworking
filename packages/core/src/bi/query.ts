import { z } from "zod";
import { financialQuarterOf, financialYearOf } from "../financial-year";
import { addDays } from "../stock";
import type { BiDataset, BiDimension, BiMeasure } from "./catalogue";
import { checkBiMetricQuery } from "./metrics";

/**
 * The query spec: the one shape the BI engine runs. Validated structurally by `biQuerySpecSchema`
 * and against the catalogue by `checkBiQuery`, whose issues name the exact path, the reason and the
 * nearest valid alternative, so an agent can fix its spec in one step.
 */

export const biGrains = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
  "financial_quarter",
  "financial_year",
] as const;
export type BiGrain = (typeof biGrains)[number];

export const biFilterOps = [
  "eq",
  "neq",
  "in",
  "not_in",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "is_null",
  "not_null",
] as const;
export type BiFilterOp = (typeof biFilterOps)[number];

/**
 * Period presets, resolved in the workspace time zone and financial year. Ranges include `from`
 * and exclude `to`. "Last N days" end today (inclusive). "Last 3/6/12 months" are the current month
 * (to today) and the 2/5/11 whole months before it. "This …" runs to the end of the current period;
 * "… to date" runs to today.
 */
export const biPeriodPresets = [
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "this_month",
  "last_month",
  "last_3_months",
  "last_6_months",
  "last_12_months",
  "this_quarter",
  "last_quarter",
  "this_financial_year",
  "last_financial_year",
  "financial_year_to_date",
  "this_year",
  "last_year",
  "year_to_date",
] as const;
export type BiPeriodPreset = (typeof biPeriodPresets)[number];

/** A real calendar date as `YYYY-MM-DD` (not 2026-02-30 or 2026-13-01). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isoDate = z.string().refine(isCalendarDate, "Use a real YYYY-MM-DD date");
const fieldId = z.string().trim().min(1).max(64);
const scalar = z.union([z.string().max(200), z.number(), z.boolean()]);

export const biFilterSchema = z.object({
  dim: fieldId,
  op: z.enum(biFilterOps),
  value: z.union([scalar, z.array(scalar).max(100)]).optional(),
});
export type BiFilter = z.infer<typeof biFilterSchema>;

export const biPeriodSchema = z
  .object({
    /** The date dimension the period applies to; the dataset's `defaultDate` when omitted. */
    dim: fieldId.optional(),
    preset: z.enum(biPeriodPresets).optional(),
    from: isoDate.optional(),
    /** Exclusive. */
    to: isoDate.optional(),
  })
  .refine((p) => (p.preset ? !p.from && !p.to : Boolean(p.from || p.to)), {
    message: "Give either a preset, or from and/or to dates",
  })
  .refine((p) => !p.from || !p.to || p.from < p.to, { message: "from must be before to" });
export type BiPeriod = z.infer<typeof biPeriodSchema>;

export const BI_MAX_LIMIT = 5000;

export const biQuerySpecSchema = z.object({
  dataset: fieldId,
  measures: z.array(fieldId).min(1).max(10),
  groupBy: z
    .array(z.object({ dim: fieldId, grain: z.enum(biGrains).optional() }))
    .max(3)
    .default([]),
  filters: z.array(biFilterSchema).max(20).default([]),
  period: biPeriodSchema.optional(),
  /** Adds the same measures for the previous period (or a year earlier) as `<measure>__compare`. */
  compare: z.enum(["previous_period", "previous_year"]).optional(),
  sort: z
    .array(z.object({ by: fieldId, dir: z.enum(["asc", "desc"]).default("desc") }))
    .max(3)
    .default([]),
  limit: z.number().int().min(1).max(BI_MAX_LIMIT).optional(),
});
export type BiQuerySpec = z.infer<typeof biQuerySpecSchema>;
export type BiQuerySpecInput = z.input<typeof biQuerySpecSchema>;

/** A problem with a spec: where, why, and the nearest valid alternative when there is one. */
export interface BiIssue {
  path: string;
  message: string;
  suggestion?: string;
}

// ─── Periods ─────────────────────────────────────────────────────────────────

export interface BiDateRange {
  from: string;
  /** Exclusive. */
  to: string;
}

const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
function addMonths(date: string, months: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + months;
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  // Clamp the day: a year before 29 February is 28 February.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(Number(date.slice(8, 10)), lastDay);
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The dates a preset covers, given today (in the workspace zone) and the financial year start. */
export function resolveBiPeriod(
  preset: BiPeriodPreset,
  today: string,
  financialYearStartMonth = 1,
): BiDateRange {
  const tomorrow = addDays(today, 1);
  switch (preset) {
    case "today":
      return { from: today, to: tomorrow };
    case "yesterday":
      return { from: addDays(today, -1), to: today };
    case "last_7_days":
      return { from: addDays(today, -6), to: tomorrow };
    case "last_30_days":
      return { from: addDays(today, -29), to: tomorrow };
    case "last_90_days":
      return { from: addDays(today, -89), to: tomorrow };
    case "this_month":
      return { from: monthStart(today), to: addMonths(monthStart(today), 1) };
    case "last_month":
      return { from: addMonths(monthStart(today), -1), to: monthStart(today) };
    case "last_3_months":
      return { from: addMonths(monthStart(today), -2), to: tomorrow };
    case "last_6_months":
      return { from: addMonths(monthStart(today), -5), to: tomorrow };
    case "last_12_months":
      return { from: addMonths(monthStart(today), -11), to: tomorrow };
    case "this_quarter": {
      const q = financialQuarterOf(today, financialYearStartMonth);
      return { from: q.start, to: q.end };
    }
    case "last_quarter": {
      const q = financialQuarterOf(
        addDays(financialQuarterOf(today, financialYearStartMonth).start, -1),
        financialYearStartMonth,
      );
      return { from: q.start, to: q.end };
    }
    case "this_financial_year": {
      const fy = financialYearOf(today, financialYearStartMonth);
      return { from: fy.start, to: fy.end };
    }
    case "last_financial_year": {
      const fy = financialYearOf(
        addDays(financialYearOf(today, financialYearStartMonth).start, -1),
        financialYearStartMonth,
      );
      return { from: fy.start, to: fy.end };
    }
    case "financial_year_to_date":
      return { from: financialYearOf(today, financialYearStartMonth).start, to: tomorrow };
    case "this_year":
      return { from: `${today.slice(0, 4)}-01-01`, to: `${Number(today.slice(0, 4)) + 1}-01-01` };
    case "last_year":
      return { from: `${Number(today.slice(0, 4)) - 1}-01-01`, to: `${today.slice(0, 4)}-01-01` };
    case "year_to_date":
      return { from: `${today.slice(0, 4)}-01-01`, to: tomorrow };
  }
}

/** The days between two dates (`to` exclusive). */
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * The range a comparison reads: the same length immediately before (whole months stay whole
 * months, so "last month" compares with the month before), or the same dates a year earlier.
 */
export function comparisonRange(
  range: BiDateRange,
  compare: "previous_period" | "previous_year",
): BiDateRange {
  if (compare === "previous_year") {
    // Shift the last day, not the exclusive end, so 28 Feb–1 Mar 2028 maps to 28 Feb–1 Mar 2027
    // and a day near 29 February never collapses to an empty range.
    const from = addMonths(range.from, -12);
    const to = addDays(addMonths(addDays(range.to, -1), -12), 1);
    return { from, to: to > from ? to : addDays(from, 1) };
  }
  const wholeMonths = range.from.endsWith("-01") && range.to.endsWith("-01");
  if (wholeMonths) {
    const months =
      (Number(range.to.slice(0, 4)) - Number(range.from.slice(0, 4))) * 12 +
      (Number(range.to.slice(5, 7)) - Number(range.from.slice(5, 7)));
    return { from: addMonths(range.from, -months), to: range.from };
  }
  const days = daysBetween(range.from, range.to);
  return { from: addDays(range.from, -days), to: range.from };
}

// ─── Checking a spec against the catalogue ───────────────────────────────────

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** The closest of `options` to `value`, if it is close enough to be a plausible typo. */
export function nearest(value: string, options: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const option of options) {
    const score = distance(value.toLowerCase(), option.toLowerCase());
    if (score < bestScore) {
      best = option;
      bestScore = score;
    }
  }
  return best !== undefined && bestScore <= Math.max(2, Math.floor(best.length / 3)) ? best : undefined;
}

function unknown(path: string, what: string, value: string, options: readonly string[]): BiIssue {
  const suggestion = nearest(value, options);
  return {
    path,
    message: `unknown ${what} '${value}'${suggestion ? `; did you mean '${suggestion}'?` : ""} Valid: ${options.join(", ")}`,
    ...(suggestion ? { suggestion } : {}),
  };
}

const VALUE_OPS: Record<BiDimension["type"], readonly BiFilterOp[]> = {
  category: ["eq", "neq", "in", "not_in", "is_null", "not_null"],
  reference: ["eq", "neq", "in", "not_in", "is_null", "not_null"],
  boolean: ["eq", "neq", "is_null", "not_null"],
  number: ["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "between", "is_null", "not_null"],
  date: ["eq", "gt", "gte", "lt", "lte", "between", "is_null", "not_null"],
};

function checkFilterValue(dim: BiDimension, filter: BiFilter, path: string): BiIssue | null {
  const { op, value } = filter;
  if (op === "is_null" || op === "not_null") {
    return value === undefined ? null : { path: `${path}.value`, message: `${op} takes no value` };
  }
  const list = op === "in" || op === "not_in";
  if (op === "between") {
    if (!Array.isArray(value) || value.length !== 2) {
      return { path: `${path}.value`, message: "between takes [low, high]" };
    }
  } else if (list) {
    if (!Array.isArray(value) || value.length === 0) {
      return { path: `${path}.value`, message: `${op} takes a non-empty list` };
    }
  } else if (value === undefined || Array.isArray(value)) {
    return { path: `${path}.value`, message: `${op} takes a single value` };
  }
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    const bad =
      dim.type === "date"
        ? typeof v !== "string" || !isCalendarDate(v)
        : dim.type === "number"
          ? typeof v !== "number"
          : dim.type === "boolean"
            ? typeof v !== "boolean"
            : dim.type === "reference"
              ? typeof v !== "string" || !UUID.test(v)
              : typeof v !== "string" && typeof v !== "number";
    if (bad) {
      const expected = {
        date: "real YYYY-MM-DD dates",
        number: "numbers",
        boolean: "true or false",
        reference: "record ids (UUIDs, as returned in <dim>__id)",
        category: "values",
      }[dim.type];
      return { path: `${path}.value`, message: `'${dim.id}' is a ${dim.type}: use ${expected}` };
    }
    if (dim.type === "category" && dim.values && !dim.values.includes(v as string | number)) {
      const suggestion = typeof v === "string" ? nearest(v, dim.values.map(String)) : undefined;
      return {
        path: `${path}.value`,
        message: `'${String(v)}' is not a value of '${dim.id}'${suggestion ? `; did you mean '${suggestion}'?` : ""} Valid: ${dim.values.join(", ")}`,
        ...(suggestion ? { suggestion } : {}),
      };
    }
  }
  return null;
}

/** Whether a filter pins a dimension to exactly one value. */
const pinsOne = (f: BiFilter) =>
  f.op === "eq" || (f.op === "in" && Array.isArray(f.value) && f.value.length === 1);

/**
 * Checks a structurally valid spec against a dataset (normally the viewer's visible view of it).
 * Returns every issue found, empty when the spec can run.
 */
export function checkBiQuery(spec: BiQuerySpec, dataset: BiDataset): BiIssue[] {
  const issues: BiIssue[] = [];
  const dims = new Map(dataset.dimensions.map((d) => [d.id, d]));
  const measures = new Map(dataset.measures.map((m) => [m.id, m]));
  const dimIds = [...dims.keys()];
  const measureIds = [...measures.keys()];

  const used: BiMeasure[] = [];
  spec.measures.forEach((id, i) => {
    const m = measures.get(id);
    if (!m) issues.push(unknown(`measures[${i}]`, "measure", id, measureIds));
    else used.push(m);
  });
  if (new Set(spec.measures).size !== spec.measures.length) {
    issues.push({ path: "measures", message: "a measure is listed twice" });
  }

  const grouped = new Set<string>();
  spec.groupBy.forEach((g, i) => {
    const dim = dims.get(g.dim);
    if (!dim) return issues.push(unknown(`groupBy[${i}].dim`, "dimension", g.dim, dimIds));
    if (grouped.has(g.dim))
      issues.push({ path: `groupBy[${i}].dim`, message: `'${g.dim}' is grouped twice` });
    grouped.add(g.dim);
    if (dim.type === "date" && !g.grain) {
      issues.push({
        path: `groupBy[${i}].grain`,
        message: `'${g.dim}' is a date: give a grain`,
        suggestion: "month",
      });
    }
    if (dim.type !== "date" && g.grain) {
      issues.push({ path: `groupBy[${i}].grain`, message: `'${g.dim}' is not a date, so it takes no grain` });
    }
  });

  spec.filters.forEach((f, i) => {
    const dim = dims.get(f.dim);
    if (!dim) return issues.push(unknown(`filters[${i}].dim`, "dimension", f.dim, dimIds));
    if (!VALUE_OPS[dim.type].includes(f.op)) {
      issues.push({
        path: `filters[${i}].op`,
        message: `'${f.op}' does not apply to ${dim.type} '${dim.id}'. Valid: ${VALUE_OPS[dim.type].join(", ")}`,
      });
      return;
    }
    const valueIssue = checkFilterValue(dim, f, `filters[${i}]`);
    if (valueIssue) issues.push(valueIssue);
  });

  const dateDims = dataset.dimensions.filter((d) => d.type === "date").map((d) => d.id);
  const periodDim = spec.period?.dim ?? dataset.defaultDate;
  if (spec.period) {
    const dim = dims.get(periodDim);
    if (!dim) issues.push(unknown("period.dim", "date dimension", periodDim, dateDims));
    else if (dim.type !== "date") {
      issues.push({
        path: "period.dim",
        message: `'${periodDim}' is not a date. Valid: ${dateDims.join(", ")}`,
      });
    }
  }

  if (spec.compare) {
    if (!spec.period) issues.push({ path: "compare", message: "a comparison needs a period" });
    else if (!spec.period.preset && !(spec.period.from && spec.period.to)) {
      issues.push({ path: "compare", message: "a comparison needs a preset or both from and to" });
    } else if (grouped.has(periodDim)) {
      issues.push({
        path: "compare",
        message: `a comparison can't group by the period's own date ('${periodDim}'); use a trend instead`,
      });
    }
  }

  // Splits (currency, units): a sum only means something within one value.
  used.forEach((m) => {
    if (!m.splitBy?.length) return;
    const ok = m.splitBy.some((d) => grouped.has(d) || spec.filters.some((f) => f.dim === d && pinsOne(f)));
    if (!ok) {
      const what = m.unit === "money" ? "amounts in different currencies" : "quantities in different units";
      issues.push({
        path: `measures[${spec.measures.indexOf(m.id)}]`,
        message: `'${m.id}' would add up ${what}: group by or filter to one ${m.splitBy.map((d) => `'${d}'`).join(" or ")}`,
        suggestion: m.splitBy[0],
      });
    }
  });

  const sortable = [
    ...spec.measures,
    ...(spec.compare ? spec.measures.map((m) => `${m}__compare`) : []),
    ...grouped,
  ];
  spec.sort.forEach((s, i) => {
    if (!sortable.includes(s.by)) issues.push(unknown(`sort[${i}].by`, "sort field", s.by, sortable));
  });

  issues.push(...checkBiMetricQuery(spec, dataset));
  return issues;
}
