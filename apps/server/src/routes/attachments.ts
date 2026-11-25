import {
  attachmentListQuerySchema,
  attachmentTargets,
  attachmentTargetScope,
  hasModuleLevel,
  isAttachmentTargetType,
  isInlineImageType,
} from "@knotworking/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, WorkspaceEnv } from "../env";
import { notFound } from "../errors";
import { assertModule } from "../middleware/modules";
import { requireWriter } from "../middleware/roles";
import { makeAttachmentLink } from "../services/attachment-links";
import {
  createAttachment,
  deleteAttachment,
  getAttachment,
  listRecordAttachments,
  listTaskAttachments,
  replaceAttachment,
  serializeAttachment,
} from "../services/attachments";
import { receiveUpload } from "../upload";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const contentQuery = z.object({ download: z.enum(["0", "1"]).optional() });

/** RFC 6266 / 8187: an ASCII fallback plus the UTF-8 name. */
export function contentDisposition(kind: "inline" | "attachment", filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * An attachment follows the module of what it hangs on: a task's files need the tasks module, a
 * document's images the docs module, a module record's files that record's module
 * (`attachmentTargets`). Unattached files (none today) are platform data.
 */
function assertParentModule(
  c: Context<WorkspaceEnv>,
  parent: {
    taskId?: string | null | undefined;
    documentId?: string | null | undefined;
    entityType?: string | null | undefined;
  },
  needed: "read" | "write",
) {
  if (parent.taskId) assertModule(c, "tasks", needed);
  if (parent.documentId) assertModule(c, "docs", needed);
  if (parent.entityType && isAttachmentTargetType(parent.entityType)) {
    const target = attachmentTargetScope(parent.entityType);
    assertModule(c, target.module, needed);
    for (const dependency of target.requiresModules) assertModule(c, dependency, "read");
  }
}

/** Who is deleting or replacing, with whether they may manage the record's module. */
function deleteActor(c: Context<WorkspaceEnv>, row?: { entityType?: string | null }) {
  const recordModule =
    row?.entityType && isAttachmentTargetType(row.entityType)
      ? attachmentTargets[row.entityType].module
      : null;
  return {
    id: c.var.user.id,
    role: c.var.workspace.role,
    canManageRecordModule: recordModule
      ? hasModuleLevel(c.var.workspace.modules[recordModule], "manage")
      : false,
  };
}

/**
 * Streams a stored file with the headers that keep it inert in a browser (see the content route).
 * `revalidate` adds an ETag so a browser keeps a private copy and rechecks access each time; a
 * signed link is never cached at all.
 */
export async function serveAttachment(
  c: Context<WorkspaceEnv> | Context<AppEnv>,
  row: { id: string; filename: string; contentType: string; size: number; storageKey: string },
  { download, revalidate }: { download: boolean; revalidate: boolean },
) {
  const inline = isInlineImageType(row.contentType) && !download;
  const etag = `"${row.id}"`;
  const headers: Record<string, string> = {
    "Content-Type": inline ? row.contentType : "application/octet-stream",
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", row.filename),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    // Bytes never change for an id, but access can: browsers keep a private copy and
    // revalidate each time, so a removed member or deleted file stops being served.
    "Cache-Control": revalidate ? "private, no-cache" : "private, no-store",
  };
  if (revalidate) {
    headers.ETag = etag;
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
  }
  const object = await c.var.storage.get(row.storageKey);
  if (!object) throw notFound("Attachment");
  headers["Content-Length"] = String(object.size ?? row.size);
  return c.body(object.body, 200, headers);
}

/**
 * Attachments: images in documents (and covers), files on tasks and files on module records. Mounted by `workspaceRoutes`,
 * so every route has already passed `requireSession` and `workspaceAccess` (members only; other
 * workspaces get 404). Uploads and deletes need a writer (guests are read-only), and a read-scope
 * token is refused for them by `requireSession`.
 */
export const attachmentRoutes = new Hono<WorkspaceEnv>()
  /**
   * A record's files: `?entityType=supplier&entityId=…`. Needs `read` on the record's module;
   * the answer says whether the record is `locked` (signed off, so files can't be deleted).
   */
  .get("/attachments", validate("query", attachmentListQuerySchema), async (c) => {
    const { entityType, entityId } = c.req.valid("query");
    assertParentModule(c, { entityType }, "read");
    return c.json(await listRecordAttachments(c.var.db, c.var.workspace.id, entityType, entityId));
  })
  /**
   * `multipart/form-data` with one `file` part and optional `taskId`, `documentId`, `entityType` + `entityId` (+ `kind`), `id` fields.
   * Streamed to storage; the size limit is `UPLOAD_MAX_BYTES` (413 `file_too_large`).
   */
  .post("/attachments", requireWriter, async (c) => {
    const upload = await receiveUpload(c.req.raw, {
      storage: c.var.storage,
      maxBytes: c.var.uploadMaxBytes,
      workspaceId: c.var.workspace.id,
    });
    try {
      assertParentModule(c, upload.fields, "write");
    } catch (err) {
      await c.var.storage.delete(upload.file.storageKey).catch(() => {});
      throw err;
    }
    return c.json(
      await createAttachment(c.var.db, c.var.storage, c.var.workspace.id, c.var.user.id, upload),
      201,
    );
  })
  .get("/attachments/:id", validate("param", idParam), async (c) => {
    const row = await getAttachment(c.var.db, c.var.workspace.id, c.req.valid("param").id);
    assertParentModule(c, row, "read");
    return c.json(serializeAttachment(row));
  })
  /**
   * The bytes. Never public: same session/token and membership checks as every workspace route.
   * Only raster images whose bytes were verified at upload are served inline with their type;
   * everything else (SVG and HTML included) is `application/octet-stream` as a download. A
   * `sandbox` CSP and `nosniff` stop a browser from running anything even if opened directly.
   * `?download=1` forces a download for images too.
   */
  .get("/attachments/:id/content", validate("param", idParam), validate("query", contentQuery), async (c) => {
    const row = await getAttachment(c.var.db, c.var.workspace.id, c.req.valid("param").id);
    assertParentModule(c, row, "read");
    return serveAttachment(c, row, { download: c.req.valid("query").download === "1", revalidate: true });
  })
  /**
   * A short-lived signed URL for the file (`ATTACHMENT_LINK_TTL_SECONDS`), for a client that can't
   * hold the bytes itself: the MCP server hands it to the person, whose browser fetches it. Needs
   * the same `read` access as the bytes (so a token's module allowlist applies too), and a
   * read-scope token may ask: it could download the file anyway. The link is a bearer
   * credential, but it is re-checked against the person's access when it is used.
   */
  .get("/attachments/:id/link", validate("param", idParam), async (c) => {
    const row = await getAttachment(c.var.db, c.var.workspace.id, c.req.valid("param").id);
    assertParentModule(c, row, "read");
    return c.json(
      makeAttachmentLink(
        c.var.attachmentLinkKey,
        `${c.var.appUrl}/api`,
        row,
        c.var.workspace.id,
        c.var.user.id,
      ),
    );
  })
  /**
   * Replaces a file on a module record with a new version: `multipart/form-data` with one `file`
   * part. The old file is deleted unless the record is locked (see `replaceAttachment`), in which
   * case both stay. Needs `write` on the record's module, and the right to delete the old file.
   */
  .post("/attachments/:id/replace", requireWriter, validate("param", idParam), async (c) => {
    const upload = await receiveUpload(c.req.raw, {
      storage: c.var.storage,
      maxBytes: c.var.uploadMaxBytes,
      workspaceId: c.var.workspace.id,
    });
    let row;
    try {
      row = await getAttachment(c.var.db, c.var.workspace.id, c.req.valid("param").id);
      assertParentModule(c, row, "write");
    } catch (err) {
      await c.var.storage.delete(upload.file.storageKey).catch(() => {});
      throw err;
    }
    return c.json(
      await replaceAttachment(
        c.var.db,
        c.var.storage,
        c.var.workspace.id,
        deleteActor(c, row),
        c.req.valid("param").id,
        upload,
      ),
      201,
    );
  })
  .delete("/attachments/:id", requireWriter, validate("param", idParam), async (c) => {
    const row = await getAttachment(c.var.db, c.var.workspace.id, c.req.valid("param").id);
    assertParentModule(c, row, "write");
    await deleteAttachment(
      c.var.db,
      c.var.storage,
      c.var.workspace.id,
      deleteActor(c, row),
      c.req.valid("param").id,
    );
    return c.body(null, 204);
  })
  .get("/tasks/:id/attachments", validate("param", idParam), async (c) =>
    c.json({ attachments: await listTaskAttachments(c.var.db, c.var.workspace.id, c.req.valid("param").id) }),
  );
