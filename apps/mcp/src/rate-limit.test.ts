import { describe, expect, it } from "vitest";
import { RateLimiter, rateLimitKey } from "./rate-limit";

const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe("rateLimitKey", () => {
  it("is a SHA-256 hex digest that does not contain the token", () => {
    const token = "knw_supersecrettoken";
    const key = rateLimitKey(token);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain(token);
    expect(rateLimitKey(token)).toBe(key);
    expect(rateLimitKey("knw_other")).not.toBe(key);
  });
});

describe("RateLimiter", () => {
  it("allows a burst up to the limit, then refuses with a Retry-After", () => {
    const c = clock();
    const limiter = new RateLimiter(60, c.now); // 1 per second
    for (let i = 0; i < 60; i++) expect(limiter.consume("a", 1)).toEqual({ ok: true });
    expect(limiter.consume("a", 1)).toEqual({ ok: false, retryAfterSeconds: 1 });
    c.advance(1000);
    expect(limiter.consume("a", 1)).toEqual({ ok: true });
    expect(limiter.consume("a", 1)).toMatchObject({ ok: false });
  });

  it("takes nothing from a refused request", () => {
    const c = clock();
    const limiter = new RateLimiter(10, c.now);
    expect(limiter.consume("a", 8)).toEqual({ ok: true });
    expect(limiter.consume("a", 5)).toMatchObject({ ok: false });
    expect(limiter.consume("a", 2)).toEqual({ ok: true }); // the 2 that were left are still there
  });

  it("keeps separate counters per key", () => {
    const limiter = new RateLimiter(2, clock().now);
    expect(limiter.consume("a", 2)).toEqual({ ok: true });
    expect(limiter.consume("a", 1)).toMatchObject({ ok: false });
    expect(limiter.consume("b", 2)).toEqual({ ok: true });
  });

  it("is disabled by 0 and ignores free (zero-cost) requests", () => {
    const off = new RateLimiter(0);
    for (let i = 0; i < 1000; i++) expect(off.consume("a", 1)).toEqual({ ok: true });
    expect(off.size).toBe(0);
    const on = new RateLimiter(1, clock().now);
    expect(on.consume("a", 0)).toEqual({ ok: true });
    expect(on.size).toBe(0);
  });

  it("refuses a request that could never fit", () => {
    const limiter = new RateLimiter(5, clock().now);
    expect(limiter.consume("a", 6)).toEqual({ ok: false, retryAfterSeconds: 60 });
  });

  it("evicts idle keys, so memory is bounded by the active callers", () => {
    const c = clock();
    const limiter = new RateLimiter(10, c.now);
    for (let i = 0; i < 500; i++) limiter.consume(`k${i}`, 1);
    expect(limiter.size).toBe(500);
    c.advance(61_000); // every bucket has refilled: same as never seen
    limiter.consume("fresh", 1);
    expect(limiter.size).toBe(1);
  });

  it("caps the number of tracked keys, dropping the least recently used", () => {
    const limiter = new RateLimiter(10, clock().now, 3);
    for (const k of ["a", "b", "c"]) limiter.consume(k, 10);
    limiter.consume("a", 0.0001); // touch a: b is now the oldest
    limiter.consume("d", 1);
    expect(limiter.size).toBe(3);
    // c still remembers what it spent; b was dropped, so it starts over with a full bucket.
    expect(limiter.consume("c", 1)).toMatchObject({ ok: false });
    expect(limiter.consume("b", 10)).toEqual({ ok: true });
  });

  it("never holds the plaintext token when keyed with rateLimitKey", () => {
    const limiter = new RateLimiter(5, clock().now);
    limiter.consume(rateLimitKey("knw_plaintext"), 1);
    const keys = [...(limiter as unknown as { buckets: Map<string, unknown> }).buckets.keys()];
    expect(JSON.stringify(keys)).not.toContain("knw_plaintext");
  });
});
