import {
  laboratoryInputSchema,
  laboratoryUpdateSchema,
  samplingPointInputSchema,
  samplingPointUpdateSchema,
  testInvestigationCloseSchema,
  testingSetupListQuerySchema,
  testPlanInputSchema,
  testPlanUpdateSchema,
  testResultsRecordSchema,
  testSampleCancelSchema,
  testSampleCreateSchema,
  testSampleListQuerySchema,
  testTrendQuerySchema,
} from "@knotworking/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { canRead, requireModuleLevel } from "../middleware/modules";
import {
  cancelSample,
  closeInvestigation,
  createLaboratory,
  createPlan,
  createSample,
  createSamplingPoint,
  getSample,
  getTrend,
  listAnalyteNames,
  listLaboratories,
  listPlans,
  listSamples,
  listSamplingPoints,
  recordResults,
  updateLaboratory,
  updatePlan,
  updateSamplingPoint,
} from "../services/testing";
import { workspaceToday } from "../services/time-zone";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const today = (c: Context<WorkspaceEnv>) => workspaceToday(c.var.db, c.var.workspace.id);
/** Which specification a sample's limits came from is shown only to readers of Specifications. */
const view = (c: Context<WorkspaceEnv>) => ({ showSpecification: canRead(c, "specifications") });

/**
 * Testing module (`testing`). Mounted at `/v1/workspaces/:slug`; the module guard has already
 * required `read` for safe methods and `write` for the rest.
 */
export const testingRoutes = new Hono<WorkspaceEnv>()
  .get("/testing/laboratories", validate("query", testingSetupListQuerySchema), async (c) =>
    c.json(await listLaboratories(c.var.db, c.var.workspace.id, c.req.valid("query").status)),
  )
  .post("/testing/laboratories", validate("json", laboratoryInputSchema), async (c) =>
    c.json(await createLaboratory(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/testing/laboratories/:id",
    validate("param", idParam),
    validate("json", laboratoryUpdateSchema),
    async (c) =>
      c.json(
        await updateLaboratory(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .get("/testing/points", validate("query", testingSetupListQuerySchema), async (c) =>
    c.json(await listSamplingPoints(c.var.db, c.var.workspace.id, c.req.valid("query").status)),
  )
  .post("/testing/points", validate("json", samplingPointInputSchema), async (c) =>
    c.json(await createSamplingPoint(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/testing/points/:id",
    validate("param", idParam),
    validate("json", samplingPointUpdateSchema),
    async (c) =>
      c.json(
        await updateSamplingPoint(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  // Plans with when each is next due.
  .get("/testing/plans", validate("query", testingSetupListQuerySchema), async (c) =>
    c.json(await listPlans(c.var.db, c.var.workspace.id, c.req.valid("query").status, await today(c))),
  )
  .post("/testing/plans", validate("json", testPlanInputSchema), async (c) =>
    c.json(
      await createPlan(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), await today(c)),
      201,
    ),
  )
  .patch(
    "/testing/plans/:id",
    validate("param", idParam),
    validate("json", testPlanUpdateSchema),
    async (c) =>
      c.json(
        await updatePlan(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .get("/testing/samples", validate("query", testSampleListQuerySchema), async (c) =>
    c.json(await listSamples(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/testing/samples/:id", validate("param", idParam), async (c) =>
    c.json(await getSample(c.var.db, c.var.workspace.id, c.req.valid("param").id, view(c))),
  )
  .post("/testing/samples", validate("json", testSampleCreateSchema), async (c) =>
    c.json(
      await createSample(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.var.activeModules,
        c.req.valid("json"),
        await today(c),
      ),
      201,
    ),
  )
  // A failure holds the lot automatically: the safe direction, so tokens (a laboratory import) may record.
  .post(
    "/testing/samples/:id/results",
    validate("param", idParam),
    validate("json", testResultsRecordSchema),
    async (c) =>
      c.json(
        await recordResults(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await today(c),
          view(c),
        ),
      ),
  )
  .post(
    "/testing/samples/:id/cancel",
    validate("param", idParam),
    validate("json", testSampleCancelSchema),
    async (c) =>
      c.json(
        await cancelSample(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          view(c),
        ),
      ),
  )
  // Closing an investigation is a sign-off: a person with `manage`, never an API token.
  .post(
    "/testing/samples/:id/investigation/close",
    forbidTokens,
    requireModuleLevel("testing", "manage"),
    validate("param", idParam),
    validate("json", testInvestigationCloseSchema),
    async (c) =>
      c.json(
        await closeInvestigation(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          view(c),
        ),
      ),
  )
  .get("/testing/trends", validate("query", testTrendQuerySchema), async (c) =>
    c.json(await getTrend(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/testing/analytes", async (c) => c.json(await listAnalyteNames(c.var.db, c.var.workspace.id)));
