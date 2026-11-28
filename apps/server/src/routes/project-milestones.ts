import { milestoneCreateSchema, milestoneUpdateSchema } from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { requireWriter } from "../middleware/roles";
import { changeMilestone, createMilestone, listProjectMilestones } from "../services/project-milestones";
import { validate } from "../validate";

const project = z.object({ id: z.uuid() });
const milestone = project.extend({ milestoneId: z.uuid() });

export const projectMilestoneRoutes = new Hono<WorkspaceEnv>()
  .get("/projects/:id/milestones", validate("param", project), async (c) =>
    c.json({
      milestones: await listProjectMilestones(c.var.db, c.var.workspace.id, c.req.valid("param").id),
    }),
  )
  .post(
    "/projects/:id/milestones",
    requireWriter,
    validate("param", project),
    validate("json", milestoneCreateSchema),
    async (c) =>
      c.json(
        await createMilestone(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          c.var.user.id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .patch(
    "/projects/:id/milestones/:milestoneId",
    requireWriter,
    validate("param", milestone),
    validate("json", milestoneUpdateSchema),
    async (c) => {
      const { id, milestoneId } = c.req.valid("param");
      return c.json(
        await changeMilestone(
          c.var.db,
          c.var.workspace.id,
          id,
          milestoneId,
          c.var.user.id,
          c.req.valid("json"),
        ),
      );
    },
  )
  .delete("/projects/:id/milestones/:milestoneId", requireWriter, validate("param", milestone), async (c) => {
    const { id, milestoneId } = c.req.valid("param");
    await changeMilestone(c.var.db, c.var.workspace.id, id, milestoneId, c.var.user.id, null);
    return c.body(null, 204);
  });
