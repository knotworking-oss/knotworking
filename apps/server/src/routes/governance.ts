import {
  clauseAssessmentSchema,
  clauseEvidenceSetSchema,
  clauseDraftSchema,
  clauseDraftDismissSchema,
  gapSnapshotCreateSchema,
  clauseImportSchema,
  clauseTaskSchema,
  gapAnalysisQuerySchema,
  standardCreateSchema,
  standardUpdateSchema,
  governanceComplianceReviewSchema,
  governanceConcernSubmitSchema,
  governanceConcernUpdateSchema,
  governanceCultureCreateSchema,
  governanceCultureUpdateSchema,
  governanceObjectiveCreateSchema,
  governanceObjectiveUpdateSchema,
  governanceProgressSchema,
  governanceRequirementCreateSchema,
  governanceRequirementUpdateSchema,
  governanceReviewCreateSchema,
  governanceReviewUpdateSchema,
  type ModuleId,
} from "@knotworking/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { notFound } from "../errors";
import { forbidTokens } from "../middleware/auth";
import { canRead, requireModuleLevel } from "../middleware/modules";
import {
  createCulture,
  createObjective,
  createRequirement,
  createReview,
  getReview,
  governanceOverview,
  listConcerns,
  listCulture,
  listObjectives,
  listRequirements,
  listReviews,
  myConcerns,
  recordProgress,
  reviewRequirement,
  signReview,
  submitConcern,
  updateConcern,
  updateCulture,
  updateObjective,
  updateRequirement,
  updateReview,
} from "../services/governance";
import {
  assessClause,
  createStandard,
  gapAnalysisCsv,
  getClause,
  getGapAnalysis,
  importClauses,
  listEvidenceChecks,
  listStandards,
  raiseClauseTask,
  setClauseEvidence,
  acceptClauseDraft,
  dismissClauseDraft,
  draftClauseFinding,
  updateStandard,
} from "../services/governance-standards";
import {
  gapSnapshotCsv,
  getGapSnapshot,
  listGapSnapshots,
  takeGapSnapshot,
} from "../services/governance-snapshots";
import { workspaceToday } from "../services/time-zone";
import { ledgerInput } from "../middleware/ledger-command";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const today = (c: Context<WorkspaceEnv>) => workspaceToday(c.var.db, c.var.workspace.id);
const readable = (c: Context<WorkspaceEnv>) => (m: ModuleId) => canRead(c, m);
/** Evidence checks run only over modules that are on and that the reader can read. */
const evidenceAccess = (c: Context<WorkspaceEnv>) => ({ active: c.var.activeModules, readable: readable(c) });
const canManage = (c: Context<WorkspaceEnv>) => c.var.workspace.modules.governance === "manage";

/**
 * Governance module (`governance`). Mounted at `/v1/workspaces/:slug`; the module guard has
 * already required `read` for safe methods and `write` for the rest. Confidential concerns are
 * read and handled only by people with `manage` (never a token), and signing a management review
 * is a person with `manage`.
 */
