"use client";

import {
  attachmentKindLabels,
  attachmentTargets,
  isInlineImageType,
  newId,
  type Attachment,
  type AttachmentKind,
  type AttachmentTargetType,
} from "@knotworking/core";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { cn } from "@knotworking/ui/lib/utils";
import { Lock, Paperclip } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AttachmentRow, UploadRow } from "@/components/task-attachments";
import {
  attachmentUrl,
  formatBytes,
  replaceAttachmentFile,
  uploadAttachment,
  UPLOAD_MAX_BYTES,
} from "@/lib/attachments";
import { browserApi, errorMessage, unwrap, unwrapEmpty } from "@/lib/auth-client";
import { relativeTime } from "@/lib/relative-time";
import { useWorkspace } from "@/lib/workspace-store";

interface PendingUpload {
  key: string;
  name: string;
  progress: number;
  error?: string;
}

/**
 * Files on a module record (certificates, specification sheets, photos, reply letters). Which
 * records take files, and what kinds, comes from `attachmentTargets` in core. The list is fetched
 * from `GET /attachments?entityType&entityId`; the viewer needs `read` in the record's module to
 * see it, `write` to attach, and the uploader or `manage` to delete. A signed-off record
 * (`locked`) still accepts files as evidence but its existing files can't be deleted.
 */
