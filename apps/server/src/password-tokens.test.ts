import { apiTokens } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_PASSWORD, makeApp, signIn, type TestCtx } from "./test-utils";

/** A password reset or change must also kill the user's personal API tokens. */
describe("API tokens and password changes", () => {
  let ctx: TestCtx;
  let ada: string;

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const status = async (token: string) => (await ctx.req("/v1/me", { headers: bearer(token) })).status;
  const mint = async (cookie: string, name: string) => {
    const res = await ctx.req("/v1/me/api-tokens", {
      method: "POST",
      cookie,
      json: { name, scope: "write" },
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { token: string; apiToken: { id: string } };
  };
  const row = async (id: string) =>
    (await ctx.handle.db.select().from(apiTokens).where(eq(apiTokens.id, id)))[0]!;
  const resetLink = async (userEmail: string) => {
    const { members } = await (await ctx.req("/v1/workspaces/acme/members", { cookie: ada })).json();
    const target = members.find((m: { email: string }) => m.email === userEmail);
    const res = await ctx.req(`/v1/workspaces/acme/members/${target.userId}/password-reset`, {
      method: "POST",
      cookie: ada,
    });
    expect(res.status).toBe(200);
    // The link comes from Better Auth's sendResetPassword, captured by `captureResetLink`.
    return new URL((await res.json()).url).pathname.split("/").at(-1)!;
  };

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("revokes all of a user's live tokens when a password reset completes", async () => {
    const priya = (await signIn(ctx, "priya@knotworking.dev")).cookie;
    const a = await mint(priya, "one");
    const b = await mint(priya, "two");
    const already = await mint(priya, "already revoked");
    await ctx.req(`/v1/me/api-tokens/${already.apiToken.id}`, { method: "DELETE", cookie: priya });
    const revokedAt = (await row(already.apiToken.id)).revokedAt!;
    const other = await mint(ada, "someone else's");
    expect(await status(a.token)).toBe(200);

    const token = await resetLink("priya@knotworking.dev");
    // Requesting a link, or presenting a bad token, changes nothing.
    const bad = await ctx.req("/api/auth/reset-password", {
      method: "POST",
      json: { newPassword: "a-brand-new-password", token: "not-a-real-token" },
    });
    expect(bad.status).toBe(400);
    expect(await status(a.token)).toBe(200);

    const reset = await ctx.req("/api/auth/reset-password", {
      method: "POST",
      json: { newPassword: "a-brand-new-password", token },
    });
    expect(reset.status).toBe(200);

    for (const t of [a, b]) {
      expect(await status(t.token)).toBe(401);
      expect((await row(t.apiToken.id)).revokedAt).toBeInstanceOf(Date);
    }
    // Already revoked tokens keep their original timestamp; other users' tokens are untouched.
    expect((await row(already.apiToken.id)).revokedAt).toEqual(revokedAt);
    expect((await row(other.apiToken.id)).revokedAt).toBeNull();
    expect(await status(other.token)).toBe(200);
    // The new password works, so the user can mint fresh tokens.
    const fresh = await signIn(ctx, "priya@knotworking.dev", "a-brand-new-password");
    expect(fresh.status).toBe(200);
    expect(await status((await mint(fresh.cookie, "fresh")).token)).toBe(200);
  });

  it("revokes all of a user's live tokens when the password is changed", async () => {
    const marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const a = await mint(marcus, "one");
    const b = await mint(marcus, "two");
    const other = await mint(ada, "someone else's");

    // A wrong current password is refused and revokes nothing.
    const wrong = await ctx.req("/api/auth/change-password", {
      method: "POST",
      cookie: marcus,
      json: { currentPassword: "not-my-password", newPassword: "another-new-password" },
    });
    expect(wrong.status).toBe(400);
    expect(await status(a.token)).toBe(200);

    const changed = await ctx.req("/api/auth/change-password", {
      method: "POST",
      cookie: marcus,
      json: { currentPassword: DEMO_PASSWORD, newPassword: "another-new-password" },
    });
    expect(changed.status).toBe(200);

    for (const t of [a, b]) {
      expect(await status(t.token)).toBe(401);
      expect((await row(t.apiToken.id)).revokedAt).toBeInstanceOf(Date);
    }
    expect(await status(other.token)).toBe(200);
    expect((await signIn(ctx, "marcus@knotworking.dev", "another-new-password")).status).toBe(200);
  });

  it("also revokes when the change signs out other sessions", async () => {
    const user = await signIn(ctx, "priya@knotworking.dev", "a-brand-new-password");
    const t = await mint(user.cookie, "one");
    const changed = await ctx.req("/api/auth/change-password", {
      method: "POST",
      cookie: user.cookie,
      json: {
        currentPassword: "a-brand-new-password",
        newPassword: "third-new-password",
        revokeOtherSessions: true,
      },
    });
    expect(changed.status).toBe(200);
    expect(await status(t.token)).toBe(401);
    expect((await row(t.apiToken.id)).revokedAt).toBeInstanceOf(Date);
  });
});
