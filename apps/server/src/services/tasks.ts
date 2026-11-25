import {
  sortKeyBetween,
  taskDatesInOrder,
  type TaskCreateInput,
  type TaskUpdateInput,
  type WorkflowStateType,
} from "@knotworking/core";
import {
  taskLabels,
  tasks,
  labels,
  recordChanges,
  teams,
  workflowStates,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, desc, eq, inArray, isNull, min, type SQL } from "drizzle-orm";
import { badRequest, notFound } from "../errors";
import {
  notifyMentioned,
  notifyTaskCreated,
  notifyTaskUpdated,
  type NotificationRow,
  type NotifiedCallback,
} from "./notifications";
import { assertNoCycle, assertRefs } from "./refs";
import { deleteRelationsOfTask } from "./task-relations";

type TaskRow = typeof tasks.$inferSelect;

export interface TaskFilters {
  teamId?: string;
  projectId?: string;
  assigneeId?: string;
  stateType?: WorkflowStateType;
  /** Omitted only for the complete internal bootstrap snapshot. Public lists are paginated. */
  limit?: number;
}

/** Wire format for a task. References are IDs — clients join against bootstrap data. */
export function serializeTask(row: TaskRow, labelIds: string[], withDescription = false) {
  const { description, deletedAt: _deleted, workspaceId: _ws, ...rest } = row;
  return {
    ...rest,
    labelIds,
    ...(withDescription ? { description } : {}),
  };
}

async function labelIdsFor(db: Executor, taskIds: string[]) {
  const map = new Map<string, string[]>();
  if (taskIds.length === 0) return map;
  for (let at = 0; at < taskIds.length; at += 5000) {
    const rows = await db
      .select({ taskId: taskLabels.taskId, labelId: taskLabels.labelId })
      .from(taskLabels)
      .where(and(inArray(taskLabels.taskId, taskIds.slice(at, at + 5000)), isNull(taskLabels.deletedAt)));
    for (const r of rows) map.set(r.taskId, [...(map.get(r.taskId) ?? []), r.labelId]);
  }
  return map;
}

export async function listTasks(db: Executor, workspaceId: string, f: TaskFilters) {
  const where: SQL[] = [eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)];
  if (f.teamId) where.push(eq(tasks.teamId, f.teamId));
  if (f.projectId) where.push(eq(tasks.projectId, f.projectId));
  if (f.assigneeId) where.push(eq(tasks.assigneeId, f.assigneeId));
  if (f.stateType) where.push(eq(workflowStates.type, f.stateType));

  const query = db
    .select({ task: tasks })
    .from(tasks)
    .innerJoin(workflowStates, eq(workflowStates.id, tasks.stateId))
    // Tasks of archived teams are hidden along with the team.
    .innerJoin(teams, and(eq(teams.id, tasks.teamId), isNull(teams.deletedAt)))
    .where(and(...where))
    .orderBy(asc(tasks.sortOrder), desc(tasks.createdAt));
  const rows = await (f.limit === undefined ? query : query.limit(f.limit));

  const labelMap = await labelIdsFor(
    db,
    rows.map((r) => r.task.id),
  );
  return rows.map((r) => serializeTask(r.task, labelMap.get(r.task.id) ?? []));
}

export async function getTask(db: Database, workspaceId: string, taskId: string) {
  const [row] = await db
    .select({ task: tasks })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)));
  if (!row) throw notFound("Task");

  const labelMap = await labelIdsFor(db, [row.task.id]);
  const children = await db
    .select({ task: tasks })
    .from(tasks)
    .where(and(eq(tasks.parentId, row.task.id), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.sortOrder));
  return {
    ...serializeTask(row.task, labelMap.get(row.task.id) ?? [], true),
    children: children.map((c) => serializeTask(c.task, [])),
  };
}

