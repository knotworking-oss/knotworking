import { createHash } from "node:crypto";

/** Rate-limit key for a token: a SHA-256 hash, so the plaintext token is never held in memory here. */
export const rateLimitKey = (token: string) => createHash("sha256").update(token).digest("hex");

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * In-memory token bucket per key: holds up to `perMinute` units and refills continuously at
 * `perMinute / 60s`. Memory is bounded: a bucket that has refilled completely is the same as no bucket,
 * so idle keys are swept, and past `maxKeys` the least recently used key is dropped.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep: number;
  private readonly refillPerMs: number;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {
    this.refillPerMs = perMinute / 60_000;
    this.lastSweep = now();
  }

  get enabled() {
    return this.perMinute > 0;
  }

  /** Number of keys currently tracked (for tests and monitoring). */
  get size() {
    return this.buckets.size;
  }

  /** Takes `cost` units for `key`. Nothing is taken when the answer is "not ok". */
  consume(key: string, cost: number): RateLimitResult {
    if (!this.enabled || cost <= 0) return { ok: true };
    const now = this.now();
    this.sweep(now);

    const existing = this.buckets.get(key);
    const bucket = existing ? this.refill(existing, now) : { tokens: this.perMinute, at: now };
    // Re-insert so Map order is least-recently-used first.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    while (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);

    if (cost > this.perMinute) return { ok: false, retryAfterSeconds: 60 };
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { ok: true };
    }
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((cost - bucket.tokens) / this.refillPerMs / 1000)),
    };
  }

  private refill(bucket: Bucket, now: number): Bucket {
    const elapsed = Math.max(0, now - bucket.at);
    return { tokens: Math.min(this.perMinute, bucket.tokens + elapsed * this.refillPerMs), at: now };
  }

  /** At most once a minute: drop every bucket that has refilled to full. */
  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (this.refill(bucket, now).tokens >= this.perMinute) this.buckets.delete(key);
    }
  }
}
