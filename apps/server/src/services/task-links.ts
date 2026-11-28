import type { TaskActivitySource, TaskLinkCreateInput } from "@knotworking/core";
import {
  lockWorkspaceLog,
  recordChanges,
  taskRelations,
  tasks,
  teams,
  workflowStates,
  type Database,
} from "@knotworking/db";
import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import type { NotifiedCallback } from "./notifications";
import { assertLiveTasks, reachesTask, taskLinkChange } from "./task-relations";
import { updateTask } from "./tasks";

const touchesTask = (id: string) =>
  or(eq(taskRelations.blockingTaskId, id), eq(taskRelations.blockedTaskId, id));

export async function listTaskLinks(db: Database, workspaceId: string, id: string) {
  await assertLiveTasks(db, workspaceId, [id]);
  const rows = await db
    .select({
      id: taskRelations.id,
      kind: taskRelations.kind,
      sourceId: taskRelations.blockingTaskId,
      task: { id: tasks.id, title: tasks.title, reference: tasks.reference },
    })
    .from(taskRelations)
    .innerJoin(
      tasks,
      and(
        eq(
          tasks.id,
          sql`case when ${taskRelations.blockingTaskId} = ${id} then ${taskRelations.blockedTaskId} else ${taskRelations.blockingTaskId} end`,
        ),
        isNull(tasks.deletedAt),
      ),
    )
    .innerJoin(teams, and(eq(teams.id, tasks.teamId), isNull(teams.deletedAt)))
    .where(and(eq(taskRelations.workspaceId, workspaceId), ne(taskRelations.kind, "blocks"), touchesTask(id)))
    .orderBy(asc(taskRelations.id));
  return {
    links: rows.map(({ id: linkId, kind, sourceId, task }) => ({
      id: linkId,
      kind:
        kind === "related"
          ? ("related" as const)
          : sourceId === id
            ? ("duplicate_of" as const)
            : ("duplicated_by" as const),
      task,
    })),
  };
}

export async function createTaskLink(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: TaskLinkCreateInput,
  onNotified: NotifiedCallback,
  source: TaskActivitySource,
) {
  const { targetId, kind } = input;
  if (id === targetId) throw badRequest("A task can't link to itself");
  const { linkId, notified } = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const found = await assertLiveTasks(tx, workspaceId, [id, targetId]);
    const task = found.find((row) => row.id === id)!;
    if (kind === "duplicate_of" && (await reachesTask(tx, workspaceId, kind, targetId, id))) {
      throw new ApiError(409, "relation_cycle", "That would create a circular duplicate link");
    }
    const [blockingTaskId, blockedTaskId] = kind === "related" ? [id, targetId].sort() : [id, targetId];
    const [row] = await tx
      .insert(taskRelations)
      .values({
        workspaceId,
        creatorId: actorId,
        blockingTaskId: blockingTaskId!,
        blockedTaskId: blockedTaskId!,
        kind,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      throw new ApiError(
        409,
        "relation_exists",
        kind === "related" ? "These tasks are already related" : "This task already has an original",
      );
    }
    let notified: Parameters<NotifiedCallback>[0] = [];
    if (kind === "duplicate_of" && input.close) {
      const [state] = await tx
        .select({ id: workflowStates.id })
        .from(workflowStates)
        .where(
          and(
            eq(workflowStates.teamId, task.teamId),
            eq(workflowStates.type, "canceled"),
            isNull(workflowStates.deletedAt),
          ),
        )
        .orderBy(
          sql`(${workflowStates.id} = ${task.stateId}) desc`,
          asc(workflowStates.sortOrder),
          asc(workflowStates.id),
        )
        .limit(1);
      if (!state) throw badRequest("Add a canceled workflow state to this team before closing duplicates");
      if (state.id !== task.stateId) {
        await updateTask(
          tx,
          workspaceId,
          actorId,
          id,
          { stateId: state.id },
          (rows) => {
            notified = rows;
          },
          source,
        );
      }
    }
    await recordChanges(tx, workspaceId, actorId, [taskLinkChange(row)]);
    return { linkId: row.id, notified };
  });
  if (notified.length) onNotified(notified);
  return { id: linkId };
}

export async function deleteTaskLink(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  linkId: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertLiveTasks(tx, workspaceId, [id]);
    const [row] = await tx
      .delete(taskRelations)
      .where(
        and(
          eq(taskRelations.workspaceId, workspaceId),
          eq(taskRelations.id, linkId),
          ne(taskRelations.kind, "blocks"),
          touchesTask(id),
        ),
      )
      .returning();
    if (!row) throw notFound("Task link");
    await recordChanges(tx, workspaceId, actorId, [taskLinkChange(row)]);
  });
}
