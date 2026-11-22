"use client";

import type { DocContent, DocumentRevisionKind } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@knotworking/ui/components/sheet";
import { cn } from "@knotworking/ui/lib/utils";
import { History } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { relativeTime } from "@/lib/relative-time";
import { useWorkspace } from "@/lib/workspace-store";
import { DocRenderer } from "./doc-renderer";
import { UserAvatar } from "@knotworking/ui/components/user-avatar";
import { useFormatDateTime } from "@/lib/workspace-time";

type RevisionMeta = {
  id: string;
  title: string;
  authorId: string | null;
  kind: DocumentRevisionKind;
  createdAt: string;
  updatedAt: string;
};
type Revision = RevisionMeta & { content: DocContent | null };

/** What a restore leaves the document as: the editor loads this. */
export type RestoredDocument = { updatedAt: string; title: string; content: DocContent | null };

/** "Nov 8, 2026, 3:04 PM" in the viewer's time zone. */
const kindLabel: Record<DocumentRevisionKind, string | null> = {
  edit: null,
  restore: "Restored version",
  "before-restore": "Before a restore",
};

/**
 * The "History" button and side sheet of a document: its saved versions (newest first, with author and
 * time), a read-only preview of the selected one and, for writers, "Restore" with a confirmation.
 *
 * Versions are fetched when the sheet opens (they are not part of the workspace snapshot). Restoring
 * first lets the editor save what it has pending (`prepareRestore`, which resolves to the `updatedAt`
 * the editor's version is based on), sends that as the restore's `expectedUpdatedAt`, and hands the
 * restored document to `onRestored` so the editor can load it.
 */
export function DocHistory({
  id,
  prepareRestore,
  onRestored,
}: {
  id: string;
  prepareRestore?: () => Promise<string | undefined>;
  onRestored?: (doc: RestoredDocument) => void;
}) {
  const when = useFormatDateTime();
  const { slug, canEditDocs: canEdit, idx } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<RevisionMeta[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Revision | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const cache = useRef(new Map<string, Revision>());
  const api = () => browserApi().v1.workspaces[":slug"].documents[":id"].revisions;

  // The list is fetched each time the sheet opens, so it is current.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRevisions(null);
    setLoadError(null);
    setSelected(null);
    setPreview(null);
    cache.current.clear();
    unwrap(api().$get({ param: { slug, id } }))
      .then((res) => !cancelled && setRevisions(res.revisions as RevisionMeta[]))
      .catch((err) => !cancelled && setLoadError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, slug, id]);

  useEffect(() => {
    if (!selected) return;
    const cached = cache.current.get(selected);
    setPreviewError(null);
    if (cached) return setPreview(cached);
    let cancelled = false;
    setPreview(null);
    unwrap(api()[":revisionId"].$get({ param: { slug, id, revisionId: selected } }))
      .then((rev) => {
        if (cancelled) return;
        cache.current.set(selected, rev as Revision);
        setPreview(rev as Revision);
      })
      .catch((err) => !cancelled && setPreviewError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, slug, id]);

  async function restore() {
    if (!preview) return;
    setRestoring(true);
    try {
      const expectedUpdatedAt = await prepareRestore?.();
      const restored = await unwrap(
        api()[":revisionId"].restore.$post({
          param: { slug, id, revisionId: preview.id },
          json: expectedUpdatedAt ? { expectedUpdatedAt } : {},
        }),
      );
      toast.success("Version restored", {
        description: "The previous version is kept in the history.",
      });
      setConfirming(false);
      setOpen(false);
      onRestored?.(restored as RestoredDocument);
    } catch (err) {
      setConfirming(false);
      if (err instanceof ApiError && err.code === "document_conflict")
        toast.error("This page was changed by someone else", {
          description: "Nothing was restored. Reload the page's latest version, then try again.",
        });
      else toast.error("Couldn't restore this version", { description: errorMessage(err) });
    } finally {
      setRestoring(false);
    }
  }

  const authorName = (authorId: string | null) =>
    (authorId && idx.users.get(authorId)?.name) || (authorId ? "Unknown member" : "Deleted user");

  return (
    <>
      <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setOpen(true)}>
        <History /> History
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full gap-0 sm:max-w-4xl">
          <SheetHeader className="border-b">
            <SheetTitle>Version history</SheetTitle>
            <SheetDescription>
              Saved versions of this page. Edits made close together are kept as one version.
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <nav
              aria-label="Versions"
              className="max-h-60 shrink-0 overflow-y-auto border-b md:max-h-none md:w-72 md:border-r md:border-b-0"
            >
              {loadError ? (
                <p role="alert" className="p-4 text-sm text-destructive">
                  Couldn&apos;t load the history. {loadError}
                </p>
              ) : !revisions ? (
                <p className="p-4 text-sm text-muted-foreground">Loading…</p>
              ) : revisions.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">No versions saved yet.</p>
              ) : (
                <ul className="flex flex-col p-2">
                  {revisions.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        aria-current={selected === r.id}
                        onClick={() => setSelected(r.id)}
                        className={cn(
                          "flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
                          selected === r.id && "bg-muted",
                        )}
                      >
                        <span className="font-medium" title={when(r.updatedAt)}>
                          {relativeTime(r.updatedAt)}
                        </span>
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <UserAvatar name={authorName(r.authorId)} className="size-4" />
                          {authorName(r.authorId)}
                        </span>
                        {kindLabel[r.kind] && (
                          <span className="text-xs text-muted-foreground italic">{kindLabel[r.kind]}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </nav>

            <section aria-label="Preview" className="flex min-h-0 min-w-0 flex-1 flex-col">
              {!selected ? (
                <p className="p-6 text-sm text-muted-foreground">Select a version to preview it.</p>
              ) : previewError ? (
                <p role="alert" className="p-6 text-sm text-destructive">
                  Couldn&apos;t load this version. {previewError}
                </p>
              ) : !preview ? (
                <p className="p-6 text-sm text-muted-foreground">Loading…</p>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3 border-b px-6 py-3">
                    <p className="text-sm text-muted-foreground">
                      {when(preview.updatedAt)} · {authorName(preview.authorId)}
                    </p>
                    {canEdit && (
                      <Button size="sm" onClick={() => setConfirming(true)}>
                        Restore this version
                      </Button>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
                    <h2 className="mb-4 text-3xl font-bold tracking-tight">{preview.title || "Untitled"}</h2>
                    <DocRenderer content={preview.content} />
                  </div>
                </>
              )}
            </section>
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={confirming} onOpenChange={(next) => !restoring && setConfirming(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore this version?</DialogTitle>
            <DialogDescription>
              The page&apos;s title and text will be replaced by this version
              {preview ? ` from ${when(preview.updatedAt)}` : ""}. What is on the page now is kept in the
              history, so you can go back.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={restoring} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button disabled={restoring} onClick={() => void restore()}>
              {restoring ? "Restoring…" : "Restore"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
