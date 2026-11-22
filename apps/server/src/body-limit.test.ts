import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import { MAX_PUBLIC_JSON_BYTES, requestBodyLimit } from "./middleware/body-limit";

function testApp() {
  return new Hono()
    .onError((error, c) => {
      if (error instanceof ApiError) return c.json({ code: error.code }, error.status);
      throw error;
    })
    .use("*", requestBodyLimit)
    .post("/v1/public/setup", async (c) => c.json(await c.req.json()));
}

describe("request body limits", () => {
  it("cancels a body rejected early by its declared length", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const res = await testApp().request(
      new Request("http://localhost/v1/public/setup", {
        method: "POST",
        body,
        duplex: "half",
        headers: { "content-length": String(MAX_PUBLIC_JSON_BYTES + 1) },
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  it("cancels a streamed body as soon as it exceeds the limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(32 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = await testApp().request(
      new Request("http://localhost/v1/public/setup", {
        method: "POST",
        body,
        duplex: "half",
        headers: { "content-type": "application/json" },
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  it("checks actual bytes even when Content-Length understates the body", async () => {
    const res = await testApp().request("/v1/public/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2" },
      body: JSON.stringify({ text: "x".repeat(MAX_PUBLIC_JSON_BYTES) }),
    });
    expect(res.status).toBe(413);
  });

  it("preserves a valid JSON body", async () => {
    const res = await testApp().request("/v1/public/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"name":"Example"}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Example" });
  });
});
