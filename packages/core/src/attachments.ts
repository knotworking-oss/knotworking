import { z } from "zod";
import type { ModuleId } from "./modules";

/**
 * Images and file attachments (shared by the API and every client).
 *
 * Bytes live in the API's storage (local disk or an S3-compatible bucket); the metadata row is
 * workspace data and travels through the sync log as the `attachment` entity. Nothing is ever
 * served from a public URL: clients fetch `GET /v1/workspaces/:slug/attachments/:id/content`
 * with their session or token.
 *
 * Portable: no DOM or Node APIs.
 */

/** Default largest upload, in bytes (`UPLOAD_MAX_BYTES` on the API overrides it). */
export const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Raster image types that may be shown inline (in documents, as a cover). Only these are ever
 * served with an image content type, and only when the file's own bytes say so. SVG is
 * deliberately absent: it can carry script, so it is stored and served as a download.
 */
export const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type InlineImageType = (typeof INLINE_IMAGE_TYPES)[number];

export const isInlineImageType = (contentType: string | null | undefined): contentType is InlineImageType =>
  (INLINE_IMAGE_TYPES as readonly string[]).includes(contentType ?? "");

/**
 * Other declared types kept as-is (served as downloads). Anything not here, or not well-formed,
 * is stored as `application/octet-stream`; in particular HTML, SVG, XML and JavaScript never keep
 * their script-capable type.
 */
const SAFE_DOWNLOAD_TYPES = new Set([
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/json",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "text/plain",
  "text/csv",
  "text/markdown",
  "audio/mpeg",
  "audio/wav",
  "video/mp4",
  "video/webm",
  "image/heic",
  "image/avif",
  "image/bmp",
  "image/tiff",
]);

/**
 * The image type a file's first bytes prove, if any (PNG, JPEG, GIF, WebP). Needs at least 12
 * bytes for WebP; fewer bytes simply don't match.
 */