async function resolveState(tx: Transaction, teamId: string, stateId: string | undefined) {
  if (stateId) {
    const [state] = await tx
      .select()
      .from(workflowStates)
      .where(
        and(
          eq(workflowStates.id, stateId),
          eq(workflowStates.teamId, teamId),
          isNull(workflowStates.deletedAt),
        ),
      );
    if (!state) throw badRequest("stateId does not belong to this team");
    return state;
  }
  // Default to the team's first "unstarted" state (e.g. Todo), else its first state.
  const states = await tx
    .select()
    .from(workflowStates)
    .where(and(eq(workflowStates.teamId, teamId), isNull(workflowStates.deletedAt)))
    .orderBy(asc(workflowStates.sortOrder));
  const state = states.find((s) => s.type === "unstarted") ?? states[0];
  if (!state) throw badRequest("Team has no workflow states");
  return state;
}

/** Started/completed/canceled timestamps follow the state's category. */
export function lifecycleFor(type: WorkflowStateType, current?: Pick<TaskRow, "startedAt">) {
  const now = new Date();
  return {
    startedAt: type === "started" || type === "completed" ? (current?.startedAt ?? now) : null,
    completedAt: type === "completed" ? now : null,
    canceledAt: type === "canceled" ? now : null,
  };
}

async function assertLabels(tx: Transaction, workspaceId: string, labelIds: string[]) {
  if (labelIds.length === 0) return;
  const found = await tx
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.workspaceId, workspaceId), inArray(labels.id, labelIds), isNull(labels.deletedAt)));
  if (found.length !== new Set(labelIds).size) throw badRequest("Unknown labelIds");
}

/**
 * `onNotified` runs after the transaction commits with the notifications the
 * write created (used for email delivery); the rows themselves are inserted in
 * the same transaction as the task.
 */
export async function createTask(
  db: Executor,
  workspaceId: string,
  actorId: string,
  input: TaskCreateInput,
  onNotified?: NotifiedCallback,
) {
  let notified: NotificationRow[] = [];
  const result = await db.transaction(async (tx) => {
    const [team] = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, input.teamId), eq(teams.workspaceId, workspaceId), isNull(teams.deletedAt)));
    if (!team) throw badRequest("Unknown teamId");

    const state = await resolveState(tx, team.id, input.stateId);
    await assertRefs(tx, workspaceId, {
      assigneeId: input.assigneeId,
      projectId: input.projectId,
      taskParentId: input.parentId,
    });
    const labelIds = [...new Set(input.labelIds ?? [])];
    await assertLabels(tx, workspaceId, labelIds);

    // New tasks go to the top of manual ordering.
    const [first] = await tx
      .select({ value: min(tasks.sortOrder) })
      .from(tasks)
      .where(and(eq(tasks.teamId, team.id), isNull(tasks.deletedAt)));

    const [task] = await tx
      .insert(tasks)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        teamId: team.id,
        title: input.title,
        description: input.description ?? null,
        stateId: state.id,
        priority: input.priority ?? 0,
        estimateMinutes: input.estimateMinutes ?? null,
        assigneeId: input.assigneeId ?? null,
        projectId: input.projectId ?? null,
        parentId: input.parentId ?? null,
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
        creatorId: actorId,
        sortOrder: input.sortOrder ?? sortKeyBetween(null, first?.value ?? null),
        ...lifecycleFor(state.type),
      })
      .returning();

    const links = labelIds.length
      ? await tx
          .insert(taskLabels)
          .values(labelIds.map((labelId) => ({ workspaceId, taskId: task!.id, labelId })))
          .returning()
      : [];

    await recordChanges(tx, workspaceId, actorId, [
      { entity: "task", entityId: task!.id, action: "upsert", data: task },
      ...links.map((l) => ({
        entity: "task_label" as const,
        entityId: l.id,
        action: "upsert" as const,
        data: l,
      })),
    ]);
    notified = [
      ...(await notifyTaskCreated(tx, workspaceId, actorId, task!)),
      ...(await notifyMentioned(tx, workspaceId, actorId, { task: task! }, null, task!.description)),
    ];
    return serializeTask(task!, labelIds, true);
  });
  if (notified.length) onNotified?.(notified);
  return result;
}

