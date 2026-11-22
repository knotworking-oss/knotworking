import { apiTokens, createPasswordUser, syncChanges, users } from "@knotworking/db";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "./services/api-tokens";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("personal API tokens", () => {
  let ctx: TestCtx;
  let ada: string; // owner (session cookie)
  let marcus: string; // member (session cookie)
  let marcusId: string;
  let teamId: string;

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (path: string, token: string) => ctx.req(path, { headers: bearer(token) });
  const mint = async (cookie: string, json: Record<string, unknown>) => {
    const res = await ctx.req("/v1/me/api-tokens", { method: "POST", cookie, json });
    expect(res.status).toBe(201);
    return (await res.json()) as { token: string; apiToken: Record<string, any> };
  };
  const syncCount = async () => (await ctx.handle.db.select({ n: count() }).from(syncChanges))[0]!.n;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const boot = await (await ctx.req(`${WS}/bootstrap`, { cookie: ada })).json();
    teamId = boot.teams[0].id;
    marcusId = boot.users.find((u: { email: string }) => u.email === "marcus@knotworking.dev").id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("management", () => {
    it("creates a token, returning the plaintext exactly once", async () => {
      const before = await syncCount();
      const { token, apiToken } = await mint(ada, { name: "Claude desktop", scope: "read" });

      expect(token).toMatch(/^knw_[A-Za-z0-9_-]{43}$/); // 32 bytes of base64url
      expect(apiToken).toMatchObject({
        name: "Claude desktop",
        scope: "read",
        prefix: token.slice(0, 8),
        lastUsedAt: null,
      });
      // No expiresInDays: defaults to 90 days rather than never expiring.
      const days = (new Date(apiToken.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89.9);
      expect(days).toBeLessThan(90.1);
      expect(apiToken.id).toBeTruthy();
      expect(apiToken.createdAt).toBeTruthy();
      expect(apiToken).not.toHaveProperty("tokenHash");

      const list = await ctx.req("/v1/me/api-tokens", { cookie: ada });
      expect(list.status).toBe(200);
      const text = JSON.stringify(await list.json());
      expect(text).not.toContain(token);
      expect(text).not.toContain("tokenHash");
      expect(text).not.toContain("token_hash");

      // Only the hash is stored.
      const [row] = await ctx.handle.db.select().from(apiTokens).where(eq(apiTokens.id, apiToken.id));
      expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row!.tokenHash).not.toContain(token);

      // Per-user data: nothing reaches the workspace sync log.
      expect(await syncCount()).toBe(before);
    });

    it("sets an expiry from expiresInDays", async () => {
      const { apiToken } = await mint(ada, { name: "Short-lived", scope: "write", expiresInDays: 7 });
      const days = (new Date(apiToken.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThanOrEqual(7);
    });

    it("validates the body", async () => {
      for (const json of [
        {},
        { name: "", scope: "read" },
        { name: "x".repeat(81), scope: "read" },
        { name: "ok", scope: "admin" },
        { name: "ok", scope: "read", expiresInDays: 0 },
        { name: "ok", scope: "read", expiresInDays: 366 },
        { name: "ok", scope: "read", expiresInDays: 1.5 },
      ]) {
        const res = await ctx.req("/v1/me/api-tokens", { method: "POST", cookie: ada, json });
        expect(res.status).toBe(400);
      }
    });

    it("requires a sign-in", async () => {
      expect((await ctx.req("/v1/me/api-tokens")).status).toBe(401);
      const res = await ctx.req("/v1/me/api-tokens", { method: "POST", json: { name: "x", scope: "read" } });
      expect(res.status).toBe(401);
    });

    it("lists only your own live tokens, and revokes only your own", async () => {
      const mine = await mint(ada, { name: "Ada's", scope: "read" });
      const his = await mint(marcus, { name: "Marcus's", scope: "read" });

      const adaList = (await (await ctx.req("/v1/me/api-tokens", { cookie: ada })).json()).apiTokens;
      expect(adaList.map((t: { id: string }) => t.id)).toContain(mine.apiToken.id);
      expect(adaList.map((t: { id: string }) => t.id)).not.toContain(his.apiToken.id);

      // Someone else's token looks like it doesn't exist, and keeps working.
      const stolen = await ctx.req(`/v1/me/api-tokens/${his.apiToken.id}`, { method: "DELETE", cookie: ada });
      expect(stolen.status).toBe(404);
      expect((await get("/v1/me", his.token)).status).toBe(200);

      const revoked = await ctx.req(`/v1/me/api-tokens/${mine.apiToken.id}`, {
        method: "DELETE",
        cookie: ada,
      });
      expect(revoked.status).toBe(204);
      expect((await get("/v1/me", mine.token)).status).toBe(401);
      const after = (await (await ctx.req("/v1/me/api-tokens", { cookie: ada })).json()).apiTokens;
      expect(after.map((t: { id: string }) => t.id)).not.toContain(mine.apiToken.id);

      expect(
        (await ctx.req(`/v1/me/api-tokens/${mine.apiToken.id}`, { method: "DELETE", cookie: ada })).status,
      ).toBe(404);
      expect((await ctx.req("/v1/me/api-tokens/not-a-uuid", { method: "DELETE", cookie: ada })).status).toBe(
        400,
      );
    });

    it("can't be managed with an API token, only a real session", async () => {
      for (const scope of ["read", "write"] as const) {
        const { token } = await mint(ada, { name: `try ${scope}`, scope });
        const list = await get("/v1/me/api-tokens", token);
        expect(list.status).toBe(403);
        expect((await list.json()).error.code).toBe("session_required");
      }
      const { token, apiToken } = await mint(ada, { name: "writer", scope: "write" });
      const create = await ctx.req("/v1/me/api-tokens", {
        method: "POST",
        headers: bearer(token),
        json: { name: "minted by a token", scope: "write" },
      });
      expect(create.status).toBe(403);
      expect((await create.json()).error.code).toBe("session_required");
      const revoke = await ctx.req(`/v1/me/api-tokens/${apiToken.id}`, {
        method: "DELETE",
        headers: bearer(token),
      });
      expect(revoke.status).toBe(403);
      expect((await revoke.json()).error.code).toBe("session_required");
      // The same session-bearer path that desktop apps use still manages tokens.
      const sessionToken = (await signIn(ctx, "ada@knotworking.dev")).body.token as string;
      const viaBearer = await get("/v1/me/api-tokens", sessionToken);
      expect(viaBearer.status).toBe(200);
    });

    it("a read-only token gets token_read_only before anything else on writes", async () => {
      const { token } = await mint(ada, { name: "ro", scope: "read" });
      const res = await ctx.req("/v1/me/api-tokens", {
        method: "POST",
        headers: bearer(token),
        json: { name: "x", scope: "read" },
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("token_read_only");
    });
  });

  describe("authentication", () => {
    it("lets a token read workspace data as its owner", async () => {
      const { token } = await mint(ada, { name: "reader", scope: "read" });
      const me = await get("/v1/me", token);
      expect(me.status).toBe(200);
      expect((await me.json()).user.email).toBe("ada@knotworking.dev");
      const boot = await get(`${WS}/bootstrap`, token);
      expect(boot.status).toBe(200);
      expect((await boot.json()).tasks.length).toBeGreaterThan(0);
      expect((await get(`${WS}/sync?after=0`, token)).status).toBe(200);
      expect((await get(`${WS}/events`, token)).status).toBe(200);
    });

    it("blocks every write for a read token", async () => {
      const { token } = await mint(ada, { name: "reader", scope: "read" });
      const before = await syncCount();
      for (const [method, path] of [
        ["POST", `${WS}/tasks`],
        ["PATCH", `${WS}/tasks/00000000-0000-7000-8000-000000000000`],
        ["DELETE", `${WS}/tasks/00000000-0000-7000-8000-000000000000`],
        ["PUT", `${WS}/notifications/preferences`],
        ["POST", `${WS}/notifications/read-all`],
      ] as const) {
        const res = await ctx.req(path, { method, headers: bearer(token), json: { teamId, title: "nope" } });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect((await res.json()).error.code).toBe("token_read_only");
      }
      expect(await syncCount()).toBe(before);
    });

    it("lets a write token create a task as its owner", async () => {
      const { token } = await mint(ada, { name: "agent", scope: "write" });
      const res = await ctx.req(`${WS}/tasks`, {
        method: "POST",
        headers: bearer(token),
        json: { teamId, title: "Created by an agent" },
      });
      expect(res.status).toBe(201);
      const task = await res.json();
      expect(task.title).toBe("Created by an agent");
      const boot = await (await ctx.req(`${WS}/bootstrap`, { cookie: ada })).json();
      const me = await (await ctx.req("/v1/me", { cookie: ada })).json();
      expect(boot.tasks.find((t: { id: string }) => t.id === task.id).creatorId).toBe(me.user.id);
    });

    it("still applies the owner's workspace role to a write token", async () => {
      const { token } = await mint(marcus, { name: "marcus agent", scope: "write" });
      // Members can write...
      const ok = await ctx.req(`${WS}/tasks`, {
        method: "POST",
        headers: bearer(token),
        json: { teamId, title: "From Marcus" },
      });
      expect(ok.status).toBe(201);
      // ...but once demoted to guest the same token is read-only (requireWriter).
      const demote = await ctx.req(`${WS}/members/${marcusId}`, {
        method: "PATCH",
        cookie: ada,
        json: { role: "guest" },
      });
      expect(demote.status).toBe(200);
      const denied = await ctx.req(`${WS}/tasks`, {
        method: "POST",
        headers: bearer(token),
        json: { teamId, title: "Nope" },
      });
      expect(denied.status).toBe(403);
      expect((await denied.json()).error.code).toBe("read_only");
      await ctx.req(`${WS}/members/${marcusId}`, { method: "PATCH", cookie: ada, json: { role: "member" } });
    });

    it("rejects unknown, malformed and revoked tokens with 401", async () => {
      const { token, apiToken } = await mint(ada, { name: "soon revoked", scope: "write" });
      expect((await get("/v1/me", token)).status).toBe(200);
      await ctx.req(`/v1/me/api-tokens/${apiToken.id}`, { method: "DELETE", cookie: ada });
      for (const bad of [token, "knw_" + "A".repeat(43), "knw_", "knw_short"]) {
        const res = await get("/v1/me", bad);
        expect(res.status).toBe(401);
        expect((await res.json()).error.code).toBe("unauthenticated");
      }
    });

    it("rejects expired tokens", async () => {
      const { token, apiToken } = await mint(ada, { name: "expiring", scope: "read", expiresInDays: 1 });
      expect((await get("/v1/me", token)).status).toBe(200);
      await ctx.handle.db
        .update(apiTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(apiTokens.id, apiToken.id));
      const res = await get("/v1/me", token);
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("unauthenticated");
    });

    it("records last use at most every few minutes", async () => {
      const { token, apiToken } = await mint(ada, { name: "usage", scope: "read" });
      const lastUsed = async () =>
        (await ctx.handle.db.select().from(apiTokens).where(eq(apiTokens.id, apiToken.id)))[0]!.lastUsedAt;
      expect(await lastUsed()).toBeNull();

      await get("/v1/me", token);
      const first = await lastUsed();
      expect(first).toBeInstanceOf(Date);
      await get("/v1/me", token);
      expect(await lastUsed()).toEqual(first); // throttled: no write per request

      const old = new Date(Date.now() - 10 * 60_000);
      await ctx.handle.db.update(apiTokens).set({ lastUsedAt: old }).where(eq(apiTokens.id, apiToken.id));
      await get("/v1/me", token);
      expect((await lastUsed())!.getTime()).toBeGreaterThan(old.getTime() + 9 * 60_000);

      const list = (await (await ctx.req("/v1/me/api-tokens", { cookie: ada })).json()).apiTokens;
      expect(list.find((t: { id: string }) => t.id === apiToken.id).lastUsedAt).toBeTruthy();
    });

    it("needs no CSRF origin, since bearer clients send no cookie", async () => {
      const { token } = await mint(ada, { name: "no origin", scope: "write" });
      const res = await ctx.req(`${WS}/tasks`, {
        method: "POST",
        headers: { ...bearer(token), origin: "" },
        json: { teamId, title: "No Origin header" },
      });
      expect(res.status).toBe(201);
    });

    it("is not accepted as a Better Auth session", async () => {
      const { token } = await mint(ada, { name: "auth", scope: "write" });
      const session = await ctx.req("/api/auth/get-session", { headers: bearer(token) });
      expect(session.status).toBe(403);
      expect((await session.json()).error.code).toBe("token_not_allowed");
      const out = await ctx.req("/api/auth/sign-out", { method: "POST", headers: bearer(token), json: {} });
      expect(out.status).toBe(403);
      // Better Auth's own session bearer still works through requireSession.
      const sessionToken = (await signIn(ctx, "ada@knotworking.dev")).body.token as string;
      expect(sessionToken).not.toMatch(/^knw_/);
      expect((await get("/v1/me", sessionToken)).status).toBe(200);
    });
  });

  describe("restricted routes", () => {
    it("keeps tokens off admin routes, even for an owner", async () => {
      const { token } = await mint(ada, { name: "admin try", scope: "write" });
      const members = (await (await ctx.req(`${WS}/members`, { cookie: ada })).json()).members;
      const target = members.find((m: { email: string }) => m.email === "priya@knotworking.dev");
      const attempts: [string, string, unknown?][] = [
        ["GET", `${WS}/invitations`],
        ["POST", `${WS}/invitations`, { email: "new@example.com", role: "member" }],
        ["POST", `${WS}/members/${target.userId}/password-reset`],
        ["POST", `${WS}/members/${target.userId}/deactivate`],
        ["PATCH", `${WS}/members/${target.userId}`, { role: "admin" }],
        ["POST", `${WS}/teams`, { key: "TOK", name: "Token team" }],
        ["POST", `${WS}/labels`, { name: "tok", color: "blue" }],
      ];
      for (const [method, path, json] of attempts) {
        const res = await ctx.req(path, { method, headers: bearer(token), ...(json ? { json } : {}) });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect((await res.json()).error.code, `${method} ${path}`).toBe("token_not_allowed");
      }
      // The same owner with a session can.
      expect((await ctx.req(`${WS}/invitations`, { cookie: ada })).status).toBe(200);
    });

    it("keeps tokens away from personal calendar data", async () => {
      const read = await mint(ada, { name: "cal read", scope: "read" });
      const write = await mint(ada, { name: "cal write", scope: "write" });
      const day = "from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z";
      const cases: [string, string, string, unknown?][] = [
        ["GET", "/v1/calendar/connections", "token_not_allowed"],
        ["POST", "/v1/calendar/connections/activate", "token_not_allowed", { provider: "google" }],
        ["DELETE", "/v1/calendar/connections/00000000-0000-7000-8000-000000000000", "token_not_allowed"],
        ["GET", `${WS}/calendar?${day}`, "token_not_allowed"],
        [
          "POST",
          `${WS}/meetings/import`,
          "token_not_allowed",
          { calendarEventId: "00000000-0000-7000-8000-000000000000" },
        ],
      ];
      for (const [method, path, code, json] of cases) {
        const res = await ctx.req(path, { method, headers: bearer(write.token), ...(json ? { json } : {}) });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect((await res.json()).error.code).toBe(code);
      }
      for (const path of ["/v1/calendar/connections", `${WS}/calendar?${day}`]) {
        const res = await get(path, read.token);
        expect(res.status, path).toBe(403);
        expect((await res.json()).error.code).toBe("token_not_allowed");
      }
      // A session still sees its calendar.
      expect((await ctx.req("/v1/calendar/connections", { cookie: ada })).status).toBe(200);
      expect((await ctx.req(`${WS}/calendar?${day}`, { cookie: ada })).status).toBe(200);
      // Meeting writes go out through the owner's external calendar, so tokens can't make them.
      const meeting = "00000000-0000-7000-8000-000000000000";
      const writes: [string, string, unknown?][] = [
        [
          "POST",
          `${WS}/meetings`,
          { title: "x", startsAt: "2026-06-01T10:00:00.000Z", endsAt: "2026-06-01T11:00:00.000Z" },
        ],
        ["PATCH", `${WS}/meetings/${meeting}`, { title: "y" }],
        ["POST", `${WS}/meetings/${meeting}/cancel`],
        ["POST", `${WS}/meetings/${meeting}/notes`],
      ];
      for (const [method, path, json] of writes) {
        const res = await ctx.req(path, { method, headers: bearer(write.token), ...(json ? { json } : {}) });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect((await res.json()).error.code).toBe("token_not_allowed");
      }
      // Workspace meetings stay readable (they are workspace data, not personal events).
      expect((await get(`${WS}/meetings/00000000-0000-7000-8000-000000000000`, read.token)).status).toBe(404);
    });
  });

  describe("access removal", () => {
    it("deletes a user's tokens with the user", async () => {
      const user = await createPasswordUser(ctx.handle.db, {
        email: "temp@knotworking.dev",
        name: "Temp",
        password: "knotworking-demo",
      });
      const { apiToken } = await createApiToken(ctx.handle.db, user.id, { name: "temp", scope: "read" });
      await ctx.handle.db.delete(users).where(eq(users.id, user.id));
      const rows = await ctx.handle.db.select().from(apiTokens).where(eq(apiTokens.id, apiToken.id));
      expect(rows).toHaveLength(0);
    });

    it("rejects a deactivated member's token, and accepts it again once reactivated", async () => {
      const { token } = await mint(marcus, { name: "marcus", scope: "write" });
      expect((await get("/v1/me", token)).status).toBe(200);

      const off = await ctx.req(`${WS}/members/${marcusId}/deactivate`, { method: "POST", cookie: ada });
      expect(off.status).toBe(200);
      const res = await get("/v1/me", token);
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("unauthenticated");
      expect((await get(`${WS}/bootstrap`, token)).status).toBe(401);

      const on = await ctx.req(`${WS}/members/${marcusId}/reactivate`, { method: "POST", cookie: ada });
      expect(on.status).toBe(200);
      expect((await get("/v1/me", token)).status).toBe(200);
    });
  });
});
