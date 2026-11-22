import {
  addDays,
  dayOffWarning,
  minutesToClock,
  roundQuantity,
  scheduleLoads,
  stockAmount,
  type ProductionLineCreateInput,
  type ProductionLineRecipeInput,
  type ProductionLineUpdateInput,
  type ProductionScheduleQuery,
} from "@knotworking/core";
import {
  items,
  lockWorkspaceLog,
  productionBatches,
  productionChangeovers,
  productionLineRecipes,
  productionLineShifts,
  productionLines,
  recipes,
  recordChanges,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { ApiError, notFound } from "../errors";
import { loadCalendar } from "./production-calendar";
import { findItem, itemSummary, toBase } from "./ports/stock";

/**
 * Production lines and capacity: which lines exist, which recipes each can make and at what rate
 * (output per hour), and the load of assigned batches against a line's hours per day. Capacity is
 * information: an overloaded day is flagged, never refused. Nothing is scheduled automatically.
 */

type LineRow = typeof productionLines.$inferSelect;
type RateRow = typeof productionLineRecipes.$inferSelect;

const serializeLine = (row: LineRow) => {
  const { workspaceId: _ws, deletedAt: _d, ...rest } = row;
  return rest;
};
const lineChange = (row: LineRow): ChangeInput => ({
  entity: "production_line",
  entityId: row.id,
  action: "upsert",
  data: serializeLine(row),
});
const rateChange = (row: RateRow): ChangeInput =>
  row.deletedAt
    ? { entity: "production_line_recipe", entityId: row.id, action: "delete" }
    : {
        entity: "production_line_recipe",
        entityId: row.id,
        action: "upsert",
        data: (({ workspaceId: _ws, deletedAt: _d, ...rest }) => rest)(row),
      };

export async function findLine(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(productionLines)
    .where(
      and(
        eq(productionLines.id, id),
        eq(productionLines.workspaceId, workspaceId),
        isNull(productionLines.deletedAt),
      ),
    );
  if (!row) throw notFound("Production line");
  return row;
}

/** A line a batch may be put on: it exists and is active. */
export async function assertAssignableLine(db: Executor, workspaceId: string, id: string) {
  const line = await findLine(db, workspaceId, id);
  if (!line.active) {
    throw new ApiError(409, "line_inactive", `${line.name} is not active; choose another line`);
  }
  return line;
}

async function assertNameFree(db: Executor, workspaceId: string, name: string, exceptId?: string) {
  const rows = await db
    .select({ id: productionLines.id, name: productionLines.name })
    .from(productionLines)
    .where(
      and(
        eq(productionLines.workspaceId, workspaceId),
        isNull(productionLines.deletedAt),
        exceptId ? ne(productionLines.id, exceptId) : undefined,
      ),
    );
  if (rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
    throw new ApiError(409, "name_taken", `Another line is already called "${name}"`);
  }
}

/** Lines with the recipes each can make and the rate per hour. */
export async function listLines(db: Executor, workspaceId: string, opts: { includeInactive?: boolean } = {}) {
  const lines = await db
    .select()
    .from(productionLines)
    .where(
      and(
        eq(productionLines.workspaceId, workspaceId),
        isNull(productionLines.deletedAt),
        opts.includeInactive === false ? eq(productionLines.active, true) : undefined,
      ),
    )
    .orderBy(asc(productionLines.name), asc(productionLines.id));
  const rates = lines.length
    ? await db
        .select({ rate: productionLineRecipes, recipe: recipes, item: items })
        .from(productionLineRecipes)
        .innerJoin(recipes, eq(recipes.id, productionLineRecipes.recipeId))
        .innerJoin(items, eq(items.id, recipes.outputItemId))
        .where(
          and(
            inArray(
              productionLineRecipes.lineId,
              lines.map((l) => l.id),
            ),
            isNull(productionLineRecipes.deletedAt),
          ),
        )
        .orderBy(asc(recipes.code))
    : [];
  const ids = lines.map((l) => l.id);
  const shifts = await shiftsOf(db, ids);
  const changeovers = await changeoversOf(db, ids);
  return {
    lines: lines.map((line) => ({
      ...serializeLine(line),
      shifts: (shifts.get(line.id) ?? []).map((sh) => ({
        id: sh.id,
        name: sh.name,
        weekdays: sh.weekdays,
        startMinute: sh.startMinute,
        endMinute: sh.endMinute,
        start: minutesToClock(sh.startMinute),
        end: minutesToClock(sh.endMinute),
      })),
      changeovers: (changeovers.get(line.id) ?? []).map((r) => ({
        id: r.id,
        fromRecipeId: r.fromRecipeId,
        toRecipeId: r.toRecipeId,
        minutes: r.minutes,
        note: r.note,
      })),
      recipes: rates
        .filter((r) => r.rate.lineId === line.id)
        .map(({ rate, recipe, item }) => ({
          id: rate.id,
          recipeId: recipe.id,
          recipeCode: recipe.code,
          recipeName: recipe.name,
          outputItem: itemSummary(item),
          ratePerHour: stockAmount(rate.ratePerHour, item),
          crewSize: rate.crewSize,
        })),
    })),
  };
}

export async function createLine(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: ProductionLineCreateInput,
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertNameFree(tx, workspaceId, input.name);
    const [row] = await tx
      .insert(productionLines)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        name: input.name,
        hoursPerDay: input.hoursPerDay,
        notes: input.notes ?? null,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [lineChange(row!)]);
    return row!.id;
  });
  return (await listLines(db, workspaceId)).lines.find((l) => l.id === id)!;
}

