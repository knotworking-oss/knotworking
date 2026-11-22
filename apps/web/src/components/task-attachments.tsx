"use client";

import { isInlineImageType, newId } from "@knotworking/core";
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
import { Progress } from "@knotworking/ui/components/progress";
import { cn } from "@knotworking/ui/lib/utils";
import { AlertCircle, Download, FileText, Paperclip, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { TaskAttachment } from "@/lib/api";
import { attachmentUrl, formatBytes, uploadAttachment, UPLOAD_MAX_BYTES } from "@/lib/attachments";
import { browserApi, errorMessage, unwrapEmpty } from "@/lib/auth-client";
import { relativeTime } from "@/lib/relative-time";
import { useWorkspace } from "@/lib/workspace-store";

interface PendingUpload {
  key: string;
  name: string;
  progress: number;
  error?: string;
}

/**
 * The task page's Attachments section: upload (button or drop), list, download and delete.
 * Like comments, the list comes from the server render and is updated from each response.
 */
export function TaskAttachments({ taskId, initial }: { taskId: string; initial: TaskAttachment[] }) {
  const { slug, viewer, canEditTasks: canEdit, idx } = useWorkspace();
  const [attachments, setAttachments] = useState(initial);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [deleting, setDeleting] = useState<TaskAttachment | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setAttachments(initial), [initial]);

  if (attachments.length === 0 && !canEdit) return null;
  const isAdmin = viewer.role === "owner" || viewer.role === "admin";
  const patchPending = (key: string, patch: Partial<PendingUpload>) =>
    setPending((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  const uploadFiles = (files: File[]) => {
    for (const file of files) {
      const key = newId();
      setPending((list) => [...list, { key, name: file.name, progress: 0 }]);
      uploadAttachment(slug, file, { taskId, onProgress: (progress) => patchPending(key, { progress }) })
        .then((attachment) => {
          setAttachments((list) => [...list.filter((a) => a.id !== attachment.id), attachment]);
          setPending((list) => list.filter((p) => p.key !== key));
        })
        .catch((err) => patchPending(key, { error: errorMessage(err) }));
    }
  };

  const remove = async (attachment: TaskAttachment) => {
    setDeleting(null);
    try {
      await unwrapEmpty(
        browserApi().v1.workspaces[":slug"].attachments[":id"].$delete({
          param: { slug, id: attachment.id },
        }),
      );
      setAttachments((list) => list.filter((a) => a.id !== attachment.id));
    } catch (err) {
      toast.error("Couldn't delete the file", { description: errorMessage(err) });
    }
  };

  return (
    <section
      aria-label="Attachments"
      className={cn(
        "-mx-3 flex flex-col gap-2 rounded-lg px-3 py-2",
        dragging && "bg-muted/60 ring-2 ring-ring/40",
      )}
      onDragOver={(e) => {
        if (!canEdit || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!canEdit || !e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        uploadFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Attachments
          {attachments.length > 0 && <span className="ml-2 tabular-nums">{attachments.length}</span>}
        </h2>
        {canEdit && (
          <>
            <input
              ref={input}
              type="file"
              multiple
              className="hidden"
              aria-label="Choose files to attach"
              onChange={(e) => {
                uploadFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <Button
              variant="ghost"
              size="xs"
              className="ml-auto text-muted-foreground"
              onClick={() => input.current?.click()}
            >
              <Paperclip /> Attach files
            </Button>
          </>
        )}
      </div>

      {attachments.length === 0 && pending.length === 0 && canEdit && (
        <p className="text-sm text-muted-foreground">
          Drop files here or use Attach files (up to {formatBytes(UPLOAD_MAX_BYTES)} each).
        </p>
      )}

      {(attachments.length > 0 || pending.length > 0) && (
        <ul className="flex flex-col gap-1">
          {attachments.map((a) => {
            const uploader = a.uploaderId ? idx.users.get(a.uploaderId) : undefined;
            const image = isInlineImageType(a.contentType);
            return (
              <AttachmentRow
                key={a.id}
                filename={a.filename}
                meta={`${formatBytes(a.size)} · ${uploader?.name ?? "Former member"} · ${relativeTime(a.createdAt)}`}
                thumbnailSrc={image ? attachmentUrl(slug, a.id) : undefined}
                openHref={attachmentUrl(slug, a.id, { download: !image })}
                downloadHref={attachmentUrl(slug, a.id, { download: true })}
                onDelete={
                  canEdit && (a.uploaderId === viewer.id || isAdmin) ? () => setDeleting(a) : undefined
                }
              />
            );
          })}
          {pending.map((p) => (
            <UploadRow
              key={p.key}
              name={p.name}
              progress={p.progress}
              error={p.error}
              onDismiss={() => setPending((list) => list.filter((x) => x.key !== p.key))}
            />
          ))}
        </ul>
      )}

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {deleting?.filename}?</DialogTitle>
            <DialogDescription>
              The file is removed for everyone in the workspace. Images that show it in a description stop
              loading.
            </DialogDescription>
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

/** One stored file: thumbnail (images) or icon, name, details, download and optional delete. */
export function AttachmentRow({
  filename,
  meta,
  thumbnailSrc,
  openHref,
  downloadHref,
  onDelete,
  onReplace,
}: {
  filename: string;
  meta: string;
  /** Inline images only; other files get an icon. */
  thumbnailSrc?: string;
  openHref: string;
  downloadHref: string;
  onDelete?: () => void;
  /** Pick a new version of this file (module records only). */
  onReplace?: () => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded-md px-1 py-1 hover:bg-muted/60">
      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-background">
        {thumbnailSrc ? (
          <img src={thumbnailSrc} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <FileText className="size-4 text-muted-foreground" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <a
          href={openHref}
          target={thumbnailSrc ? "_blank" : undefined}
          rel="noopener noreferrer"
          className="truncate text-sm font-medium hover:underline"
        >
          {filename}
        </a>
        <span className="truncate text-xs text-muted-foreground" suppressHydrationWarning>
          {meta}
        </span>
      </div>
      <Button variant="ghost" size="icon-xs" aria-label={`Download ${filename}`} asChild>
        <a href={downloadHref}>
          <Download />
        </a>
      </Button>
      {onReplace && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Replace ${filename} with a new version`}
          className="text-muted-foreground"
          onClick={onReplace}
        >
          <RefreshCw />
        </Button>
      )}
      {onDelete && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Delete ${filename}`}
          className="text-muted-foreground"
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      )}
    </li>
  );
}

/** A file being uploaded: progress, or the error with a dismiss button. */
export function UploadRow({
  name,
  progress,
  error,
  onDismiss,
}: {
  name: string;
  /** 0–1. */
  progress: number;
  error?: string;
  onDismiss?: () => void;
}) {
  return (
    <li className="flex items-center gap-3 px-1 py-1">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background">
        {error ? (
          <AlertCircle className="size-4 text-destructive" />
        ) : (
          <Paperclip className="size-4 text-muted-foreground" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm">{name}</span>
        {error ? (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        ) : (
          <Progress value={Math.round(progress * 100)} aria-label={`Uploading ${name}`} />
        )}
      </div>
      {error && onDismiss && (
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss}>
          <X />
        </Button>
      )}
    </li>
  );
}
