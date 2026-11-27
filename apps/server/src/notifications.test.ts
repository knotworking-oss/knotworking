import { notifications, tasks } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { notifyTaskCommented } from "./services/notifications";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("notifications", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: string;
  let priya: string;
  let ids: Record<"ada" | "marcus" | "priya", string>;
  let boot: any;
  let teamId: string;
  let states: { id: string; name: string; type: string }[];

  const call = (path: string, cookie: string, init: { method?: string; json?: unknown } = {}) =>
    ctx.req(`${WS}${path}`, { cookie, ...init });
  const inbox = async (cookie: string, query = "") => (await call(`/notifications${query}`, cookie)).json();
  const createTask = async (cookie: string, json: Record<string, unknown>) => {
    const res = await call("/tasks", cookie, { method: "POST", json: { teamId, ...json } });
    expect(res.status).toBe(201);
    return res.json();
  };

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    const cookie = async (name: string) => (await signIn(ctx, `${name}@knotworking.dev`)).cookie;
    ada = await cookie("ada");
    marcus = await cookie("marcus");
    priya = await cookie("priya");
    boot = await (await call("/bootstrap", ada)).json();
    const email = (u: { email: string }) => u.email.split("@")[0]!;
    ids = Object.fromEntries(boot.users.map((u: { id: string; email: string }) => [email(u), u.id])) as never;
    teamId = boot.teams[0].id;
    states = boot.workflowStates.filter((s: { teamId: string }) => s.teamId === teamId);
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("requires a session", async () => {
    expect((await ctx.req(`${WS}/notifications`)).status).toBe(401);
  });

  it("notifies the assignee of a new task, but not the actor", async () => {
    const task = await createTask(ada, { title: "Review the budget", assigneeId: ids.marcus });
    await createTask(ada, { title: "My own task", assigneeId: ids.ada });
    await createTask(ada, { title: "Nobody's task" });

    const body = await inbox(marcus);
    expect(body.unreadCount).toBe(1);
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]).toMatchObject({
      type: "task_assigned",
      taskId: task.id,
      actorId: ids.ada,
      readAt: null,
      data: { taskTitle: "Review the budget" },
    });
    expect(body.notifications[0]).not.toHaveProperty("userId");
    expect((await inbox(ada)).notifications).toEqual([]); // self-assignment is silent
    expect((await inbox(priya)).unreadCount).toBe(0);
  });

  it("notifies on reassignment, and on status changes for the existing assignee", async () => {
    const task = await createTask(ada, { title: "Ship the newsletter", assigneeId: ids.marcus });
    const before = (await inbox(priya)).notifications.length;

    // Reassigned to priya: she gets "assigned"; the new state in the same patch is not repeated.
    const started = states.find((s) => s.type === "started")!;
    await call(`/tasks/${task.id}`, ada, {
      method: "PATCH",
      json: { assigneeId: ids.priya, stateId: started.id },
    });
    const afterAssign = await inbox(priya);
    expect(afterAssign.notifications).toHaveLength(before + 1);
    expect(afterAssign.notifications[0]).toMatchObject({ type: "task_assigned", taskId: task.id });

    // Status change by someone else: the assignee is told the new state.
    const done = states.find((s) => s.type === "completed")!;
    await call(`/tasks/${task.id}`, ada, { method: "PATCH", json: { stateId: done.id } });
    const afterStatus = await inbox(priya);
    expect(afterStatus.notifications[0]).toMatchObject({
      type: "task_status_changed",
      taskId: task.id,
      data: { taskTitle: "Ship the newsletter", stateName: done.name },
    });

    // The assignee changing it themselves is silent; so is an edit that touches neither field.
    const reopened = states.find((s) => s.type === "unstarted")!;
    await call(`/tasks/${task.id}`, priya, { method: "PATCH", json: { stateId: reopened.id } });
    await call(`/tasks/${task.id}`, ada, { method: "PATCH", json: { title: "Ship the newsletter v2" } });
    expect((await inbox(priya)).notifications).toHaveLength(afterStatus.notifications.length);
  });

  it("notifies the assignee of a comment from someone else", async () => {
    const task = await createTask(ada, { title: "Discuss pricing", assigneeId: ids.priya });
    const rows = await ctx.handle.db.transaction(async (tx) => {
      const [row] = await tx.select().from(tasks).where(eq(tasks.id, task.id));
      const mine = await notifyTaskCommented(tx, boot.workspace.id, ids.priya, row!, "I will do it");
      const theirs = await notifyTaskCommented(tx, boot.workspace.id, ids.ada, row!, "Any update?");
      return { mine, theirs };
    });
    expect(rows.mine).toMatchObject([{ userId: ids.ada }]); // the author isn't notified about their own comment
    expect(rows.theirs).toHaveLength(1);
    const latest = (await inbox(priya)).notifications[0];
    expect(latest).toMatchObject({
      type: "task_commented",
      taskId: task.id,
      data: { taskTitle: "Discuss pricing", snippet: "Any update?" },
    });
  });

  it("notifies the assignee when a comment is posted through the comment route", async () => {
    const task = await createTask(ada, { title: "Review the brief", assigneeId: ids.priya });
    const before = (await inbox(priya)).unreadCount;
    const body = (t: string) => ({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
    });
    const comment = (cookie: string, text: string) =>
      call(`/tasks/${task.id}/comments`, cookie, { method: "POST", json: { body: body(text) } });

    expect((await comment(priya, "On it")).status).toBe(201); // own task: silent
    expect((await inbox(priya)).unreadCount).toBe(before);

    expect((await comment(ada, "Any update?")).status).toBe(201);
    const after = await inbox(priya);
    expect(after.unreadCount).toBe(before + 1);
    expect(after.notifications[0]).toMatchObject({
      type: "task_commented",
      taskId: task.id,
      data: { snippet: "Any update?" },
    });
  });

  it("follows commenters and preserves an explicit unfollow", async () => {
    const task = await createTask(ada, { title: "Following example", assigneeId: ids.marcus });
    const path = `/tasks/${task.id}/following`;
    const comment = (cookie: string) =>
      call(`/tasks/${task.id}/comments`, cookie, {
        method: "POST",
        json: {
          body: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Update" }] }],
          },
        },
      });
    expect(await (await call(path, ada)).json()).toEqual({ following: true, count: 2 });
    expect(await (await call(path, priya)).json()).toEqual({ following: false, count: 2 });
    expect((await comment(priya)).status).toBe(201);
    expect(await (await call(path, priya)).json()).toEqual({ following: true, count: 3 });
    const update = await call(path, marcus, { method: "PUT", json: { following: false } });
    expect(update.status).toBe(200);
    expect(await update.json()).toEqual({ following: false, count: 2 });
    expect((await comment(marcus)).status).toBe(201);
    expect(await (await call(path, marcus)).json()).toEqual({ following: false, count: 2 });
    const before = (await inbox(marcus)).unreadCount;
    expect((await comment(ada)).status).toBe(201);
    expect((await inbox(marcus)).unreadCount).toBe(before);
  });

  it("keeps notifications out of the workspace sync log", async () => {
    const { cursor } = await (await call("/bootstrap", ada)).json();
    await createTask(ada, { title: "Private signal", assigneeId: ids.marcus });
    const sync = await (await call(`/sync?after=${cursor}`, priya)).json();
    expect(sync.changes.map((c: { entity: string }) => c.entity)).toEqual(["task"]);
    expect(JSON.stringify(sync)).not.toContain("task_assigned");
  });

  it("pages through the inbox, newest first", async () => {
    for (let i = 0; i < 4; i++) await createTask(ada, { title: `Paged ${i}`, assigneeId: ids.marcus });
    const all = await inbox(marcus, "?limit=100");
    const first = await inbox(marcus, "?limit=3");
    expect(first.notifications.map((n: { id: string }) => n.id)).toEqual(
      all.notifications.slice(0, 3).map((n: { id: string }) => n.id),
    );
    expect(first.nextCursor).toBe(first.notifications[2].id);
    expect(first.unreadCount).toBe(all.notifications.length);
    const second = await inbox(marcus, `?limit=100&before=${first.nextCursor}`);
    expect(second.notifications.map((n: { id: string }) => n.id)).toEqual(
      all.notifications.slice(3).map((n: { id: string }) => n.id),
    );
    expect(second.nextCursor).toBeNull();
    expect((await inbox(marcus, "?limit=0")).error).toBeTruthy();
  });

  it("marks one notification read, and only your own", async () => {
    const [target] = (await inbox(marcus)).notifications;
    const before = (await inbox(marcus)).unreadCount;

    expect((await call(`/notifications/${target.id}/read`, priya, { method: "POST" })).status).toBe(404);
    expect((await inbox(marcus)).unreadCount).toBe(before);

    const res = await call(`/notifications/${target.id}/read`, marcus, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).unreadCount).toBe(before - 1);
    const readAt = (await inbox(marcus)).notifications[0].readAt;
    expect(readAt).toBeTruthy();

    // Idempotent: the original timestamp is kept.
    await call(`/notifications/${target.id}/read`, marcus, { method: "POST" });
    expect((await inbox(marcus)).notifications[0].readAt).toBe(readAt);

    const unread = await inbox(marcus, "?unread=true&limit=100");
    expect(unread.notifications.every((n: { readAt: unknown }) => n.readAt === null)).toBe(true);
    expect(unread.notifications.map((n: { id: string }) => n.id)).not.toContain(target.id);
    expect((await call(`/notifications/unread-count`, marcus)).status).toBe(200);
  });

  it("marks everything read", async () => {
    const priyaUnread = (await inbox(priya)).unreadCount;
    expect(priyaUnread).toBeGreaterThan(0);
    const res = await call("/notifications/read-all", marcus, { method: "POST" });
    expect(await res.json()).toMatchObject({ unreadCount: 0 });
    expect((await (await call("/notifications/unread-count", marcus)).json()).unreadCount).toBe(0);
    expect((await inbox(marcus)).notifications.length).toBeGreaterThan(0); // still listed
    expect((await inbox(priya)).unreadCount).toBe(priyaUnread); // others untouched
  });

  it("hides notifications about deleted tasks", async () => {
    const task = await createTask(ada, { title: "Short-lived", assigneeId: ids.marcus });
    expect((await inbox(marcus)).unreadCount).toBe(1);
    await call(`/tasks/${task.id}`, ada, { method: "DELETE" });
    const body = await inbox(marcus);
    expect(body.unreadCount).toBe(0);
    expect(body.notifications.map((n: { taskId: string }) => n.taskId)).not.toContain(task.id);
  });

  describe("email", () => {
    it("emails the assignee when SMTP is configured, unless they opted out", async () => {
      ctx.mailer.sent.length = 0;
      await createTask(ada, { title: "Emailed task", assigneeId: ids.priya });
      await vi.waitFor(() => expect(ctx.mailer.sent).toHaveLength(1));
      expect(ctx.mailer.sent[0]).toMatchObject({
        to: "priya@knotworking.dev",
        subject: 'Ada Park assigned you "Emailed task"',
      });
      expect(ctx.mailer.sent[0]!.text).toContain("/acme/task/");

      expect((await call("/notifications/preferences", priya)).status).toBe(200);
      const off = await call("/notifications/preferences", priya, {
        method: "PUT",
        json: { emailEnabled: false },
      });
      expect(await off.json()).toMatchObject({
        emailEnabled: false,
        emailConfigured: true,
        emailTypes: { task_assigned: true },
      });

      const task = await createTask(ada, { title: "Silent task", assigneeId: ids.priya });
      // The in-app notification is still created; only the email is skipped.
      expect((await inbox(priya)).notifications[0]).toMatchObject({ taskId: task.id });
      await new Promise((r) => setTimeout(r, 50));
      expect(ctx.mailer.sent).toHaveLength(1);

      await call("/notifications/preferences", priya, { method: "PUT", json: { emailEnabled: true } });
      expect(await (await call("/notifications/preferences", priya)).json()).toMatchObject({
        emailEnabled: true,
      });
    });

    it("sends no email when SMTP is not configured", async () => {
      const { mailer } = ctx;
      const real = mailer.configured;
      (mailer as { configured: boolean }).configured = false;
      mailer.sent.length = 0;
      await createTask(ada, { title: "Unmailed", assigneeId: ids.marcus });
      await new Promise((r) => setTimeout(r, 50));
      expect(mailer.sent).toHaveLength(0);
      expect((await inbox(marcus)).unreadCount).toBe(1);
      (mailer as { configured: boolean }).configured = real;
    });
  });

  it("persists rows with workspace and recipient scoping", async () => {
    const rows = await ctx.handle.db.select().from(notifications);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.userId !== r.actorId)).toBe(true);
  });
});
