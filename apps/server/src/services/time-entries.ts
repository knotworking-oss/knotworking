import {
  timerMinutes,
  type TimeEntryCreateInput,
  type TimeEntryUpdateInput,
  type TimerStartInput,
  type WorkspaceRole,
} from "@knotworking/core";
import {
  lockWorkspaceLog,
  projects,
  recordChanges,
  tasks,
  timeEntries,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, desc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { workspaceToday } from "./time-zone";
import { isAdmin } from "./members";
import { assertRefs } from "./refs";

type TimeEntryRow = typeof timeEntries.$inferSelect;

/**
 * Time tracking. A time entry is either finished (`minutes` set) or a running timer
 * (`minutes` null, `startedAt` set); each user has at most one running timer per workspace.
 *
 * Permissions: guests can't write (`requireWriter` on the routes). Members log, edit and
 * delete their own time; owners and admins can also log time for others and edit or delete
 * anyone's entries. Timers are always the caller's own.
 */
export interface TimeActor {
  id: string;
  role: WorkspaceRole;
}

/** Wire format for a time entry. `minutes` is null while its timer runs. */
export function serializeTimeEntry(row: TimeEntryRow) {
  const { deletedAt: _deleted, workspaceId: _ws, ...rest } = row;
  return rest;
}

const minutesSum = sql<number>`coalesce(sum(${timeEntries.minutes}), 0)::int`;

async function assertTask(db: Executor, workspaceId: string, taskId: string) {
  const [task] = await db
    .select({ id: tasks.id, estimateMinutes: tasks.estimateMinutes })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)));
  if (!task) throw notFound("Task");
  return task;
}

async function getLiveEntry(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(timeEntries)
    .where(
      and(eq(timeEntries.id, id), eq(timeEntries.workspaceId, workspaceId), isNull(timeEntries.deletedAt)),
    );
  if (!row) throw notFound("Time entry");
  return row;
}

function assertCanChange(actor: TimeActor, entry: TimeEntryRow, verb: "edit" | "delete") {
  if (entry.userId !== actor.id && !isAdmin(actor.role)) {
    throw new ApiError(403, "forbidden", `You can only ${verb} your own time`);
  }
}

async function runningTimer(tx: Executor, workspaceId: string, userId: string) {
  const [row] = await tx
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, workspaceId),
        eq(timeEntries.userId, userId),
        isNull(timeEntries.minutes),
        isNull(timeEntries.deletedAt),
      ),
    );
  return row;
}

/** Stops a running timer in `tx`, rounding to whole minutes (1 minute to 24 hours). */
async function stop(tx: Transaction, entry: TimeEntryRow, now = new Date()) {
  const [row] = await tx
    .update(timeEntries)
    .set({ minutes: timerMinutes(entry.startedAt ?? entry.createdAt, now) })
    .where(eq(timeEntries.id, entry.id))
    .returning();
  return row!;
}

/** Per-user totals of finished entries (running timers don't count until stopped). */
async function userTotals(db: Executor, where: SQL | undefined) {
  return db
    .select({ userId: timeEntries.userId, minutes: minutesSum })
    .from(timeEntries)
    .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
    .where(where)
    .groupBy(timeEntries.userId)
    .orderBy(desc(minutesSum));
}

/** A task's entries (newest day first) and its totals. */
export async function listTaskTimeEntries(db: Database, workspaceId: string, taskId: string) {
  const task = await assertTask(db, workspaceId, taskId);
  const rows = await db
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, workspaceId),
        eq(timeEntries.taskId, taskId),
        isNull(timeEntries.deletedAt),
      ),
    )
    .orderBy(desc(timeEntries.entryDate), desc(timeEntries.createdAt), desc(timeEntries.id));
  const entries = rows.map(serializeTimeEntry);
  const users = new Map<string | null, number>();
  for (const e of entries) {
    if (e.minutes !== null) users.set(e.userId, (users.get(e.userId) ?? 0) + e.minutes);
  }
  return {
    entries,
    totals: {
      loggedMinutes: [...users.values()].reduce((s, m) => s + m, 0),
      estimateMinutes: task.estimateMinutes,
      users: [...users]
        .map(([userId, minutes]) => ({ userId, minutes }))
        .sort((a, b) => b.minutes - a.minutes),
    },
  };
}

/**
 * Time on a project's (live) tasks: the total, the sum of the tasks' time estimates, and
 * the split per task and per person. Only finished entries count.
 */
export async function projectTimeTotals(db: Database, workspaceId: string, projectId: string) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)),
    );
  if (!project) throw notFound("Project");

  const inProject = and(
    eq(tasks.workspaceId, workspaceId),
    eq(tasks.projectId, projectId),
    isNull(tasks.deletedAt),
  );
  const finished = and(inProject, isNull(timeEntries.deletedAt), isNotNull(timeEntries.minutes));
  const [taskRows, logged, users] = await Promise.all([
    db
      .select({ id: tasks.id, estimateMinutes: tasks.estimateMinutes })
      .from(tasks)
      .where(inProject)
      .orderBy(asc(tasks.sortOrder)),
    db
      .select({ taskId: timeEntries.taskId, minutes: minutesSum })
      .from(timeEntries)
      .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
      .where(finished)
      .groupBy(timeEntries.taskId),
    userTotals(db, finished),
  ]);
  const byTask = new Map(logged.map((r) => [r.taskId, r.minutes]));
  const perTask = taskRows
    .map((t) => ({ taskId: t.id, loggedMinutes: byTask.get(t.id) ?? 0, estimateMinutes: t.estimateMinutes }))
    .filter((t) => t.loggedMinutes > 0 || t.estimateMinutes !== null);
  return {
    projectId,
    loggedMinutes: perTask.reduce((s, t) => s + t.loggedMinutes, 0),
    estimateMinutes: perTask.reduce((s, t) => s + (t.estimateMinutes ?? 0), 0),
    tasks: perTask,
    users,
  };
}

