import {
  incidentCreateSchema,
  incidentScopeSchema,
  incidentEventSchema,
  incidentReleaseSchema,
  incidentCloseSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { requireModuleLevel } from "../middleware/modules";
import { validate } from "../validate";
import {
  listIncidents,
  getIncident,
  createIncident,
  containIncident,
  addIncidentEvent,
  releaseIncidentHold,
  closeIncident,
} from "../services/incidents";
const idParam = z.object({ id: z.uuid() });
// Case snapshots contain customer distribution and production evidence; every endpoint needs both.
export const incidentRoutes = new Hono<WorkspaceEnv>()
  .use("/quality/incidents", requireModuleLevel("despatch", "read"), requireModuleLevel("production", "read"))
  .use(
    "/quality/incidents/*",
    requireModuleLevel("despatch", "read"),
    requireModuleLevel("production", "read"),
  )
  .get(
    "/quality/incidents",
    validate("query", z.object({ offset: z.coerce.number().int().min(0).max(1e7).default(0) })),
    async (c) => c.json(await listIncidents(c.var.db, c.var.workspace.id, c.req.valid("query").offset)),
  )
  .post("/quality/incidents", validate("json", incidentCreateSchema), async (c) =>
    c.json(await createIncident(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .get("/quality/incidents/:id", validate("param", idParam), async (c) =>
    c.json(await getIncident(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post(
    "/quality/incidents/:id/contain",
    forbidTokens,
    requireModuleLevel("quality", "manage"),
    validate("param", idParam),
    validate("json", incidentScopeSchema),
    async (c) =>
      c.json(
        await containIncident(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/quality/incidents/:id/events",
    forbidTokens,
    validate("param", idParam),
    validate("json", incidentEventSchema),
    async (c) =>
      c.json(
        await addIncidentEvent(
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
    "/quality/incidents/:id/release",
    forbidTokens,
    requireModuleLevel("quality", "manage"),
    validate("param", idParam),
    validate("json", incidentReleaseSchema),
    async (c) =>
      c.json(
        await releaseIncidentHold(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/quality/incidents/:id/close",
    forbidTokens,
    requireModuleLevel("quality", "manage"),
    validate("param", idParam),
    validate("json", incidentCloseSchema),
    async (c) =>
      c.json(
        await closeIncident(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  );
