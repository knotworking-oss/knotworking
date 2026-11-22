import {
  addDays,
  batchHours,
  freeQuantity,
  minutesToClock,
  planLineDay,
  projectDailyDemand,
  proposeLineDaySequence,
  reservationHeldOn,
  lineShiftMinutes,
  sortAllergens,
  stockAmount,
  weekStart,
  type AllergenCode,
  type DailyDemandQuery,
  type LineChangeoversSetInput,
  type LineDayQuery,
  type LineSequenceSetInput,
  type LineShiftsSetInput,
  type DayPlanBatch,
  type DayPlanLine,
} from "@knotworking/core";
import { lotBalances } from "./stock-ledger";
import {
  items,
  lockWorkspaceLog,
  productionBatches,
  productionChangeovers,
  productionLineShifts,
  productionReservations,
  recipes,
  recipeVersions,
  recordChanges,
  stockLots,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { ApiError, notFound } from "../errors";
import { getDemandSummary } from "./ports/demand";
import { salesCommitments } from "./ports/sales";
import { itemSummary, num } from "./ports/stock";
import { loadCalendar } from "./production-calendar";
import { changeoversOf, findLine, listLines, ratesOf, shiftsOf } from "./production-lines";
import { workspaceToday } from "./time-zone";

/**
 * Detailed scheduling (3.5.1): a line's shift windows and changeover rules, the timed plan of one
 * line on one day with its explained proposal, applying an order, and the daily demand view. Rules
 * are in `@knotworking/core` production-scheduling.ts. Advisory: nothing is reordered, moved or
 * refused except by applying an order on purpose.
 */

type ShiftRow = typeof productionLineShifts.$inferSelect;
type ChangeoverRow = typeof productionChangeovers.$inferSelect;
type BatchRow = typeof productionBatches.$inferSelect;

const strip = <T extends { workspaceId: string; deletedAt?: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _d, ...rest } = row;
  return rest;
};
const shiftChange = (row: ShiftRow): ChangeInput =>
  row.deletedAt
    ? { entity: "production_line_shift", entityId: row.id, action: "delete" }
    : { entity: "production_line_shift", entityId: row.id, action: "upsert", data: strip(row) };
const changeoverChange = (row: ChangeoverRow): ChangeInput =>
  row.deletedAt
    ? { entity: "production_changeover", entityId: row.id, action: "delete" }
    : { entity: "production_changeover", entityId: row.id, action: "upsert", data: strip(row) };
const batchChange = (row: BatchRow): ChangeInput => ({
  entity: "production_batch",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

const lineView = async (db: Executor, ws: string, id: string) =>
  (await listLines(db, ws)).lines.find((l) => l.id === id)!;

/** Replaces a line's shift windows. With none, its capacity is its hours per day again. */
export async function setLineShifts(
  db: Database,
  ws: string,
  actor: string,
  lineId: string,
  input: LineShiftsSetInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    await findLine(tx, ws, lineId);
    const removed = await tx
      .update(productionLineShifts)
      .set({ deletedAt: new Date() })
      .where(and(eq(productionLineShifts.lineId, lineId), isNull(productionLineShifts.deletedAt)))
      .returning();
    const added = input.shifts.length
      ? await tx
          .insert(productionLineShifts)
          .values(
            input.shifts.map((s) => ({
              workspaceId: ws,
              lineId,
              name: s.name,
              weekdays: [...new Set(s.weekdays)].sort(),
              ...lineShiftMinutes(s),
            })),
          )
          .returning()
      : [];
    await recordChanges(tx, ws, actor, [...removed, ...added].map(shiftChange));
  });
  return lineView(db, ws, lineId);
}

/** Replaces a line's changeover rules. Every recipe named must exist in the workspace. */
export async function setLineChangeovers(
  db: Database,
  ws: string,
  actor: string,
  lineId: string,
  input: LineChangeoversSetInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    await findLine(tx, ws, lineId);
    const named = [
      ...new Set(
        input.rules.flatMap((r) => [r.fromRecipeId, r.toRecipeId]).filter((id): id is string => !!id),
      ),
    ];
    if (named.length) {
      const found = await tx
        .select({ id: recipes.id })
        .from(recipes)
        .where(and(eq(recipes.workspaceId, ws), isNull(recipes.deletedAt), inArray(recipes.id, named)));
      if (found.length !== named.length) throw notFound("Recipe");
    }
    const removed = await tx
      .update(productionChangeovers)
      .set({ deletedAt: new Date() })
      .where(and(eq(productionChangeovers.lineId, lineId), isNull(productionChangeovers.deletedAt)))
      .returning();
    const added = input.rules.length
      ? await tx
          .insert(productionChangeovers)
          .values(
            input.rules.map((r) => ({
              workspaceId: ws,
              lineId,
              fromRecipeId: r.fromRecipeId,
              toRecipeId: r.toRecipeId,
              minutes: r.minutes,
              note: r.note || null,
            })),
          )
          .returning()
      : [];
    await recordChanges(tx, ws, actor, [...removed, ...added].map(changeoverChange));
  });
  return lineView(db, ws, lineId);
}

