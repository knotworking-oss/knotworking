import { formatMinutes, formatMoney, type BiGrain, type BiUnit } from "@knotworking/core";

/**
 * Shaping and formatting for dashboard widgets. Pure functions (no React), shared by the viewer,
 * the CSV export and `/design`, and unit-tested in `bi-format.test.ts`.
 */

export type BiCell = string | number | boolean | null;
export type BiRow = Record<string, BiCell>;

export interface BiColumn {
  key: string;
  label: string;
  kind: "dimension" | "measure";
  type?: "category" | "date" | "number" | "boolean" | "reference";
  idKey?: string;
  grain?: BiGrain;
  /** Category dimensions: their values in catalogue order. */
  values?: readonly (string | number)[];
  unit?: BiUnit;
  compareKey?: string;
}

export interface BiResult {
  dataset: string;
  columns: BiColumn[];
  rows: BiRow[];
  truncated: boolean;
  period: { dim: string; from: string; to: string } | null;
  comparePeriod: { from: string; to: string } | null;
  compareTruncated?: boolean;
  currency: string | null;
}

/** Categorical series slots (`--chart-1` … `--chart-5`), assigned in order, never cycled. */
export const SERIES_SLOTS = 5;
export const OTHER = "Other";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "in_progress" → "In progress". */
export const humanize = (value: string) => {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** A date bucket's start (`YYYY-MM-DD`) as a label for its grain. */
export function formatBucket(date: string, grain: BiGrain = "day"): string {
  const year = date.slice(0, 4);
  const month = MONTHS[Number(date.slice(5, 7)) - 1] ?? "";
  const day = String(Number(date.slice(8, 10)));
  switch (grain) {
    case "day":
      return `${day} ${month} ${year}`;
    case "week":
      return `w/c ${day} ${month} ${year}`;
    case "month":
      return `${month} ${year}`;
    case "quarter":
    case "financial_quarter":
      return `Qtr from ${month} ${year}`;
    case "year":
      return year;
    case "financial_year":
      return date.slice(5) === "01-01" ? year : `FY from ${month} ${year}`;
  }
}

/** A dimension value as people read it. */
export function formatDimension(column: BiColumn, value: BiCell): string {
  if (value === null || value === "") return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (column.type === "date" && typeof value === "string") return formatBucket(value, column.grain);
  if (column.type === "category" && typeof value === "string") return humanize(value);
  return String(value);
}

const integer = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });

/** A measure value with its unit: money in its currency, minutes as hours and minutes. */
export function formatMeasure(unit: BiUnit | undefined, value: BiCell, currency: string | null): string {
  if (value === null || typeof value !== "number") return "–";
  switch (unit) {
    case "money":
      return currency ? formatMoney(value, currency, { maxDecimals: 2 }) : decimal.format(value);
    case "minutes":
      return formatMinutes(Math.round(value));
    case "count":
      return integer.format(value);
    case "percent":
      return `${percentFormat.format(value)}%`;
    case "per_million":
      return `${percentFormat.format(value)} per million`;
    default:
      return decimal.format(value);
  }
}

const percentFormat = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });

/** A short axis label: £24k, 1.2M, 12h. Full values stay in tooltips and tables. */
export function formatAxis(unit: BiUnit | undefined, value: number, currency: string | null): string {
  if (unit === "minutes") return `${decimal.format(Math.round((value / 60) * 10) / 10)}h`;
  if (unit === "percent") return `${percentFormat.format(value)}%`;
  const options: Intl.NumberFormatOptions = {
    notation: "compact",
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  };
  if (unit === "money" && currency)
    return new Intl.NumberFormat("en-GB", { ...options, style: "currency", currency }).format(value);
  return new Intl.NumberFormat("en-GB", options).format(value);
}

/** The currency of one row: the dataset's own currency column, else the workspace's. */
export const rowCurrency = (result: BiResult, row: BiRow, workspaceCurrency: string): string | null =>
  result.currency ?? (typeof row.currency === "string" ? row.currency : null) ?? workspaceCurrency;

