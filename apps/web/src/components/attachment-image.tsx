"use client";

import { cn } from "@knotworking/ui/lib/utils";
import { ImageOff } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { attachmentUrl } from "@/lib/attachments";

/**
 * An uploaded image, loaded through the same-origin `/api` proxy with the session cookie (there
 * are no public attachment URLs). Shows a placeholder if it was deleted or can't be loaded.
 */
export function AttachmentImage({
  attachmentId,
  filename,
  alt,
  className,
}: {
  attachmentId: string;
  filename?: string | null;
  alt?: string | null;
  className?: string;
}) {
  const slug = useParams<{ workspace?: string }>()?.workspace ?? "";
  const [failed, setFailed] = useState(false);
  if (failed || !slug)
    return (
      <div
        className={cn(
          "my-1 flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground",
          className,
        )}
      >
        <ImageOff className="size-4" />
        {filename || alt || "Image"} is unavailable
      </div>
    );
  return (
    <img
      src={attachmentUrl(slug, attachmentId)}
      alt={alt ?? filename ?? ""}
      title={filename ?? undefined}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("my-1 h-auto max-w-full rounded-md border border-border", className)}
    />
  );
}
