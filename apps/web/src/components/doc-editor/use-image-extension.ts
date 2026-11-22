"use client";

import { isInlineImageType } from "@knotworking/core";
import type { Editor } from "@tiptap/core";
import { useParams } from "next/navigation";
import { useMemo, useRef } from "react";
import { toast } from "sonner";
import { attachmentUrl, uploadAttachment } from "@/lib/attachments";
import { errorMessage } from "@/lib/auth-client";
import { DocImage, isInlineImageFile } from "./image";

/** What new images in this editor are attached to (shown in that task's or doc's context). */
export interface ImageUploadTarget {
  taskId?: string;
  documentId?: string;
  /** A module record (see `attachmentTargets` in core), e.g. an SOP's images. */
  entityType?: string;
  entityId?: string;
  kind?: string;
}

/**
 * The editor's image node, wired to this workspace: images resolve to the same-origin
 * `/api/…/attachments/:id/content` URL, and, when `target` is set, pasted, dropped or picked
 * images are uploaded (with a progress toast) and inserted where they landed.
 */
export function useImageExtension(target: ImageUploadTarget | undefined) {
  const slug = useParams<{ workspace?: string }>()?.workspace ?? "";
  const targetRef = useRef(target);
  targetRef.current = target;
  return useMemo(
    () =>
      DocImage.configure({
        resolveSrc: (id) => attachmentUrl(slug, id),
        onFiles: target
          ? (files, pos, editor) =>
              void insertUploadedImages(editor, slug, files, pos, targetRef.current ?? {})
          : null,
      }),
    // Created once with the editor (see DocEditor).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
}

async function insertUploadedImages(
  editor: Editor,
  slug: string,
  files: File[],
  pos: number | null,
  target: ImageUploadTarget,
) {
  let at = pos;
  for (const file of files) {
    if (!isInlineImageFile(file)) {
      toast.error(`${file.name} can't be shown in a page`, {
        description: "Images can be PNG, JPEG, GIF or WebP. Attach other files to a task instead.",
      });
      continue;
    }
    const id = toast.loading(`Uploading ${file.name}…`);
    try {
      const attachment = await uploadAttachment(slug, file, {
        ...target,
        onProgress: (f) => toast.loading(`Uploading ${file.name}… ${Math.round(f * 100)}%`, { id }),
      });
      if (!isInlineImageType(attachment.contentType)) {
        toast.error(`${file.name} isn't a valid image`, { id });
        continue;
      }
      if (editor.isDestroyed) {
        toast.dismiss(id);
        return;
      }
      const insertAt = Math.min(at ?? editor.state.selection.to, editor.state.doc.content.size);
      editor
        .chain()
        .insertContentAt(insertAt, {
          type: "image",
          attrs: { attachmentId: attachment.id, filename: attachment.filename },
        })
        .run();
      // The next image goes after this one.
      at = editor.state.selection.to;
      toast.success(`Added ${file.name}`, { id });
    } catch (err) {
      toast.error(`Couldn't upload ${file.name}`, { id, description: errorMessage(err) });
    }
  }
}
