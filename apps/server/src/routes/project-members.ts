import { teamMemberAddSchema } from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { requireWriter } from "../middleware/roles";
import { listProjectPeople, saveProjectPerson } from "../services/project-members";
import { validate } from "../validate";

const project = z.object({ id: z.uuid() });
const participant = project.extend({ userId: z.uuid() });

export const projectMemberRoutes = new Hono<WorkspaceEnv>()
  .get("/projects/:id/members", validate("param", project), async (c) =>
    c.json(await listProjectPeople(c.var.db, c.var.workspace.id, c.req.valid("param").id, c.var.user.id)),
  )
  .post(
    "/projects/:id/members",
    requireWriter,
    validate("param", project),
    validate("json", teamMemberAddSchema),
    async (c) =>
      c.json(
        await saveProjectPerson(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          c.var.user.id,
          c.req.valid("json").userId,
          { contributor: true },
        ),
      ),
  )
  .delete("/projects/:id/members/:userId", requireWriter, validate("param", participant), async (c) =>
    c.json(
      await saveProjectPerson(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("param").id,
        c.var.user.id,
        c.req.valid("param").userId,
        { contributor: false },
      ),
    ),
  )
  .put(
    "/projects/:id/following",
    validate("param", project),
    validate("json", z.object({ following: z.boolean() })),
    async (c) =>
      c.json(
        await saveProjectPerson(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          c.var.user.id,
          c.var.user.id,
          { following: c.req.valid("json").following },
        ),
      ),
  );
