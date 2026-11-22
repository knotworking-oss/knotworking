import type {
  BiColumnRef,
  BiCondition,
  BiDataset,
  BiDateRange,
  BiDimension,
  BiFilter,
  BiGrain,
  BiMeasure,
  BiQuerySpec,
} from "@knotworking/core";
import { QUANTITY_DECIMALS, unitCodes, units, type UnitCode } from "@knotworking/core";
import { sql, type SQL } from "drizzle-orm";
import { requireTable } from "./registry";

/**
 * Compiles a checked query spec (`checkBiQuery`) into one parameterised SQL statement. Identifiers
 * come only from the catalogue (and exist in the Drizzle schema); every value is a bind parameter.
 * The statement always:
 *  - restricts the base table and every joined workspace table to the caller's workspace;
 *  - excludes soft-deleted rows of the base table and of `parent` joins;
 *  - joins only through the dataset's declared joins, and only those the query uses.
 */
export interface CompileContext {
  workspaceId: string;
  timeZone: string;
  financialYearStartMonth: number;
  /** The resolved period, if any, on `periodDim`. */
  period?: { dim: string; range: BiDateRange };
}

export interface CompiledColumn {
  key: string;
  kind: "dimension" | "measure";
  /** For reference dimensions, the key holding the id (`<dim>__id`). */
  idKey?: string;
  dimension?: BiDimension;
  measure?: BiMeasure;
  grain?: BiGrain;
}

export interface CompiledQuery {
  /** The statement, given the number of rows to return at most. */
  build: (limit: number) => SQL;
  columns: CompiledColumn[];
}

const BASE = "t";
const alias = (join?: string) => sql.identifier(join ? `j_${join}` : BASE);
const col = (ref: BiColumnRef) => sql`${alias(ref.join)}.${sql.identifier(ref.column)}`;

function conditionSql(c: BiCondition): SQL {
  const target = col(c);
  switch (c.op) {
    case "is_null":
      return sql`${target} is null`;
    case "not_null":
      return sql`${target} is not null`;
    case "eq":
      return sql`${target} = ${c.value}`;
    case "neq":
      // `<>` alone drops nulls; a "not closed" count should keep rows with no status yet.
      return sql`${target} is distinct from ${c.value}`;
    case "gt":
      return sql`${target} > ${c.value}`;
    case "lt":
      return sql`${target} < ${c.value}`;
    case "in":
    case "not_in": {
      const values = sql.join(
        (c.value as readonly string[]).map((v) => sql`${v}`),
        sql`, `,
      );
      // `not in` alone drops nulls; keep them, as `neq` does.
      return c.op === "in"
        ? sql`${target} in (${values})`
        : sql`(${target} not in (${values}) or ${target} is null)`;
    }
  }
}

/** Every condition must hold. */
const allOf = (conditions: readonly BiCondition[]) => sql.join(conditions.map(conditionSql), sql` and `);

/**
 * `factor` and `dimension` of every unit, as SQL CASE expressions over a unit column. Built from the
 * core `units` table, so SQL converts exactly as `convertQuantity` does.
 */
const unitCase = (unit: SQL, pick: (u: (typeof units)[UnitCode]) => string | number) =>
  sql`(case ${unit} ${sql.join(
    unitCodes.map((code) => sql`when ${code} then ${pick(units[code])}`),
    sql` `,
  )} end)`;

/**
 * A quantity held in the item's base unit, expressed in another unit (`convertQuantity(base,
 * baseUnit, unit, item)`): divided by the unit's factor, and across dimensions through grams (the
 * item's density or unit weight). Null when the item can't bridge the dimensions.
 */
function convertedQuantity(m: BiMeasure & { convert: NonNullable<BiMeasure["convert"]> }): SQL {
  const target = col(m.convert.unit);
  const itemUnit = col({ join: m.convert.itemJoin, column: "unit" });
  const targetDim = sql`${unitCase(target, (u) => u.dimension)}::text`;
  const baseDim = sql`${unitCase(itemUnit, (u) => u.dimension)}::text`;
  const gramsPer = (dim: SQL) =>
    sql`(case ${dim} when 'mass' then 1::numeric when 'volume' then ${col({ join: m.convert.itemJoin, column: "density_g_per_ml" })} when 'count' then ${col({ join: m.convert.itemJoin, column: "unit_weight_g" })} end)`;
  const bridge = sql`(case when ${baseDim} = ${targetDim} then 1::numeric else ${gramsPer(baseDim)} / nullif(${gramsPer(targetDim)}, 0) end)`;
  // Rounded to the ledger's precision, as the purchasing service rounds before pricing.
  return sql`round(${col(m.of!)} * ${bridge} / ${unitCase(target, (u) => u.toBase)}::numeric, ${QUANTITY_DECIMALS})`;
}

/** A date dimension as a `date` value: timestamps are read in the workspace zone. */
function dateExpr(dim: BiDimension, ctx: CompileContext): SQL {
  return dim.instant ? sql`(${col(dim)} at time zone ${ctx.timeZone})::date` : sql`${col(dim)}`;
}

