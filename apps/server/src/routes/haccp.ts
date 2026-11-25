import {
  calibrationCorrectSchema,
  calibrationRecordCreateSchema,
  ccpLogBulkReviewSchema,
  ccpLogCorrectSchema,
  ccpLogCreateSchema,
  ccpLogListQuerySchema,
  ccpLogReviewSchema,
  cleaningCorrectSchema,
  cleaningRecordCreateSchema,
  cleaningVerifySchema,
  correctiveActionCloseSchema,
  correctiveActionCreateSchema,
  correctiveActionListQuerySchema,
  correctiveActionUpdateSchema,
  deviationListQuerySchema,
  haccpAssetCreateSchema,
  haccpAssetListQuerySchema,
  haccpAssetUpdateSchema,
  haccpBulkSignoffSchema,
  haccpDaySignoffSchema,
  haccpHazardReviewSchema,
  haccpPlanTemplateCreateSchema,
  haccpPlanTemplateListQuerySchema,
  haccpPlanTemplateSchema,
  hazardLibraryEntrySchema,
  hazardLibraryListQuerySchema,
  haccpSignoffListQuerySchema,
  haccpDueQuerySchema,
  haccpPlanApproveSchema,
  haccpPlanCreateSchema,
  haccpPlanDraftSchema,
  haccpPlanListQuerySchema,
  haccpPlanStatusSchema,
  haccpPlanUpdateSchema,
  haccpRecordListQuerySchema,
  hasModuleLevel,
  type HaccpSource,
} from "@knotworking/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { assertModule, hideUnreadableLinks, requireModuleLevel } from "../middleware/modules";
import {
  approvePlanDraft,
  closeCorrectiveAction,
  correctCalibration,
  correctCleaning,
  correctLog,
  createAsset,
  createCorrectiveAction,
  createHazardLibraryEntry,
  createPlan,
  createPlanTemplate,
  deleteHazardLibraryEntry,
  deletePlan,
  deletePlanTemplate,
  discardPlanDraft,
  getBatchRecord,
  getCorrectiveAction,
  getDue,
  getHazardLibraryEntry,
  getLog,
  getPlanTemplate,
  getPlan,
  getPlanVersion,
  listAssets,
  listCalibration,
  listCleaning,
  listCorrectiveActions,
  listDeviations,
  listHazardLibrary,
  listLogs,
  listPlanTemplates,
  listSignoffs,
  listPlans,
  planScopeIds,
  recordCalibration,
  recordCleaning,
  recordLog,
  reviewHazardAnalysis,
  reviewLog,
  reviewLogs,
  savePlanDraft,
  setPlanStatus,
  signOffDay,
  signOffDays,
  updateAsset,
  updateCorrectiveAction,
  updateHazardLibraryEntry,
  updatePlan,
  updatePlanTemplate,
  verifyCleaning,
} from "../services/haccp";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const versionParam = z.object({ id: z.uuid(), versionId: z.uuid() });
const batchParam = z.object({ batchId: z.uuid() });

/**
 * `api` when an API token made the request: it follows the credential, so it can't be claimed.
 * A CCP reading from a token waits for a person's review; a person's own reading is approved.
 */
const sourceOf = (c: Context<WorkspaceEnv>): HaccpSource =>
  c.var.credential.kind === "token" ? "api" : "manual";

/**
 * Items, recipes, stock and production enhance HACCP (`enhancedBy`); none is required. A plan's
 * scope and a record's batch or lot are shown only to callers who can read their module, and
 * linking one needs that module too (`404 module_inactive` / `403 module_forbidden` otherwise).
 */
const links = { items: "items", recipes: "recipes", batch: "production", lot: "stock" } as const;
const view = <T>(c: Context<WorkspaceEnv>, value: T) => hideUnreadableLinks(c, value, links);
const assertScopeModules = (
  c: Context<WorkspaceEnv>,
  scope: { itemIds: string[]; recipeIds: string[] } | undefined,
  /** What the plan's versions already name: keeping it needs no access. */
  kept: { itemIds: Set<string>; recipeIds: Set<string> } = { itemIds: new Set(), recipeIds: new Set() },
) => {
  if (scope?.itemIds.some((id) => !kept.itemIds.has(id))) assertModule(c, "items", "read");
  if (scope?.recipeIds.some((id) => !kept.recipeIds.has(id))) assertModule(c, "recipes", "read");
};
const assertRecordLinks = (
  c: Context<WorkspaceEnv>,
  input: { batchId?: string | null | undefined; lotId?: string | null | undefined },
) => {
  if (input.batchId) assertModule(c, "production", "read");
  if (input.lotId) assertModule(c, "stock", "read");
};
const readProduction = (c: Context<WorkspaceEnv>) =>
  hasModuleLevel(c.var.workspace.modules.production, "read");

