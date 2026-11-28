import {
  addDaysToIsoDate,
  newId,
  startOfDayInZone,
  todayInZone,
  type RecurrenceSchedule,
} from "@knotworking/core";
import { automationWebhooks } from "@knotworking/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deriveAutomationKey, saveRecurrence, tickTaskAutomation } from "./services/task-automation";
import { deliverAutomationWebhook } from "./services/automation-webhook-transport";
import { makeApp, signIn, TEST_SECRET, type TestCtx } from "./test-utils";

vi.mock("./services/automation-webhook-transport", async (original) => ({
  ...(await original<typeof import("./services/automation-webhook-transport")>()),
  deliverAutomationWebhook: vi.fn(),
}));

describe("task automation", () => {
  const modules = ["tasks", "automation"] as const;
  let ctx: TestCtx;
  let owner: string;
  let member: string;
  let teamId: string;
  let completedId: string;
  let userId: string;
  let today: string;
  let zone: string;
  const call = (path: string, method = "GET", json?: unknown, cookie = owner) =>
    ctx.req(`/v1/workspaces/acme${path}`, { method, cookie, json });
  const create = async (title: string, changes: Record<string, unknown> = {}) => {
    const response = await call("/tasks", "POST", { title, teamId, ...changes });
    expect(response.status).toBe(201);
    return (await response.json()).id as string;
  };
  const tick = (when = new Date()) =>
    tickTaskAutomation(ctx.handle.db, modules, deriveAutomationKey(TEST_SECRET), when);

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, activeModules: modules });
    owner = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    member = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const snapshot = await (await call("/bootstrap")).json();
    teamId = snapshot.teams[0].id;
    completedId = snapshot.workflowStates.find(
      (state: { teamId: string; type: string }) => state.teamId === teamId && state.type === "completed",
    ).id;
    userId = snapshot.users.find((user: { name: string }) => user.name.startsWith("Marcus")).id;
    zone = snapshot.workspace.timeZone;
    today = todayInZone(zone);
  }, 60_000);
  afterAll(async () => ctx?.handle.close());

  it("schedules once across two ticks and preserves an existing occurrence when editing the cadence", async () => {
    const taskId = await create("Monthly stock review", {
      dueDate: today,
      startDate: addDaysToIsoDate(today, -2),
    });
    const schedule: RecurrenceSchedule = {
      frequency: "daily",
      interval: 1,
      weekdays: [],
      firstOn: today,
      timing: "on_schedule",
    };
    const path = `/automation/recurrences/${taskId}`;
    expect(await (await call(path)).json()).toEqual({ recurrence: null });
    expect((await call(path, "PUT", { schedule, enabled: true }, member)).status).toBe(200);
    await Promise.all([tick(), tick()]);
    const { recurrence } = await (await call(path)).json();
    expect(recurrence.nextOn).toBe(addDaysToIsoDate(today, 1));
    expect(recurrence.previousTaskId).not.toBe(taskId);
    expect(await (await call(`/tasks/${recurrence.previousTaskId}`)).json()).toMatchObject({
      title: "Monthly stock review",
      dueDate: today,
      startDate: addDaysToIsoDate(today, -2),
    });
    expect((await call(path, "PUT", { schedule: { ...schedule, interval: 2 }, enabled: true })).status).toBe(
      200,
    );
    await tick();
    expect(await (await call(path)).json()).toMatchObject({
      recurrence: {
        previousTaskId: recurrence.previousTaskId,
        nextOn: addDaysToIsoDate(today, 2),
      },
    });
    await call(path, "DELETE");
  });

  it("resumes a paused cadence without generating occurrences from the paused period", async () => {
    const taskId = await create("Recurring paused review");
    const schedule: RecurrenceSchedule = {
      frequency: "daily",
      interval: 2,
      weekdays: [],
      firstOn: today,
      timing: "on_schedule",
    };
    const path = `/automation/recurrences/${taskId}`;
    expect((await call(path, "PUT", { schedule, enabled: true })).status).toBe(200);
    await tick();
    const { recurrence: before } = await (await call(path)).json();
    expect(before.nextOn).toBe(addDaysToIsoDate(today, 2));
    expect((await call(path, "PUT", { schedule, enabled: false })).status).toBe(200);

    const { workspace } = await (await call("/bootstrap")).json();
    const { user } = await (await ctx.req("/v1/me", { cookie: owner })).json();
    const resumedOn = addDaysToIsoDate(today, 7);
    const completed = addDaysToIsoDate(today, 8);
    const resumed = await saveRecurrence(
      ctx.handle.db,
      workspace.id,
      user.id,
      taskId,
      resumedOn,
      schedule,
      true,
    );
    expect(resumed).toMatchObject({ nextOn: completed, previousTaskId: before.previousTaskId });
    await tick(startOfDayInZone(resumedOn, zone));
    expect((await (await call(path)).json()).recurrence.previousTaskId).toBe(before.previousTaskId);
    await tick(startOfDayInZone(completed, zone));
    const { recurrence: next } = await (await call(path)).json();
    expect(next.nextOn).toBe(addDaysToIsoDate(today, 10));
    expect(next.previousTaskId).not.toBe(before.previousTaskId);
    expect((await (await call(`/tasks/${next.previousTaskId}`)).json()).dueDate).toBe(completed);
    await call(path, "DELETE");
  });

  it("waits for the previous task to close and applies each rule once without chaining", async () => {
    const taskId = await create("Review procedure");
    const path = `/automation/recurrences/${taskId}`;
    const schedule: RecurrenceSchedule = {
      frequency: "daily",
      interval: 1,
      weekdays: [],
      firstOn: today,
      timing: "after_completion",
    };
    expect((await call(path, "PUT", { schedule, enabled: true })).status).toBe(200);
    const filter = { version: 1, expression: { field: "creatorId", op: "ne", value: userId } };
    const rule = {
      name: "Follow up on closure",
      teamId,
      trigger: "state_changed",
      filter,
      actions: [
        { kind: "assign", assigneeId: userId },
        { kind: "create_subtask", title: "Check the review" },
      ],
      enabled: true,
    };
    expect((await call("/automation/rules", "POST", rule, member)).status).toBe(403);
    const createdRule = await call("/automation/rules", "POST", rule);
    expect(createdRule.status).toBe(201);
    const { id } = await createdRule.json();
    const chained = await call("/automation/rules", "POST", {
      ...rule,
      name: "Assignment rule",
      trigger: "assignee_changed",
    });
    expect(chained.status).toBe(201);
    expect(await (await call("/automation/dry-run", "POST", { taskId, rule })).json()).toEqual({
      matches: true,
      actions: rule.actions,
    });
    await tick();
    expect(await (await call(path)).json()).toMatchObject({ recurrence: { previousTaskId: taskId } });
    expect((await call(`/tasks/${taskId}`, "PATCH", { stateId: completedId })).status).toBe(200);
    await tick();
    await tick();
    expect(await (await call(`/tasks/${taskId}`)).json()).toMatchObject({ assigneeId: userId });
    const automation = await (await call("/automation")).json();
    expect(automation.runs).toMatchObject([{ ruleId: id, taskId, status: "completed" }]);
    expect(automation.runs).toHaveLength(1);
    expect((await (await call(path)).json()).recurrence.previousTaskId).not.toBe(taskId);
    await call(path, "DELETE");
  });

  it("signs one webhook delivery, hides its secret and retries unsuccessful responses", async () => {
    const mockDelivery = vi.mocked(deliverAutomationWebhook);
    mockDelivery.mockResolvedValueOnce(503).mockResolvedValueOnce(204);
    const webhook = {
      name: "Notify task tracker",
      url: "https://hooks.example.com/delivery",
      enabled: true,
      events: ["task_created"],
      filter: null,
    };
    expect((await call("/automation/webhooks", "POST", webhook, member)).status).toBe(403);
    const response = await call("/automation/webhooks", "POST", webhook);
    expect(response.status).toBe(201);
    const { id, secret } = await response.json();
    expect(secret).toHaveLength(43);
    expect((await ctx.handle.db.select().from(automationWebhooks))[0]?.secretCiphertext).not.toContain(
      secret,
    );
    expect(await (await call("/automation/webhooks")).text()).not.toContain(secret);
    const taskId = await create("Notify tracker");
    const now = new Date();
    await tick(now);
    await tick(new Date(now.getTime() + 61_000));
    expect(mockDelivery).toHaveBeenCalledTimes(2);
    const first = mockDelivery.mock.calls[0]![0];
    expect(mockDelivery.mock.calls[1]![0]).toEqual(first);
    expect(JSON.parse(first.body)).toMatchObject({ event: "task_created", task: { id: taskId } });
    expect(await (await call("/automation/webhooks")).json()).toMatchObject({
      deliveries: [{ webhookId: id, id: first.deliveryId, status: "delivered", attempts: 2 }],
    });
  });

  it("rolls back earlier actions if a later action has invalid references", async () => {
    const rule = {
      name: "Fail atomically",
      teamId,
      trigger: "due_date_passed",
      filter: null,
      actions: [
        { kind: "assign", assigneeId: userId },
        { kind: "add_label", labelId: newId() },
      ],
      enabled: true,
    };
    const response = await call("/automation/rules", "POST", rule);
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const taskId = await create("Past due", { dueDate: addDaysToIsoDate(today, -1) });
    await tick();
    expect(await (await call(`/tasks/${taskId}`)).json()).toMatchObject({ assigneeId: null });
    expect((await (await call("/automation")).json()).runs).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: id, taskId, status: "failed" })]),
    );
  });
  it("refuses a workspace-wide fixed status and stops queuing while the workspace has Automation disabled", async () => {
    const rule = {
      name: "Close new task",
      teamId: null,
      trigger: "task_created",
      filter: null,
      actions: [{ kind: "set_state", stateId: completedId }],
      enabled: true,
    };
    expect((await call("/automation/rules", "POST", rule)).status).toBe(400);
    expect(
      (
        await call("/automation/rules", "POST", {
          ...rule,
          teamId,
          actions: [{ kind: "set_state", stateId: newId() }],
        })
      ).status,
    ).toBe(400);
    expect((await call("/automation/rules", "POST", { ...rule, teamId })).status).toBe(201);
    expect((await call("/module-settings", "PATCH", { modules: ["tasks"] })).status).toBe(200);
    expect((await call("/automation")).status).toBe(404);
    const taskId = await create("Created while Automation disabled");
    await tick();
    expect((await call("/module-settings", "PATCH", { modules: null })).status).toBe(200);
    await tick();
    expect(await (await call(`/tasks/${taskId}`)).json()).toMatchObject({ completedAt: null });
  });

  it("skips a queued rule after its creator loses Tasks write access", async () => {
    const access = (module: string) => `/members/${userId}/module-access/${module}`;
    expect((await call(access("automation"), "PUT", { level: "manage" })).status).toBe(200);
    const rule = {
      name: "Member posts an automatic comment",
      teamId,
      trigger: "task_created",
      filter: null,
      actions: [{ kind: "comment", text: "Created through an automation" }],
      enabled: true,
    };
    const response = await call("/automation/rules", "POST", rule, member);
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const taskId = await create("Pending rule before revoke");
    expect((await call(access("tasks"), "PUT", { level: "read" })).status).toBe(200);
    await tick();
    expect((await (await call("/automation")).json()).runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: id,
          taskId,
          status: "skipped",
          result: "Rule owner no longer has access",
        }),
      ]),
    );
    await call(access("tasks"), "PUT", { level: null });
    await call(access("automation"), "PUT", { level: null });
  });

  it("releases a scheduled task when its due date begins in the workspace zone", async () => {
    expect((await call("/settings", "PATCH", { timeZone: "America/Los_Angeles" })).status).toBe(200);
    const taskId = await create("Check local midnight");
    const firstOn = addDaysToIsoDate(today, 2);
    const schedule: RecurrenceSchedule = {
      frequency: "daily",
      interval: 1,
      weekdays: [],
      firstOn,
      timing: "on_schedule",
    };
    const path = `/automation/recurrences/${taskId}`;
    expect((await call(path, "PUT", { schedule, enabled: true })).status).toBe(200);
    await tick(new Date(`${firstOn}T00:30:00Z`));
    expect(await (await call(path)).json()).toMatchObject({
      recurrence: { previousTaskId: taskId, nextOn: firstOn },
    });
    await tick(new Date(`${firstOn}T10:00:00Z`));
    expect(await (await call(path)).json()).toMatchObject({
      recurrence: { nextOn: addDaysToIsoDate(firstOn, 1) },
    });
    await call(path, "DELETE");
  });
});