/** Change from the comparison value, as a fraction (0.12 = +12%), or null when it can't be computed. */
export function delta(current: BiCell, previous: BiCell): number | null {
  if (typeof current !== "number" || typeof previous !== "number" || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

export interface ChartSeries {
  key: string;
  label: string;
  /** `var(--chart-n)`; "Other" takes the last slot. */
  color: string;
}

export interface ChartData {
  /** One entry per x value: `x` holds the label, each series key its value. */
  points: Array<Record<string, string | number | null>>;
  series: ChartSeries[];
  /** The x dimension (for labels and drill-through), if any. */
  xColumn?: BiColumn;
  measure: BiColumn;
  /** Series were folded into "Other" to stay within the palette. */
  folded: boolean;
}

const slot = (i: number) => `var(--chart-${i + 1})`;

/**
 * Colour slots for series, following the entity and never its rank, so a filter that changes the
 * totals doesn't repaint anything. A category with at most five catalogue values gives each value
 * its own slot (a state is always the same colour); otherwise the series shown take slots in
 * alphabetical order. "Other" always takes the last slot.
 */
function assignSlots(column: BiColumn, names: string[], reserveOther = false): Map<string, number> {
  const fixed =
    column.values && column.values.length <= SERIES_SLOTS
      ? column.values.map((v) => formatDimension(column, v))
      : [];
  const reserved = reserveOther ? SERIES_SLOTS - 1 : -1;
  const slots = new Map<string, number>();
  const taken = new Set<number>([reserved]);
  // Catalogue values keep their own slot; anything else ("None", a value not listed) takes a
  // free slot in alphabetical order, so no two series ever share a colour.
  for (const name of names) {
    const i = fixed.indexOf(name);
    if (i !== -1 && !taken.has(i)) {
      slots.set(name, i);
      taken.add(i);
    }
  }
  // Free slots: first those no catalogue value owns, then those of catalogue values not shown.
  const all = Array.from({ length: SERIES_SLOTS }, (_, i) => i).filter((i) => !taken.has(i));
  const free = [...all.filter((i) => i >= fixed.length), ...all.filter((i) => i < fixed.length)];
  for (const name of [...names].filter((n) => !slots.has(n)).sort((a, b) => a.localeCompare(b))) {
    slots.set(name, free.shift() ?? SERIES_SLOTS - 1);
  }
  return slots;
}

/**
 * Turns a result into chart points. One grouping: x is that dimension, series are the measures.
 * Two groupings: x is `display.x` (else the first), series are the other dimension's values for
 * the first measure. More series than palette slots fold into "Other" (largest totals keep their
 * own colour), never a generated hue.
 */
export function chartData(result: BiResult, display: { x?: string; series?: string } = {}): ChartData {
  const dims = result.columns.filter((c) => c.kind === "dimension");
  const measures = result.columns.filter((c) => c.kind === "measure");
  const measure = measures[0]!;
  const xColumn = dims.find((d) => d.key === display.x) ?? dims[0];
  const seriesColumn =
    dims.find((d) => d.key === display.series && d !== xColumn) ?? dims.find((d) => d !== xColumn);

  if (!xColumn) {
    return { points: [], series: [], measure, folded: false };
  }
  const xLabel = (row: BiRow) => formatDimension(xColumn, row[xColumn.key] ?? null);

  if (!seriesColumn) {
    const series = measures
      .slice(0, SERIES_SLOTS)
      .map((m, i) => ({ key: m.key, label: m.label, color: slot(i) }));
    const points = result.rows.map((row) => ({
      x: xLabel(row),
      ...Object.fromEntries(
        series.map((s) => [s.key, typeof row[s.key] === "number" ? (row[s.key] as number) : null]),
      ),
    }));
    return { points, series, xColumn, measure, folded: measures.length > SERIES_SLOTS };
  }

  // Series from the second dimension: keep the largest, fold the rest into "Other".
  const totals = new Map<string, number>();
  for (const row of result.rows) {
    const name = formatDimension(seriesColumn, row[seriesColumn.key] ?? null);
    totals.set(
      name,
      (totals.get(name) ?? 0) + (typeof row[measure.key] === "number" ? (row[measure.key] as number) : 0),
    );
  }
  const names = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)!);
  const folded = names.length > SERIES_SLOTS;
  // The largest keep their own colour; which colour follows the entity, not the size.
  const kept = folded ? names.slice(0, SERIES_SLOTS - 1) : names;
  const slots = assignSlots(seriesColumn, kept, folded);
  const ordered = [...kept].sort((a, b) => slots.get(a)! - slots.get(b)!);
  const keyOf = new Map(ordered.map((name, i) => [name, `s${i}`]));
  const series: ChartSeries[] = ordered.map((name, i) => ({
    key: `s${i}`,
    label: name,
    color: slot(slots.get(name)!),
  }));
  if (folded) series.push({ key: "other", label: OTHER, color: slot(SERIES_SLOTS - 1) });

  const byX = new Map<string, Record<string, string | number | null>>();
  for (const row of result.rows) {
    const x = xLabel(row);
    const point = byX.get(x) ?? { x };
    byX.set(x, point);
    const name = formatDimension(seriesColumn, row[seriesColumn.key] ?? null);
    const key = keyOf.get(name) ?? "other";
    const value = typeof row[measure.key] === "number" ? (row[measure.key] as number) : 0;
    point[key] = ((point[key] as number | null | undefined) ?? 0) + value;
  }
  return { points: [...byX.values()], series, xColumn, measure, folded };
}

