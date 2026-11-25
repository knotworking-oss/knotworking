import {
  sortKeyBetween,
  type DocumentCreateInput,
  type DocumentRestoreInput,
  type DocumentUpdateInput,
} from "@knotworking/core";
import { documents, recordChanges, type Database, type Executor, type Transaction } from "@knotworking/db";
import { and, asc, eq, inArray, isNull, max, sql, type SQL } from "drizzle-orm";
import { ApiError, notFound } from "../errors";
import { assertCoverImage } from "./attachments";
import {
  getRevision,
  insertRevision,
  recordCreated,
  recordUpdate,
  revisionContent,
} from "./document-revisions";
import { notifyMentioned, type NotificationRow, type NotifiedCallback } from "./notifications";
import { assertNoCycle, assertRefs } from "./refs";

type DocumentRow = typeof documents.$inferSelect;

/** Metadata only — content is fetched lazily per document. */
export function serializeDocumentMeta(row: DocumentRow) {
  const { content: _content, deletedAt: _deleted, workspaceId: _ws, ...meta } = row;
  return meta;
}

export async function listDocuments(db: Executor, workspaceId: string) {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.workspaceId, workspaceId), isNull(documents.deletedAt)))
    .orderBy(asc(documents.sortOrder));
  return rows.map(serializeDocumentMeta);
}

export async function getDocument(db: Database, workspaceId: string, id: string) {
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.workspaceId, workspaceId), isNull(documents.deletedAt)));
  if (!doc) throw notFound("Document");

  // Breadcrumbs: walk up the tree (bounded to avoid cycles).
  const ancestors: ReturnType<typeof serializeDocumentMeta>[] = [];
  let parentId = doc.parentId;
  for (let depth = 0; parentId && depth < 32; depth++) {
    const [parent] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, parentId), eq(documents.workspaceId, workspaceId)));
    if (!parent || parent.deletedAt) break;
    ancestors.unshift(serializeDocumentMeta(parent));
    parentId = parent.parentId;
  }
  const children = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.parentId, doc.id),
        eq(documents.workspaceId, workspaceId),
        isNull(documents.deletedAt),
      ),
    )
    .orderBy(asc(documents.sortOrder));

  return {
    ...serializeDocumentMeta(doc),
    content: doc.content,
    ancestors,
    children: children.map(serializeDocumentMeta),
  };
}

const siblingsOf = (workspaceId: string, parentId: string | null | undefined): SQL =>
  and(
    eq(documents.workspaceId, workspaceId),
    parentId ? eq(documents.parentId, parentId) : isNull(documents.parentId),
    isNull(documents.deletedAt),
  )!;

export async function createDocument(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: DocumentCreateInput,
  onNotified?: NotifiedCallback,
) {
  let notified: NotificationRow[] = [];
  const result = await db.transaction(async (tx) => {
    await assertRefs(tx, workspaceId, {
      documentParentId: input.parentId,
      teamId: input.teamId,
      projectId: input.projectId,
    });
    // Append to the end of its siblings.
    const [last] = await tx
      .select({ value: max(documents.sortOrder) })
      .from(documents)
      .where(siblingsOf(workspaceId, input.parentId));
    const [doc] = await tx
      .insert(documents)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        parentId: input.parentId ?? null,
        teamId: input.teamId ?? null,
        projectId: input.projectId ?? null,
        title: input.title ?? "",
        icon: input.icon ?? null,
        content: input.content ?? { type: "doc", content: [] },
        sortOrder: input.sortOrder ?? sortKeyBetween(last?.value ?? null, null),
        creatorId: actorId,
        lastEditedById: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "document", entityId: doc!.id, action: "upsert", data: doc },
    ]);
    await recordCreated(tx, workspaceId, doc!.id, actorId, doc!);
    notified = await notifyMentioned(tx, workspaceId, actorId, { document: doc! }, null, doc!.content);
    return { ...serializeDocumentMeta(doc!), content: doc!.content };
  });
  if (notified.length) onNotified?.(notified);
  return result;
}

export async function updateDocument(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: DocumentUpdateInput,
  onNotified?: NotifiedCallback,
) {
  let notified: NotificationRow[] = [];
  const result = await db.transaction(async (tx) => {
    const out = await applyDocumentUpdate(tx, workspaceId, actorId, id, input, "edit");
    notified = out.notified;
    return out.document;
  });
  if (notified.length) onNotified?.(notified);
  return result;
}

/**
 * The document write behind PATCH, MCP `update_document` and restore, inside the caller's transaction:
 * the row update (with the `expectedUpdatedAt` precondition), its sync-log entry and, when the title or
 * body changed, the version-history snapshot (`recordUpdate`). Returns the document plus any mention
 * notifications written (the caller hands those to the email callback after commit); a restore passes
 * `notifyMentions: false`, since the restored body's mentions were already announced when it was written.
 */
