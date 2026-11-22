import {
  expandNonWorkingDates,
  workingCalendar,
  type CalendarQuery,
  type NonWorkingDaysAddInput,
  type WorkingCalendar,
} from "@knotworking/core";
import {
  lockWorkspaceLog,
  productionLines,
  productionNonWorkingDays,
  recordChanges,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { notFound } from "../errors";

/**
 * The production working-day calendar: days the workspace, or one line, does not produce. Advisory
 * (see `@knotworking/core` production-calendar.ts): the schedule, batch pages and the cover view
 * warn; nothing is refused or moved.
 */

type DayRow = typeof productionNonWorkingDays.$inferSelect;

const serializeDay = (row: DayRow) => {
  const { workspaceId: _ws, deletedAt: _d, ...rest } = row;
  return rest;
};
const dayChange = (row: DayRow): ChangeInput =>
  row.deletedAt
    ? { entity: "production_non_working_day", entityId: row.id, action: "delete" }
    : { entity: "production_non_working_day", entityId: row.id, action: "upsert", data: serializeDay(row) };

/** The days off between two dates (inclusive), optionally those that apply to one line. */
export async function listNonWorkingDays(
  db: Executor,
  workspaceId: string,
  query: Pick<CalendarQuery, "from" | "to"> & { lineId?: string },
) {
  const rows = await db
    .select({ day: productionNonWorkingDays, lineName: productionLines.name })
    .from(productionNonWorkingDays)
    .leftJoin(productionLines, eq(productionLines.id, productionNonWorkingDays.lineId))
    .where(
      and(
        eq(productionNonWorkingDays.workspaceId, workspaceId),
        isNull(productionNonWorkingDays.deletedAt),
        gte(productionNonWorkingDays.date, query.from),
        lte(productionNonWorkingDays.date, query.to),
        query.lineId
          ? or(isNull(productionNonWorkingDays.lineId), eq(productionNonWorkingDays.lineId, query.lineId))
          : undefined,
      ),
    )
    .orderBy(asc(productionNonWorkingDays.date), asc(productionNonWorkingDays.id));
  return {
    from: query.from,
    to: query.to,
    days: rows.map(({ day, lineName }) => ({ ...serializeDay(day), lineName: lineName ?? null })),
  };
}

/** A lookup over the days off in a range, for the schedule, batch checks and the cover view. */
export async function loadCalendar(
  db: Executor,
  workspaceId: string,
  from: string,
  to: string,
): Promise<WorkingCalendar> {
  return workingCalendar((await listNonWorkingDays(db, workspaceId, { from, to })).days);
}

/**
 * Marks dates as non-working for the workspace or a line. Dates already marked for that scope are
 * kept as they are (and counted in `existing`), so the request can be repeated.
 */
export async function addNonWorkingDays(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: NonWorkingDaysAddInput,
) {
  const dates = expandNonWorkingDates(input);
  const lineId = input.lineId ?? null;
  const created = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (lineId) {
      const [line] = await tx
        .select({ id: productionLines.id })
        .from(productionLines)
        .where(
          and(
            eq(productionLines.id, lineId),
            eq(productionLines.workspaceId, workspaceId),
            isNull(productionLines.deletedAt),
          ),
        );
      if (!line) throw notFound("Production line");
    }
    if (dates.length === 0) return [];
    const have = await tx
      .select({ date: productionNonWorkingDays.date })
      .from(productionNonWorkingDays)
      .where(
        and(
          eq(productionNonWorkingDays.workspaceId, workspaceId),
          isNull(productionNonWorkingDays.deletedAt),
          inArray(productionNonWorkingDays.date, dates),
          lineId ? eq(productionNonWorkingDays.lineId, lineId) : isNull(productionNonWorkingDays.lineId),
        ),
      );
    const taken = new Set(have.map((r) => r.date));
    const fresh = dates.filter((d) => !taken.has(d));
    if (fresh.length === 0) return [];
    const rows = await tx
      .insert(productionNonWorkingDays)
      .values(fresh.map((date) => ({ workspaceId, date, lineId, reason: input.reason ?? null })))
      .returning();
    await recordChanges(tx, workspaceId, actorId, rows.map(dayChange));
    return rows;
  });
  return {
    created: created.length,
    existing: dates.length - created.length,
    days: created.map(serializeDay),
  };
}

/** Takes a day off the calendar (the date is a working day again). */
export async function removeNonWorkingDay(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [row] = await tx
      .update(productionNonWorkingDays)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(productionNonWorkingDays.id, id),
          eq(productionNonWorkingDays.workspaceId, workspaceId),
          isNull(productionNonWorkingDays.deletedAt),
        ),
      )
      .returning();
    if (!row) throw notFound("Non-working day");
    await recordChanges(tx, workspaceId, actorId, [dayChange(row)]);
  });
}
