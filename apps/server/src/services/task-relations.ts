import type { TaskActivitySource, TaskRelationCreateInput } from "@knotworking/core";
import {
  lockWorkspaceLog,
  recordChanges,
  taskRelations,
  tasks,
  teams,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ApiError, badRequest, isPrimaryKeyViolation, notFound } from "../errors";
import { recordTaskActivity } from "./task-activity";

/**
 * Task dependencies ("A blocks B", read from B as "blocked by A").
 *
 * Rows are bootstrapped and synced like `task_labels`: an upsert per created
 * relation and a tombstone when one is removed (rows are hard-deleted so the
 * unique pair can be created again). Both tasks must be live and in a live team.
 */

type RelationRow = typeof taskRelations.$inferSelect;
type ChangeList = Parameters<typeof recordChanges>[3];

/** How many hops the cycle check follows before giving up (a guard, not a product limit). */
const MAX_DEPTH = 1000;

export function serializeTaskRelation(row: RelationRow) {
  const { deletedAt: _deleted, workspaceId: _ws, kind: _kind, ...rest } = row;
  return rest;
}

/**
 * Relations whose two tasks are both visible: not deleted, and not in an
 * archived team (task lists hide those, so their relations are hidden too).
 */
export async function listTaskRelations(db: Executor, workspaceId: string, scope?: SQL) {
  const blocking = alias(tasks, "blocking_task");
  const blockingTeam = alias(teams, "blocking_team");
  const rows = await db
    .select({ relation: taskRelations })
    .from(taskRelations)
    .innerJoin(tasks, and(eq(tasks.id, taskRelations.blockedTaskId), isNull(tasks.deletedAt)))
    .innerJoin(teams, and(eq(teams.id, tasks.teamId), isNull(teams.deletedAt)))
    .innerJoin(blocking, and(eq(blocking.id, taskRelations.blockingTaskId), isNull(blocking.deletedAt)))
    .innerJoin(blockingTeam, and(eq(blockingTeam.id, blocking.teamId), isNull(blockingTeam.deletedAt)))
    .where(
      and(
        eq(taskRelations.workspaceId, workspaceId),
        eq(taskRelations.kind, "blocks"),
        isNull(taskRelations.deletedAt),
        scope,
      ),
    );
  return rows.map((r) => serializeTaskRelation(r.relation));
}

/** Whether `from` reaches `to` through directed links of the given kind. */
export async function reachesTask(
  tx: Transaction,
  workspaceId: string,
  kind: "blocks" | "duplicate_of",
  from: string,
  to: string,
) {
  const seen = new Set<string>([from]);
  let frontier = [from];
  for (let depth = 0; frontier.length > 0; depth++) {
    if (depth > MAX_DEPTH) throw badRequest("The dependency chain is too long");
    const next = await tx
      .select({ id: taskRelations.blockedTaskId })
      .from(taskRelations)
      .where(
        and(
          eq(taskRelations.workspaceId, workspaceId),
          eq(taskRelations.kind, kind),
          inArray(taskRelations.blockingTaskId, frontier),
          isNull(taskRelations.deletedAt),
        ),
      );
    frontier = [];
    for (const { id } of next) {
      if (id === to) return true;
      if (!seen.has(id)) {
        seen.add(id);
        frontier.push(id);
      }
    }
  }
  return false;
}

export async function assertLiveTasks(tx: Executor, workspaceId: string, ids: string[]) {
  const found = await tx
    .select({ id: tasks.id, teamId: tasks.teamId, stateId: tasks.stateId, projectId: tasks.projectId })
    .from(tasks)
    .innerJoin(teams, and(eq(teams.id, tasks.teamId), isNull(teams.deletedAt)))
    .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, ids), isNull(tasks.deletedAt)));
  for (const id of ids) {
    if (!found.some((t) => t.id === id)) throw notFound("Task");
  }
  return found;
}

/**
 * `blockingTaskId` blocks `blockedTaskId`. Refuses self-relations (400), a pair
 * that already exists (409 `relation_exists`) and anything that would close a
 * cycle, including the reverse of an existing pair (409 `relation_cycle`).
 */
