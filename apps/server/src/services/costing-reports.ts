import {
  adjustmentCosts,
  adjustmentCostTypes,
  adjustmentsCsv,
  applyFrozenPeriods,
  batchesCsv,
  closeSummary,
  COSTING_REPORT_MAX_BATCHES,
  costingPeriodOf,
  costingPeriodStart,
  costingReport,
  costingReportRange,
  journalCsv,
  noAdjustmentCosts,
  stockAmount,
  stockValuation,
  units,
  valuationCsv,
  type AdjustmentCostLine,
  type AdjustmentCostTotals,
  type CostingCloseInput,
  type CostingCloseListQuery,
  type CostingCloseSnapshot,
  type CostingExportQuery,
  type CostingPeriod,
  type CostingReportRowView,
  type CostingValuationQuery,
  type FrozenBatch,
  type FrozenPeriodInfo,
  type JournalPeriod,
  type CostingAdjustmentsQuery,
  type CostingReportQuery,
  dateInZone,
  effectiveCurrency,
  endOfDayInZone,
  startOfDayInZone,
} from "@knotworking/core";
import { lotBalances } from "./stock-ledger";
import {
  costingPeriodCloses,
  items,
  lockWorkspaceLog,
  productionBatches,
  recordChanges,
  stockLots,
  stockMovements,
  users,
  workspaces,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { batchConversion, loadGraph } from "./costing";
import { absorptionRateEntries } from "./costing-settings";
import { itemSummary, num } from "./ports/stock";
import { workspaceTimeZone } from "./time-zone";

/**
 * Costing reports built on the engine in `costing.ts`: the period report (standard against
 * actual, with labour and overhead absorbed and the cost of waste and adjustments beside it, and
 * closed periods shown frozen), period closes, the stock valuation and the CSV exports.
 */

type ItemRow = typeof items.$inferSelect;

const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;

// ─── Waste and adjustments ───────────────────────────────────────────────────

/**
 * Waste, stock adjustments and stocktake differences posted in a window (local days), each valued
 * at its lot's cost. Reversals are movements of the same type and net the original off.
 */
async function adjustmentMovements(
  db: Executor,
  workspaceId: string,
  from: string,
  to: string,
  timeZone: string,
  itemId?: string,
) {
  const rows = await db
    .select({
      type: stockMovements.type,
      itemId: stockMovements.itemId,
      lotId: stockMovements.lotId,
      quantity: stockMovements.quantity,
      occurredAt: stockMovements.occurredAt,
    })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.workspaceId, workspaceId),
        inArray(stockMovements.type, [...adjustmentCostTypes]),
        gte(stockMovements.occurredAt, startOfDayInZone(from, timeZone)),
        lt(stockMovements.occurredAt, endOfDayInZone(to, timeZone)),
        itemId ? eq(stockMovements.itemId, itemId) : undefined,
      ),
    );
  const loaded = await loadGraph(db, workspaceId, [], [...new Set(rows.map((r) => r.lotId))]);
  return {
    loaded,
    movements: rows.map((r) => ({
      type: r.type as (typeof adjustmentCostTypes)[number],
      itemId: r.itemId,
      quantity: r.quantity,
      occurredOn: dateInZone(r.occurredAt, timeZone),
      unitCost: loaded.engine.lotCost(r.lotId)?.unitCost ?? null,
    })),
  };
}

/** Items of the movements, for the units; items with movements but no lot cost are loaded too. */
async function unitsFor(db: Executor, workspaceId: string, itemIds: readonly string[]) {
  const ids = [...new Set(itemIds)];
  if (!ids.length) return new Map<string, ItemRow>();
  const rows = await db
    .select()
    .from(items)
    .where(and(eq(items.workspaceId, workspaceId), inArray(items.id, ids)));
  return new Map(rows.map((r) => [r.id, r]));
}

const presentAdjustmentLines = (lines: AdjustmentCostLine[], itemMap: ReadonlyMap<string, ItemRow>) =>
  lines.map((l) => {
    const item = itemMap.get(l.itemId)!;
    return {
      ...l,
      item: itemSummary(item),
      amount: stockAmount(l.quantity, item),
      unvaluedAmount: stockAmount(l.unvaluedQuantity, item),
    };
  });

