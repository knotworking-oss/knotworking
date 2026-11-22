import {
  BI_CATALOGUE_VERSION,
  biDataset,
  biQuerySpecSchema,
  checkBiQuery,
  comparisonRange,
  nearest,
  resolveBiPeriod,
  type BiDataset,
  type BiDateRange,
  type BiDimensionType,
  type BiGrain,
  type BiIssue,
  type BiQuerySpec,
  type BiUnit,
} from "@knotworking/core";
import type { Database } from "@knotworking/db";
import { ApiError } from "../../errors";
import { visibleCatalogue, visibleDataset, type BiViewer } from "./access";
import { compileBiQuery, type CompiledColumn } from "./compile";
import { runAnalyticQuery } from "./guard";
import { cachedBiResult } from "./cache";
import { runCertifiedQuery } from "./metrics";

/** The workspace facts a query needs, read once per request. */
export interface BiWorkspace {
  id: string;
  timeZone: string;
  currency: string;
  financialYearStartMonth: number;
  /** Today in the workspace zone. */
  today: string;
}

export type BiValue = string | number | boolean | null;

export interface BiResultColumn {
  key: string;
  label: string;
  kind: "dimension" | "measure";
  /** Dimensions: their type; for `reference`, `idKey` holds the record's id for drill-through. */
  type?: BiDimensionType;
  idKey?: string;
  grain?: BiGrain;
  /** Category dimensions: every value it can take, in catalogue order (stable chart colours). */
  values?: readonly (string | number)[];
  /** Measures: what the number is. */
  unit?: BiUnit;
  /** The comparison column (`<key>__compare`), when the query compares periods. */
  compareKey?: string;
}

export interface BiQueryResult {
  dataset: string;
  catalogueVersion: number;
  columns: BiResultColumn[];
  rows: Record<string, BiValue>[];
  /** More rows matched than the limit; only the first ones are returned. */
  truncated: boolean;
  period: (BiDateRange & { dim: string }) | null;
  comparePeriod: BiDateRange | null;
  /** The comparison period had more groups than could be read; some `__compare` values are missing. */
  compareTruncated: boolean;
  /**
   * The currency of `money` measures: the workspace's; for a dataset with its own currencies, the
   * one a filter pins, else `null` (then each row carries its currency dimension).
   */
  currency: string | null;
}

/** Default rows a query returns. */
const DEFAULT_LIMIT = 1000;
/** Groups read for a comparison (and for sorting by one). */
const COMPARE_ROW_CAP = 5000;

/** The one value a filter pins a dimension to (`eq`, or `in` with one value), if any. */
function pinnedValue(spec: BiQuerySpec, dim: string): string | null {
  const f = spec.filters.find(
    (x) =>
      x.dim === dim && (x.op === "eq" || (x.op === "in" && Array.isArray(x.value) && x.value.length === 1)),
  );
  const value = f ? (Array.isArray(f.value) ? f.value[0] : f.value) : undefined;
  return typeof value === "string" ? value : null;
}

/** Orders rows by a sort list as SQL would: nulls last in both directions, ties by the next key. */
function compareRows(
  a: Record<string, BiValue>,
  b: Record<string, BiValue>,
  sort: BiQuerySpec["sort"],
): number {
  for (const { by, dir } of sort) {
    const x = a[by] ?? null;
    const y = b[by] ?? null;
    if (x === y) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    const order = x < y ? -1 : 1;
    return dir === "asc" ? order : -order;
  }
  return 0;
}

const invalid = (issues: BiIssue[]) =>
  new ApiError(400, "invalid_query", `${issues[0]!.path}: ${issues[0]!.message}`, { issues });

/** Parses a spec, refusing anything structurally wrong with paths an agent can act on. */
export function parseBiQuerySpec(input: unknown): BiQuerySpec {
  const parsed = biQuerySpecSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw invalid(
    parsed.error.issues.map((i) => ({
      path:
        i.path
          .map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))
          .join("")
          .replace(/^\./, "") || "spec",
      message: i.message,
    })),
  );
}

