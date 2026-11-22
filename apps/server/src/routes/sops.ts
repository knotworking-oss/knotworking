import {
  hasModuleLevel,
  sopAcknowledgeSchema,
  sopCopyCloseSchema,
  sopCopyIssueSchema,
  sopCopyListQuerySchema,
  sopCreateSchema,
  sopDecisionSchema,
  sopDraftSchema,
  sopListQuerySchema,
  sopOutstandingQuerySchema,
  sopSubmitSchema,
  sopTargetsSchema,
  sopUpdateSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { requireModuleLevel } from "../middleware/modules";
import {
  acknowledgeSop,
  createSop,
  decideSopVersion,
  deleteSop,
  getSop,
  getSopTargets,
  getSopVersion,
  listAcknowledgements,
  listOutstandingAcknowledgements,
  listSops,
  saveSopDraft,
  setSopTargets,
  submitSop,
  updateSop,
} from "../services/sops";
import { closeSopCopy, getSopCopy, issueSopCopy, listSopCopies } from "../services/sop-copies";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const versionParam = z.object({ id: z.uuid(), versionId: z.uuid() });
const copyParam = z.object({ copyId: z.uuid() });

/**
 * SOPs module (`sops`): controlled procedures. Mounted at `/v1/workspaces/:slug`; the module guard
 * has already required `read` for safe methods and `write` for the rest. Drafts and versions under
 * review need `write` to read. A sign-off or an acknowledgement is a person: `forbidTokens`.
 */
export const sopRoutes = new Hono<WorkspaceEnv>()
  .get("/sops", validate("query", sopListQuerySchema), async (c) =>
    c.json(
      await listSops(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("query"), c.var.activeModules),
    ),
  )
  // Who still has to acknowledge what (before `/sops/:id`, which would read "outstanding" as an id).
  .get(
    "/sops/outstanding",
    requireModuleLevel("sops", "manage"),
    validate("query", sopOutstandingQuerySchema),
    async (c) =>
      c.json(
        await listOutstandingAcknowledgements(
          c.var.db,
          c.var.workspace.id,
          c.var.activeModules,
          c.req.valid("query"),
        ),
      ),
  )
  // The controlled-copy register (before `/sops/:id`, which would read "copies" as an id).
  .get("/sops/copies", validate("query", sopCopyListQuerySchema), async (c) =>
    c.json(await listSopCopies(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/sops/copies/:copyId", validate("param", copyParam), async (c) =>
    c.json(await getSopCopy(c.var.db, c.var.workspace.id, c.req.valid("param").copyId)),
  )
  // Issuing and calling in a printed copy is the document controller's attestation: a person.
  .post(
    "/sops/copies/:copyId/close",
    forbidTokens,
    requireModuleLevel("sops", "manage"),
    validate("param", copyParam),
    validate("json", sopCopyCloseSchema),
    async (c) =>
      c.json(
        await closeSopCopy(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").copyId,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/sops/:id/copies",
    forbidTokens,
    requireModuleLevel("sops", "manage"),
    validate("param", idParam),
    validate("json", sopCopyIssueSchema),
    async (c) =>
      c.json(
        await issueSopCopy(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .get("/sops/:id", validate("param", idParam), async (c) =>
    c.json(
      await getSop(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        hasModuleLevel(c.var.workspace.modules.sops, "write"),
        c.var.activeModules,
      ),
    ),
  )
  .get("/sops/:id/targets", requireModuleLevel("sops", "manage"), validate("param", idParam), async (c) =>
    c.json(await getSopTargets(c.var.db, c.var.workspace.id, c.var.activeModules, c.req.valid("param").id)),
  )
  .put(
    "/sops/:id/targets",
    requireModuleLevel("sops", "manage"),
    validate("param", idParam),
    validate("json", sopTargetsSchema),
    async (c) =>
      c.json(
        await setSopTargets(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          c.var.activeModules,
        ),
      ),
  )
  .get("/sops/:id/versions/:versionId", validate("param", versionParam), async (c) => {
    const { id, versionId } = c.req.valid("param");
    return c.json(
      await getSopVersion(
        c.var.db,
        c.var.workspace.id,
        id,
        versionId,
        hasModuleLevel(c.var.workspace.modules.sops, "write"),
      ),
    );
  })
  .post("/sops", validate("json", sopCreateSchema), async (c) =>
    c.json(await createSop(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch("/sops/:id", validate("param", idParam), validate("json", sopUpdateSchema), async (c) =>
    c.json(
      await updateSop(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  )
  .put("/sops/:id/draft", validate("param", idParam), validate("json", sopDraftSchema), async (c) =>
    c.json(
      await saveSopDraft(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  )
  .post("/sops/:id/submit", validate("param", idParam), validate("json", sopSubmitSchema), async (c) =>
    c.json(
      await submitSop(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
        c.var.activeModules,
      ),
      201,
    ),
  )
  // Approval is a document-control sign-off: a person with `manage`, never an API token.
  .post(
    "/sops/:id/versions/:versionId/decision",
    forbidTokens,
    requireModuleLevel("sops", "manage"),
    validate("param", versionParam),
    validate("json", sopDecisionSchema),
    async (c) => {
      const { id, versionId } = c.req.valid("param");
      return c.json(
        await decideSopVersion(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.var.activeModules,
          id,
          versionId,
          c.req.valid("json"),
        ),
      );
    },
  )
  // "I have read and understood": a personal attestation, never an API token.
  .post(
    "/sops/:id/acknowledge",
    forbidTokens,
    validate("param", idParam),
    validate("json", sopAcknowledgeSchema),
    async (c) =>
      c.json(
        await acknowledgeSop(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json").versionId,
          "app",
          c.var.activeModules,
        ),
        201,
      ),
  )
  .get(
    "/sops/:id/versions/:versionId/acknowledgements",
    requireModuleLevel("sops", "manage"),
    validate("param", versionParam),
    async (c) => {
      const { id, versionId } = c.req.valid("param");
      return c.json(
        await listAcknowledgements(c.var.db, c.var.workspace.id, c.var.activeModules, id, versionId),
      );
    },
  )
  .delete("/sops/:id", validate("param", idParam), async (c) => {
    await deleteSop(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  });
