import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import type { AppEnv } from "./env";
import { ApiError } from "./errors";
import {
  DEFAULT_TOKEN_READS_PER_MINUTE,
  DEFAULT_TOKEN_WRITES_PER_MINUTE,
  apiTokenRateLimit,
} from "./middleware/rate-limit";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("API-level per-token rate limit", () => {
  let ctx: TestCtx;
  let ada: string;
  let teamId: string;
  let t = 1_000_000;
  const advance = (ms: number) => (t += ms);

  const mint = async (scope: "read" | "write") => {
    const res = await ctx.req("/v1/me/api-tokens", {
      method: "POST",
      cookie: ada,
      json: { name: "rl", scope },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { token: string }).token;
  };
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (path: string, token: string) => ctx.req(path, { headers: as(token) });
  const post = (token: string, title = "rl task") =>
    ctx.req(`${WS}/tasks`, { method: "POST", headers: as(token), json: { teamId, title } });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, apiTokenRateLimit: { reads: 5, writes: 3, now: () => t } });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    teamId = (await (await ctx.req(`${WS}/bootstrap`, { cookie: ada })).json()).teams[0].id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("defaults to 600 reads and 120 writes a minute", () => {
    expect(DEFAULT_TOKEN_READS_PER_MINUTE).toBe(600);
    expect(DEFAULT_TOKEN_WRITES_PER_MINUTE).toBe(120);
  });

  it("answers 429 rate_limited with Retry-After once a token's read budget is spent, and recovers next window", async () => {
    const token = await mint("read");
    for (let i = 0; i < 5; i++) expect((await get("/v1/me", token)).status).toBe(200);
    const blocked = await get(`${WS}/projects`, token);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe("rate_limited");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(blocked.headers.get("retry-after"))).toBeLessThanOrEqual(60);

    advance(61_000);
    expect((await get("/v1/me", token)).status).toBe(200);
  });

  it("budgets reads and writes separately", async () => {
    const token = await mint("write");
    advance(61_000);
    for (let i = 0; i < 5; i++) expect((await get("/v1/me", token)).status).toBe(200);
    expect((await get("/v1/me", token)).status).toBe(429);
    // Reads are spent, writes are untouched.
    for (let i = 0; i < 3; i++) expect((await post(token)).status).toBe(201);
    const blocked = await post(token);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe("rate_limited");
    expect(blocked.headers.get("retry-after")).toBeTruthy();

    // A spent write budget does not block reads in a fresh window, and vice versa.
    advance(61_000);
    expect((await get("/v1/me", token)).status).toBe(200);
    expect((await post(token)).status).toBe(201);
  });

  it("limits each token on its own", async () => {
    advance(61_000);
    const a = await mint("read");
    const b = await mint("read");
    for (let i = 0; i < 5; i++) expect((await get("/v1/me", a)).status).toBe(200);
    expect((await get("/v1/me", a)).status).toBe(429);
    expect((await get("/v1/me", b)).status).toBe(200);
  });

  it("never limits sign-in sessions", async () => {
    for (let i = 0; i < 30; i++) expect((await ctx.req("/v1/me", { cookie: ada })).status).toBe(200);
    expect((await ctx.req(`${WS}/projects`, { cookie: ada })).status).toBe(200);
  });

  it("a read-only token's refused writes never reach the limiter and leave the read budget alone", async () => {
    advance(61_000);
    const token = await mint("read");
    for (let i = 0; i < 10; i++) {
      const res = await post(token);
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("token_read_only");
    }
    expect((await get("/v1/me", token)).status).toBe(200);
  });

  it("counts a token's /events connection once, however long it stays open", async () => {
    advance(61_000);
    const token = await mint("read");
    const res = await ctx.req(`${WS}/events`, { headers: as(token) });
    expect(res.status).toBe(200);
    const reader = (res as unknown as Response).body!.getReader();
    await reader.read(); // `ready`
    // The connect used 1 of 5 reads; 4 more fit, the 5th beyond that does not.
    for (let i = 0; i < 4; i++) expect((await get("/v1/me", token)).status).toBe(200);
    expect((await get("/v1/me", token)).status).toBe(429);
    await reader.cancel();
  });

  it("does not count requests refused for a bad token", async () => {
    advance(61_000);
    for (let i = 0; i < 20; i++) expect((await get("/v1/me", "knw_not-a-real-token")).status).toBe(401);
  });

  it("covers the other token-reachable prefixes (/v1/calendar is counted before it is refused)", async () => {
    advance(61_000);
    const token = await mint("read");
    for (let i = 0; i < 5; i++) expect((await get("/v1/calendar/connections", token)).status).toBe(403);
    expect((await get("/v1/calendar/connections", token)).status).toBe(429);
  });
});