export function RecordAttachments({
  entityType,
  entityId,
  className,
}: {
  entityType: AttachmentTargetType;
  entityId: string;
  className?: string;
}) {
  const target = attachmentTargets[entityType];
  const { slug, viewer, can, idx } = useWorkspace();
  const kinds = target.kinds as readonly AttachmentKind[];
  const [files, setFiles] = useState<Attachment[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [kind, setKind] = useState<AttachmentKind>(kinds[0]!);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [deleting, setDeleting] = useState<Attachment | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  /** The file a "Replace" click is for, until a new one is picked. */
  const replacing = useRef<Attachment | null>(null);

  const canRead = can(target.module, "read");
  const canWrite = viewer.role !== "guest" && can(target.module, "write");
  const canManage = viewer.role !== "guest" && can(target.module, "manage");

  const load = useCallback(async () => {
    try {
      const res = await unwrap(
        browserApi().v1.workspaces[":slug"].attachments.$get({
          param: { slug },
          query: { entityType, entityId },
        }),
      );
      setFiles(res.attachments as Attachment[]);
      setLocked(res.locked);
      setFailed(null);
    } catch (err) {
      setFailed(errorMessage(err));
    }
  }, [slug, entityType, entityId]);
  useEffect(() => {
    setFiles(null);
    if (canRead) void load();
  }, [canRead, load]);

  if (!canRead) return null;

  const patchPending = (key: string, patch: Partial<PendingUpload>) =>
    setPending((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  const uploadFiles = (picked: File[]) => {
    for (const file of picked) {
      const key = newId();
      setPending((list) => [...list, { key, name: file.name, progress: 0 }]);
      uploadAttachment(slug, file, {
        entityType,
        entityId,
        kind,
        onProgress: (progress) => patchPending(key, { progress }),
      })
        .then((attachment) => {
          setFiles((list) => [...(list ?? []).filter((a) => a.id !== attachment.id), attachment]);
          setPending((list) => list.filter((p) => p.key !== key));
        })
        .catch((err) => patchPending(key, { error: errorMessage(err) }));
    }
  };

  /**
   * A new version of a file: the new one is added, and the old one goes unless the record is
   * signed off (then both stay, and the list says which the new one replaced).
   */
  const replaceFile = (old: Attachment, file: File) => {
    const key = newId();
    setPending((list) => [...list, { key, name: file.name, progress: 0 }]);
    replaceAttachmentFile(slug, old.id, file, { onProgress: (progress) => patchPending(key, { progress }) })
      .then(({ attachment, replaced }) => {
        setFiles((list) => [
          ...(list ?? []).filter((a) => a.id !== attachment.id && !(replaced && a.id === old.id)),
          attachment,
        ]);
        setPending((list) => list.filter((p) => p.key !== key));
        if (!replaced) toast.info("The earlier version is kept: this record is signed off.");
      })
      .catch((err) => patchPending(key, { error: errorMessage(err) }));
  };

  const remove = async (attachment: Attachment) => {
    setDeleting(null);
    try {
      await unwrapEmpty(
        browserApi().v1.workspaces[":slug"].attachments[":id"].$delete({
          param: { slug, id: attachment.id },
        }),
      );
      setFiles((list) => (list ?? []).filter((a) => a.id !== attachment.id));
    } catch (err) {
      toast.error("Couldn't delete the file", { description: errorMessage(err) });
      void load();
    }
  };

  const list = files ?? [];
  return (
    <section
      aria-label="Attachments"
      className={cn(
        "flex flex-col gap-2 rounded-lg",
        dragging && "bg-muted/60 ring-2 ring-ring/40",
        className,
      )}
      onDragOver={(e) => {
        if (!canWrite || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!canWrite || !e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        uploadFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Attachments
          {list.length > 0 && <span className="ml-2 tabular-nums">{list.length}</span>}
        </h2>
        {locked && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="size-3" /> Signed off: files can be added but not removed
          </span>
        )}
        {canWrite && (
          <div className="ml-auto flex items-center gap-2">
            {kinds.length > 1 && (
              <Select value={kind} onValueChange={(v) => setKind(v as AttachmentKind)}>
                <SelectTrigger size="sm" aria-label="Kind of file">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {kinds.map((k) => (
                    <SelectItem key={k} value={k}>
                      {attachmentKindLabels[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <input
              ref={replaceInput}
              type="file"
              className="hidden"
              aria-label="Choose the new version of the file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file && replacing.current) replaceFile(replacing.current, file);
                replacing.current = null;
                e.target.value = "";
              }}
            />
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
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() => input.current?.click()}
            >
              <Paperclip /> Attach{" "}
              {kinds.length === 1 ? attachmentKindLabels[kinds[0]!].toLowerCase() : "files"}
            </Button>
          </div>
        )}
      </div>

      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {failed}
        </p>
      )}
      {files && list.length === 0 && pending.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {canWrite
            ? `No files yet. Drop files here or use Attach (up to ${formatBytes(UPLOAD_MAX_BYTES)} each).`
            : `No files on this ${target.label}.`}
        </p>
      )}

      {(list.length > 0 || pending.length > 0) && (
        <ul className="flex flex-col gap-1">
          {list.map((a) => {
            const uploader = a.uploaderId ? idx.users.get(a.uploaderId) : undefined;
            const image = isInlineImageType(a.contentType);
            const deletable = canWrite && !locked && (a.uploaderId === viewer.id || canManage);
            // A locked record keeps the old file, so anyone who may attach may add a version.
            const replaceable = canWrite && (locked || deletable);
            const supersedes = a.replacesId ? list.find((x) => x.id === a.replacesId) : undefined;
            return (
              <AttachmentRow
                key={a.id}
                filename={a.filename}
                meta={`${a.kind ? `${attachmentKindLabels[a.kind]} · ` : ""}${formatBytes(a.size)} · ${uploader?.name ?? "Former member"} · ${relativeTime(a.createdAt)}${supersedes ? ` · replaces ${supersedes.filename}` : ""}`}
                thumbnailSrc={image ? attachmentUrl(slug, a.id) : undefined}
                openHref={attachmentUrl(slug, a.id, { download: !image })}
                downloadHref={attachmentUrl(slug, a.id, { download: true })}
                onDelete={deletable ? () => setDeleting(a) : undefined}
                onReplace={
                  replaceable
                    ? () => {
                        replacing.current = a;
                        replaceInput.current?.click();
                      }
                    : undefined
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
              onDismiss={() => setPending((l) => l.filter((x) => x.key !== p.key))}
            />
          ))}
        </ul>
      )}

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {deleting?.filename}?</DialogTitle>
            <DialogDescription>The file is removed for everyone in the workspace.</DialogDescription>
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

/**
 * A "Files" button that opens the record's attachments in a dialog, for records that have a row in
 * a table rather than a page of their own (audits, recall tests, calibration and cleaning records).
 * The dialog mounts the panel afresh each time, so the lock state is always current.
 */
export function RecordFilesButton({
  entityType,
  entityId,
  title,
  description,
  label = "Files",
}: {
  entityType: AttachmentTargetType;
  entityId: string;
  title: string;
  description?: string;
  label?: string;
}) {
  const { can } = useWorkspace();
  const [open, setOpen] = useState(false);
  if (!can(attachmentTargets[entityType].module, "read")) return null;
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Paperclip data-icon="inline-start" /> {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <RecordAttachments entityType={entityType} entityId={entityId} />
        </DialogContent>
      </Dialog>
    </>
  );
}