export async function updateLine(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: ProductionLineUpdateInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findLine(tx, workspaceId, id);
    if (patch.name) await assertNameFree(tx, workspaceId, patch.name, id);
    const [row] = await tx
      .update(productionLines)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.hoursPerDay !== undefined ? { hoursPerDay: patch.hoursPerDay } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.changeoverMinutes !== undefined ? { changeoverMinutes: patch.changeoverMinutes } : {}),
        ...(patch.allergenCleanMinutes !== undefined
          ? { allergenCleanMinutes: patch.allergenCleanMinutes }
          : {}),
        ...(patch.crewAvailable !== undefined ? { crewAvailable: patch.crewAvailable } : {}),
      })
      .where(eq(productionLines.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [lineChange(row!)]);
  });
  return (await listLines(db, workspaceId)).lines.find((l) => l.id === id)!;
}

/** Sets (or changes) the rate at which a line makes a recipe; the unit is a unit of the output item. */
export async function setLineRecipe(
  db: Database,
  workspaceId: string,
  actorId: string,
  lineId: string,
  recipeId: string,
  input: ProductionLineRecipeInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findLine(tx, workspaceId, lineId);
    const [recipe] = await tx
      .select()
      .from(recipes)
      .where(and(eq(recipes.id, recipeId), eq(recipes.workspaceId, workspaceId), isNull(recipes.deletedAt)));
    if (!recipe) throw notFound("Recipe");
    const output = await findItem(tx, workspaceId, recipe.outputItemId);
    const ratePerHour = toBase(input.rate, input.unit, output);
    const [existing] = await tx
      .select()
      .from(productionLineRecipes)
      .where(
        and(
          eq(productionLineRecipes.lineId, lineId),
          eq(productionLineRecipes.recipeId, recipeId),
          isNull(productionLineRecipes.deletedAt),
        ),
      );
    const [row] = existing
      ? await tx
          .update(productionLineRecipes)
          .set({ ratePerHour, ...(input.crewSize !== undefined ? { crewSize: input.crewSize } : {}) })
          .where(eq(productionLineRecipes.id, existing.id))
          .returning()
      : await tx
          .insert(productionLineRecipes)
          .values({ workspaceId, lineId, recipeId, ratePerHour, crewSize: input.crewSize ?? null })
          .returning();
    await recordChanges(tx, workspaceId, actorId, [rateChange(row!)]);
  });
  return (await listLines(db, workspaceId)).lines.find((l) => l.id === lineId)!;
}

/** The line can no longer make the recipe. Batches already on the line keep it (they show as unrated). */
export async function removeLineRecipe(
  db: Database,
  workspaceId: string,
  actorId: string,
  lineId: string,
  recipeId: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findLine(tx, workspaceId, lineId);
    const [row] = await tx
      .update(productionLineRecipes)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(productionLineRecipes.lineId, lineId),
          eq(productionLineRecipes.recipeId, recipeId),
          isNull(productionLineRecipes.deletedAt),
        ),
      )
      .returning();
    if (!row) throw notFound("Line recipe");
    await recordChanges(tx, workspaceId, actorId, [rateChange(row)]);
  });
  return (await listLines(db, workspaceId)).lines.find((l) => l.id === lineId)!;
}

