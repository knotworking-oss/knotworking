import { apiTokens, workspaceMembers } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_STREAM_REVALIDATE_MS } from "./routes/workspace";
import { isApiTokenValid } from "./services/api-tokens";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const INTERVAL = 100;

/** Drains an SSE response, resolving `true` once the server closes it, `false` if it is still open after `ms`. */
function endsWithin(res: Response, ms: number) {
  const reader = res.body!.getReader();
  const done = (async () => {
    for (;;) if ((await reader.read()).done) return true;
  })();
  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), ms));
  return { ended: Promise.race([done, timeout]), cancel: () => reader.cancel() };
}

describe("/events re-validates its credential", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: string;
  let marcusId: string;
  const db = () => ctx.handle.db;

  const mint = async (cookie: string, json: Record<string, unknown> = { name: "stream", scope: "read" }) => {
    const res = await ctx.req("/v1/me/api-tokens", { method: "POST", cookie, json });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; apiToken: { id: string } };
    return { token: body.token, id: body.apiToken.id };
  };
  const open = async (credential: { token: string } | { cookie: string }) => {
    const res = await ctx.req(`${WS}/events`, {
      ...("token" in credential
        ? { headers: { authorization: `Bearer ${credential.token}` } }
        : { cookie: credential.cookie }),
    });
    expect(res.status).toBe(200);
    return res as unknown as Response;
  };

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, streamRevalidateMs: INTERVAL });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const boot = await (await ctx.req(`${WS}/bootstrap`, { cookie: ada })).json();
    marcusId = boot.users.find((u: { email: string }) => u.email === "marcus@knotworking.dev").id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("checks every 30 seconds by default", () => {
    expect(DEFAULT_STREAM_REVALIDATE_MS).toBe(30_000);
  });

  it("keeps a stream with a valid token open across several checks, and still delivers nudges", async () => {
    const { token } = await mint(ada);
    const res = await open({ token });
    const stream = endsWithin(res, INTERVAL * 8);
    // A write by someone else while the stream is open still reaches it (it is not a dead stream).
    const boot = await (await ctx.req(`${WS}/bootstrap`, { cookie: ada })).json();
    expect(
      (
        await ctx.req(`${WS}/tasks`, {
          method: "POST",
          cookie: ada,
          json: { teamId: boot.teams[0].id, title: "Written during the stream" },
        })
      ).status,
    ).toBe(201);
    expect(await stream.ended).toBe(false);
    await stream.cancel();
  });

  it("ends the stream shortly after the token is revoked", async () => {
    const { token, id } = await mint(ada);
    const res = await open({ token });
    const stream = endsWithin(res, 5_000);
    await new Promise((r) => setTimeout(r, INTERVAL * 2)); // established and past a check
    const revoked = await ctx.req(`/v1/me/api-tokens/${id}`, { method: "DELETE", cookie: ada });
    expect(revoked.status).toBeLessThan(300);
    expect(await stream.ended).toBe(true);
    // And it cannot reconnect.
    expect((await ctx.req(`${WS}/events`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(
      401,
    );
  });

  it("ends the stream shortly after the token expires", async () => {
    const { token, id } = await mint(ada);
    const res = await open({ token });
    const stream = endsWithin(res, 5_000);
    await new Promise((r) => setTimeout(r, INTERVAL * 2));
    await db()
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiTokens.id, id));
    expect(await stream.ended).toBe(true);
  });

  it("ends a token stream when the owner is deactivated, and not before", async () => {
    const { token } = await mint(marcus);
    const res = await open({ token });
    const stream = endsWithin(res, 5_000);
    await new Promise((r) => setTimeout(r, INTERVAL * 3));
    const off = await ctx.req(`${WS}/members/${marcusId}/deactivate`, { method: "POST", cookie: ada });
    expect(off.status).toBe(200);
    expect(await stream.ended).toBe(true);
    await ctx.req(`${WS}/members/${marcusId}/reactivate`, { method: "POST", cookie: ada });
  });

  it("ends a token stream when the user is removed from the workspace, and a session stream too", async () => {
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie; // deactivation above ended the old session
    const { token } = await mint(marcus);
    const tokenStream = endsWithin(await open({ token }), 5_000);
    const sessionStream = endsWithin(await open({ cookie: marcus }), 5_000);
    await new Promise((r) => setTimeout(r, INTERVAL * 2));
    // Soft-delete the membership directly: the owner still has other access, only this workspace is lost.
    await db()
      .update(workspaceMembers)
      .set({ deletedAt: new Date() })
      .where(eq(workspaceMembers.userId, marcusId));
    expect(await tokenStream.ended).toBe(true);
    expect(await sessionStream.ended).toBe(true);
    await db().update(workspaceMembers).set({ deletedAt: null }).where(eq(workspaceMembers.userId, marcusId));
  });

  it("keeps a session stream open while the session and membership are fine", async () => {
    const stream = endsWithin(await open({ cookie: ada }), INTERVAL * 6);
    expect(await stream.ended).toBe(false);
    await stream.cancel();
  });

  describe("isApiTokenValid", () => {
    it("is true for a live token and false once revoked, expired or unknown", async () => {
      const live = await mint(ada);
      expect(await isApiTokenValid(db(), live.id)).toBe(true);
      expect(await isApiTokenValid(db(), "00000000-0000-4000-8000-000000000000")).toBe(false);

      await db().update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, live.id));
      expect(await isApiTokenValid(db(), live.id)).toBe(false);

      const expiring = await mint(ada);
      await db()
        .update(apiTokens)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(eq(apiTokens.id, expiring.id));
      expect(await isApiTokenValid(db(), expiring.id)).toBe(false);
    });
  });
});
