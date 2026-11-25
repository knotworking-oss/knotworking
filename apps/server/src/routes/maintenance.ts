import {
  type SiteSource,
  hygieneClearanceSchema,
  maintenanceRecordCorrectSchema,
  maintenanceRecordCreateSchema,
  maintenanceRecordListQuerySchema,
  maintenanceTaskCreateSchema,
  maintenanceTaskListQuerySchema,
  maintenanceTaskUpdateSchema,
  siteAssetListQuerySchema,
  siteAssetUpdateSchema,
  workOrderCancelSchema,
  workOrderCompleteSchema,
  workOrderCreateSchema,
  workOrderListQuerySchema,
  workOrderUpdateSchema,
} from "@knotworking/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { canRead, requireModuleLevel } from "../middleware/modules";
import { listAreas } from "../services/ports/assets";
import * as maintenance from "../services/maintenance";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });

/**
 * `api` when an API token made the request: it follows the credential, so it can't be claimed.
 */
const sourceOf = (c: Context<WorkspaceEnv>): SiteSource =>
  c.var.credential.kind === "token" ? "api" : "manual";

/** Maintenance routes, mounted at the current and legacy paths. */
export const maintenanceRoutes = new Hono<WorkspaceEnv>()
  .get("/areas", async (c) => c.json({ areas: await listAreas(c.var.db, c.var.workspace.id) }))
  // Equipment of the HACCP calibration register a maintained asset can be linked to (read-only).
  // HACCP is a soft dependency: inactive is 404 `module_inactive`, unreadable 403 `module_forbidden`.
  .get("/calibration-instruments", requireModuleLevel("haccp", "read"), async (c) =>
    c.json(await maintenance.listCalibrationInstruments(c.var.db, c.var.workspace.id)),
  )

  // ── Planned maintenance ──
  .get("/assets", validate("query", siteAssetListQuerySchema), async (c) =>
    c.json(
      await maintenance.listMaintainedAssets(c.var.db, c.var.workspace.id, c.req.valid("query"), {
        withCalibration: canRead(c, "haccp"),
      }),
    ),
  )
  // Assets themselves are added and changed in the asset register (`/assets`); Maintenance only links a
  // maintained asset to its HACCP calibration instrument, which needs HACCP.
  .patch(
    "/assets/:id",
    requireModuleLevel("haccp", "read"),
    validate("param", idParam),
    validate("json", siteAssetUpdateSchema),
    async (c) =>
      c.json(
        await maintenance.updateCalibrationLink(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .get("/tasks", validate("query", maintenanceTaskListQuerySchema), async (c) =>
    c.json(await maintenance.listMaintenanceTasks(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/tasks", validate("json", maintenanceTaskCreateSchema), async (c) =>
    c.json(
      await maintenance.createMaintenanceTask(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("json"),
      ),
      201,
    ),
  )
  .patch("/tasks/:id", validate("param", idParam), validate("json", maintenanceTaskUpdateSchema), async (c) =>
    c.json(
      await maintenance.updateMaintenanceTask(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  )
  .get("/records", validate("query", maintenanceRecordListQuerySchema), async (c) =>
    c.json(await maintenance.listMaintenanceRecords(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/records/:id", validate("param", idParam), async (c) =>
    c.json(await maintenance.getMaintenanceRecord(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  // Completed maintenance attests that a person did the work: tokens are refused.
  .post("/records", forbidTokens, validate("json", maintenanceRecordCreateSchema), async (c) =>
    c.json(
      await maintenance.recordMaintenance(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
      201,
    ),
  )
  .post(
    "/records/:id/correct",
    forbidTokens,
    validate("param", idParam),
    validate("json", maintenanceRecordCorrectSchema),
    async (c) =>
      c.json(
        await maintenance.correctMaintenance(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  // The hygiene clearance after maintenance in a production area is a sign-off.
  .post(
    "/records/:id/clearance",
    forbidTokens,
    requireModuleLevel("maintenance", "manage"),
    validate("param", idParam),
    validate("json", hygieneClearanceSchema),
    async (c) =>
      c.json(
        await maintenance.clearMaintenance(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.var.activeModules,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )

  // ── Breakdowns and work orders ──
  .get("/work-orders", validate("query", workOrderListQuerySchema), async (c) =>
    c.json(await maintenance.listWorkOrders(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/work-orders/:id", validate("param", idParam), async (c) =>
    c.json(await maintenance.getWorkOrder(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  // Raising one is data entry: an agent may report a breakdown.
  .post("/work-orders", validate("json", workOrderCreateSchema), async (c) =>
    c.json(
      await maintenance.createWorkOrder(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), {
        source: sourceOf(c),
      }),
      201,
    ),
  )
  .patch("/work-orders/:id", validate("param", idParam), validate("json", workOrderUpdateSchema), async (c) =>
    c.json(
      await maintenance.updateWorkOrder(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  )
  // Completing attests that a person did the work; cancelling is a person's decision: tokens refused.
  .post(
    "/work-orders/:id/complete",
    forbidTokens,
    validate("param", idParam),
    validate("json", workOrderCompleteSchema),
    async (c) =>
      c.json(
        await maintenance.completeWorkOrder(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/work-orders/:id/cancel",
    forbidTokens,
    validate("param", idParam),
    validate("json", workOrderCancelSchema),
    async (c) =>
      c.json(
        await maintenance.cancelWorkOrder(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  );
