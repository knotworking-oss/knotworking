import {
  projectCreateSchema,
  projectFromTemplateSchema,
  projectUpdateSchema,
  taskCreateSchema,
  taskListQuerySchema,
  taskRelationCreateSchema,
  taskUpdateSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { canRead } from "../middleware/modules";
import { requireWriter } from "../middleware/roles";
import { listBacklinks } from "../services/backlinks";
import { emailNotifier } from "../services/notifications";
import { createProjectFromTemplate } from "../services/project-templates";
import { createProject, deleteProject, listProjects, updateProject } from "../services/projects";
import { createTaskRelation, deleteTaskRelation } from "../services/task-relations";
import { createTask, deleteTask, getTask, listTasks, updateTask } from "../services/tasks";
import { validate } from "../validate";
import { commentRoutes } from "./comments";

const idParam = z.object({ id: z.uuid() });

/**
 * Tasks module (`tasks`): tasks, their dependencies, comments and projects. Mounted at
 * `/v1/workspaces/:slug`; the module guard has already required `read` for safe methods and
 * `write` for the rest. Teams, workflow states and labels are configured by `structureRoutes`.
 */
export const taskRoutes = new Hono<WorkspaceEnv>()
  // ── Tasks ──
  .get("/tasks", validate("query", taskListQuerySchema), async (c) =>
    c.json({ tasks: await listTasks(c.var.db, c.var.workspace.id, c.req.valid("query")) }),
  )
  .get("/tasks/:id", validate("param", idParam), async (c) =>
    c.json(await getTask(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .get("/tasks/:id/backlinks", validate("param", idParam), async (c) =>
    c.json(
      await listBacklinks(
        c.var.db,
        c.var.workspace.id,
        { kind: "task", id: c.req.valid("param").id },
        { documents: canRead(c, "docs"), tasks: true },
      ),
    ),
  )
  .post("/tasks", requireWriter, validate("json", taskCreateSchema), async (c) =>
    c.json(
      await createTask(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("json"),
        emailNotifier(c.var),
      ),
      201,
    ),
  )
  .patch(
    "/tasks/:id",
    requireWriter,
    validate("param", idParam),
    validate("json", taskUpdateSchema),
    async (c) =>
      c.json(
        await updateTask(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          emailNotifier(c.var),
        ),
      ),
  )
  .delete("/tasks/:id", requireWriter, validate("param", idParam), async (c) => {
    await deleteTask(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })

  // ── Task dependencies (listed in the bootstrap; `blockingTaskId` blocks `blockedTaskId`) ──
  .post("/task-relations", requireWriter, validate("json", taskRelationCreateSchema), async (c) =>
    c.json(await createTaskRelation(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .delete("/task-relations/:id", requireWriter, validate("param", idParam), async (c) => {
    await deleteTaskRelation(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })

  // ── Comments (GET/POST /tasks/:id/comments, PATCH/DELETE /comments/:id) ──
  .route("/", commentRoutes)

  // ── Projects ──
  .get("/projects", async (c) => c.json({ projects: await listProjects(c.var.db, c.var.workspace.id) }))
  .post("/projects", requireWriter, validate("json", projectCreateSchema), async (c) =>
    c.json(await createProject(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .post("/projects/from-template", requireWriter, validate("json", projectFromTemplateSchema), async (c) =>
    c.json(
      await createProjectFromTemplate(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("json"),
        emailNotifier(c.var),
      ),
      201,
    ),
  )
  .patch(
    "/projects/:id",
    requireWriter,
    validate("param", idParam),
    validate("json", projectUpdateSchema),
    async (c) =>
      c.json(
        await updateProject(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete("/projects/:id", requireWriter, validate("param", idParam), async (c) => {
    await deleteProject(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  });
