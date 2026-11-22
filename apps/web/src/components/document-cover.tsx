"use client";

import { attachmentRef, isInlineImageType, parseAttachmentRef } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Progress } from "@knotworking/ui/components/progress";
import { ImagePlus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { attachmentUrl, uploadAttachment } from "@/lib/attachments";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

/**
 * A document's cover image (`documents.coverUrl`, an `attachment:<id>` reference). Writers can
 * add, change or remove it; the image is uploaded as an attachment of the document.
 */
export function DocumentCover({ documentId, coverUrl }: { documentId: string; coverUrl: string | null }) {
  const { slug, canEditDocs: canEdit } = useWorkspace();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [cover, setCover] = useState(() => parseAttachmentRef(coverUrl));
  const [progress, setProgress] = useState<number | null>(null);

  const save = async (next: string | null) => {
    await unwrap(
      browserApi().v1.workspaces[":slug"].documents[":id"].$patch({
        param: { slug, id: documentId },
        json: { coverUrl: next ? attachmentRef(next) : null },
      }),
    );
    setCover(next);
    router.refresh();
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!isInlineImageType(file.type)) {
      toast.error("Covers can be PNG, JPEG, GIF or WebP images");
      return;
    }
    setProgress(0);
    try {
      const attachment = await uploadAttachment(slug, file, { documentId, onProgress: setProgress });
      await save(attachment.id);
    } catch (err) {
      toast.error("Couldn't set the cover", { description: errorMessage(err) });
    } finally {
      setProgress(null);
    }
  };

  const remove = async () => {
    try {
      await save(null);
    } catch (err) {
      toast.error("Couldn't remove the cover", { description: errorMessage(err) });
    }
  };

  const picker = (
    <input
      ref={input}
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp"
      className="hidden"
      onChange={(e) => {
        void upload(e.target.files?.[0]);
        e.target.value = "";
      }}
    />
  );
  const uploading = progress !== null && (
    <Progress value={Math.round(progress * 100)} aria-label="Uploading cover" className="mb-4" />
  );

  if (!cover) {
    if (!canEdit) return null;
    return (
      <div className="mb-2 flex flex-col">
        {picker}
        {uploading}
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-muted-foreground"
          disabled={progress !== null}
          onClick={() => input.current?.click()}
        >
          <ImagePlus /> Add cover
        </Button>
      </div>
    );
  }

  return (
    <div className="group relative mb-8">
      {picker}
      {/* Cover images are attachments served through the authenticated /api proxy. */}
      <img
        src={attachmentUrl(slug, cover)}
        alt=""
        className="h-48 w-full rounded-lg border border-border object-cover sm:h-60"
      />
      {canEdit && (
        <div className="absolute right-3 bottom-3 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <Button
            variant="secondary"
            size="sm"
            disabled={progress !== null}
            onClick={() => input.current?.click()}
          >
            <ImagePlus /> Change cover
          </Button>
          <Button variant="secondary" size="icon-sm" aria-label="Remove cover" onClick={() => void remove()}>
            <Trash2 />
          </Button>
        </div>
      )}
      {progress !== null && (
        <Progress value={Math.round(progress * 100)} aria-label="Uploading cover" className="mt-2" />
      )}
    </div>
  );
}