/**
 * The dataset as this viewer may use it. Refuses an unknown dataset (400, with the nearest visible
 * one), a dataset of a module the viewer can't read (403), and any field they may not use (403).
 */
function datasetFor(spec: BiQuerySpec, viewer: BiViewer): BiDataset {
  const full = biDataset(spec.dataset);
  if (!full) {
    const visible = visibleCatalogue(viewer).map((d) => d.id);
    const suggestion = nearest(spec.dataset, visible);
    throw invalid([
      {
        path: "dataset",
        message: `unknown dataset '${spec.dataset}'${suggestion ? `; did you mean '${suggestion}'?` : ""} Valid: ${visible.join(", ")}`,
        ...(suggestion ? { suggestion } : {}),
      },
    ]);
  }
  const visible = visibleDataset(full, viewer);
  if (!visible) {
    throw new ApiError(
      403,
      "module_forbidden",
      `You don't have access to the ${full.module} module in this workspace`,
    );
  }
  const fullIds = new Set([...full.dimensions, ...full.measures].map((f) => f.id));
  const visibleIds = new Set([...visible.dimensions, ...visible.measures].map((f) => f.id));
  const referenced = [
    ...spec.measures,
    ...spec.groupBy.map((g) => g.dim),
    ...spec.filters.map((f) => f.dim),
    ...(spec.period?.dim ? [spec.period.dim] : []),
  ];
  const forbidden = [...new Set(referenced.filter((id) => fullIds.has(id) && !visibleIds.has(id)))];
  if (forbidden.length) {
    throw new ApiError(
      403,
      "bi_field_forbidden",
      `You don't have access to ${forbidden.map((f) => `'${f}'`).join(", ")} in ${full.id}: it needs a module you can't read`,
      { fields: forbidden },
    );
  }
  return visible;
}

const toNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function shapeRow(row: Record<string, unknown>, columns: CompiledColumn[]): Record<string, BiValue> {
  const out: Record<string, BiValue> = {};
  for (const c of columns) {
    if (c.kind === "measure") {
      out[c.key] = toNumber(row[c.key]);
      continue;
    }
    if (c.idKey) out[c.idKey] = (row[c.idKey] as string | null) ?? null;
    const v = row[c.key];
    out[c.key] =
      v === null || v === undefined
        ? null
        : c.dimension?.type === "number"
          ? Number(v)
          : typeof v === "boolean" || typeof v === "number"
            ? v
            : String(v);
  }
  return out;
}

/**
 * Runs a query spec as the viewer: checks access and the spec, compiles it, runs it under the
 * analytic guard, and (with `compare`) runs the comparison period and joins it on the group keys.
 */
export async function runBiQuery(
  db: Database,
  workspace: BiWorkspace,
  viewer: BiViewer,
  input: unknown,
): Promise<BiQueryResult> {
  const spec = parseBiQuerySpec(input);
  const dataset = datasetFor(spec, viewer);
  const issues = checkBiQuery(spec, dataset);
  if (issues.length) throw invalid(issues);
  return cachedBiResult(db, workspace, viewer, spec, () =>
    // Certified metrics are computed by their module's services, never compiled to SQL.
    dataset.virtual
      ? runCertifiedQuery(db, workspace, dataset, spec)
      : compileAndRun(db, workspace, dataset, spec),
  );
}

