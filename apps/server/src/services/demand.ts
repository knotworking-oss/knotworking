import {
  addWeeks,
  buildCoverage,
  buildDemandForecast,
  buildDemandSummary,
  customerKey,
  PACK_UNITS_PER_ITEM,
  toBaseQuantity,
  itemBaseUnit,
  weekStart,
  demandItemTypes,
  isDemandItemType,
  DEMAND_MAX_WEEKS,
  demandAction,
  demandEntriesFromInput,
  demandKey,
  demandRange,
  formatWeek,
  normalizePackName,
  packUnitKey,
  parseDemandCsv,
  resolveDemandEntries,
  stockAmount,
  type DemandAction,
  type DemandEntry,
  type DemandImportInput,
  type DemandImportListQuery,
  type DemandItem,
  type DemandItemType,
  type DemandLineListQuery,
  type DemandLinesSetInput,
  type DemandRowError,
  type DemandSource,
  type DemandSummary,
  type PackUnit,
  type PackUnitInput,
  type PackUnitListQuery,
  type PackUnitsSetInput,
  type DemandCoverage,
  type DemandCoverageQuery,
  type DemandForecast,
  type DemandForecastApplyInput,
  type DemandForecastQuery,
  type ResolvedDemandEntry,
} from "@knotworking/core";
import { lotBalances } from "./stock-ledger";
import {
  demandHistory,
  demandImports,
  demandLines,
  demandPackUnits,
  items,
  lockWorkspaceLog,
  productionBatches,
  recordChanges,
  stockLots,
  users,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ApiError, badRequest, notFound } from "../errors";
import { itemSummary, num } from "./ports/stock";
import { workspaceToday } from "./time-zone";

/**
 * Demand module: demand per item per ISO week (and customer), set by hand, by CSV import or by
 * the sales system through the API.
 *
 * - One live line per item, week and customer (case-insensitive; the `demand_lines_key` index is
 *   the backstop). Writing a key again replaces its quantity, so re-sending is idempotent; a
 *   write that changes nothing writes nothing.
 * - Every batch is all-or-nothing: entries are checked against the items first and nothing is
 *   written while any is wrong (`invalid_rows`, every problem listed with its row).
 * - Each write takes the workspace lock, then reads the current lines, so concurrent writers queue.
 * - Every change appends to `demand_history` (append-only: what the quantity was and became, who,
 *   how) and to the sync log (`demand_line`, `demand_import`). Lines are not in the bootstrap.
 * - `getDemandSummary` is what the production module plans from.
 */

type ItemRow = typeof items.$inferSelect;
type LineRow = typeof demandLines.$inferSelect;
type ImportRow = typeof demandImports.$inferSelect;

/** `%` and `_` are literal in a search box. */
const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;

/** Rows per insert, well under Postgres's 65,535 bind parameters. */
const CHUNK = 500;
const chunks = <T>(list: readonly T[], size = CHUNK): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/** How many changed rows a CSV import's preview lists. */
const PREVIEW_LIMIT = 1000;

// ─── Serialisation ───────────────────────────────────────────────────────────

function serializeLine(row: LineRow) {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
}

function serializeImport(row: ImportRow) {
  const { workspaceId: _ws, ...rest } = row;
  return rest;
}

const lineChange = (row: LineRow): ChangeInput =>
  row.deletedAt
    ? { entity: "demand_line", entityId: row.id, action: "delete" }
    : { entity: "demand_line", entityId: row.id, action: "upsert", data: serializeLine(row) };

const lineView = (row: LineRow, item: ItemRow) => ({
  ...serializeLine(row),
  week: formatWeek(row.periodStart),
  amount: stockAmount(row.quantity, item),
  item: itemSummary(item),
});

/** Every problem, in row order; the first few in the message so an agent sees them. */
function invalidRows(errors: DemandRowError[], what: "row" | "line") {
  const sorted = [...errors].sort((a, b) => a.row - b.row);
  const shown = sorted
    .slice(0, 5)
    .map(
      (e) => `${what === "row" ? "Row" : "Line"} ${e.row}${e.column ? ` (${e.column})` : ""}: ${e.message}`,
    );
  const more = sorted.length > 5 ? `; and ${sorted.length - 5} more` : "";
  const rows = new Set(sorted.map((e) => e.row)).size;
  return new ApiError(
    400,
    "invalid_rows",
    `${rows} ${what}${rows === 1 ? " has" : "s have"} problems; nothing was saved. ${shown.join("; ")}${more}`,
    { errors: sorted },
  );
}

// ─── Resolving and planning ──────────────────────────────────────────────────

