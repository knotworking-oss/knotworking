import { newId, todayInZone, DEFAULT_TIME_ZONE } from "@knotworking/core";
import { ledgerCommands, notifications, tasks, syncChanges } from "@knotworking/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainNotificationEmails, registerNotificationDelivery } from "./services/notifications";
import { makeApp, signIn, type TestCtx } from "./test-utils";

describe("information flow integrity", () => {
  let ctx: TestCtx, cookie: string, workspaceId: string, actorId: string, recipientId: string;
  let itemId: string, locationId: string;
  const post = (path: string, json: unknown) =>
    ctx.req(`/v1/workspaces/acme${path}`, { method: "POST", cookie, json });
  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const boot = await (await ctx.req("/v1/workspaces/acme/bootstrap", { cookie })).json();
    workspaceId = boot.workspace.id;
    actorId = boot.users.find((u: { email: string }) => u.email === "ada@knotworking.dev").id;
    recipientId = boot.users.find((u: { email: string }) => u.email === "marcus@knotworking.dev").id;
    itemId = (
      await (
        await post("/items", { code: "RETRY", name: "Retry flour", type: "ingredient", unit: "kg" })
      ).json()
    ).id;
    locationId = (await (await post("/stock/locations", { name: "Retry store" })).json()).id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("bootstraps every task above the former 5,000 row cap, while keeping public lists bounded", async () => {
    const boot = await (await ctx.req("/v1/workspaces/acme/bootstrap", { cookie })).json();
    const teamId = boot.teams[0].id;
    const stateId = boot.workflowStates.find((s: { teamId: string }) => s.teamId === teamId).id;
    const ids = Array.from({ length: 5001 }, () => newId());
    for (let at = 0; at < ids.length; at += 500) {
      await ctx.handle.db
        .insert(tasks)
        .values(
          ids
            .slice(at, at + 500)
            .map((id) => ({ id, workspaceId, teamId, stateId, title: "Complete snapshot", sortOrder: "a0" })),
        );
    }
    const snapshot = await (await ctx.req("/v1/workspaces/acme/bootstrap", { cookie })).json();
    const actual = new Set(snapshot.tasks.map((t: { id: string }) => t.id));
    expect(ids.every((id) => actual.has(id))).toBe(true);
    const page = await (await ctx.req("/v1/workspaces/acme/tasks?limit=2", { cookie })).json();
    expect(page.tasks).toHaveLength(2);
  }, 30_000);

  it("replays concurrent receipts once and refuses to reuse their key for a different payload", async () => {
    const commandId = newId();
    const input = {
      commandId,
      itemId,
      locationId,
      receivedOn: todayInZone(DEFAULT_TIME_ZONE),
      quantity: 5,
      unit: "kg",
    };
    const before = await ctx.handle.db
      .select()
      .from(syncChanges)
      .where(eq(syncChanges.workspaceId, workspaceId));
    const replies = await Promise.all([post("/stock/receipts", input), post("/stock/receipts", input)]);
    expect(replies.map((r) => r.status)).toEqual([201, 201]);
    const [first, retry] = await Promise.all(replies.map((r) => r.json()));
    expect(retry).toEqual(first);
    const after = await ctx.handle.db
      .select()
      .from(syncChanges)
      .where(eq(syncChanges.workspaceId, workspaceId));
    expect(after.length - before.length).toBe(2); // one lot and one movement
    expect((await post("/stock/receipts", { ...input, quantity: 6 })).status).toBe(409);
    expect(
      await ctx.handle.db.select().from(ledgerCommands).where(eq(ledgerCommands.commandId, commandId)),
    ).toHaveLength(1);
  });

  it("does not consume a command ID when its transaction is rejected", async () => {
    const commandId = newId();
    const bad = await post("/stock/receipts", {
      commandId,
      itemId: newId(),
      locationId,
      receivedOn: todayInZone(DEFAULT_TIME_ZONE),
      quantity: 5,
      unit: "kg",
    });
    expect(bad.status).toBe(404);
    expect(
      await ctx.handle.db.select().from(ledgerCommands).where(eq(ledgerCommands.commandId, commandId)),
    ).toHaveLength(0);
  });

  it("recovers committed mail after a restart, retries failures and fences simultaneous delivery workers", async () => {
    const id = newId();
    await ctx.handle.db.insert(notifications).values({
      id,
      workspaceId,
      userId: recipientId,
      actorId,
      type: "task_assigned",
      data: { taskTitle: "Durable notification" },
    });
    let calls = 0;
    registerNotificationDelivery(ctx.handle.db, {
      appUrl: "http://localhost:3000",
      mailer: {
        configured: true,
        async send() {
          calls++;
          if (calls === 1) throw new Error("temporary SMTP failure");
        },
      },
    });
    await drainNotificationEmails(ctx.handle.db);
    const [failed] = await ctx.handle.db.select().from(notifications).where(eq(notifications.id, id));
    expect(failed).toMatchObject({ emailState: "pending", emailAttempts: 1 });
    await ctx.handle.db
      .update(notifications)
      .set({ emailNextAttemptAt: new Date(0) })
      .where(eq(notifications.id, id));
    await Promise.all([drainNotificationEmails(ctx.handle.db), drainNotificationEmails(ctx.handle.db)]);
    const [sent] = await ctx.handle.db.select().from(notifications).where(eq(notifications.id, id));
    expect(sent).toMatchObject({ emailState: "sent", emailAttempts: 2, emailLeaseToken: null });
    expect(calls).toBe(2);
    await drainNotificationEmails(ctx.handle.db);
    expect(calls).toBe(2);

    const project = await (await post("/projects", { name: "Deleted project" })).json();
    const queuedId = newId();
    await ctx.handle.db.insert(notifications).values({
      id: queuedId,
      workspaceId,
      userId: recipientId,
      actorId,
      type: "project_update_posted",
      module: "tasks",
      data: { subjectId: project.id, title: project.name },
    });
    expect(
      (await ctx.req(`/v1/workspaces/acme/projects/${project.id}`, { method: "DELETE", cookie })).status,
    ).toBe(204);
    await drainNotificationEmails(ctx.handle.db);
    const [skipped] = await ctx.handle.db.select().from(notifications).where(eq(notifications.id, queuedId));
    expect(skipped).toMatchObject({ emailState: "skipped", emailLeaseToken: null });
    expect(calls).toBe(2);
  });
});
