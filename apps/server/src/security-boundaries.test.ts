import { moduleIds } from "@knotworking/core";
import { addWorkspaceMember, apiTokens, workspaces } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAssistantToken, revokeAllApiTokens } from "./services/api-tokens";
import { setModuleAccess } from "./services/module-access";
import { MAX_JSON_BYTES, MAX_PUBLIC_JSON_BYTES } from "./middleware/body-limit";
import { makeApp, signIn, type TestCtx } from "./test-utils";

async function expectStreamToEnd(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ended = (async () => {
      while (!(await reader.read()).done) {}
      return true;
    })();
    expect(
      await Promise.race([
        ended,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 3000);
        }),
      ]),
    ).toBe(true);
  } finally {
    clearTimeout(timer);
    await reader.cancel();
  }
}

describe("security boundaries", () => {
  let ctx: TestCtx;
  let owner: string;
  let member: string;
  let ownerId: string;
  let memberId: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, streamRevalidateMs: 100 });
    owner = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    member = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const boot = await (await ctx.req("/v1/workspaces/acme/bootstrap", { cookie: owner })).json();
    ownerId = boot.users.find((u: { email: string }) => u.email === "ada@knotworking.dev").id;
    memberId = boot.users.find((u: { email: string }) => u.email === "marcus@knotworking.dev").id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("bounds unauthenticated JSON, including streamed bodies without Content-Length", async () => {
    for (const path of ["/api/auth/sign-in/email", "/v1/public/setup"]) {
      const res = await ctx.req(path, {
        method: "POST",
        json: { unused: "x".repeat(MAX_PUBLIC_JSON_BYTES) },
      });
      expect(res.status).toBe(413);
      expect((await res.json()).error.code).toBe("body_too_large");
    }
    const res = await ctx.req("/v1/workspaces/acme/documents", {
      method: "POST",
      cookie: owner,
      json: { unused: "x".repeat(MAX_JSON_BYTES) },
    });
    expect(res.status).toBe(413);
  });

  it("does not let a workspace owner reset an account belonging to another workspace", async () => {
    const [other] = await ctx.handle.db
      .insert(workspaces)
      .values({ slug: "other", name: "Other" })
      .returning();
    await addWorkspaceMember(ctx.handle.db, other!.id, memberId, "owner");
    await addWorkspaceMember(ctx.handle.db, other!.id, ownerId, "member");
    const res = await ctx.req(`/v1/workspaces/other/members/${ownerId}/password-reset`, {
      method: "POST",
      cookie: member,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("shared_account_reset");
  });

  it("revokes a turn's temporary assistant token with the member's other tokens", async () => {
    const turn = await createAssistantToken(ctx.handle.db, memberId, "write");
    const headers = { authorization: `Bearer ${turn.token}`, origin: "" };
    expect((await ctx.req("/v1/workspaces/acme/tasks", { headers })).status).toBe(200);
    await revokeAllApiTokens(ctx.handle.db, memberId);
    expect((await ctx.req("/v1/workspaces/acme/tasks", { headers })).status).toBe(401);
  });

  it("stops accepting an assistant token once it expires", async () => {
    const turn = await createAssistantToken(ctx.handle.db, memberId, "read");
    const headers = { authorization: `Bearer ${turn.token}`, origin: "" };
    expect((await ctx.req("/v1/workspaces/acme/tasks", { headers })).status).toBe(200);
    await ctx.handle.db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiTokens.id, turn.id));
    expect((await ctx.req("/v1/workspaces/acme/tasks", { headers })).status).toBe(401);
  });

  it("does not show one member's module access to other members or guests through the sync log", async () => {
    const { members } = await (await ctx.req("/v1/workspaces/acme/members", { cookie: owner })).json();
    const target = members.find((m: { email: string }) => m.email === "priya@knotworking.dev");
    await setModuleAccess(
      ctx.handle.db,
      (await ctx.handle.db.select().from(workspaces).where(eq(workspaces.slug, "acme")))[0]!.id,
      ownerId,
      [...moduleIds],
      { userId: target.userId, moduleId: "people" },
      "manage",
    );
    const guestInvite = await (
      await ctx.req("/v1/workspaces/acme/invitations", {
        method: "POST",
        cookie: owner,
        json: { email: "sync-guest@partner.test", role: "guest" },
      })
    ).json();
    await ctx.req(`/v1/public/invitations/${guestInvite.url.split("/invite/")[1]}/accept`, {
      method: "POST",
      json: { name: "Sync Guest", password: "guest-password-1" },
    });
    const guest = (await signIn(ctx, "sync-guest@partner.test", "guest-password-1")).cookie;
    const accessRows = async (cookie: string) =>
      (
        (await (await ctx.req("/v1/workspaces/acme/sync?after=0&limit=500", { cookie })).json()).changes as {
          entity: string;
          data: { userId: string } | null;
        }[]
      ).filter((c) => c.entity === "module_access");

    // Admins see every grant; a guest and an ordinary member see none that belong to someone else.
    const ownerRows = await accessRows(owner);
    expect(ownerRows.some((c) => c.data?.userId === target.userId)).toBe(true);
    expect((await accessRows(guest)).length).toBe(0);
    const priya = (await signIn(ctx, "priya@knotworking.dev")).cookie;
    const own = await accessRows(priya);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((c) => c.data?.userId === target.userId)).toBe(true);
  });

  it("closes a private assistant stream after module access is removed", async () => {
    const me = await (await ctx.req("/v1/me", { cookie: member })).json();
    const workspaceId = me.workspaces.find((w: { slug: string }) => w.slug === "acme").id;
    await setModuleAccess(
      ctx.handle.db,
      workspaceId,
      ownerId,
      moduleIds,
      { userId: memberId, moduleId: "assistant" },
      "read",
    );
    const res = await ctx.req("/v1/workspaces/acme/assistant/stream", { cookie: member });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    await setModuleAccess(
      ctx.handle.db,
      workspaceId,
      ownerId,
      moduleIds,
      { userId: memberId, moduleId: "assistant" },
      "none",
    );
    await expectStreamToEnd(reader);
  });

  it("closes a private assistant stream after its session signs out", async () => {
    const signedIn = await signIn(ctx, "marcus@knotworking.dev");
    const me = await (await ctx.req("/v1/me", { cookie: signedIn.cookie })).json();
    const workspaceId = me.workspaces.find((w: { slug: string }) => w.slug === "acme").id;
    await setModuleAccess(
      ctx.handle.db,
      workspaceId,
      ownerId,
      moduleIds,
      { userId: memberId, moduleId: "assistant" },
      "read",
    );
    const res = await ctx.req("/v1/workspaces/acme/assistant/stream", { cookie: signedIn.cookie });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    expect(
      (await ctx.req("/api/auth/sign-out", { method: "POST", cookie: signedIn.cookie, json: {} })).status,
    ).toBe(200);
    await expectStreamToEnd(reader);
  });
});
