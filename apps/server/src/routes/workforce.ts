import {
  absenceActionSchema,
  absenceCreateSchema,
  absenceCorrectSchema,
  absenceDecisionSchema,
  absenceHrCreateSchema,
  absenceListSchema,
  workforceAvailabilitySchema,
  agencyCreateSchema,
  agencyEngagementCreateSchema,
  agencyEngagementEndSchema,
  agencyUpdateSchema,
  rotaEntryCancelSchema,
  rotaEntryCreateSchema,
  rotaGenerateSchema,
  rotaQuerySchema,
  shiftCreateSchema,
  shiftUpdateSchema,
  staffingQuerySchema,
  staffingRequirementCreateSchema,
  staffingRequirementUpdateSchema,
  workingPatternCreateSchema,
  workingPatternEndSchema,
  payrollRunApproveSchema,
  payrollRunCorrectSchema,
  payrollRunExportSchema,
  payrollRunListSchema,
  payrollRunPrepareSchema,
  payrollRunPreviewSchema,
  payrollRunWithdrawSchema,
} from "@knotworking/core";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { ApiError } from "../errors";
import { forbidTokens } from "../middleware/auth";
import { assertModule, canRead, requireModuleLevel } from "../middleware/modules";
import { todayIn } from "../middleware/workspace";
import { validate } from "../validate";
import {
  absenceHistory,
  correctAbsence,
  createHrAbsence,
  decideAbsence,
  listHrAbsences,
  myAbsences,
  submitMyAbsence,
  withdrawMyAbsence,
  workforceAvailability,
  workforceStaff,
} from "../services/workforce";
import {
  cancelRotaEntry,
  createAgency,
  createEngagement,
  createPattern,
  createRotaEntry,
  createShift,
  endEngagement,
  endPattern,
  generateRota,
  getRota,
  listAgencies,
  listPatterns,
  listShifts,
  myRota,
  updateAgency,
  updateShift,
} from "../services/workforce-rota";
import {
  createRequirement,
  listRequirements,
  staffingCheck,
  updateRequirement,
} from "../services/workforce-staffing";
import {
  approvePayrollRun,
  correctPayrollRun,
  exportPayrollRun,
  getPayrollRun,
  listPayrollRuns,
  preparePayrollRun,
  previewPayrollRun,
  withdrawPayrollRun,
} from "../services/payroll-runs";
const id = z.object({ id: z.uuid() });
const manage = requireModuleLevel("workforce_hr", "manage");
/** Shifts, agencies and staffing requirements are planning setup; rota entries need only write. */
const setup = requireModuleLevel("workforce", "manage");
/**
 * Payroll runs hold hours and sickness days: a signed-in person with Private HR manage (the route
 * guard) and Attendance manage (hours and payroll), never a token.
 */