/** Live, uncancelled batches on a line's day, in their applied order (unordered ones last, by code). */
async function dayBatches(db: Executor, ws: string, lineId: string, date: string) {
  return db
    .select({ batch: productionBatches, recipe: recipes, version: recipeVersions, output: items })
    .from(productionBatches)
    .innerJoin(recipes, eq(recipes.id, productionBatches.recipeId))
    .innerJoin(recipeVersions, eq(recipeVersions.id, productionBatches.recipeVersionId))
    .innerJoin(items, eq(items.id, productionBatches.outputItemId))
    .where(
      and(
        eq(productionBatches.workspaceId, ws),
        eq(productionBatches.lineId, lineId),
        eq(productionBatches.plannedOn, date),
        isNull(productionBatches.deletedAt),
        ne(productionBatches.status, "cancelled"),
      ),
    )
    .orderBy(
      sql`${productionBatches.sequence} asc nulls last`,
      asc(productionBatches.batchCode),
      asc(productionBatches.id),
    );
}

/**
 * The timed plan of one line on one day (shift windows, changeovers, allergen clean-downs, crew,
 * overruns), in the applied order, and a proposed order with the reason for each place.
 */
export async function getLineDayPlan(db: Executor, ws: string, query: LineDayQuery) {
  const line = await findLine(db, ws, query.lineId);
  const rates = (await ratesOf(db, [line.id])).get(line.id) ?? {};
  const rows = await dayBatches(db, ws, line.id, query.date);
  const calendar = await loadCalendar(db, ws, query.date, query.date);
  const shifts = (await shiftsOf(db, [line.id])).get(line.id) ?? [];
  const rules = (await changeoversOf(db, [line.id])).get(line.id) ?? [];
  const crews = new Map(
    ((await lineView(db, ws, line.id))?.recipes ?? []).map((r) => [r.recipeId, r.crewSize] as const),
  );
  const dayOff = calendar.dayOff(query.date, line.id);
  const planLine: DayPlanLine = {
    id: line.id,
    name: line.name,
    hoursPerDay: line.hoursPerDay,
    shifts,
    changeoverMinutes: line.changeoverMinutes,
    allergenCleanMinutes: line.allergenCleanMinutes,
    crewAvailable: line.crewAvailable,
    changeovers: rules,
  };
  const batches: DayPlanBatch[] = rows.map(({ batch, version, output }) => {
    const hours = batchHours(batch.plannedQuantity, rates[batch.recipeId]);
    const approved = version.approvedAllergens;
    // Both the approved ingredient roll-up and the product's own declaration: either may list more.
    const contains = [...(approved?.contains ?? []), ...(output.allergens as AllergenCode[])];
    return {
      id: batch.id,
      batchCode: batch.batchCode,
      recipeId: batch.recipeId,
      status: batch.status,
      runMinutes: hours === null ? null : Math.round(hours * 60),
      crew: crews.get(batch.recipeId) ?? null,
      contains: sortAllergens(new Set(contains)),
      mayContain: sortAllergens(
        new Set(
          [...(approved?.mayContain ?? []), ...(output.mayContain as AllergenCode[])].filter(
            (a) => !contains.includes(a),
          ),
        ),
      ),
    };
  });
  const plan = planLineDay(planLine, query.date, dayOff, batches);
  const proposal = proposeLineDaySequence(planLine, query.date, dayOff, batches);
  const byId = new Map(rows.map((r) => [r.batch.id, r]));
  const clock = (m: number | null) => (m === null ? null : minutesToClock(m));
  return {
    line: {
      id: line.id,
      name: line.name,
      active: line.active,
      hoursPerDay: line.hoursPerDay,
      changeoverMinutes: line.changeoverMinutes,
      allergenCleanMinutes: line.allergenCleanMinutes,
      crewAvailable: line.crewAvailable,
    },
    ...plan,
    windows: plan.windows.map((w) => ({ ...w, startClock: clock(w.start), endClock: clock(w.end) })),
    endClock: clock(plan.endMinute),
    steps: plan.steps.map((s) => {
      const { batch, recipe, output } = byId.get(s.batchId)!;
      const b = batches.find((x) => x.id === s.batchId)!;
      return {
        ...s,
        status: batch.status,
        sequence: batch.sequence,
        recipe: { id: recipe.id, code: recipe.code, name: recipe.name },
        planned: stockAmount(batch.plannedQuantity, output),
        allergens: { contains: b.contains, mayContain: b.mayContain },
        changeoverStartClock: clock(s.changeoverStart),
        startClock: clock(s.start),
        endClock: clock(s.end),
      };
    }),
    proposal: {
      ...proposal,
      current: { ...proposal.current, endClock: clock(proposal.current.endMinute) },
      proposed: { ...proposal.proposed, endClock: clock(proposal.proposed.endMinute) },
    },
  };
}

