import type { MiddlewareHandler } from "hono";
import { ApiError } from "../errors";

/** Bound JSON before parsing it. CSV imports allow 2M characters, including UTF-8 text. */
export const MAX_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_PUBLIC_JSON_BYTES = 64 * 1024;

const tooLarge = () => new ApiError(413, "body_too_large", "The request body is too large");

export const requestBodyLimit: MiddlewareHandler = async (c, next) => {
  // receiveUpload streams attachments to storage and applies UPLOAD_MAX_BYTES itself. Never
  // buffer multipart uploads here or weaken the configurable streaming limit.
  if (c.req.method === "POST" && /^\/v1\/workspaces\/[^/]+\/attachments$/.test(c.req.path)) {
    return next();
  }
  const request = c.req.raw;
  if (!request.body) return next();
  const maxBytes =
    c.req.path.startsWith("/api/auth/") || c.req.path.startsWith("/v1/public/")
      ? MAX_PUBLIC_JSON_BYTES
      : MAX_JSON_BYTES;
  // Content-Length can reject early, but never substitutes for counting the actual stream.
  if (Number(request.headers.get("content-length")) > maxBytes) {
    void request.body.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } catch (error) {
    // Stop the source too; a rejected client must not keep feeding the proxy/API indefinitely.
    // Cancellation can be asynchronous, so do not delay the 413 waiting for it to finish.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  c.req.raw = new Request(request, {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
  return next();
};