/** `GET /costing/adjustments`: what waste and stock adjustments cost in a window, by type and item. */
export async function getAdjustmentCosts(
  db: Executor,
  workspaceId: string,
  query: CostingAdjustmentsQuery,
  today: string,
) {
  const range = costingReportRange({ period: "month", from: query.from, to: query.to }, today);
  if (range.error) throw badRequest(range.error);
  const timeZone = await workspaceTimeZone(db, workspaceId);
  const { movements } = await adjustmentMovements(
    db,
    workspaceId,
    range.from,
    range.to,
    timeZone,
    query.itemId,
  );
  const itemMap = await unitsFor(
    db,
    workspaceId,
    movements.map((m) => m.itemId),
  );
  const { lines, totals } = adjustmentCosts({
    movements,
    units: new Map([...itemMap.values()].map((i) => [i.id, i.unit])),
  });
  return { from: range.from, to: range.to, totals, lines: presentAdjustmentLines(lines, itemMap) };
}

// ─── The period report ───────────────────────────────────────────────────────

/** A closed period's frozen figures, by the day the period starts. */
async function frozenPeriods(
  db: Executor,
  workspaceId: string,
  period: CostingPeriod,
  periodStarts: readonly string[],
) {
  const map = new Map<string, { snapshot: CostingCloseSnapshot; info: Omit<FrozenPeriodInfo, "drift"> }>();
  if (!periodStarts.length) return map;
  const rows = await db
    .select({ close: costingPeriodCloses, by: users.name })
    .from(costingPeriodCloses)
    .leftJoin(users, eq(users.id, costingPeriodCloses.closedBy))
    .where(
      and(
        eq(costingPeriodCloses.workspaceId, workspaceId),
        eq(costingPeriodCloses.period, period),
        eq(costingPeriodCloses.status, "closed"),
        inArray(costingPeriodCloses.periodStart, [...periodStarts]),
      ),
    );
  for (const { close, by } of rows) {
    map.set(close.periodStart, {
      snapshot: close.snapshot,
      info: {
        closeId: close.id,
        closedAt: close.closedAt.toISOString(),
        closedBy: close.closedBy && by ? { id: close.closedBy, name: by } : null,
        note: close.note,
      },
    });
  }
  return map;
}

/**
 * The live period report with everything the pages and the snapshot need: the core report (with
 * conversion costs), enriched rows, each batch's headline figures and the cost of waste and
 * adjustments per period. Closed periods are not swapped in here (`getCostingReport` does that).
 */