const payroll = createMiddleware<WorkspaceEnv>(async (c, next) => {
  assertModule(c, "attendance", "manage");
  await next();
});
const rotaOptions = (c: Context<WorkspaceEnv>) => ({
  absencesEnabled: c.var.activeModules.includes("workforce_hr"),
  canReadProduction: canRead(c, "production"),
});
export const workforceRoutes = new Hono<WorkspaceEnv>()
  .get("/workforce/availability", validate("query", workforceAvailabilitySchema), async (c) => {
    const result: Awaited<ReturnType<typeof workforceAvailability>> & { sourceEnabled: boolean } = {
      availability: [],
      hasMore: false,
      sourceEnabled: c.var.activeModules.includes("workforce_hr"),
    };
    if (result.sourceEnabled)
      Object.assign(result, await workforceAvailability(c.var.db, c.var.workspace.id, c.req.valid("query")));
    return c.json(result);
  })
  .get("/workforce/me", forbidTokens, validate("query", absenceListSchema), async (c) => {
    type Mine = Awaited<ReturnType<typeof myAbsences>>;
    const result: {
      enabled: boolean;
      person: Mine["person"] | null;
      absences: Mine["absences"];
      hasMore: boolean;
    } = { enabled: c.var.activeModules.includes("workforce_hr"), person: null, absences: [], hasMore: false };
    if (result.enabled) {
      try {
        Object.assign(
          result,
          await myAbsences(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("query").offset),
        );
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    }
    return c.json(result);
  })
  .post("/workforce/me/absences", forbidTokens, validate("json", absenceCreateSchema), async (c) => {
    if (!c.var.activeModules.includes("workforce_hr"))
      throw new ApiError(404, "module_inactive", "Private HR records are not enabled");
    return c.json(
      await submitMyAbsence(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
      201,
    );
  })
  .post(
    "/workforce/me/absences/:id/withdraw",
    forbidTokens,
    validate("param", id),
    validate("json", absenceActionSchema),
    async (c) => {
      if (!c.var.activeModules.includes("workforce_hr"))
        throw new ApiError(404, "module_inactive", "Private HR records are not enabled");
      return c.json(
        await withdrawMyAbsence(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      );
    },
  )
  .get("/workforce/hr/absences", forbidTokens, validate("query", absenceListSchema), async (c) =>
    c.json(await listHrAbsences(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/workforce/hr/absences", forbidTokens, manage, validate("json", absenceHrCreateSchema), async (c) =>
    c.json(await createHrAbsence(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .get(
    "/workforce/hr/absences/:id/history",
    forbidTokens,
    validate("param", id),
    validate("query", absenceListSchema),
    async (c) =>
      c.json(
        await absenceHistory(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          c.req.valid("query").offset,
        ),
      ),
  )
  .post(
    "/workforce/hr/absences/:id/decision",
    forbidTokens,
    manage,
    validate("param", id),
    validate("json", absenceDecisionSchema),
    async (c) =>
      c.json(
        await decideAbsence(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/workforce/hr/absences/:id/correct",
    forbidTokens,
    manage,
    validate("param", id),
    validate("json", absenceCorrectSchema),
    async (c) =>
      c.json(
        await correctAbsence(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .get(
    "/workforce/hr/staff",
    forbidTokens,
    validate("query", z.object({ q: z.string().trim().max(200).default("") })),
    async (c) => c.json(await workforceStaff(c.var.db, c.var.workspace.id, c.req.valid("query").q)),
  )
  // ─── Rotas (3.4.4.2) ───────────────────────────────────────────────────────
  .get("/workforce/shifts", async (c) =>
    c.json(await listShifts(c.var.db, c.var.workspace.id, { canReadProduction: canRead(c, "production") })),
  )
  .post("/workforce/shifts", setup, validate("json", shiftCreateSchema), async (c) =>
    c.json(await createShift(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/workforce/shifts/:id",
    setup,
    validate("param", id),
    validate("json", shiftUpdateSchema),
    async (c) =>
      c.json(
        await updateShift(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          todayIn(c),
        ),
      ),
  )
  .get("/workforce/patterns", validate("query", z.object({ staffId: z.uuid().optional() })), async (c) =>
    c.json(await listPatterns(c.var.db, c.var.workspace.id, c.req.valid("query").staffId)),
  )
  .post("/workforce/patterns", validate("json", workingPatternCreateSchema), async (c) =>
    c.json(await createPattern(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .post(
    "/workforce/patterns/:id/end",
    validate("param", id),
    validate("json", workingPatternEndSchema),
    async (c) =>
      c.json(
        await endPattern(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .get("/workforce/rota", validate("query", rotaQuerySchema), async (c) =>
    c.json(await getRota(c.var.db, c.var.workspace.id, c.req.valid("query"), rotaOptions(c))),
  )
  .get("/workforce/rota/me", validate("query", rotaQuerySchema), async (c) =>
    c.json(
      await myRota(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("query"), {
        canReadProduction: canRead(c, "production"),
      }),
    ),
  )
  .post("/workforce/rota/entries", validate("json", rotaEntryCreateSchema), async (c) =>
    c.json(
      await createRotaEntry(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), rotaOptions(c)),
      201,
    ),
  )
  .post(
    "/workforce/rota/entries/:id/cancel",
    validate("param", id),
    validate("json", rotaEntryCancelSchema),
    async (c) =>
      c.json(
        await cancelRotaEntry(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post("/workforce/rota/generate", validate("json", rotaGenerateSchema), async (c) =>
    c.json(
      await generateRota(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), rotaOptions(c)),
    ),
  )
  .get("/workforce/agencies", async (c) => c.json(await listAgencies(c.var.db, c.var.workspace.id)))
  .post("/workforce/agencies", setup, validate("json", agencyCreateSchema), async (c) =>
    c.json(await createAgency(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/workforce/agencies/:id",
    setup,
    validate("param", id),
    validate("json", agencyUpdateSchema),
    async (c) =>
      c.json(
        await updateAgency(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post("/workforce/agency-engagements", setup, validate("json", agencyEngagementCreateSchema), async (c) =>
    c.json(await createEngagement(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .post(
    "/workforce/agency-engagements/:id/end",
    setup,
    validate("param", id),
    validate("json", agencyEngagementEndSchema),
    async (c) =>
      c.json(
        await endEngagement(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  // ─── Competence-based staffing (3.4.4.3) ───────────────────────────────────
  .get("/workforce/staffing/requirements", async (c) =>
    c.json(await listRequirements(c.var.db, c.var.workspace.id, { canReadTraining: canRead(c, "training") })),
  )
  .post(
    "/workforce/staffing/requirements",
    setup,
    validate("json", staffingRequirementCreateSchema),
    async (c) =>
      c.json(await createRequirement(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/workforce/staffing/requirements/:id",
    setup,
    validate("param", id),
    validate("json", staffingRequirementUpdateSchema),
    async (c) =>
      c.json(
        await updateRequirement(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .get("/workforce/staffing", validate("query", staffingQuerySchema), async (c) =>
    c.json(
      await staffingCheck(c.var.db, c.var.workspace.id, c.req.valid("query"), {
        absencesEnabled: c.var.activeModules.includes("workforce_hr"),
        trainingEnabled: c.var.activeModules.includes("training"),
        productionEnabled: c.var.activeModules.includes("production"),
        canReadTraining: canRead(c, "training"),
        canReadProduction: canRead(c, "production"),
        today: todayIn(c),
      }),
    ),
  )
  // ─── Payroll runs (3.4.4.4) ────────────────────────────────────────────────
  .get(
    "/workforce/hr/payroll-runs",
    forbidTokens,
    manage,
    payroll,
    validate("query", payrollRunListSchema),
    async (c) => c.json(await listPayrollRuns(c.var.db, c.var.workspace.id, c.req.valid("query").offset)),
  )
  .get(
    "/workforce/hr/payroll-runs/preview",
    forbidTokens,
    manage,
    payroll,
    validate("query", payrollRunPreviewSchema),
    async (c) =>
      c.json(await previewPayrollRun(c.var.db, c.var.workspace.id, c.req.valid("query"), todayIn(c))),
  )
  .post(
    "/workforce/hr/payroll-runs",
    forbidTokens,
    manage,
    payroll,
    validate("json", payrollRunPrepareSchema),
    async (c) =>
      c.json(
        await preparePayrollRun(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), todayIn(c)),
        201,
      ),
  )
  .get("/workforce/hr/payroll-runs/:id", forbidTokens, manage, payroll, validate("param", id), async (c) =>
    c.json(await getPayrollRun(c.var.db, c.var.workspace.id, c.req.valid("param").id, c.var.user.id)),
  )
  .post(
    "/workforce/hr/payroll-runs/:id/approve",
    forbidTokens,
    manage,
    payroll,
    validate("param", id),
    validate("json", payrollRunApproveSchema),
    async (c) =>
      c.json(
        await approvePayrollRun(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/workforce/hr/payroll-runs/:id/correct",
    forbidTokens,
    manage,
    payroll,
    validate("param", id),
    validate("json", payrollRunCorrectSchema),
    async (c) =>
      c.json(
        await correctPayrollRun(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          todayIn(c),
        ),
        201,
      ),
  )
  .post(
    "/workforce/hr/payroll-runs/:id/export",
    forbidTokens,
    manage,
    payroll,
    validate("param", id),
    validate("json", payrollRunExportSchema),
    async (c) =>
      c.json(
        await exportPayrollRun(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/workforce/hr/payroll-runs/:id/withdraw",
    forbidTokens,
    manage,
    payroll,
    validate("param", id),
    validate("json", payrollRunWithdrawSchema),
    async (c) =>
      c.json(
        await withdrawPayrollRun(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  );
