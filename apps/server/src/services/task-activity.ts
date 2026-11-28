import { isDeepStrictEqual } from "node:util";
import {
  taskActivityFields,
  type TaskActivityChange,
  type TaskActivityDetails,
  type TaskActivityField,
  type TaskActivitySource,
} from "@knotworking/core";
import { taskEvents, tasks, teams, type Database, type Transaction } from "@knotworking/db";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { notFound } from "../errors";
import { activityTriggers, queueAutomationEvent } from "./automation-events";

type TrackedTask = Pick<typeof tasks.$inferSelect, Exclude<TaskActivityField, "labelIds">>;

export function taskActivityChanges(
  before: TrackedTask & { labelIds: string[] },
  after: TrackedTask & { labelIds: string[] },
) {
  const changes: Partial<Record<TaskActivityField, TaskActivityChange>> = {};
  for (const field of taskActivityFields) {
    if (field === "description") {
      // Record that the description changed without retaining prior document text.
      if (!isDeepStrictEqual(before.description, after.description)) {
        changes.description = { from: before.description !== null, to: after.description !== null };
      }
      continue;
    }
    const from = field === "labelIds" ? [...before.labelIds].sort() : before[field];
    const to = field === "labelIds" ? [...after.labelIds].sort() : after[field];
    if (!isDeepStrictEqual(from, to)) changes[field] = { from, to };
  }
  return changes;
}

export async function recordTaskActivity(
  tx: Transaction,
  workspaceId: string,
  taskIds: string[],
  actorId: string,
  source: TaskActivitySource,
  details: TaskActivityDetails,
) {
  const events = await tx
    .insert(taskEvents)
    .values(taskIds.map((taskId) => ({ workspaceId, taskId, actorId, source, details })))
    .returning({ id: taskEvents.id, taskId: taskEvents.taskId });
  if (source === "automation") return;
  const triggers = activityTriggers(details);
  for (const event of events) {
    await queueAutomationEvent(tx, workspaceId, event.taskId, event.id, triggers);
  }
}

export async function listTaskActivity(
  db: Database,
  workspaceId: string,
  taskId: string,
  { before, limit }: { before?: string; limit: number },
) {
  // Check visibility and read the page in the same snapshot, including for tasks with no events.
  const visible = db
    .select({ taskId: tasks.id })
    .from(tasks)
    .innerJoin(teams, and(eq(teams.id, tasks.teamId), isNull(teams.deletedAt)))
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)))
    .as("visible_task");
  const rows = await db
    .select({ event: taskEvents })
    .from(visible)
    .leftJoin(
      taskEvents,
      and(
        eq(taskEvents.workspaceId, workspaceId),
        eq(taskEvents.taskId, visible.taskId),
        before ? lt(taskEvents.id, before) : undefined,
      ),
    )
    .orderBy(desc(taskEvents.id))
    .limit(limit + 1);
  if (rows.length === 0) throw notFound("Task");
  const events = rows.slice(0, limit).flatMap(({ event }) => {
    if (!event) return [];
    const { workspaceId: _workspace, taskId: _task, ...details } = event;
    return [details];
  });
  return { events, nextCursor: rows.length > limit ? events.at(-1)!.id : null };
}
