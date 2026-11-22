import { timeEntries } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

describe("time tracking", () => {
  let ctx: TestCtx;
  let ada: string; // owner
  let marcus: string; // member
  let priya: string; // admin
  let guest: string;
  let adaId: string;
  let marcusId: string;
  let teamId: string;
  let taskId: string;
  let otherTaskId: string;

  const base = "/v1/workspaces/acme";
  const missing = "01900000-0000-7000-8000-000000000000";
  const log = (cookie: string, json: object, id = taskId) =>
    ctx.req(`${base}/tasks/${id}/time-entries`, { method: "POST", cookie, json });
  const patch = (cookie: string, id: string, json: object) =>
    ctx.req(`${base}/time-entries/${id}`, { method: "PATCH", cookie, json });
  const remove = (cookie: string, id: string) =>
    ctx.req(`${base}/time-entries/${id}`, { method: "DELETE", cookie });
  const start = (cookie: string, id = taskId, json: object = {}) =>
    ctx.req(`${base}/tasks/${id}/timer`, { method: "POST", cookie, json });
  const stop = (cookie: string) => ctx.req(`${base}/timer/stop`, { method: "POST", cookie });
  const list = async (cookie = ada, id = taskId) =>
    (await ctx.req(`${base}/tasks/${id}/time-entries`, { cookie })).json();
  const cursor = async () => (await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json()).cursor;
  const changesSince = async (after: string) =>
    (await (await ctx.req(`${base}/sync?after=${after}`, { cookie: ada })).json()).changes as {
      entity: string;
      entityId: string;
      action: string;
      data: Record<string, unknown> | null;
    }[];

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    priya = (await signIn(ctx, "priya@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${base}/members`, { cookie: ada })).json();
    const idOf = (email: string) => members.find((m: { email: string }) => m.email === email).userId;
    adaId = idOf("ada@knotworking.dev");
    marcusId = idOf("marcus@knotworking.dev");
    await ctx.req(`${base}/members/${idOf("priya@knotworking.dev")}`, {
      method: "PATCH",
      cookie: ada,
      json: { role: "admin" },
    });
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
    teamId = boot.teams[0].id;
    const create = async (title: string) =>
      (
        await (
          await ctx.req(`${base}/tasks`, { method: "POST", cookie: ada, json: { teamId, title } })
        ).json()
      ).id as string;
    taskId = await create("Time tracked");
    otherTaskId = await create("Also time tracked");
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("sets a time estimate on tasks", async () => {
    const res = await ctx.req(`${base}/tasks/${taskId}`, {
      method: "PATCH",
      cookie: ada,
      json: { estimateMinutes: 240 },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estimateMinutes: 240 });
    const tooBig = await ctx.req(`${base}/tasks/${taskId}`, {
      method: "PATCH",
      cookie: ada,
      json: { estimateMinutes: 1000 * 60 + 1 },
    });
    expect(tooBig.status).toBe(400);
    const zero = await ctx.req(`${base}/tasks/${taskId}`, {
      method: "PATCH",
      cookie: ada,
      json: { estimateMinutes: 0 },
    });
    expect(zero.status).toBe(400);
  });

  it("logs, lists, edits and deletes entries, all in the sync log", async () => {
    const after = await cursor();
    const created = await log(marcus, { minutes: 90, note: "Pairing", entryDate: "2026-11-02" });
    expect(created.status).toBe(201);
    const entry = await created.json();
    expect(entry).toMatchObject({
      taskId,
      userId: marcusId,
      minutes: 90,
      note: "Pairing",
      entryDate: "2026-11-02",
      startedAt: null,
    });
    expect(entry).not.toHaveProperty("workspaceId");

    const second = await (await log(ada, { minutes: 30 })).json();
    expect(second.entryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/); // defaults to today

    const listed = await list(priya);
    expect(listed.entries.map((e: { id: string }) => e.id)).toEqual([second.id, entry.id]); // newest day first
    expect(listed.totals).toEqual({
      loggedMinutes: 120,
      estimateMinutes: 240,
      users: [
        { userId: marcusId, minutes: 90 },
        { userId: adaId, minutes: 30 },
      ],
    });

    const edited = await patch(marcus, entry.id, { minutes: 75, note: "" });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ minutes: 75, note: null });

    expect((await remove(marcus, entry.id)).status).toBe(204);
    expect((await remove(marcus, entry.id)).status).toBe(404);
    expect((await list()).totals.loggedMinutes).toBe(30);

    const changes = await changesSince(after);
    expect(changes.map((c) => `${c.entity}:${c.action}`)).toEqual([
      "time_entry:upsert",
      "time_entry:upsert",
      "time_entry:upsert",
      "time_entry:delete",
    ]);
    expect(changes[0]!.data).toMatchObject({ id: entry.id, minutes: 90 });
    expect(changes[2]!.data).toMatchObject({ id: entry.id, minutes: 75 });

    // The bootstrap carries live entries, so clients can total them.
    const boot = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();
    const ids = boot.timeEntries.map((e: { id: string }) => e.id);
    expect(ids).toContain(second.id);
    expect(ids).not.toContain(entry.id);
    await remove(ada, second.id);
  });

  it("lets members change only their own time; admins and owners anyone's", async () => {
    const adas = await (await log(ada, { minutes: 10 })).json();
    expect((await patch(marcus, adas.id, { minutes: 20 })).status).toBe(403);
    expect((await remove(marcus, adas.id)).status).toBe(403);

    const marcuss = await (await log(marcus, { minutes: 15 })).json();
    expect((await patch(priya, marcuss.id, { minutes: 25 })).status).toBe(200);
    expect((await patch(ada, marcuss.id, { note: "Checked" })).status).toBe(200);
    expect((await remove(priya, marcuss.id)).status).toBe(204);
    expect((await remove(ada, adas.id)).status).toBe(204);
  });

  it("lets only admins log time for someone else", async () => {
    expect((await log(marcus, { minutes: 5, userId: adaId })).status).toBe(403);
    const forMarcus = await log(priya, { minutes: 5, userId: marcusId });
    expect(forMarcus.status).toBe(201);
    const entry = await forMarcus.json();
    expect(entry.userId).toBe(marcusId);
    // …and they can't log for someone outside the workspace.
    expect((await log(priya, { minutes: 5, userId: missing })).status).toBe(400);
    await remove(priya, entry.id);
  });

  it("gives guests read-only access", async () => {
    const entry = await (await log(ada, { minutes: 45 })).json();
    expect((await list(guest)).entries.map((e: { id: string }) => e.id)).toContain(entry.id);
    expect((await log(guest, { minutes: 5 })).status).toBe(403);
    expect((await patch(guest, entry.id, { minutes: 5 })).status).toBe(403);
    expect((await remove(guest, entry.id)).status).toBe(403);
    expect((await start(guest)).status).toBe(403);
    expect((await stop(guest)).status).toBe(403);
    await remove(ada, entry.id);
  });

  it("validates input and references", async () => {
    expect((await log(ada, {})).status).toBe(400);
    expect((await log(ada, { minutes: 0 })).status).toBe(400);
    expect((await log(ada, { minutes: -5 })).status).toBe(400);
    expect((await log(ada, { minutes: 1.5 })).status).toBe(400);
    expect((await log(ada, { minutes: 24 * 60 + 1 })).status).toBe(400);
    expect((await log(ada, { minutes: 5, entryDate: "yesterday" })).status).toBe(400);
    expect((await log(ada, { minutes: 5, note: "x".repeat(501) })).status).toBe(400);
    expect((await log(ada, { minutes: 5 }, missing)).status).toBe(404);
    expect((await ctx.req(`${base}/tasks/${missing}/time-entries`, { cookie: ada })).status).toBe(404);
    expect((await patch(ada, missing, { minutes: 5 })).status).toBe(404);
    const entry = await (await log(ada, { minutes: 5 })).json();
    expect((await patch(ada, entry.id, {})).status).toBe(400);
    await remove(ada, entry.id);
  });

  it("keeps one running timer per user: starting another stops the first", async () => {
    const after = await cursor();
    const first = await start(marcus, taskId, { note: "Deep work" });
    expect(first.status).toBe(201);
    const { entry: running, stopped: none } = await first.json();
    expect(none).toBeNull();
    expect(running).toMatchObject({ taskId, userId: marcusId, minutes: null, note: "Deep work" });
    expect(running.startedAt).toBeTruthy();

    // A running timer doesn't count towards totals yet, and its duration can't be edited.
    expect((await list()).totals.loggedMinutes).toBe(0);
    expect((await patch(marcus, running.id, { minutes: 10 })).status).toBe(400);
    expect((await patch(marcus, running.id, { note: "Deeper work" })).status).toBe(200);

    // Pretend it has run for 25 minutes.
    await ctx.handle.db
      .update(timeEntries)
      .set({ startedAt: new Date(Date.now() - 25 * 60_000) })
      .where(eq(timeEntries.id, running.id));

    const second = await (await start(marcus, otherTaskId)).json();
    expect(second.stopped).toMatchObject({ id: running.id, minutes: 25 });
    expect(second.entry).toMatchObject({ taskId: otherTaskId, minutes: null });

    // Someone else's timer is independent.
    const adas = await (await start(ada, otherTaskId)).json();
    expect(adas.stopped).toBeNull();

    const open = await ctx.handle.db.select().from(timeEntries);
    const runningFor = (userId: string) =>
      open.filter((e) => e.userId === userId && e.minutes === null && e.deletedAt === null);
    expect(runningFor(marcusId).map((e) => e.id)).toEqual([second.entry.id]);
    expect(runningFor(adaId)).toHaveLength(1);

    const stopped = await stop(marcus);
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ id: second.entry.id, minutes: 1 }); // at least a minute
    expect((await stop(marcus)).status).toBe(404); // nothing running any more
    expect((await stop(ada)).status).toBe(200);

    const changes = await changesSince(after);
    expect(changes.every((c) => c.entity === "time_entry" && c.action === "upsert")).toBe(true);
    // start, note edit, (stop + start), start, stop, stop
    expect(changes).toHaveLength(7);
    expect(changes.find((c) => c.entityId === running.id && c.data?.minutes === 25)).toBeTruthy();
  });

  it("caps a forgotten timer at 24 hours", async () => {
    const { entry } = await (await start(marcus)).json();
    await ctx.handle.db
      .update(timeEntries)
      .set({ startedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000) })
      .where(eq(timeEntries.id, entry.id));
    expect((await (await stop(marcus)).json()).minutes).toBe(24 * 60);
    await remove(marcus, entry.id);
  });

  it("the database refuses a second running timer even without the service", async () => {
    const { entry } = await (await start(marcus)).json();
    const [row] = await ctx.handle.db.select().from(timeEntries).where(eq(timeEntries.id, entry.id));
    await expect(
      ctx.handle.db.insert(timeEntries).values({
        workspaceId: row!.workspaceId,
        taskId,
        userId: marcusId,
        entryDate: "2026-11-09",
        startedAt: new Date(),
      }),
    ).rejects.toThrow();
    await stop(marcus);
  });

  it("totals a project's time per task and per person", async () => {
    const project = await (
      await ctx.req(`${base}/projects`, { method: "POST", cookie: ada, json: { name: "Billable" } })
    ).json();
    for (const id of [taskId, otherTaskId]) {
      await ctx.req(`${base}/tasks/${id}`, {
        method: "PATCH",
        cookie: ada,
        json: { projectId: project.id },
      });
    }
    await ctx.req(`${base}/tasks/${otherTaskId}`, {
      method: "PATCH",
      cookie: ada,
      json: { estimateMinutes: 60 },
    });

    const before = await (await ctx.req(`${base}/projects/${project.id}/time`, { cookie: guest })).json();
    await log(ada, { minutes: 30 }, taskId);
    await log(marcus, { minutes: 50 }, otherTaskId);
    await start(ada, taskId); // running: not counted

    const totals = await (await ctx.req(`${base}/projects/${project.id}/time`, { cookie: guest })).json();
    expect(totals.loggedMinutes - before.loggedMinutes).toBe(80);
    expect(totals.estimateMinutes).toBe(240 + 60);
    const perTask = Object.fromEntries(
      totals.tasks.map((t: { taskId: string; loggedMinutes: number }) => [t.taskId, t.loggedMinutes]),
    );
    const prior = Object.fromEntries(
      before.tasks.map((t: { taskId: string; loggedMinutes: number }) => [t.taskId, t.loggedMinutes]),
    );
    expect(perTask[taskId] - (prior[taskId] ?? 0)).toBe(30);
    expect(perTask[otherTaskId] - (prior[otherTaskId] ?? 0)).toBe(50);
    expect(totals.users.reduce((s: number, u: { minutes: number }) => s + u.minutes, 0)).toBe(
      totals.loggedMinutes,
    );

    // Deleted tasks drop out of the totals (and their entries out of the bootstrap).
    await ctx.req(`${base}/tasks/${otherTaskId}`, { method: "DELETE", cookie: ada });
    const afterDelete = await (await ctx.req(`${base}/projects/${project.id}/time`, { cookie: ada })).json();
    expect(afterDelete.tasks.map((t: { taskId: string }) => t.taskId)).not.toContain(otherTaskId);
    const boot = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();
    expect(boot.timeEntries.some((e: { taskId: string }) => e.taskId === otherTaskId)).toBe(false);

    expect((await ctx.req(`${base}/projects/${missing}/time`, { cookie: ada })).status).toBe(404);
    await stop(ada);
  });
});
