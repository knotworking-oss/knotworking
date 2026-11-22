import {
  npdProjectCreateSchema,
  npdProjectListQuerySchema,
  npdProjectUpdateSchema,
  npdSignoffSchema,
  npdTrialSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { requireModuleLevel } from "../middleware/modules";
import {
  createProject,
  getProject,
  launchProject,
  listProjects,
  recordSignoff,
  recordTrial,
  updateProject,
} from "../services/npd";
import { workspaceToday } from "../services/time-zone";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });

/**
 * Product development module (`npd`). Mounted at `/v1/workspaces/:slug`; the module guard has
 * already required `read` for safe methods and `write` for the rest.
 */
export const npdRoutes = new Hono<WorkspaceEnv>()
  .get("/npd/projects", validate("query", npdProjectListQuerySchema), async (c) =>
    c.json(await listProjects(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/npd/projects/:id", validate("param", idParam), async (c) =>
    c.json(await getProject(c.var.db, c.var.workspace.id, c.req.valid("param").id, c.var.activeModules)),
  )
  .post("/npd/projects", validate("json", npdProjectCreateSchema), async (c) =>
    c.json(
      await createProject(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("json"),
        c.var.activeModules,
      ),
      201,
    ),
  )
  .patch(
    "/npd/projects/:id",
    validate("param", idParam),
    validate("json", npdProjectUpdateSchema),
    async (c) =>
      c.json(
        await updateProject(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          c.var.activeModules,
        ),
      ),
  )
  .post("/npd/projects/:id/trials", validate("param", idParam), validate("json", npdTrialSchema), async (c) =>
    c.json(
      await recordTrial(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
        await workspaceToday(c.var.db, c.var.workspace.id),
        c.var.activeModules,
      ),
      201,
    ),
  )
  // A sign-off attests that a person reviewed or obtained it: never an API token.
  .post(
    "/npd/projects/:id/signoffs",
    forbidTokens,
    validate("param", idParam),
    validate("json", npdSignoffSchema),
    async (c) =>
      c.json(
        await recordSignoff(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await workspaceToday(c.var.db, c.var.workspace.id),
          c.var.activeModules,
        ),
      ),
  )
  // Launching is a sign-off: a person with `manage`, with every checklist item met.
  .post(
    "/npd/projects/:id/launch",
    forbidTokens,
    requireModuleLevel("npd", "manage"),
    validate("param", idParam),
    async (c) =>
      c.json(
        await launchProject(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.var.activeModules,
        ),
      ),
  );
