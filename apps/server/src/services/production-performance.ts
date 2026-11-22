import {
  absorptionRateOn,
  addDays,
  batchHours,
  batchRunHours,
  computeOee,
  siteOee,
  dateInZone,
  downtimeCategory,
  downtimeReasonInfo,
  lineCapacityHours,
  oeeDefinitions,
  rejectReasonLabels,
  roundQuantity,
  stockAmount,
  type AbsorptionRateEntry,
  type DowntimeReason,
  type DowntimeRecordInput,
  type LabourRecordInput,
  type PerformanceQuery,
  type PerformanceVoidInput,
  type RejectReason,
  type RejectRecordInput,
} from "@knotworking/core";
import {
  costingAbsorptionRates,
  items,
  productionBatches,
  productionDowntime,
  productionLabour,
  productionLineRecipes,
  productionLines,
  productionRecords,
  productionRejects,
  recipes,
  recordChanges,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { executeLedgerCommand } from "./ledger-command";
import { findBatch, userNames } from "./ports/production";
import { findItem, itemSummary, num, toBase } from "./ports/stock";
import { loadCalendar } from "./production-calendar";
import { findLine, shiftsOf } from "./production-lines";
import { workspaceTimeZone } from "./time-zone";

/**
 * Factory performance (3.5.2): downtime, rejects and actual labour, and OEE per line per day with
 * standard against actual hours. Rules and definitions in `@knotworking/core`
 * production-performance.ts. Records are append-only: voided with a reason, never edited.
 */

type DowntimeRow = typeof productionDowntime.$inferSelect;
type RejectRow = typeof productionRejects.$inferSelect;
type LabourRow = typeof productionLabour.$inferSelect;

const strip = <T extends { workspaceId: string }>(row: T) => {
  const { workspaceId: _ws, ...rest } = row;
  return rest;
};
const change = (
  entity: "production_downtime" | "production_reject" | "production_labour",
  row: { id: string; workspaceId: string },
): ChangeInput => ({
  entity,
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

/** Rejects and labour go on a started or completed batch; after sign-off only `manage` adds or voids them. */
function assertRecordable(batch: typeof productionBatches.$inferSelect, canManage: boolean) {
  if (batch.status === "planned" || batch.status === "cancelled")
    throw new ApiError(
      409,
      "batch_not_running",
      `Batch ${batch.batchCode} is ${batch.status}: start it first`,
    );
  if (batch.status === "completed" && !canManage)
    throw new ApiError(
      403,
      "batch_completed",
      `Batch ${batch.batchCode} is signed off: recording against it now needs manage access`,
    );
}

/**
 * Voiding (and downtime against a batch) follows the batch-record rule: never on a planned batch;
 * on a signed-off or cancelled one only with `manage`.
 */
function assertCorrectable(batch: typeof productionBatches.$inferSelect, canManage: boolean) {
  if (batch.status === "planned")
    throw new ApiError(409, "batch_not_running", `Batch ${batch.batchCode} hasn't started`);
  if ((batch.status === "completed" || batch.status === "cancelled") && !canManage)
    throw new ApiError(
      403,
      "batch_completed",
      `Batch ${batch.batchCode} is ${batch.status === "completed" ? "signed off" : "cancelled"}: changing its records needs manage access`,
    );
}

const assertNotVoided = (row: { voidedAt: Date | null }) => {
  if (row.voidedAt) throw new ApiError(409, "already_voided", "This record has already been voided");
};
const voidSet = (actor: string, input: PerformanceVoidInput) => ({
  voidedAt: new Date(),
  voidedBy: actor,
  voidReason: input.reason,
});

// ─── Downtime ────────────────────────────────────────────────────────────────

const downtimeView = (row: DowntimeRow) => ({
  ...strip(row),
  category: downtimeCategory(row.reason),
  reasonLabel: downtimeReasonInfo[row.reason].label,
});

export async function recordDowntime(
  db: Database,
  ws: string,
  actor: string,
  input: DowntimeRecordInput,
  opts: { canManage: boolean },
) {
  return executeLedgerCommand(db, ws, actor, "recordDowntime", input, input, async (tx) => {
    await findLine(tx, ws, input.lineId);
    if (input.batchId) {
      const batch = await findBatch(tx, ws, input.batchId);
      if (batch.lineId !== input.lineId) throw badRequest(`Batch ${batch.batchCode} is not on this line`);
      if (batch.status !== "planned") assertCorrectable(batch, opts.canManage);
    }
    const [row] = await tx
      .insert(productionDowntime)
      .values({
        workspaceId: ws,
        lineId: input.lineId,
        batchId: input.batchId ?? null,
        occurredOn: input.date,
        minutes: input.minutes,
        reason: input.reason,
        note: input.note || null,
        recordedBy: actor,
      })
      .returning();
    await recordChanges(tx, ws, actor, [change("production_downtime", row!)]);
    return downtimeView(row!);
  });
}

export async function voidDowntime(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: PerformanceVoidInput,
  opts: { canManage: boolean },
) {
  return executeLedgerCommand(db, ws, actor, "voidDowntime", input, { id, input }, async (tx) => {
    const [row] = await tx
      .select()
      .from(productionDowntime)
      .where(and(eq(productionDowntime.id, id), eq(productionDowntime.workspaceId, ws)));
    if (!row) throw notFound("Downtime record");
    assertNotVoided(row);
    if (row.batchId) {
      const batch = await findBatch(tx, ws, row.batchId);
      if (batch.status !== "planned") assertCorrectable(batch, opts.canManage);
    }
    const [updated] = await tx
      .update(productionDowntime)
      .set(voidSet(actor, input))
      .where(eq(productionDowntime.id, id))
      .returning();
    await recordChanges(tx, ws, actor, [change("production_downtime", updated!)]);
    return downtimeView(updated!);
  });
}

/** Downtime between two dates (voided records included, marked), newest day first. */
export async function listDowntime(db: Executor, ws: string, q: PerformanceQuery) {
  const rows = await db
    .select({ row: productionDowntime, lineName: productionLines.name })
    .from(productionDowntime)
    .innerJoin(productionLines, eq(productionLines.id, productionDowntime.lineId))
    .where(
      and(
        eq(productionDowntime.workspaceId, ws),
        gte(productionDowntime.occurredOn, q.from),
        lte(productionDowntime.occurredOn, q.to),
        q.lineId ? eq(productionDowntime.lineId, q.lineId) : undefined,
      ),
    )
    .orderBy(sql`${productionDowntime.occurredOn} desc`, sql`${productionDowntime.createdAt} desc`);
  const names = await userNames(
    db,
    rows.flatMap((r) => [r.row.recordedBy, r.row.voidedBy]),
  );
  return {
    from: q.from,
    to: q.to,
    downtime: rows.map(({ row, lineName }) => ({
      ...downtimeView(row),
      lineName,
      recordedByName: row.recordedBy ? (names.get(row.recordedBy) ?? null) : null,
      voidedByName: row.voidedBy ? (names.get(row.voidedBy) ?? null) : null,
    })),
  };
}

// ─── Rejects and labour ──────────────────────────────────────────────────────

export async function recordReject(
  db: Database,
  ws: string,
  actor: string,
  batchId: string,
  input: RejectRecordInput,
  opts: { canManage: boolean },
) {
  return executeLedgerCommand(db, ws, actor, "recordReject", input, { batchId, input }, async (tx) => {
    const batch = await findBatch(tx, ws, batchId);
    assertRecordable(batch, opts.canManage);
    const output = await findItem(tx, ws, batch.outputItemId);
    const quantity = toBase(input.quantity, input.unit, output);
    const [row] = await tx
      .insert(productionRejects)
      .values({
        workspaceId: ws,
        batchId,
        quantity,
        reason: input.reason,
        note: input.note || null,
        recordedBy: actor,
      })
      .returning();
    await recordChanges(tx, ws, actor, [change("production_reject", row!)]);
    return {
      ...strip(row!),
      quantity: stockAmount(row!.quantity, output),
      reasonLabel: rejectReasonLabels[row!.reason],
    };
  });
}

export async function recordLabour(
  db: Database,
  ws: string,
  actor: string,
  batchId: string,
  input: LabourRecordInput,
  opts: { canManage: boolean },
) {
  return executeLedgerCommand(db, ws, actor, "recordLabour", input, { batchId, input }, async (tx) => {
    const batch = await findBatch(tx, ws, batchId);
    assertRecordable(batch, opts.canManage);
    const [row] = await tx
      .insert(productionLabour)
      .values({
        workspaceId: ws,
        batchId,
        people: input.people,
        minutes: input.minutes,
        note: input.note || null,
        recordedBy: actor,
      })
      .returning();
    await recordChanges(tx, ws, actor, [change("production_labour", row!)]);
    return { ...strip(row!), personHours: roundQuantity((row!.people * row!.minutes) / 60, 2) };
  });
}

export async function voidReject(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: PerformanceVoidInput,
  opts: { canManage: boolean },
) {
  return executeLedgerCommand(db, ws, actor, "voidReject", input, { id, input }, async (tx) => {
    const [row] = await tx
      .select()
      .from(productionRejects)
      .where(and(eq(productionRejects.id, id), eq(productionRejects.workspaceId, ws)));
    if (!row) throw notFound("Reject record");
    assertNotVoided(row);
    assertCorrectable(await findBatch(tx, ws, row.batchId), opts.canManage);
    const [updated] = await tx
      .update(productionRejects)
      .set(voidSet(actor, input))
      .where(eq(productionRejects.id, id))
      .returning();
    await recordChanges(tx, ws, actor, [change("production_reject", updated!)]);
    return strip(updated!);
  });
}

export async function voidLabour(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: PerformanceVoidInput,
  opts: { canManage: boolean },
) {
  return executeLedgerCommand(db, ws, actor, "voidLabour", input, { id, input }, async (tx) => {
    const [row] = await tx
      .select()
      .from(productionLabour)
      .where(and(eq(productionLabour.id, id), eq(productionLabour.workspaceId, ws)));
    if (!row) throw notFound("Labour record");
    assertNotVoided(row);
    assertCorrectable(await findBatch(tx, ws, row.batchId), opts.canManage);
    const [updated] = await tx
      .update(productionLabour)
      .set(voidSet(actor, input))
      .where(eq(productionLabour.id, id))
      .returning();
    await recordChanges(tx, ws, actor, [change("production_labour", updated!)]);
    return strip(updated!);
  });
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** Net good output per batch: production records (reversals are negative rows). */
async function producedBy(db: Executor, ws: string, batchIds: string[]) {
  const map = new Map<string, number>();
  if (!batchIds.length) return map;
  const rows = await db
    .select({ batchId: productionRecords.batchId, total: sql<string>`sum(${productionRecords.quantity})` })
    .from(productionRecords)
    .where(
      and(
        eq(productionRecords.workspaceId, ws),
        eq(productionRecords.kind, "output"),
        inArray(productionRecords.batchId, batchIds),
      ),
    )
    .groupBy(productionRecords.batchId);
  for (const r of rows) map.set(r.batchId, Math.max(0, num(r.total)));
  return map;
}

async function activeBy<T extends typeof productionRejects | typeof productionLabour>(
  db: Executor,
  table: T,
  ws: string,
  batchIds: string[],
) {
  if (!batchIds.length) return [];
  return db
    .select()
    .from(table as typeof productionRejects)
    .where(and(eq(table.workspaceId, ws), inArray(table.batchId, batchIds), isNull(table.voidedAt)));
}

const personHours = (rows: readonly LabourRow[]) =>
  roundQuantity(
    rows.reduce((t, r) => t + (r.people * r.minutes) / 60, 0),
    2,
  );

/** A batch's rejects, labour and downtime, with yield, speed and standard against actual hours. */
export async function getBatchPerformance(db: Executor, ws: string, batchId: string) {
  const batch = await findBatch(db, ws, batchId);
  // Not `findItem`: an old batch's output item may since have been archived or deleted.
  const [output] = await db.select().from(items).where(eq(items.id, batch.outputItemId));
  if (!output) throw notFound("Item");
  const [rate] = batch.lineId
    ? await db
        .select()
        .from(productionLineRecipes)
        .where(
          and(
            eq(productionLineRecipes.lineId, batch.lineId),
            eq(productionLineRecipes.recipeId, batch.recipeId),
            isNull(productionLineRecipes.deletedAt),
          ),
        )
    : [];
  const rejects = await db
    .select()
    .from(productionRejects)
    .where(and(eq(productionRejects.workspaceId, ws), eq(productionRejects.batchId, batchId)))
    .orderBy(asc(productionRejects.createdAt));
  const labour = await db
    .select()
    .from(productionLabour)
    .where(and(eq(productionLabour.workspaceId, ws), eq(productionLabour.batchId, batchId)))
    .orderBy(asc(productionLabour.createdAt));
  const downtime = await db
    .select()
    .from(productionDowntime)
    .where(and(eq(productionDowntime.workspaceId, ws), eq(productionDowntime.batchId, batchId)))
    .orderBy(asc(productionDowntime.createdAt));
  const names = await userNames(
    db,
    [...rejects, ...labour, ...downtime].flatMap((r) => [r.recordedBy, r.voidedBy]),
  );
  const who = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  const good = (await producedBy(db, ws, [batchId])).get(batchId) ?? 0;
  const rejected = rejects.filter((r) => !r.voidedAt).reduce((t, r) => t + r.quantity, 0);
  const runHours = batchRunHours(batch.startedAt, batch.completedAt);
  const standardHours = batchHours(batch.plannedQuantity, rate?.ratePerHour);
  const actualPersonHours = personHours(labour.filter((l) => !l.voidedAt));
  const unplanned = downtime
    .filter((d) => !d.voidedAt && downtimeCategory(d.reason) === "unplanned")
    .reduce((t, d) => t + d.minutes, 0);
  return {
    batchId,
    batchCode: batch.batchCode,
    status: batch.status,
    planned: stockAmount(batch.plannedQuantity, output),
    good: stockAmount(good, output),
    rejected: stockAmount(rejected, output),
    /** Good ÷ (good + rejects). */
    firstPassYield: good + rejected > 0 ? roundQuantity(good / (good + rejected), 4) : null,
    ratePerHour: rate ? stockAmount(rate.ratePerHour, output) : null,
    /** Started to completed. */
    runHours,
    unplannedDowntimeMinutes: unplanned,
    /** (Good + rejects) per hour of run time, base unit. */
    actualRatePerHour: runHours && runHours > 0 ? stockAmount((good + rejected) / runHours, output) : null,
    standardHours,
    standardPersonHours:
      standardHours !== null && rate?.crewSize ? roundQuantity(standardHours * rate.crewSize, 2) : null,
    actualPersonHours,
    rejects: rejects.map((r) => ({
      ...strip(r),
      quantity: stockAmount(r.quantity, output),
      reasonLabel: rejectReasonLabels[r.reason],
      recordedByName: who(r.recordedBy),
      voidedByName: who(r.voidedBy),
    })),
    labour: labour.map((l) => ({
      ...strip(l),
      personHours: roundQuantity((l.people * l.minutes) / 60, 2),
      recordedByName: who(l.recordedBy),
      voidedByName: who(l.voidedBy),
    })),
    downtime: downtime.map((d) => ({
      ...downtimeView(d),
      recordedByName: who(d.recordedBy),
      voidedByName: who(d.voidedBy),
    })),
  };
}

/**
 * OEE per line per day and over the range, downtime and rejects by reason, standard against actual
 * labour hours and, for people who can read costing, line hours costed at the absorption rates.
 */
export async function getPerformance(
  db: Database,
  ws: string,
  q: PerformanceQuery,
  access: { costing: boolean },
) {
  const days: string[] = [];
  for (let d = q.from; d <= q.to; d = addDays(d, 1)) days.push(d);
  const lines = await db
    .select()
    .from(productionLines)
    .where(
      and(
        eq(productionLines.workspaceId, ws),
        isNull(productionLines.deletedAt),
        q.lineId ? eq(productionLines.id, q.lineId) : undefined,
      ),
    )
    .orderBy(asc(productionLines.name));
  if (q.lineId && !lines.length) throw notFound("Production line");
  const lineIds = lines.map((l) => l.id);
  const shifts = await shiftsOf(db, lineIds);
  const calendar = await loadCalendar(db, ws, q.from, q.to);
  const batches = lineIds.length
    ? await db
        .select({ batch: productionBatches, output: items, recipe: recipes })
        .from(productionBatches)
        .innerJoin(items, eq(items.id, productionBatches.outputItemId))
        .innerJoin(recipes, eq(recipes.id, productionBatches.recipeId))
        .where(
          and(
            eq(productionBatches.workspaceId, ws),
            isNull(productionBatches.deletedAt),
            ne(productionBatches.status, "cancelled"),
            inArray(productionBatches.lineId, lineIds),
            gte(productionBatches.plannedOn, q.from),
            lte(productionBatches.plannedOn, q.to),
          ),
        )
    : [];
  const batchIds = batches.map((b) => b.batch.id);
  const rates = lineIds.length
    ? await db
        .select()
        .from(productionLineRecipes)
        .where(and(inArray(productionLineRecipes.lineId, lineIds), isNull(productionLineRecipes.deletedAt)))
    : [];
  const rateOf = (lineId: string, recipeId: string) =>
    rates.find((r) => r.lineId === lineId && r.recipeId === recipeId) ?? null;
  const produced = await producedBy(db, ws, batchIds);
  const rejects = (await activeBy(db, productionRejects, ws, batchIds)) as RejectRow[];
  const labour = (await activeBy(db, productionLabour, ws, batchIds)) as unknown as LabourRow[];
  const downtime = lineIds.length
    ? await db
        .select()
        .from(productionDowntime)
        .where(
          and(
            eq(productionDowntime.workspaceId, ws),
            inArray(productionDowntime.lineId, lineIds),
            isNull(productionDowntime.voidedAt),
            // In range by its own day, or against a batch planned in range (it counts on that day).
            batchIds.length
              ? or(
                  and(gte(productionDowntime.occurredOn, q.from), lte(productionDowntime.occurredOn, q.to)),
                  inArray(productionDowntime.batchId, batchIds),
                )
              : and(gte(productionDowntime.occurredOn, q.from), lte(productionDowntime.occurredOn, q.to)),
          ),
        )
    : [];
  const absorption: AbsorptionRateEntry[] = access.costing
    ? (
        await db
          .select()
          .from(costingAbsorptionRates)
          .where(and(eq(costingAbsorptionRates.workspaceId, ws), isNull(costingAbsorptionRates.deletedAt)))
      ).map((r) => ({ ...r, lineId: r.lineId, effectiveFrom: r.effectiveFrom }))
    : [];

  // Downtime against a batch counts on the day the batch is planned, like its output; other downtime
  // on the day it happened. Downtime against a batch planned outside the range is left out.
  const plannedOnOf = new Map(batches.map((b) => [b.batch.id, b.batch.plannedOn]));
  const effectiveDay = (d: (typeof downtime)[number]) =>
    d.batchId ? (plannedOnOf.get(d.batchId) ?? null) : d.occurredOn;
  const timeZone = access.costing ? await workspaceTimeZone(db, ws) : null;

  const rejectedOf = (batchId: string) =>
    rejects.filter((r) => r.batchId === batchId).reduce((t, r) => t + r.quantity, 0);

  const lineViews = lines.map((line) => {
    const lineShifts = shifts.get(line.id) ?? [];
    const mineBatches = batches.filter((b) => b.batch.lineId === line.id);
    const mineDowntime = downtime.filter((d) => {
      const day = effectiveDay(d);
      return d.lineId === line.id && day !== null && day >= q.from && day <= q.to;
    });
    const dayRows = days.map((date) => {
      const capacityMinutes = Math.round(
        lineCapacityHours(
          { hoursPerDay: line.hoursPerDay, shifts: lineShifts },
          date,
          calendar.dayOff(date, line.id),
        ) * 60,
      );
      const dayDowntime = mineDowntime.filter((d) => effectiveDay(d) === date);
      const dayBatches = mineBatches.filter((b) => b.batch.plannedOn === date);
      const plannedDown = dayDowntime
        .filter((d) => downtimeCategory(d.reason) === "planned")
        .reduce((t, d) => t + d.minutes, 0);
      const unplannedDown = dayDowntime
        .filter((d) => downtimeCategory(d.reason) === "unplanned")
        .reduce((t, d) => t + d.minutes, 0);
      // A day with nothing planned on the line isn't scheduled: no planned production time to lose.
      // Its downtime is reported apart and never counted against another day.
      const scheduled = dayBatches.length > 0;
      const oee = computeOee({
        capacityMinutes: scheduled ? capacityMinutes : 0,
        plannedDowntimeMinutes: scheduled ? plannedDown : 0,
        unplannedDowntimeMinutes: scheduled ? unplannedDown : 0,
        batches: dayBatches.map((b) => ({
          good: produced.get(b.batch.id) ?? 0,
          rejects: rejectedOf(b.batch.id),
          ratePerHour: rateOf(line.id, b.batch.recipeId)?.ratePerHour ?? null,
        })),
      });
      let standardPersonHours = 0;
      let standardUnknown = 0;
      for (const b of dayBatches) {
        const rate = rateOf(line.id, b.batch.recipeId);
        const hours = batchHours(b.batch.plannedQuantity, rate?.ratePerHour);
        if (hours === null || !rate?.crewSize) standardUnknown += 1;
        else standardPersonHours += hours * rate.crewSize;
      }
      const actualPersonHours = personHours(
        labour.filter((l) => dayBatches.some((b) => b.batch.id === l.batchId)),
      );
      return {
        date,
        ...oee,
        scheduled,
        /** The line's capacity that day whether or not anything was scheduled. */
        lineCapacityMinutes: capacityMinutes,
        /** Downtime logged on a day with nothing scheduled: listed, not counted in OEE. */
        unscheduledDowntimeMinutes: scheduled ? 0 : plannedDown + unplannedDown,
        batches: dayBatches.length,
        labour: {
          standardPersonHours: roundQuantity(standardPersonHours, 2),
          /** Batches without a rate or crew size: their standard labour is unknown. */
          standardUnknown,
          actualPersonHours,
        },
      };
    });
    const totals = computeOee({
      capacityMinutes: dayRows.reduce((t, d) => t + d.capacityMinutes, 0),
      plannedDowntimeMinutes: dayRows.reduce((t, d) => t + d.plannedDowntimeMinutes, 0),
      unplannedDowntimeMinutes: dayRows.reduce((t, d) => t + d.unplannedDowntimeMinutes, 0),
      batches: mineBatches.map((b) => ({
        good: produced.get(b.batch.id) ?? 0,
        rejects: rejectedOf(b.batch.id),
        ratePerHour: rateOf(line.id, b.batch.recipeId)?.ratePerHour ?? null,
      })),
    });
    const byReason = new Map<DowntimeReason, { minutes: number; events: number }>();
    for (const d of mineDowntime) {
      const r = byReason.get(d.reason) ?? { minutes: 0, events: 0 };
      byReason.set(d.reason, { minutes: r.minutes + d.minutes, events: r.events + 1 });
    }
    // Rejects across products are in different units: compare them by the run time they cost.
    const rejectReasons = new Map<RejectReason, { records: number; idealMinutes: number; unrated: number }>();
    for (const r of rejects) {
      const b = mineBatches.find((x) => x.batch.id === r.batchId);
      if (!b) continue;
      const rate = rateOf(line.id, b.batch.recipeId)?.ratePerHour;
      const agg = rejectReasons.get(r.reason) ?? { records: 0, idealMinutes: 0, unrated: 0 };
      agg.records += 1;
      if (rate) agg.idealMinutes += (r.quantity / rate) * 60;
      else agg.unrated += 1;
      rejectReasons.set(r.reason, agg);
    }
    // Line hours at the costing module's per-hour absorption rates: standard hours (planned ÷ rate)
    // against actual run hours (started to completed). Per-kg rates are left out.
    let cost: null | {
      standardHours: number;
      actualHours: number;
      standardCost: number;
      actualCost: number;
      variance: number;
      batchesCosted: number;
      batchesLeftOut: number;
    } = null;
    if (access.costing) {
      let standardHours = 0;
      let actualHours = 0;
      let standardCost = 0;
      let actualCost = 0;
      let costed = 0;
      let leftOut = 0;
      for (const b of mineBatches) {
        const rate = rateOf(line.id, b.batch.recipeId);
        const std = batchHours(b.batch.plannedQuantity, rate?.ratePerHour);
        const act = batchRunHours(b.batch.startedAt, b.batch.completedAt);
        // As costing does: actual at the rates in force on the completion date (workspace time
        // zone); standard at those on the planned date.
        const completedOn = b.batch.completedAt ? dateInZone(b.batch.completedAt, timeZone!) : null;
        const stdRate = absorptionRateOn(absorption, line.id, b.batch.plannedOn);
        const actRate = completedOn ? absorptionRateOn(absorption, line.id, completedOn) : null;
        if (std === null || act === null || !stdRate || !actRate) {
          leftOut += 1;
          continue;
        }
        standardHours += std;
        actualHours += act;
        standardCost += std * (stdRate.labourPerHour + stdRate.overheadPerHour);
        actualCost += act * (actRate.labourPerHour + actRate.overheadPerHour);
        costed += 1;
      }
      cost = {
        standardHours: roundQuantity(standardHours, 2),
        actualHours: roundQuantity(actualHours, 2),
        standardCost: roundQuantity(standardCost, 2),
        actualCost: roundQuantity(actualCost, 2),
        /** Positive is adverse (more than standard), as in costing. */
        variance: roundQuantity(actualCost - standardCost, 2),
        batchesCosted: costed,
        batchesLeftOut: leftOut,
      };
    }
    return {
      id: line.id,
      name: line.name,
      active: line.active,
      days: dayRows,
      totals: {
        ...totals,
        labour: {
          standardPersonHours: roundQuantity(
            dayRows.reduce((t, d) => t + d.labour.standardPersonHours, 0),
            2,
          ),
          standardUnknown: dayRows.reduce((t, d) => t + d.labour.standardUnknown, 0),
          actualPersonHours: roundQuantity(
            dayRows.reduce((t, d) => t + d.labour.actualPersonHours, 0),
            2,
          ),
        },
      },
      downtimeByReason: [...byReason.entries()]
        .map(([reason, v]) => ({ reason, ...downtimeReasonInfo[reason], ...v }))
        .sort((a, b) => b.minutes - a.minutes),
      rejectsByReason: [...rejectReasons.entries()]
        .map(([reason, v]) => ({
          reason,
          label: rejectReasonLabels[reason],
          ...v,
          idealMinutes: roundQuantity(v.idealMinutes, 2),
        }))
        .sort((a, b) => b.idealMinutes - a.idealMinutes),
      cost,
    };
  });
  return {
    from: q.from,
    to: q.to,
    days,
    definitions: oeeDefinitions,
    /** Every line together (the certified metric `oee`). */
    site: siteOee(lineViews.map((l) => l.totals)),
    costBasis: access.costing
      ? ("Per-hour labour and overhead absorption rates from costing: standard hours (planned ÷ line rate) at the rates in force on the planned date, against actual run hours (started to completed) at the rates in force on the completion date, as costing absorbs them. Per-kg rates are not included." as const)
      : null,
    lines: lineViews,
    batchesWithOutput: batches.map((b) => ({
      id: b.batch.id,
      batchCode: b.batch.batchCode,
      lineId: b.batch.lineId,
      plannedOn: b.batch.plannedOn,
      recipe: { id: b.recipe.id, code: b.recipe.code, name: b.recipe.name },
      output: itemSummary(b.output),
      good: stockAmount(produced.get(b.batch.id) ?? 0, b.output),
      rejected: stockAmount(rejectedOf(b.batch.id), b.output),
    })),
  };
}
