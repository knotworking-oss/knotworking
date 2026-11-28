import {
  hasModuleLevel,
  type ModuleAccessLevel,
  type TaskViewCreateInput,
  type TaskViewUpdateInput,
} from "@knotworking/core";
import {
  lockWorkspaceLog,
  recordChanges,
  taskViews,
  teams,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { ApiError, notFound } from "../errors";

function visibleViews(db: Executor, workspaceId: string, userId?: string, id?: string) {
  return db
    .select({ view: taskViews })
    .from(taskViews)
    .leftJoin(teams, and(eq(teams.id, taskViews.teamId), isNull(teams.deletedAt)))
    .where(
      and(
        eq(taskViews.workspaceId, workspaceId),
        isNull(taskViews.deletedAt),
        id ? eq(taskViews.id, id) : undefined,
        or(ne(taskViews.scope, "personal"), userId ? eq(taskViews.ownerId, userId) : undefined),
        or(ne(taskViews.scope, "team"), isNotNull(teams.id)),
      ),
    );
}

export async function listTaskViews(db: Executor, workspaceId: string, userId?: string) {
  return (await visibleViews(db, workspaceId, userId).orderBy(asc(taskViews.name), asc(taskViews.id))).map(
    (row) => row.view,
  );
}

export async function getTaskView(db: Executor, workspaceId: string, userId: string, id: string) {
  const [row] = await visibleViews(db, workspaceId, userId, id);
  if (!row) throw notFound("Task view");
  return row.view;
}

interface Actor {
  id: string;
  level: ModuleAccessLevel;
}

export async function createTaskView(
  db: Database,
  workspaceId: string,
  actor: Actor,
  input: TaskViewCreateInput,
) {
  if (input.scope === "workspace" && !hasModuleLevel(actor.level, "manage"))
    throw new ApiError(403, "forbidden", "Managing Tasks is required to create a workspace view");
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (input.teamId) {
      const [team] = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.id, input.teamId), eq(teams.workspaceId, workspaceId), isNull(teams.deletedAt)));
      if (!team) throw notFound("Team");
    }
    const [view] = await tx
      .insert(taskViews)
      .values({ ...input, workspaceId, ownerId: actor.id })
      .returning();
    await recordChanges(tx, workspaceId, actor.id, [
      { entity: "task_view", entityId: view!.id, action: "upsert", data: view },
    ]);
    return view!;
  });
}

export async function changeTaskView(
  db: Database,
  workspaceId: string,
  actor: Actor,
  id: string,
  patch: TaskViewUpdateInput | null,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const view = await getTaskView(tx, workspaceId, actor.id, id);
    if (view.ownerId !== actor.id && !hasModuleLevel(actor.level, "manage"))
      throw new ApiError(403, "forbidden", "Only the view owner or a Tasks manager can edit this view");
    const [next] = await tx
      .update(taskViews)
      .set(patch ?? { deletedAt: new Date() })
      .where(and(eq(taskViews.workspaceId, workspaceId), eq(taskViews.id, id)))
      .returning();
    // Carry the audience on deletion so private view IDs never reach other members.
    await recordChanges(tx, workspaceId, actor.id, [
      { entity: "task_view", entityId: id, action: "upsert", data: next },
    ]);
    return next!;
  });
}
