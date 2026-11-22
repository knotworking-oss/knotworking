import { CLIENT_IP_HEADER } from "@knotworking/core";
import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { ApiError } from "../errors";

/** Upper bound on tracked keys per limiter, so a flood of spoofed keys can't grow memory without limit. */
const MAX_TRACKED = 10_000;

/**
 * Fixed-window counters with bounded memory, shared by the limiters below. State lives in this
 * process only: a restart resets it, and each API replica counts separately.
 */
function createWindowCounter(windowMs: number, now: () => number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    /** Counts one hit for `key`; returns 0 when allowed, otherwise the seconds until the window resets. */
    hit(key: string, max: number): number {
      const t = now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        if (hits.size >= MAX_TRACKED) {
          for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
          // Still full of live entries: drop the oldest (Map keeps insertion order).
          while (hits.size >= MAX_TRACKED) hits.delete(hits.keys().next().value!);
        }
        entry = { count: 0, resetAt: t + windowMs };
        hits.set(key, entry);
      }
      entry.count++;
      return entry.count > max ? Math.max(1, Math.ceil((entry.resetAt - t) / 1000)) : 0;
    },
  };
}

function tooManyRequests(c: { header: (name: string, value: string) => void }, retryAfter: number): never {
  c.header("Retry-After", String(retryAfter));
  throw new ApiError(
    429,
    "rate_limited",
    `Too many requests — try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}`,
  );
}

export interface RateLimitOptions {
  /** Requests allowed per client per window. */
  max: number;
  windowMs: number;
  /** Requests to skip (e.g. cheap, read-only config the login page polls). */
  skip?: (method: string, path: string) => boolean;
  /** Clock, for tests. */
  now?: () => number;
  /** What to count by; default the client IP. The kiosk's host search counts per device. */
  key?: (c: Context) => string;
}

/**
 * A small in-memory fixed-window limiter keyed on the client IP (or on `key`) the web proxy determined
 * from trusted hops (the same header Better Auth rate-limits on). Without a client IP
 * (no trusted proxy configured) everyone shares one bucket. State is per process; it is a
 * brake on guessing invitation tokens and hammering first-run setup, not a distributed quota.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const counter = createWindowCounter(options.windowMs, options.now ?? Date.now);

  return async (c, next) => {
    if (options.skip?.(c.req.method, c.req.path)) return next();
    const key = options.key?.(c) ?? (c.req.header(CLIENT_IP_HEADER)?.trim() || "unknown");
    const retryAfter = counter.hit(key, options.max);
    if (retryAfter) tooManyRequests(c, retryAfter);
    return next();
  };
}

export interface ApiTokenRateLimitOptions {
  /** GET/HEAD/OPTIONS requests allowed per token per window. `0` = unlimited. */
  reads: number;
  /** All other requests allowed per token per window. `0` = unlimited. */
  writes: number;
  windowMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/** Defaults for {@link ApiTokenRateLimitOptions}: a busy agent, not a bulk exporter. */
export const DEFAULT_TOKEN_READS_PER_MINUTE = 600;
export const DEFAULT_TOKEN_WRITES_PER_MINUTE = 120;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Limits requests made with a personal API token (`knw_…`); sign-in sessions pass untouched.
 * Must run after `requireSession`, which resolves `c.var.credential`.
 *
 * Reads and writes have separate budgets, keyed on the token's database id (never the plaintext
 * token), so one token cannot starve another and a flood of reads cannot use up the write budget.
 * Over budget the answer is `429 rate_limited` with `Retry-After`. A `/events` stream counts once,
 * when it connects (the stream itself makes no further requests).
 *
 * HONEST LIMITS: counters live in this process's memory (bounded, see `MAX_TRACKED`). A restart
 * resets them and every API replica counts separately, so N replicas allow up to N times the
 * budget. The MCP server has its own per-token limit on top of this (per MCP process). This is a
 * brake on runaway agents, not an exact distributed quota.
 */
export function apiTokenRateLimit(options: ApiTokenRateLimitOptions) {
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const reads = createWindowCounter(windowMs, now);
  const writes = createWindowCounter(windowMs, now);

  return createMiddleware<AppEnv>(async (c, next) => {
    const credential = c.var.credential;
    if (credential.kind !== "token") return next();
    const read = SAFE_METHODS.has(c.req.method);
    const max = read ? options.reads : options.writes;
    if (max > 0) {
      const retryAfter = (read ? reads : writes).hit(credential.tokenId, max);
      if (retryAfter) tooManyRequests(c, retryAfter);
    }
    return next();
  });
}
