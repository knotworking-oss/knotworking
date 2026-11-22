import {
  labelCreateSchema,
  labelUpdateSchema,
  teamCreateSchema,
  teamMemberAddSchema,
  teamUpdateSchema,
  workflowStateCreateSchema,
  workflowStateDeleteQuerySchema,
  workflowStateUpdateSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { requireAdmin } from "../middleware/roles";
import {
  addTeamMember,
  createLabel,
  createState,
  createTeam,
  deleteLabel,
  deleteState,
  listArchivedTeams,
  removeTeamMember,
  updateLabel,
  updateState,
  updateTeam,
} from "../services/structure";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const memberParam = z.object({ id: z.uuid(), userId: z.uuid() });

/**
 * Teams, workflow states and labels. Reads come from the bootstrap snapshot; every
 * route here changes the workspace's structure and is limited to owners and admins.
 * Mounted at `/v1/workspaces/:slug`.
 */
export const structureRoutes = new Hono<WorkspaceEnv>()
  // ── Teams ──
  .get("/teams/archived", requireAdmin, async (c) =>
    c.json({ teams: await listArchivedTeams(c.var.db, c.var.workspace.id) }),
  )
  .post("/teams", requireAdmin, validate("json", teamCreateSchema), async (c) =>
    c.json(await createTeam(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/teams/:id",
    requireAdmin,
    validate("param", idParam),
    validate("json", teamUpdateSchema),
    async (c) =>
      c.json(
        await updateTeam(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/teams/:id/members",
    requireAdmin,
    validate("param", idParam),
    validate("json", teamMemberAddSchema),
    async (c) => {
      const { member, created } = await addTeamMember(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json").userId,
      );
      return c.json(member, created ? 201 : 200);
    },
  )
  .delete("/teams/:id/members/:userId", requireAdmin, validate("param", memberParam), async (c) => {
    const { id, userId } = c.req.valid("param");
    await removeTeamMember(c.var.db, c.var.workspace.id, c.var.user.id, id, userId);
    return c.body(null, 204);
  })

  // ── Workflow states ──
  .post(
    "/teams/:id/states",
    requireAdmin,
    validate("param", idParam),
    validate("json", workflowStateCreateSchema),
    async (c) =>
      c.json(
        await createState(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .patch(
    "/states/:id",
    requireAdmin,
    validate("param", idParam),
    validate("json", workflowStateUpdateSchema),
    async (c) =>
      c.json(
        await updateState(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete(
    "/states/:id",
    requireAdmin,
    validate("param", idParam),
    validate("query", workflowStateDeleteQuerySchema),
    async (c) => {
      await deleteState(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("query").moveTasksTo,
      );
      return c.body(null, 204);
    },
  )

  // ── Labels ──
  .post("/labels", requireAdmin, validate("json", labelCreateSchema), async (c) =>
    c.json(await createLabel(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/labels/:id",
    requireAdmin,
    validate("param", idParam),
    validate("json", labelUpdateSchema),
    async (c) =>
      c.json(
        await updateLabel(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete("/labels/:id", requireAdmin, validate("param", idParam), async (c) => {
    await deleteLabel(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  });
