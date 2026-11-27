import { newId, olderClosedTaskFilter } from "@knotworking/core";
import { tasks } from "@knotworking/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

describe("planner bootstrap and team features", () => {
  let ctx: TestCtx;
  let owner: string;
  let member: string;
  let boot: any;
  let teamId: string;
  let doneId: string;
  let projectId: string;
  let oldId: string;

  const request = (path: string, method = "GET", json?: unknown, cookie = owner) =>
    ctx.req(`/v1/workspaces/acme${path}`, { method, cookie, json });
  const recent = async () => {
    const response = await request("/bootstrap?taskWindow=recent");
    expect(response.status).toBe(200);
    return response.json();
  };

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    owner = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    member = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    boot = await (await request("/bootstrap")).json();
    teamId = boot.teams[0].id;
    doneId = boot.workflowStates.find(
      (state: { teamId: string; type: string }) => state.teamId === teamId && state.type === "completed",
    ).id;
    projectId = (await (await request("/projects", "POST", { name: "Planner archive" })).json()).id;
    const opened = await (
      await request("/tasks", "POST", { teamId, projectId, title: "Open parent" })
    ).json();
    const older = await (
      await request("/tasks", "POST", {
        teamId,
        projectId,
        stateId: doneId,
        title: "Old child",
        parentId: opened.id,
        estimateMinutes: 90,
        labelIds: [boot.labels[0].id],
      })
    ).json();
    oldId = older.id;
    expect(
      (await request("/task-relations", "POST", { blockedTaskId: oldId, blockingTaskId: opened.id })).status,
    ).toBe(201);
    expect(
      (await request(`/tasks/${oldId}/time-entries`, "POST", { minutes: 25, entryDate: "2026-01-01" }))
        .status,
    ).toBe(201);
    await ctx.handle.db.execute(sql`update ${tasks}
      set updated_at = now() - interval '45 days', created_at = now() - interval '60 days'
      where id = ${oldId}`);
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("keeps historical tasks out of the recent snapshot and preserves counts, direct reads and reopening", async () => {
    const snapshot = await recent();
    expect(snapshot.workspace.closedTaskWindowDays).toBe(30);
    expect(snapshot.tasks.some((task: { id: string }) => task.id === oldId)).toBe(false);
    expect(snapshot.taskLabels.some((link: { taskId: string }) => link.taskId === oldId)).toBe(false);
    expect(
      snapshot.taskRelations.some((link: { blockedTaskId: string }) => link.blockedTaskId === oldId),
    ).toBe(false);
    expect(snapshot.timeEntries.some((entry: { taskId: string }) => entry.taskId === oldId)).toBe(false);
    expect(snapshot.closedWindow.projectCounts[projectId]).toEqual({
      open: 1,
      completed: 1,
      canceled: 0,
      started: 0,
      estimate: 90,
      logged: 25,
    });
    expect(snapshot.closedWindow.stateCounts[doneId]).toBeGreaterThanOrEqual(1);
    expect(snapshot.closedWindow.labelCounts[boot.labels[0].id]).toBeGreaterThanOrEqual(1);
    const full = await (await request("/bootstrap")).json();
    expect(full.closedWindow).toBeUndefined();
    expect(full.tasks.some((task: { id: string }) => task.id === oldId)).toBe(true);
    const direct = await (await request(`/tasks/${oldId}?context=true`)).json();
    expect(direct.context.tasks).toContainEqual(expect.objectContaining({ id: direct.parentId }));
    expect(direct.context.relations).toContainEqual(expect.objectContaining({ blockedTaskId: oldId }));
    const historical = { version: 1, expression: olderClosedTaskFilter(snapshot.closedWindow.cutoff) };
    const query = new URLSearchParams({
      projectId,
      title: "OLD CHILD",
      filter: JSON.stringify(historical),
      includeRelations: "true",
    });
    const history = await (await request(`/tasks?${query}`)).json();
    expect(history.tasks).toMatchObject([{ id: oldId }]);
    expect(history.relations).toContainEqual(expect.objectContaining({ blockedTaskId: oldId }));

    expect((await request("/settings", "PATCH", { closedTaskWindowDays: 0 })).status).toBe(400);
    expect((await request("/settings", "PATCH", { closedTaskWindowDays: 60 }, member)).status).toBe(403);
    expect((await request("/settings", "PATCH", { closedTaskWindowDays: 60 })).status).toBe(200);
    expect((await recent()).tasks).toContainEqual(expect.objectContaining({ id: oldId }));
    expect((await request("/settings", "PATCH", { closedTaskWindowDays: 30 })).status).toBe(200);
    const start = (await recent()).cursor;
    const openStateId = boot.workflowStates.find(
      (state: { teamId: string; type: string }) => state.teamId === teamId && state.type === "unstarted",
    ).id;
    expect((await request(`/tasks/${oldId}`, "PATCH", { stateId: openStateId })).status).toBe(200);
    const delta = await (await request(`/sync?after=${start}`)).json();
    expect(delta.changes).toContainEqual(
      expect.objectContaining({ entity: "task", entityId: oldId, action: "upsert" }),
    );
    expect((await recent()).tasks).toContainEqual(expect.objectContaining({ id: oldId }));
  });

  it("validates feature switches and syncs them only for the edited team", async () => {
    expect(boot.teams.every((team: { features: string[] }) => team.features.length === 0)).toBe(true);
    const start = (await recent()).cursor;
    const path = `/teams/${teamId}`;
    expect((await request(path, "PATCH", { features: ["cycles"] }, member)).status).toBe(403);
    expect((await request(path, "PATCH", { features: ["cycles", "cycles"] })).status).toBe(400);
    expect((await request(path, "PATCH", { features: ["unavailable"] })).status).toBe(400);
    expect((await request(path, "PATCH", { features: ["cycles", "triage"] })).status).toBe(200);
    const next = await recent();
    expect(next.teams.find((t: { id: string }) => t.id === teamId).features).toEqual(["cycles", "triage"]);
    expect(
      next.teams
        .filter((t: { id: string }) => t.id !== teamId)
        .every((t: { features: string[] }) => t.features.length === 0),
    ).toBe(true);
    expect((await (await request(`/sync?after=${start}`)).json()).changes).toContainEqual(
      expect.objectContaining({
        entity: "team",
        entityId: teamId,
        data: expect.objectContaining({ features: ["cycles", "triage"] }),
      }),
    );
  });

  it("keeps the recent response size almost constant with 50,000 historical tasks", async () => {
    const before = JSON.stringify(await recent());
    const marker = newId();
    await ctx.handle.db.execute(sql`
      insert into tasks (id, workspace_id, team_id, state_id, title, sort_order, updated_at)
      select gen_random_uuid(), ${boot.workspace.id}, ${teamId}, ${doneId}, ${marker}, 'a0',
             now() - interval '100 days'
      from generate_series(1, 50000)
    `);
    const snapshot = await recent();
    expect(snapshot.closedWindow.olderCount).toBeGreaterThanOrEqual(50_000);
    expect(snapshot.tasks.some((task: { title: string }) => task.title === marker)).toBe(false);
    expect(JSON.stringify(snapshot).length - before.length).toBeLessThan(200);
  }, 30_000);
});
