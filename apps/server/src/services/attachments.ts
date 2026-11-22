import {
  attachmentUploadFieldsSchema,
  isInlineImageType,
  attachmentTargets,
  isAttachmentTargetType,
  parseAttachmentRef,
  sanitizeContentType,
  sanitizeFilename,
  type Attachment,
  type AttachmentKind,
  type AttachmentTargetType,
  type WorkspaceRole,
} from "@knotworking/core";
import {
  attachments,
  documents,
  recordChanges,
  sops,
  sopVersions,
  tasks,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { attachmentTargetRegistry } from "./attachment-targets";
import type { Storage } from "../storage";
import type { ParsedUpload } from "../upload";
import { isAdmin } from "./members";

type AttachmentRow = typeof attachments.$inferSelect;

/** Wire format (and sync-log payload). The storage key and workspace id stay on the server. */
export function serializeAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    uploaderId: row.uploaderId,
    taskId: row.taskId,
    documentId: row.documentId,
    entityType: (row.entityType as AttachmentTargetType | null) ?? null,
    entityId: row.entityId,
    kind: (row.kind as AttachmentKind | null) ?? null,
    replacesId: row.replacesId,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertLiveTask(db: Executor, workspaceId: string, taskId: string) {
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)));
  return Boolean(task);
}

async function assertLiveDocument(db: Executor, workspaceId: string, documentId: string) {
  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId), isNull(documents.deletedAt)),
    );
  return Boolean(doc);
}

/**
 * A live attachment in this workspace whose task or document (if any) is live too: files on a
 * deleted task or document are not served, like comments on a deleted task.
 */
export async function findAttachment(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select({
      attachment: attachments,
      taskDeletedAt: tasks.deletedAt,
      documentDeletedAt: documents.deletedAt,
    })
    .from(attachments)
    .leftJoin(tasks, eq(tasks.id, attachments.taskId))
    .leftJoin(documents, eq(documents.id, attachments.documentId))
    .where(
      and(eq(attachments.id, id), eq(attachments.workspaceId, workspaceId), isNull(attachments.deletedAt)),
    );
  if (!row || row.taskDeletedAt || row.documentDeletedAt) return null;
  // A file on a module record is served only while the record is live in this workspace.
  const { entityType, entityId } = row.attachment;
  if (entityType && entityId) {
    if (!isAttachmentTargetType(entityType)) return null;
    if (!(await attachmentTargetRegistry[entityType].load(db, workspaceId, entityId))) return null;
  }
  return row.attachment;
}

export async function getAttachment(db: Executor, workspaceId: string, id: string) {
  const row = await findAttachment(db, workspaceId, id);
  if (!row) throw notFound("Attachment");
  return row;
}

/** Oldest first. */
export async function listTaskAttachments(db: Database, workspaceId: string, taskId: string) {
  if (!(await assertLiveTask(db, workspaceId, taskId))) throw notFound("Task");
  const rows = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.workspaceId, workspaceId),
        eq(attachments.taskId, taskId),
        isNull(attachments.deletedAt),
      ),
    )
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  return rows.map(serializeAttachment);
}

/**
 * A record's files, oldest first, and whether the record is locked (signed off or append-only:
 * files can still be added, existing ones can't be deleted).
 */
export async function listRecordAttachments(
  db: Database,
  workspaceId: string,
  entityType: AttachmentTargetType,
  entityId: string,
) {
  const target = await attachmentTargetRegistry[entityType].load(db, workspaceId, entityId);
  if (!target) throw notFound(`The ${attachmentTargets[entityType].label}`);
  const rows = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.workspaceId, workspaceId),
        eq(attachments.entityType, entityType),
        eq(attachments.entityId, entityId),
        isNull(attachments.deletedAt),
      ),
    )
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  return { attachments: rows.map(serializeAttachment), locked: target.locked };
}

/**
 * Records an upload whose bytes are already in storage. On any failure the stored object is
 * deleted, so rejected uploads leave nothing behind.
 */