/** The items a batch names (by id or code, case-insensitive), as a lookup for `resolveDemandEntries`. */
async function itemLookup(db: Executor, workspaceId: string, entries: readonly DemandEntry[]) {
  const ids = [...new Set(entries.flatMap((e) => (e.itemId ? [e.itemId] : [])))];
  const codes = [...new Set(entries.flatMap((e) => (e.itemCode ? [e.itemCode.toLowerCase()] : [])))];
  const rows: ItemRow[] = [];
  for (const [idChunk = [], codeChunk = []] of zipChunks(ids, codes)) {
    const match = or(
      idChunk.length ? inArray(items.id, idChunk) : undefined,
      codeChunk.length ? inArray(sql`lower(${items.code})`, codeChunk) : undefined,
    );
    if (!match) continue;
    rows.push(
      ...(await db
        .select()
        .from(items)
        .where(and(eq(items.workspaceId, workspaceId), isNull(items.deletedAt), match))),
    );
  }
  const packs = await packUnitsByItem(
    db,
    workspaceId,
    rows.map((r) => r.id),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byCode = new Map(rows.map((r) => [r.code.toLowerCase(), r]));
  const withPacks = (row: ItemRow | undefined) =>
    row ? ({ ...row, packUnits: packs.get(row.id) } as DemandItem) : undefined;
  return {
    rows: byId,
    find: ({ itemId, itemCode }: { itemId?: string | undefined; itemCode?: string | undefined }) =>
      withPacks(itemId ? byId.get(itemId) : itemCode ? byCode.get(itemCode.toLowerCase()) : undefined),
  };
}

/** Live pack units per item, by name. */
async function packUnitsByItem(db: Executor, workspaceId: string, itemIds: readonly string[]) {
  const byItem = new Map<string, PackUnit[]>();
  for (const idChunk of chunks([...itemIds])) {
    const rows = await db
      .select()
      .from(demandPackUnits)
      .where(
        and(
          eq(demandPackUnits.workspaceId, workspaceId),
          isNull(demandPackUnits.deletedAt),
          inArray(demandPackUnits.itemId, idChunk),
        ),
      )
      .orderBy(asc(demandPackUnits.name));
    for (const r of rows)
      byItem.set(r.itemId, [...(byItem.get(r.itemId) ?? []), { name: r.name, size: r.size }]);
  }
  return byItem;
}

/** Pairs of id and code chunks, so one query per chunk looks both up. */
function zipChunks(a: string[], b: string[]): [string[] | undefined, string[] | undefined][] {
  const left = chunks(a);
  const right = chunks(b);
  return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => [left[i], right[i]]);
}

interface PlannedEntry {
  entry: ResolvedDemandEntry;
  current: LineRow | undefined;
  action: DemandAction;
}

/** What each entry does to the live line with its key, read inside the caller's transaction. */
async function planEntries(
  db: Executor,
  workspaceId: string,
  resolved: readonly ResolvedDemandEntry[],
): Promise<PlannedEntry[]> {
  const current = new Map<string, LineRow>();
  const itemIds = [...new Set(resolved.map((e) => e.item.id))];
  const periods = [...new Set(resolved.map((e) => e.periodStart))];
  for (const idChunk of chunks(itemIds)) {
    const rows = await db
      .select()
      .from(demandLines)
      .where(
        and(
          eq(demandLines.workspaceId, workspaceId),
          isNull(demandLines.deletedAt),
          inArray(demandLines.itemId, idChunk),
          inArray(demandLines.periodStart, periods),
        ),
      );
    for (const row of rows) current.set(demandKey(row.itemId, row.periodStart, row.customer), row);
  }
  return resolved.map((entry) => {
    const line = current.get(demandKey(entry.item.id, entry.periodStart, entry.customer));
    return { entry, current: line, action: demandAction(entry, line) };
  });
}

/**
 * `replaceHorizon`: the live lines in the file's weeks (first to last, every item) for the
 * customers the file names (case-insensitively; a blank customer is its own one) that no row of
 * the file names, as removals. Other customers' demand is left alone, so one retailer's forecast
 * file never wipes another's. Their items are added to `itemRows` so the preview
 * can describe them.
 */
async function planHorizonRemovals(
  db: Executor,
  workspaceId: string,
  horizon: { from: string; to: string },
  plan: readonly PlannedEntry[],
  itemRows: Map<string, ItemRow>,
): Promise<PlannedEntry[]> {
  const inFile = new Set(plan.map((p) => demandKey(p.entry.item.id, p.entry.periodStart, p.entry.customer)));
  const customers = new Set(plan.map((p) => customerKey(p.entry.customer)));
  const rows = await db
    .select({ line: demandLines, item: items })
    .from(demandLines)
    .innerJoin(items, eq(items.id, demandLines.itemId))
    .where(
      and(
        eq(demandLines.workspaceId, workspaceId),
        isNull(demandLines.deletedAt),
        gte(demandLines.periodStart, horizon.from),
        lte(demandLines.periodStart, horizon.to),
      ),
    )
    .orderBy(demandLines.periodStart, items.code, demandLines.customer);
  const removals: PlannedEntry[] = [];
  for (const { line, item } of rows) {
    if (!customers.has(customerKey(line.customer))) continue;
    if (inFile.has(demandKey(line.itemId, line.periodStart, line.customer))) continue;
    if (!itemRows.has(item.id)) itemRows.set(item.id, item);
    removals.push({
      entry: {
        row: 0,
        item: { id: line.itemId } as DemandItem,
        periodStart: line.periodStart,
        customer: line.customer,
        quantity: null,
        entered: null,
      },
      current: line,
      action: "remove",
    });
  }
  return removals;
}

const countActions = (plan: readonly PlannedEntry[]) => {
  const counts: Record<DemandAction, number> = { create: 0, update: 0, remove: 0, unchanged: 0 };
  for (const p of plan) counts[p.action]++;
  return counts;
};

/**
 * Writes a plan: inserts, updates and (soft) removes lines, appends one history row per change and
 * records the sync log. `source` and `importId` are set when the quantity changes (they say where
 * the current quantity came from). Returns the written lines in plan order.
 */