function bucket(expr: SQL, grain: BiGrain, ctx: CompileContext): SQL {
  const shift = sql`make_interval(months => ${ctx.financialYearStartMonth - 1})`;
  switch (grain) {
    case "day":
      return expr;
    case "week":
    case "month":
    case "quarter":
    case "year":
      return sql`date_trunc(${grain}, ${expr})::date`;
    case "financial_quarter":
      return sql`(date_trunc('quarter', ${expr} - ${shift}) + ${shift})::date`;
    case "financial_year":
      return sql`(date_trunc('year', ${expr} - ${shift}) + ${shift})::date`;
  }
}

/** A category with a `map` reports the mapped value (an item's unit → its base unit). */
function categoryExpr(dim: BiDimension): SQL {
  if (!dim.map) return col(dim);
  const entries = Object.entries(dim.map);
  return sql`(case ${col(dim)} ${sql.join(
    entries.map(([from, to]) => sql`when ${from} then ${to}`),
    sql` `,
  )} else ${col(dim)}::text end)`;
}

/** The value a filter compares: the date in the workspace zone, a mapped category, or the column (a reference's id). */
const filterTarget = (dim: BiDimension, ctx: CompileContext) =>
  dim.type === "date" ? dateExpr(dim, ctx) : dim.type === "category" ? categoryExpr(dim) : col(dim);

function filterSql(dim: BiDimension, f: BiFilter, ctx: CompileContext): SQL {
  const target = filterTarget(dim, ctx);
  const param = (v: unknown) => (dim.type === "date" ? sql`${v}::date` : sql`${v}`);
  const value = f.value;
  switch (f.op) {
    case "is_null":
      return sql`${target} is null`;
    case "not_null":
      return sql`${target} is not null`;
    case "eq":
      return sql`${target} = ${param(value)}`;
    case "neq":
      return sql`${target} is distinct from ${param(value)}`;
    case "gt":
      return sql`${target} > ${param(value)}`;
    case "gte":
      return sql`${target} >= ${param(value)}`;
    case "lt":
      return sql`${target} < ${param(value)}`;
    case "lte":
      return sql`${target} <= ${param(value)}`;
    case "between": {
      const [low, high] = value as [unknown, unknown];
      return sql`${target} between ${param(low)} and ${param(high)}`;
    }
    case "in":
    case "not_in": {
      const list = sql.join(
        (value as unknown[]).map((v) => param(v)),
        sql`, `,
      );
      // `not in` alone drops nulls; keep them, as `neq` does.
      return f.op === "in"
        ? sql`${target} in (${list})`
        : sql`(${target} not in (${list}) or ${target} is null)`;
    }
  }
}

function measureSql(m: BiMeasure): SQL {
  const filter = m.where?.length ? sql` filter (where ${allOf(m.where)})` : sql``;
  const quantity =
    m.convert && m.of ? convertedQuantity({ ...m, convert: m.convert }) : m.of ? col(m.of) : undefined;
  const value = quantity && m.times ? sql`(${quantity} * ${col(m.times)})` : quantity;
  switch (m.agg) {
    case "count":
      return sql`count(*)${filter}`;
    case "count_distinct":
      return sql`count(distinct ${value})${filter}`;
    case "sum":
      // An empty period sums to 0, not "no data".
      return sql`coalesce(sum(${value})${filter}, 0)`;
    case "avg":
    case "min":
    case "max":
      return sql`${sql.raw(m.agg)}(${value})${filter}`;
    case "certified":
      // Certified metrics are computed by services (services/bi/metrics.ts), never in SQL.
      throw new Error(`Measure ${m.id} is a certified metric and can't be compiled`);
  }
}

/** The joins needed for a set of fields, parents before the joins that go through them. */
function orderedJoins(dataset: BiDataset, needed: Iterable<string>): string[] {
  const out: string[] = [];
  const visit = (name: string) => {
    if (out.includes(name)) return;
    const join = dataset.joins[name];
    if (!join) throw new Error(`Dataset ${dataset.id} has no join "${name}"`);
    if (join.fromJoin) visit(join.fromJoin);
    out.push(name);
  };
  for (const name of needed) visit(name);
  return out;
}

const refJoins = (refs: Array<BiColumnRef | undefined>) => refs.flatMap((r) => (r?.join ? [r.join] : []));