describe("API-level token rate limit: off switch and defaults", () => {
  let ctx: TestCtx;
  let ada: string;
  let t = 5_000_000;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, apiTokenRateLimit: { reads: 0, writes: 2, now: () => t } });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("0 turns a budget off without touching the other", async () => {
    const res = await ctx.req("/v1/me/api-tokens", {
      method: "POST",
      cookie: ada,
      json: { name: "x", scope: "write" },
    });
    const { token } = (await res.json()) as { token: string };
    const h = { authorization: `Bearer ${token}` };
    for (let i = 0; i < 50; i++) expect((await ctx.req("/v1/me", { headers: h })).status).toBe(200);
    const boot = await (await ctx.req(`${WS}/bootstrap`, { headers: h })).json();
    const create = () =>
      ctx.req(`${WS}/tasks`, { method: "POST", headers: h, json: { teamId: boot.teams[0].id, title: "w" } });
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(429);
  });
});

describe("apiTokenRateLimit middleware", () => {
  function setup(credential: AppEnv["Variables"]["credential"] | (() => AppEnv["Variables"]["credential"])) {
    let t = 0;
    const app = new Hono<AppEnv>()
      .use("*", async (c, next) => {
        c.set("credential", typeof credential === "function" ? credential() : credential);
        await next();
      })
      .use("*", apiTokenRateLimit({ reads: 2, writes: 1, now: () => t }))
      .all("/x", (c) => c.json({ ok: true }))
      .onError((err, c) =>
        err instanceof ApiError ? c.json({ error: { code: err.code } }, err.status) : c.text("boom", 500),
      );
    return { app, advance: (ms: number) => (t += ms) };
  }

  it("keys on the token id, not the plaintext, and leaves sessions alone", async () => {
    const { app } = setup({ kind: "session" });
    for (let i = 0; i < 10; i++) expect((await app.request("/x")).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await app.request("/x", { method: "POST" })).status).toBe(200);
  });

  it("treats HEAD and OPTIONS as reads and everything else as writes", async () => {
    const { app } = setup({ kind: "token", scope: "write", tokenId: "tok-1", modules: null });
    expect((await app.request("/x", { method: "HEAD" })).status).toBe(200);
    expect((await app.request("/x", { method: "OPTIONS" })).status).toBe(200);
    expect((await app.request("/x", { method: "GET" })).status).toBe(429);
    expect((await app.request("/x", { method: "PUT" })).status).toBe(200);
    expect((await app.request("/x", { method: "DELETE" })).status).toBe(429);
  });

  it("rounds Retry-After up to whole seconds from the window reset", async () => {
    const { app, advance } = setup({ kind: "token", scope: "write", tokenId: "tok-2", modules: null });
    await app.request("/x", { method: "POST" });
    advance(45_500);
    const blocked = await app.request("/x", { method: "POST" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("15");
  });

  it("keeps memory bounded: the table is capped, evicting the oldest entries", async () => {
    let n = 0;
    const { app } = setup(() => ({ kind: "token", scope: "write", tokenId: `tok-${n++}`, modules: null }));
    // 10,001 distinct tokens: the first one's entry is evicted to stay under the cap...
    for (let i = 0; i < 10_001; i++) await app.request("/x", { method: "POST" });
    // ...so it starts over with a fresh budget (tok-0 was evicted; its write budget is 1, and is spendable again).
    n = 0;
    expect((await app.request("/x", { method: "POST" })).status).toBe(200);
  }, 60_000);
});

describe("API token rate limit configuration", () => {
  const base = { BETTER_AUTH_SECRET: "x".repeat(32) };

  it("defaults to 600 reads and 120 writes per minute", () => {
    expect(loadConfig(base).apiTokenRateLimit).toEqual({ reads: 600, writes: 120 });
    expect(
      loadConfig({ ...base, API_TOKEN_READ_LIMIT_PER_MINUTE: "", API_TOKEN_WRITE_LIMIT_PER_MINUTE: " " })
        .apiTokenRateLimit,
    ).toEqual({ reads: 600, writes: 120 });
  });

  it("reads both limits from the environment, with 0 meaning off", () => {
    expect(
      loadConfig({ ...base, API_TOKEN_READ_LIMIT_PER_MINUTE: "1000", API_TOKEN_WRITE_LIMIT_PER_MINUTE: "0" })
        .apiTokenRateLimit,
    ).toEqual({ reads: 1000, writes: 0 });
  });

  it("refuses values that are not whole numbers, rather than silently changing the limit", () => {
    for (const bad of ["abc", "-1", "1.5", "NaN"])
      expect(() => loadConfig({ ...base, API_TOKEN_READ_LIMIT_PER_MINUTE: bad })).toThrow(
        /API_TOKEN_READ_LIMIT_PER_MINUTE must be a whole number/,
      );
    expect(() => loadConfig({ ...base, API_TOKEN_WRITE_LIMIT_PER_MINUTE: "lots" })).toThrow(
      /API_TOKEN_WRITE_LIMIT_PER_MINUTE/,
    );
  });
});
