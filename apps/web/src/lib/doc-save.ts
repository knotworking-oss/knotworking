import { ApiError } from "@knotworking/api-client";
import type { DocContent, DocumentUpdateInput } from "@knotworking/core";

/** What the editor knows about the stored document: the version its edits are based on. */
export type DocSnapshot = { updatedAt: string; title: string; content: DocContent | null };

/**
 * The stored document changed under the editor in a way that matters for what is being saved (its title
 * or body). Nothing was written; `current` is the stored version.
 */
export class DocumentConflictError extends Error {
  constructor(readonly current: DocSnapshot) {
    super("This page was changed by someone else.");
    this.name = "DocumentConflictError";
  }
}

const isSnapshot = (value: unknown): value is DocSnapshot =>
  !!value && typeof value === "object" && typeof (value as DocSnapshot).updatedAt === "string";

/** The `current` document of a `409 document_conflict` response, or null for any other error. */
export function conflictSnapshot(err: unknown): DocSnapshot | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== "document_conflict") return null;
  const current = (err.details as { current?: unknown } | undefined)?.current;
  return isSnapshot(current) ? current : null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Whether the stored version differs, in a field this patch writes, from the one the edit was based on. */
function clashes(patch: DocumentUpdateInput, base: DocSnapshot, current: DocSnapshot) {
  return (
    (patch.title !== undefined && !same(base.title, current.title)) ||
    (patch.content !== undefined && !same(base.content, current.content))
  );
}

const MAX_REBASES = 3;

/**
 * Saves edits to one document with optimistic concurrency. Every write carries the `updatedAt` it is based
 * on (`expectedUpdatedAt`), and each successful response becomes the next base, so a single editor's rapid
 * autosaves chain without conflicts (callers must not overlap saves; `useAutosave` doesn't).
 *
 * When the server answers 409 the stored version is compared with the base, field by field, for what this
 * patch writes: if only something else changed (e.g. the document was moved, or someone retitled a page
 * while we edit its body), the save silently rebases and retries. If the title or body this patch writes
 * was changed by someone else it throws `DocumentConflictError` and writes nothing, so a stale editor can
 * never overwrite newer content.
 */
export function createDocSaver({
  initial,
  send,
}: {
  initial: DocSnapshot;
  /** PATCHes the document and returns it as stored. Rejects with the API's `ApiError`. */
  send: (patch: DocumentUpdateInput) => Promise<DocSnapshot>;
}) {
  let base = initial;
  return {
    get base() {
      return base;
    },
    /** Adopts a version the user chose to load (after "Reload"). */
    rebase(snapshot: DocSnapshot) {
      base = snapshot;
    },
    async save(patch: Omit<DocumentUpdateInput, "expectedUpdatedAt">): Promise<void> {
      for (let rebases = 0; ; rebases++) {
        try {
          const saved = await send({ ...patch, expectedUpdatedAt: base.updatedAt });
          base = { updatedAt: saved.updatedAt, title: saved.title, content: saved.content };
          return;
        } catch (err) {
          const current = conflictSnapshot(err);
          if (!current) throw err;
          if (clashes(patch, base, current) || rebases >= MAX_REBASES)
            throw new DocumentConflictError(current);
          base = current;
        }
      }
    },
  };
}