/** Donut slices: the first grouping's values for the first measure, folded to the palette. */
export function donutData(result: BiResult) {
  const dim = result.columns.find((c) => c.kind === "dimension");
  const measure = result.columns.find((c) => c.kind === "measure")!;
  const slices = result.rows
    .map((row) => ({
      name: dim ? formatDimension(dim, row[dim.key] ?? null) : measure.label,
      value: typeof row[measure.key] === "number" ? (row[measure.key] as number) : 0,
    }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  const kept = slices.length > SERIES_SLOTS ? slices.slice(0, SERIES_SLOTS - 1) : slices;
  const rest = slices.slice(kept.length);
  const slots = dim
    ? assignSlots(
        dim,
        kept.map((s) => s.name),
        rest.length > 0,
      )
    : new Map([[measure.label, 0]]);
  const out = kept.map((s, i) => ({ ...s, key: `s${i}`, color: slot(slots.get(s.name) ?? i) }));
  if (rest.length) {
    out.push({
      name: OTHER,
      value: rest.reduce((sum, s) => sum + s.value, 0),
      key: "other",
      color: slot(SERIES_SLOTS - 1),
    });
  }
  return { slices: out, measure };
}

/** A pivot: rows by the first grouping, columns by the second, cells the first measure. */
export function pivotData(result: BiResult) {
  const dims = result.columns.filter((c) => c.kind === "dimension");
  const measure = result.columns.find((c) => c.kind === "measure")!;
  const [rowDim, colDim] = dims;
  if (!rowDim || !colDim) return null;
  const rowLabels: string[] = [];
  const colLabels: string[] = [];
  const rawOf = new Map<string, string>();
  const cells = new Map<string, number>();
  for (const row of result.rows) {
    const r = formatDimension(rowDim, row[rowDim.key] ?? null);
    const c = formatDimension(colDim, row[colDim.key] ?? null);
    if (!rowLabels.includes(r)) rowLabels.push(r);
    if (!colLabels.includes(c)) colLabels.push(c);
    rawOf.set(c, String(row[colDim.key] ?? ""));
    const value = typeof row[measure.key] === "number" ? (row[measure.key] as number) : 0;
    cells.set(`${r}\u0000${c}`, (cells.get(`${r}\u0000${c}`) ?? 0) + value);
  }
  // Dates run in time order: sort on the raw YYYY-MM-DD, not the label ("Apr" before "Dec").
  if (colDim.type === "date") colLabels.sort((a, b) => rawOf.get(a)!.localeCompare(rawOf.get(b)!));
  return {
    rowDim,
    colDim,
    measure,
    rowLabels,
    colLabels,
    cell: (r: string, c: string) => cells.get(`${r}\u0000${c}`) ?? null,
  };
}

/** A result as CSV rows: a header of labels, then dimension labels and raw measure numbers. */
export function resultCsv(result: BiResult): Array<Array<string | number | null>> {
  const header = result.columns.flatMap((c) =>
    c.compareKey ? [c.label, `${c.label} (comparison)`] : [c.label],
  );
  const body = result.rows.map((row) =>
    result.columns.flatMap((c): Array<string | number | null> => {
      if (c.kind === "dimension") return [formatDimension(c, row[c.key] ?? null)];
      const value = typeof row[c.key] === "number" ? (row[c.key] as number) : null;
      if (!c.compareKey) return [value];
      const previous = row[c.compareKey];
      return [value, typeof previous === "number" ? previous : null];
    }),
  );
  return [header, ...body];
}

/** Where a dataset's records live in the app, for "open in module" links. */
export const DATASET_PAGES: Record<string, string> = {
  stock_movements: "stock",
  stock_lots: "stock/lots",
  purchase_orders: "purchasing",
  purchase_invoices: "purchasing/invoices",
  sales_orders: "sales",
  production_batches: "production",
  quality_complaints: "quality/complaints",
  quality_nonconformances: "quality/nonconformances",
  haccp_corrective_actions: "haccp",
  training_records: "training",
  tasks: "my-tasks",
  time_entries: "time",
};

/** Detail pages for reference dimensions that have one (`<dim>__id` → page). */
export const REFERENCE_PAGES: Record<string, string> = {
  project: "projects",
};

/** Says that a copy of a dashboard left out widgets on data the person can't read. */
export const omittedNotice = (n: number) =>
  `${n === 1 ? "One widget was" : `${n} widgets were`} left out: ${n === 1 ? "it uses" : "they use"} data you can't read.`;