/** Live shift windows per line. */
export async function shiftsOf(db: Executor, lineIds: string[]) {
  const map = new Map<string, (typeof productionLineShifts.$inferSelect)[]>();
  if (lineIds.length === 0) return map;
  const rows = await db
    .select()
    .from(productionLineShifts)
    .where(and(inArray(productionLineShifts.lineId, lineIds), isNull(productionLineShifts.deletedAt)))
    .orderBy(asc(productionLineShifts.startMinute), asc(productionLineShifts.id));
  for (const r of rows) map.set(r.lineId, [...(map.get(r.lineId) ?? []), r]);
  return map;
}

/** Live changeover rules per line. */
export async function changeoversOf(db: Executor, lineIds: string[]) {
  const map = new Map<string, (typeof productionChangeovers.$inferSelect)[]>();
  if (lineIds.length === 0) return map;
  const rows = await db
    .select()
    .from(productionChangeovers)
    .where(and(inArray(productionChangeovers.lineId, lineIds), isNull(productionChangeovers.deletedAt)))
    .orderBy(asc(productionChangeovers.createdAt), asc(productionChangeovers.id));
  for (const r of rows) map.set(r.lineId, [...(map.get(r.lineId) ?? []), r]);
  return map;
}

export async function ratesOf(db: Executor, lineIds: string[]) {
  const map = new Map<string, Record<string, number>>();
  if (lineIds.length === 0) return map;
  const rows = await db
    .select()
    .from(productionLineRecipes)
    .where(and(inArray(productionLineRecipes.lineId, lineIds), isNull(productionLineRecipes.deletedAt)));
  for (const r of rows) {
    const rec = map.get(r.lineId) ?? {};
    rec[r.recipeId] = r.ratePerHour;
    map.set(r.lineId, rec);
  }
  return map;
}

/** What a batch's line means for its day: its hours, the day's load and the warnings. Null without a line. */
export async function lineCheck(
  db: Executor,
  workspaceId: string,
  batch: { id: string; lineId: string | null; recipeId: string; plannedOn: string },
) {
  if (!batch.lineId) return null;
  const [line] = await db.select().from(productionLines).where(eq(productionLines.id, batch.lineId));
  if (!line) return null;
  const sameDay = await db
    .select()
    .from(productionBatches)
    .where(
      and(
        eq(productionBatches.workspaceId, workspaceId),
        eq(productionBatches.lineId, line.id),
        eq(productionBatches.plannedOn, batch.plannedOn),
        isNull(productionBatches.deletedAt),
      ),
    );
  const rates = (await ratesOf(db, [line.id])).get(line.id) ?? {};
  const shifts = (await shiftsOf(db, [line.id])).get(line.id) ?? [];
  const calendar = await loadCalendar(db, workspaceId, batch.plannedOn, batch.plannedOn);
  const day = scheduleLoads(
    [{ id: line.id, hoursPerDay: line.hoursPerDay, shifts, rates }],
    sameDay.map((b) => ({
      id: b.id,
      lineId: b.lineId,
      recipeId: b.recipeId,
      plannedOn: b.plannedOn,
      plannedQuantity: b.plannedQuantity,
      status: b.status,
    })),
    [batch.plannedOn],
    calendar,
  )[line.id]![0]!;
  const mine = day.batches.find((b) => b.batchId === batch.id);
  const warnings: string[] = [];
  if (!line.active) warnings.push(`${line.name} is no longer active`);
  if (mine && mine.hours === null) {
    warnings.push(`${line.name} has no rate for this recipe, so its hours are unknown`);
  }
  if (day.dayOff) warnings.push(dayOffWarning(batch.plannedOn, day.dayOff, line.name));
  else if (shifts.length && day.capacityHours === 0)
    warnings.push(`${line.name} has no shift on ${batch.plannedOn}`);
  else if (day.overloaded) {
    warnings.push(
      `${line.name} is overloaded on ${batch.plannedOn}: ${day.hours} h planned against ${day.capacityHours} h`,
    );
  }
  return {
    lineId: line.id,
    lineName: line.name,
    hours: mine?.hours ?? null,
    dayHours: day.hours,
    capacityHours: day.capacityHours,
    loadPercent: day.loadPercent,
    overloaded: day.overloaded,
    dayOff: day.dayOff,
    warnings,
  };
}

/**
 * Whether a batch's planned date is a non-working day (the workspace's, or its line's), whether or
 * not it has a line. `null` on a working day. Advisory: the batch is planned anyway.
 */
