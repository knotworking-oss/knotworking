import {
  changeoverRiskQuerySchema,
  checklistCheckCorrectSchema,
  checklistCheckCreateSchema,
  checklistCheckListQuerySchema,
  checklistTemplateCreateSchema,
  checklistTemplateListQuerySchema,
  checklistTemplateUpdateSchema,
  checkSignOffSchema,
  csvImportSchema,
  glassBreakageCreateSchema,
  glassBreakageListQuerySchema,
  glassBreakageReleaseSchema,
  glassBreakageUpdateSchema,
  glassCheckCorrectSchema,
  glassCheckListQuerySchema,
  glassChecksCreateSchema,
  glassItemCreateSchema,
  glassItemListQuerySchema,
  glassItemUpdateSchema,
  hasModuleLevel,
  hygieneClearanceSchema,
  maintenanceRecordCorrectSchema,
  maintenanceRecordCreateSchema,
  maintenanceRecordListQuerySchema,
  maintenanceTaskCreateSchema,
  maintenanceTaskListQuerySchema,
  maintenanceTaskUpdateSchema,
  pestDeviceCreateSchema,
  pestDeviceListQuerySchema,
  pestDeviceUpdateSchema,
  pestTrendQuerySchema,
  pestVisitCorrectSchema,
  pestVisitCreateSchema,
  pestVisitListQuerySchema,
  siteActionCloseSchema,
  siteActionCreateSchema,
  siteActionListQuerySchema,
  siteActionUpdateSchema,
  siteAssetCreateSchema,
  siteAssetListQuerySchema,
  siteAssetUpdateSchema,
  siteDueQuerySchema,
  storageReadingBulkReviewSchema,
  storageReadingCorrectSchema,
  storageReadingCreateSchema,
  storageReadingListQuerySchema,
  storageReadingReviewSchema,
  storageUnitCreateSchema,
  storageUnitListQuerySchema,
  storageUnitUpdateSchema,
  workOrderCancelSchema,
  workOrderCompleteSchema,
  workOrderCreateSchema,
  workOrderListQuerySchema,
  workOrderUpdateSchema,
  type SiteSource,
} from "@knotworking/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { requireModuleLevel } from "../middleware/modules";
import * as site from "../services/site";
import { importGlassCsv } from "../services/site-import";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });

/**
 * `api` when an API token made the request: it follows the credential, so it can't be claimed.
 * A storage reading from a token waits for a person's review; a person's own is approved.
 */
const sourceOf = (c: Context<WorkspaceEnv>): SiteSource =>
  c.var.credential.kind === "token" ? "api" : "manual";

/**
 * Site programmes module (`site`). Mounted at `/v1/workspaces/:slug`; the module guard has already
 * required `read` for safe methods and `write` for the rest.
 *
 * Agents (API tokens) may read everything, keep the registers (devices, glass items, assets and
 * tasks, storage units, checklists), enter pest control visits, record storage readings (held
 * `pending` until a person reviews them; an out-of-limit one opens its corrective action at once),
 * raise and fill in a glass breakage, and raise or fill in corrective actions. Sign-offs need
 * `manage` and a signed-in person and can never be opened to tokens: reviewing readings, signing
 * off a check, releasing an area after a breakage, the hygiene clearance after maintenance, and
 * closing a corrective action. Records that attest a person did something (glass checks,
 * maintenance, pre-start and changeover checks) and every correction are a person's too.
 * Records are append-only: no route deletes one.
 */