export async function createTaskRelation(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: TaskRelationCreateInput,
  source: TaskActivitySource = "internal",
) {
  const { blockingTaskId, blockedTaskId } = input;
  if (blockingTaskId === blockedTaskId) throw badRequest("A task can't block itself");
  try {
    return await db.transaction(async (tx) => {
      // Serialise relation writes in the workspace (recordChanges re-takes this lock), so two
      // concurrent requests can't each add one half of a cycle.
      await lockWorkspaceLog(tx, workspaceId);
      await assertLiveTasks(tx, workspaceId, [blockingTaskId, blockedTaskId]);

      const [existing] = await tx
        .select({ id: taskRelations.id })
        .from(taskRelations)
        .where(
          and(
            eq(taskRelations.blockingTaskId, blockingTaskId),
            eq(taskRelations.blockedTaskId, blockedTaskId),
            eq(taskRelations.kind, "blocks"),
          ),
        );
      if (existing) {
        throw new ApiError(409, "relation_exists", "These tasks are already linked");
      }
      if (await reachesTask(tx, workspaceId, "blocks", blockedTaskId, blockingTaskId)) {
        throw new ApiError(
          409,
          "relation_cycle",
          "That would create a circular dependency: the blocked task already blocks this one",
        );
      }

      const [row] = await tx
        .insert(taskRelations)
        .values({
          ...(input.id ? { id: input.id } : {}),
          workspaceId,
          blockingTaskId,
          blockedTaskId,
          creatorId: actorId,
        })
        .returning();
      await recordChanges(tx, workspaceId, actorId, [
        { entity: "task_relation", entityId: row!.id, action: "upsert", data: serializeTaskRelation(row!) },
      ]);
      await recordTaskActivity(tx, workspaceId, [blockingTaskId, blockedTaskId], actorId, source, {
        kind: "dependency_added",
        blockingTaskId,
        blockedTaskId,
      });
      return serializeTaskRelation(row!);
    });
  } catch (err) {
    if (isPrimaryKeyViolation(err))
      throw new ApiError(409, "conflict", "A relation with this id already exists");
    throw err;
  }
}

export async function deleteTaskRelation(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  source: TaskActivitySource = "internal",
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [row] = await tx
      .delete(taskRelations)
      .where(
        and(
          eq(taskRelations.id, id),
          eq(taskRelations.workspaceId, workspaceId),
          eq(taskRelations.kind, "blocks"),
        ),
      )
      .returning();
    if (!row) throw notFound("Relation");
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "task_relation", entityId: id, action: "delete" },
    ]);
    await recordTaskActivity(tx, workspaceId, [row.blockingTaskId, row.blockedTaskId], actorId, source, {
      kind: "dependency_removed",
      blockingTaskId: row.blockingTaskId,
      blockedTaskId: row.blockedTaskId,
    });
  });
}

/** Removes a deleted task's relations (in the caller's transaction) and returns their tombstones. */
export async function deleteRelationsOfTask(tx: Transaction, taskId: string): Promise<ChangeList> {
  const removed = await tx
    .delete(taskRelations)
    .where(or(eq(taskRelations.blockingTaskId, taskId), eq(taskRelations.blockedTaskId, taskId)))
    .returning();
  return removed.map(relationDeleteChange);
}

/** A link change invalidates the on-demand list on both tasks. */
export function taskLinkChange(row: RelationRow): ChangeList[number] {
  return {
    entity: "task_link",
    entityId: row.id,
    action: "upsert",
    data: { taskIds: [row.blockingTaskId, row.blockedTaskId] },
  };
}

function relationDeleteChange(row: RelationRow): ChangeList[number] {
  if (row.kind !== "blocks") return taskLinkChange(row);
  return { entity: "task_relation", entityId: row.id, action: "delete" };
}

/**
 * Sync-log changes for the relations touching `taskIds` when their team is
 * archived (tombstones; rows are kept) or restored (upserts for relations whose
 * other task is visible again too). Mirrors what archiving does to the tasks.
 */
export async function relationChangesForTeamVisibility(
  tx: Transaction,
  workspaceId: string,
  taskIds: string[],
  visible: boolean,
): Promise<ChangeList> {
  if (taskIds.length === 0) return [];
  const touching = await tx
    .select()
    .from(taskRelations)
    .where(
      and(
        eq(taskRelations.workspaceId, workspaceId),
        isNull(taskRelations.deletedAt),
        or(inArray(taskRelations.blockingTaskId, taskIds), inArray(taskRelations.blockedTaskId, taskIds)),
      ),
    );
  if (!visible) {
    return touching.map(relationDeleteChange);
  }
  const visibleIds = new Set((await listTaskRelations(tx, workspaceId)).map((r) => r.id));
  return touching.flatMap((r): ChangeList => {
    if (r.kind !== "blocks") return [taskLinkChange(r)];
    if (!visibleIds.has(r.id)) return [];
    return [{ entity: "task_relation", entityId: r.id, action: "upsert", data: serializeTaskRelation(r) }];
  });
}
