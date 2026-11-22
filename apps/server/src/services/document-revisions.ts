import {
  emptyDoc,
  type DocContent,
  type DocumentRestoreInput,
  type DocumentRevisionKind,
} from "@knotworking/core";
import { documentRevisions, documents, type Database, type Executor } from "@knotworking/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { notFound } from "../errors";

/**
 * Version history for documents.
 *
 * A revision is a snapshot of a document's title and body, written in the same transaction as the
 * document write (create, PATCH, restore). Revisions are workspace data but NOT in the sync log:
 * content is large, so clients fetch them on demand, like comments.
 */

/**
 * Autosave must not create a revision per keystroke: while the latest revision of a document is an
 * "edit" by the same author and was started less than this long ago, a save updates it in place
 * instead of adding another. So there is at most one "edit" revision per document, author and window.
 */
export const REVISION_THROTTLE_MINUTES = 10;
/** Only this many revisions are kept per document; saving a newer one prunes the oldest. */
export const MAX_REVISIONS_PER_DOCUMENT = 100;

type RevisionRow = typeof documentRevisions.$inferSelect;
type Snapshot = { title: string; content: DocContent | null };

/** Order-insensitive deep equality for JSON (jsonb reorders object keys, so `JSON.stringify` can't compare). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export const sameSnapshot = (a: Snapshot, b: Snapshot) =>
  a.title === b.title && jsonEqual(a.content ?? null, b.content ?? null);

/** Metadata only: the list never carries bodies. */
export function serializeRevisionMeta(row: Omit<RevisionRow, "content">) {
  const { workspaceId: _ws, ...meta } = row;
  return meta;
}

export function serializeRevision(row: RevisionRow) {
  const { workspaceId: _ws, ...rest } = row;
  return rest;
}

const now = sql`clock_timestamp()`;

/** Inserts a revision and prunes the document's history down to `MAX_REVISIONS_PER_DOCUMENT`. */
export async function insertRevision(
  tx: Executor,
  workspaceId: string,
  documentId: string,
  authorId: string | null,
  kind: DocumentRevisionKind,
  state: Snapshot,
  at?: Date,
) {
  await tx.insert(documentRevisions).values({
    workspaceId,
    documentId,
    title: state.title,
    content: state.content,
    authorId,
    kind,
    createdAt: at ?? (now as unknown as Date),
    updatedAt: at ?? (now as unknown as Date),
  });
  // Newest first; ids are time-ordered, so they settle ties (a restore writes two in one transaction).
  const stale = await tx
    .select({ id: documentRevisions.id })
    .from(documentRevisions)
    .where(eq(documentRevisions.documentId, documentId))
    .orderBy(desc(documentRevisions.createdAt), desc(documentRevisions.id))
    .offset(MAX_REVISIONS_PER_DOCUMENT);
  if (stale.length)
    await tx.delete(documentRevisions).where(
      inArray(
        documentRevisions.id,
        stale.map((r) => r.id),
      ),
    );
}

/** The first revision of a brand-new document. */
export const recordCreated = (
  tx: Executor,
  workspaceId: string,
  documentId: string,
  authorId: string,
  state: Snapshot,
) => insertRevision(tx, workspaceId, documentId, authorId, "edit", state);

/**
 * Records the state a document update produced. Call it inside the update's transaction, with
 * the row as it was before (`before`) and as stored after (`after`).
 *
 * - "edit": skipped when the title and body did not change (a move, an attachment change or a no-op
 *   save), and folded into the latest revision when that is an "edit" by the same author inside the
 *   throttle window.
 * - "restore": always recorded as its own revision.
 *
 * A document that predates version history has no revisions, so its state before the first captured
 * change is stored first (as the version that was current then); otherwise that version would be
 * unrecoverable.
 */
export async function recordUpdate(
  tx: Executor,
  workspaceId: string,
  actorId: string,
  before: Snapshot & { updatedAt: Date; lastEditedById: string | null },
  after: Snapshot & { id: string },
  kind: "edit" | "restore",
) {
  if (kind === "edit" && sameSnapshot(before, after)) return;
  const [latest] = await tx
    .select({
      id: documentRevisions.id,
      authorId: documentRevisions.authorId,
      kind: documentRevisions.kind,
      fresh: sql<boolean>`${documentRevisions.createdAt} > clock_timestamp() - ${REVISION_THROTTLE_MINUTES * 60_000}::double precision * interval '1 millisecond'`,
    })
    .from(documentRevisions)
    .where(eq(documentRevisions.documentId, after.id))
    .orderBy(desc(documentRevisions.createdAt), desc(documentRevisions.id))
    .limit(1);
  if (!latest) {
    await insertRevision(tx, workspaceId, after.id, before.lastEditedById, "edit", before, before.updatedAt);
  } else if (kind === "edit" && latest.kind === "edit" && latest.authorId === actorId && latest.fresh) {
    await tx
      .update(documentRevisions)
      .set({ title: after.title, content: after.content, updatedAt: now as unknown as Date })
      .where(eq(documentRevisions.id, latest.id));
    return;
  }
  await insertRevision(tx, workspaceId, after.id, actorId, kind, after);
}

/** The live document of this workspace, or a 404. Revisions of deleted or foreign documents are never readable. */
async function assertLiveDocument(db: Executor, workspaceId: string, documentId: string) {
  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId), isNull(documents.deletedAt)),
    );
  if (!doc) throw notFound("Document");
}

/** Newest first, without bodies. */
export async function listRevisions(db: Database, workspaceId: string, documentId: string) {
  await assertLiveDocument(db, workspaceId, documentId);
  const rows = await db
    .select({
      id: documentRevisions.id,
      workspaceId: documentRevisions.workspaceId,
      documentId: documentRevisions.documentId,
      title: documentRevisions.title,
      authorId: documentRevisions.authorId,
      kind: documentRevisions.kind,
      createdAt: documentRevisions.createdAt,
      updatedAt: documentRevisions.updatedAt,
    })
    .from(documentRevisions)
    .where(and(eq(documentRevisions.documentId, documentId), eq(documentRevisions.workspaceId, workspaceId)))
    .orderBy(desc(documentRevisions.createdAt), desc(documentRevisions.id))
    .limit(MAX_REVISIONS_PER_DOCUMENT);
  return rows.map(serializeRevisionMeta);
}

/** The full snapshot, for preview and restore. */
export async function getRevision(db: Executor, workspaceId: string, documentId: string, revisionId: string) {
  await assertLiveDocument(db, workspaceId, documentId);
  const [row] = await db
    .select()
    .from(documentRevisions)
    .where(
      and(
        eq(documentRevisions.id, revisionId),
        eq(documentRevisions.documentId, documentId),
        eq(documentRevisions.workspaceId, workspaceId),
      ),
    );
  if (!row) throw notFound("Revision");
  return row;
}

export const revisionContent = (row: Pick<RevisionRow, "content">): DocContent => row.content ?? emptyDoc();

export type { DocumentRestoreInput };
