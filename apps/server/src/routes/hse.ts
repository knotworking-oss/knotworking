import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  hseCreateSchema,
  hseSaveSchema,
  hseActionSchema,
  hsePermitSignSchema,
  hsePageSchema,
  hseListSchema,
  hseEntrySchema,
  hsePermitCreateSchema,
  hsePermitSaveSchema,
  hsePermitCloseSchema,
  hsePermitListSchema,
  hseIncidentCreateSchema,
  hseIncidentSaveSchema,
  hseIncidentListSchema,
  hasModuleLevel,
  hseIncidentActionCompleteSchema,
  hseIncidentActionCreateSchema,
  hseInjuriesSaveSchema,
  hseReportSchema,
} from "@knotworking/core";
import type { WorkspaceEnv } from "../env";
import {
  addIncidentAction,
  completeIncidentAction,
  hseIncidentOverview,
  incidentFollowUp,
  incidentForReader,
  PEOPLE_HURT_REASON_HIDDEN,
  reportHseIncident,
  saveIncidentInjuries,
} from "../services/hse-incident-follow-up";
import { workspaceToday } from "../services/time-zone";
import { forbidTokens } from "../middleware/auth";
import { assertModule, canRead, requireModuleLevel } from "../middleware/modules";
import { validate } from "../validate";
import {
  createHseRecord,
  saveHseDraft,
  actHseRecord,
  getHseRecord,
  listHseRecords,
  hseHistory,
  listHseEntries,
  createHseEntry,
  voidHseEntry,
  createHsePermit,
  saveHsePermit,
  actHsePermit,
  getHsePermit,
  listHsePermits,
  hsePermitHistory,
} from "../services/hse";
import {
  createHseIncident,
  saveHseIncident,
  closeHseIncident,
  getHseIncident,
  listHseIncidents,
  hseIncidentHistory,
} from "../services/hse-incidents";
const id = z.object({ id: z.uuid() });
const actionParam = z.object({ id: z.uuid(), actionId: z.uuid() });
const incidentManager = (c: Context<WorkspaceEnv>) =>
  hasModuleLevel(c.var.workspace.modules.hse_incidents, "manage");
/** Health details and the people hurt: a signed-in `hse_incidents` manager (incident routes refuse tokens). */
const canSeeRestricted = (c: Context<WorkspaceEnv>) =>
  c.var.credential.kind === "session" && incidentManager(c);