/**
 * Applies an order to a line's day: `batchIds` must be exactly its live, uncancelled batches, so an
 * order made against a stale view is refused (`sequence_stale`) rather than half-applied.
 */
export async function setLineSequence(db: Database, ws: string, actor: string, input: LineSequenceSetInput) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    await findLine(tx, ws, input.lineId);
    const rows = await dayBatches(tx, ws, input.lineId, input.date);
    const live = new Set(rows.map((r) => r.batch.id));
    if (live.size !== input.batchIds.length || input.batchIds.some((id) => !live.has(id))) {
      throw new ApiError(
        409,
        "sequence_stale",
        "The batches on this line and day have changed; reload the plan and order them again",
      );
    }
    // Someone else saved an order since this one was read: refuse rather than silently overwrite.
    if (
      input.expectedBatchIds &&
      (input.expectedBatchIds.length !== rows.length ||
        rows.some((r, i) => r.batch.id !== input.expectedBatchIds![i]))
    ) {
      throw new ApiError(
        409,
        "sequence_stale",
        "Someone else changed the order of this day; reload the plan and order it again",
      );
    }
    const changes: ChangeInput[] = [];
    for (const [i, id] of input.batchIds.entries()) {
      const current = rows.find((r) => r.batch.id === id)!.batch;
      if (current.sequence === i + 1) continue;
      const [row] = await tx
        .update(productionBatches)
        .set({ sequence: i + 1 })
        .where(eq(productionBatches.id, id))
        .returning();
      changes.push(batchChange(row!));
    }
    if (changes.length) await recordChanges(tx, ws, actor, changes);
  });
  return getLineDayPlan(db, ws, { lineId: input.lineId, date: input.date });
}

// ─── Daily demand ────────────────────────────────────────────────────────────

/**
 * Per product per day from today: confirmed sales commitments due (outstanding), planned batch
 * output, and the running projection from today's free stock. Weekly demand from the demand module
 * is listed beside it and never added in (an order and its forecast are not counted twice). Each
 * source appears only when the caller may read its module (`basis`).
 */
