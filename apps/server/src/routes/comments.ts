import { commentUpdateSchema, taskCommentCreateSchema } from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { requireWriter } from "../middleware/roles";
import { createTaskComment, deleteComment, listTaskComments, updateComment } from "../services/comments";
import { emailNotifier } from "../services/notifications";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });

/**
 * Comments. Fetched per task (not part of the bootstrap snapshot), but every
 * write still lands in the sync log. Mounted by `taskRoutes`.
 */
export const commentRoutes = new Hono<WorkspaceEnv>()
  .get("/tasks/:id/comments", validate("param", idParam), async (c) =>
    c.json({ comments: await listTaskComments(c.var.db, c.var.workspace.id, c.req.valid("param").id) }),
  )
  .post(
    "/tasks/:id/comments",
    requireWriter,
    validate("param", idParam),
    validate("json", taskCommentCreateSchema),
    async (c) =>
      c.json(
        await createTaskComment(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          emailNotifier(c.var),
        ),
        201,
      ),
  )
  .patch(
    "/comments/:id",
    requireWriter,
    validate("param", idParam),
    validate("json", commentUpdateSchema),
    async (c) =>
      c.json(
        await updateComment(
          c.var.db,
          c.var.workspace.id,
          { id: c.var.user.id, role: c.var.workspace.role },
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete("/comments/:id", requireWriter, validate("param", idParam), async (c) => {
    await deleteComment(
      c.var.db,
      c.var.workspace.id,
      { id: c.var.user.id, role: c.var.workspace.role },
      c.req.valid("param").id,
    );
    return c.body(null, 204);
  });
