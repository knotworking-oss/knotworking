import { documents, projects, syncChanges, teams, workspaces } from "@knotworking/db";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("document updates: optimistic concurrency (expectedUpdatedAt)", () => {
  let ctx: TestCtx;
  let ada: string;

  const db = () => ctx.handle.db;
  const create = async (title: string) => {
    const res = await ctx.req(`${WS}/documents`, { method: "POST", cookie: ada, json: { title } });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; updatedAt: string };
  };
  const fetchDoc = async (id: string) => (await ctx.req(`${WS}/documents/${id}`, { cookie: ada })).json();
  const patch = (id: string, json: Record<string, unknown>) =>
    ctx.req(`${WS}/documents/${id}`, { method: "PATCH", cookie: ada, json });
  const syncRows = async (id: string) =>
    (
      await db()
        .select({ n: count() })
        .from(syncChanges)
        .where(and(eq(syncChanges.entity, "document"), eq(syncChanges.entityId, id)))
    )[0]!.n;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("applies an update whose expectedUpdatedAt matches what GET returned", async () => {
    const created = await create("Plan");
    const seen = (await fetchDoc(created.id)).updatedAt as string;
    const res = await patch(created.id, { title: "Plan v2", expectedUpdatedAt: seen });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.title).toBe("Plan v2");
    expect(updated).not.toHaveProperty("expectedUpdatedAt");
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(seen).getTime());
    // Chaining: the returned updatedAt is the next precondition.
    const next = await patch(created.id, { title: "Plan v3", expectedUpdatedAt: updated.updatedAt });
    expect(next.status).toBe(200);
    expect((await fetchDoc(created.id)).title).toBe("Plan v3");
  });

  it("rejects a stale expectedUpdatedAt with 409 document_conflict and writes nothing", async () => {
    const created = await create("Shared");
    const seen = (await fetchDoc(created.id)).updatedAt as string;
    // Someone else edits first.
    expect((await patch(created.id, { title: "Theirs" })).status).toBe(200);
    const before = await db().select().from(documents).where(eq(documents.id, created.id));
    const syncBefore = await syncRows(created.id);

    const res = await patch(created.id, { title: "Mine", expectedUpdatedAt: seen });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("document_conflict");
    expect(body.error.message).toMatch(/changed/i);

    expect((await fetchDoc(created.id)).title).toBe("Theirs");
    const after = await db().select().from(documents).where(eq(documents.id, created.id));
    expect(after).toEqual(before); // no column touched, including updatedAt and lastEditedById
    expect(await syncRows(created.id)).toBe(syncBefore);
  });

  it("a stale editor's body save is refused and the 409 carries the current document", async () => {
    const text = (t: string) => ({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
    });
    const created = await create("Body race");
    const seen = (await fetchDoc(created.id)).updatedAt as string;
    // Another writer (a person, or an agent through the MCP server) saves first.
    const theirs = await patch(created.id, { content: text("their paragraph"), expectedUpdatedAt: seen });
    expect(theirs.status).toBe(200);
    const stored = await theirs.json();

    const mine = await patch(created.id, { content: text("my typing"), expectedUpdatedAt: seen });
    expect(mine.status).toBe(409);
    const { error } = await mine.json();
    expect(error.code).toBe("document_conflict");
    expect(error.details.current).toMatchObject({
      id: created.id,
      title: "Body race",
      content: text("their paragraph"),
      updatedAt: stored.updatedAt,
    });
    expect(error.details.current).not.toHaveProperty("workspaceId");
    expect((await fetchDoc(created.id)).content).toEqual(text("their paragraph"));

    // Rebasing on what the 409 returned lets the next attempt through.
    const retry = await patch(created.id, {
      content: text("their paragraph + mine"),
      expectedUpdatedAt: error.details.current.updatedAt,
    });
    expect(retry.status).toBe(200);
  });

  it("a rapid chain of guarded saves from one editor never conflicts", async () => {
    const created = await create("Typing");
    let seen = (await fetchDoc(created.id)).updatedAt as string;
    for (let i = 0; i < 10; i++) {
      const res = await patch(created.id, { title: `Typing ${i}`, expectedUpdatedAt: seen });
      expect(res.status, `save ${i}`).toBe(200);
      seen = (await res.json()).updatedAt;
    }
    expect((await fetchDoc(created.id)).title).toBe("Typing 9");
  });

  it("compares instants, not strings", async () => {
    const created = await create("Zones");
    const seen = new Date((await fetchDoc(created.id)).updatedAt as string);
    // The same instant written with a different offset still matches.
    const pad = (n: number) => String(n).padStart(2, "0");
    const shifted = new Date(seen.getTime() + 2 * 3_600_000);
    const withOffset =
      `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
      `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
      `.${String(shifted.getUTCMilliseconds()).padStart(3, "0")}+02:00`;
    expect(new Date(withOffset).getTime()).toBe(seen.getTime());
    expect(withOffset).not.toBe(seen.toISOString());
    const ok = await patch(created.id, { title: "Zones 2", expectedUpdatedAt: withOffset });
    expect(ok.status).toBe(200);
    // One millisecond off is a different instant.
    const off = new Date((await fetchDoc(created.id)).updatedAt as string).getTime() + 1;
    const miss = await patch(created.id, {
      title: "Zones 3",
      expectedUpdatedAt: new Date(off).toISOString(),
    });
    expect(miss.status).toBe(409);
  });

  it("behaves exactly as before when expectedUpdatedAt is absent", async () => {
    const created = await create("Free-for-all");
    const syncBefore = await syncRows(created.id);
    for (const title of ["a", "b", "c"]) expect((await patch(created.id, { title })).status).toBe(200);
    expect((await fetchDoc(created.id)).title).toBe("c");
    expect(await syncRows(created.id)).toBe(syncBefore + 3);
  });

  it("records one sync change for a successful guarded write", async () => {
    const created = await create("Synced");
    const seen = (await fetchDoc(created.id)).updatedAt as string;
    const syncBefore = await syncRows(created.id);
    expect((await patch(created.id, { title: "Synced 2", expectedUpdatedAt: seen })).status).toBe(200);
    expect(await syncRows(created.id)).toBe(syncBefore + 1);
  });

  it("lets exactly one of two concurrent writers holding the same value win", async () => {
    const created = await create("Race");
    const seen = (await fetchDoc(created.id)).updatedAt as string;
    const syncBefore = await syncRows(created.id);
    const results = await Promise.all([
      patch(created.id, { title: "Writer A", expectedUpdatedAt: seen }),
      patch(created.id, { title: "Writer B", expectedUpdatedAt: seen }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.findIndex((r) => r.status === 200);
    const loser = results[1 - winner]!;
    expect((await loser.json()).error.code).toBe("document_conflict");
    expect((await fetchDoc(created.id)).title).toBe(winner === 0 ? "Writer A" : "Writer B");
    expect(await syncRows(created.id)).toBe(syncBefore + 1);
  });

  it("still reports a missing or deleted document as 404, even with a precondition", async () => {
    const iso = new Date().toISOString();
    const missing = await patch("00000000-0000-7000-8000-000000000000", {
      title: "x",
      expectedUpdatedAt: iso,
    });
    expect(missing.status).toBe(404);
    const created = await create("Gone");
    await ctx.req(`${WS}/documents/${created.id}`, { method: "DELETE", cookie: ada });
    const gone = await patch(created.id, { title: "x", expectedUpdatedAt: created.updatedAt });
    expect(gone.status).toBe(404);
  });

  it("validates expectedUpdatedAt as an ISO datetime", async () => {
    const created = await create("Validation");
    for (const bad of ["yesterday", "2026-01-01", 12345, ""]) {
      const res = await patch(created.id, { title: "x", expectedUpdatedAt: bad });
      expect(res.status, String(bad)).toBe(400);
    }
  });
});

/**
 * Characterization of what a client that sends NO precondition gets (the web editor before item 20, and
 * MCP `update_document` with `content`): the whole body is last-write-wins.
 */
describe("document updates: unconditional writes are last-write-wins (characterization)", () => {
  let ctx: TestCtx;
  let ada: string;
  const text = (t: string) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
  });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("a stale editor silently overwrites a newer body", async () => {
    const created = await (
      await ctx.req(`${WS}/documents`, {
        method: "POST",
        cookie: ada,
        json: { title: "Doc", content: text("v1") },
      })
    ).json();
    // Two editors both loaded v1. B (a person or an agent) saves first.
    const theirs = await ctx.req(`${WS}/documents/${created.id}`, {
      method: "PATCH",
      cookie: ada,
      json: { content: text("v1 + their paragraph") },
    });
    expect(theirs.status).toBe(200);
    // A autosaves from the stale copy: accepted, and B's work is gone.
    const mine = await ctx.req(`${WS}/documents/${created.id}`, {
      method: "PATCH",
      cookie: ada,
      json: { content: text("v1 + my typing") },
    });
    expect(mine.status).toBe(200);
    const final = await (await ctx.req(`${WS}/documents/${created.id}`, { cookie: ada })).json();
    expect(final.content).toEqual(text("v1 + my typing"));
  });
});

