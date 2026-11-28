"use client";

import {
  docToPlainText,
  projectHealthLabels,
  projectHealths,
  textToDoc,
  type DocContent,
  type ProjectHealth,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@knotworking/ui/components/dialog";
import { ProjectHealthBadge } from "@knotworking/ui/components/project-badges";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useFormatDateTime } from "@/lib/workspace-time";
import { useWorkspace } from "@/lib/workspace-store";
import { DocEditor } from "./doc-editor/doc-editor";
import { DocRenderer } from "./doc-renderer";

type Message = { id: string; body: DocContent; authorId: string | null; createdAt: string };
type Update = Message & { health: ProjectHealth };
type Page<T> = { items: T[]; nextCursor: string | null };

function useMessagePages<T extends Message>(
  fetchPage: (before?: string) => Promise<Page<T>>,
  enabled: boolean,
) {
  const [page, setPage] = useState<Page<T>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const requestId = useRef(0);

  const load = useCallback(
    async (before?: string) => {
      const request = ++requestId.current;
      setBusy(true);
      setError(undefined);
      try {
        const next = await fetchPage(before);
        if (request === requestId.current)
          setPage((previous) => {
            if (!previous?.items.length) return next;
            const entries = before ? [...previous.items, ...next.items] : [...next.items, ...previous.items];
            return {
              items: [...new Map(entries.map((row) => [row.id, row])).values()],
              nextCursor: before ? next.nextCursor : previous.nextCursor,
            };
          });
      } catch (err) {
        if (request === requestId.current) setError(errorMessage(err));
      } finally {
        if (request === requestId.current) setBusy(false);
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    if (enabled) void load();
    return () => {
      requestId.current++;
    };
  }, [enabled, load]);

  return { page, busy, error, load };
}

export function ProjectUpdates({ projectId }: { projectId: string }) {
  const { slug, idx, sync, canEditTasks } = useWorkspace();
  const formatDate = useFormatDateTime();
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<ProjectHealth>("on_track");
  const [body, setBody] = useState<DocContent | null>(null);
  const [saving, setSaving] = useState(false);
  const fetch = useCallback(
    (before?: string) =>
      unwrap(
        browserApi().v1.workspaces[":slug"].projects[":id"].updates.$get({
          param: { slug, id: projectId },
          query: { before },
        }),
      ),
    [slug, projectId],
  );
  const { page, busy, error, load } = useMessagePages<Update>(fetch, true);

  useEffect(
    () =>
      sync.onChanges((changes) => {
        if (
          changes.some((change) => change.entity === "project_update" && change.data?.projectId === projectId)
        )
          void load();
      }),
    [sync, projectId, load],
  );

  async function post(event: FormEvent) {
    event.preventDefault();
    if (!body || !docToPlainText(body).trim()) return;
    setSaving(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].projects[":id"].updates.$post({
          param: { slug, id: projectId },
          json: { health, body },
        }),
      );
      setOpen(false);
      sync.pull();
      void load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section id="project-updates" aria-label="Project updates" className="border-b px-6 py-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Updates</h2>
        {canEditTasks && (
          <Dialog
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (next) {
                setHealth(idx.projects.get(projectId)?.health ?? "on_track");
                setBody(null);
              }
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                Post update
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Post project update</DialogTitle>
                <DialogDescription>
                  Your post sets the project’s health and notifies its followers.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={post} className="flex min-w-0 flex-col gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  Health
                  <select
                    value={health}
                    className="h-8 rounded-md border bg-background px-2"
                    onChange={(event) => setHealth(event.target.value as ProjectHealth)}
                  >
                    {projectHealths.map((option) => (
                      <option key={option} value={option}>
                        {projectHealthLabels[option]}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="max-h-60 overflow-auto rounded-md border p-2">
                  <DocEditor content={null} placeholder="Write a status update…" onChange={setBody} />
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={saving || !body || !docToPlainText(body).trim()}>
                    Post
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {page?.items.length === 0 && <p className="text-sm text-muted-foreground">No project updates yet.</p>}
      <div className="divide-y">
        {page?.items.map((row) => (
          <article key={row.id} className="space-y-2 py-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <ProjectHealthBadge health={row.health} />
              <span>
                {row.authorId ? (idx.users.get(row.authorId)?.name ?? "Former member") : "Former member"}
              </span>
              <time dateTime={row.createdAt}>{formatDate(row.createdAt)}</time>
            </div>
            <DocRenderer content={row.body} className="text-sm" />
            <ProjectUpdateDiscussion projectId={projectId} updateId={row.id} />
          </article>
        ))}
      </div>
      {page?.nextCursor && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load(page.nextCursor!)}>
          Older updates
        </Button>
      )}
    </section>
  );
}

function ProjectUpdateDiscussion({ projectId, updateId }: { projectId: string; updateId: string }) {
  const { slug, idx, sync, canEditTasks } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const fetch = useCallback(
    (before?: string) =>
      unwrap(
        browserApi().v1.workspaces[":slug"].projects[":id"].updates[":updateId"].comments.$get({
          param: { slug, id: projectId, updateId },
          query: { before },
        }),
      ),
    [slug, projectId, updateId],
  );
  const { page, busy, error, load } = useMessagePages<Message>(fetch, open);

  useEffect(() => {
    if (!open) return;
    return sync.onChanges((changes) => {
      if (changes.some((row) => row.entity === "project_update" && row.entityId === updateId)) void load();
    });
  }, [sync, open, updateId, load]);

  async function comment(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    setSending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].projects[":id"].updates[":updateId"].comments.$post({
          param: { slug, id: projectId, updateId },
          json: { body: textToDoc(draft.trim()) },
        }),
      );
      setDraft("");
      void load();
      sync.pull();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} className="text-sm">
      <summary className="cursor-pointer text-xs text-muted-foreground">Comments</summary>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {page?.items.map((row) => (
        <div key={row.id} className="mt-2 rounded-md border p-2">
          <p className="text-xs font-medium">
            {row.authorId ? (idx.users.get(row.authorId)?.name ?? "Former member") : "Former member"}
          </p>
          <DocRenderer content={row.body} className="text-sm" />
        </div>
      ))}
      {page?.nextCursor && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load(page.nextCursor!)}>
          Older comments
        </Button>
      )}
      {canEditTasks && (
        <form onSubmit={comment} className="mt-2 flex flex-col items-start gap-2">
          <Textarea aria-label="Comment" value={draft} onChange={(event) => setDraft(event.target.value)} />
          <Button size="sm" type="submit" disabled={sending || !draft.trim()}>
            Comment
          </Button>
        </form>
      )}
    </details>
  );
}
