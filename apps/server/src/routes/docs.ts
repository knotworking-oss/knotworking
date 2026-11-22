import { documentCreateSchema, documentRestoreSchema, documentUpdateSchema } from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { canRead } from "../middleware/modules";
import { requireWriter } from "../middleware/roles";
import { listBacklinks } from "../services/backlinks";
import { getRevision, listRevisions, serializeRevision } from "../services/document-revisions";
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  restoreRevision,
  updateDocument,
} from "../services/documents";
import { emailNotifier } from "../services/notifications";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const revisionParam = z.object({ id: z.uuid(), revisionId: z.uuid() });

/**
 * Documents module (`docs`): the wiki and its version history. Mounted at
 * `/v1/workspaces/:slug`; the module guard has already required `read` for safe methods and
 * `write` for the rest.
 */
export const docRoutes = new Hono<WorkspaceEnv>()
  // ── Documents ──
  .get("/documents", async (c) => c.json({ documents: await listDocuments(c.var.db, c.var.workspace.id) }))
  .get("/documents/:id", validate("param", idParam), async (c) =>
    c.json(await getDocument(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .get("/documents/:id/backlinks", validate("param", idParam), async (c) =>
    c.json(
      await listBacklinks(
        c.var.db,
        c.var.workspace.id,
        { kind: "doc", id: c.req.valid("param").id },
        { documents: true, tasks: canRead(c, "tasks") },
      ),
    ),
  )
  .post("/documents", requireWriter, validate("json", documentCreateSchema), async (c) =>
    c.json(
      await createDocument(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("json"),
        emailNotifier(c.var),
      ),
      201,
    ),
  )
  .patch(
    "/documents/:id",
    requireWriter,
    validate("param", idParam),
    validate("json", documentUpdateSchema),
    async (c) =>
      c.json(
        await updateDocument(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          emailNotifier(c.var),
        ),
      ),
  )
  .delete("/documents/:id", requireWriter, validate("param", idParam), async (c) => {
    await deleteDocument(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })

  // ── Document version history (fetched on demand, not in the sync log) ──
  .get("/documents/:id/revisions", validate("param", idParam), async (c) =>
    c.json({ revisions: await listRevisions(c.var.db, c.var.workspace.id, c.req.valid("param").id) }),
  )
  .get("/documents/:id/revisions/:revisionId", validate("param", revisionParam), async (c) => {
    const { id, revisionId } = c.req.valid("param");
    return c.json(serializeRevision(await getRevision(c.var.db, c.var.workspace.id, id, revisionId)));
  })
  .post(
    "/documents/:id/revisions/:revisionId/restore",
    requireWriter,
    validate("param", revisionParam),
    validate("json", documentRestoreSchema),
    async (c) => {
      const { id, revisionId } = c.req.valid("param");
      return c.json(
        await restoreRevision(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          id,
          revisionId,
          c.req.valid("json"),
        ),
      );
    },
  );