const incidentView = async (c: Context<WorkspaceEnv>, incidentId: string) => {
  const allowed = canSeeRestricted(c);
  const incident = await getHseIncident(c.var.db, c.var.workspace.id, incidentId);
  const followUp = await incidentFollowUp(c.var.db, c.var.workspace.id, incidentId, {
    canSeeRestricted: allowed,
    today: await workspaceToday(c.var.db, c.var.workspace.id),
  });
  return { ...incidentForReader(incident, allowed), ...followUp, canSeeRestricted: allowed };
};
const manage = requireModuleLevel("hse", "manage");
const siteRead = requireModuleLevel("site", "read");
export const hseRoutes = new Hono<WorkspaceEnv>()
  // Anyone with HSE write access (an agent too) reports an incident in which nobody was hurt; it
  // becomes a restricted incident. Only its reference comes back.
  .post("/hse/reports", validate("json", hseReportSchema), async (c) =>
    c.json(await reportHseIncident(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .get("/hse/registers", validate("query", hseListSchema), async (c) =>
    c.json(await listHseRecords(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/hse/registers", validate("json", hseCreateSchema), async (c) => {
    const input = c.req.valid("json");
    if (input.content.actionTaskIds.length) assertModule(c, "tasks", "read");
    if (input.content.supplierId) assertModule(c, "items", "read");
    return c.json(await createHseRecord(c.var.db, c.var.workspace.id, c.var.user.id, input), 201);
  })
  .get("/hse/registers/:id", validate("param", id), async (c) =>
    c.json(await getHseRecord(c.var.db, c.var.workspace.id, c.req.valid("param").id, canRead(c, "items"))),
  )
  .put("/hse/registers/:id/draft", validate("param", id), validate("json", hseSaveSchema), async (c) => {
    const input = c.req.valid("json");
    if (input.content.actionTaskIds.length) assertModule(c, "tasks", "read");
    if (input.content.supplierId) assertModule(c, "items", "read");
    return c.json(
      await saveHseDraft(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id, input),
    );
  })
  .post(
    "/hse/registers/:id/approve",
    forbidTokens,
    manage,
    validate("param", id),
    validate("json", hseActionSchema),
    async (c) =>
      c.json(
        await actHseRecord(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          "approve",
          canRead(c, "items"),
        ),
      ),
  )
  .post("/hse/registers/:id/review", validate("param", id), validate("json", hseActionSchema), async (c) =>
    c.json(
      await actHseRecord(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
        "review",
      ),
    ),
  )
  .post(
    "/hse/registers/:id/archive",
    forbidTokens,
    manage,
    validate("param", id),
    validate("json", hseActionSchema),
    async (c) =>
      c.json(
        await actHseRecord(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          "archive",
        ),
      ),
  )
  .get("/hse/registers/:id/history", validate("param", id), validate("query", hsePageSchema), async (c) =>
    c.json(
      await hseHistory(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("param").id,
        c.req.valid("query"),
        canRead(c, "items"),
      ),
    ),
  )
  .get("/hse/registers/:id/entries", validate("param", id), validate("query", hsePageSchema), async (c) =>
    c.json(await listHseEntries(c.var.db, c.var.workspace.id, c.req.valid("param").id, c.req.valid("query"))),
  )
  .post(
    "/hse/registers/:id/entries",
    forbidTokens,
    validate("param", id),
    validate("json", hseEntrySchema),
    async (c) =>
      c.json(
        await createHseEntry(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .post(
    "/hse/registers/:id/entries/:entryId/void",
    forbidTokens,
    manage,
    validate("param", id.extend({ entryId: z.uuid() })),
    validate("json", hseActionSchema),
    async (c) =>
      c.json(
        await voidHseEntry(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("param").entryId,
          c.req.valid("json"),
        ),
      ),
  )
  .get("/hse/permits", siteRead, validate("query", hsePermitListSchema), async (c) =>
    c.json(await listHsePermits(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/hse/permits", siteRead, validate("json", hsePermitCreateSchema), async (c) => {
    const input = c.req.valid("json");
    if (input.body.visitId) assertModule(c, "attendance", "read");
    return c.json(await createHsePermit(c.var.db, c.var.workspace.id, c.var.user.id, input), 201);
  })
  .get("/hse/permits/:id", siteRead, validate("param", id), async (c) =>
    c.json(await getHsePermit(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .put(
    "/hse/permits/:id",
    siteRead,
    validate("param", id),
    validate("json", hsePermitSaveSchema),
    async (c) => {
      const input = c.req.valid("json");
      if (input.body.visitId) assertModule(c, "attendance", "read");
      return c.json(
        await saveHsePermit(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id, input),
      );
    },
  )
  .get(
    "/hse/permits/:id/history",
    siteRead,
    validate("param", id),
    validate("query", hsePageSchema),
    async (c) =>
      c.json(
        await hsePermitHistory(c.var.db, c.var.workspace.id, c.req.valid("param").id, c.req.valid("query")),
      ),
  )
  .post(
    "/hse/permits/:id/issue",
    forbidTokens,
    manage,
    siteRead,
    validate("param", id),
    validate("json", hsePermitSignSchema),
    async (c) => {
      const permit = await getHsePermit(c.var.db, c.var.workspace.id, c.req.valid("param").id);
      if (permit.body.visitId) assertModule(c, "attendance", "read");
      return c.json(
        await actHsePermit(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          permit.id,
          c.req.valid("json"),
          "issue",
          canRead(c, "attendance"),
          c.var.workspace.availableModules,
        ),
      );
    },
  )
  .post(
    "/hse/permits/:id/suspend",
    forbidTokens,
    manage,
    siteRead,
    validate("param", id),
    validate("json", hseActionSchema),
    async (c) =>
      c.json(
        await actHsePermit(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          "suspend",
        ),
      ),
  )
  .post(
    "/hse/permits/:id/resume",
    forbidTokens,
    manage,
    siteRead,
    validate("param", id),
    validate("json", hsePermitSignSchema),
    async (c) => {
      const permit = await getHsePermit(c.var.db, c.var.workspace.id, c.req.valid("param").id);
      if (permit.body.visitId) assertModule(c, "attendance", "read");
      return c.json(
        await actHsePermit(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          permit.id,
          c.req.valid("json"),
          "resume",
          canRead(c, "attendance"),
          c.var.workspace.availableModules,
        ),
      );
    },
  )
  .post(
    "/hse/permits/:id/close",
    forbidTokens,
    manage,
    siteRead,
    validate("param", id),
    validate("json", hsePermitCloseSchema),
    async (c) =>
      c.json(
        await actHsePermit(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          "close",
        ),
      ),
  )
  .post(
    "/hse/permits/:id/cancel",
    forbidTokens,
    manage,
    siteRead,
    validate("param", id),
    validate("json", hseActionSchema),
    async (c) =>
      c.json(
        await actHsePermit(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          "cancel",
        ),
      ),
  );
export const hseIncidentRoutes = new Hono<WorkspaceEnv>()
  .get("/hse/incidents", forbidTokens, validate("query", hseIncidentListSchema), async (c) =>
    c.json(await listHseIncidents(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  // What needs attention (before `/:id`, which would otherwise take "overview" as an id).
  .get("/hse/incidents/overview", forbidTokens, async (c) =>
    c.json(
      await hseIncidentOverview(
        c.var.db,
        c.var.workspace.id,
        await workspaceToday(c.var.db, c.var.workspace.id),
      ),
    ),
  )
  .post("/hse/incidents", forbidTokens, validate("json", hseIncidentCreateSchema), async (c) =>
    c.json(
      incidentForReader(
        await createHseIncident(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
        canSeeRestricted(c),
      ),
      201,
    ),
  )
  .get("/hse/incidents/:id", forbidTokens, validate("param", id), async (c) =>
    c.json(await incidentView(c, c.req.valid("param").id)),
  )
  .put(
    "/hse/incidents/:id",
    forbidTokens,
    validate("param", id),
    validate("json", hseIncidentSaveSchema),
    async (c) =>
      c.json(
        incidentForReader(
          await saveHseIncident(
            c.var.db,
            c.var.workspace.id,
            c.var.user.id,
            c.req.valid("param").id,
            c.req.valid("json"),
            { canSeeRestricted: canSeeRestricted(c) },
          ),
          canSeeRestricted(c),
        ),
      ),
  )
  .post(
    "/hse/incidents/:id/close",
    forbidTokens,
    requireModuleLevel("hse_incidents", "manage"),
    validate("param", id),
    validate("json", hseActionSchema),
    async (c) =>
      c.json(
        incidentForReader(
          await closeHseIncident(
            c.var.db,
            c.var.workspace.id,
            c.var.user.id,
            c.req.valid("param").id,
            c.req.valid("json"),
          ),
          canSeeRestricted(c),
        ),
      ),
  )
  .get(
    "/hse/incidents/:id/history",
    forbidTokens,
    validate("param", id),
    validate("query", hsePageSchema),
    async (c) => {
      const history = await hseIncidentHistory(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("param").id,
        c.req.valid("query"),
      );
      const allowed = canSeeRestricted(c);
      return c.json({
        ...history,
        events: history.events.map((e) => ({
          ...e,
          reason: !allowed && e.action === "people_hurt_updated" ? PEOPLE_HURT_REASON_HIDDEN : e.reason,
          snapshot: incidentForReader(e.snapshot as { body?: unknown }, allowed) as Record<string, unknown>,
        })),
      });
    },
  )
  // Owned corrective actions: added with write access, completed by their owner or a manager.
  .post(
    "/hse/incidents/:id/actions",
    forbidTokens,
    validate("param", id),
    validate("json", hseIncidentActionCreateSchema),
    async (c) => {
      const incidentId = c.req.valid("param").id;
      await addIncidentAction(c.var.db, c.var.workspace.id, c.var.user.id, incidentId, c.req.valid("json"));
      return c.json(await incidentView(c, incidentId), 201);
    },
  )
  .post(
    "/hse/incidents/:id/actions/:actionId/complete",
    forbidTokens,
    validate("param", actionParam),
    validate("json", hseIncidentActionCompleteSchema),
    async (c) => {
      const { id: incidentId, actionId } = c.req.valid("param");
      await completeIncidentAction(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        incidentId,
        actionId,
        c.req.valid("json"),
        { isManager: incidentManager(c) },
      );
      return c.json(await incidentView(c, incidentId));
    },
  )
  // The people hurt and the worst outcome together: a signed-in manager.
  .put(
    "/hse/incidents/:id/injuries",
    forbidTokens,
    requireModuleLevel("hse_incidents", "manage"),
    validate("param", id),
    validate("json", hseInjuriesSaveSchema),
    async (c) => {
      const incidentId = c.req.valid("param").id;
      await saveIncidentInjuries(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        incidentId,
        c.req.valid("json"),
      );
      return c.json(await incidentView(c, incidentId));
    },
  );
