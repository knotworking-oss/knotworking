import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sortKeyBetween } from "@knotworking/core";
import { makeApp, SETUP_TOKEN, signIn, type TestCtx } from "./test-utils";

type Ctx = TestCtx;

describe("API (seeded workspace)", () => {
  let ctx: Ctx;
  let ada: string; // owner session cookie

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("authentication", () => {
    it("rejects requests without a session", async () => {
      expect((await ctx.req("/v1/me")).status).toBe(401);
      expect((await ctx.req("/v1/workspaces/acme/bootstrap")).status).toBe(401);
    });

    it("signs in with email and password", async () => {
      const res = await ctx.req("/v1/me", { cookie: ada });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.email).toBe("ada@knotworking.dev");
      expect(body.workspaces.map((w: { slug: string }) => w.slug)).toEqual(["acme"]);
    });

    it("rejects a wrong password", async () => {
      expect((await signIn(ctx, "ada@knotworking.dev", "not-the-password")).status).toBe(401);
    });

    it("accepts the session token as a bearer token (desktop/mobile)", async () => {
      const { body } = await signIn(ctx, "marcus@knotworking.dev");
      const res = await ctx.req("/v1/me", { headers: { authorization: `Bearer ${body.token}` } });
      expect(res.status).toBe(200);
      expect((await res.json()).user.email).toBe("marcus@knotworking.dev");
    });

    it("has no public sign-up", async () => {
      const res = await ctx.req("/api/auth/sign-up/email", {
        method: "POST",
        json: { email: "stranger@example.com", password: "a-long-password", name: "Stranger" },
      });
      expect(res.ok).toBe(false);
      expect((await signIn(ctx, "stranger@example.com", "a-long-password")).status).toBe(401);
    });

    it("reports login configuration publicly", async () => {
      const body = await (await ctx.req("/v1/public/auth-config")).json();
      expect(body).toMatchObject({ needsSetup: false, providers: [] });
    });
  });

  describe("workspace data", () => {
    it("hides workspaces the user is not a member of", async () => {
      expect((await ctx.req("/v1/workspaces/nope/bootstrap", { cookie: ada })).status).toBe(404);
    });

    it("bootstraps a workspace snapshot", async () => {
      const body = await (await ctx.req("/v1/workspaces/acme/bootstrap", { cookie: ada })).json();
      expect(body.teams).toHaveLength(3);
      expect(body.tasks.length).toBeGreaterThan(10);
      expect(body.tasks[0]).not.toHaveProperty("description");
      expect(body.documents[0]).not.toHaveProperty("content");
    });

    it("creates, updates and syncs tasks", async () => {
      const boot = await (await ctx.req("/v1/workspaces/acme/bootstrap", { cookie: ada })).json();
      const ops = boot.teams.find((t: { key: string }) => t.key === "OPS");
      const done = boot.workflowStates.find(
        (s: { teamId: string; type: string }) => s.teamId === ops.id && s.type === "completed",
      );
      const finance = boot.labels.find((l: { name: string }) => l.name === "Finance");

      const created = await ctx.req("/v1/workspaces/acme/tasks", {
        method: "POST",
        cookie: ada,
        json: { teamId: ops.id, title: "Test task", priority: 2, labelIds: [finance.id] },
      });
      expect(created.status).toBe(201);
      const task = await created.json();
      expect(task).not.toHaveProperty("identifier");
      expect(task).not.toHaveProperty("number");
      const fetched = await (await ctx.req(`/v1/workspaces/acme/tasks/${task.id}`, { cookie: ada })).json();
      expect(fetched).toMatchObject({ id: task.id, title: "Test task", labelIds: [finance.id] });

      const updated = await (
        await ctx.req(`/v1/workspaces/acme/tasks/${task.id}`, {
          method: "PATCH",
          cookie: ada,
          json: { stateId: done.id, labelIds: [] },
        })
      ).json();
      expect(updated.completedAt).toBeTruthy();
      expect(updated.labelIds).toEqual([]);

      const sync = await (
        await ctx.req(`/v1/workspaces/acme/sync?after=${boot.cursor}`, { cookie: ada })
      ).json();
      const kinds = sync.changes.map((c: { entity: string; action: string }) => `${c.entity}:${c.action}`);
      expect(kinds).toEqual(["task:upsert", "task_label:upsert", "task:upsert", "task_label:delete"]);
    });

    it("moves a task to another state and position (drag and drop)", async () => {
      const boot = await (await ctx.req("/v1/workspaces/acme/bootstrap", { cookie: ada })).json();
      const ops = boot.teams.find((t: { key: string }) => t.key === "OPS");
      const started = boot.workflowStates.find(
        (s: { teamId: string; type: string }) => s.teamId === ops.id && s.type === "started",
      );
      const column = boot.tasks
        .filter((i: { stateId: string }) => i.stateId === started.id)
        .sort((a: { sortOrder: string }, b: { sortOrder: string }) => (a.sortOrder < b.sortOrder ? -1 : 1));
      expect(column.length).toBeGreaterThan(0);
      const task = boot.tasks.find(
        (i: { teamId: string; stateId: string }) => i.teamId === ops.id && i.stateId !== started.id,
      );
      const sortOrder = sortKeyBetween(null, column[0].sortOrder);

      const moved = await (
        await ctx.req(`/v1/workspaces/acme/tasks/${task.id}`, {
          method: "PATCH",
          cookie: ada,
          json: { stateId: started.id, sortOrder },
        })
      ).json();
      expect(moved).toMatchObject({ stateId: started.id, sortOrder });
      expect(moved.startedAt).toBeTruthy();

      const bad = await ctx.req(`/v1/workspaces/acme/tasks/${task.id}`, {
        method: "PATCH",
        cookie: ada,
        json: { sortOrder: "not a key" },
      });
      expect(bad.status).toBe(400);
    });

    it("validates input", async () => {
      const res = await ctx.req("/v1/workspaces/acme/tasks", {
        method: "POST",
        cookie: ada,
        json: { title: "" },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_input");
    });

    it("manages the document tree", async () => {
      const post = (json: unknown) =>
        ctx.req("/v1/workspaces/acme/documents", { method: "POST", cookie: ada, json }).then((r) => r.json());
      const parent = await post({ title: "Parent" });
      const child = await post({ title: "Child", parentId: parent.id });
      const fetched = await (
        await ctx.req(`/v1/workspaces/acme/documents/${child.id}`, { cookie: ada })
      ).json();
      expect(fetched.ancestors.map((a: { title: string }) => a.title)).toEqual(["Parent"]);
      expect(
        (await ctx.req(`/v1/workspaces/acme/documents/${parent.id}`, { method: "DELETE", cookie: ada }))
          .status,
      ).toBe(204);
      expect((await ctx.req(`/v1/workspaces/acme/documents/${child.id}`, { cookie: ada })).status).toBe(404);
    });

    it("reports project progress", async () => {
      const { projects } = await (await ctx.req("/v1/workspaces/acme/projects", { cookie: ada })).json();
      expect(projects.find((p: { name: string }) => p.name === "Customer survey").progress.ratio).toBe(1);
    });
  });

  describe("managed access", () => {
    it("invites someone, who sets a password and signs in", async () => {
      const res = await ctx.req("/v1/workspaces/acme/invitations", {
        method: "POST",
        cookie: ada,
        json: { email: "Grace@Example.com", role: "member" },
      });
      expect(res.status).toBe(201);
      const { url, invitation } = await res.json();
      expect(invitation.email).toBe("grace@example.com");
      expect(ctx.mailer.sent.at(-1)?.text).toContain(url);

      const token = url.split("/invite/")[1];
      const info = await (await ctx.req(`/v1/public/invitations/${token}`)).json();
      expect(info).toMatchObject({
        email: "grace@example.com",
        workspaceName: "Acme Inc",
        existingUser: false,
      });

      const accepted = await ctx.req(`/v1/public/invitations/${token}/accept`, {
        method: "POST",
        json: { name: "Grace Hopper", password: "compilers-rule" },
      });
      expect(accepted.status).toBe(200);
      // Single use.
      expect((await ctx.req(`/v1/public/invitations/${token}`)).status).toBe(404);

      const grace = await signIn(ctx, "grace@example.com", "compilers-rule");
      expect(grace.status).toBe(200);
      const me = await (await ctx.req("/v1/me", { cookie: grace.cookie })).json();
      expect(me.workspaces).toEqual([expect.objectContaining({ slug: "acme", role: "member" })]);

      // Members can't manage access.
      const forbidden = await ctx.req("/v1/workspaces/acme/invitations", {
        method: "POST",
        cookie: grace.cookie,
        json: { email: "someone@example.com" },
      });
      expect(forbidden.status).toBe(403);
    });

    it("deactivates and reactivates a member", async () => {
      const marcus = await signIn(ctx, "marcus@knotworking.dev");
      const { members } = await (await ctx.req("/v1/workspaces/acme/members", { cookie: ada })).json();
      const target = members.find((m: { email: string }) => m.email === "marcus@knotworking.dev");

      const off = await ctx.req(`/v1/workspaces/acme/members/${target.userId}/deactivate`, {
        method: "POST",
        cookie: ada,
      });
      expect(off.status).toBe(200);
      // Signed out everywhere, and can't sign back in.
      expect((await ctx.req("/v1/me", { cookie: marcus.cookie })).status).toBe(401);
      expect((await signIn(ctx, "marcus@knotworking.dev")).status).toBe(403);

      await ctx.req(`/v1/workspaces/acme/members/${target.userId}/reactivate`, {
        method: "POST",
        cookie: ada,
      });
      expect((await signIn(ctx, "marcus@knotworking.dev")).status).toBe(200);
    });

    it("lets admins task a password reset link", async () => {
      const { members } = await (await ctx.req("/v1/workspaces/acme/members", { cookie: ada })).json();
      const priya = members.find((m: { email: string }) => m.email === "priya@knotworking.dev");
      const res = await ctx.req(`/v1/workspaces/acme/members/${priya.userId}/password-reset`, {
        method: "POST",
        cookie: ada,
      });
      const { url } = await res.json();
      expect(url).toContain("/api/auth/reset-password/");

      const token = new URL(url).pathname.split("/").at(-1);
      const reset = await ctx.req("/api/auth/reset-password", {
        method: "POST",
        json: { newPassword: "a-brand-new-password", token },
      });
      expect(reset.status).toBe(200);
      expect((await signIn(ctx, "priya@knotworking.dev")).status).toBe(401);
      expect((await signIn(ctx, "priya@knotworking.dev", "a-brand-new-password")).status).toBe(200);
    });

    it("protects the last owner", async () => {
      const me = await (await ctx.req("/v1/me", { cookie: ada })).json();
      const res = await ctx.req(`/v1/workspaces/acme/members/${me.user.id}`, {
        method: "PATCH",
        cookie: ada,
        json: { role: "admin" },
      });
      expect(res.status).toBe(409);
      const self = await ctx.req(`/v1/workspaces/acme/members/${me.user.id}/deactivate`, {
        method: "POST",
        cookie: ada,
      });
      expect(self.status).toBe(409);
    });
  });
});

describe("first-run setup", () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await makeApp({ seed: false });
  }, 30_000);
  afterAll(() => ctx.handle.close());

  const input = {
    workspaceName: "Lab Team",
    name: "Owner",
    email: "owner@lab.test",
    password: "correct-horse-battery",
  };

  it("requires the one-time setup code from the API log", async () => {
    expect((await (await ctx.req("/v1/public/auth-config")).json()).needsSetup).toBe(true);
    const res = await ctx.req("/v1/public/setup", { method: "POST", json: { ...input, token: "guess" } });
    expect(res.status).toBe(403);
  });

  it("creates the workspace and owner exactly once, even under concurrent attempts", async () => {
    const attempts = await Promise.all(
      [0, 1, 2].map((i) =>
        ctx.req("/v1/public/setup", {
          method: "POST",
          json: { ...input, email: `owner${i}@lab.test`, token: SETUP_TOKEN },
        }),
      ),
    );
    expect(attempts.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const winner = attempts.findIndex((r) => r.status === 201);

    const owner = await signIn(ctx, `owner${winner}@lab.test`, "correct-horse-battery");
    const boot = await (await ctx.req("/v1/workspaces/lab-team/bootstrap", { cookie: owner.cookie })).json();
    expect(boot.teams.map((t: { key: string }) => t.key)).toEqual(["GEN"]);
  });
});