export const siteRoutes = new Hono<WorkspaceEnv>()
  // ── Areas (the HACCP register) and what's due ──
  .get("/site/areas", async (c) => c.json(await site.listAreas(c.var.db, c.var.workspace.id)))
  .get("/site/due", validate("query", siteDueQuerySchema), async (c) =>
    c.json(await site.getSiteDue(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  // Equipment of the HACCP calibration register a maintained asset can be linked to (read-only).
  .get("/site/calibration-instruments", async (c) =>
    c.json(await site.listCalibrationInstruments(c.var.db, c.var.workspace.id)),
  )

  // ── Pest control ──
  .get("/site/pest/devices", validate("query", pestDeviceListQuerySchema), async (c) =>
    c.json(await site.listPestDevices(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/site/pest/devices", validate("json", pestDeviceCreateSchema), async (c) =>
    c.json(
      await site.createPestDevice(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
      201,
    ),
  )
  .patch(
    "/site/pest/devices/:id",
    validate("param", idParam),
    validate("json", pestDeviceUpdateSchema),
    async (c) =>
      c.json(
        await site.updatePestDevice(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .get("/site/pest/trends", validate("query", pestTrendQuerySchema), async (c) =>
    c.json(await site.getPestTrends(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/site/pest/visits", validate("query", pestVisitListQuerySchema), async (c) =>
    c.json(await site.listPestVisits(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/site/pest/visits/:id", validate("param", idParam), async (c) =>
    c.json(await site.getPestVisit(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/site/pest/visits", validate("json", pestVisitCreateSchema), async (c) =>
    c.json(
      await site.recordPestVisit(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), {
        source: sourceOf(c),
      }),
      201,
    ),
  )
  .post(
    "/site/pest/visits/:id/correct",
    forbidTokens,
    validate("param", idParam),
    validate("json", pestVisitCorrectSchema),
    async (c) =>
      c.json(
        await site.correctPestVisit(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )

  // ── Glass and brittle plastics ──
  .get("/site/glass/items", validate("query", glassItemListQuerySchema), async (c) =>
    c.json(await site.listGlassItems(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  // CSV import of the register (checked first with `dryRun`); keeping the register is open to tokens.
  .post("/site/glass/items/import", validate("json", csvImportSchema), async (c) => {
    const input = c.req.valid("json");
    const result = await importGlassCsv(c.var.db, c.var.workspace.id, c.var.user.id, input);
    return c.json(result, input.dryRun ? 200 : 201);
  })
  .post("/site/glass/items", validate("json", glassItemCreateSchema), async (c) =>
    c.json(await site.createGlassItem(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/site/glass/items/:id",
    validate("param", idParam),
    validate("json", glassItemUpdateSchema),
    async (c) =>
      c.json(
        await site.updateGlassItem(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .get("/site/glass/checks", validate("query", glassCheckListQuerySchema), async (c) =>
    c.json(await site.listGlassChecks(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/site/glass/checks/:id", validate("param", idParam), async (c) =>
    c.json(await site.getGlassCheck(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  // Condition checks and their corrections attest that a person looked: tokens are refused.
  .post("/site/glass/checks", forbidTokens, validate("json", glassChecksCreateSchema), async (c) =>
    c.json(
      await site.recordGlassChecks(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
      201,
    ),
  )
  .post(
    "/site/glass/checks/:id/correct",
    forbidTokens,
    validate("param", idParam),
    validate("json", glassCheckCorrectSchema),
    async (c) =>
      c.json(
        await site.correctGlassCheck(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .get("/site/glass/breakages", validate("query", glassBreakageListQuerySchema), async (c) =>
    c.json(await site.listGlassBreakages(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/site/glass/breakages/:id", validate("param", idParam), async (c) =>
    c.json(await site.getGlassBreakage(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/site/glass/breakages", validate("json", glassBreakageCreateSchema), async (c) =>
    c.json(
      await site.createGlassBreakage(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), {
        source: sourceOf(c),
      }),
      201,
    ),
  )
  .patch(
    "/site/glass/breakages/:id",
    validate("param", idParam),
    validate("json", glassBreakageUpdateSchema),
    async (c) =>
      c.json(
        await site.updateGlassBreakage(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  // Releasing the area is a sign-off: a person with `manage`, never an API token.
  .post(
    "/site/glass/breakages/:id/release",
    forbidTokens,
    requireModuleLevel("site", "manage"),
    validate("param", idParam),
    validate("json", glassBreakageReleaseSchema),
    async (c) =>
      c.json(
        await site.releaseGlassBreakage(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.var.activeModules,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )

  // ── Planned maintenance ──
  .get("/site/maintenance/assets", validate("query", siteAssetListQuerySchema), async (c) =>
    c.json(await site.listSiteAssets(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/site/maintenance/assets", validate("json", siteAssetCreateSchema), async (c) =>
    c.json(await site.createSiteAsset(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/site/maintenance/assets/:id",
    validate("param", idParam),
    validate("json", siteAssetUpdateSchema),
    async (c) =>
      c.json(
        await site.updateSiteAsset(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .get("/site/maintenance/tasks", validate("query", maintenanceTaskListQuerySchema), async (c) =>
    c.json(await site.listMaintenanceTasks(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/site/maintenance/tasks", validate("json", maintenanceTaskCreateSchema), async (c) =>
    c.json(
      await site.createMaintenanceTask(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
      201,
    ),
  )
  .patch(
    "/site/maintenance/tasks/:id",
    validate("param", idParam),
    validate("json", maintenanceTaskUpdateSchema),
    async (c) =>
      c.json(
        await site.updateMaintenanceTask(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .get("/site/maintenance/records", validate("query", maintenanceRecordListQuerySchema), async (c) =>
    c.json(await site.listMaintenanceRecords(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/site/maintenance/records/:id", validate("param", idParam), async (c) =>
    c.json(await site.getMaintenanceRecord(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  // Completed maintenance attests that a person did the work: tokens are refused.
  .post(
    "/site/maintenance/records",
    forbidTokens,
    validate("json", maintenanceRecordCreateSchema),
    async (c) =>
      c.json(
        await site.recordMaintenance(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
        201,
      ),
  )
  .post(
    "/site/maintenance/records/:id/correct",
    forbidTokens,
    validate("param", idParam),
    validate("json", maintenanceRecordCorrectSchema),
    async (c) =>
      c.json(
        await site.correctMaintenance(
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
    "/site/maintenance/records/:id/clearance",
    forbidTokens,
    requireModuleLevel("site", "manage"),
    validate("param", idParam),
    validate("json", hygieneClearanceSchema),
    async (c) =>
      c.json(
        await site.clearMaintenance(
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
  .get("/site/maintenance/work-orders", validate("query", workOrderListQuerySchema), async (c) =>
    c.json(await site.listWorkOrders(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/site/maintenance/work-orders/:id", validate("param", idParam), async (c) =>
    c.json(await site.getWorkOrder(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  // Raising one is data entry: an agent may report a breakdown.
  .post("/site/maintenance/work-orders", validate("json", workOrderCreateSchema), async (c) =>
    c.json(
      await site.createWorkOrder(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), {
        source: sourceOf(c),
      }),
      201,
    ),
  )
  .patch(
    "/site/maintenance/work-orders/:id",
    validate("param", idParam),
    validate("json", workOrderUpdateSchema),
    async (c) =>
      c.json(
        await site.updateWorkOrder(
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
    "/site/maintenance/work-orders/:id/complete",
    forbidTokens,
    validate("param", idParam),
    validate("json", workOrderCompleteSchema),
    async (c) =>
      c.json(
        await site.completeWorkOrder(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/site/maintenance/work-orders/:id/cancel",
    forbidTokens,
    validate("param", idParam),
    validate("json", workOrderCancelSchema),
    async (c) =>
      c.json(
        await site.cancelWorkOrder(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )

  // ── Storage temperatures ──
  .get("/site/storage/units", validate("query", storageUnitListQuerySchema), async (c) =>
    c.json(await site.listStorageUnits(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/site/storage/units", validate("json", storageUnitCreateSchema), async (c) =>
    c.json(
      await site.createStorageUnit(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
      201,
    ),
  )
  .patch(
    "/site/storage/units/:id",
    validate("param", idParam),
    validate("json", storageUnitUpdateSchema),
    async (c) =>
      c.json(
        await site.updateStorageUnit(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .get("/site/storage/readings", validate("query", storageReadingListQuerySchema), async (c) =>
    c.json(await site.listStorageReadings(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/site/storage/readings/:id", validate("param", idParam), async (c) =>
    c.json(await site.getStorageReading(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  // Any token with `write` may record a reading (a sensor feed or an agent): it waits for review.
  .post("/site/storage/readings", validate("json", storageReadingCreateSchema), async (c) =>
    c.json(
      await site.recordStorageReading(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), {
        source: sourceOf(c),
      }),
      201,
    ),
  )
  // Reviewing readings a token recorded is a sign-off: a person with `manage`.
  .post(
    "/site/storage/readings/review",
    forbidTokens,
    requireModuleLevel("site", "manage"),
    validate("json", storageReadingBulkReviewSchema),
    async (c) =>
      c.json(
        await site.reviewStorageReadings(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
      ),
  )
  .post(
    "/site/storage/readings/:id/review",
    forbidTokens,
    requireModuleLevel("site", "manage"),
    validate("param", idParam),
    validate("json", storageReadingReviewSchema),
    async (c) =>
      c.json(
        await site.reviewStorageReading(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  // A correction is a person's act; correcting an out-of-limit reading also needs `manage`.
  .post(
    "/site/storage/readings/:id/correct",
    forbidTokens,
    validate("param", idParam),
    validate("json", storageReadingCorrectSchema),
    async (c) =>
      c.json(
        await site.correctStorageReading(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          { canManage: hasModuleLevel(c.var.workspace.modules.site, "manage") },
        ),
        201,
      ),
  )

  // ── Corrective actions ──
  .get("/site/actions", validate("query", siteActionListQuerySchema), async (c) =>
    c.json(await site.listSiteActions(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/site/actions/:id", validate("param", idParam), async (c) =>
    c.json(await site.getSiteAction(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/site/actions", validate("json", siteActionCreateSchema), async (c) =>
    c.json(
      await site.createSiteAction(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), {
        source: sourceOf(c),
      }),
      201,
    ),
  )
  .patch(
    "/site/actions/:id",
    validate("param", idParam),
    validate("json", siteActionUpdateSchema),
    async (c) =>
      c.json(
        await site.updateSiteAction(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  // The sign-off that closes a corrective action.
  .post(
    "/site/actions/:id/close",
    forbidTokens,
    requireModuleLevel("site", "manage"),
    validate("param", idParam),
    validate("json", siteActionCloseSchema),
    async (c) =>
      c.json(
        await site.closeSiteAction(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )

  // ── Pre-start and allergen changeover checks ──
  .get("/site/checklists/templates", validate("query", checklistTemplateListQuerySchema), async (c) =>
    c.json(await site.listChecklistTemplates(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/site/checklists/templates/:id", validate("param", idParam), async (c) =>
    c.json(await site.getChecklistTemplate(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/site/checklists/templates", validate("json", checklistTemplateCreateSchema), async (c) =>
    c.json(
      await site.createChecklistTemplate(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
      201,
    ),
  )
  .patch(
    "/site/checklists/templates/:id",
    validate("param", idParam),
    validate("json", checklistTemplateUpdateSchema),
    async (c) =>
      c.json(
        await site.updateChecklistTemplate(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  // The allergen risk of a changeover (warns only; nothing is stored or blocked).
  .get("/site/checklists/allergen-risk", validate("query", changeoverRiskQuerySchema), async (c) =>
    c.json(await site.getChangeoverRisk(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/site/checklists/checks", validate("query", checklistCheckListQuerySchema), async (c) =>
    c.json(await site.listChecklistChecks(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/site/checklists/checks/:id", validate("param", idParam), async (c) =>
    c.json(await site.getChecklistCheck(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  // A completed check attests that a person did it: tokens are refused.
  .post("/site/checklists/checks", forbidTokens, validate("json", checklistCheckCreateSchema), async (c) =>
    c.json(
      await site.recordChecklistCheck(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
      201,
    ),
  )
  .post(
    "/site/checklists/checks/:id/correct",
    forbidTokens,
    validate("param", idParam),
    validate("json", checklistCheckCorrectSchema),
    async (c) =>
      c.json(
        await site.correctChecklistCheck(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  // The sign-off before production starts: a person with `manage`, never an API token.
  .post(
    "/site/checklists/checks/:id/sign-off",
    forbidTokens,
    requireModuleLevel("site", "manage"),
    validate("param", idParam),
    validate("json", checkSignOffSchema),
    async (c) =>
      c.json(
        await site.signOffChecklistCheck(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  );