/**
 * Food safety records module (`haccp`). Mounted at `/v1/workspaces/:slug`; the module guard has
 * already required `read` for safe methods and `write` for the rest.
 *
 * Agents (API tokens) may read everything, draft plans, raise or fill in corrective actions and
 * record CCP readings (`source: api`, held as `pending` until a person reviews them; an
 * out-of-limit one still opens its corrective action at once). Approving, archiving or restoring
 * a plan, reviewing a plan's hazard analysis, reviewing a reading, signing off a day (one plan or
 * several at once) and closing a corrective action are sign-offs (`manage` and a signed-in person).
 * The hazard library and plan templates are reusable starting points, kept by anyone with `write`
 * (tokens too): a plan copies from them by value, so they never change an approved plan.
 * Correcting a reading and recording cleaning, verification and calibration are a person's
 * attestations. Logs and records are append-only: no route deletes one, and the only update is a
 * one-time stamp (a reading's review, a cleaning's verification).
 */
export const haccpRoutes = new Hono<WorkspaceEnv>()
  // ── Plans ──
  .get("/haccp/plans", validate("query", haccpPlanListQuerySchema), async (c) =>
    c.json(await listPlans(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/haccp/plans/:id", validate("param", idParam), async (c) =>
    c.json(view(c, await getPlan(c.var.db, c.var.workspace.id, c.req.valid("param").id))),
  )
  .get("/haccp/plans/:id/versions/:versionId", validate("param", versionParam), async (c) => {
    const { id, versionId } = c.req.valid("param");
    return c.json(view(c, await getPlanVersion(c.var.db, c.var.workspace.id, id, versionId)));
  })
  .post("/haccp/plans", validate("json", haccpPlanCreateSchema), async (c) => {
    assertScopeModules(c, c.req.valid("json").draft?.scope);
    return c.json(
      view(c, await createPlan(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"))),
      201,
    );
  })
  .patch("/haccp/plans/:id", validate("param", idParam), validate("json", haccpPlanUpdateSchema), async (c) =>
    c.json(
      view(
        c,
        await updatePlan(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
    ),
  )
  // Archiving takes a plan out of force (and restoring puts it back): a sign-off, like approval.
  .post(
    "/haccp/plans/:id/status",
    forbidTokens,
    requireModuleLevel("haccp", "manage"),
    validate("param", idParam),
    validate("json", haccpPlanStatusSchema),
    async (c) =>
      c.json(
        view(
          c,
          await setPlanStatus(
            c.var.db,
            c.var.workspace.id,
            c.var.user.id,
            c.req.valid("param").id,
            c.req.valid("json"),
          ),
        ),
      ),
  )
  .put(
    "/haccp/plans/:id/draft",
    validate("param", idParam),
    validate("json", haccpPlanDraftSchema),
    async (c) => {
      assertScopeModules(
        c,
        c.req.valid("json").scope,
        await planScopeIds(c.var.db, c.var.workspace.id, c.req.valid("param").id),
      );
      return c.json(
        view(
          c,
          await savePlanDraft(
            c.var.db,
            c.var.workspace.id,
            c.var.user.id,
            c.req.valid("param").id,
            c.req.valid("json"),
          ),
        ),
      );
    },
  )
  .delete("/haccp/plans/:id/draft", validate("param", idParam), async (c) => {
    await discardPlanDraft(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })
  // Approval is a document-control sign-off: a person with `manage`, never an API token.
  .post(
    "/haccp/plans/:id/draft/approve",
    forbidTokens,
    requireModuleLevel("haccp", "manage"),
    validate("param", idParam),
    validate("json", haccpPlanApproveSchema),
    async (c) =>
      c.json(
        view(
          c,
          await approvePlanDraft(
            c.var.db,
            c.var.workspace.id,
            c.var.user.id,
            c.req.valid("param").id,
            c.req.valid("json"),
          ),
        ),
      ),
  )
  // The hazard analysis is reviewed on its own date: a sign-off, like approval.
  .post(
    "/haccp/plans/:id/hazard-review",
    forbidTokens,
    requireModuleLevel("haccp", "manage"),
    validate("param", idParam),
    validate("json", haccpHazardReviewSchema),
    async (c) =>
      c.json(
        view(
          c,
          await reviewHazardAnalysis(
            c.var.db,
            c.var.workspace.id,
            c.var.user.id,
            c.req.valid("param").id,
            c.req.valid("json"),
          ),
        ),
      ),
  )
  .delete("/haccp/plans/:id", validate("param", idParam), async (c) => {
    await deletePlan(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })

  // ── The hazard library and plan templates (reusable starting points; plans copy by value) ──
  .get("/haccp/library", validate("query", hazardLibraryListQuerySchema), async (c) =>
    c.json(await listHazardLibrary(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/haccp/library/:id", validate("param", idParam), async (c) =>
    c.json(await getHazardLibraryEntry(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/haccp/library", validate("json", hazardLibraryEntrySchema), async (c) =>
    c.json(
      await createHazardLibraryEntry(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
      201,
    ),
  )
  .put(
    "/haccp/library/:id",
    validate("param", idParam),
    validate("json", hazardLibraryEntrySchema),
    async (c) =>
      c.json(
        await updateHazardLibraryEntry(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete("/haccp/library/:id", validate("param", idParam), async (c) => {
    await deleteHazardLibraryEntry(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })
  .get("/haccp/templates", validate("query", haccpPlanTemplateListQuerySchema), async (c) =>
    c.json(await listPlanTemplates(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/haccp/templates/:id", validate("param", idParam), async (c) =>
    c.json(await getPlanTemplate(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/haccp/templates", validate("json", haccpPlanTemplateCreateSchema), async (c) =>
    c.json(await createPlanTemplate(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .put(
    "/haccp/templates/:id",
    validate("param", idParam),
    validate("json", haccpPlanTemplateSchema),
    async (c) =>
      c.json(
        await updatePlanTemplate(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete("/haccp/templates/:id", validate("param", idParam), async (c) => {
    await deletePlanTemplate(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })

  // ── What's due, and a batch's record ──
  // Per-batch CCPs are due only on batches the caller can see: none without Production.
  .get("/haccp/due", validate("query", haccpDueQuerySchema), async (c) =>
    c.json(
      view(
        c,
        await getDue(c.var.db, c.var.workspace.id, c.req.valid("query"), new Date(), {
          batches: readProduction(c),
        }),
      ),
    ),
  )
  // A production batch's HACCP record: only with Production.
  .get(
    "/haccp/batches/:batchId",
    requireModuleLevel("production", "read"),
    validate("param", batchParam),
    async (c) => c.json(await getBatchRecord(c.var.db, c.var.workspace.id, c.req.valid("param").batchId)),
  )

  // ── CCP monitoring logs (append-only) ──
  .get("/haccp/logs", validate("query", ccpLogListQuerySchema), async (c) =>
    c.json(view(c, await listLogs(c.var.db, c.var.workspace.id, c.req.valid("query")))),
  )
  .get("/haccp/logs/:id", validate("param", idParam), async (c) =>
    c.json(view(c, await getLog(c.var.db, c.var.workspace.id, c.req.valid("param").id))),
  )
  .post("/haccp/logs", validate("json", ccpLogCreateSchema), async (c) => {
    assertRecordLinks(c, c.req.valid("json"));
    return c.json(
      view(
        c,
        await recordLog(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), {
          source: sourceOf(c),
        }),
      ),
      201,
    );
  })
  // Reviewing readings an API token recorded is a sign-off: a person with `manage`.
  .post(
    "/haccp/logs/review",
    forbidTokens,
    requireModuleLevel("haccp", "manage"),
    validate("json", ccpLogBulkReviewSchema),
    async (c) =>
      c.json(view(c, await reviewLogs(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")))),
  )
  .post(
    "/haccp/logs/:id/review",
    forbidTokens,
    requireModuleLevel("haccp", "manage"),
    validate("param", idParam),
    validate("json", ccpLogReviewSchema),
    async (c) =>
      c.json(
        view(
          c,
          await reviewLog(
            c.var.db,
            c.var.workspace.id,
            c.var.user.id,
            c.req.valid("param").id,
            c.req.valid("json"),
          ),
        ),
      ),
  )
  // A correction is a person's act; correcting an out-of-limit reading also needs `manage`.
  .post(
    "/haccp/logs/:id/correct",
    forbidTokens,
    validate("param", idParam),
    validate("json", ccpLogCorrectSchema),
    async (c) =>
      c.json(
        view(
          c,
          await correctLog(
            c.var.db,
            c.var.workspace.id,
            c.var.user.id,
            c.req.valid("param").id,
            c.req.valid("json"),
            {
              canManage: hasModuleLevel(c.var.workspace.modules.haccp, "manage"),
            },
          ),
        ),
        201,
      ),
  )

  // ── Deviations and corrective actions ──
  .get("/haccp/deviations", validate("query", deviationListQuerySchema), async (c) =>
    c.json(view(c, await listDeviations(c.var.db, c.var.workspace.id, c.req.valid("query")))),
  )
  .get("/haccp/corrective-actions", validate("query", correctiveActionListQuerySchema), async (c) =>
    c.json(view(c, await listCorrectiveActions(c.var.db, c.var.workspace.id, c.req.valid("query")))),
  )
  .get("/haccp/corrective-actions/:id", validate("param", idParam), async (c) =>
    c.json(view(c, await getCorrectiveAction(c.var.db, c.var.workspace.id, c.req.valid("param").id))),
  )
  .post("/haccp/corrective-actions", validate("json", correctiveActionCreateSchema), async (c) => {
    assertRecordLinks(c, c.req.valid("json"));
    return c.json(
      view(
        c,
        await createCorrectiveAction(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), {
          source: sourceOf(c),
        }),
      ),
      201,
    );
  })
  .patch(
    "/haccp/corrective-actions/:id",
    validate("param", idParam),
    validate("json", correctiveActionUpdateSchema),
    async (c) => {
      assertRecordLinks(c, c.req.valid("json"));
      return c.json(
        view(
          c,
          await updateCorrectiveAction(
            c.var.db,
            c.var.workspace.id,
            c.var.user.id,
            c.req.valid("param").id,
            c.req.valid("json"),
          ),
        ),
      );
    },
  )
  // The sign-off that closes a corrective action.
  .post(
    "/haccp/corrective-actions/:id/close",
    forbidTokens,
    requireModuleLevel("haccp", "manage"),
    validate("param", idParam),
    validate("json", correctiveActionCloseSchema),
    async (c) =>
      c.json(
        view(
          c,
          await closeCorrectiveAction(
            c.var.db,
            c.var.workspace.id,
            c.var.user.id,
            c.req.valid("param").id,
            c.req.valid("json"),
          ),
        ),
      ),
  )

  // ── Areas and equipment ──
  .get("/haccp/assets", validate("query", haccpAssetListQuerySchema), async (c) =>
    c.json(await listAssets(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/haccp/assets", validate("json", haccpAssetCreateSchema), async (c) =>
    c.json(await createAsset(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/haccp/assets/:id",
    validate("param", idParam),
    validate("json", haccpAssetUpdateSchema),
    async (c) =>
      c.json(
        await updateAsset(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )

  // ── Cleaning and calibration records (append-only; a person's attestations) ──
  .get("/haccp/cleaning", validate("query", haccpRecordListQuerySchema), async (c) =>
    c.json(await listCleaning(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/haccp/cleaning", forbidTokens, validate("json", cleaningRecordCreateSchema), async (c) =>
    c.json(await recordCleaning(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .post(
    "/haccp/cleaning/:id/verify",
    forbidTokens,
    validate("param", idParam),
    validate("json", cleaningVerifySchema),
    async (c) =>
      c.json(
        await verifyCleaning(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/haccp/cleaning/:id/correct",
    forbidTokens,
    validate("param", idParam),
    validate("json", cleaningCorrectSchema),
    async (c) =>
      c.json(
        await correctCleaning(
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
    "/haccp/calibration/:id/correct",
    forbidTokens,
    validate("param", idParam),
    validate("json", calibrationCorrectSchema),
    async (c) =>
      c.json(
        await correctCalibration(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          { canManage: hasModuleLevel(c.var.workspace.modules.haccp, "manage") },
        ),
        201,
      ),
  )
  .get("/haccp/calibration", validate("query", haccpRecordListQuerySchema), async (c) =>
    c.json(await listCalibration(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/haccp/calibration", forbidTokens, validate("json", calibrationRecordCreateSchema), async (c) =>
    c.json(await recordCalibration(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )

  // ── The supervisor's sign-off of a day (a sign-off: `manage`, a signed-in person) ──
  .get("/haccp/signoffs", validate("query", haccpSignoffListQuerySchema), async (c) =>
    c.json(await listSignoffs(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post(
    "/haccp/signoffs",
    forbidTokens,
    requireModuleLevel("haccp", "manage"),
    validate("json", haccpDaySignoffSchema),
    async (c) =>
      c.json(await signOffDay(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  // One sign-off over several plans or the whole site, all or nothing.
  .post(
    "/haccp/signoffs/bulk",
    forbidTokens,
    requireModuleLevel("haccp", "manage"),
    validate("json", haccpBulkSignoffSchema),
    async (c) =>
      c.json(await signOffDays(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  );