async function applyPlan(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  plan: readonly PlannedEntry[],
  origin: { source: DemandSource; importId: string | null },
): Promise<{ row: LineRow; action: Exclude<DemandAction, "unchanged">; previous: number | null }[]> {
  const written: { row: LineRow; action: Exclude<DemandAction, "unchanged">; previous: number | null }[] = [];
  const now = new Date();

  const creates = plan.filter((p) => p.action === "create");
  for (const batch of chunks(creates)) {
    const rows = await tx
      .insert(demandLines)
      .values(
        batch.map(({ entry }) => ({
          workspaceId,
          itemId: entry.item.id,
          periodStart: entry.periodStart,
          customer: entry.customer,
          quantity: entry.quantity!,
          enteredQuantity: entry.entered?.quantity ?? null,
          enteredUnit: entry.entered?.unit ?? null,
          note: entry.note ?? null,
          externalRef: entry.externalRef ?? null,
          source: origin.source,
          importId: origin.importId,
          createdBy: actorId,
          updatedBy: actorId,
        })),
      )
      .returning();
    written.push(...rows.map((row) => ({ row, action: "create" as const, previous: null })));
  }

  // Updates and removals: one `UPDATE … FROM (VALUES …)` per chunk rather than one per line, so
  // the workspace lock is held for as few round trips as possible. Each row of `v` says what
  // changes on its line: a removal sets `deleted_at`, the source and the import; an update sets
  // the quantity, the note and external reference when given, and the source and import only when
  // the quantity changes (they say where the current quantity came from).
  const changed = plan.flatMap(({ entry, current, action }) =>
    current && (action === "update" || action === "remove") ? [{ entry, current, action }] : [],
  );
  for (const batch of chunks(changed)) {
    const values = sql.join(
      batch.map(({ entry, current, action }) => {
        const remove = action === "remove";
        const setSource = remove || entry.quantity !== current.quantity;
        return sql`(${current.id}::uuid, ${remove}::boolean, ${remove ? null : entry.quantity!}::numeric,
          ${!remove && entry.note !== undefined}::boolean, ${entry.note ?? null}::text,
          ${!remove && entry.externalRef !== undefined}::boolean, ${entry.externalRef ?? null}::text,
          ${setSource}::boolean, ${remove ? null : (entry.entered?.quantity ?? null)}::numeric,
          ${remove ? null : (entry.entered?.unit ?? null)}::text)`;
      }),
      sql`, `,
    );
    const rows = await tx
      .update(demandLines)
      .set({
        quantity: sql`case when v.is_remove then ${demandLines.quantity} else v.new_quantity end`,
        note: sql`case when v.has_note then v.new_note else ${demandLines.note} end`,
        externalRef: sql`case when v.has_ref then v.new_ref else ${demandLines.externalRef} end`,
        enteredQuantity: sql`case when v.has_source and not v.is_remove then v.new_eq else ${demandLines.enteredQuantity} end`,
        enteredUnit: sql`case when v.has_source and not v.is_remove then v.new_eu else ${demandLines.enteredUnit} end`,
        source: sql`case when v.has_source then ${origin.source}::text else ${demandLines.source} end`,
        importId: sql`case when v.has_source then ${origin.importId}::uuid else ${demandLines.importId} end`,
        deletedAt: sql`case when v.is_remove then ${now.toISOString()}::timestamptz else ${demandLines.deletedAt} end`,
        updatedBy: actorId,
      })
      .from(
        sql`(values ${values}) as v(line_id, is_remove, new_quantity, has_note, new_note, has_ref, new_ref, has_source, new_eq, new_eu)`,
      )
      .where(eq(demandLines.id, sql`v.line_id`))
      .returning(getTableColumns(demandLines));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const { current, action } of batch) {
      written.push({ row: byId.get(current.id)!, action, previous: current.quantity });
    }
  }

  for (const batch of chunks(written)) {
    await tx.insert(demandHistory).values(
      batch.map(({ row, action, previous }) => ({
        workspaceId,
        lineId: row.id,
        itemId: row.itemId,
        periodStart: row.periodStart,
        customer: row.customer,
        action,
        previousQuantity: previous,
        quantity: action === "remove" ? null : row.quantity,
        enteredQuantity: action === "remove" ? null : row.enteredQuantity,
        enteredUnit: action === "remove" ? null : row.enteredUnit,
        note: row.note,
        source: origin.source,
        importId: origin.importId,
        actorId,
      })),
    );
  }
  for (const batch of chunks(written, 1000)) {
    await recordChanges(
      tx,
      workspaceId,
      actorId,
      batch.map((w) => lineChange(w.row)),
    );
  }
  return written;
}

// ─── Setting lines ───────────────────────────────────────────────────────────

/**
 * `PUT /demand/lines`: creates, replaces or removes (`quantity: null`) many lines in one
 * transaction. All or nothing. `source` is how the caller signed in: `manual` for a person in the
 * app, `api` for an API token (the sales system's feed, or an agent).
 */
export async function setDemandLines(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: DemandLinesSetInput,
  source: Exclude<DemandSource, "import">,
) {
  const entries = demandEntriesFromInput(input);
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const lookup = await itemLookup(tx, workspaceId, entries);
    const { resolved, errors } = resolveDemandEntries(entries, lookup.find);
    if (errors.length) throw invalidRows(errors, "line");
    const plan = await planEntries(tx, workspaceId, resolved);
    const written = await applyPlan(tx, workspaceId, actorId, plan, { source, importId: null });
    const byKey = new Map(
      written.map((w) => [demandKey(w.row.itemId, w.row.periodStart, w.row.customer), w.row]),
    );
    const counts = countActions(plan);
    return {
      created: counts.create,
      updated: counts.update,
      removed: counts.remove,
      unchanged: counts.unchanged,
      /** One per request line, in order: the line as it now is (`null` once removed, or never there). */
      lines: plan.map(({ entry, current, action }) => {
        const line = byKey.get(demandKey(entry.item.id, entry.periodStart, entry.customer)) ?? current;
        return {
          row: entry.row,
          action,
          line: line && !line.deletedAt ? lineView(line, lookup.rows.get(entry.item.id)!) : null,
        };
      }),
    };
  });
}

