"use client";

import type { DocContent, DocumentUpdateInput } from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import type { Editor } from "@tiptap/react";
import { TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { createDocSaver, DocumentConflictError, type DocSnapshot } from "@/lib/doc-save";
import { useAutosave } from "@/lib/use-autosave";
import { useWorkspace } from "@/lib/workspace-store";
import { DocHistory } from "./doc-history";
import { DocEditor } from "./doc-editor/doc-editor";
import { toStoredContent } from "./doc-editor/extensions";
import { SaveStatusText } from "./doc-editor/save-status";

/**
 * A document's title and body. Writers edit in place with autosave (debounced
 * PATCH through the `/api` proxy); guests get the read-only view.
 *
 * Every save says which version it is based on (`expectedUpdatedAt`). If someone else changed the
 * title or body meanwhile, nothing is written: the editor keeps the user's text, pauses saving and asks
 * whether to load the other version or keep this one as a copy.
 */
export function DocumentEditor({
  id,
  title: initialTitle,
  content: initialContent,
  updatedAt,
  parentId,
  teamId,
  projectId,
  meta,
}: {
  id: string;
  title: string;
  content: DocContent | null | undefined;
  /** The document's `updatedAt` as loaded: the version this editor's edits are based on. */
  updatedAt: string;
  /** Where "keep my version" files the copy (next to the original). */
  parentId?: string | null;
  teamId?: string | null;
  projectId?: string | null;
  /** Rendered between the title and the body (e.g. "Last edited by"). */
  meta?: ReactNode;
}) {
  const { slug, canEditDocs: canEdit } = useWorkspace();
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  // The body the editor is mounted with; "Reload" swaps it (and `rev`, which remounts the editor).
  const [content, setContent] = useState(initialContent);
  const [rev, setRev] = useState(0);
  const [conflict, setConflict] = useState<DocSnapshot | null>(null);
  const [copying, setCopying] = useState(false);
  const editor = useRef<Editor | null>(null);
  const saver = useRef<ReturnType<typeof createDocSaver>>(null);
  // The save in progress, if any, so a restore can wait for it (see `prepareRestore`).
  const inflight = useRef<Promise<unknown>>(null);
  saver.current ??= createDocSaver({
    initial: { updatedAt, title: initialTitle, content: initialContent ?? null },
    send: (patch) =>
      unwrap(
        browserApi().v1.workspaces[":slug"].documents[":id"].$patch({ param: { slug, id }, json: patch }),
      ),
  });

  const { status, schedule, flush, discard } = useAutosave<DocumentUpdateInput>(
    async (patch) => {
      try {
        const saving = saver.current!.save(patch);
        inflight.current = saving.catch(() => {});
        await saving;
      } catch (err) {
        if (err instanceof DocumentConflictError) setConflict(err.current);
        throw err;
      }
      setConflict(null);
      // The title appears in the sidebar, breadcrumbs and tab title.
      if (patch.title !== undefined) router.refresh();
    },
    { pauseOn: (err) => err instanceof DocumentConflictError },
  );

  /** Drops this editor's unsaved changes and shows the stored version. */
  function reload(latest: DocSnapshot) {
    saver.current!.rebase(latest);
    discard();
    setTitle(latest.title);
    setContent(latest.content);
    setRev((n) => n + 1);
    setConflict(null);
    router.refresh();
  }

  /**
   * Before a restore: saves what is pending and waits for it, so the restore is based on the version
   * this editor has actually written. (If the page is in conflict that save is refused and the restore
   * then fails with the same conflict, which is right: resolve it first.)
   */
  async function prepareRestore() {
    await flush();
    await inflight.current;
    return saver.current!.base.updatedAt;
  }

  /**
   * A restore replaced the stored title and body. Same as choosing "Reload their version" in the
   * conflict notice: the editor adopts the restored version as the base of its next save, so saving
   * carries on from it without a conflict, and shows the restored text.
   */
  function onRestored(restored: DocSnapshot) {
    reload({ updatedAt: restored.updatedAt, title: restored.title, content: restored.content });
  }

  /** Files what is on screen as a new page next to this one, then loads the stored version. */
  async function keepMine() {
    if (!conflict || !editor.current) return;
    setCopying(true);
    try {
      const copy = await unwrap(
        browserApi().v1.workspaces[":slug"].documents.$post({
          param: { slug },
          json: {
            parentId: parentId ?? null,
            teamId: teamId ?? null,
            projectId: projectId ?? null,
            title: `${title.trim() || "Untitled"} (my version)`.slice(0, 512),
            content: toStoredContent(editor.current.getJSON()),
          },
        }),
      );
      toast.success("Saved your version as a new page", {
        action: { label: "Open", onClick: () => router.push(`/${slug}/docs/${copy.id}`) },
      });
      reload(conflict);
    } catch (err) {
      toast.error("Couldn't save a copy, your text is still here", { description: errorMessage(err) });
    } finally {
      setCopying(false);
    }
  }

  if (!canEdit)
    return (
      <>
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
          <h1 className="min-w-0 flex-[1_1_16rem] text-3xl font-bold tracking-tight sm:text-4xl">
            {initialTitle || "Untitled"}
          </h1>
          <DocHistory id={id} />
        </div>
        {meta}
        <DocEditor content={initialContent} editable={false} className="text-base" />
      </>
    );

  return (
    <>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <h1 className="min-w-0 flex-[1_1_16rem] text-3xl font-bold tracking-tight sm:text-4xl">
          <textarea
            aria-label="Document title"
            value={title}
            rows={1}
            maxLength={512}
            placeholder="Untitled"
            autoFocus={!initialTitle}
            onChange={(e) => {
              const next = e.target.value.replace(/\n/g, "");
              setTitle(next);
              schedule({ title: next.trim() });
            }}
            onBlur={() => void flush()}
            onKeyDown={(e) => {
              if (e.key === "Enter" && editor.current) {
                e.preventDefault();
                // Move DOM focus now (Tiptap's focus command waits a frame), so typing continues in the body.
                editor.current.view.focus();
                editor.current.commands.focus("start");
              }
            }}
            className="field-sizing-content w-full resize-none bg-transparent outline-none placeholder:text-muted-foreground/50"
          />
        </h1>
        <SaveStatusText status={status} className="mt-3 shrink-0" />
        <DocHistory id={id} prepareRestore={prepareRestore} onRestored={onRestored} />
      </div>
      {meta}
      {conflict && (
        <Alert variant="destructive" className="mb-6">
          <TriangleAlert />
          <AlertTitle>This page was changed by someone else</AlertTitle>
          <AlertDescription>
            <p>
              Your recent edits have not been saved, so nothing of theirs was overwritten. Your text is still
              here. Load their version (your unsaved edits are discarded), or keep yours as a separate page
              and load theirs.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={copying} onClick={() => reload(conflict)}>
                Reload their version
              </Button>
              <Button size="sm" disabled={copying} onClick={() => void keepMine()}>
                Keep my version as a copy
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      <DocEditor
        key={rev}
        content={content}
        className="text-base"
        onReady={(e) => (editor.current = e)}
        images={{ documentId: id }}
        onChange={(next) => schedule({ content: next })}
      />
    </>
  );
}
