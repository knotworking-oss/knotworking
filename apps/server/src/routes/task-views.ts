import { taskViewCreateSchema, taskViewUpdateSchema } from "@knotworking/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { requireWriter } from "../middleware/roles";
import { changeTaskView, createTaskView, getTaskView, listTaskViews } from "../services/task-views";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const actor = (c: Context<WorkspaceEnv>) => ({
  id: c.var.user.id,
  level: c.var.workspace.modules.tasks ?? ("none" as const),
});

export const taskViewRoutes = new Hono<WorkspaceEnv>()
  .get("/tasks/views", async (c) =>
    c.json({ views: await listTaskViews(c.var.db, c.var.workspace.id, c.var.user.id) }),
  )
  .post("/tasks/views", requireWriter, validate("json", taskViewCreateSchema), async (c) =>
    c.json(await createTaskView(c.var.db, c.var.workspace.id, actor(c), c.req.valid("json")), 201),
  )
  .get("/tasks/views/:id", validate("param", idParam), async (c) =>
    c.json(await getTaskView(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id)),
  )
  .patch(
    "/tasks/views/:id",
    requireWriter,
    validate("param", idParam),
    validate("json", taskViewUpdateSchema),
    async (c) =>
      c.json(
        await changeTaskView(
          c.var.db,
          c.var.workspace.id,
          actor(c),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete("/tasks/views/:id", requireWriter, validate("param", idParam), async (c) => {
    await changeTaskView(c.var.db, c.var.workspace.id, actor(c), c.req.valid("param").id, null);
    return c.body(null, 204);
  });