describe("documents with tables", () => {
  let ctx: TestCtx;
  let ada: string;
  const table = (rows: string[][]) => ({
    type: "table",
    content: rows.map((cells, r) => ({
      type: "tableRow",
      content: cells.map((text) => ({
        type: r === 0 ? "tableHeader" : "tableCell",
        attrs: { colspan: 1, rowspan: 1, colwidth: null },
        content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
      })),
    })),
  });
  const create = (content: unknown) =>
    ctx.req(`${WS}/documents`, { method: "POST", cookie: ada, json: { title: "Table doc", content } });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("stores and returns table content unchanged", async () => {
    const content = {
      type: "doc",
      content: [
        table([
          ["Name", "Status"],
          ["Login", ""],
        ]),
      ],
    };
    const created = await create(content);
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const fetched = await (await ctx.req(`${WS}/documents/${id}`, { cookie: ada })).json();
    expect(fetched.content).toEqual(content);
  });

  it("accepts a large table without hitting a size limit", async () => {
    const rows = Array.from({ length: 150 }, (_, r) => Array.from({ length: 12 }, (_, c) => `r${r}c${c}`));
    expect((await create({ type: "doc", content: [table(rows)] })).status).toBe(201);
  });

  it("rejects malformed tables with 400", async () => {
    for (const bad of [
      { type: "table", content: [] },
      { type: "table", content: [{ type: "paragraph" }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [] }] }] },
    ]) {
      const res = await create({ type: "doc", content: [bad] });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe("documents attached to a team or project", () => {
  let ctx: TestCtx;
  let ada: string;
  let guest: string;
  let team: { id: string };
  let otherTeam: { id: string };
  let project: { id: string };
  let foreign: { teamId: string; projectId: string };

  const db = () => ctx.handle.db;
  const post = (json: Record<string, unknown>, cookie = ada) =>
    ctx.req(`${WS}/documents`, { method: "POST", cookie, json });
  const patch = (id: string, json: Record<string, unknown>, cookie = ada) =>
    ctx.req(`${WS}/documents/${id}`, { method: "PATCH", cookie, json });
  const send = (path: string, method: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie: ada, ...(json === undefined ? {} : { json }) });
  const boot = async () => (await ctx.req(`${WS}/bootstrap`, { cookie: ada })).json();
  const row = async (id: string) => (await db().select().from(documents).where(eq(documents.id, id)))[0]!;
  const changesAfter = async (cursor: string) =>
    (await (await ctx.req(`${WS}/sync?after=${cursor}`, { cookie: ada })).json()).changes as {
      entity: string;
      entityId: string;
      action: string;
      data: any;
    }[];
  const unknownId = "01900000-0000-7000-8000-000000000000";

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { url } = await (
      await send("/invitations", "POST", { email: "guest@partner.test", role: "guest" })
    ).json();
    await ctx.req(`/v1/public/invitations/${url.split("/invite/")[1]}/accept`, {
      method: "POST",
      json: { name: "Gail Guest", password: "guest-password-1" },
    });
    guest = (await signIn(ctx, "guest@partner.test", "guest-password-1")).cookie;

    team = (await boot()).teams[0];
    otherTeam = await (await send("/teams", "POST", { key: "DOCS", name: "Docs team" })).json();
    project = await (await send("/projects", "POST", { name: "Handbook" })).json();

    // A second workspace with its own team and project.
    const [ws] = await db().insert(workspaces).values({ slug: "other", name: "Other" }).returning();
    const [t] = await db()
      .insert(teams)
      .values({ workspaceId: ws!.id, key: "OTH", name: "Other team" })
      .returning();
    const [p] = await db()
      .insert(projects)
      .values({ workspaceId: ws!.id, name: "Other project", sortOrder: "a0" })
      .returning();
    foreign = { teamId: t!.id, projectId: p!.id };
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("creates a doc already attached to a team and a project", async () => {
    const cursor = (await boot()).cursor;
    const res = await post({ title: "Runbook", teamId: team.id, projectId: project.id });
    expect(res.status).toBe(201);
    const doc = await res.json();
    expect(doc).toMatchObject({ teamId: team.id, projectId: project.id });
    const b = await boot();
    expect(b.documents.find((d: { id: string }) => d.id === doc.id)).toMatchObject({
      teamId: team.id,
      projectId: project.id,
    });
    expect(await changesAfter(cursor)).toEqual([
      expect.objectContaining({
        entity: "document",
        entityId: doc.id,
        action: "upsert",
        data: expect.objectContaining({ teamId: team.id, projectId: project.id }),
      }),
    ]);
  });

  it("leaves a plain doc unattached", async () => {
    const doc = await (await post({ title: "Loose" })).json();
    expect(doc).toMatchObject({ teamId: null, projectId: null });
  });

  it("attaches, moves and clears (null) an existing doc, logging each change", async () => {
    const doc = await (await post({ title: "Movable" })).json();

    let cursor = (await boot()).cursor;
    let res = await patch(doc.id, { teamId: team.id, projectId: project.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ teamId: team.id, projectId: project.id });
    expect(await changesAfter(cursor)).toEqual([
      expect.objectContaining({
        entity: "document",
        entityId: doc.id,
        action: "upsert",
        data: expect.objectContaining({ teamId: team.id, projectId: project.id }),
      }),
    ]);

    // Moving one side leaves the other alone.
    res = await patch(doc.id, { teamId: otherTeam.id });
    expect(await res.json()).toMatchObject({ teamId: otherTeam.id, projectId: project.id });

    // A patch that doesn't mention them keeps them.
    res = await patch(doc.id, { title: "Movable 2" });
    expect(await res.json()).toMatchObject({ teamId: otherTeam.id, projectId: project.id });

    // null clears, one side at a time.
    cursor = (await boot()).cursor;
    res = await patch(doc.id, { projectId: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ teamId: otherTeam.id, projectId: null });
    res = await patch(doc.id, { teamId: null });
    expect(await res.json()).toMatchObject({ teamId: null, projectId: null });
    const log = await changesAfter(cursor);
    expect(log).toHaveLength(2);
    expect(log.at(-1)).toMatchObject({
      entity: "document",
      entityId: doc.id,
      action: "upsert",
      data: expect.objectContaining({ teamId: null, projectId: null }),
    });
    expect(await row(doc.id)).toMatchObject({ teamId: null, projectId: null });
  });

  it("rejects teams and projects that are unknown, from another workspace, or not UUIDs", async () => {
    const doc = await (await post({ title: "Guarded", teamId: team.id })).json();
    const cursor = (await boot()).cursor;

    for (const bad of [
      { teamId: foreign.teamId },
      { projectId: foreign.projectId },
      { teamId: unknownId },
      { projectId: unknownId },
      { teamId: "nope" },
      { projectId: 5 },
      { teamId: "" },
    ]) {
      expect((await post({ title: "Rejected doc", ...bad })).status, JSON.stringify(bad)).toBe(400);
      expect((await patch(doc.id, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    // Nothing was written, and the doc kept its team.
    expect(await changesAfter(cursor)).toEqual([]);
    expect(await row(doc.id)).toMatchObject({ teamId: team.id, projectId: null });
    const titles = (await db().select({ title: documents.title }).from(documents)).map((d) => d.title);
    expect(titles).not.toContain("Rejected doc");
  });

  it("rejects a deleted project and an archived team", async () => {
    const gone = await (await send("/projects", "POST", { name: "Gone soon" })).json();
    expect((await send(`/projects/${gone.id}`, "DELETE")).status).toBe(204);
    const shelved = await (await send("/teams", "POST", { key: "SHLV", name: "Shelved" })).json();
    expect((await send(`/teams/${shelved.id}`, "PATCH", { archived: true })).status).toBe(200);

    expect((await post({ title: "x", projectId: gone.id })).status).toBe(400);
    expect((await post({ title: "x", teamId: shelved.id })).status).toBe(400);
    const doc = await (await post({ title: "Fine" })).json();
    expect((await patch(doc.id, { projectId: gone.id })).status).toBe(400);
    expect((await patch(doc.id, { teamId: shelved.id })).status).toBe(400);
  });

  it("is writer-only: guests can't attach or detach", async () => {
    const doc = await (await post({ title: "Read-only", teamId: team.id })).json();
    expect((await post({ title: "x", teamId: team.id }, guest)).status).toBe(403);
    expect((await patch(doc.id, { teamId: null }, guest)).status).toBe(403);
    expect(await row(doc.id)).toMatchObject({ teamId: team.id });
  });

  it("keeps docs when their project is deleted, clearing the link in the sync log", async () => {
    const doomed = await (await send("/projects", "POST", { name: "Doomed" })).json();
    const doc = await (await post({ title: "Survivor", projectId: doomed.id, teamId: team.id })).json();
    const child = await (await post({ title: "Child", parentId: doc.id })).json();
    const cursor = (await boot()).cursor;

    expect((await send(`/projects/${doomed.id}`, "DELETE")).status).toBe(204);

    expect(await row(doc.id)).toMatchObject({ projectId: null, teamId: team.id, deletedAt: null });
    expect(await row(child.id)).toMatchObject({ deletedAt: null });
    const b = await boot();
    expect(b.documents.find((d: { id: string }) => d.id === doc.id)).toMatchObject({
      projectId: null,
      teamId: team.id,
    });
    const changes = await changesAfter(cursor);
    expect(changes).toContainEqual(
      expect.objectContaining({
        entity: "document",
        entityId: doc.id,
        action: "upsert",
        data: expect.objectContaining({ projectId: null, teamId: team.id }),
      }),
    );
    // Only the attached doc is touched.
    expect(changes.filter((c) => c.entity === "document").map((c) => c.entityId)).toEqual([doc.id]);
  });

  it("keeps docs of an archived team attached, so restoring the team restores the link", async () => {
    const shelf = await (await send("/teams", "POST", { key: "ARCH", name: "Archivable" })).json();
    const doc = await (await post({ title: "Team notes", teamId: shelf.id })).json();

    expect((await send(`/teams/${shelf.id}`, "PATCH", { archived: true })).status).toBe(200);
    // The doc is still there and still listed; only the team is hidden.
    expect(await row(doc.id)).toMatchObject({ teamId: shelf.id, deletedAt: null });
    const b = await boot();
    expect(b.teams.some((t: { id: string }) => t.id === shelf.id)).toBe(false);
    expect(b.documents.find((d: { id: string }) => d.id === doc.id)).toMatchObject({ teamId: shelf.id });
    // It can still be edited.
    expect((await patch(doc.id, { title: "Team notes 2" })).status).toBe(200);

    expect((await send(`/teams/${shelf.id}`, "PATCH", { archived: false })).status).toBe(200);
    const back = await boot();
    expect(back.teams.some((t: { id: string }) => t.id === shelf.id)).toBe(true);
    expect(back.documents.find((d: { id: string }) => d.id === doc.id)).toMatchObject({ teamId: shelf.id });
  });
});
