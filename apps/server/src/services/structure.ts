import {
  sortKeyBetween,
  sortKeysBetween,
  workflowStateTypes,
  type LabelCreateInput,
  type LabelUpdateInput,
  type TeamCreateInput,
  type TeamUpdateInput,
  type WorkflowStateCreateInput,
  type WorkflowStateType,
  type WorkflowStateUpdateInput,
} from "@knotworking/core";
import {
  defaultWorkflow,
  labels,
  recordChanges,
  taskLabels,
  tasks,
  teamMembers,
  teams,
  workflowStates,
  workspaceMembers,
  type Database,
  type Transaction,
} from "@knotworking/db";
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { relationChangesForTeamVisibility } from "./task-relations";
import { lifecycleFor } from "./tasks";

/**
 * Admin-managed workspace structure: teams, their members and workflow states,
 * and labels. Every write runs in a transaction that appends to the sync log.
 */

type ChangeList = Parameters<typeof recordChanges>[3];
type TaskRow = typeof tasks.$inferSelect;

/** Rows per insert: keeps a big team's batch under Postgres' bind-parameter limit. */
const CHANGE_BATCH = 1000;

/** `recordChanges` in slices, in order, within the caller's transaction. */
async function recordChangesInChunks(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  changes: ChangeList,
) {
  for (let i = 0; i < changes.length; i += CHANGE_BATCH) {
    await recordChanges(tx, workspaceId, actorId, changes.slice(i, i + CHANGE_BATCH));
  }
}

/**
 * Structural edits are rare, so they take the workspace's advisory lock up front
 * (`recordChanges` re-takes it, which is fine within one transaction). That
 * serialises them: two admins can't both claim a team key or both delete the last
 * "Done" state.
 */
