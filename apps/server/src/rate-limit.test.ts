import { CLIENT_IP_HEADER } from "@knotworking/core";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import { rateLimit } from "./middleware/rate-limit";
import { makeApp, type TestCtx } from "./test-utils";

describe("rateLimit middleware", () => {
  function setup(max = 2) {
    let t = 1_000;
    const app = new Hono()
      .use("*", rateLimit({ max, windowMs: 10_000, now: () => t, skip: (_m, path) => path === "/free" }))
      .get("/x", (c) => c.json({ ok: true }))
      .get("/free", (c) => c.json({ ok: true }))
      .onError((err, c) =>
        err instanceof ApiError ? c.json({ error: { code: err.code } }, err.status) : c.text("boom", 500),
      );
    const get = (path: string, ip?: string) =>
      app.request(path, { headers: ip ? { [CLIENT_IP_HEADER]: ip } : {} });
    return { get, advance: (ms: number) => (t += ms) };
  }

  it("allows up to max per client per window, then 429s with Retry-After", async () => {
    const { get, advance } = setup(2);
    expect((await get("/x", "1.1.1.1")).status).toBe(200);
    expect((await get("/x", "1.1.1.1")).status).toBe(200);
    const blocked = await get("/x", "1.1.1.1");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: { code: "rate_limited" } });
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    advance(10_001);
    expect((await get("/x", "1.1.1.1")).status).toBe(200);
  });

  it("counts clients separately, shares one bucket without a client IP, and honours skip", async () => {
    const { get } = setup(1);
    expect((await get("/x", "1.1.1.1")).status).toBe(200);
    expect((await get("/x", "2.2.2.2")).status).toBe(200);
    expect((await get("/x", "1.1.1.1")).status).toBe(429);
    expect((await get("/x")).status).toBe(200);
    expect((await get("/x")).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await get("/free", "1.1.1.1")).status).toBe(200);
  });
});

describe("public endpoints are rate limited", () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await makeApp({ seed: true, publicRateLimit: { max: 3, windowMs: 60_000 } });
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("throttles invitation lookups and setup attempts, but not the login page config", async () => {
    const ip = { [CLIENT_IP_HEADER]: "9.9.9.9" };
    for (let i = 0; i < 10; i++) {
      expect((await ctx.req("/v1/public/auth-config", { headers: ip })).status).toBe(200);
    }
    for (let i = 0; i < 3; i++) {
      expect((await ctx.req("/v1/public/invitations/not-a-real-token", { headers: ip })).status).toBe(404);
    }
    const blocked = await ctx.req("/v1/public/invitations/not-a-real-token", { headers: ip });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe("rate_limited");
    const setup = await ctx.req("/v1/public/setup", { method: "POST", json: {}, headers: ip });
    expect(setup.status).toBe(429);

    // Other clients are unaffected, and so is the rest of the API.
    const other = await ctx.req("/v1/public/invitations/not-a-real-token", {
      headers: { [CLIENT_IP_HEADER]: "8.8.8.8" },
    });
    expect(other.status).toBe(404);
    expect((await ctx.req("/health")).status).toBe(200);
  });
});