async function liveReport(
  db: Executor,
  workspaceId: string,
  query: {
    period: CostingPeriod;
    from: string;
    to: string;
    outputItemId?: string | undefined;
    recipeId?: string | undefined;
  },
) {
  // Completion dates are local dates in the workspace's time zone: compare instants with the
  // bounds of the local days.
  const timeZone = await workspaceTimeZone(db, workspaceId);
  const where: (SQL | undefined)[] = [
    eq(productionBatches.workspaceId, workspaceId),
    isNull(productionBatches.deletedAt),
    eq(productionBatches.status, "completed"),
    gte(productionBatches.completedAt, startOfDayInZone(query.from, timeZone)),
    lt(productionBatches.completedAt, endOfDayInZone(query.to, timeZone)),
  ];
  if (query.outputItemId) where.push(eq(productionBatches.outputItemId, query.outputItemId));
  if (query.recipeId) where.push(eq(productionBatches.recipeId, query.recipeId));
  const rows = await db
    .select()
    .from(productionBatches)
    .where(and(...where))
    .orderBy(asc(productionBatches.completedAt), asc(productionBatches.id))
    .limit(COSTING_REPORT_MAX_BATCHES + 1);
  if (rows.length > COSTING_REPORT_MAX_BATCHES) {
    throw badRequest(
      `More than ${COSTING_REPORT_MAX_BATCHES} batches were completed in this window; choose a shorter one or one product`,
    );
  }
  const loaded = await loadGraph(
    db,
    workspaceId,
    rows.map((r) => r.id),
  );
  const rates = await absorptionRateEntries(db, workspaceId);
  const outputs = [...new Set(rows.map((r) => r.outputItemId))]
    .map((id) => loaded.items.get(id)!)
    .sort((a, b) => a.code.localeCompare(b.code));
  const costed = rows.map((row) => {
    const cost = loaded.engine.batchCost(row.id);
    return {
      row,
      cost,
      conversion: batchConversion(row, loaded, rates, cost.produced),
      completedOn: dateInZone(row.completedAt!, timeZone),
    };
  });
  const report = costingReport({
    period: query.period,
    from: query.from,
    to: query.to,
    batches: costed.map((c) => ({
      outputItemId: c.row.outputItemId,
      completedOn: c.completedOn,
      cost: c.cost,
      conversion: c.conversion,
    })),
    itemUnits: new Map(outputs.map((i) => [i.id, i.unit])),
    itemOrder: outputs.map((i) => i.id),
  });
  const reportRows: CostingReportRowView[] = report.rows.map((row) => {
    const item = loaded.items.get(row.itemId)!;
    return {
      ...row,
      item: itemSummary(item),
      planned: stockAmount(row.planned, item),
      produced: stockAmount(row.produced, item),
    };
  });
  const batches: (FrozenBatch & { periodStart: string; provisional: boolean })[] = costed.map((c) => {
    const item = loaded.items.get(c.row.outputItemId)!;
    return {
      id: c.row.id,
      batchCode: c.row.batchCode,
      outputItemId: item.id,
      outputItemCode: item.code,
      outputItemName: item.name,
      unit: item.unit,
      planned: stockAmount(c.cost.planned, item).display,
      produced: stockAmount(c.cost.produced, item).display,
      completedOn: c.completedOn,
      actualCost: c.cost.actualCost,
      estimatedCost: c.cost.estimatedCost,
      costComplete: c.cost.costComplete && c.cost.standard.complete,
      labour: c.conversion.labour,
      overhead: c.conversion.overhead,
      standardCost: c.cost.standard.producedCost,
      variance: c.cost.variance.total,
      periodStart: costingPeriodStart(c.completedOn, query.period),
      provisional: c.cost.provisional,
    };
  });

  // Waste and adjustments per period.
  const { movements, loaded: moved } = await adjustmentMovements(
    db,
    workspaceId,
    query.from,
    query.to,
    timeZone,
  );
  const movedItems = await unitsFor(
    db,
    workspaceId,
    movements.map((m) => m.itemId),
  );
  const movedUnits = new Map([...movedItems.values(), ...moved.items.values()].map((i) => [i.id, i.unit]));
  const adjustmentsByPeriod = new Map<
    string,
    { totals: AdjustmentCostTotals; lines: AdjustmentCostLine[] }
  >();
  for (const periodStart of new Set(movements.map((m) => costingPeriodStart(m.occurredOn, query.period)))) {
    adjustmentsByPeriod.set(
      periodStart,
      adjustmentCosts({
        movements: movements.filter((m) => costingPeriodStart(m.occurredOn, query.period) === periodStart),
        units: movedUnits,
      }),
    );
  }
  const itemInfo = new Map([...movedItems, ...loaded.items]);
  return { timeZone, report, reportRows, batches, adjustmentsByPeriod, itemInfo };
}

const sumAdjustments = (list: readonly AdjustmentCostTotals[]): AdjustmentCostTotals => {
  const r = (n: number) => Math.round(n * 10_000) / 10_000;
  const t = { ...noAdjustmentCosts };
  for (const a of list) {
    t.waste = r(t.waste + a.waste);
    t.adjustment = r(t.adjustment + a.adjustment);
    t.stocktake = r(t.stocktake + a.stocktake);
    t.incomplete ||= a.incomplete;
    t.movements += a.movements;
  }
  t.total = r(t.waste + t.adjustment + t.stocktake);
  return t;
};

