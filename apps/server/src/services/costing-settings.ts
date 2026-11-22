import {
  dateInZone,
  type AbsorptionRateEntry,
  type AbsorptionRateSetInput,
  type StandardCostEntry,
  type StandardCostSetInput,
} from "@knotworking/core";
import {
  costingAbsorptionRates,
  itemStandardCosts,
  items,
  lockWorkspaceLog,
  productionLines,
  recordChanges,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { workspaceTimeZone } from "./time-zone";

/**
 * What people set for costing: standard cost history (a standard cost from a date, so the
 * standard side of a batch uses the cost in force then) and labour and overhead absorption rates
 * (per line or workspace-wide, from a date). Both are small reference data and go through the sync
 * log like any other write.
 */

type StandardCostRow = typeof itemStandardCosts.$inferSelect;
type RateRow = typeof costingAbsorptionRates.$inferSelect;

const strip = <T extends { workspaceId: string; deletedAt: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...data } = row;
  return data;
};
const standardCostChange = (row: StandardCostRow): ChangeInput => ({
  entity: "costing_standard_cost",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});
const rateChange = (row: RateRow): ChangeInput => ({
  entity: "costing_absorption_rate",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

// ─── Standard cost history ───────────────────────────────────────────────────

/** Entries by item id, oldest first, for the items given (the engine's `standardCosts`). */
export async function standardCostHistory(
  db: Executor,
  workspaceId: string,
  itemIds: readonly string[],
): Promise<Map<string, StandardCostEntry[]>> {
  const map = new Map<string, StandardCostEntry[]>();
  const ids = [...new Set(itemIds)];
  for (let at = 0; at < ids.length; at += 5000) {
    const rows = await db
      .select()
      .from(itemStandardCosts)
      .where(
        and(
          eq(itemStandardCosts.workspaceId, workspaceId),
          isNull(itemStandardCosts.deletedAt),
          sql`${itemStandardCosts.itemId} in (${sql.join(
            ids.slice(at, at + 5000).map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      )
      .orderBy(asc(itemStandardCosts.effectiveFrom));
    for (const r of rows) {
      const list = map.get(r.itemId) ?? [];
      list.push({ effectiveFrom: r.effectiveFrom, cost: r.cost });
      map.set(r.itemId, list);
    }
  }
  return map;
}

export async function listStandardCosts(db: Executor, workspaceId: string, itemId: string) {
  const rows = await db
    .select()
    .from(itemStandardCosts)
    .where(
      and(
        eq(itemStandardCosts.workspaceId, workspaceId),
        eq(itemStandardCosts.itemId, itemId),
        isNull(itemStandardCosts.deletedAt),
      ),
    )
    .orderBy(asc(itemStandardCosts.effectiveFrom));
  return { itemId, entries: rows.map((r) => ({ ...strip(r) })).reverse() };
}

/**
 * Adds the entries a change to an item's standard cost needs: the cost it had before (from the
 * day it was created, when it had no history yet) and the new one from `today`. Returns the
 * changes to record. The caller updates `items.standard_cost` itself.
 */
export async function recordStandardCostChange(
  tx: Executor,
  workspaceId: string,
  actorId: string,
  current: { id: string; standardCost: number | null; createdAt: Date },
  next: number | null,
  options: { effectiveFrom?: string; note?: string | null } = {},
): Promise<ChangeInput[]> {
  const timeZone = await workspaceTimeZone(tx, workspaceId);
  const effectiveFrom = options.effectiveFrom ?? dateInZone(new Date(), timeZone);
  const changes: ChangeInput[] = [];
  const [existing] = await tx
    .select({ id: itemStandardCosts.id })
    .from(itemStandardCosts)
    .where(and(eq(itemStandardCosts.itemId, current.id), isNull(itemStandardCosts.deletedAt)))
    .limit(1);
  if (!existing && current.standardCost !== null) {
    // The cost the item has now was never in the history: keep it from the day it was created, or,
    // when the new entry is back-dated before that, from today (so a back-dated entry doesn't
    // replace what is in force now).
    const today = dateInZone(new Date(), timeZone);
    const created = dateInZone(current.createdAt, timeZone);
    const baselineFrom = created < effectiveFrom ? created : effectiveFrom < today ? today : null;
    if (baselineFrom) {
      const [baseline] = await tx
        .insert(itemStandardCosts)
        .values({
          workspaceId,
          itemId: current.id,
          effectiveFrom: baselineFrom,
          cost: current.standardCost,
          note: "Before history was kept",
          setBy: null,
        })
        .returning();
      changes.push(standardCostChange(baseline!));
    }
  }
  const values = {
    workspaceId,
    itemId: current.id,
    effectiveFrom,
    cost: next,
    note: options.note ?? null,
    setBy: actorId,
  };
  const [row] = await tx
    .insert(itemStandardCosts)
    .values(values)
    .onConflictDoUpdate({
      target: [itemStandardCosts.itemId, itemStandardCosts.effectiveFrom],
      set: { cost: next, note: values.note, setBy: actorId, deletedAt: null, updatedAt: new Date() },
    })
    .returning();
  changes.push(standardCostChange(row!));
  return changes;
}

/**
 * Sets an item's standard cost from a date on or before today (a back-dated entry corrects the
 * history; the standard side of batches completed since then moves with it). The item's current
 * standard cost becomes whatever is in force today.
 */
export async function setStandardCost(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: StandardCostSetInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [item] = await tx
      .select()
      .from(items)
      .where(and(eq(items.id, input.itemId), eq(items.workspaceId, workspaceId), isNull(items.deletedAt)));
    if (!item) throw notFound("Item");
    const timeZone = await workspaceTimeZone(tx, workspaceId);
    const today = dateInZone(new Date(), timeZone);
    if (input.effectiveFrom > today) {
      throw badRequest("A standard cost can't take effect in the future; set it on the day it applies");
    }
    const changes = await recordStandardCostChange(tx, workspaceId, actorId, item, input.cost, {
      effectiveFrom: input.effectiveFrom,
      note: input.note ?? null,
    });
    // The item's current cost is the entry in force today.
    const history = await standardCostHistory(tx, workspaceId, [item.id]);
    const entries = history.get(item.id) ?? [];
    const inForce = [...entries].reverse().find((e) => e.effectiveFrom <= today);
    const current = inForce ? inForce.cost : item.standardCost;
    if (current !== item.standardCost) {
      const [row] = await tx
        .update(items)
        .set({ standardCost: current })
        .where(eq(items.id, item.id))
        .returning();
      const { workspaceId: _ws, deletedAt: _d, ...data } = row!;
      changes.push({ entity: "item", entityId: item.id, action: "upsert", data });
    }
    await recordChanges(tx, workspaceId, actorId, changes);
    return listStandardCosts(tx, workspaceId, item.id);
  });
}

// ─── Absorption rates ────────────────────────────────────────────────────────

export async function absorptionRateEntries(
  db: Executor,
  workspaceId: string,
): Promise<AbsorptionRateEntry[]> {
  const rows = await db
    .select()
    .from(costingAbsorptionRates)
    .where(
      and(eq(costingAbsorptionRates.workspaceId, workspaceId), isNull(costingAbsorptionRates.deletedAt)),
    );
  return rows.map((r) => ({
    lineId: r.lineId,
    effectiveFrom: r.effectiveFrom,
    labourPerHour: r.labourPerHour,
    labourPerKg: r.labourPerKg,
    overheadPerHour: r.overheadPerHour,
    overheadPerKg: r.overheadPerKg,
  }));
}

/** Every entry with the line's name, newest first within each line (the workspace default first). */
export async function listAbsorptionRates(db: Executor, workspaceId: string) {
  const rows = await db
    .select({ rate: costingAbsorptionRates, lineName: productionLines.name })
    .from(costingAbsorptionRates)
    .leftJoin(productionLines, eq(productionLines.id, costingAbsorptionRates.lineId))
    .where(
      and(eq(costingAbsorptionRates.workspaceId, workspaceId), isNull(costingAbsorptionRates.deletedAt)),
    );
  const lines = await db
    .select({ id: productionLines.id, name: productionLines.name, active: productionLines.active })
    .from(productionLines)
    .where(and(eq(productionLines.workspaceId, workspaceId), isNull(productionLines.deletedAt)))
    .orderBy(asc(productionLines.name));
  return {
    rates: rows
      .map(({ rate, lineName }) => ({ ...strip(rate), lineName }))
      .sort(
        (a, b) =>
          (a.lineId ?? "").localeCompare(b.lineId ?? "") || b.effectiveFrom.localeCompare(a.effectiveFrom),
      ),
    lines,
  };
}

/** Sets the rates for a line (or the default) from a date; a date already set for it is replaced. */
export async function setAbsorptionRate(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: AbsorptionRateSetInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (input.lineId) {
      const [line] = await tx
        .select({ id: productionLines.id })
        .from(productionLines)
        .where(
          and(
            eq(productionLines.id, input.lineId),
            eq(productionLines.workspaceId, workspaceId),
            isNull(productionLines.deletedAt),
          ),
        );
      if (!line) throw notFound("Production line");
    }
    const values = {
      labourPerHour: input.labourPerHour,
      labourPerKg: input.labourPerKg,
      overheadPerHour: input.overheadPerHour,
      overheadPerKg: input.overheadPerKg,
      note: input.note ?? null,
      setBy: actorId,
    };
    const [existing] = await tx
      .select({ id: costingAbsorptionRates.id })
      .from(costingAbsorptionRates)
      .where(
        and(
          eq(costingAbsorptionRates.workspaceId, workspaceId),
          input.lineId
            ? eq(costingAbsorptionRates.lineId, input.lineId)
            : isNull(costingAbsorptionRates.lineId),
          eq(costingAbsorptionRates.effectiveFrom, input.effectiveFrom),
        ),
      );
    let row: RateRow | undefined;
    try {
      [row] = existing
        ? await tx
            .update(costingAbsorptionRates)
            .set({ ...values, deletedAt: null })
            .where(eq(costingAbsorptionRates.id, existing.id))
            .returning()
        : await tx
            .insert(costingAbsorptionRates)
            .values({ workspaceId, lineId: input.lineId, effectiveFrom: input.effectiveFrom, ...values })
            .returning();
    } catch (err) {
      throw new ApiError(409, "rate_exists", `Could not save the rates: ${(err as Error).message}`);
    }
    await recordChanges(tx, workspaceId, actorId, [rateChange(row!)]);
    return listAbsorptionRates(tx, workspaceId);
  });
}