export async function getDailyDemand(
  db: Database,
  ws: string,
  query: DailyDemandQuery,
  access: { sales: boolean; stock: boolean; demand: boolean },
) {
  const today = await workspaceToday(db, ws);
  const last = addDays(today, query.days - 1);
  const days = Array.from({ length: query.days }, (_, i) => addDays(today, i));

  // Commitments: overdue ones (due before today, still outstanding) count on today.
  const committed = new Map<string, Map<string, number>>();
  const overdue = new Map<string, number>();
  const add = (map: Map<string, Map<string, number>>, item: string, day: string, qty: number) => {
    const byDay = map.get(item) ?? new Map<string, number>();
    byDay.set(day, (byDay.get(day) ?? 0) + qty);
    map.set(item, byDay);
  };
  if (access.sales) {
    // Offset pages are separate reads: a line seen on two pages (rows shifted between reads) counts once.
    const seen = new Set<string>();
    for (let offset = 0; ; offset += 100) {
      const page = await salesCommitments(db, ws, {
        from: addDays(last, -366),
        to: last,
        limit: 100,
        offset,
      });
      for (const l of page.lines) {
        if (seen.has(l.lineId)) continue;
        seen.add(l.lineId);
        if (query.itemId && l.itemId !== query.itemId) continue;
        if (l.outstanding <= 0) continue;
        if (l.dueOn < today) overdue.set(l.itemId, (overdue.get(l.itemId) ?? 0) + l.outstanding);
        add(committed, l.itemId, l.dueOn < today ? today : l.dueOn, l.outstanding);
      }
      if (offset + 100 >= page.total) break;
    }
  }

  // Planned output: open batches whose date has passed count on today.
  const planned = new Map<string, Map<string, number>>();
  const late = new Map<string, number>();
  const batchRows = await db
    .select({
      itemId: productionBatches.outputItemId,
      plannedOn: productionBatches.plannedOn,
      quantity: productionBatches.plannedQuantity,
    })
    .from(productionBatches)
    .where(
      and(
        eq(productionBatches.workspaceId, ws),
        isNull(productionBatches.deletedAt),
        inArray(productionBatches.status, ["planned", "in_progress"]),
        lte(productionBatches.plannedOn, last),
        query.itemId ? eq(productionBatches.outputItemId, query.itemId) : undefined,
      ),
    );
  for (const b of batchRows) {
    if (b.plannedOn < today) late.set(b.itemId, (late.get(b.itemId) ?? 0) + b.quantity);
    add(planned, b.itemId, b.plannedOn < today ? today : b.plannedOn, b.quantity);
  }

  const itemIds = [...new Set([...committed.keys(), ...planned.keys()])];
  const itemRows = itemIds.length
    ? await db
        .select()
        .from(items)
        .where(and(eq(items.workspaceId, ws), inArray(items.id, itemIds)))
        .orderBy(asc(items.code))
    : [];

  let stock: Map<string, number> | null = null;
  if (access.stock) {
    stock = new Map();
    if (itemIds.length) {
      const perLot = lotBalances(db, ws);
      const rows = await db
        .select({ lotId: stockLots.id, itemId: stockLots.itemId, total: perLot.qty })
        .from(stockLots)
        .innerJoin(perLot, eq(perLot.lotId, stockLots.id))
        .where(
          and(
            eq(stockLots.workspaceId, ws),
            isNull(stockLots.deletedAt),
            eq(stockLots.status, "available"),
            inArray(stockLots.itemId, itemIds),
            sql`(${stockLots.expiresOn} is null or ${stockLots.expiresOn} >= ${today})`,
          ),
        );
      // Free stock: each lot's balance less what active reservations still hold of it.
      const reserved = new Map<string, number>();
      const held = rows.length
        ? await db
            .select()
            .from(productionReservations)
            .where(
              and(
                eq(productionReservations.workspaceId, ws),
                eq(productionReservations.status, "active"),
                inArray(
                  productionReservations.lotId,
                  rows.map((r) => r.lotId),
                ),
              ),
            )
        : [];
      for (const r of held) reserved.set(r.lotId, (reserved.get(r.lotId) ?? 0) + reservationHeldOn(r, today));
      for (const r of rows)
        stock.set(
          r.itemId,
          (stock.get(r.itemId) ?? 0) + freeQuantity(Math.max(0, num(r.total)), reserved.get(r.lotId) ?? 0),
        );
    }
  }

  const weekly = new Map<string, { periodStart: string; week: string; quantity: number }[]>();
  if (access.demand && itemIds.length) {
    const summary = await getDemandSummary(db, ws, {
      from: weekStart(today),
      to: weekStart(last),
      itemIds,
    });
    for (const row of summary.rows)
      weekly.set(
        row.item.id,
        row.periods.map((p) => ({ periodStart: p.periodStart, week: p.week, quantity: p.quantity.base })),
      );
  }

  const rows = itemRows.map((item) => {
    const opening = stock ? (stock.get(item.id) ?? 0) : null;
    const projection = projectDailyDemand(
      opening,
      days.map((date) => ({
        date,
        committed: committed.get(item.id)?.get(date) ?? 0,
        planned: planned.get(item.id)?.get(date) ?? 0,
      })),
    );
    return {
      item: itemSummary(item),
      baseUnit: stockAmount(0, item).baseUnit,
      opening: opening === null ? null : stockAmount(opening, item),
      overdueCommitted: overdue.get(item.id) ?? 0,
      latePlanned: late.get(item.id) ?? 0,
      days: projection.days,
      firstShortDate: projection.firstShortDate,
      weeklyDemand: access.demand ? (weekly.get(item.id) ?? []) : null,
    };
  });
  return {
    from: today,
    to: last,
    days,
    basis: {
      salesCommitments: access.sales,
      stock: access.stock,
      weeklyDemand: access.demand,
      /** Weekly demand is shown beside the daily figures, never added to them. */
      weeklyDemandCombined: false as const,
    },
    items: rows,
    shortItems: rows.filter((r) => r.firstShortDate).length,
  };
}
