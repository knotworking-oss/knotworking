import {
  attachmentContentPath,
  DEFAULT_UPLOAD_MAX_BYTES,
  isInlineImageType,
  type Attachment,
} from "@knotworking/core";

/**
 * Browser-side attachment helpers. Uploads use XMLHttpRequest (fetch can't report upload
 * progress) through the same-origin `/api` proxy, so the session cookie and the Origin check
 * apply exactly as for every other write.
 */

/** Same-origin URL of an attachment's bytes (cookie-authenticated; never a public link). */
export const attachmentUrl = (slug: string, id: string, { download = false } = {}) =>
  `/api${attachmentContentPath(slug, id)}${download ? "?download=1" : ""}`;

/** The client-side check mirrors the API's default; the API has the final say. */
export const UPLOAD_MAX_BYTES = DEFAULT_UPLOAD_MAX_BYTES;

export const isImageFile = (file: { type: string }) => isInlineImageType(file.type);

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export function formatBytes(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export interface UploadOptions {
  taskId?: string;
  documentId?: string;
  /** A module record (see `attachmentTargets` in core) and what the file is. */
  entityType?: string;
  entityId?: string;
  kind?: string;
  /** 0–1 while the bytes are sent. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export function uploadAttachment(slug: string, file: File, options: UploadOptions = {}): Promise<Attachment> {
  if (file.size > UPLOAD_MAX_BYTES) {
    return Promise.reject(
      new UploadError(
        `${file.name} is too large (max ${formatBytes(UPLOAD_MAX_BYTES)})`,
        413,
        "file_too_large",
      ),
    );
  }
  const form = new FormData();
  if (options.taskId) form.append("taskId", options.taskId);
  if (options.documentId) form.append("documentId", options.documentId);
  if (options.entityType && options.entityId) {
    form.append("entityType", options.entityType);
    form.append("entityId", options.entityId);
    if (options.kind) form.append("kind", options.kind);
  }
  form.append("file", file, file.name);
  return sendFile<Attachment>(
    `/api/v1/workspaces/${encodeURIComponent(slug)}/attachments`,
    form,
    201,
    options,
  );
}

/** What replacing a file answers: the new file, and whether the old one was removed (`false` on a locked record). */
export interface ReplacedAttachment {
  attachment: Attachment;
  replaced: boolean;
  previousId: string;
}

/** Replaces a file on a module record with a new version (`POST …/attachments/:id/replace`). */
export function replaceAttachmentFile(
  slug: string,
  id: string,
  file: File,
  options: Pick<UploadOptions, "onProgress" | "signal"> = {},
): Promise<ReplacedAttachment> {
  if (file.size > UPLOAD_MAX_BYTES) {
    return Promise.reject(
      new UploadError(
        `${file.name} is too large (max ${formatBytes(UPLOAD_MAX_BYTES)})`,
        413,
        "file_too_large",
      ),
    );
  }
  const form = new FormData();
  form.append("file", file, file.name);
  return sendFile<ReplacedAttachment>(
    `/api/v1/workspaces/${encodeURIComponent(slug)}/attachments/${encodeURIComponent(id)}/replace`,
    form,
    201,
    options,
  );
}

function sendFile<T>(
  url: string,
  form: FormData,
  okStatus: number,
  options: Pick<UploadOptions, "onProgress" | "signal">,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) options.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = xhr.response as (T & { error?: { code?: string; message?: string } }) | null;
      if (xhr.status === okStatus && body) return resolve(body);
      reject(
        new UploadError(
          body?.error?.message ?? `Upload failed (${xhr.status})`,
          xhr.status,
          body?.error?.code ?? "upload_failed",
        ),
      );
    };
    xhr.onerror = () => reject(new UploadError("Upload failed: network error", 0, "network"));
    xhr.onabort = () => reject(new UploadError("Upload canceled", 0, "aborted"));
    options.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}