/**
 * Standard against actual by product and period (`costingReport`), with labour and overhead
 * absorbed shown apart from materials, the cost of waste and adjustments per period, and closed
 * periods frozen: their totals and rows are the snapshot's, with `frozen` saying who closed them
 * and how far today's figures have drifted. Also returns every batch's headline figures (frozen
 * periods' from their snapshot) for exports.
 */
export async function getCostingReportWithBatches(
  db: Executor,
  workspaceId: string,
  query: {
    period: CostingPeriod;
    from: string;
    to: string;
    outputItemId?: string | undefined;
    recipeId?: string | undefined;
  },
) {
  const live = await liveReport(db, workspaceId, query);
  const frozen = await frozenPeriods(
    db,
    workspaceId,
    query.period,
    live.report.periods.map((p) => p.periodStart),
  );
  const merged = applyFrozenPeriods(live.report, live.reportRows, frozen);
  // A frozen period is for the whole workspace: a product filter shows live figures instead.
  const filtered = Boolean(query.outputItemId || query.recipeId);
  const used = filtered ? applyFrozenPeriods(live.report, live.reportRows, new Map()) : merged;
  const periods = used.periods.map((p) => {
    const snapshot = frozen.get(p.periodStart)?.snapshot;
    const adjustments =
      snapshot && !filtered
        ? snapshot.adjustments.totals
        : (live.adjustmentsByPeriod.get(p.periodStart)?.totals ?? noAdjustmentCosts);
    return { ...p, adjustments };
  });
  const batches = [
    ...live.batches.filter((b) => filtered || !frozen.has(b.periodStart)),
    ...(filtered ? [] : [...frozen.values()].flatMap((f) => f.snapshot.batches)),
  ].sort((a, b) => a.completedOn.localeCompare(b.completedOn) || a.batchCode.localeCompare(b.batchCode));
  return {
    report: {
      period: live.report.period,
      from: live.report.from,
      to: live.report.to,
      periods,
      rows: used.rows,
      totals: used.totals,
      adjustments: sumAdjustments(periods.map((p) => p.adjustments)),
    },
    batches,
    live,
  };
}

export async function getCostingReport(
  db: Executor,
  workspaceId: string,
  query: Pick<CostingReportQuery, "outputItemId" | "recipeId"> & {
    period: CostingPeriod;
    from: string;
    to: string;
  },
) {
  return (await getCostingReportWithBatches(db, workspaceId, query)).report;
}

// ─── Closing a period ────────────────────────────────────────────────────────

type CloseRow = typeof costingPeriodCloses.$inferSelect;

/** The close without its snapshot: what lists and the sync log carry. */
const closeHeader = (row: CloseRow) => {
  const { workspaceId: _ws, deletedAt: _deleted, snapshot: _snapshot, ...rest } = row;
  return rest;
};
const closeChange = (row: CloseRow) => ({
  entity: "costing_period_close" as const,
  entityId: row.id,
  action: "upsert" as const,
  data: closeHeader(row),
});

async function userNames(db: Executor, ids: readonly string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((u) => [u.id, u.name]));
}

export async function listCloses(db: Executor, workspaceId: string, query: CostingCloseListQuery) {
  const closer = users;
  const rows = await db
    .select({ close: costingPeriodCloses, closedByName: closer.name })
    .from(costingPeriodCloses)
    .leftJoin(closer, eq(closer.id, costingPeriodCloses.closedBy))
    .where(
      and(
        eq(costingPeriodCloses.workspaceId, workspaceId),
        query.period ? eq(costingPeriodCloses.period, query.period) : undefined,
        query.status ? eq(costingPeriodCloses.status, query.status) : undefined,
      ),
    )
    .orderBy(desc(costingPeriodCloses.periodStart), desc(costingPeriodCloses.closedAt))
    .limit(query.limit)
    .offset(query.offset);
  const names = await userNames(
    db,
    rows.flatMap((r) => (r.close.reopenedBy ? [r.close.reopenedBy] : [])),
  );
  return {
    closes: rows.map(({ close, closedByName }) => ({
      ...closeHeader(close),
      closedByName,
      reopenedByName: close.reopenedBy ? (names.get(close.reopenedBy) ?? null) : null,
    })),
  };
}

