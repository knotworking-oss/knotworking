import { describe, expect, it, vi } from "vitest";
import { ledgerFetch } from "../../../../packages/api-client/src/ledger-fetch";

describe("ledger transport retries", () => {
  const url = "https://example.test/api/v1/workspaces/acme/production/batches/batch/output";
  it("uses the same command key and body when a committed response is lost", async () => {
    const received: Request[] = [];
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      received.push(input as Request);
      if (received.length === 1) throw new TypeError("connection closed");
      return new Response("{}");
    });
    await ledgerFetch(transport as typeof fetch)(url, {
      method: "POST",
      body: JSON.stringify({ quantity: 5 }),
    });
    expect(received).toHaveLength(2);
    expect(received[0]!.headers.get("Idempotency-Key")).toBe(received[1]!.headers.get("Idempotency-Key"));
    expect(received[0]!.headers.get("Idempotency-Key")).toBeTruthy();
    expect(await received[0]!.text()).toBe(await received[1]!.text());
  });
  it("preserves a caller's key and never retries a rejected command", async () => {
    const transport = vi.fn(async () => new Response("{}", { status: 409 }));
    await ledgerFetch(transport)(url, {
      method: "POST",
      body: JSON.stringify({ commandId: "01900000-0000-7000-8000-000000000001" }),
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("never automatically retries other writes", async () => {
    const transport = vi.fn(async () => {
      throw new TypeError("offline");
    });
    await expect(
      ledgerFetch(transport)("https://example.test/api/v1/workspaces/acme/items", { method: "POST" }),
    ).rejects.toThrow("offline");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