describe("hardening", () => {
  let ctx: Ctx;
  let ada: string;
  let ids: Record<string, string>;
  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req("/v1/workspaces/acme/members", { cookie: ada })).json();
    ids = Object.fromEntries(
      members.map((m: { email: string; userId: string }) => [m.email.split("@")[0], m.userId]),
    );
  }, 60_000);
  afterAll(() => ctx.handle.close());

  const boot = async (cookie = ada) => (await ctx.req("/v1/workspaces/acme/bootstrap", { cookie })).json();

  it("rejects cookie-authenticated writes from other origins", async () => {
    const { teams } = await boot();
    const body = { teamId: teams[0].id, title: "CSRF" };
    const evil = await ctx.req("/v1/workspaces/acme/tasks", {
      method: "POST",
      cookie: ada,
      json: body,
      headers: { origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
    expect((await evil.json()).error.code).toBe("bad_origin");
    // Bearer-token clients (no cookie) aren't browsers and don't send Origin.
    const { body: session } = await signIn(ctx, "ada@knotworking.dev");
    const bearer = await ctx.req("/v1/workspaces/acme/tasks", {
      method: "POST",
      json: body,
      headers: { origin: "", authorization: `Bearer ${session.token}` },
    });
    expect(bearer.status).toBe(201);
  });

  it("includes meetings in the bootstrap snapshot", async () => {
    const b = await boot();
    expect(b.meetings.length).toBeGreaterThan(0);
    expect(b.meetingAttendees.length).toBeGreaterThan(0);
  });

  it("validates references and rejects cycles", async () => {
    const b = await boot();
    const team = b.teams[0];
    const bad = await ctx.req("/v1/workspaces/acme/tasks", {
      method: "POST",
      cookie: ada,
      json: { teamId: team.id, title: "x", assigneeId: "01900000-0000-7000-8000-000000000000" },
    });
    expect(bad.status).toBe(400);

    const task = await (
      await ctx.req("/v1/workspaces/acme/tasks", {
        method: "POST",
        cookie: ada,
        json: { teamId: team.id, title: "Parent" },
      })
    ).json();
    const self = await ctx.req(`/v1/workspaces/acme/tasks/${task.id}`, {
      method: "PATCH",
      cookie: ada,
      json: { parentId: task.id },
    });
    expect(self.status).toBe(400);

    const post = (json: unknown) =>
      ctx.req("/v1/workspaces/acme/documents", { method: "POST", cookie: ada, json }).then((r) => r.json());
    const a = await post({ title: "A" });
    const child = await post({ title: "B", parentId: a.id });
    const cycle = await ctx.req(`/v1/workspaces/acme/documents/${a.id}`, {
      method: "PATCH",
      cookie: ada,
      json: { parentId: child.id },
    });
    expect(cycle.status).toBe(400);
  });

  it("gives guests read-only access without the team's email addresses", async () => {
    const { url } = await (
      await ctx.req("/v1/workspaces/acme/invitations", {
        method: "POST",
        cookie: ada,
        json: { email: "guest@partner.test", role: "guest" },
      })
    ).json();
    await ctx.req(`/v1/public/invitations/${url.split("/invite/")[1]}/accept`, {
      method: "POST",
      json: { name: "Gail Guest", password: "guest-password-1" },
    });
    const guest = (await signIn(ctx, "guest@partner.test", "guest-password-1")).cookie;

    const b = await boot(guest);
    expect(b.tasks.length).toBeGreaterThan(0); // can read
    expect(b.users.every((u: { email: string }) => u.email === "")).toBe(true);
    const members = await (await ctx.req("/v1/workspaces/acme/members", { cookie: guest })).json();
    expect(members.members.every((m: { email: string }) => m.email === "")).toBe(true);

    const doc = b.documents[0];
    expect(
      (await ctx.req(`/v1/workspaces/acme/documents/${doc.id}`, { method: "DELETE", cookie: guest })).status,
    ).toBe(403);
    const create = await ctx.req("/v1/workspaces/acme/tasks", {
      method: "POST",
      cookie: guest,
      json: { teamId: b.teams[0].id, title: "x" },
    });
    expect(create.status).toBe(403);
  });

  it("only lets owners create reset links for admins", async () => {
    await ctx.req(`/v1/workspaces/acme/members/${ids.marcus}`, {
      method: "PATCH",
      cookie: ada,
      json: { role: "admin" },
    });
    await ctx.req(`/v1/workspaces/acme/members/${ids.noor}`, {
      method: "PATCH",
      cookie: ada,
      json: { role: "admin" },
    });
    const marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const reset = (who: string, cookie: string) =>
      ctx.req(`/v1/workspaces/acme/members/${ids[who]}/password-reset`, { method: "POST", cookie });
    expect((await reset("priya", marcus)).status).toBe(200); // admin → member
    expect((await reset("noor", marcus)).status).toBe(403); // admin → admin
    expect((await reset("noor", ada)).status).toBe(200); // owner → admin
  });
});