export async function getClose(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(costingPeriodCloses)
    .where(and(eq(costingPeriodCloses.id, id), eq(costingPeriodCloses.workspaceId, workspaceId)));
  if (!row) throw notFound("Costing close");
  const names = await userNames(
    db,
    [row.closedBy, row.reopenedBy].filter((v): v is string => !!v),
  );
  const name = (uid: string | null) => (uid ? (names.get(uid) ?? null) : null);
  return {
    ...closeHeader(row),
    snapshot: row.snapshot,
    closedByName: name(row.closedBy),
    reopenedByName: name(row.reopenedBy),
  };
}

/**
 * Signs a period off and freezes its figures. A person with `manage` does it (the route refuses
 * tokens). The period must have ended; batches with incomplete or provisional costs need
 * `acknowledgeGaps`. The snapshot is the live report for that period, the batches in it and the
 * cost of waste and adjustments; the sync log carries the close without it.
 */
export async function closePeriod(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: CostingCloseInput,
  today: string,
) {
  const range = costingPeriodOf(input.period, input.of);
  if (!range) throw badRequest(`"${input.of}" is not a date, week (2026-W46) or month (2026-11)`);
  if (range.periodEnd >= today) {
    throw new ApiError(
      409,
      "period_not_ended",
      `${range.label} hasn't ended yet; a period can be closed once its last day has passed`,
    );
  }
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [already] = await tx
      .select({ id: costingPeriodCloses.id })
      .from(costingPeriodCloses)
      .where(
        and(
          eq(costingPeriodCloses.workspaceId, workspaceId),
          eq(costingPeriodCloses.period, input.period),
          eq(costingPeriodCloses.periodStart, range.periodStart),
          eq(costingPeriodCloses.status, "closed"),
        ),
      );
    if (already)
      throw new ApiError(409, "period_closed", `${range.label} is already closed; reopen it first`);
    const live = await liveReport(tx, workspaceId, {
      period: input.period,
      from: range.periodStart,
      to: range.periodEnd,
    });
    const period = live.report.periods.find((p) => p.periodStart === range.periodStart);
    const totals = period?.totals ?? live.report.totals;
    const provisional = live.batches.filter((b) => b.provisional).length;
    if (
      (totals.incompleteBatches > 0 || provisional > 0 || totals.conversion.incompleteBatches > 0) &&
      !input.acknowledgeGaps
    ) {
      const parts = [
        totals.incompleteBatches
          ? `${totals.incompleteBatches} batch(es) with an incomplete cost or standard`
          : "",
        provisional ? `${provisional} batch(es) resting on a batch still in progress` : "",
        totals.conversion.incompleteBatches
          ? `${totals.conversion.incompleteBatches} batch(es) missing the hours or kilograms an absorption rate needs`
          : "",
      ].filter(Boolean);
      throw new ApiError(
        409,
        "period_has_gaps",
        `${range.label} has ${parts.join(" and ")}. Close it anyway by acknowledging the gaps.`,
      );
    }
    const adjustments = live.adjustmentsByPeriod.get(range.periodStart) ?? {
      totals: noAdjustmentCosts,
      lines: [],
    };
    const snapshot: CostingCloseSnapshot = {
      version: 1,
      currency: await workspaceCurrency(tx, workspaceId),
      period: input.period,
      periodStart: range.periodStart,
      periodEnd: range.periodEnd,
      totals,
      rows: live.reportRows.filter((r) => r.periodStart === range.periodStart),
      batches: live.batches
        .filter((b) => b.periodStart === range.periodStart)
        .map(({ periodStart: _p, provisional: _v, ...b }) => b),
      adjustments: {
        totals: adjustments.totals,
        lines: adjustments.lines.map((l) => {
          const item = live.itemInfo.get(l.itemId)!;
          return { ...l, itemCode: item.code, itemName: item.name };
        }),
      },
    };
    const [row] = await tx
      .insert(costingPeriodCloses)
      .values({
        workspaceId,
        period: input.period,
        periodStart: range.periodStart,
        periodEnd: range.periodEnd,
        status: "closed",
        summary: closeSummary(snapshot),
        snapshot,
        note: input.note ?? null,
        closedBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [closeChange(row!)]);
    return row!.id;
  });
  return getClose(db, workspaceId, id);
}