/** Compiles a checked spec and runs it under the guard, with the comparison period when asked. */
async function compileAndRun(
  db: Database,
  workspace: BiWorkspace,
  dataset: BiDataset,
  spec: BiQuerySpec,
): Promise<BiQueryResult> {
  let period: BiQueryResult["period"] = null;
  if (spec.period) {
    const dim = spec.period.dim ?? dataset.defaultDate;
    const range = spec.period.preset
      ? resolveBiPeriod(spec.period.preset, workspace.today, workspace.financialYearStartMonth)
      : { from: spec.period.from ?? "0001-01-01", to: spec.period.to ?? "9999-12-31" };
    period = { dim, ...range };
  }
  const limit = spec.limit ?? DEFAULT_LIMIT;
  const ctx = {
    workspaceId: workspace.id,
    timeZone: workspace.timeZone,
    financialYearStartMonth: workspace.financialYearStartMonth,
  };

  const main = compileBiQuery(dataset, spec, {
    ...ctx,
    period: period ? { dim: period.dim, range: period } : undefined,
  });
  // Sorting by a comparison column can only happen once both periods are merged, so then every
  // group is fetched (up to the comparison cap), sorted here and only then cut to the limit.
  const sortsOnCompare = spec.sort.some((s) => s.by.endsWith("__compare"));
  const result = await runAnalyticQuery<Record<string, unknown>>(db, main.build, {
    rowCap: sortsOnCompare ? COMPARE_ROW_CAP : limit,
  });
  let rows = result.rows.map((r) => shapeRow(r, main.columns));
  let truncated = result.truncated;
  let compareTruncated = false;

  let comparePeriod: BiDateRange | null = null;
  if (spec.compare && period) {
    comparePeriod = comparisonRange(period, spec.compare);
    const previous = compileBiQuery(
      dataset,
      { ...spec, sort: [] },
      {
        ...ctx,
        period: { dim: period.dim, range: comparePeriod },
      },
    );
    // The comparison is looked up per row, so it may need every group, not only the top ones.
    const before = await runAnalyticQuery<Record<string, unknown>>(db, previous.build, {
      rowCap: COMPARE_ROW_CAP,
    });
    // Groups past the cap would read as "no data" in the earlier period; say so instead.
    compareTruncated = before.truncated;
    const dimKeys = main.columns.filter((c) => c.kind === "dimension").map((c) => c.idKey ?? c.key);
    const keyOf = (row: Record<string, BiValue>) => JSON.stringify(dimKeys.map((k) => row[k] ?? null));
    const lookup = new Map(
      before.rows.map((r) => {
        const shaped = shapeRow(r, previous.columns);
        return [keyOf(shaped), shaped];
      }),
    );
    for (const row of rows) {
      const match = lookup.get(keyOf(row));
      for (const m of spec.measures) row[`${m}__compare`] = match ? (match[m] ?? null) : null;
    }
  }
  if (sortsOnCompare) {
    rows.sort((a, b) => compareRows(a, b, spec.sort));
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      truncated = true;
    }
  }

  const columns: BiResultColumn[] = main.columns.map((c) =>
    c.kind === "measure"
      ? {
          key: c.key,
          label: c.measure!.label,
          kind: "measure",
          unit: c.measure!.unit,
          ...(spec.compare ? { compareKey: `${c.key}__compare` } : {}),
        }
      : {
          key: c.key,
          label: c.dimension!.label,
          kind: "dimension",
          type: c.dimension!.type,
          ...(c.idKey ? { idKey: c.idKey } : {}),
          ...(c.grain ? { grain: c.grain } : {}),
          ...(c.dimension!.values ? { values: c.dimension!.values } : {}),
        },
  );

  return {
    dataset: dataset.id,
    catalogueVersion: BI_CATALOGUE_VERSION,
    columns,
    rows,
    truncated,
    period,
    comparePeriod,
    compareTruncated,
    currency: dataset.currencyDimension ? pinnedValue(spec, dataset.currencyDimension) : workspace.currency,
  };
}

/** The viewer's catalogue as the API returns it (no table or column names). */
export function describeCatalogue(viewer: BiViewer) {
  return {
    catalogueVersion: BI_CATALOGUE_VERSION,
    datasets: visibleCatalogue(viewer).map((d) => ({
      id: d.id,
      label: d.label,
      description: d.description,
      grain: d.grain,
      module: d.module,
      defaultDate: d.defaultDate,
      currency: d.currencyDimension ? { dimension: d.currencyDimension } : "workspace",
      dimensions: d.dimensions.map((dim) => ({
        id: dim.id,
        label: dim.label,
        type: dim.type,
        ...(dim.description ? { description: dim.description } : {}),
        ...(dim.values ? { values: dim.values } : {}),
      })),
      measures: d.measures.map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        aggregate: m.agg,
        unit: m.unit,
        ...(m.splitBy ? { splitBy: m.splitBy } : {}),
        ...(m.certified ? { certified: m.certified } : {}),
      })),
    })),
  };
}