async function lockWorkspace(tx: Transaction, workspaceId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`);
}

/** `{}` and `{ name: undefined }` are no-ops (Drizzle refuses an empty `set`). */
const patchOf = (input: object) =>
  Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

// ─── Teams ───────────────────────────────────────────────────────────────────

async function getLiveTeam(tx: Transaction, workspaceId: string, teamId: string) {
  const [team] = await tx
    .select()
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId), isNull(teams.deletedAt)));
  if (!team) throw notFound("Team");
  return team;
}

async function assertKeyFree(tx: Transaction, workspaceId: string, key: string, exceptTeamId?: string) {
  const [taken] = await tx
    .select({ id: teams.id, archivedAt: teams.deletedAt })
    .from(teams)
    .where(
      and(
        eq(teams.workspaceId, workspaceId),
        eq(teams.key, key),
        exceptTeamId ? ne(teams.id, exceptTeamId) : undefined,
      ),
    );
  if (taken) {
    throw new ApiError(
      409,
      "team_key_taken",
      taken.archivedAt
        ? `The key ${key} belongs to an archived team. Restore that team or pick another key`
        : `A team with the key ${key} already exists`,
    );
  }
}

async function assertActiveMembers(tx: Transaction, workspaceId: string, userIds: string[]) {
  if (userIds.length === 0) return;
  const found = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        inArray(workspaceMembers.userId, userIds),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  if (found.length !== new Set(userIds).size) throw badRequest("memberIds must be active workspace members");
}

export async function listArchivedTeams(db: Database, workspaceId: string) {
  return db
    .select()
    .from(teams)
    .where(and(eq(teams.workspaceId, workspaceId), isNotNull(teams.deletedAt)))
    .orderBy(asc(teams.name));
}

/** Creates a team with the default workflow (Backlog … Canceled) and optional members. */
export async function createTeam(db: Database, workspaceId: string, actorId: string, input: TeamCreateInput) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    await assertKeyFree(tx, workspaceId, input.key);
    const memberIds = [...new Set(input.memberIds ?? [])];
    await assertActiveMembers(tx, workspaceId, memberIds);

    const [team] = await tx
      .insert(teams)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        icon: input.icon ?? null,
        color: input.color ?? "gray",
      })
      .returning();
    const keys = sortKeysBetween(null, null, defaultWorkflow.length);
    const states = await tx
      .insert(workflowStates)
      .values(
        defaultWorkflow.map(([name, type], i) => ({
          workspaceId,
          teamId: team!.id,
          name,
          type,
          sortOrder: keys[i]!,
        })),
      )
      .returning();
    const members = memberIds.length
      ? await tx
          .insert(teamMembers)
          .values(memberIds.map((userId) => ({ workspaceId, teamId: team!.id, userId })))
          .returning()
      : [];

    await recordChanges(tx, workspaceId, actorId, [
      { entity: "team", entityId: team!.id, action: "upsert", data: team },
      ...states.map((s) => ({
        entity: "workflow_state" as const,
        entityId: s.id,
        action: "upsert" as const,
        data: s,
      })),
      ...members.map((m) => ({
        entity: "team_member" as const,
        entityId: m.id,
        action: "upsert" as const,
        data: m,
      })),
    ]);
    return team!;
  });
}

/**
 * Renames or restyles a team, or archives / restores it (`archived`). Archiving
 * hides the team and its tasks (a delete for each in the sync log) but keeps all
 * data; restoring re-sends the tasks (upserts) so every client gets everything back.
 */
export async function updateTeam(
  db: Database,
  workspaceId: string,
  actorId: string,
  teamId: string,
  input: TeamUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const [current] = await tx
      .select()
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)));
    if (!current) throw notFound("Team");
    const { archived, ...fields } = input;
    if (current.deletedAt && archived !== false) {
      throw new ApiError(409, "team_archived", "This team is archived. Restore it before editing");
    }
    if (Object.keys(patchOf(input)).length === 0) return current;
    if (fields.key && fields.key !== current.key) await assertKeyFree(tx, workspaceId, fields.key, teamId);

    const patch: Partial<typeof teams.$inferInsert> = { ...fields };
    if (archived !== undefined) patch.deletedAt = archived ? new Date() : null;
    const [team] = await tx.update(teams).set(patch).where(eq(teams.id, teamId)).returning();
    const changes: ChangeList = [
      team!.deletedAt
        ? { entity: "team", entityId: teamId, action: "delete" }
        : { entity: "team", entityId: teamId, action: "upsert", data: team },
    ];
    // Task lists hide tasks of archived teams, so the log must follow: archiving
    // deletes the team's live tasks for clients, restoring re-sends them (also for
    // clients that loaded while the team was archived and never saw them).
    if (Boolean(current.deletedAt) !== Boolean(team!.deletedAt)) {
      const teamTasks = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.teamId, teamId), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)));
      changes.push(
        ...(team!.deletedAt
          ? teamTasks.map((t) => ({ entity: "task" as const, entityId: t.id, action: "delete" as const }))
          : taskChanges(teamTasks)),
        // Their dependencies follow: hidden with the tasks, re-sent when both ends are visible again.
        ...(await relationChangesForTeamVisibility(
          tx,
          workspaceId,
          teamTasks.map((t) => t.id),
          !team!.deletedAt,
        )),
      );
    }
    await recordChangesInChunks(tx, workspaceId, actorId, changes);
    return team!;
  });
}

export async function addTeamMember(
  db: Database,
  workspaceId: string,
  actorId: string,
  teamId: string,
  userId: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    await getLiveTeam(tx, workspaceId, teamId);
    await assertActiveMembers(tx, workspaceId, [userId]);
    const [existing] = await tx
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    if (existing) return { member: existing, created: false };
    const [member] = await tx.insert(teamMembers).values({ workspaceId, teamId, userId }).returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "team_member", entityId: member!.id, action: "upsert", data: member },
    ]);
    return { member: member!, created: true };
  });
}

export async function removeTeamMember(
  db: Database,
  workspaceId: string,
  actorId: string,
  teamId: string,
  userId: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    await getLiveTeam(tx, workspaceId, teamId);
    // Join rows are hard-deleted (unique on team + user); the delete is still logged.
    const [row] = await tx
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .returning({ id: teamMembers.id });
    if (!row) throw notFound("Team member");
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "team_member", entityId: row.id, action: "delete" },
    ]);
  });
}

// ─── Workflow states ─────────────────────────────────────────────────────────

const liveStates = (teamId: string) =>
  and(eq(workflowStates.teamId, teamId), isNull(workflowStates.deletedAt));
const isOpen = (t: WorkflowStateType) => t === "backlog" || t === "unstarted" || t === "started";
const rankOf = (t: WorkflowStateType) => workflowStateTypes.indexOf(t);

/**
 * A workflow must keep an open state (where new work starts) and a completed
 * state (where it ends), or tasks could not be created or finished.
 */
async function assertWorkflowUsable(tx: Transaction, teamId: string) {
  const states = await tx
    .select({ type: workflowStates.type })
    .from(workflowStates)
    .where(liveStates(teamId));
  if (!states.some((s) => isOpen(s.type)) || !states.some((s) => s.type === "completed")) {
    throw new ApiError(
      409,
      "invalid_workflow",
      "A team needs at least one open state (Backlog, Todo or In Progress) and one Done state",
    );
  }
}

async function getState(tx: Transaction, workspaceId: string, stateId: string) {
  const [state] = await tx
    .select()
    .from(workflowStates)
    .where(
      and(
        eq(workflowStates.id, stateId),
        eq(workflowStates.workspaceId, workspaceId),
        isNull(workflowStates.deletedAt),
      ),
    );
  if (!state) throw notFound("Workflow state");
  return state;
}

/** Puts tasks into a state; their started/completed/canceled timestamps follow its category. */
async function placeTasks(tx: Transaction, taskRows: TaskRow[], stateId: string, type: WorkflowStateType) {
  const placed: TaskRow[] = [];
  for (const task of taskRows) {
    const [row] = await tx
      .update(tasks)
      .set({ stateId, ...lifecycleFor(type, task) })
      .where(eq(tasks.id, task.id))
      .returning();
    placed.push(row!);
  }
  return placed;
}

const taskChanges = (rows: TaskRow[]): ChangeList =>
  rows.map((t) => ({ entity: "task" as const, entityId: t.id, action: "upsert" as const, data: t }));

const tasksIn = (tx: Transaction, stateId: string) =>
  tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.stateId, stateId), isNull(tasks.deletedAt)));

export async function createState(
  db: Database,
  workspaceId: string,
  actorId: string,
  teamId: string,
  input: WorkflowStateCreateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    await getLiveTeam(tx, workspaceId, teamId);
    let sortOrder = input.sortOrder;
    if (!sortOrder) {
      // Right after the last state of the same or an earlier category, so the list stays grouped.
      const existing = await tx
        .select()
        .from(workflowStates)
        .where(liveStates(teamId))
        .orderBy(asc(workflowStates.sortOrder));
      const index = existing.findLastIndex((s) => rankOf(s.type) <= rankOf(input.type));
      sortOrder = sortKeyBetween(existing[index]?.sortOrder, existing[index + 1]?.sortOrder);
    }
    const [state] = await tx
      .insert(workflowStates)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        teamId,
        name: input.name,
        type: input.type,
        description: input.description ?? null,
        sortOrder,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "workflow_state", entityId: state!.id, action: "upsert", data: state },
    ]);
    return state!;
  });
}

/**
 * Renames, re-describes, reorders (`sortOrder`) or re-categorises a state. When the
 * category changes, the lifecycle timestamps of the tasks in it follow.
 */
export async function updateState(
  db: Database,
  workspaceId: string,
  actorId: string,
  stateId: string,
  input: WorkflowStateUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const current = await getState(tx, workspaceId, stateId);
    if (Object.keys(patchOf(input)).length === 0) return current;
    const [state] = await tx
      .update(workflowStates)
      .set(input)
      .where(eq(workflowStates.id, stateId))
      .returning();
    const changes: ChangeList = [
      { entity: "workflow_state", entityId: stateId, action: "upsert", data: state },
    ];
    if (input.type && input.type !== current.type) {
      await assertWorkflowUsable(tx, current.teamId);
      changes.push(...taskChanges(await placeTasks(tx, await tasksIn(tx, stateId), stateId, input.type)));
    }
    await recordChanges(tx, workspaceId, actorId, changes);
    return state!;
  });
}

/**
 * Deletes a state. If tasks are still in it the request is refused (409
 * `state_in_use`) unless `moveTasksTo` names another state of the same team to
 * receive them.
 */
export async function deleteState(
  db: Database,
  workspaceId: string,
  actorId: string,
  stateId: string,
  moveTasksTo?: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const state = await getState(tx, workspaceId, stateId);
    const inState = await tasksIn(tx, stateId);

    const changes: ChangeList = [];
    if (inState.length > 0) {
      if (!moveTasksTo) {
        throw new ApiError(
          409,
          "state_in_use",
          `${inState.length} ${inState.length === 1 ? "task is" : "tasks are"} still in "${state.name}". Move them to another state first`,
          { taskCount: inState.length },
        );
      }
      if (moveTasksTo === stateId) throw badRequest("moveTasksTo must be a different state");
      const target = await getState(tx, workspaceId, moveTasksTo).catch(() => {
        throw badRequest("Unknown moveTasksTo state");
      });
      if (target.teamId !== state.teamId) throw badRequest("moveTasksTo must be a state of the same team");
      changes.push(...taskChanges(await placeTasks(tx, inState, target.id, target.type)));
    }

    await tx.update(workflowStates).set({ deletedAt: new Date() }).where(eq(workflowStates.id, stateId));
    await assertWorkflowUsable(tx, state.teamId);
    changes.push({ entity: "workflow_state", entityId: stateId, action: "delete" });
    await recordChanges(tx, workspaceId, actorId, changes);
  });
}

// ─── Labels ──────────────────────────────────────────────────────────────────

async function assertLabelNameFree(
  tx: Transaction,
  workspaceId: string,
  teamId: string | null,
  name: string,
  exceptId?: string,
) {
  const [clash] = await tx
    .select({ id: labels.id })
    .from(labels)
    .where(
      and(
        eq(labels.workspaceId, workspaceId),
        isNull(labels.deletedAt),
        teamId ? eq(labels.teamId, teamId) : isNull(labels.teamId),
        sql`lower(${labels.name}) = lower(${name})`,
        exceptId ? ne(labels.id, exceptId) : undefined,
      ),
    );
  if (clash) throw new ApiError(409, "label_exists", `A label named "${name}" already exists`);
}

async function getLabel(tx: Transaction, workspaceId: string, labelId: string) {
  const [label] = await tx
    .select()
    .from(labels)
    .where(and(eq(labels.id, labelId), eq(labels.workspaceId, workspaceId), isNull(labels.deletedAt)));
  if (!label) throw notFound("Label");
  return label;
}

export async function createLabel(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: LabelCreateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const teamId = input.teamId ?? null;
    if (teamId) {
      await getLiveTeam(tx, workspaceId, teamId).catch(() => {
        throw badRequest("Unknown teamId");
      });
    }
    await assertLabelNameFree(tx, workspaceId, teamId, input.name);
    const [label] = await tx
      .insert(labels)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        teamId,
        name: input.name,
        color: input.color ?? "gray",
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "label", entityId: label!.id, action: "upsert", data: label },
    ]);
    return label!;
  });
}

export async function updateLabel(
  db: Database,
  workspaceId: string,
  actorId: string,
  labelId: string,
  input: LabelUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const current = await getLabel(tx, workspaceId, labelId);
    if (Object.keys(patchOf(input)).length === 0) return current;
    if (input.name) await assertLabelNameFree(tx, workspaceId, current.teamId, input.name, labelId);
    const [label] = await tx.update(labels).set(input).where(eq(labels.id, labelId)).returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "label", entityId: labelId, action: "upsert", data: label },
    ]);
    return label!;
  });
}

/** Deletes a label and takes it off every task that had it. */
export async function deleteLabel(db: Database, workspaceId: string, actorId: string, labelId: string) {
  await db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    await getLabel(tx, workspaceId, labelId);
    const removed = await tx
      .delete(taskLabels)
      .where(eq(taskLabels.labelId, labelId))
      .returning({ id: taskLabels.id });
    await tx.update(labels).set({ deletedAt: new Date() }).where(eq(labels.id, labelId));
    await recordChanges(tx, workspaceId, actorId, [
      ...removed.map((r) => ({ entity: "task_label" as const, entityId: r.id, action: "delete" as const })),
      { entity: "label", entityId: labelId, action: "delete" },
    ]);
  });
}
