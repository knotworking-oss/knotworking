import {
  auditCancelSchema,
  auditProgrammeCreateSchema,
  auditProgrammeUpdateSchema,
  complaintTrendsQuerySchema,
  hasModuleLevel,
  recallPrefillQuerySchema,
  salesVolumeListQuerySchema,
  salesVolumeSchema,
  supplierReviewSchema,
  auditCompleteSchema,
  auditCreateSchema,
  auditListQuerySchema,
  auditUpdateSchema,
  complaintCloseSchema,
  complaintCreateSchema,
  complaintListQuerySchema,
  complaintUpdateSchema,
  nonconformanceCloseSchema,
  nonconformanceCreateSchema,
  nonconformanceListQuerySchema,
  nonconformanceUpdateSchema,
  qualityReopenSchema,
  recallTestCreateSchema,
  recallTestListQuerySchema,
  recallTestVoidSchema,
} from "@knotworking/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { requireModuleLevel } from "../middleware/modules";
import {
  cancelAudit,
  closeComplaint,
  closeNonconformance,
  completeAudit,
  createAudit,
  createComplaint,
  createNonconformance,
  createRecallTest,
  deleteAudit,
  getAudit,
  getComplaint,
  getNonconformance,
  getRecallTest,
  listAudits,
  listComplaints,
  listNonconformances,
  listRecallTests,
  qualitySummary,
  reopenComplaint,
  reopenNonconformance,
  updateAudit,
  updateComplaint,
  updateNonconformance,
  voidRecallTest,
} from "../services/quality";
import {
  complaintTrends,
  createAuditProgramme,
  deleteAuditProgramme,
  listAuditProgrammes,
  listSalesVolumes,
  recallTestPrefill,
  recordSupplierReview,
  setSalesVolume,
  supplierQualityStanding,
  updateAuditProgramme,
} from "../services/quality-extras";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });

/**
 * A complainant's contact details are for the team replying to them: API tokens (agents) never get
 * them back, though they may record them. The sync log never holds them at all.
 */
const forViewer = <T extends { complainantContact: string | null }>(
  c: Context<WorkspaceEnv>,
  complaint: T,
): T => (c.var.credential.kind === "token" ? { ...complaint, complainantContact: null } : complaint);

/**
 * Quality module (`quality`). Mounted at `/v1/workspaces/:slug`; the module guard has already
 * required `read` for safe methods and `write` for the rest.
 *
 * - `write` (API tokens allowed): log and work complaints, raise and work non-conformances, plan,
 *   edit, cancel and delete audits.
 * - A signed-in person: completing an audit is its member auditor or someone with `manage`
 *   (`canCompleteAudit`); recording a recall test needs `write` (attestations).
 * - `manage` and a signed-in person: close or reopen a complaint, verify (close) or reopen a
 *   non-conformance, void a recall test.
 */