export async function updateTask(
  db: Database,
  workspaceId: string,
  actorId: string,
  taskId: string,
  input: TaskUpdateInput,
  onNotified?: NotifiedCallback,
) {
  let notified: NotificationRow[] = [];
  const result = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ task: tasks })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)));
    if (!current) throw notFound("Task");

    const { labelIds, stateId, ...fields } = input;
    await assertRefs(tx, workspaceId, {
      assigneeId: fields.assigneeId,
      projectId: fields.projectId,
      taskParentId: fields.parentId,
    });
    if (fields.parentId !== undefined) await assertNoCycle(tx, tasks, taskId, fields.parentId);
    // The schema checks dates sent together; a PATCH of one is checked against the stored other.
    const dates = {
      startDate: fields.startDate !== undefined ? fields.startDate : current.task.startDate,
      dueDate: fields.dueDate !== undefined ? fields.dueDate : current.task.dueDate,
    };
    if (!taskDatesInOrder(dates)) throw badRequest("The start date can't be after the due date");
    // `updatedAt` is set explicitly so a labels-only edit still has a column to
    // update (Drizzle rejects an empty SET) and still bumps the task.
    const patch: Partial<typeof tasks.$inferInsert> = { ...fields, updatedAt: new Date() };
    let newState: { name: string } | undefined;
    if (stateId && stateId !== current.task.stateId) {
      const state = await resolveState(tx, current.task.teamId, stateId);
      newState = state;
      Object.assign(patch, { stateId: state.id }, lifecycleFor(state.type, current.task));
    }

    const [task] = await tx.update(tasks).set(patch).where(eq(tasks.id, taskId)).returning();
    const changes: Parameters<typeof recordChanges>[3] = [
      { entity: "task", entityId: taskId, action: "upsert", data: task },
    ];

    let finalLabelIds: string[];
    if (labelIds) {
      const next = [...new Set(labelIds)];
      await assertLabels(tx, workspaceId, next);
      const existing = await tx
        .select()
        .from(taskLabels)
        .where(and(eq(taskLabels.taskId, taskId), isNull(taskLabels.deletedAt)));
      const removed = existing.filter((l) => !next.includes(l.labelId));
      const added = next.filter((id) => !existing.some((l) => l.labelId === id));
      if (removed.length) {
        // Hard delete the join row (unique constraint) and emit a tombstone.
        await tx.delete(taskLabels).where(
          inArray(
            taskLabels.id,
            removed.map((r) => r.id),
          ),
        );
        changes.push(
          ...removed.map((r) => ({
            entity: "task_label" as const,
            entityId: r.id,
            action: "delete" as const,
          })),
        );
      }
      if (added.length) {
        const rows = await tx
          .insert(taskLabels)
          .values(added.map((labelId) => ({ workspaceId, taskId, labelId })))
          .returning();
        changes.push(
          ...rows.map((r) => ({
            entity: "task_label" as const,
            entityId: r.id,
            action: "upsert" as const,
            data: r,
          })),
        );
      }
      finalLabelIds = next;
    } else {
      finalLabelIds = (await labelIdsFor(tx, [taskId])).get(taskId) ?? [];
    }

    await recordChanges(tx, workspaceId, actorId, changes);
    notified = await notifyTaskUpdated(tx, workspaceId, actorId, current.task, task!, newState);
    // Only a description edit can add mentions; the diff against the stored text keeps autosaves quiet.
    if (fields.description !== undefined)
      notified.push(
        ...(await notifyMentioned(
          tx,
          workspaceId,
          actorId,
          { task: task! },
          current.task.description,
          task!.description,
        )),
      );
    return serializeTask(task!, finalLabelIds, true);
  });
  if (notified.length) onNotified?.(notified);
  return result;
}

export async function deleteTask(db: Database, workspaceId: string, actorId: string, taskId: string) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(tasks)
      .set({ deletedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)))
      .returning({ id: tasks.id });
    if (!row) throw notFound("Task");
    // Dependencies on a deleted task go with it (tombstones), so nothing stays "blocked" by it.
    const relationTombstones = await deleteRelationsOfTask(tx, taskId);
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "task", entityId: taskId, action: "delete" },
      ...relationTombstones,
    ]);
  });
}
