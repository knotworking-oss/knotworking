import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverAutomationWebhook, validateAutomationWebhookUrl } from "./automation-webhook-transport";

const { resolve4, request } = vi.hoisted(() => ({
  resolve4: vi.fn<(hostname: string) => Promise<string[]>>(),
  request: vi.fn<
    (
      url: URL,
      options: RequestOptions,
      onResponse: (response: IncomingMessage) => void,
    ) => {
      on: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    }
  >(),
}));

vi.mock("node:dns/promises", () => ({
  Resolver: class {
    resolve4 = resolve4;
  },
}));
vi.mock("node:https", () => ({ request }));

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

const message = {
  url: "https://events.example.com/incoming",
  secret: "test-signing-secret",
  deliveryId: "delivery-1",
  body: '{"title":"Weekly review ✅"}',
};

describe("automation webhook transport", () => {
  it.each([
    "http://events.example.com",
    "https://user@events.example.com",
    "https://events.example.com#fragment",
    "https://localhost",
    "https://internal.localhost",
    "https://127.0.0.1",
    "https://10.0.0.1",
    "https://[::1]",
  ])("rejects invalid webhook destinations at configuration time (%s)", (url) => {
    expect(() => validateAutomationWebhookUrl(url)).toThrow();
  });

  it("refuses to send to a DNS destination with a private address", async () => {
    resolve4.mockResolvedValue(["1.1.1.1", "192.168.0.1"]);
    await expect(deliverAutomationWebhook(message)).rejects.toThrow("public IPv4");
    expect(request).not.toHaveBeenCalled();
  });

  it("pins the address, signs the exact request body, and returns redirects as a status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const timestamp = "1767225600";
    const signature = createHmac("sha256", message.secret)
      .update(`${timestamp}.${message.deliveryId}.${message.body}`)
      .digest("hex");
    resolve4.mockResolvedValue(["1.1.1.1"]);

    const destroy = vi.fn();
    const end = vi.fn((body: string) => {
      expect(body).toBe(message.body);
      request.mock.calls[0]![2]({ statusCode: 307, destroy } as unknown as IncomingMessage);
    });
    request.mockReturnValue({ on: vi.fn(), end });

    await expect(deliverAutomationWebhook(message)).resolves.toBe(307);
    const [url, options] = request.mock.calls[0]!;
    expect(url.hostname).toBe("events.example.com");
    expect(options).toMatchObject({
      method: "POST",
      agent: false,
      rejectUnauthorized: true,
      headers: {
        "content-length": Buffer.byteLength(message.body),
        "x-knotworking-delivery": message.deliveryId,
        "x-knotworking-timestamp": timestamp,
        "x-knotworking-signature": `sha256=${signature}`,
      },
    });
    const lookupResult = vi.fn();
    options.lookup?.(url.hostname, { family: 4 }, lookupResult);
    expect(lookupResult).toHaveBeenCalledWith(null, "1.1.1.1", 4);
    expect(resolve4).toHaveBeenCalledExactlyOnceWith(url.hostname);
    expect(destroy).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });
});
