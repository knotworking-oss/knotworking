import {
  defenceApproveSchema,
  defenceAssessmentCreateSchema,
  defenceAssessmentUpdateSchema,
  defenceCheckListQuerySchema,
  defenceCheckResolveSchema,
  defenceCheckSchema,
  defenceControlCreateSchema,
  defenceControlUpdateSchema,
  defenceDraftSchema,
  defenceExerciseSchema,
  defenceReviewStartSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { canRead, requireModuleLevel } from "../middleware/modules";
import {
  approveDraft,
  createAssessment,
  createControl,
  defenceOverview,
  getAssessment,
  listAssessments,
  listChecks,
  listControls,
  listExercises,
  recordCheck,
  recordExercise,
  resolveCheck,
  saveDraft,
  startReview,
  updateAssessment,
  updateControl,
} from "../services/defence";
import { workspaceToday } from "../services/time-zone";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const controlListQuery = z.object({ status: z.enum(["active", "all"]).default("active") });

/**
 * Food defence module (`defence`). Mounted at `/v1/workspaces/:slug`; the module guard has already
 * required `read` for safe methods and `write` for the rest. Approving an assessment, recording a
 * check, resolving a failure and recording an exercise are a person's acts: never an API token.
 */
export const defenceRoutes = new Hono<WorkspaceEnv>()
  .get("/defence/overview", async (c) =>
    c.json(
      await defenceOverview(
        c.var.db,
        c.var.workspace.id,
        await workspaceToday(c.var.db, c.var.workspace.id),
        {
          visitors: canRead(c, "attendance"),
        },
      ),
    ),
  )
  .get("/defence/assessments", async (c) =>
    c.json(
      await listAssessments(c.var.db, c.var.workspace.id, await workspaceToday(c.var.db, c.var.workspace.id)),
    ),
  )
  .get("/defence/assessments/:id", validate("param", idParam), async (c) =>
    c.json(
      await getAssessment(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("param").id,
        await workspaceToday(c.var.db, c.var.workspace.id),
      ),
    ),
  )
  .post("/defence/assessments", validate("json", defenceAssessmentCreateSchema), async (c) =>
    c.json(
      await createAssessment(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("json"),
        await workspaceToday(c.var.db, c.var.workspace.id),
      ),
      201,
    ),
  )
  .patch(
    "/defence/assessments/:id",
    validate("param", idParam),
    validate("json", defenceAssessmentUpdateSchema),
    async (c) =>
      c.json(
        await updateAssessment(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await workspaceToday(c.var.db, c.var.workspace.id),
        ),
      ),
  )
  .put(
    "/defence/assessments/:id/draft",
    validate("param", idParam),
    validate("json", defenceDraftSchema),
    async (c) =>
      c.json(
        await saveDraft(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await workspaceToday(c.var.db, c.var.workspace.id),
        ),
      ),
  )
  .post(
    "/defence/assessments/:id/review",
    validate("param", idParam),
    validate("json", defenceReviewStartSchema),
    async (c) =>
      c.json(
        await startReview(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await workspaceToday(c.var.db, c.var.workspace.id),
        ),
        201,
      ),
  )
  .post(
    "/defence/assessments/:id/draft/approve",
    forbidTokens,
    requireModuleLevel("defence", "manage"),
    validate("param", idParam),
    validate("json", defenceApproveSchema),
    async (c) =>
      c.json(
        await approveDraft(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await workspaceToday(c.var.db, c.var.workspace.id),
        ),
      ),
  )
  .get("/defence/controls", validate("query", controlListQuery), async (c) =>
    c.json(
      await listControls(
        c.var.db,
        c.var.workspace.id,
        await workspaceToday(c.var.db, c.var.workspace.id),
        c.req.valid("query").status,
      ),
    ),
  )
  .post("/defence/controls", validate("json", defenceControlCreateSchema), async (c) =>
    c.json(await createControl(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/defence/controls/:id",
    validate("param", idParam),
    validate("json", defenceControlUpdateSchema),
    async (c) =>
      c.json(
        await updateControl(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/defence/controls/:id/checks",
    forbidTokens,
    validate("param", idParam),
    validate("json", defenceCheckSchema),
    async (c) =>
      c.json(
        await recordCheck(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await workspaceToday(c.var.db, c.var.workspace.id),
        ),
        201,
      ),
  )
  .get("/defence/checks", validate("query", defenceCheckListQuerySchema), async (c) =>
    c.json(await listChecks(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post(
    "/defence/checks/:id/resolve",
    forbidTokens,
    validate("param", idParam),
    validate("json", defenceCheckResolveSchema),
    async (c) =>
      c.json(
        await resolveCheck(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .get("/defence/exercises", async (c) => c.json(await listExercises(c.var.db, c.var.workspace.id)))
  .post("/defence/exercises", forbidTokens, validate("json", defenceExerciseSchema), async (c) =>
    c.json(
      await recordExercise(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("json"),
        await workspaceToday(c.var.db, c.var.workspace.id),
      ),
      201,
    ),
  );
