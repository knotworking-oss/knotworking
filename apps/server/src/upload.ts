import { newId, sniffImageType, type InlineImageType } from "@knotworking/core";
import busboy from "busboy";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { ApiError, badRequest } from "./errors";
import type { Storage } from "./storage";

/** Room for multipart boundaries, part headers and the small form fields. */
const MULTIPART_OVERHEAD = 64 * 1024;
/** Names of the text fields we read; anything else is ignored. */
const FIELDS = new Set(["id", "taskId", "documentId", "entityType", "entityId", "kind"]);

export interface ParsedUpload {
  fields: Record<string, string>;
  file: {
    /** Where the bytes now are. The caller deletes it if the upload is rejected later. */
    storageKey: string;
    /** As the client sent it; sanitize before storing. */
    filename: string;
    declaredType: string;
    size: number;
    /** What the first bytes prove, if an inline image type. */
    sniffed: InlineImageType | null;
  };
}

export const tooLarge = (maxBytes: number) =>
  new ApiError(413, "file_too_large", `Files can be at most ${formatBytes(maxBytes)}`, { maxBytes });

function formatBytes(n: number) {
  if (n >= 1024 * 1024) return `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

/**
 * Streams a `multipart/form-data` upload (one part named `file`, plus optional text fields) into
 * storage without buffering it in the API (S3 storage buffers up to `maxBytes`).
 *
 * - A `Content-Length` that can't fit is refused before anything is read.
 * - The file is cut off at `maxBytes` (413, and the partial object is deleted); a body that keeps
 *   coming far past the limit (e.g. chunked without a length) is no longer read.
 * - The storage key is a fresh server id under the workspace, never derived from the filename.
 */
export async function receiveUpload(
  request: Request,
  { storage, maxBytes, workspaceId }: { storage: Storage; maxBytes: number; workspaceId: string },
): Promise<ParsedUpload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    throw new ApiError(415, "unsupported_media_type", "Upload a file as multipart/form-data");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes + MULTIPART_OVERHEAD)
    throw tooLarge(maxBytes);
  if (!request.body) throw badRequest("Missing file");

  const source = Readable.fromWeb(request.body as unknown as NodeWebReadableStream<Uint8Array>);
  const parser = busboy({
    headers: { "content-type": contentType },
    defParamCharset: "utf8",
    // busboy flags a file as truncated once it *reaches* `fileSize`, so allow one byte more and
    // treat anything over `maxBytes` as too large.
    limits: { files: 1, fileSize: maxBytes + 1, fields: 10, fieldSize: 256, parts: 12, headerPairs: 20 },
  });

  const fields: Record<string, string> = {};
  let file: ParsedUpload["file"] | undefined;
  let stored: Promise<void> | undefined;
  let fileStream: Readable | undefined;
  let truncated = false;
  let aborted = false;
  let received = 0;

  const finished = new Promise<void>((resolve, reject) => {
    parser.on("field", (name, value, info) => {
      if (!FIELDS.has(name)) return;
      if (info.valueTruncated) return reject(badRequest(`Field ${name} is too long`));
      fields[name] = value;
    });
    parser.on("file", (name, stream, info) => {
      if (name !== "file" || file || aborted) {
        stream.resume();
        return;
      }
      const current: ParsedUpload["file"] = {
        storageKey: `${workspaceId}/${newId()}`,
        filename: info.filename ?? "",
        declaredType: info.mimeType ?? "",
        size: 0,
        sniffed: null,
      };
      file = current;
      fileStream = stream;
      stream.on("limit", () => {
        truncated = true;
      });
      const head: Buffer[] = [];
      let headLength = 0;
      async function* tap() {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          current.size += chunk.length;
          if (headLength < 16) {
            head.push(chunk);
            headLength += chunk.length;
          }
          yield chunk;
        }
        current.sniffed = sniffImageType(Buffer.concat(head).subarray(0, 16));
      }
      stored = storage
        .put(current.storageKey, tap(), { contentType: "application/octet-stream" })
        .catch((err) => {
          // Keep draining so the parser (and the request) can finish.
          stream.resume();
          throw err;
        });
      // Don't let an early failure surface as an unhandled rejection before `close`.
      stored.catch(() => {});
    });
    parser.on("error", () => reject(badRequest("Malformed upload")));
    parser.on("close", () => resolve());
    source.on("error", () => reject(badRequest("The upload was interrupted")));
    source.on("data", (chunk: Buffer) => {
      received += chunk.length;
      // Far past what the limit allows: stop reading instead of draining it all.
      if (received > maxBytes + MULTIPART_OVERHEAD && !aborted) {
        aborted = true;
        source.unpipe(parser);
        source.destroy();
        // Ends the storage write too (it deletes its partial object). A file part that starts in
        // this very chunk is skipped by the `aborted` check above.
        fileStream?.destroy(tooLarge(maxBytes));
        reject(tooLarge(maxBytes));
      }
    });
  });

  source.pipe(parser);
  const cleanup = async () => {
    if (!file) return;
    await stored?.catch(() => {});
    await storage.delete(file.storageKey).catch(() => {});
  };
  try {
    await finished;
    if (!file) throw badRequest("Missing file (send it as the form field `file`)");
    await stored;
    if (truncated || file.size > maxBytes) throw tooLarge(maxBytes);
    if (file.size === 0) throw badRequest("The file is empty");
    return { fields, file };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
