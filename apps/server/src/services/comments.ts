import {
  docToPlainText,
  type CommentUpdateInput,
  type TaskCommentCreateInput,
  type WorkspaceRole,
} from "@knotworking/core";
import { comments, recordChanges, tasks, type Database, type Executor } from "@knotworking/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { isAdmin } from "./members";
import { notifyTaskCommented, type NotifiedCallback } from "./notifications";

type CommentRow = typeof comments.$inferSelect;

/** Wire format for a comment. `authorId` is null once the author's account is gone. */
export function serializeComment(row: CommentRow) {
  const { deletedAt: _deleted, workspaceId: _ws, ...rest } = row;
  return rest;
}

export interface CommentActor {
  id: string;
  role: WorkspaceRole;
}

async function assertTask(db: Executor, workspaceId: string, taskId: string) {
  const [task] = await db
    .select({ id: tasks.id, title: tasks.title, assigneeId: tasks.assigneeId })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)));
  if (!task) throw notFound("Task");
  return task;
}

async function getLiveComment(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(comments)
    .where(and(eq(comments.id, id), eq(comments.workspaceId, workspaceId), isNull(comments.deletedAt)));
  if (!row) throw notFound("Comment");
  return row;
}

/** Oldest first, so a thread reads top to bottom. */
export async function listTaskComments(db: Database, workspaceId: string, taskId: string) {
  await assertTask(db, workspaceId, taskId);
  const rows = await db
    .select()
    .from(comments)
    .where(
      and(eq(comments.workspaceId, workspaceId), eq(comments.taskId, taskId), isNull(comments.deletedAt)),
    )
    .orderBy(asc(comments.createdAt), asc(comments.id));
  return rows.map(serializeComment);
}

export async function createTaskComment(
  db: Database,
  workspaceId: string,
  actorId: string,
  taskId: string,
  input: TaskCommentCreateInput,
  onNotified?: NotifiedCallback,
) {
  const { comment, notified } = await db.transaction(async (tx) => {
    const task = await assertTask(tx, workspaceId, taskId);
    if (input.parentId) {
      const parent = await getLiveComment(tx, workspaceId, input.parentId).catch(() => null);
      if (parent?.taskId !== taskId) throw badRequest("Unknown parentId");
    }
    const [row] = await tx
      .insert(comments)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        taskId,
        parentId: input.parentId ?? null,
        authorId: actorId,
        body: input.body,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "comment", entityId: row!.id, action: "upsert", data: row },
    ]);
    const notified = await notifyTaskCommented(
      tx,
      workspaceId,
      actorId,
      task,
      docToPlainText(input.body).trim(),
    );
    return { comment: serializeComment(row!), notified };
  });
  if (notified.length) onNotified?.(notified);
  return comment;
}

/** Only the author can edit a comment. */
export async function updateComment(
  db: Database,
  workspaceId: string,
  actor: CommentActor,
  id: string,
  input: CommentUpdateInput,
) {
  return db.transaction(async (tx) => {
    const existing = await getLiveComment(tx, workspaceId, id);
    if (existing.authorId !== actor.id) {
      throw new ApiError(403, "forbidden", "You can only edit your own comments");
    }
    const [row] = await tx
      .update(comments)
      .set({ body: input.body, editedAt: new Date() })
      .where(eq(comments.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actor.id, [
      { entity: "comment", entityId: id, action: "upsert", data: row },
    ]);
    return serializeComment(row!);
  });
}

/** Authors can delete their own comments; admins can delete any. Replies go with their parent. */
export async function deleteComment(db: Database, workspaceId: string, actor: CommentActor, id: string) {
  await db.transaction(async (tx) => {
    const existing = await getLiveComment(tx, workspaceId, id);
    if (existing.authorId !== actor.id && !isAdmin(actor.role)) {
      throw new ApiError(403, "forbidden", "You can only delete your own comments");
    }
    // Collect the reply subtree, level by level.
    const ids = [id];
    for (let level = [id]; level.length;) {
      const children = await tx
        .select({ id: comments.id })
        .from(comments)
        .where(
          and(
            eq(comments.workspaceId, workspaceId),
            inArray(comments.parentId, level),
            isNull(comments.deletedAt),
          ),
        );
      level = children.map((c) => c.id);
      ids.push(...level);
    }
    await tx.update(comments).set({ deletedAt: new Date() }).where(inArray(comments.id, ids));
    await recordChanges(
      tx,
      workspaceId,
      actor.id,
      ids.map((entityId) => ({ entity: "comment" as const, entityId, action: "delete" as const })),
    );
  });
}
