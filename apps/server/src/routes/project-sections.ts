import { sectionCreateSchema, sectionUpdateSchema } from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { requireWriter } from "../middleware/roles";
import { changeSection, createSection, listProjectSections } from "../services/project-sections";
import { validate } from "../validate";

const project = z.object({ id: z.uuid() });
const section = project.extend({ sectionId: z.uuid() });

export const projectSectionRoutes = new Hono<WorkspaceEnv>()
  .get("/projects/:id/sections", validate("param", project), async (c) =>
    c.json({ sections: await listProjectSections(c.var.db, c.var.workspace.id, c.req.valid("param").id) }),
  )
  .post(
    "/projects/:id/sections",
    requireWriter,
    validate("param", project),
    validate("json", sectionCreateSchema),
    async (c) =>
      c.json(
        await createSection(
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
    "/projects/:id/sections/:sectionId",
    requireWriter,
    validate("param", section),
    validate("json", sectionUpdateSchema),
    async (c) => {
      const { id, sectionId } = c.req.valid("param");
      return c.json(
        await changeSection(c.var.db, c.var.workspace.id, id, sectionId, c.var.user.id, c.req.valid("json")),
      );
    },
  )
  .delete("/projects/:id/sections/:sectionId", requireWriter, validate("param", section), async (c) => {
    const { id, sectionId } = c.req.valid("param");
    await changeSection(c.var.db, c.var.workspace.id, id, sectionId, c.var.user.id, null);
    return c.body(null, 204);
  });
