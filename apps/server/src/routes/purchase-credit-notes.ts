import {
  purchaseCreditNoteCreateSchema,
  purchaseCreditNoteListQuerySchema,
  purchaseCreditNoteUpdateSchema,
  purchaseCreditNoteVoidSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { requireModuleLevel } from "../middleware/modules";
import {
  approveCreditNote,
  createCreditNote,
  deleteCreditNote,
  getCreditNote,
  listCreditNotes,
  updateCreditNote,
  voidCreditNote,
} from "../services/purchase-credit-notes";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });

/**
 * Supplier credit notes (purchasing module), mounted at `/v1/workspaces/:slug`; the `/purchasing`
 * module rule already requires `read` for safe methods and `write` for the rest.
 *
 * - `write` (API tokens allowed, so agents can draft credit notes): create, edit and delete drafts.
 * - `manage` and a signed-in person, always (`forbidTokens`): approving a credit note, and voiding
 *   an approved one.
 */
export const purchaseCreditNoteRoutes = new Hono<WorkspaceEnv>()
  .get("/purchasing/credit-notes", validate("query", purchaseCreditNoteListQuerySchema), async (c) =>
    c.json(await listCreditNotes(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/purchasing/credit-notes/:id", validate("param", idParam), async (c) =>
    c.json(await getCreditNote(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/purchasing/credit-notes", validate("json", purchaseCreditNoteCreateSchema), async (c) =>
    c.json(await createCreditNote(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/purchasing/credit-notes/:id",
    validate("param", idParam),
    validate("json", purchaseCreditNoteUpdateSchema),
    async (c) =>
      c.json(
        await updateCreditNote(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete("/purchasing/credit-notes/:id", validate("param", idParam), async (c) => {
    await deleteCreditNote(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })
  // ── A signed-in person, always ──
  .post(
    "/purchasing/credit-notes/:id/approve",
    forbidTokens,
    requireModuleLevel("purchasing", "manage"),
    validate("param", idParam),
    async (c) =>
      c.json(await approveCreditNote(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id)),
  )
  .post(
    "/purchasing/credit-notes/:id/void",
    forbidTokens,
    requireModuleLevel("purchasing", "manage"),
    validate("param", idParam),
    validate("json", purchaseCreditNoteVoidSchema),
    async (c) =>
      c.json(
        await voidCreditNote(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  );
