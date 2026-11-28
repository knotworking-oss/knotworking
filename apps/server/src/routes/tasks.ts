import {
  projectCreateSchema,
  projectFromTemplateSchema,
  projectUpdateSchema,
  taskActivityQuerySchema,
  taskBulkSchema,
  taskCreateSchema,
  taskListQuerySchema,
  taskLinkCreateSchema,
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
import { listTaskActivity } from "../services/task-activity";
import { projectSubtaskRollups } from "../services/subtask-rollups";
import { bulkChangeTasks } from "../services/task-bulk";
import { getTaskFollowing, setTaskFollowing } from "../services/task-followers";
import { createTaskLink, deleteTaskLink, listTaskLinks } from "../services/task-links";
import { createTaskRelation, deleteTaskRelation } from "../services/task-relations";
import { createTask, deleteTask, duplicateTask, getTask, queryTasks, updateTask } from "../services/tasks";
import { validate } from "../validate";
import { commentRoutes } from "./comments";
import { customFieldRoutes } from "./custom-fields";
import { taskViewRoutes } from "./task-views";
import { projectMilestoneRoutes } from "./project-milestones";
import { projectSectionRoutes } from "./project-sections";
import { projectMemberRoutes } from "./project-members";
import { projectUpdateRoutes } from "./project-updates";

const idParam = z.object({ id: z.uuid() });
const linkTaskParam = z.object({ id: z.uuid().transform((id) => id.toLowerCase()) });

/**
 * Tasks module (`tasks`): tasks, their dependencies, comments and projects. Mounted at
 * `/v1/workspaces/:slug`; the module guard has already required `read` for safe methods and
 * `write` for the rest. Teams, workflow states and labels are configured by `structureRoutes`.
 */
export const taskRoutes = new Hono<WorkspaceEnv>()
  .route("/", customFieldRoutes)
  .route("/", taskViewRoutes)
  .route("/", projectMilestoneRoutes)
  .route("/", projectSectionRoutes)
  .route("/", projectMemberRoutes)
  .route("/", projectUpdateRoutes)
  // ── Tasks ──
  .get("/tasks", validate("query", taskListQuerySchema), async (c) =>
    c.json(await queryTasks(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get(
    "/tasks/:id",
    validate("param", idParam),
    validate("query", z.object({ context: z.literal("true").optional() }).optional()),
    async (c) =>
      c.json(
        await getTask(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          c.req.valid("query")?.context === "true",
        ),
      ),
  )
  .get(
    "/tasks/:id/activity",
    validate("param", idParam),
    validate("query", taskActivityQuerySchema),
    async (c) =>
      c.json(
        await listTaskActivity(c.var.db, c.var.workspace.id, c.req.valid("param").id, c.req.valid("query")),
      ),
  )
  .get("/tasks/:id/links", validate("param", linkTaskParam), async (c) =>
    c.json(await listTaskLinks(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post(
    "/tasks/:id/links",
    requireWriter,
    validate("param", linkTaskParam),
    validate("json", taskLinkCreateSchema),
    async (c) =>
      c.json(
        await createTaskLink(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          emailNotifier(c.var),
          c.var.credential.kind,
        ),
        201,
      ),
  )
  .delete(
    "/tasks/:id/links/:linkId",
    requireWriter,
    validate("param", linkTaskParam.extend({ linkId: z.uuid() })),
    async (c) => {
      const { id, linkId } = c.req.valid("param");
      await deleteTaskLink(c.var.db, c.var.workspace.id, c.var.user.id, id, linkId);
      return c.body(null, 204);
    },
  )
  .get("/tasks/:id/following", validate("param", idParam), async (c) =>
    c.json(await getTaskFollowing(c.var.db, c.var.workspace.id, c.req.valid("param").id, c.var.user.id)),
  )
  .put(
    "/tasks/:id/following",
    validate("param", idParam),
    validate("json", z.object({ following: z.boolean() })),
    async (c) =>
      c.json(
        await setTaskFollowing(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          c.var.user.id,
          c.req.valid("json").following,
        ),
      ),
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
        c.var.credential.kind,
      ),
      201,
    ),
  )
  .post("/tasks/bulk", requireWriter, validate("json", taskBulkSchema), async (c) =>
    c.json(
      await bulkChangeTasks(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("json"),
        emailNotifier(c.var),
        c.var.credential.kind,
      ),
    ),
  )
  .post("/tasks/:id/duplicate", requireWriter, validate("param", idParam), async (c) =>
    c.json(
      await duplicateTask(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        emailNotifier(c.var),
        c.var.credential.kind,
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
          c.var.credential.kind,
        ),
      ),
  )
  .delete("/tasks/:id", requireWriter, validate("param", idParam), async (c) => {
    await deleteTask(
      c.var.db,
      c.var.workspace.id,
      c.var.user.id,
      c.req.valid("param").id,
      c.var.credential.kind,
    );
    return c.body(null, 204);
  })

  // ── Task dependencies (listed in the bootstrap; `blockingTaskId` blocks `blockedTaskId`) ──
  .post("/task-relations", requireWriter, validate("json", taskRelationCreateSchema), async (c) =>
    c.json(
      await createTaskRelation(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("json"),
        c.var.credential.kind,
      ),
      201,
    ),
  )
  .delete("/task-relations/:id", requireWriter, validate("param", idParam), async (c) => {
    await deleteTaskRelation(
      c.var.db,
      c.var.workspace.id,
      c.var.user.id,
      c.req.valid("param").id,
      c.var.credential.kind,
    );
    return c.body(null, 204);
  })

  // ── Comments (GET/POST /tasks/:id/comments, PATCH/DELETE /comments/:id) ──
  .route("/", commentRoutes)

  // ── Projects ──
  .get("/projects", async (c) => c.json({ projects: await listProjects(c.var.db, c.var.workspace.id) }))
  .get("/projects/:id/subtask-rollups", validate("param", idParam), async (c) =>
    c.json(await projectSubtaskRollups(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
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
        { slug: c.var.workspace.slug, canUse: (moduleId) => canRead(c, moduleId) },
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