export async function createAttachment(
  db: Database,
  storage: Storage,
  workspaceId: string,
  actorId: string,
  upload: ParsedUpload,
) {
  try {
    const parsed = attachmentUploadFieldsSchema.safeParse(upload.fields);
    if (!parsed.success) throw badRequest("Invalid fields", parsed.error.issues);
    const fields = parsed.data;
    return await db.transaction(async (tx) => {
      if (fields.taskId && !(await assertLiveTask(tx, workspaceId, fields.taskId)))
        throw badRequest("Unknown taskId");
      if (fields.documentId && !(await assertLiveDocument(tx, workspaceId, fields.documentId)))
        throw badRequest("Unknown documentId");
      if (fields.entityType && fields.entityId) {
        if (!(await attachmentTargetRegistry[fields.entityType].load(tx, workspaceId, fields.entityId)))
          throw badRequest("Unknown entityId");
      }
      const [row] = await tx
        .insert(attachments)
        .values({
          ...(fields.id ? { id: fields.id } : {}),
          workspaceId,
          uploaderId: actorId,
          taskId: fields.taskId ?? null,
          documentId: fields.documentId ?? null,
          entityType: fields.entityType ?? null,
          entityId: fields.entityId ?? null,
          kind: fields.entityType ? (fields.kind ?? attachmentTargets[fields.entityType].kinds[0]) : null,
          filename: sanitizeFilename(upload.file.filename),
          contentType: sanitizeContentType(upload.file.declaredType, upload.file.sniffed),
          size: upload.file.size,
          storageKey: upload.file.storageKey,
        })
        .returning();
      const attachment = serializeAttachment(row!);
      await recordChanges(tx, workspaceId, actorId, [
        { entity: "attachment", entityId: row!.id, action: "upsert", data: { ...attachment } },
      ]);
      return attachment;
    });
  } catch (err) {
    await storage.delete(upload.file.storageKey).catch((e) => console.error("Could not remove upload", e));
    throw err;
  }
}

export interface AttachmentActor {
  id: string;
  role: WorkspaceRole;
  /** `manage` on the module of the record a file hangs on (the route checks it). */
  canManageRecordModule?: boolean;
}

/**
 * Why a file on a module record can't be deleted, or null when it can: the record is locked
 * (signed off or append-only), or an SOP's draft or version uses the image. Both are a 409
 * `attachment_locked`. Task and document files are never locked.
 */
async function removalBlock(tx: Executor, workspaceId: string, row: AttachmentRow): Promise<ApiError | null> {
  if (!row.entityType || !row.entityId) return null;
  if (isAttachmentTargetType(row.entityType)) {
    const target = await attachmentTargetRegistry[row.entityType].load(tx, workspaceId, row.entityId);
    if (target?.locked) {
      return new ApiError(
        409,
        "attachment_locked",
        "This record is signed off, so its files can't be deleted. You can still add more.",
      );
    }
  }
  // An image the SOP's draft or any of its versions uses is part of the controlled document.
  if (row.entityType === "sop") {
    const needle = `%${row.id}%`;
    const [used] = await tx
      .select({ id: sopVersions.id })
      .from(sopVersions)
      .where(
        and(
          eq(sopVersions.sopId, row.entityId),
          isNull(sopVersions.deletedAt),
          sql`${sopVersions.content}::text ilike ${needle}`,
        ),
      )
      .limit(1);
    const [inDraft] = used
      ? [undefined]
      : await tx
          .select({ id: sops.id })
          .from(sops)
          .where(and(eq(sops.id, row.entityId), sql`${sops.draftContent}::text ilike ${needle}`));
    if (used || inDraft) {
      return new ApiError(
        409,
        "attachment_locked",
        used
          ? "A version of this SOP uses this image, so it can't be deleted."
          : "The draft uses this image: remove it from the draft first.",
      );
    }
  }
  return null;
}

/** The uploader, or (task and document files) an owner/admin, or (record files) `manage` on its module. */
function assertMayDelete(row: AttachmentRow, actor: AttachmentActor, verb = "delete") {
  const onRecord = Boolean(row.entityType && row.entityId);
  const privileged = onRecord ? Boolean(actor.canManageRecordModule) : isAdmin(actor.role);
  if (row.uploaderId !== actor.id && !privileged) {
    throw new ApiError(403, "forbidden", `You can only ${verb} files you uploaded`);
  }
}

