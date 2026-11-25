import { getProductionReadiness } from "../services/production-readiness";
import { ledgerInput } from "../middleware/ledger-command";
import {
  availabilityQuerySchema,
  calendarQuerySchema,
  dailyDemandQuerySchema,
  deviceCreateSchema,
  deviceReadingsPostSchema,
  deviceReadingsQuerySchema,
  deviceUpdateSchema,
  packingWeightFromDeviceSchema,
  downtimeListSchema,
  packingCheckSchema,
  packingRunCloseSchema,
  packingRunOpenSchema,
  packingVoidSchema,
  downtimeRecordSchema,
  labourRecordSchema,
  performanceQuerySchema,
  performanceVoidSchema,
  rejectRecordSchema,
  lineChangeoversSetSchema,
  lineDayQuerySchema,
  lineSequenceSetSchema,
  lineShiftsSetSchema,
  hasModuleLevel,
  nonWorkingDaysAddSchema,
  lotTraceQuerySchema,
  materialRequirementsQuerySchema,
  planFromDemandQuerySchema,
  productionBatchCancelSchema,
  productionBatchCompleteSchema,
  productionBatchCreateSchema,
  productionBatchListQuerySchema,
  productionBatchUpdateSchema,
  productionLineCreateSchema,
  productionLineRecipeSchema,
  productionLineUpdateSchema,
  productionReleaseSchema,
  productionReservationUpdateSchema,
  productionReserveSchema,
  productionScheduleQuerySchema,
  reservationListQuerySchema,
  scanQuerySchema,
  productionConsumptionSchema,
  productionOutputSchema,
  productionPlanBatchesSchema,
  productionRecordReverseSchema,
} from "@knotworking/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { canRead, requireModuleLevel } from "../middleware/modules";
import { personOrToken } from "../middleware/token-actions";
import { getBatchDeviationWarning } from "../services/haccp";
import {
  cancelBatch,
  completeBatch,
  createBatch,
  getBatch,
  getMaterialRequirements,
  getPlanFromDemand,
  listBatches,
  planBatches,
  recordConsumption,
  recordOutput,
  reverseRecord,
  startBatch,
  suggestBatchPick,
  traceLot,
  updateBatch,
} from "../services/production";
import { addNonWorkingDays, listNonWorkingDays, removeNonWorkingDay } from "../services/production-calendar";
import {
  createLine,
  getSchedule,
  listLines,
  removeLineRecipe,
  setLineRecipe,
  updateLine,
} from "../services/production-lines";
import {
  createDevice,
  listDeviceReadings,
  listDevices,
  postDeviceReadings,
  recordWeightFromDevice,
  updateDevice,
} from "../services/production-devices";
import {
  closePackingRun,
  getBatchPacking,
  getLotPacking,
  openPackingRun,
  recordPackingCheck,
  voidPackingCheck,
} from "../services/production-packing";
import {
  getBatchPerformance,
  getPerformance,
  listDowntime,
  recordDowntime,
  recordLabour,
  recordReject,
  voidDowntime,
  voidLabour,
  voidReject,
} from "../services/production-performance";
import {
  getDailyDemand,
  getLineDayPlan,
  setLineChangeovers,
  setLineSequence,
  setLineShifts,
} from "../services/production-scheduling";
import {
  getAvailability,
  listReservations,
  releaseReservation,
  reserveForBatch,
  scanLotForBatch,
  updateReservation,
} from "../services/production-reservations";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
/** Devices show HACCP equipment links and calibration dates only to HACCP readers. */
const deviceAccess = (c: Context<WorkspaceEnv>) => ({
  haccp: c.var.activeModules.includes("haccp") && canRead(c, "haccp"),
});
/** Packing views show the labels and specifications modules' candidates only to their readers. */
const packingView = (c: Context<WorkspaceEnv>) => ({
  labels: c.var.activeModules.includes("labels") && canRead(c, "labels"),
  specifications: c.var.activeModules.includes("specifications") && canRead(c, "specifications"),
});
const recordParam = z.object({ id: z.uuid(), recordId: z.uuid() });
const lotParam = z.object({ lotId: z.uuid() });
const lineParam = z.object({ id: z.uuid() });
const lineRecipeParam = z.object({ id: z.uuid(), recipeId: z.uuid() });