export function compileBiQuery(dataset: BiDataset, spec: BiQuerySpec, ctx: CompileContext): CompiledQuery {
  const dims = new Map(dataset.dimensions.map((d) => [d.id, d]));
  const measures = spec.measures.map((id) => dataset.measures.find((m) => m.id === id)!);
  const grouped = spec.groupBy.map((g) => ({ dim: dims.get(g.dim)!, grain: g.grain }));
  const filters = spec.filters.map((f) => ({ dim: dims.get(f.dim)!, filter: f }));
  const periodDim = ctx.period ? dims.get(ctx.period.dim)! : undefined;

  const base = requireTable(dataset.table);
  const joins = orderedJoins(dataset, [
    // A row belongs to its parent, so a soft-deleted parent hides it whatever the query reads.
    ...Object.entries(dataset.joins).flatMap(([name, join]) => (join.kind === "parent" ? [name] : [])),
    ...refJoins([...(dataset.scope ?? [])]),
    ...refJoins(
      measures.flatMap((m) => [
        m.of,
        m.times,
        m.convert?.unit,
        m.convert ? { join: m.convert.itemJoin, column: "unit" } : undefined,
        ...(m.where ?? []),
      ]),
    ),
    ...refJoins(grouped.map((g) => g.dim)),
    ...refJoins(filters.map((f) => f.dim)),
    ...refJoins([periodDim]),
  ]);

  const joinSql = joins.map((name) => {
    const join = dataset.joins[name]!;
    const table = requireTable(join.table);
    const on = [
      sql`${alias(name)}.${sql.identifier(join.to ?? "id")} = ${col({ join: join.fromJoin, column: join.from })}`,
    ];
    if (table.hasWorkspaceId) on.push(sql`${alias(name)}.workspace_id = ${ctx.workspaceId}`);
    if (join.kind === "parent" && table.hasDeletedAt) on.push(sql`${alias(name)}.deleted_at is null`);
    const kind = join.kind === "parent" ? sql`inner join` : sql`left join`;
    return sql` ${kind} ${sql.identifier(table.name)} as ${alias(name)} on ${sql.join(on, sql` and `)}`;
  });

  const where: SQL[] = [sql`${alias()}.workspace_id = ${ctx.workspaceId}`];
  if (base.hasDeletedAt) where.push(sql`${alias()}.deleted_at is null`);
  for (const condition of dataset.scope ?? []) where.push(conditionSql(condition));
  for (const { dim, filter } of filters) where.push(filterSql(dim, filter, ctx));
  if (periodDim && ctx.period) {
    const expr = dateExpr(periodDim, ctx);
    where.push(sql`${expr} >= ${ctx.period.range.from}::date and ${expr} < ${ctx.period.range.to}::date`);
  }

  const columns: CompiledColumn[] = [];
  const select: SQL[] = [];
  // By output position: an expression with bind parameters (the zone, a grain) repeated in GROUP BY
  // would be a different expression to Postgres.
  const groupBy: SQL[] = [];
  for (const { dim, grain } of grouped) {
    if (dim.type === "reference") {
      const labels = Array.isArray(dim.labelColumn) ? dim.labelColumn : [dim.labelColumn ?? dim.column];
      const label =
        labels.length === 1
          ? sql`${col({ join: dim.join, column: labels[0]! })}::text`
          : sql`concat_ws(' ', ${sql.join(
              labels.map((c) => col({ join: dim.join, column: c })),
              sql`, `,
            )})`;
      select.push(
        sql`${col(dim)}::text as ${sql.identifier(`${dim.id}__id`)}`,
        sql`${label} as ${sql.identifier(dim.id)}`,
      );
      groupBy.push(sql.raw(String(select.length - 1)), sql.raw(String(select.length)));
      columns.push({ key: dim.id, idKey: `${dim.id}__id`, kind: "dimension", dimension: dim });
    } else if (dim.type === "date") {
      const expr = bucket(dateExpr(dim, ctx), grain ?? "day", ctx);
      select.push(sql`to_char(${expr}, 'YYYY-MM-DD') as ${sql.identifier(dim.id)}`);
      groupBy.push(sql.raw(String(select.length)));
      columns.push({ key: dim.id, kind: "dimension", dimension: dim, grain: grain ?? "day" });
    } else {
      select.push(
        sql`${dim.type === "category" ? categoryExpr(dim) : col(dim)} as ${sql.identifier(dim.id)}`,
      );
      groupBy.push(sql.raw(String(select.length)));
      columns.push({ key: dim.id, kind: "dimension", dimension: dim });
    }
  }
  for (const m of measures) {
    select.push(sql`${measureSql(m)} as ${sql.identifier(m.id)}`);
    columns.push({ key: m.id, kind: "measure", measure: m });
  }

  // Sort by output columns; by default a date trend runs forward and anything else largest first.
  const sorts = spec.sort.filter((s) => !s.by.endsWith("__compare"));
  const order: SQL[] = sorts.length
    ? sorts.map((s) => sql`${sql.identifier(s.by)} ${s.dir === "asc" ? sql`asc` : sql`desc`} nulls last`)
    : grouped.some((g) => g.dim.type === "date")
      ? grouped.filter((g) => g.dim.type === "date").map((g) => sql`${sql.identifier(g.dim.id)} asc`)
      : [sql`${sql.identifier(measures[0]!.id)} desc nulls last`];
  // Ties broken by every grouped column, so results (and row caps) are deterministic.
  for (const g of grouped) order.push(sql`${sql.identifier(g.dim.id)} asc nulls last`);

  const statement = sql`select ${sql.join(select, sql`, `)} from ${sql.identifier(base.name)} as ${alias()}${sql.join(
    joinSql,
    sql``,
  )} where ${sql.join(where, sql` and `)}${groupBy.length ? sql` group by ${sql.join(groupBy, sql`, `)}` : sql``} order by ${sql.join(order, sql`, `)}`;

  return { build: (limit) => sql`${statement} limit ${limit}`, columns };
}