/**
 * Task and document files: the uploader or an owner/admin may delete. Files on a module record:
 * the uploader or someone with `manage` on its module, and never once the record is locked
 * (signed off or append-only). Soft-deletes the row (a tombstone in the sync log),
 * then removes the bytes once the transaction has committed.
 */
export async function deleteAttachment(
  db: Database,
  storage: Storage,
  workspaceId: string,
  actor: AttachmentActor,
  id: string,
) {
  const storageKey = await db.transaction(async (tx) => {
    const row = await getAttachment(tx, workspaceId, id);
    assertMayDelete(row, actor);
    const block = await removalBlock(tx, workspaceId, row);
    if (block) throw block;
    await tx.update(attachments).set({ deletedAt: new Date() }).where(eq(attachments.id, id));
    await recordChanges(tx, workspaceId, actor.id, [
      { entity: "attachment", entityId: id, action: "delete" },
    ]);
    return row.storageKey;
  });
  // Best effort: the row is already gone for everyone, so a storage hiccup only leaves bytes behind.
  await storage.delete(storageKey).catch((err) => console.error(`Could not remove ${storageKey}`, err));
}

/**
 * Replaces a file on a module record with a new version, in place: the new file is added on the
 * same record with the same kind (`replacesId` points at the old one). When the old file could be
 * deleted (the actor is its uploader or has `manage`, and the record isn't locked) it goes in the
 * same transaction. A locked record, or an SOP image a version uses, keeps the old file beside the
 * new one (`replaced: false`): files can be added to a locked record, never removed. Anyone who may
 * attach may add the new file; removing the old one needs the delete rights, so an actor without
 * them gets a 403 on an unlocked record rather than a silent second copy. Files on tasks and
 * documents are not replaced this way (400). On any failure the new bytes are deleted.
 */
export async function replaceAttachment(
  db: Database,
  storage: Storage,
  workspaceId: string,
  actor: AttachmentActor,
  id: string,
  upload: ParsedUpload,
) {
  try {
    const result = await db.transaction(async (tx) => {
      const old = await getAttachment(tx, workspaceId, id);
      if (!old.entityType || !old.entityId) {
        throw badRequest("Only files on a module record can be replaced; delete and upload instead");
      }
      const block = await removalBlock(tx, workspaceId, old);
      // Only removing the old file needs the delete rights; a locked record just gains a version.
      if (!block) assertMayDelete(old, actor, "replace");
      const [row] = await tx
        .insert(attachments)
        .values({
          workspaceId,
          uploaderId: actor.id,
          entityType: old.entityType,
          entityId: old.entityId,
          kind: old.kind,
          replacesId: old.id,
          filename: sanitizeFilename(upload.file.filename),
          contentType: sanitizeContentType(upload.file.declaredType, upload.file.sniffed),
          size: upload.file.size,
          storageKey: upload.file.storageKey,
        })
        .returning();
      const attachment = serializeAttachment(row!);
      const changes: Parameters<typeof recordChanges>[3] = [
        { entity: "attachment", entityId: row!.id, action: "upsert", data: { ...attachment } },
      ];
      if (!block) {
        await tx.update(attachments).set({ deletedAt: new Date() }).where(eq(attachments.id, old.id));
        changes.push({ entity: "attachment", entityId: old.id, action: "delete" });
      }
      await recordChanges(tx, workspaceId, actor.id, changes);
      return {
        attachment,
        replaced: !block,
        previousId: old.id,
        oldStorageKey: block ? null : old.storageKey,
      };
    });
    if (result.oldStorageKey) {
      const key = result.oldStorageKey;
      await storage.delete(key).catch((err) => console.error(`Could not remove ${key}`, err));
    }
    return { attachment: result.attachment, replaced: result.replaced, previousId: result.previousId };
  } catch (err) {
    await storage.delete(upload.file.storageKey).catch((e) => console.error("Could not remove upload", e));
    throw err;
  }
}

/** `documents.coverUrl` must reference a live inline image in the same workspace. */
export async function assertCoverImage(
  db: Executor,
  workspaceId: string,
  coverUrl: string | null | undefined,
) {
  if (!coverUrl) return;
  const id = parseAttachmentRef(coverUrl);
  const row = id ? await findAttachment(db, workspaceId, id) : null;
  if (!row || !isInlineImageType(row.contentType)) throw badRequest("Unknown cover image");
}
