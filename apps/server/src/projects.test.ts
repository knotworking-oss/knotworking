import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const base = "/v1/workspaces/acme";

describe("projects", () => {
  let ctx: TestCtx;
  let ada: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  const boot = async (cookie = ada) => (await ctx.req(`${base}/bootstrap`, { cookie })).json();
  const send = (path: string, method: string, json?: unknown, cookie = ada) =>
    ctx.req(`${base}${path}`, { method, cookie, ...(json === undefined ? {} : { json }) });
  const changesAfter = async (cursor: string) =>
    (await (await ctx.req(`${base}/sync?after=${cursor}`, { cookie: ada })).json()).changes as {
      entity: string;
      entityId: string;
      action: string;
    }[];

  it("creates a project with a lead and teams", async () => {
    const b = await boot();
    const res = await send("/projects", "POST", {
      name: "  Rebrand ",
      description: "New look",
      status: "active",
      leadId: b.users[0].id,
      startDate: "2026-01-01",
      targetDate: "2026-03-01",
      teamIds: [b.teams[0].id, b.teams[0].id, b.teams[1].id],
    });
    expect(res.status).toBe(201);
    const project = await res.json();
    expect(project).toMatchObject({ name: "Rebrand", status: "active", leadId: b.users[0].id });
    expect(project.teamIds.sort()).toEqual([b.teams[0].id, b.teams[1].id].sort());
    const after = await boot();
    expect(after.projectTeams.filter((l: { projectId: string }) => l.projectId === project.id)).toHaveLength(
      2,
    );
  });

  it("edits every field, replaces linked teams and records the changes", async () => {
    const b = await boot();
    const [t0, t1, t2] = b.teams;
    const created = await (
      await send("/projects", "POST", { name: "Edit me", teamIds: [t0.id, t1.id] })
    ).json();
    const cursor = (await boot()).cursor;

    const res = await send(`/projects/${created.id}`, "PATCH", {
      name: "Edited",
      description: "Now with words",
      status: "completed",
      health: "at_risk",
      leadId: b.users[1].id,
      startDate: "2026-02-01",
      targetDate: "2026-04-01",
      teamIds: [t1.id, t2.id],
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated).toMatchObject({
      name: "Edited",
      description: "Now with words",
      status: "completed",
      health: "at_risk",
      leadId: b.users[1].id,
      startDate: "2026-02-01",
      targetDate: "2026-04-01",
    });
    expect(updated.completedAt).toBeTruthy();
    expect(updated.teamIds.sort()).toEqual([t1.id, t2.id].sort());

    const changes = await changesAfter(cursor);
    expect(changes.filter((c) => c.entity === "project")).toEqual([
      expect.objectContaining({ entityId: created.id, action: "upsert" }),
    ]);
    const links = changes.filter((c) => c.entity === "project_team");
    expect(links.filter((c) => c.action === "delete")).toHaveLength(1); // t0 unlinked
    expect(links.filter((c) => c.action === "upsert")).toHaveLength(1); // t2 linked

    const after = await boot();
    const live = after.projectTeams.filter((l: { projectId: string }) => l.projectId === created.id);
    expect(live.map((l: { teamId: string }) => l.teamId).sort()).toEqual([t1.id, t2.id].sort());

    // Clearing optional fields, and reopening a completed project, clears its completion time.
    const cleared = await (
      await send(`/projects/${created.id}`, "PATCH", {
        description: null,
        health: null,
        leadId: null,
        targetDate: null,
        status: "active",
        teamIds: [],
      })
    ).json();
    expect(cleared).toMatchObject({
      description: null,
      health: null,
      leadId: null,
      targetDate: null,
      completedAt: null,
      teamIds: [],
    });
    const ids = (await boot()).projects.map((p: { id: string }) => p.id);
    expect(ids).toContain(created.id);
  });

  it("leaves unrelated fields and teams alone on a partial edit", async () => {
    const b = await boot();
    const created = await (
      await send("/projects", "POST", { name: "Partial", description: "Keep", teamIds: [b.teams[0].id] })
    ).json();
    const updated = await (await send(`/projects/${created.id}`, "PATCH", { health: "on_track" })).json();
    expect(updated).toMatchObject({ name: "Partial", description: "Keep", health: "on_track" });
    expect(updated.teamIds).toEqual([b.teams[0].id]);
  });

  it("validates input and references", async () => {
    const b = await boot();
    const created = await (
      await send("/projects", "POST", { name: "Validate", startDate: "2026-05-01" })
    ).json();
    const patch = (json: unknown) => send(`/projects/${created.id}`, "PATCH", json);

    expect((await patch({ name: " " })).status).toBe(400);
    expect((await patch({ status: "nope" })).status).toBe(400);
    expect((await patch({ startDate: "2026-06-01", targetDate: "2026-05-01" })).status).toBe(400);
    // A target date alone is checked against the stored start date.
    const early = await patch({ targetDate: "2026-04-01" });
    expect(early.status).toBe(400);
    expect((await early.json()).error.code).toBe("invalid_input");
    expect((await patch({ leadId: "01900000-0000-7000-8000-000000000000" })).status).toBe(400);
    expect((await patch({ teamIds: ["01900000-0000-7000-8000-000000000000"] })).status).toBe(400);
    expect(
      (await send("/projects", "POST", { name: "x", leadId: "01900000-0000-7000-8000-000000000000" })).status,
    ).toBe(400);
    expect((await patch({ teamIds: [b.teams[0].id], name: "Still fine" })).status).toBe(200);
    expect((await send("/projects/not-a-uuid", "PATCH", { name: "x" })).status).toBe(400);
    expect(
      (await send("/projects/01900000-0000-7000-8000-000000000000", "PATCH", { name: "x" })).status,
    ).toBe(404);
  });

  it("deletes a project, detaching its tasks and docs", async () => {
    const b = await boot();
    const project = await (
      await send("/projects", "POST", { name: "Doomed", teamIds: [b.teams[0].id] })
    ).json();
    const task = await (
      await send("/tasks", "POST", { teamId: b.teams[0].id, title: "Orphan me", projectId: project.id })
    ).json();
    const doc = await (await send("/documents", "POST", { title: "Spec", projectId: project.id })).json();
    const cursor = (await boot()).cursor;

    expect((await send(`/projects/${project.id}`, "DELETE")).status).toBe(204);

    const after = await boot();
    expect(after.projects.some((p: { id: string }) => p.id === project.id)).toBe(false);
    expect(after.projectTeams.some((l: { projectId: string }) => l.projectId === project.id)).toBe(false);
    expect(after.tasks.find((t: { id: string }) => t.id === task.id).projectId).toBeNull();
    expect(after.documents.find((d: { id: string }) => d.id === doc.id).projectId).toBeNull();
    const list = await (await send("/projects", "GET")).json();
    expect(list.projects.some((p: { id: string }) => p.id === project.id)).toBe(false);

    const changes = await changesAfter(cursor);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: "project", entityId: project.id, action: "delete" }),
        expect.objectContaining({ entity: "task", entityId: task.id, action: "upsert" }),
        expect.objectContaining({ entity: "document", entityId: doc.id, action: "upsert" }),
        expect.objectContaining({ entity: "project_team", action: "delete" }),
      ]),
    );

    // Gone for good: further edits and deletes 404, and tasks can't be filed under it.
    expect((await send(`/projects/${project.id}`, "DELETE")).status).toBe(404);
    expect((await send(`/projects/${project.id}`, "PATCH", { name: "Back" })).status).toBe(404);
    expect((await send(`/tasks/${task.id}`, "PATCH", { projectId: project.id })).status).toBe(400);
  });

  it("keeps projects read-only for guests", async () => {
    const { url } = await (
      await send("/invitations", "POST", { email: "guest@partner.test", role: "guest" })
    ).json();
    await ctx.req(`/v1/public/invitations/${url.split("/invite/")[1]}/accept`, {
      method: "POST",
      json: { name: "Gail Guest", password: "guest-password-1" },
    });
    const guest = (await signIn(ctx, "guest@partner.test", "guest-password-1")).cookie;
    const target = (await boot()).projects[0];

    expect((await send("/projects", "POST", { name: "Nope" }, guest)).status).toBe(403);
    expect((await send(`/projects/${target.id}`, "PATCH", { name: "Nope" }, guest)).status).toBe(403);
    expect((await send(`/projects/${target.id}`, "DELETE", undefined, guest)).status).toBe(403);
    expect((await send("/projects", "GET", undefined, guest)).status).toBe(200);
  });
});