/** Logs a finished entry. Logging for someone else takes an owner or admin. */
export async function createTimeEntry(
  db: Database,
  workspaceId: string,
  actor: TimeActor,
  taskId: string,
  input: TimeEntryCreateInput,
) {
  const userId = input.userId ?? actor.id;
  if (userId !== actor.id && !isAdmin(actor.role)) {
    throw new ApiError(403, "forbidden", "Only owners and admins can log time for someone else");
  }
  return db.transaction(async (tx) => {
    await assertTask(tx, workspaceId, taskId);
    if (userId !== actor.id) await assertRefs(tx, workspaceId, { assigneeId: userId });
    const [row] = await tx
      .insert(timeEntries)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        taskId,
        userId,
        minutes: input.minutes,
        note: input.note || null,
        entryDate: input.entryDate ?? (await workspaceToday(tx, workspaceId)),
      })
      .returning();
    await recordChanges(tx, workspaceId, actor.id, [
      { entity: "time_entry", entityId: row!.id, action: "upsert", data: row },
    ]);
    return serializeTimeEntry(row!);
  });
}

export async function updateTimeEntry(
  db: Database,
  workspaceId: string,
  actor: TimeActor,
  id: string,
  input: TimeEntryUpdateInput,
) {
  return db.transaction(async (tx) => {
    const existing = await getLiveEntry(tx, workspaceId, id);
    assertCanChange(actor, existing, "edit");
    if (input.minutes !== undefined && existing.minutes === null) {
      throw badRequest("Stop the timer before changing its duration");
    }
    const [row] = await tx
      .update(timeEntries)
      .set({
        ...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
        ...(input.note !== undefined ? { note: input.note || null } : {}),
        ...(input.entryDate !== undefined ? { entryDate: input.entryDate } : {}),
        updatedAt: new Date(),
      })
      .where(eq(timeEntries.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actor.id, [
      { entity: "time_entry", entityId: id, action: "upsert", data: row },
    ]);
    return serializeTimeEntry(row!);
  });
}

export async function deleteTimeEntry(db: Database, workspaceId: string, actor: TimeActor, id: string) {
  await db.transaction(async (tx) => {
    const existing = await getLiveEntry(tx, workspaceId, id);
    assertCanChange(actor, existing, "delete");
    await tx.update(timeEntries).set({ deletedAt: new Date() }).where(eq(timeEntries.id, id));
    await recordChanges(tx, workspaceId, actor.id, [
      { entity: "time_entry", entityId: id, action: "delete" },
    ]);
  });
}

/**
 * Starts the caller's timer on a task. A timer already running (on any task) is stopped
 * first, in the same transaction, so there is never more than one. The workspace lock makes
 * concurrent starts queue; the partial unique index backs the rule up.
 */
export async function startTimer(
  db: Database,
  workspaceId: string,
  actorId: string,
  taskId: string,
  input: TimerStartInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertTask(tx, workspaceId, taskId);
    const now = new Date();
    const running = await runningTimer(tx, workspaceId, actorId);
    const stopped = running ? await stop(tx, running, now) : null;
    const [row] = await tx
      .insert(timeEntries)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        taskId,
        userId: actorId,
        minutes: null,
        note: input.note || null,
        entryDate: input.entryDate ?? (await workspaceToday(tx, workspaceId)),
        startedAt: now,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      ...(stopped
        ? [{ entity: "time_entry" as const, entityId: stopped.id, action: "upsert" as const, data: stopped }]
        : []),
      { entity: "time_entry", entityId: row!.id, action: "upsert", data: row },
    ]);
    return { entry: serializeTimeEntry(row!), stopped: stopped ? serializeTimeEntry(stopped) : null };
  });
}

/** Stops the caller's running timer (404 when none runs). */
export async function stopTimer(db: Database, workspaceId: string, actorId: string) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const running = await runningTimer(tx, workspaceId, actorId);
    if (!running) throw notFound("Running timer");
    const row = await stop(tx, running);
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "time_entry", entityId: row.id, action: "upsert", data: row },
    ]);
    return serializeTimeEntry(row);
  });
}

/** Live entries on live tasks, for the bootstrap snapshot. */
export async function listWorkspaceTimeEntries(db: Database, workspaceId: string) {
  const rows = await db
    .select({ entry: timeEntries })
    .from(timeEntries)
    .innerJoin(tasks, and(eq(tasks.id, timeEntries.taskId), isNull(tasks.deletedAt)))
    .where(and(eq(timeEntries.workspaceId, workspaceId), isNull(timeEntries.deletedAt)))
    .orderBy(desc(timeEntries.entryDate), desc(timeEntries.createdAt));
  return rows.map((r) => serializeTimeEntry(r.entry));
}