/** Removes one line (kept in the history). */
export async function deleteDemandLine(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  source: Exclude<DemandSource, "import">,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [current] = await tx
      .select()
      .from(demandLines)
      .where(
        and(eq(demandLines.id, id), eq(demandLines.workspaceId, workspaceId), isNull(demandLines.deletedAt)),
      );
    if (!current) throw notFound("Demand line");
    await applyPlan(
      tx,
      workspaceId,
      actorId,
      [
        {
          entry: {
            row: 1,
            item: { id: current.itemId } as DemandItem,
            periodStart: current.periodStart,
            customer: current.customer,
            quantity: null,
            entered: null,
          },
          current,
          action: "remove",
        },
      ],
      { source, importId: null },
    );
  });
}

// ─── CSV import ──────────────────────────────────────────────────────────────

/**
 * `POST /demand/imports`: checks a CSV file against the items and, unless `dryRun`, upserts every
 * row in one transaction. With any problem nothing is written: a dry run returns the problems, an
 * import answers `400 invalid_rows` with them. Lines it sets get `source: "import"` and the
 * import's id.
 */
export async function importDemandCsv(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: DemandImportInput,
) {
  const parsed = parseDemandCsv(input.csv);
  const fileName = input.fileName ?? null;

  const check = async (tx: Executor) => {
    const lookup = await itemLookup(tx, workspaceId, parsed.entries);
    const { resolved, errors } = resolveDemandEntries(parsed.entries, lookup.find);
    const allErrors = [...parsed.errors, ...errors].sort((a, b) => a.row - b.row);
    let plan = allErrors.length ? [] : await planEntries(tx, workspaceId, resolved);
    let horizon: { from: string; to: string } | null = null;
    if (input.replaceHorizon && plan.length) {
      horizon = {
        from: plan.reduce(
          (min, p) => (p.entry.periodStart < min ? p.entry.periodStart : min),
          plan[0]!.entry.periodStart,
        ),
        to: plan.reduce(
          (max, p) => (p.entry.periodStart > max ? p.entry.periodStart : max),
          plan[0]!.entry.periodStart,
        ),
      };
      plan = [...plan, ...(await planHorizonRemovals(tx, workspaceId, horizon, plan, lookup.rows))];
    }
    return { lookup, plan, errors: allErrors, horizon };
  };

  const result = (
    plan: PlannedEntry[],
    errors: DemandRowError[],
    lookup: Awaited<ReturnType<typeof itemLookup>>,
    imported: ImportRow | null,
    horizon: { from: string; to: string } | null,
  ) => {
    const counts = countActions(plan);
    const changes = plan.filter((p) => p.action !== "unchanged");
    return {
      dryRun: imported === null,
      fileName,
      rowCount: parsed.rowCount,
      ignoredColumns: parsed.ignoredColumns,
      errors,
      created: counts.create,
      updated: counts.update,
      /** Lines in the horizon that the file doesn't have (`replaceHorizon` only). */
      removed: counts.remove,
      unchanged: counts.unchanged,
      /** The weeks `replaceHorizon` covers (the file's first to last week), or `null`. */
      horizon: horizon
        ? {
            from: horizon.from,
            to: horizon.to,
            fromWeek: formatWeek(horizon.from),
            toWeek: formatWeek(horizon.to),
          }
        : null,
      /** The changes the import makes (or made), in row order; the first `PREVIEW_LIMIT`. */
      changes: changes.slice(0, PREVIEW_LIMIT).map(({ entry, current, action }) => {
        const item = lookup.rows.get(entry.item.id)!;
        return {
          row: entry.row,
          action,
          item: itemSummary(item),
          periodStart: entry.periodStart,
          week: formatWeek(entry.periodStart),
          customer: entry.customer,
          amount: entry.quantity === null ? null : stockAmount(entry.quantity, item),
          previous: current ? stockAmount(current.quantity, item) : null,
        };
      }),
      changesTruncated: changes.length > PREVIEW_LIMIT,
      import: imported ? serializeImport(imported) : null,
    };
  };

  if (input.dryRun) {
    const { lookup, plan, errors, horizon } = await check(db);
    return result(plan, errors, lookup, null, horizon);
  }

  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const { lookup, plan, errors, horizon } = await check(tx);
    if (errors.length) throw invalidRows(errors, "row");
    const counts = countActions(plan);
    const [imported] = await tx
      .insert(demandImports)
      .values({
        workspaceId,
        fileName,
        rowCount: parsed.rowCount,
        createdCount: counts.create,
        updatedCount: counts.update,
        removedCount: counts.remove,
        unchangedCount: counts.unchanged,
        actorId,
      })
      .returning();
    await applyPlan(tx, workspaceId, actorId, plan, { source: "import", importId: imported!.id });
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "demand_import", entityId: imported!.id, action: "upsert", data: serializeImport(imported!) },
    ]);
    return result(plan, [], lookup, imported!, horizon);
  });
}

