import {
  actionableDueStates,
  checklistActionListQuerySchema,
  checklistCheckCorrectSchema,
  checklistTemplateListQuerySchema,
  generalChecklistCheckCreateSchema,
  generalChecklistCheckListQuerySchema,
  generalChecklistTemplateCreateSchema,
  generalChecklistTemplateUpdateSchema,
  resolveChecklistActionSchema,
  sortSiteDueItems,
  todayInZone,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import * as checklists from "../services/checklists";
import { workspaceTimeZone } from "../services/time-zone";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const dueQuery = z.object({ include: z.enum(["due", "all"]).default("due") });

export const checklistRoutes = new Hono<WorkspaceEnv>()
  .get("/checklists/due", validate("query", dueQuery), async (c) => {
    const { db, workspace } = c.var;
    const now = new Date();
    const zone = await workspaceTimeZone(db, workspace.id);
    const all = await checklists.checklistDueItems(db, workspace.id, "general", now, zone);
    const items =
      c.req.valid("query").include === "all"
        ? all
        : all.filter(({ state }) => (actionableDueStates as readonly string[]).includes(state));
    return c.json({ today: todayInZone(zone, now), items: sortSiteDueItems(items) });
  })
  .get("/checklists/templates", validate("query", checklistTemplateListQuerySchema), async (c) =>
    c.json(
      await checklists.listChecklistTemplates(c.var.db, c.var.workspace.id, c.req.valid("query"), "general"),
    ),
  )
  .get("/checklists/templates/:id", validate("param", idParam), async (c) =>
    c.json(
      await checklists.getChecklistTemplate(c.var.db, c.var.workspace.id, c.req.valid("param").id, "general"),
    ),
  )
  .post("/checklists/templates", validate("json", generalChecklistTemplateCreateSchema), async (c) =>
    c.json(
      await checklists.createChecklistTemplate(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        {
          ...c.req.valid("json"),
          kind: "general",
          duringProduction: false,
        },
        "general",
      ),
      201,
    ),
  )
  .patch(
    "/checklists/templates/:id",
    validate("param", idParam),
    validate("json", generalChecklistTemplateUpdateSchema),
    async (c) =>
      c.json(
        await checklists.updateChecklistTemplate(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          "general",
        ),
      ),
  )
  .get("/checklists/checks", validate("query", generalChecklistCheckListQuerySchema), async (c) =>
    c.json(
      await checklists.listChecklistChecks(c.var.db, c.var.workspace.id, c.req.valid("query"), "general"),
    ),
  )
  .get("/checklists/checks/:id", validate("param", idParam), async (c) =>
    c.json(
      await checklists.getChecklistCheck(c.var.db, c.var.workspace.id, c.req.valid("param").id, "general"),
    ),
  )
  .post("/checklists/checks", forbidTokens, validate("json", generalChecklistCheckCreateSchema), async (c) =>
    c.json(
      await checklists.recordChecklistCheck(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("json"),
        "general",
      ),
      201,
    ),
  )
  .post(
    "/checklists/checks/:id/correct",
    forbidTokens,
    validate("param", idParam),
    validate("json", checklistCheckCorrectSchema),
    async (c) =>
      c.json(
        await checklists.correctChecklistCheck(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          "general",
        ),
        201,
      ),
  )
  .get("/checklists/actions", validate("query", checklistActionListQuerySchema), async (c) =>
    c.json(await checklists.listChecklistActions(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post(
    "/checklists/actions/:id/resolve",
    forbidTokens,
    validate("param", idParam),
    validate("json", resolveChecklistActionSchema),
    async (c) =>
      c.json(
        await checklists.resolveChecklistAction(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json").note,
        ),
      ),
  );
