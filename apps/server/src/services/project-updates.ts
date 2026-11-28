import type { DocContent, ProjectUpdateCreateInput } from "@knotworking/core";
import {
  lockWorkspaceLog,
  projectUpdateComments,
  projectUpdates,
  projects,
  recordChanges,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { notFound } from "../errors";
import { insertNotifications, type NotifiedCallback } from "./notifications";
import { projectFollowerIds } from "./project-members";

interface Page {
  before?: string;
  limit: number;
}

async function readProject(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id), isNull(projects.deletedAt)));
  if (!row) throw notFound("Project");
  return row;
}

async function assertUpdate(db: Executor, workspaceId: string, projectId: string, updateId: string) {
  const [row] = await db
    .select({ id: projectUpdates.id })
    .from(projectUpdates)
    .where(
      and(
        eq(projectUpdates.workspaceId, workspaceId),
        eq(projectUpdates.projectId, projectId),
        eq(projectUpdates.id, updateId),
      ),
    );
  if (!row) throw notFound("Project update");
}

function pageRows<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}

export async function listProjectUpdates(
  db: Executor,
  workspaceId: string,
  projectId: string,
  { before, limit }: Page,
) {
  await readProject(db, workspaceId, projectId);
  const rows = await db
    .select()
    .from(projectUpdates)
    .where(
      and(
        eq(projectUpdates.workspaceId, workspaceId),
        eq(projectUpdates.projectId, projectId),
        before ? lt(projectUpdates.id, before) : undefined,
      ),
    )
    .orderBy(desc(projectUpdates.id))
    .limit(limit + 1);
  return pageRows(rows, limit);
}

export async function postProjectUpdate(
  db: Database,
  workspaceId: string,
  projectId: string,
  actorId: string,
  input: ProjectUpdateCreateInput,
  onNotified: NotifiedCallback,
) {
  const { update, notified } = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const project = await readProject(tx, workspaceId, projectId);
    const [row] = await tx
      .insert(projectUpdates)
      .values({ ...input, workspaceId, projectId, authorId: actorId })
      .returning();
    const [next] = await tx
      .update(projects)
      .set({ health: input.health, lastUpdateAt: row!.createdAt })
      .where(eq(projects.id, projectId))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "project", entityId: projectId, action: "upsert", data: next },
      { entity: "project_update", entityId: row!.id, action: "upsert", data: { id: row!.id, projectId } },
    ]);
    const followers = await projectFollowerIds(tx, workspaceId, project);
    const notified = await insertNotifications(
      tx,
      workspaceId,
      actorId,
      followers
        .filter((userId) => userId !== actorId)
        .map((userId) => ({
          userId,
          type: "project_update_posted",
          module: "tasks",
          data: { title: project.name, subjectId: projectId },
        })),
    );
    return { update: row!, notified };
  });
  if (notified.length) onNotified(notified);
  return update;
}

export async function listProjectUpdateComments(
  db: Executor,
  workspaceId: string,
  projectId: string,
  updateId: string,
  { before, limit }: Page,
) {
  await readProject(db, workspaceId, projectId);
  await assertUpdate(db, workspaceId, projectId, updateId);
  const rows = await db
    .select()
    .from(projectUpdateComments)
    .where(
      and(
        eq(projectUpdateComments.workspaceId, workspaceId),
        eq(projectUpdateComments.updateId, updateId),
        before ? lt(projectUpdateComments.id, before) : undefined,
      ),
    )
    .orderBy(desc(projectUpdateComments.id))
    .limit(limit + 1);
  return pageRows(rows, limit);
}

export async function commentOnProjectUpdate(
  db: Database,
  workspaceId: string,
  projectId: string,
  updateId: string,
  actorId: string,
  body: DocContent,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await readProject(tx, workspaceId, projectId);
    await assertUpdate(tx, workspaceId, projectId, updateId);
    const [comment] = await tx
      .insert(projectUpdateComments)
      .values({ workspaceId, updateId, authorId: actorId, body })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "project_update", entityId: updateId, action: "upsert", data: { id: updateId, projectId } },
    ]);
    return comment!;
  });
}
