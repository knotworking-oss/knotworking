import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

describe("task comments", () => {
  let ctx: TestCtx;
  let ada: string; // owner
  let marcus: string; // member
  let priya: string; // admin
  let guest: string;
  let taskId: string;

  const base = "/v1/workspaces/acme";
  const missing = "01900000-0000-7000-8000-000000000000";
  const text = (t: string) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
  });
  const post = (cookie: string, body: unknown, id = taskId, extra: object = {}) =>
    ctx.req(`${base}/tasks/${id}/comments`, { method: "POST", cookie, json: { body, ...extra } });
  const patch = (cookie: string, id: string, body: unknown) =>
    ctx.req(`${base}/comments/${id}`, { method: "PATCH", cookie, json: { body } });
  const remove = (cookie: string, id: string) =>
    ctx.req(`${base}/comments/${id}`, { method: "DELETE", cookie });
  const list = async (cookie = ada, id = taskId): Promise<{ id: string }[]> =>
    (await (await ctx.req(`${base}/tasks/${id}/comments`, { cookie })).json()).comments;
  const ids = (comments: { id: string }[]) => comments.map((c) => c.id);

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    priya = (await signIn(ctx, "priya@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${base}/members`, { cookie: ada })).json();
    const priyaId = members.find((m: { email: string }) => m.email === "priya@knotworking.dev").userId;
    await ctx.req(`${base}/members/${priyaId}`, { method: "PATCH", cookie: ada, json: { role: "admin" } });

    const { url } = await (
      await ctx.req(`${base}/invitations`, {
        method: "POST",
        cookie: ada,
        json: { email: "guest@partner.test", role: "guest" },
      })
    ).json();
    await ctx.req(`/v1/public/invitations/${url.split("/invite/")[1]}/accept`, {
      method: "POST",
      json: { name: "Gail Guest", password: "guest-password-1" },
    });
    guest = (await signIn(ctx, "guest@partner.test", "guest-password-1")).cookie;

    const boot = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();
    taskId = boot.tasks[0].id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("creates, lists, edits and deletes comments, all in the sync log", async () => {
    expect(await list()).toEqual([]);
    const { cursor } = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();

    const created = await post(marcus, text("First!"));
    expect(created.status).toBe(201);
    const comment = await created.json();
    expect(comment).toMatchObject({ taskId, documentId: null, parentId: null, editedAt: null });
    expect(comment).not.toHaveProperty("workspaceId");
    expect(comment.authorId).toBeTruthy();
    expect(comment.body).toEqual(text("First!"));

    const second = await (await post(ada, text("Second"))).json();
    expect(ids(await list(priya))).toEqual([comment.id, second.id]); // oldest first

    const edited = await patch(marcus, comment.id, text("First! (edited)"));
    expect(edited.status).toBe(200);
    const after = await edited.json();
    expect(after.body).toEqual(text("First! (edited)"));
    expect(after.editedAt).toBeTruthy();

    expect((await remove(marcus, comment.id)).status).toBe(204);
    expect(ids(await list())).toEqual([second.id]);
    expect((await remove(marcus, comment.id)).status).toBe(404);

    const sync = await (await ctx.req(`${base}/sync?after=${cursor}`, { cookie: ada })).json();
    const kinds = sync.changes.map((c: { entity: string; action: string }) => `${c.entity}:${c.action}`);
    expect(kinds).toEqual(["comment:upsert", "comment:upsert", "comment:upsert", "comment:delete"]);
    expect(sync.changes[0].data.body).toEqual(text("First!"));
  });

  it("lets only authors edit, and authors or admins delete", async () => {
    const mine = await (await post(marcus, text("Mine"))).json();
    // Not even an owner or admin can rewrite someone else's words.
    expect((await patch(ada, mine.id, text("Hijacked"))).status).toBe(403);
    expect((await patch(priya, mine.id, text("Hijacked"))).status).toBe(403);
    expect((await list()).find((c) => c.id === mine.id)).toMatchObject({ body: text("Mine") });

    // A member can't delete a colleague's comment, but admins and owners can.
    const adas = await (await post(ada, text("Ada's"))).json();
    expect((await remove(marcus, adas.id)).status).toBe(403);
    expect((await remove(priya, mine.id)).status).toBe(204);
    expect((await remove(priya, adas.id)).status).toBe(204);
    const again = await (await post(marcus, text("Again"))).json();
    expect((await remove(ada, again.id)).status).toBe(204);
  });

  it("gives guests read-only access", async () => {
    const own = await (await post(ada, text("Readable by guests"))).json();
    expect(ids(await list(guest))).toContain(own.id);
    expect((await post(guest, text("Hi"))).status).toBe(403);
    expect((await patch(guest, own.id, text("x"))).status).toBe(403);
    expect((await remove(guest, own.id)).status).toBe(403);
  });

  it("validates input and references", async () => {
    expect((await post(ada, { type: "doc", content: [] })).status).toBe(400); // empty
    expect((await post(ada, text("   "))).status).toBe(400); // blank
    expect((await post(ada, { type: "nope" })).status).toBe(400); // not a doc
    expect((await post(ada, text("x".repeat(20_001)))).status).toBe(400); // too long
    expect(
      (await ctx.req(`${base}/tasks/${taskId}/comments`, { method: "POST", cookie: ada, json: {} })).status,
    ).toBe(400);
    expect((await post(ada, text("x"), missing)).status).toBe(404);
    expect((await ctx.req(`${base}/tasks/${missing}/comments`, { cookie: ada })).status).toBe(404);
    expect((await patch(ada, missing, text("x"))).status).toBe(404);
    expect((await post(ada, text("x"), taskId, { parentId: missing })).status).toBe(400);
    const own = await (await post(ada, text("keep"))).json();
    expect((await patch(ada, own.id, { type: "doc", content: [] })).status).toBe(400);
  });

  it("threads replies and deletes them with their parent", async () => {
    const boot = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();
    const otherTask = boot.tasks[1].id;
    const parent = await (await post(ada, text("Question?"), otherTask)).json();
    const reply = await (await post(marcus, text("Answer."), otherTask, { parentId: parent.id })).json();
    expect(reply.parentId).toBe(parent.id);
    // A reply must belong to the same task as its parent.
    expect((await post(ada, text("Wrong task"), taskId, { parentId: parent.id })).status).toBe(400);

    const { cursor } = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();
    expect((await remove(ada, parent.id)).status).toBe(204);
    expect(await list(ada, otherTask)).toEqual([]);
    const sync = await (await ctx.req(`${base}/sync?after=${cursor}`, { cookie: ada })).json();
    expect(sync.changes.map((c: { entityId: string }) => c.entityId).sort()).toEqual(
      [parent.id, reply.id].sort(),
    );
  });

  it("hides comments of deleted tasks and of other workspaces", async () => {
    const boot = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();
    const doomed = await (
      await ctx.req(`${base}/tasks`, {
        method: "POST",
        cookie: ada,
        json: { teamId: boot.teams[0].id, title: "Doomed" },
      })
    ).json();
    await post(ada, text("Bye"), doomed.id);
    await ctx.req(`${base}/tasks/${doomed.id}`, { method: "DELETE", cookie: ada });
    expect((await ctx.req(`${base}/tasks/${doomed.id}/comments`, { cookie: ada })).status).toBe(404);
    expect((await ctx.req(`/v1/workspaces/other/tasks/${taskId}/comments`, { cookie: ada })).status).toBe(
      404,
    );
  });
});