export const governanceRoutes = new Hono<WorkspaceEnv>()
  .get("/governance/overview", async (c) =>
    c.json(
      await governanceOverview(
        c.var.db,
        c.var.workspace.id,
        await today(c),
        canManage(c) && c.var.credential.kind === "session",
      ),
    ),
  )
  // Standards gap analysis: the library (standards and clauses imported from the workspace's own
  // licensed copy) is configuration (`manage`); assessing a clause is a person's judgement (never
  // a token); raising a task to close a finding is ordinary work (`write`).
  .get("/governance/standards", async (c) =>
    c.json(await listStandards(c.var.db, c.var.workspace.id, await today(c))),
  )
  .get(
    "/governance/standards/:id",
    validate("param", idParam),
    validate("query", gapAnalysisQuerySchema),
    async (c) =>
      c.json(
        await getGapAnalysis(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          c.req.valid("query"),
          await today(c),
          {
            tasks: c.var.activeModules.includes("tasks") && canRead(c, "tasks"),
            evidence: evidenceAccess(c),
          },
        ),
      ),
  )
  .get("/governance/standards/:id/report.csv", validate("param", idParam), async (c) => {
    const file = await gapAnalysisCsv(
      c.var.db,
      c.var.workspace.id,
      c.req.valid("param").id,
      await today(c),
      evidenceAccess(c),
    );
    return c.body(file.csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file.fileName}"`,
      "cache-control": "no-store",
    });
  })
  .get("/governance/clauses/:id", validate("param", idParam), async (c) =>
    c.json(await getClause(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  // Every evidence check's live result for the reader, with the clauses it is mapped to.
  .get("/governance/evidence-checks", async (c) =>
    c.json(await listEvidenceChecks(c.var.db, c.var.workspace.id, await today(c), evidenceAccess(c))),
  )
  // Mapping evidence checks to a clause is part of setting up the analysis: `manage`.
  .put(
    "/governance/clauses/:id/evidence",
    requireModuleLevel("governance", "manage"),
    validate("param", idParam),
    validate("json", clauseEvidenceSetSchema),
    async (c) =>
      c.json(
        await setClauseEvidence(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/governance/standards",
    requireModuleLevel("governance", "manage"),
    validate("json", standardCreateSchema),
    async (c) =>
      c.json(await createStandard(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/governance/standards/:id",
    requireModuleLevel("governance", "manage"),
    validate("param", idParam),
    validate("json", standardUpdateSchema),
    async (c) =>
      c.json(
        await updateStandard(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/governance/standards/:id/clauses/import",
    requireModuleLevel("governance", "manage"),
    validate("param", idParam),
    validate("json", clauseImportSchema),
    async (c) =>
      c.json(
        await importClauses(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/governance/clauses/:id/assessments",
    forbidTokens,
    validate("param", idParam),
    validate("json", clauseAssessmentSchema),
    async (c) =>
      c.json(
        await assessClause(
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
    "/governance/clauses/:id/tasks",
    validate("param", idParam),
    validate("json", clauseTaskSchema),
    async (c) => {
      if (!c.var.activeModules.includes("tasks")) throw notFound("Route");
      return c.json(
        await raiseClauseTask(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      );
    },
  )
  // Drafted findings (G3): anyone with write, agents included, may propose a finding; only a
  // person records it, by accepting the draft as their own assessment.
  .post(
    "/governance/clauses/:id/drafts",
    validate("param", idParam),
    validate("json", clauseDraftSchema),
    async (c) =>
      c.json(
        await draftClauseFinding(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          c.var.credential.kind === "token" ? "agent" : "person",
        ),
        201,
      ),
  )
  .post(
    "/governance/drafts/:id/accept",
    forbidTokens,
    validate("param", idParam),
    validate("json", clauseAssessmentSchema),
    async (c) =>
      c.json(
        await acceptClauseDraft(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
        ),
      ),
  )
  .post(
    "/governance/drafts/:id/dismiss",
    validate("param", idParam),
    validate("json", clauseDraftDismissSchema),
    async (c) =>
      c.json(
        await dismissClauseDraft(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          c.var.credential.kind === "token" ? "agent" : "person",
        ),
      ),
  )
  // Pre-audit snapshots (G3): frozen copies of a standard's gap analysis.
  .get("/governance/standards/:id/snapshots", validate("param", idParam), async (c) =>
    c.json(await listGapSnapshots(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post(
    "/governance/standards/:id/snapshots",
    requireModuleLevel("governance", "manage"),
    validate("param", idParam),
    validate("json", gapSnapshotCreateSchema),
    async (c) =>
      c.json(
        await takeGapSnapshot(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await today(c),
          evidenceAccess(c),
        ),
        201,
      ),
  )
  .get("/governance/snapshots/:id", validate("param", idParam), async (c) =>
    c.json(
      await getGapSnapshot(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("param").id,
        await today(c),
        evidenceAccess(c),
      ),
    ),
  )
  .get("/governance/snapshots/:id/report.csv", validate("param", idParam), async (c) => {
    const file = await gapSnapshotCsv(
      c.var.db,
      c.var.workspace.id,
      c.req.valid("param").id,
      await today(c),
      evidenceAccess(c),
    );
    return c.body(file.csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file.fileName}"`,
      "cache-control": "no-store",
    });
  })
  // Objectives.
  .get("/governance/objectives", async (c) =>
    c.json(await listObjectives(c.var.db, c.var.workspace.id, await today(c))),
  )
  .post("/governance/objectives", validate("json", governanceObjectiveCreateSchema), async (c) =>
    c.json(
      await createObjective(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), await today(c)),
      201,
    ),
  )
  .patch(
    "/governance/objectives/:id",
    validate("param", idParam),
    validate("json", governanceObjectiveUpdateSchema),
    async (c) =>
      c.json(
        await updateObjective(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await today(c),
        ),
      ),
  )
  .post(
    "/governance/objectives/:id/progress",
    validate("param", idParam),
    validate("json", governanceProgressSchema),
    async (c) =>
      c.json(
        await recordProgress(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await today(c),
        ),
        201,
      ),
  )
  // Culture plan.
  .get("/governance/culture", async (c) =>
    c.json(await listCulture(c.var.db, c.var.workspace.id, await today(c))),
  )
  .post("/governance/culture", validate("json", governanceCultureCreateSchema), async (c) =>
    c.json(
      await createCulture(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), await today(c)),
      201,
    ),
  )
  .patch(
    "/governance/culture/:id",
    validate("param", idParam),
    validate("json", governanceCultureUpdateSchema),
    async (c) =>
      c.json(
        await updateCulture(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await today(c),
        ),
      ),
  )
  // Requirements register.
  .get("/governance/requirements", async (c) =>
    c.json(await listRequirements(c.var.db, c.var.workspace.id, await today(c))),
  )
  .post("/governance/requirements", validate("json", governanceRequirementCreateSchema), async (c) =>
    c.json(
      await createRequirement(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("json"),
        await today(c),
      ),
      201,
    ),
  )
  .patch(
    "/governance/requirements/:id",
    validate("param", idParam),
    validate("json", governanceRequirementUpdateSchema),
    async (c) =>
      c.json(
        await updateRequirement(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await today(c),
        ),
      ),
  )
  // A compliance review is a person's judgement.
  .post(
    "/governance/requirements/:id/review",
    forbidTokens,
    validate("param", idParam),
    validate("json", governanceComplianceReviewSchema),
    async (c) =>
      c.json(
        await reviewRequirement(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await today(c),
        ),
      ),
  )
  // Confidential concerns: managers only, never a token.
  .get("/governance/concerns", forbidTokens, requireModuleLevel("governance", "manage"), async (c) =>
    c.json(await listConcerns(c.var.db, c.var.workspace.id)),
  )
  .patch(
    "/governance/concerns/:id",
    forbidTokens,
    requireModuleLevel("governance", "manage"),
    validate("param", idParam),
    validate("json", governanceConcernUpdateSchema),
    async (c) =>
      c.json(
        await updateConcern(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  // Management reviews.
  .get("/governance/reviews", async (c) => c.json(await listReviews(c.var.db, c.var.workspace.id)))
  .post("/governance/reviews", validate("json", governanceReviewCreateSchema), async (c) =>
    c.json(await createReview(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .get("/governance/reviews/:id", validate("param", idParam), async (c) =>
    c.json(
      await getReview(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("param").id,
        await today(c),
        readable(c),
        c.var.activeModules,
      ),
    ),
  )
  .patch(
    "/governance/reviews/:id",
    validate("param", idParam),
    validate("json", governanceReviewUpdateSchema),
    async (c) => {
      const id = c.req.valid("param").id;
      await updateReview(c.var.db, c.var.workspace.id, c.var.user.id, id, c.req.valid("json"));
      return c.json(
        await getReview(c.var.db, c.var.workspace.id, id, await today(c), readable(c), c.var.activeModules),
      );
    },
  )
  .post(
    "/governance/reviews/:id/sign",
    forbidTokens,
    requireModuleLevel("governance", "manage"),
    validate("param", idParam),
    async (c) =>
      c.json(
        await signReview(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          await today(c),
          readable(c),
          c.var.activeModules,
        ),
      ),
  );

/**
 * Raising a confidential concern is open to every member of the workspace (not only those with
 * Governance access), so these routes are platform routes that check the module is on themselves.
 * A person's own report: never a token.
 */
const assertGovernanceOn = (c: Context<WorkspaceEnv>) => {
  if (!c.var.activeModules.includes("governance")) throw notFound("Route");
};
export const concernRoutes = new Hono<WorkspaceEnv>()
  .post("/concerns", forbidTokens, validate("json", governanceConcernSubmitSchema), async (c) => {
    assertGovernanceOn(c);
    return c.json(
      await submitConcern(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), await today(c)),
      201,
    );
  })
  .get("/concerns/mine", forbidTokens, async (c) => {
    assertGovernanceOn(c);
    return c.json(await myConcerns(c.var.db, c.var.workspace.id, c.var.user.id));
  });