export async function batchCalendarCheck(
  db: Executor,
  workspaceId: string,
  batch: { lineId: string | null; plannedOn: string },
) {
  const calendar = await loadCalendar(db, workspaceId, batch.plannedOn, batch.plannedOn);
  const off = calendar.dayOff(batch.plannedOn, batch.lineId);
  if (!off) return null;
  let lineName: string | null = null;
  if (batch.lineId) {
    const [line] = await db
      .select({ name: productionLines.name })
      .from(productionLines)
      .where(eq(productionLines.id, batch.lineId));
    lineName = line?.name ?? null;
  }
  return {
    date: batch.plannedOn,
    scope: off.scope,
    reason: off.reason,
    message: dayOffWarning(batch.plannedOn, off, lineName),
  };
}

/**
 * The schedule per line per day between two dates (inclusive, at most 62 days): the batches on
 * each line with their hours, the day's load against capacity and an overload flag, plus the open
 * batches in range that are on no line. Inactive lines show only when they carry batches.
 */
export async function getSchedule(db: Database, workspaceId: string, query: ProductionScheduleQuery) {
  const days: string[] = [];
  for (let d = query.from; d <= query.to; d = addDays(d, 1)) days.push(d);
  const rows = await db
    .select({ batch: productionBatches, recipe: recipes, output: items })
    .from(productionBatches)
    .innerJoin(recipes, eq(recipes.id, productionBatches.recipeId))
    .innerJoin(items, eq(items.id, productionBatches.outputItemId))
    .where(
      and(
        eq(productionBatches.workspaceId, workspaceId),
        isNull(productionBatches.deletedAt),
        gte(productionBatches.plannedOn, query.from),
        lte(productionBatches.plannedOn, query.to),
        ne(productionBatches.status, "cancelled"),
      ),
    )
    .orderBy(
      asc(productionBatches.plannedOn),
      sql`${productionBatches.sequence} asc nulls last`,
      asc(productionBatches.batchCode),
    );
  const allLines = (await listLines(db, workspaceId)).lines;
  const used = new Set(rows.map((r) => r.batch.lineId).filter(Boolean));
  const lines = allLines.filter((l) => l.active || used.has(l.id));
  const rates = await ratesOf(
    db,
    lines.map((l) => l.id),
  );
  const calendar = await loadCalendar(db, workspaceId, query.from, query.to);
  const loads = scheduleLoads(
    lines.map((l) => ({
      id: l.id,
      hoursPerDay: l.hoursPerDay,
      shifts: l.shifts,
      rates: rates.get(l.id) ?? {},
    })),
    rows.map(({ batch }) => ({
      id: batch.id,
      lineId: batch.lineId,
      recipeId: batch.recipeId,
      plannedOn: batch.plannedOn,
      plannedQuantity: batch.plannedQuantity,
      status: batch.status,
    })),
    days,
    calendar,
  );
  const view = ({ batch, recipe, output }: (typeof rows)[number], hours: number | null) => ({
    id: batch.id,
    batchCode: batch.batchCode,
    status: batch.status,
    plannedOn: batch.plannedOn,
    recipe: { id: recipe.id, code: recipe.code, name: recipe.name },
    planned: stockAmount(batch.plannedQuantity, output),
    hours,
  });
  const byId = new Map(rows.map((r) => [r.batch.id, r]));
  return {
    from: query.from,
    to: query.to,
    days,
    /** The workspace's days off in range (a line's own are on its days as `dayOff`). */
    daysOff: days.flatMap((date) => {
      const off = calendar.dayOff(date);
      return off ? [{ date, ...off }] : [];
    }),
    lines: lines.map((line) => {
      const lineDays = loads[line.id]!.map((d) => ({
        ...d,
        batches: d.batches.map((b) => view(byId.get(b.batchId)!, b.hours)),
      }));
      return {
        id: line.id,
        name: line.name,
        active: line.active,
        hoursPerDay: line.hoursPerDay,
        hasShifts: line.shifts.length > 0,
        days: lineDays,
        totalHours: roundQuantity(
          lineDays.reduce((t, d) => t + d.hours, 0),
          2,
        ),
        overloadedDays: lineDays.filter((d) => d.overloaded).length,
      };
    }),
    unassigned: rows
      .filter((r) => !r.batch.lineId && (r.batch.status === "planned" || r.batch.status === "in_progress"))
      .map((r) => view(r, null)),
  };
}