export const qualityRoutes = new Hono<WorkspaceEnv>()
  .get("/quality/summary", async (c) => c.json(await qualitySummary(c.var.db, c.var.workspace.id)))

  // ── Complaints ──
  .get("/quality/complaints", validate("query", complaintListQuerySchema), async (c) => {
    const page = await listComplaints(c.var.db, c.var.workspace.id, c.req.valid("query"));
    return c.json({ ...page, complaints: page.complaints.map((x) => forViewer(c, x)) });
  })
  .get("/quality/complaints/:id", validate("param", idParam), async (c) =>
    c.json(forViewer(c, await getComplaint(c.var.db, c.var.workspace.id, c.req.valid("param").id))),
  )
  .post("/quality/complaints", validate("json", complaintCreateSchema), async (c) =>
    c.json(
      forViewer(c, await createComplaint(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"))),
      201,
    ),
  )
  .patch(
    "/quality/complaints/:id",
    validate("param", idParam),
    validate("json", complaintUpdateSchema),
    async (c) =>
      c.json(
        forViewer(
          c,
          await updateComplaint(
            c.var.db,
            c.var.workspace.id,
            c.var.user.id,
            c.req.valid("param").id,
            c.req.valid("json"),
          ),
        ),
      ),
  )
  .post(
    "/quality/complaints/:id/close",
    forbidTokens,
    requireModuleLevel("quality", "manage"),
    validate("param", idParam),
    validate("json", complaintCloseSchema),
    async (c) =>
      c.json(
        await closeComplaint(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/quality/complaints/:id/reopen",
    forbidTokens,
    requireModuleLevel("quality", "manage"),
    validate("param", idParam),
    validate("json", qualityReopenSchema),
    async (c) =>
      c.json(
        await reopenComplaint(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json").reason,
        ),
      ),
  )

  // ── Non-conformances ──
  .get("/quality/nonconformances", validate("query", nonconformanceListQuerySchema), async (c) =>
    c.json(await listNonconformances(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/quality/nonconformances/:id", validate("param", idParam), async (c) =>
    c.json(await getNonconformance(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/quality/nonconformances", validate("json", nonconformanceCreateSchema), async (c) =>
    c.json(await createNonconformance(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/quality/nonconformances/:id",
    validate("param", idParam),
    validate("json", nonconformanceUpdateSchema),
    async (c) =>
      c.json(
        await updateNonconformance(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/quality/nonconformances/:id/close",
    forbidTokens,
    requireModuleLevel("quality", "manage"),
    validate("param", idParam),
    validate("json", nonconformanceCloseSchema),
    async (c) =>
      c.json(
        await closeNonconformance(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.var.activeModules,
          c.req.valid("param").id,
          c.req.valid("json").verificationNote,
        ),
      ),
  )
  .post(
    "/quality/nonconformances/:id/reopen",
    forbidTokens,
    requireModuleLevel("quality", "manage"),
    validate("param", idParam),
    validate("json", qualityReopenSchema),
    async (c) =>
      c.json(
        await reopenNonconformance(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json").reason,
        ),
      ),
  )

  // ── Internal audits ──
  .get("/quality/audits", validate("query", auditListQuerySchema), async (c) =>
    c.json(await listAudits(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/quality/audits/:id", validate("param", idParam), async (c) =>
    c.json(await getAudit(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/quality/audits", validate("json", auditCreateSchema), async (c) =>
    c.json(await createAudit(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch("/quality/audits/:id", validate("param", idParam), validate("json", auditUpdateSchema), async (c) =>
    c.json(
      await updateAudit(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  )
  .delete("/quality/audits/:id", validate("param", idParam), async (c) => {
    await deleteAudit(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })
  .post(
    "/quality/audits/:id/complete",
    forbidTokens,
    validate("param", idParam),
    validate("json", auditCompleteSchema),
    async (c) =>
      c.json(
        await completeAudit(
          c.var.db,
          c.var.workspace.id,
          { userId: c.var.user.id, level: c.var.workspace.modules.quality },
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/quality/audits/:id/cancel",
    validate("param", idParam),
    validate("json", auditCancelSchema),
    async (c) =>
      c.json(
        await cancelAudit(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json").reason,
        ),
      ),
  )

  // ── Recurring audit programme (`write`; the sweep plans the audits ahead) ──
  .get("/quality/audit-programmes", async (c) =>
    c.json(await listAuditProgrammes(c.var.db, c.var.workspace.id)),
  )
  .post("/quality/audit-programmes", validate("json", auditProgrammeCreateSchema), async (c) =>
    c.json(await createAuditProgramme(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/quality/audit-programmes/:id",
    validate("param", idParam),
    validate("json", auditProgrammeUpdateSchema),
    async (c) =>
      c.json(
        await updateAuditProgramme(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete("/quality/audit-programmes/:id", validate("param", idParam), async (c) => {
    await deleteAuditProgramme(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })

  // ── Complaint trends per million units sold ──
  .get("/quality/trends", validate("query", complaintTrendsQuerySchema), async (c) =>
    c.json(await complaintTrends(c.var.db, c.var.workspace.id, c.req.valid("query").months)),
  )
  .get("/quality/sales-volumes", validate("query", salesVolumeListQuerySchema), async (c) =>
    c.json(await listSalesVolumes(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .put("/quality/sales-volumes", validate("json", salesVolumeSchema), async (c) =>
    c.json(await setSalesVolume(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"))),
  )

  // ── Supplier non-conformances beside the supplier's approval ──
  .get("/quality/suppliers/:id", validate("param", idParam), async (c) =>
    c.json(await supplierQualityStanding(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post(
    "/quality/suppliers/:id/review",
    forbidTokens,
    requireModuleLevel("quality", "manage"),
    validate("param", idParam),
    validate("json", supplierReviewSchema),
    async (c) =>
      c.json(
        await recordSupplierReview(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json").nonconformanceIds,
        ),
      ),
  )

  // ── Mock recall tests ──
  .get("/quality/recall-tests/prefill", validate("query", recallPrefillQuerySchema), async (c) =>
    c.json(
      await recallTestPrefill(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("query"),
        c.var.activeModules.includes("production") &&
          hasModuleLevel(c.var.workspace.modules.production, "read"),
      ),
    ),
  )
  .get("/quality/recall-tests", validate("query", recallTestListQuerySchema), async (c) =>
    c.json(await listRecallTests(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/quality/recall-tests/:id", validate("param", idParam), async (c) =>
    c.json(await getRecallTest(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/quality/recall-tests", forbidTokens, validate("json", recallTestCreateSchema), async (c) =>
    c.json(await createRecallTest(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .post(
    "/quality/recall-tests/:id/void",
    forbidTokens,
    requireModuleLevel("quality", "manage"),
    validate("param", idParam),
    validate("json", recallTestVoidSchema),
    async (c) =>
      c.json(
        await voidRecallTest(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json").reason,
        ),
      ),
  );