async function applyDocumentUpdate(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  id: string,
  input: DocumentUpdateInput,
  revisionKind: "edit" | "restore",
  notifyMentions = true,
) {
  // `expectedUpdatedAt` is a precondition, never a column.
  const { expectedUpdatedAt, ...changes } = input;
  await assertRefs(tx, workspaceId, {
    documentParentId: changes.parentId,
    teamId: changes.teamId,
    projectId: changes.projectId,
  });
  if (changes.parentId !== undefined) await assertNoCycle(tx, documents, id, changes.parentId);
  await assertCoverImage(tx, workspaceId, changes.coverUrl);
  const live = and(eq(documents.id, id), eq(documents.workspaceId, workspaceId), isNull(documents.deletedAt));
  // Only a title or body change can produce a revision. The row is locked while it is read, so what
  // we compare with (and keep as the baseline) is exactly what the UPDATE below replaces.
  const [before] =
    changes.title !== undefined || changes.content !== undefined
      ? await tx.select().from(documents).where(live).for("update")
      : [];
  const [doc] = await tx
    .update(documents)
    .set({
      ...changes,
      lastEditedById: actorId,
      // Strictly increases at millisecond resolution (what clients see in `updatedAt`), so two
      // writes in the same millisecond still invalidate each other's `expectedUpdatedAt`.
      updatedAt: sql`greatest(clock_timestamp(), date_trunc('milliseconds', ${documents.updatedAt}) + interval '1 millisecond')`,
    })
    // The precondition is part of the UPDATE's WHERE, so it is checked against the row as it is
    // when the write lock is taken: of two concurrent writers holding the same value, one wins.
    // Compared as instants at millisecond precision (JSON dates carry no more).
    .where(
      expectedUpdatedAt
        ? and(
            live,
            sql`date_trunc('milliseconds', ${documents.updatedAt}) = ${new Date(expectedUpdatedAt).toISOString()}::timestamptz`,
          )
        : live,
    )
    .returning();
  if (!doc) {
    if (expectedUpdatedAt) {
      const [latest] = await tx.select().from(documents).where(live);
      if (latest) {
        // The latest version rides along so the client can show or merge it without another request.
        throw new ApiError(
          409,
          "document_conflict",
          "This document changed since you last read it. Fetch the latest version, reapply your edit and try again.",
          { current: { ...serializeDocumentMeta(latest), content: latest.content } },
        );
      }
    }
    throw notFound("Document");
  }
  await recordChanges(tx, workspaceId, actorId, [
    { entity: "document", entityId: id, action: "upsert", data: doc },
  ]);
  if (before) await recordUpdate(tx, workspaceId, actorId, before, doc, revisionKind);
  // Mentions are diffed against the body being replaced (`before` is the row as locked above, and the
  // guarded UPDATE decided whether this write happened at all, so a refused save notifies no one).
  const notified =
    notifyMentions && changes.content !== undefined
      ? await notifyMentioned(tx, workspaceId, actorId, { document: doc }, before?.content, doc.content)
      : [];
  return { document: { ...serializeDocumentMeta(doc), content: doc.content }, notified };
}

/**
 * Restores a revision: snapshots the current state as "before-restore" (so the restore can be undone),
 * then applies the revision's title and body as an ordinary document update (sync-log entry, a new
 * "restore" revision, and the `expectedUpdatedAt` precondition if given). All in one transaction, so a
 * conflict (409) leaves no trace, not even the snapshot.
 */
export async function restoreRevision(
  db: Database,
  workspaceId: string,
  actorId: string,
  documentId: string,
  revisionId: string,
  input: DocumentRestoreInput,
) {
  return db.transaction(async (tx) => {
    const revision = await getRevision(tx, workspaceId, documentId, revisionId);
    const [current] = await tx
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.workspaceId, workspaceId),
          isNull(documents.deletedAt),
        ),
      )
      .for("update");
    if (!current) throw notFound("Document");
    await insertRevision(tx, workspaceId, documentId, actorId, "before-restore", current);
    const { document } = await applyDocumentUpdate(
      tx,
      workspaceId,
      actorId,
      documentId,
      {
        title: revision.title,
        content: revisionContent(revision),
        ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
      },
      "restore",
      false,
    );
    return document;
  });
}

/** Soft-deletes a document and all of its descendants. */
export async function deleteDocument(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    const all = await tx
      .select({ id: documents.id, parentId: documents.parentId })
      .from(documents)
      .where(and(eq(documents.workspaceId, workspaceId), isNull(documents.deletedAt)));
    if (!all.some((d) => d.id === id)) throw notFound("Document");
    const ids = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const d of all)
        if (d.parentId && ids.has(d.parentId) && !ids.has(d.id)) (ids.add(d.id), (grew = true));
    }
    await tx
      .update(documents)
      .set({ deletedAt: new Date() })
      .where(inArray(documents.id, [...ids]));
    await recordChanges(
      tx,
      workspaceId,
      actorId,
      [...ids].map((entityId) => ({ entity: "document" as const, entityId, action: "delete" as const })),
    );
  });
}
