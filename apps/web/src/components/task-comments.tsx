"use client";

import { docToPlainText, textToDoc, type DocContent } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@knotworking/ui/components/dropdown-menu";
import { Textarea } from "@knotworking/ui/components/textarea";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { TaskComment } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { relativeTime } from "@/lib/relative-time";
import { useWorkspace } from "@/lib/workspace-store";
import { DocRenderer } from "./doc-renderer";
import { MemberAvatar } from "@/components/member-avatar";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

/** Today's composer writes plain text, which is stored as plain paragraphs of the shared block format. */
const isPlainText = (body: DocContent) =>
  body.content.every(
    (n) => n.type === "paragraph" && (n.content ?? []).every((c) => c.type === "text" && !c.marks),
  );

const MAX_LENGTH = 20_000;

/**
 * Comment thread for a task. The comments come from the server render
 * (`initial`); changes are applied from each API response, so the list is
 * correct without waiting for a bootstrap refresh. They are not part of the
 * workspace snapshot, so other people's new comments show up on reload.
 */
export function TaskComments({ taskId, initial }: { taskId: string; initial: TaskComment[] }) {
  const timeZone = useWorkspaceTimeZone();
  const { slug, viewer, canEditTasks: canEdit, idx } = useWorkspace();
  const [comments, setComments] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TaskComment | null>(null);
  useEffect(() => setComments(initial), [initial]);

  if (comments.length === 0 && !canEdit) return null;

  const api = () => browserApi().v1.workspaces[":slug"];
  const isAdmin = viewer.role === "owner" || viewer.role === "admin";

  const add = async (text: string) => {
    try {
      const created = await unwrap(
        api().tasks[":id"].comments.$post({ param: { slug, id: taskId }, json: { body: textToDoc(text) } }),
      );
      setComments((list) => [...list.filter((c) => c.id !== created.id), created]);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  const save = async (id: string, text: string) => {
    try {
      const updated = await unwrap(
        api().comments[":id"].$patch({ param: { slug, id }, json: { body: textToDoc(text) } }),
      );
      setComments((list) => list.map((c) => (c.id === id ? updated : c)));
      setEditing(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async (comment: TaskComment) => {
    setDeleting(null);
    try {
      const res = await api().comments[":id"].$delete({ param: { slug, id: comment.id } });
      if (!res.ok) await unwrap(Promise.resolve(res));
      setComments((list) => list.filter((c) => c.id !== comment.id && c.parentId !== comment.id));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <section className="mt-6 flex flex-col gap-4" aria-label="Comments">
      <h2 className="text-sm font-medium text-muted-foreground">
        Comments
        {comments.length > 0 && <span className="ml-2 tabular-nums">{comments.length}</span>}
      </h2>

      {comments.length > 0 && (
        <ul className="flex flex-col gap-5">
          {comments.map((comment) => {
            const author = comment.authorId ? idx.users.get(comment.authorId) : undefined;
            const mine = comment.authorId === viewer.id;
            const plain = isPlainText(comment.body);
            return (
              <li key={comment.id} className="group/comment flex gap-3">
                <MemberAvatar
                  userId={comment.authorId}
                  name={author?.name ?? "Former member"}
                  src={author?.avatarUrl}
                  className="mt-0.5"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{author?.name ?? "Former member"}</span>
                    <time
                      dateTime={comment.createdAt}
                      title={formatLongDate(comment.createdAt, timeZone)}
                      suppressHydrationWarning
                      className="text-xs text-muted-foreground"
                    >
                      {relativeTime(comment.createdAt)}
                    </time>
                    {comment.editedAt && <span className="text-xs text-muted-foreground">(edited)</span>}
                    {canEdit && (mine || isAdmin) && editing !== comment.id && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Comment actions"
                            className="ml-auto text-muted-foreground opacity-0 group-hover/comment:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-36">
                          {mine && plain && (
                            <DropdownMenuItem onSelect={() => setEditing(comment.id)}>
                              <Pencil /> Edit
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(comment)}>
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  {editing === comment.id ? (
                    <CommentEditor
                      initialText={docToPlainText(comment.body).trimEnd()}
                      submitLabel="Save"
                      onSubmit={(text) => save(comment.id, text)}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <DocRenderer content={comment.body} className="text-sm leading-6" />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canEdit && <CommentEditor placeholder="Leave a comment…" submitLabel="Comment" onSubmit={add} />}

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this comment?</DialogTitle>
            <DialogDescription>It will be removed for everyone in the workspace.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={() => deleting && remove(deleting)}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Plain-text composer shared by "new comment" and "edit comment". ⌘/Ctrl+Enter submits. */
function CommentEditor({
  initialText = "",
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialText?: string;
  placeholder?: string;
  submitLabel: string;
  /** Resolves true when saved (the composer then clears itself). */
  onSubmit: (text: string) => Promise<boolean | void>;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const empty = text.trim().length === 0;
  const unchanged = text.trim() === initialText.trim();

  const submit = async () => {
    if (empty || unchanged || busy) return;
    setBusy(true);
    try {
      if ((await onSubmit(text)) === true) setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label={placeholder ?? "Edit comment"}
        placeholder={placeholder}
        value={text}
        maxLength={MAX_LENGTH}
        autoFocus={Boolean(onCancel)}
        disabled={busy}
        className="min-h-20 text-sm"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button size="sm" onClick={submit} disabled={empty || unchanged || busy}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
