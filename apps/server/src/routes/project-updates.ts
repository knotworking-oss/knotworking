import {
  projectUpdateCommentSchema,
  projectUpdateCreateSchema,
  projectUpdatePageSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { requireWriter } from "../middleware/roles";
import { emailNotifier } from "../services/notifications";
import {
  commentOnProjectUpdate,
  listProjectUpdateComments,
  listProjectUpdates,
  postProjectUpdate,
} from "../services/project-updates";
import { validate } from "../validate";

const project = z.object({ id: z.uuid() });
const update = project.extend({ updateId: z.uuid() });

export const projectUpdateRoutes = new Hono<WorkspaceEnv>()
  .get(
    "/projects/:id/updates",
    validate("param", project),
    validate("query", projectUpdatePageSchema),
    async (c) =>
      c.json(
        await listProjectUpdates(c.var.db, c.var.workspace.id, c.req.valid("param").id, c.req.valid("query")),
      ),
  )
  .post(
    "/projects/:id/updates",
    requireWriter,
    validate("param", project),
    validate("json", projectUpdateCreateSchema),
    async (c) =>
      c.json(
        await postProjectUpdate(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          c.var.user.id,
          c.req.valid("json"),
          emailNotifier(c.var),
        ),
        201,
      ),
  )
  .get(
    "/projects/:id/updates/:updateId/comments",
    validate("param", update),
    validate("query", projectUpdatePageSchema),
    async (c) => {
      const { id, updateId } = c.req.valid("param");
      return c.json(
        await listProjectUpdateComments(c.var.db, c.var.workspace.id, id, updateId, c.req.valid("query")),
      );
    },
  )
  .post(
    "/projects/:id/updates/:updateId/comments",
    requireWriter,
    validate("param", update),
    validate("json", projectUpdateCommentSchema),
    async (c) => {
      const { id, updateId } = c.req.valid("param");
      return c.json(
        await commentOnProjectUpdate(
          c.var.db,
          c.var.workspace.id,
          id,
          updateId,
          c.var.user.id,
          c.req.valid("json").body,
        ),
        201,
      );
    },
  );