export function sniffImageType(bytes: Uint8Array): InlineImageType | null {
  const at = (i: number) => bytes[i];
  const ascii = (from: number, text: string) => [...text].every((ch, i) => at(from + i) === ch.charCodeAt(0));
  if (
    at(0) === 0x89 &&
    ascii(1, "PNG") &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  )
    return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/**
 * The content type to store for an upload. The client's declared type is never trusted for
 * anything that would be rendered: an image type is kept only when the bytes prove it (so a
 * script renamed `.png` is not an image), and only well-known download types survive otherwise.
 */
export function sanitizeContentType(declared: string | null | undefined, sniffed: InlineImageType | null) {
  if (sniffed) return sniffed;
  const type = (declared ?? "").split(";")[0]!.trim().toLowerCase();
  return SAFE_DOWNLOAD_TYPES.has(type) ? type : "application/octet-stream";
}

/** Longest stored filename, in characters. */
export const MAX_FILENAME_LENGTH = 200;

/**
 * A display filename: no path, no control or bidi-override characters, no quotes or slashes
 * (it ends up in `Content-Disposition`), at most 200 characters. Never used as a storage path.
 */
export function sanitizeFilename(name: string | null | undefined): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // C0/C1 controls, and bidi overrides that can disguise an extension.
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "")
    .replace(/["<>:|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!cleaned) return "file";
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;
  // Keep the extension when shortening.
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
}

/**
 * What a file can hang on besides a task or a document: a module's record. One entry per target
 * (the key is the record's sync entity type); the server adds how to load and lock-check the
 * record (`apps/server/src/services/attachment-targets.ts`). Reading needs `read` on `module`,
 * attaching `write`, deleting the uploader's own file or `manage`.
 */
export const attachmentKinds = ["certificate", "specification", "photo", "reply_letter", "document"] as const;
export type AttachmentKind = (typeof attachmentKinds)[number];
export const attachmentKindLabels: Record<AttachmentKind, string> = {
  certificate: "Certificate",
  specification: "Specification",
  photo: "Photo",
  reply_letter: "Reply letter",
  document: "Document",
};

export interface AttachmentTargetDefinition {
  module: ModuleId;
  /** Singular, for the panel ("Attachments on this supplier"). */
  label: string;
  /** The kinds a file can be filed as; the first is the default. */
  kinds: readonly AttachmentKind[];
}

export const attachmentTargets = {
  hse_record: { module: "hse", label: "HSE register", kinds: ["document", "certificate"] },
  hse_entry: { module: "hse", label: "HSE verification", kinds: ["document", "certificate", "photo"] },
  hse_permit: { module: "hse", label: "HSE permit", kinds: ["document", "certificate"] },
  training_record: { module: "training", label: "training record", kinds: ["certificate"] },
  supplier: { module: "items", label: "supplier", kinds: ["certificate", "specification"] },
  item: { module: "items", label: "item", kinds: ["specification"] },
  // The completed questionnaire and what came with it.
  supplier_questionnaire: { module: "items", label: "questionnaire", kinds: ["document", "certificate"] },
  quality_complaint: { module: "quality", label: "complaint", kinds: ["photo", "reply_letter"] },
  quality_nonconformance: { module: "quality", label: "non-conformance", kinds: ["photo", "document"] },
  site_glass_breakage: { module: "site", label: "breakage", kinds: ["photo"] },
  haccp_corrective_action: { module: "haccp", label: "corrective action", kinds: ["photo", "document"] },
  purchase_order: { module: "purchasing", label: "purchase order", kinds: ["document"] },
  purchase_invoice: { module: "purchasing", label: "supplier invoice", kinds: ["document"] },
  quality_audit: { module: "quality", label: "audit", kinds: ["document", "photo"] },
  quality_recall_test: { module: "quality", label: "recall test", kinds: ["document", "photo"] },
  // A delivery is several receipt rows sharing a `deliveryId`; its files hang on the first row.
  purchase_receipt: { module: "purchasing", label: "delivery", kinds: ["document", "photo"] },
  // One line of a delivery (a receipt row): photos of that item as it arrived, kept apart from
  // the delivery's own files. Same table as `purchase_receipt`, so the same rows.
  purchase_receipt_line: { module: "purchasing", label: "delivery line", kinds: ["photo", "document"] },
  haccp_calibration_record: {
    module: "haccp",
    label: "calibration record",
    kinds: ["certificate", "document", "photo"],
  },
  haccp_cleaning_record: { module: "haccp", label: "cleaning record", kinds: ["photo", "document"] },
  // The images in an SOP's text. A file a draft or any version uses can't be deleted.
  sop: { module: "sops", label: "SOP", kinds: ["photo", "document"] },
  // The signed specification sheet, the supplier's own document, certificates of analysis.
  specification: {
    module: "specifications",
    label: "specification",
    kinds: ["specification", "certificate", "document"],
  },
  // The laboratory's report or certificate of analysis, photos of the sampling site.
  testing_sample: { module: "testing", label: "sample", kinds: ["certificate", "document", "photo"] },
  // Briefs, trial photos, artwork proofs, the customer's signed approval.
  npd_project: { module: "npd", label: "project", kinds: ["document", "photo", "specification"] },
  // The exercise plan, debrief notes and photos.
  defence_exercise: { module: "defence", label: "exercise", kinds: ["document", "photo"] },
} as const satisfies Record<string, AttachmentTargetDefinition>;
export type AttachmentTargetType = keyof typeof attachmentTargets;
export const attachmentTargetTypes = Object.keys(attachmentTargets) as [
  AttachmentTargetType,
  ...AttachmentTargetType[],
];
export const isAttachmentTargetType = (value: string): value is AttachmentTargetType =>
  Object.prototype.hasOwnProperty.call(attachmentTargets, value);

/** Form fields of `POST /v1/workspaces/:slug/attachments` (multipart), besides `file`. */
export const attachmentUploadFieldsSchema = z
  .object({
    id: z.uuid().optional(), // clients may pre-generate IDs
    taskId: z.uuid().optional(),
    documentId: z.uuid().optional(),
    /** A module record: both `entityType` and `entityId`, never with a task or document. */
    entityType: z.enum(attachmentTargetTypes).optional(),
    entityId: z.uuid().optional(),
    kind: z.enum(attachmentKinds).optional(),
  })
  .refine((f) => [f.taskId, f.documentId, f.entityType].filter(Boolean).length <= 1, {
    message: "An attachment belongs to at most one task, document or record",
  })
  .refine((f) => Boolean(f.entityType) === Boolean(f.entityId), {
    message: "entityType and entityId go together",
  })
  .refine((f) => !f.kind || Boolean(f.entityType), { message: "kind only applies to a record" })
  .refine(
    (f) =>
      !f.entityType ||
      !f.kind ||
      (attachmentTargets[f.entityType].kinds as readonly string[]).includes(f.kind),
    { message: "That kind of file is not allowed on this record" },
  );
export type AttachmentUploadFields = z.infer<typeof attachmentUploadFieldsSchema>;

/** Query of `GET /v1/workspaces/:slug/attachments`: a record's files. */
export const attachmentListQuerySchema = z.object({
  entityType: z.enum(attachmentTargetTypes),
  entityId: z.uuid(),
});

/** Wire format of an attachment's metadata (also the `attachment` sync-log payload). */
export interface Attachment {
  id: string;
  uploaderId: string | null;
  taskId: string | null;
  documentId: string | null;
  /** The module record it hangs on (see `attachmentTargets`), or null. */
  entityType: AttachmentTargetType | null;
  entityId: string | null;
  kind: AttachmentKind | null;
  /** The file this one replaced, when it is a new version of an earlier file on the same record. */
  replacesId: string | null;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A signed download link (`GET …/attachments/:id/link`) lives this long. Short, because the URL
 * is a bearer credential: whoever holds it can fetch the file until it expires.
 */
export const ATTACHMENT_LINK_TTL_SECONDS = 300;

/** What `GET …/attachments/:id/link` answers. */
export interface AttachmentLink {
  /** Absolute URL; fetching it needs no sign-in. */
  url: string;
  expiresAt: string;
  filename: string;
  contentType: string;
  size: number;
}

/** API path (under the API's base URL) that serves an attachment's bytes. */
export const attachmentContentPath = (workspaceSlug: string, attachmentId: string) =>
  `/v1/workspaces/${encodeURIComponent(workspaceSlug)}/attachments/${encodeURIComponent(attachmentId)}/content`;

/**
 * `documents.coverUrl` holds a reference to an attachment, not a URL anyone can fetch:
 * `attachment:<id>`. Clients turn it into `attachmentContentPath` for their own transport.
 */
const ATTACHMENT_REF = /^attachment:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const attachmentRef = (attachmentId: string) => `attachment:${attachmentId}`;
export const parseAttachmentRef = (value: string | null | undefined): string | null =>
  ATTACHMENT_REF.exec(value ?? "")?.[1]?.toLowerCase() ?? null;
export const attachmentRefSchema = z.string().refine((v) => parseAttachmentRef(v) !== null, {
  message: "Expected attachment:<id>",
});