/**
 * Reopens a closed period (`manage`, a person, with a reason). The close stays on record as
 * `reopened` with who and why; the period's figures are live again until it is closed afresh.
 */
export async function reopenPeriod(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  reason: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [current] = await tx
      .select()
      .from(costingPeriodCloses)
      .where(and(eq(costingPeriodCloses.id, id), eq(costingPeriodCloses.workspaceId, workspaceId)));
    if (!current) throw notFound("Costing close");
    if (current.status !== "closed")
      throw new ApiError(409, "not_closed", "This period was already reopened");
    const [row] = await tx
      .update(costingPeriodCloses)
      .set({ status: "reopened", reopenedBy: actorId, reopenedAt: new Date(), reopenReason: reason })
      .where(eq(costingPeriodCloses.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [closeChange(row!)]);
  });
  return getClose(db, workspaceId, id);
}

async function workspaceCurrency(db: Executor, workspaceId: string) {
  const [row] = await db
    .select({ currency: workspaces.currency })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return effectiveCurrency(row?.currency);
}

// ─── Stock valuation ─────────────────────────────────────────────────────────

/**
 * Stock on hand valued at lot cost (the costing engine's: invoice or purchase price, the batch
 * that made it, or the standard cost, flagged as estimated). Per lot and per item, as of now.
 * Materials only: absorbed labour and overhead are not in a lot's cost.
 */
export async function getStockValuation(
  db: Executor,
  workspaceId: string,
  query: CostingValuationQuery,
  today: string,
) {
  const perLot = lotBalances(db, workspaceId, { positiveOnly: true });
  const where: (SQL | undefined)[] = [
    eq(stockLots.workspaceId, workspaceId),
    isNull(stockLots.deletedAt),
    query.status ? eq(stockLots.status, query.status) : undefined,
    query.itemType ? eq(items.type, query.itemType) : undefined,
    query.q
      ? or(
          sql`${items.name} ilike ${like(query.q)} escape '!'`,
          sql`${items.code} ilike ${like(query.q)} escape '!'`,
          sql`${stockLots.lotCode} ilike ${like(query.q)} escape '!'`,
        )
      : undefined,
  ];
  const rows = await db
    .select({ lot: stockLots, item: items, qty: perLot.qty })
    .from(stockLots)
    .innerJoin(perLot, eq(perLot.lotId, stockLots.id))
    .innerJoin(items, eq(items.id, stockLots.itemId))
    .where(and(...where))
    .orderBy(asc(items.code), asc(stockLots.receivedOn), asc(stockLots.lotCode));
  const loaded = await loadGraph(
    db,
    workspaceId,
    [],
    rows.map((r) => r.lot.id),
  );
  const valuation = stockValuation({
    units: new Map(rows.map((r) => [r.item.id, r.item.unit])),
    lots: rows.map((r) => ({
      lotId: r.lot.id,
      lotCode: r.lot.lotCode,
      itemId: r.item.id,
      status: r.lot.status,
      receivedOn: r.lot.receivedOn,
      expiresOn: r.lot.expiresOn,
      quantity: num(r.qty),
      cost: loaded.engine.lotCost(r.lot.id),
    })),
  });
  const itemMap = new Map(rows.map((r) => [r.item.id, r.item]));
  return {
    asOf: today,
    totals: valuation.totals,
    items: valuation.items.map((i) => ({
      ...i,
      item: itemSummary(itemMap.get(i.itemId)!),
      amount: stockAmount(i.quantity, itemMap.get(i.itemId)!),
    })),
    lots: valuation.lots.map(({ cost, ...lot }) => {
      const item = itemMap.get(lot.itemId)!;
      return {
        ...lot,
        item: itemSummary(item),
        amount: stockAmount(lot.quantity, item),
        unitCost: cost?.unitCost ?? null,
        unit: item.unit,
        source: cost?.source ?? "missing",
        estimatedPercent: cost?.estimatedPercent ?? 0,
        provisional: cost?.provisional ?? false,
      };
    }),
  };
}

