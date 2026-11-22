import {
  authenticityCreateSchema,
  authenticityListQuerySchema,
  authenticitySaveSchema,
  authenticityVersionCommandSchema,
  authenticityApproveSchema,
  authenticityTriggerSchema,
  authenticityVerificationSchema,
  authenticityVoidSchema,
  authenticityArchiveSchema,
  hasModuleLevel,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { assertModule, requireModuleLevel } from "../middleware/modules";
import { validate } from "../validate";
import {
  listAuthenticity,
  getAuthenticity,
  createAuthenticity,
  startAuthenticityReview,
  saveAuthenticityDraft,
  approveAuthenticity,
  raiseAuthenticityTrigger,
  verifyAuthenticityControl,
  voidAuthenticityVerification,
  archiveAuthenticity,
} from "../services/authenticity";
const idParam = z.object({ id: z.uuid() });
export const authenticityRoutes = new Hono<WorkspaceEnv>()
  .get("/quality/authenticity", validate("query", authenticityListQuerySchema), async (c) =>
    c.json(await listAuthenticity(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/quality/authenticity", validate("json", authenticityCreateSchema), async (c) => {
    if (c.req.valid("json").draft.evidence.some((e) => e.sampleId)) assertModule(c, "testing", "read");
    return c.json(
      await createAuthenticity(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
      201,
    );
  })
  .get("/quality/authenticity/:id", validate("param", idParam), async (c) =>
    c.json(await getAuthenticity(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post(
    "/quality/authenticity/:id/draft",
    validate("param", idParam),
    validate("json", authenticityVersionCommandSchema),
    async (c) =>
      c.json(
        await startAuthenticityReview(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .put(
    "/quality/authenticity/:id/draft",
    validate("param", idParam),
    validate("json", authenticitySaveSchema),
    async (c) => {
      if (c.req.valid("json").draft.evidence.some((e) => e.sampleId)) assertModule(c, "testing", "read");
      return c.json(
        await saveAuthenticityDraft(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      );
    },
  )
  .post(
    "/quality/authenticity/:id/approve",
    forbidTokens,
    requireModuleLevel("quality", "manage"),
    validate("param", idParam),
    validate("json", authenticityApproveSchema),
    async (c) =>
      c.json(
        await approveAuthenticity(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/quality/authenticity/:id/triggers",
    validate("param", idParam),
    validate("json", authenticityTriggerSchema),
    async (c) =>
      c.json(
        await raiseAuthenticityTrigger(
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
    "/quality/authenticity/:id/versions/:versionId/controls/:controlId/verify",
    forbidTokens,
    validate("param", z.object({ id: z.uuid(), versionId: z.uuid(), controlId: z.uuid() })),
    validate("json", authenticityVerificationSchema),
    async (c) =>
      c.json(
        await verifyAuthenticityControl(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("param").versionId,
          c.req.valid("param").controlId,
          c.req.valid("json"),
          hasModuleLevel(c.var.workspace.modules.quality, "manage"),
        ),
        201,
      ),
  )
  .post(
    "/quality/authenticity/:id/verifications/:verificationId/void",
    forbidTokens,
    requireModuleLevel("quality", "manage"),
    validate("param", z.object({ id: z.uuid(), verificationId: z.uuid() })),
    validate("json", authenticityVoidSchema),
    async (c) =>
      c.json(
        await voidAuthenticityVerification(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("param").verificationId,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/quality/authenticity/:id/archive",
    forbidTokens,
    requireModuleLevel("quality", "manage"),
    validate("param", idParam),
    validate("json", authenticityArchiveSchema),
    async (c) =>
      c.json(
        await archiveAuthenticity(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  );