/**
 * Production module (`production`): the batch schedule, material requirements, batch records
 * and lot tracing. Mounted at `/v1/workspaces/:slug`; the module guard has already required
 * `read` for safe methods and `write` for the rest.
 *
 * Planning, starting and recording consumption and output are ordinary writes (API tokens
 * allowed, so agents can plan and, later, scales or tablets can record). Completing a batch is
 * the sign-off: `manage` and a signed-in person. Corrections (reversals) and cancellations are a
 * person's act too; on a closed or started batch they also need `manage` (checked in the service).
 * There is no route that updates or deletes a record: batch records are append-only.
 */
export const productionRoutes = new Hono<WorkspaceEnv>()
  // ── Reading ──
  .get("/production/batches", validate("query", productionBatchListQuerySchema), async (c) =>
    c.json(await listBatches(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/production/batches/:id", validate("param", idParam), async (c) =>
    c.json(await getBatch(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .get("/production/batches/:id/readiness", validate("param", idParam), async (c) =>
    c.json(
      await getProductionReadiness(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("param").id,
        hasModuleLevel(c.var.workspace.modules.haccp, "read"),
      ),
    ),
  )
  // A read-only FEFO suggestion for what the batch still needs: it reserves nothing.
  .get("/production/batches/:id/pick", validate("param", idParam), async (c) =>
    c.json(await suggestBatchPick(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  // Lines with the recipes each can make and their rates; the schedule is load against capacity.
  .get("/production/lines", async (c) => c.json(await listLines(c.var.db, c.var.workspace.id)))
  .get("/production/schedule", validate("query", productionScheduleQuerySchema), async (c) =>
    c.json(await getSchedule(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  // One line's day timed against its shifts, with changeovers, allergen clean-downs and a proposed
  // order (advisory: nothing changes until an order is applied).
  .get("/production/schedule/day", validate("query", lineDayQuerySchema), async (c) =>
    c.json(
      await getLineDayPlan(c.var.db, c.var.workspace.id, c.req.valid("query"), canRead(c, "food_items")),
    ),
  )
  // Per product per day: confirmed sales commitments, planned output and projected stock. Each
  // source only for callers who can read its module; weekly demand is shown beside, never added.
  .get("/production/daily-demand", validate("query", dailyDemandQuerySchema), async (c) =>
    c.json(
      await getDailyDemand(c.var.db, c.var.workspace.id, c.req.valid("query"), {
        sales: c.var.activeModules.includes("sales") && canRead(c, "sales"),
        stock: c.var.activeModules.includes("stock") && canRead(c, "stock"),
        demand: c.var.activeModules.includes("demand") && canRead(c, "demand"),
      }),
    ),
  )
  // Factory performance: OEE per line per day with its definitions, downtime and rejects by reason,
  // standard against actual labour; line cost only for people who can read costing.
  .get("/production/performance", validate("query", performanceQuerySchema), async (c) =>
    c.json(
      await getPerformance(c.var.db, c.var.workspace.id, c.req.valid("query"), {
        costing: c.var.activeModules.includes("costing") && canRead(c, "costing"),
      }),
    ),
  )
  .get("/production/downtime", validate("query", downtimeListSchema), async (c) =>
    c.json(await listDowntime(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  // Devices: the registry with each device's calibration state, and the readings it sent.
  .get("/production/devices", async (c) =>
    c.json(await listDevices(c.var.db, c.var.workspace.id, deviceAccess(c))),
  )
  .get(
    "/production/devices/:id/readings",
    validate("param", idParam),
    validate("query", deviceReadingsQuerySchema),
    async (c) =>
      c.json(
        await listDeviceReadings(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          c.req.valid("query"),
          deviceAccess(c),
        ),
      ),
  )
  // Packing: the batch's runs with checks and gaps, and which label and specification a lot carries.
  .get("/production/batches/:id/packing", validate("param", idParam), async (c) =>
    c.json(await getBatchPacking(c.var.db, c.var.workspace.id, c.req.valid("param").id, packingView(c))),
  )
  .get("/production/lots/:lotId/packing", validate("param", lotParam), async (c) =>
    c.json(await getLotPacking(c.var.db, c.var.workspace.id, c.req.valid("param").lotId)),
  )
  .get("/production/batches/:id/performance", validate("param", idParam), async (c) =>
    c.json(await getBatchPerformance(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  // The working-day calendar: days the workspace or a line does not produce (advisory).
  .get("/production/calendar", validate("query", calendarQuerySchema), async (c) =>
    c.json(await listNonWorkingDays(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  // Reservations (stock set aside for batches) and availability (on hand less reserved).
  .get("/production/reservations", validate("query", reservationListQuerySchema), async (c) =>
    c.json(await listReservations(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/production/availability", validate("query", availabilityQuerySchema), async (c) =>
    c.json(await getAvailability(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  // Resolves a scanned lot code for the consumption form. Reads only.
  .get(
    "/production/batches/:id/scan",
    validate("param", idParam),
    validate("query", scanQuerySchema),
    async (c) =>
      c.json(
        await scanLotForBatch(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          c.req.valid("query").code,
        ),
      ),
  )
  .get("/production/requirements", validate("query", materialRequirementsQuerySchema), async (c) =>
    c.json(await getMaterialRequirements(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  // Batches proposed from demand: demand, what is planned, the gap and whole batches per item and
  // week. Computed on read from the demand module, a soft dependency of production: only for
  // callers who can read Demand (`404 module_inactive` / `403 module_forbidden` otherwise).
  .get(
    "/production/plan-from-demand",
    requireModuleLevel("demand", "read"),
    validate("query", planFromDemandQuerySchema),
    async (c) => c.json(await getPlanFromDemand(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get(
    "/production/lots/:lotId/trace",
    validate("param", lotParam),
    validate("query", lotTraceQuerySchema),
    async (c) =>
      c.json(await traceLot(c.var.db, c.var.workspace.id, c.req.valid("param").lotId, c.req.valid("query"))),
  )

  // ── Planning and recording (`write`; tokens allowed) ──
  .post("/production/batches", validate("json", productionBatchCreateSchema), async (c) =>
    c.json(await createBatch(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  // Several batches at once (from the plan-from-demand view), all or nothing, each as above. Plain
  // batch planning: it reads nothing from Demand, so it doesn't need it.
  .post("/production/plan-from-demand", validate("json", productionPlanBatchesSchema), async (c) =>
    c.json(await planBatches(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/production/batches/:id",
    validate("param", idParam),
    validate("json", productionBatchUpdateSchema),
    async (c) =>
      c.json(
        await updateBatch(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  // Reserving is planning, not a sign-off: tokens allowed. Releasing by hand is the same.
  .post(
    "/production/batches/:id/reservations",
    validate("param", idParam),
    validate("json", productionReserveSchema),
    async (c) =>
      c.json(
        await reserveForBatch(
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
    "/production/reservations/:id/release",
    validate("param", idParam),
    validate("json", productionReleaseSchema),
    async (c) =>
      c.json(
        await releaseReservation(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  // The expiry of a reservation (its last day), or none.
  .patch(
    "/production/reservations/:id",
    validate("param", idParam),
    validate("json", productionReservationUpdateSchema),
    async (c) =>
      c.json(
        await updateReservation(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  // Marking days off is planning data like a batch date: `write`, tokens allowed.
  .post("/production/calendar", validate("json", nonWorkingDaysAddSchema), async (c) =>
    c.json(await addNonWorkingDays(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .delete("/production/calendar/:id", validate("param", idParam), async (c) => {
    await removeNonWorkingDay(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })
  // Recording downtime, rejects and labour is like recording output: `write`, tokens allowed (so a
  // line tablet or device can post). On a signed-off batch it needs `manage` (checked in the service).
  .post("/production/downtime", validate("json", downtimeRecordSchema), async (c) =>
    c.json(
      await recordDowntime(c.var.db, c.var.workspace.id, c.var.user.id, ledgerInput(c, c.req.valid("json")), {
        canManage: hasModuleLevel(c.var.workspace.modules.production, "manage"),
      }),
      201,
    ),
  )
  .post(
    "/production/batches/:id/rejects",
    validate("param", idParam),
    validate("json", rejectRecordSchema),
    async (c) =>
      c.json(
        await recordReject(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
          { canManage: hasModuleLevel(c.var.workspace.modules.production, "manage") },
        ),
        201,
      ),
  )
  .post(
    "/production/batches/:id/labour",
    validate("param", idParam),
    validate("json", labourRecordSchema),
    async (c) =>
      c.json(
        await recordLabour(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
          { canManage: hasModuleLevel(c.var.workspace.modules.production, "manage") },
        ),
        201,
      ),
  )
  // Opening a packing run and recording its checks is like recording output: `write`, tokens allowed.
  .post(
    "/production/batches/:id/packing",
    validate("param", idParam),
    validate("json", packingRunOpenSchema),
    async (c) =>
      c.json(
        await openPackingRun(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
          { labelsActive: c.var.workspace.availableModules.includes("labels"), ...packingView(c) },
        ),
        201,
      ),
  )
  .post(
    "/production/packing/:id/checks",
    validate("param", idParam),
    validate("json", packingCheckSchema),
    async (c) =>
      c.json(
        await recordPackingCheck(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
          packingView(c),
        ),
        201,
      ),
  )
  // A device's readings, from the device or the site gateway it's connected to: `write`, tokens
  // allowed (that's how a gateway sends). Idempotent per reading id.
  .post(
    "/production/devices/:id/readings",
    validate("param", idParam),
    validate("json", deviceReadingsPostSchema),
    async (c) =>
      c.json(
        await postDeviceReadings(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  // A weight sample from a scale's readings, like recording any other packing check.
  .post(
    "/production/packing/:id/checks/weight-from-device",
    validate("param", idParam),
    validate("json", packingWeightFromDeviceSchema),
    async (c) =>
      c.json(
        await recordWeightFromDevice(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
          packingView(c),
        ),
        201,
      ),
  )
  // Closing a run is its sign-off, and voiding a check a correction: a person's acts.
  .post(
    "/production/packing/:id/close",
    forbidTokens,
    validate("param", idParam),
    validate("json", packingRunCloseSchema),
    async (c) =>
      c.json(
        await closePackingRun(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
          packingView(c),
        ),
      ),
  )
  .post(
    "/production/packing/checks/:id/void",
    forbidTokens,
    validate("param", idParam),
    validate("json", packingVoidSchema),
    async (c) =>
      c.json(
        await voidPackingCheck(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
          packingView(c),
        ),
      ),
  )
  // Voiding a record is a correction, a person's act like reversing a batch record.
  .post(
    "/production/downtime/:id/void",
    forbidTokens,
    validate("param", idParam),
    validate("json", performanceVoidSchema),
    async (c) =>
      c.json(
        await voidDowntime(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
          { canManage: hasModuleLevel(c.var.workspace.modules.production, "manage") },
        ),
      ),
  )
  .post(
    "/production/rejects/:id/void",
    forbidTokens,
    validate("param", idParam),
    validate("json", performanceVoidSchema),
    async (c) =>
      c.json(
        await voidReject(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
          { canManage: hasModuleLevel(c.var.workspace.modules.production, "manage") },
        ),
      ),
  )
  .post(
    "/production/labour/:id/void",
    forbidTokens,
    validate("param", idParam),
    validate("json", performanceVoidSchema),
    async (c) =>
      c.json(
        await voidLabour(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
          { canManage: hasModuleLevel(c.var.workspace.modules.production, "manage") },
        ),
      ),
  )
  // Applying an order to a line's day is planning, like moving a batch: `write`, tokens allowed.
  .put("/production/schedule/sequence", validate("json", lineSequenceSetSchema), async (c) =>
    c.json(
      await setLineSequence(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("json"),
        canRead(c, "food_items"),
      ),
    ),
  )
  // Registering and retiring devices is configuration: `manage`.
  .post(
    "/production/devices",
    requireModuleLevel("production", "manage"),
    validate("json", deviceCreateSchema),
    async (c) =>
      c.json(
        await createDevice(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), deviceAccess(c)),
        201,
      ),
  )
  .patch(
    "/production/devices/:id",
    requireModuleLevel("production", "manage"),
    validate("param", idParam),
    validate("json", deviceUpdateSchema),
    async (c) =>
      c.json(
        await updateDevice(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          deviceAccess(c),
        ),
      ),
  )
  // Line configuration (capacity, rates, shifts and changeovers) needs `manage`.
  .put(
    "/production/lines/:id/shifts",
    requireModuleLevel("production", "manage"),
    validate("param", lineParam),
    validate("json", lineShiftsSetSchema),
    async (c) =>
      c.json(
        await setLineShifts(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .put(
    "/production/lines/:id/changeovers",
    requireModuleLevel("production", "manage"),
    validate("param", lineParam),
    validate("json", lineChangeoversSetSchema),
    async (c) =>
      c.json(
        await setLineChangeovers(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/production/lines",
    requireModuleLevel("production", "manage"),
    validate("json", productionLineCreateSchema),
    async (c) =>
      c.json(await createLine(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/production/lines/:id",
    requireModuleLevel("production", "manage"),
    validate("param", lineParam),
    validate("json", productionLineUpdateSchema),
    async (c) =>
      c.json(
        await updateLine(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .put(
    "/production/lines/:id/recipes/:recipeId",
    requireModuleLevel("production", "manage"),
    validate("param", lineRecipeParam),
    validate("json", productionLineRecipeSchema),
    async (c) =>
      c.json(
        await setLineRecipe(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("param").recipeId,
          c.req.valid("json"),
        ),
      ),
  )
  .delete(
    "/production/lines/:id/recipes/:recipeId",
    requireModuleLevel("production", "manage"),
    validate("param", lineRecipeParam),
    async (c) =>
      c.json(
        await removeLineRecipe(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("param").recipeId,
        ),
      ),
  )
  .post("/production/batches/:id/start", validate("param", idParam), async (c) =>
    c.json(await startBatch(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id)),
  )
  .post(
    "/production/batches/:id/consumption",
    validate("param", idParam),
    validate("json", productionConsumptionSchema),
    async (c) =>
      c.json(
        await recordConsumption(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
        ),
        201,
      ),
  )
  .post(
    "/production/batches/:id/output",
    validate("param", idParam),
    validate("json", productionOutputSchema),
    async (c) =>
      c.json(
        await recordOutput(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
          c.var.activeModules.includes("food_items"),
        ),
        201,
      ),
  )

  // ── A signed-in person (cancelling: or a token where the workspace allows it, `personOrToken`) ──
  .post(
    "/production/batches/:id/records/:recordId/reverse",
    forbidTokens,
    validate("param", recordParam),
    validate("json", productionRecordReverseSchema),
    async (c) =>
      c.json(
        await reverseRecord(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("param").recordId,
          c.req.valid("json").reason,
          { canManage: hasModuleLevel(c.var.workspace.modules.production, "manage") },
        ),
        201,
      ),
  )
  .post(
    "/production/batches/:id/cancel",
    personOrToken("production.cancel"),
    validate("param", idParam),
    validate("json", productionBatchCancelSchema),
    async (c) =>
      c.json(
        await cancelBatch(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json").reason,
          { canManage: hasModuleLevel(c.var.workspace.modules.production, "manage") },
        ),
      ),
  )
  // The sign-off that closes a batch record.
  .post(
    "/production/batches/:id/complete",
    forbidTokens,
    requireModuleLevel("production", "manage"),
    validate("param", idParam),
    validate("json", productionBatchCompleteSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const batch = await completeBatch(c.var.db, c.var.workspace.id, c.var.user.id, id, c.req.valid("json"));
      // Completing is never blocked by a deviation, but whoever can read haccp is told about open ones
      // (module-filtered: others get `null`).
      const haccpWarning = hasModuleLevel(c.var.workspace.modules.haccp, "read")
        ? await getBatchDeviationWarning(c.var.db, c.var.workspace.id, id)
        : null;
      return c.json({ ...batch, haccpWarning });
    },
  );