// ─── CSV exports ─────────────────────────────────────────────────────────────

/** A generic CSV for accounting: the cost journal, batches, stock valuation or waste and adjustments. */
export async function costingExport(
  db: Executor,
  workspaceId: string,
  query: CostingExportQuery,
  today: string,
): Promise<{ csv: string; fileName: string }> {
  const currency = await workspaceCurrency(db, workspaceId);
  if (query.kind === "valuation") {
    const v = await getStockValuation(db, workspaceId, { status: query.status }, today);
    return {
      fileName: `stock-valuation-${today}.csv`,
      csv: valuationCsv({
        currency,
        asOf: v.asOf,
        lots: v.lots.map((l) => ({
          itemCode: l.item.code,
          itemName: l.item.name,
          lotCode: l.lotCode,
          status: l.status,
          receivedOn: l.receivedOn,
          expiresOn: l.expiresOn,
          quantity: l.amount.display,
          unit: units[l.amount.displayUnit].label,
          unitCost: l.unitCost,
          value: l.value,
          source: l.source,
          estimatedPercent: l.estimatedPercent,
        })),
      }),
    };
  }
  const range = costingReportRange({ period: query.period, from: query.from, to: query.to }, today);
  if (range.error) throw badRequest(range.error);
  if (query.kind === "adjustments") {
    const a = await getAdjustmentCosts(db, workspaceId, { from: range.from, to: range.to }, today);
    return {
      fileName: `waste-and-adjustments-${range.from}-${range.to}.csv`,
      csv: adjustmentsCsv({
        currency,
        from: range.from,
        to: range.to,
        lines: a.lines.map((l) => ({
          type: l.type,
          itemCode: l.item.code,
          itemName: l.item.name,
          quantity: l.amount.display,
          unit: units[l.amount.displayUnit].label,
          loss: l.loss,
          movements: l.movements,
          unvaluedQuantity: l.unvaluedAmount.display,
        })),
      }),
    };
  }
  const { report, batches } = await getCostingReportWithBatches(db, workspaceId, {
    period: query.period,
    from: range.from,
    to: range.to,
  });
  if (query.kind === "batches") {
    return {
      fileName: `batch-costs-${range.from}-${range.to}.csv`,
      csv: batchesCsv({
        currency,
        batches: batches.map((b) => ({
          batchCode: b.batchCode,
          completedOn: b.completedOn,
          itemCode: b.outputItemCode,
          itemName: b.outputItemName,
          unit: units[b.unit].label,
          produced: b.produced,
          planned: b.planned,
          materials: b.actualCost,
          labour: b.labour,
          overhead: b.overhead,
          standardCost: b.standardCost,
          variance: b.variance,
          costComplete: b.costComplete,
        })),
      }),
    };
  }
  const journal: JournalPeriod[] = report.periods
    .map((p): JournalPeriod => {
      const rows = report.rows.filter((r) => r.periodStart === p.periodStart);
      return {
        periodStart: p.periodStart,
        periodEnd: costingPeriodOf(query.period, p.periodStart)!.periodEnd,
        label: p.period,
        frozen: Boolean(p.frozen),
        rows: rows.map((r) => ({
          itemCode: r.item.code,
          itemName: r.item.name,
          unit: units[r.produced.displayUnit].label,
          produced: r.produced.display,
          batches: r.batches,
          materials: r.actualCost,
          labour: r.conversion.labour,
          overhead: r.conversion.overhead,
        })),
        adjustments: {
          waste: p.adjustments.waste,
          adjustment: p.adjustments.adjustment,
          stocktake: p.adjustments.stocktake,
        },
      };
    })
    .filter(
      (p) => p.rows.length > 0 || p.adjustments.waste || p.adjustments.adjustment || p.adjustments.stocktake,
    );
  return {
    fileName: `cost-journal-${range.from}-${range.to}.csv`,
    csv: journalCsv({ currency, period: query.period, periods: journal }),
  };
}