/** Imports, newest first, with who ran them. */
export async function listDemandImports(db: Database, workspaceId: string, query: DemandImportListQuery) {
  const where = eq(demandImports.workspaceId, workspaceId);
  const [rows, [total]] = await Promise.all([
    db
      .select({ row: demandImports, actorName: users.name })
      .from(demandImports)
      .leftJoin(users, eq(users.id, demandImports.actorId))
      .where(where)
      .orderBy(desc(demandImports.createdAt), desc(demandImports.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(demandImports).where(where),
  ]);
  return {
    imports: rows.map(({ row, actorName }) => ({ ...serializeImport(row), actorName })),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

// ─── Reading ─────────────────────────────────────────────────────────────────

const createdByUser = alias(users, "created_by_user");
const updatedByUser = alias(users, "updated_by_user");

/** Live lines, by week, item code and customer. */
export async function listDemandLines(db: Database, workspaceId: string, query: DemandLineListQuery) {
  const where: (SQL | undefined)[] = [
    eq(demandLines.workspaceId, workspaceId),
    isNull(demandLines.deletedAt),
    query.itemId ? eq(demandLines.itemId, query.itemId) : undefined,
    query.itemCode ? sql`lower(${items.code}) = ${query.itemCode.toLowerCase()}` : undefined,
    query.from ? gte(demandLines.periodStart, query.from) : undefined,
    query.to ? lte(demandLines.periodStart, query.to) : undefined,
    query.customer ? sql`lower(${demandLines.customer}) = ${customerKey(query.customer)}` : undefined,
    query.source ? eq(demandLines.source, query.source) : undefined,
    query.importId ? eq(demandLines.importId, query.importId) : undefined,
    query.q
      ? or(
          sql`${items.name} ilike ${like(query.q)} escape '!'`,
          sql`${items.code} ilike ${like(query.q)} escape '!'`,
        )
      : undefined,
  ];
  const [rows, [total]] = await Promise.all([
    db
      .select({
        line: demandLines,
        item: items,
        createdByName: createdByUser.name,
        updatedByName: updatedByUser.name,
      })
      .from(demandLines)
      .innerJoin(items, eq(items.id, demandLines.itemId))
      .leftJoin(createdByUser, eq(createdByUser.id, demandLines.createdBy))
      .leftJoin(updatedByUser, eq(updatedByUser.id, demandLines.updatedBy))
      .where(and(...where))
      .orderBy(
        asc(demandLines.periodStart),
        asc(items.code),
        sql`${demandLines.customer} asc nulls first`,
        asc(demandLines.id),
      )
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(demandLines)
      .innerJoin(items, eq(items.id, demandLines.itemId))
      .where(and(...where)),
  ]);
  return {
    lines: rows.map(({ line, item, createdByName, updatedByName }) => ({
      ...lineView(line, item),
      createdByName,
      updatedByName,
    })),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

/**
 * The history of a line's key (item, week and customer), newest first: every create, change and
 * removal with the quantities before and after, who and how. Includes earlier lines with the same
 * key that were removed and set again.
 */
export async function getDemandLineHistory(db: Database, workspaceId: string, id: string) {
  const [found] = await db
    .select({ line: demandLines, item: items })
    .from(demandLines)
    .innerJoin(items, eq(items.id, demandLines.itemId))
    .where(and(eq(demandLines.id, id), eq(demandLines.workspaceId, workspaceId)));
  if (!found) throw notFound("Demand line");
  const { line, item } = found;
  const rows = await db
    .select({ change: demandHistory, actorName: users.name })
    .from(demandHistory)
    .leftJoin(users, eq(users.id, demandHistory.actorId))
    .where(
      and(
        eq(demandHistory.workspaceId, workspaceId),
        eq(demandHistory.itemId, line.itemId),
        eq(demandHistory.periodStart, line.periodStart),
        sql`lower(coalesce(${demandHistory.customer}, '')) = ${customerKey(line.customer)}`,
      ),
    )
    .orderBy(desc(demandHistory.createdAt), desc(demandHistory.id));
  return {
    line: { ...lineView(line, item), removed: line.deletedAt !== null },
    history: rows.map(({ change, actorName }) => ({
      id: change.id,
      lineId: change.lineId,
      action: change.action,
      previous: change.previousQuantity === null ? null : stockAmount(change.previousQuantity, item),
      amount: change.quantity === null ? null : stockAmount(change.quantity, item),
      enteredQuantity: change.enteredQuantity,
      enteredUnit: change.enteredUnit,
      note: change.note,
      source: change.source,
      importId: change.importId,
      actorName,
      createdAt: change.createdAt,
    })),
  };
}

export interface DemandSummaryOptions {
  /** Any date or Monday; default: the current week. */
  from?: string | undefined;
  /** Any date or Monday (inclusive); default: `DEMAND_DEFAULT_WEEKS` weeks from `from`. */
  to?: string | undefined;
  /** Only these items. */
  itemIds?: readonly string[] | undefined;
  /** Only the item with this stock code (case-insensitive). */
  itemCode?: string | undefined;
  itemType?: DemandItemType | undefined;
  /** One row per item and customer instead of one per item. */
  byCustomer?: boolean | undefined;
}

/**
 * **The production module's entry point**: demand per item per ISO week over a range, in each
 * item's base unit (`row.periods[i].quantity.base`), from live lines. Items with demand only;
 * archived items still show when they have demand (check `item.status`).
 */
export async function getDemandSummary(
  db: Executor,
  workspaceId: string,
  options: DemandSummaryOptions = {},
): Promise<DemandSummary> {
  const range = demandRange(options, await workspaceToday(db, workspaceId));
  if (!range) {
    throw badRequest(`Choose a range that ends after it starts and covers at most ${DEMAND_MAX_WEEKS} weeks`);
  }
  const byCustomer = options.byCustomer ?? false;
  if (options.itemIds?.length === 0) {
    return buildDemandSummary({ ...range, byCustomer, cells: [], items: new Map() });
  }
  const customer = byCustomer ? demandLines.customer : sql<string | null>`null`;
  const rows = await db
    .select({
      item: items,
      periodStart: demandLines.periodStart,
      customer: sql<string | null>`${customer}`,
      total: sql<string>`sum(${demandLines.quantity})`,
      lineCount: sql<number>`count(*)::int`,
    })
    .from(demandLines)
    .innerJoin(items, eq(items.id, demandLines.itemId))
    .where(
      and(
        eq(demandLines.workspaceId, workspaceId),
        isNull(demandLines.deletedAt),
        gte(demandLines.periodStart, range.from),
        lte(demandLines.periodStart, range.to),
        options.itemIds ? inArray(demandLines.itemId, [...options.itemIds]) : undefined,
        options.itemCode ? sql`lower(${items.code}) = ${options.itemCode.toLowerCase()}` : undefined,
        options.itemType ? eq(items.type, options.itemType) : undefined,
      ),
    )
    .groupBy(items.id, demandLines.periodStart, ...(byCustomer ? [demandLines.customer] : []));
  const packs = await packUnitsByItem(db, workspaceId, [...new Set(rows.map((r) => r.item.id))]);
  return buildDemandSummary({
    ...range,
    byCustomer,
    cells: rows.map((r) => ({
      itemId: r.item.id,
      periodStart: r.periodStart,
      customer: r.customer,
      quantity: num(r.total),
      lineCount: Number(r.lineCount),
    })),
    items: new Map(
      rows.map((r) => {
        const packUnits = packs.get(r.item.id);
        return [r.item.id, { ...itemSummary(r.item), ...(packUnits ? { packUnits } : {}) }];
      }),
    ),
  });
}

// ─── Units of sale (pack units) ──────────────────────────────────────────────

type PackRow = typeof demandPackUnits.$inferSelect;

const packView = (row: PackRow, item: ItemRow) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return { ...rest, item: itemSummary(item), amount: stockAmount(row.size, item) };
};

const packChange = (row: PackRow): ChangeInput =>
  row.deletedAt
    ? { entity: "demand_pack_unit", entityId: row.id, action: "delete" }
    : {
        entity: "demand_pack_unit",
        entityId: row.id,
        action: "upsert",
        data: (({ workspaceId: _ws, deletedAt: _deleted, ...rest }) => rest)(row),
      };

/** Live pack units, by item code then name. */
export async function listPackUnits(db: Database, workspaceId: string, query: PackUnitListQuery) {
  const rows = await db
    .select({ pack: demandPackUnits, item: items })
    .from(demandPackUnits)
    .innerJoin(items, eq(items.id, demandPackUnits.itemId))
    .where(
      and(
        eq(demandPackUnits.workspaceId, workspaceId),
        isNull(demandPackUnits.deletedAt),
        query.itemId ? eq(demandPackUnits.itemId, query.itemId) : undefined,
        query.itemCode ? sql`lower(${items.code}) = ${query.itemCode.toLowerCase()}` : undefined,
      ),
    )
    .orderBy(asc(items.code), asc(demandPackUnits.name));
  return { packUnits: rows.map(({ pack, item }) => packView(pack, item)) };
}

/**
 * `PUT /demand/pack-units`: creates, resizes or removes (`size: null`) units of sale in one
 * transaction, all or nothing. A pack's size is in base units; changing it never changes demand
 * already entered (that is held in base units, with what was typed kept beside it).
 */
export async function setPackUnits(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: PackUnitsSetInput,
) {
  const entries = input.packUnits.map((p, index) => ({ ...p, row: index + 1 }));
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const lookup = await itemLookup(
      tx,
      workspaceId,
      entries.map((e) => ({ row: e.row, itemId: e.itemId, itemCode: e.itemCode }) as DemandEntry),
    );
    const errors: DemandRowError[] = [];
    const wanted: { row: number; item: ItemRow; name: string; size: number | null }[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      const found = lookup.find({ itemId: e.itemId, itemCode: e.itemCode });
      const item = found && lookup.rows.get(found.id);
      if (!item) {
        errors.push({
          row: e.row,
          column: "item",
          message: e.itemCode ? `No item has the code "${e.itemCode}"` : "Item not found",
        });
        continue;
      }
      let size: number | null = null;
      if (e.size !== null) {
        if (!isDemandItemType(item.type) || item.status !== "active") {
          errors.push({
            row: e.row,
            column: "item",
            message: `${item.code} must be an active finished good or work in progress to have units of sale`,
          });
          continue;
        }
        size = toBaseQuantity(e.size, e.unit ?? itemBaseUnit(item), item);
        if (size === null || size <= 0) {
          errors.push({
            row: e.row,
            column: "unit",
            message: `${item.code}: that size can't be converted to ${itemBaseUnit(item)} (it needs a density or unit weight)`,
          });
          continue;
        }
      }
      const key = `${item.id}|${packUnitKey(e.name)}`;
      if (seen.has(key)) {
        errors.push({ row: e.row, message: `${item.code} has "${e.name}" twice in this request` });
        continue;
      }
      seen.add(key);
      wanted.push({ row: e.row, item, name: normalizePackName(e.name), size });
    }
    if (errors.length) throw invalidRows(errors, "line");

    const itemIds = [...new Set(wanted.map((w) => w.item.id))];
    const existing = itemIds.length
      ? await tx
          .select()
          .from(demandPackUnits)
          .where(
            and(
              eq(demandPackUnits.workspaceId, workspaceId),
              isNull(demandPackUnits.deletedAt),
              inArray(demandPackUnits.itemId, itemIds),
            ),
          )
      : [];
    const byKey = new Map(existing.map((p) => [`${p.itemId}|${packUnitKey(p.name)}`, p]));
    const live = new Map<string, number>();
    for (const p of existing) live.set(p.itemId, (live.get(p.itemId) ?? 0) + 1);
    const now = new Date();
    const changes: ChangeInput[] = [];
    const result: {
      row: number;
      action: "create" | "update" | "remove" | "unchanged";
      packUnit: ReturnType<typeof packView> | null;
    }[] = [];
    for (const w of wanted) {
      const current = byKey.get(`${w.item.id}|${packUnitKey(w.name)}`);
      if (w.size === null) {
        if (!current) {
          result.push({ row: w.row, action: "unchanged", packUnit: null });
          continue;
        }
        const [row] = await tx
          .update(demandPackUnits)
          .set({ deletedAt: now, updatedBy: actorId })
          .where(eq(demandPackUnits.id, current.id))
          .returning();
        changes.push(packChange(row!));
        live.set(w.item.id, (live.get(w.item.id) ?? 1) - 1);
        result.push({ row: w.row, action: "remove", packUnit: null });
      } else if (current) {
        if (current.size === w.size && current.name === w.name) {
          result.push({ row: w.row, action: "unchanged", packUnit: packView(current, w.item) });
          continue;
        }
        const [row] = await tx
          .update(demandPackUnits)
          .set({ size: w.size, name: w.name, updatedBy: actorId })
          .where(eq(demandPackUnits.id, current.id))
          .returning();
        changes.push(packChange(row!));
        result.push({ row: w.row, action: "update", packUnit: packView(row!, w.item) });
      } else {
        const count = (live.get(w.item.id) ?? 0) + 1;
        if (count > PACK_UNITS_PER_ITEM) {
          throw invalidRows(
            [{ row: w.row, message: `${w.item.code} can have at most ${PACK_UNITS_PER_ITEM} units of sale` }],
            "line",
          );
        }
        live.set(w.item.id, count);
        const [row] = await tx
          .insert(demandPackUnits)
          .values({
            workspaceId,
            itemId: w.item.id,
            name: w.name,
            size: w.size,
            createdBy: actorId,
            updatedBy: actorId,
          })
          .returning();
        changes.push(packChange(row!));
        result.push({ row: w.row, action: "create", packUnit: packView(row!, w.item) });
      }
    }
    if (changes.length) await recordChanges(tx, workspaceId, actorId, changes);
    return { results: result };
  });
}

/** Removes one pack unit. Lines keep what was entered in it. */
export async function deletePackUnit(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [row] = await tx
      .update(demandPackUnits)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(
        and(
          eq(demandPackUnits.id, id),
          eq(demandPackUnits.workspaceId, workspaceId),
          isNull(demandPackUnits.deletedAt),
        ),
      )
      .returning();
    if (!row) throw notFound("Pack unit");
    await recordChanges(tx, workspaceId, actorId, [packChange(row)]);
  });
}

// ─── Forecast ────────────────────────────────────────────────────────────────

/**
 * `GET /demand/forecast`: a forecast per item (and customer) from past demand (see core
 * `demand-planning.ts` for the method). History is the demand lines of weeks before the current
 * week, except lines copied from an earlier forecast (`source: forecast`), which are not demand.
 * Only active finished goods and work in progress are forecast.
 */
export async function getDemandForecast(
  db: Executor,
  workspaceId: string,
  options: Omit<DemandForecastQuery, "byCustomer" | "window" | "seasonal"> & {
    byCustomer?: boolean | undefined;
    window?: number | undefined;
    seasonal?: boolean | undefined;
  },
): Promise<DemandForecast> {
  const today = await workspaceToday(db, workspaceId);
  const range = demandRange(
    {
      from: options.from,
      to: options.to ?? (options.from ? addWeeks(options.from, 7) : addWeeks(weekStart(today), 7)),
    },
    today,
  );
  if (!range || range.to > addWeeks(range.from, 51)) {
    throw badRequest("Choose a range that ends after it starts and covers at most 52 weeks");
  }
  const window = options.window ?? 8;
  const seasonal = options.seasonal ?? true;
  const byCustomer = options.byCustomer ?? false;
  // History runs up to the earlier of the current week and the first forecast week.
  const origin = range.from < weekStart(today) ? range.from : weekStart(today);
  const rows = await db
    .select({
      item: items,
      periodStart: demandLines.periodStart,
      customer: demandLines.customer,
      total: sql<string>`sum(${demandLines.quantity})`,
    })
    .from(demandLines)
    .innerJoin(items, eq(items.id, demandLines.itemId))
    .where(
      and(
        eq(demandLines.workspaceId, workspaceId),
        isNull(demandLines.deletedAt),
        sql`${demandLines.source} <> 'forecast'`,
        lte(demandLines.periodStart, addWeeks(origin, -1)),
        gte(demandLines.periodStart, addWeeks(origin, -(53 + 1 + window))),
        eq(items.status, "active"),
        inArray(items.type, options.itemType ? [options.itemType] : [...demandItemTypes]),
        options.itemId ? eq(items.id, options.itemId) : undefined,
        options.itemCode ? sql`lower(${items.code}) = ${options.itemCode.toLowerCase()}` : undefined,
      ),
    )
    .groupBy(items.id, demandLines.periodStart, demandLines.customer);
  const packs = await packUnitsByItem(db, workspaceId, [...new Set(rows.map((r) => r.item.id))]);
  return buildDemandForecast({
    ...range,
    origin,
    byCustomer,
    window,
    seasonal,
    cells: rows.map((r) => ({
      itemId: r.item.id,
      customer: r.customer,
      periodStart: r.periodStart,
      quantity: num(r.total),
    })),
    items: new Map(
      rows.map((r) => {
        const packUnits = packs.get(r.item.id);
        return [r.item.id, { ...itemSummary(r.item), ...(packUnits ? { packUnits } : {}) }];
      }),
    ),
  });
}

/**
 * `POST /demand/forecast/apply`: writes the forecast into demand lines with `source: forecast`,
 * as an ordinary write (`setDemandLines`: history, sync log, all or nothing). By default only
 * weeks that have no line with the same key (item, week, customer) are filled, so real orders and
 * hand-entered plans are never overwritten; `overwrite` replaces the line with the same key. An
 * item total is never written beside customer lines, nor a customer's forecast beside a total
 * without a customer (it would be counted twice). Weeks forecast at 0 are not written.
 */
export async function applyDemandForecast(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: DemandForecastApplyInput,
) {
  const forecast = await getDemandForecast(db, workspaceId, input);
  const lines: DemandLinesSetInput["lines"] = [];
  const skipped: { item: string; week: string; customer: string | null; reason: string }[] = [];
  if (forecast.rows.length) {
    const existing = await db
      .select({
        itemId: demandLines.itemId,
        periodStart: demandLines.periodStart,
        customer: demandLines.customer,
      })
      .from(demandLines)
      .where(
        and(
          eq(demandLines.workspaceId, workspaceId),
          isNull(demandLines.deletedAt),
          gte(demandLines.periodStart, forecast.from),
          lte(demandLines.periodStart, forecast.to),
          inArray(demandLines.itemId, [...new Set(forecast.rows.map((r) => r.item.id))]),
        ),
      );
    const at = (itemId: string, periodStart: string) =>
      existing.filter((l) => l.itemId === itemId && l.periodStart === periodStart);
    for (const row of forecast.rows) {
      for (const p of row.periods) {
        const skip = (reason: string) =>
          skipped.push({ item: row.item.code, week: p.week, customer: row.customer, reason });
        if (p.quantity.base <= 0) continue;
        const here = at(row.item.id, p.periodStart);
        const sameKey = here.some((l) => customerKey(l.customer) === customerKey(row.customer));
        const customerLines = here.some((l) => l.customer !== null);
        if (!forecast.byCustomer) {
          // An item total: never alongside customer lines (it would be counted twice).
          if (customerLines) {
            skip("Customers already have demand this week; forecast by customer to fill them");
            continue;
          }
          if (sameKey && !input.overwrite) {
            skip("Already has demand");
            continue;
          }
        } else {
          // A customer's forecast: never alongside a total entered for the item without customer.
          if (row.customer !== null && here.some((l) => l.customer === null)) {
            skip("The week already has a total without a customer");
            continue;
          }
          if (sameKey && !input.overwrite) {
            skip("Already has demand");
            continue;
          }
        }
        lines.push({
          itemId: row.item.id,
          period: p.periodStart,
          quantity: p.quantity.base,
          unit: itemBaseUnit(row.item),
          ...(row.customer ? { customer: row.customer } : {}),
        });
      }
    }
  }
  if (lines.length === 0) {
    return { created: 0, updated: 0, removed: 0, unchanged: 0, lines: [], skipped };
  }
  const result = await setDemandLines(db, workspaceId, actorId, { lines }, "forecast");
  return { ...result, skipped };
}

// ─── Coverage: demand against stock and planned batches ──────────────────────

/**
 * `GET /demand/coverage`: per item per week, demand against the stock available now (released
 * lots that haven't expired) and the output of planned and in-progress batches due that week
 * (batches due before the range count in its first week). Starts no earlier than the current
 * week. `includeStock` / `includeProduction` say whether the caller may read those modules; what
 * they may not read is left out of the figures (`basis` says what is counted).
 */
export async function getDemandCoverage(
  db: Database,
  workspaceId: string,
  query: DemandCoverageQuery,
  access: { stock: boolean; production: boolean },
): Promise<DemandCoverage> {
  const today = await workspaceToday(db, workspaceId);
  const thisWeek = weekStart(today);
  const from = query.from && query.from > thisWeek ? query.from : thisWeek;
  const summary = await getDemandSummary(db, workspaceId, {
    from,
    to: query.to,
    itemIds: query.itemId ? [query.itemId] : undefined,
    itemCode: query.itemCode,
    itemType: query.itemType,
  });
  const itemIds = summary.rows.map((r) => r.item.id);
  let stock: Map<string, number> | null = null;
  if (access.stock) {
    stock = new Map();
    if (itemIds.length) {
      const perLot = lotBalances(db, workspaceId);
      const rows = await db
        .select({ itemId: stockLots.itemId, total: sql<string>`sum(${perLot.qty})` })
        .from(stockLots)
        .innerJoin(perLot, eq(perLot.lotId, stockLots.id))
        .where(
          and(
            eq(stockLots.workspaceId, workspaceId),
            isNull(stockLots.deletedAt),
            eq(stockLots.status, "available"),
            inArray(stockLots.itemId, itemIds),
            sql`(${stockLots.expiresOn} is null or ${stockLots.expiresOn} >= ${today})`,
          ),
        )
        .groupBy(stockLots.itemId);
      for (const r of rows) stock.set(r.itemId, Math.max(0, num(r.total)));
    }
  }
  let supply: Map<string, Map<string, number>> | null = null;
  if (access.production) {
    supply = new Map();
    if (itemIds.length) {
      const rows = await db
        .select({
          itemId: productionBatches.outputItemId,
          plannedOn: productionBatches.plannedOn,
          quantity: productionBatches.plannedQuantity,
        })
        .from(productionBatches)
        .where(
          and(
            eq(productionBatches.workspaceId, workspaceId),
            isNull(productionBatches.deletedAt),
            inArray(productionBatches.status, ["planned", "in_progress"]),
            inArray(productionBatches.outputItemId, itemIds),
            lte(productionBatches.plannedOn, addWeeks(summary.to, 1)),
          ),
        );
      for (const r of rows) {
        const week = weekStart(r.plannedOn) < summary.from ? summary.from : weekStart(r.plannedOn);
        const byWeek = supply.get(r.itemId) ?? new Map<string, number>();
        byWeek.set(week, (byWeek.get(week) ?? 0) + r.quantity);
        supply.set(r.itemId, byWeek);
      }
    }
  }
  return buildCoverage({ summary, stock, supply, shortOnly: query.shortOnly });
}
