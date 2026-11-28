import { newId } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

describe("project milestones", () => {
  let ctx: TestCtx;
  let cookie: string;
  let teamId: string;
  let doneId: string;
  let leadId: string;

  const call = (path: string, method = "GET", json?: unknown) =>
    ctx.req(`/v1/workspaces/acme${path}`, { method, cookie, json });
  const create = async (path: string, json: unknown) => {
    const response = await call(path, "POST", json);
    expect(response.status).toBe(201);
    return response.json();
  };

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const boot = await (await call("/bootstrap")).json();
    teamId = boot.teams[0].id;
    leadId = boot.users[0].id;
    doneId = boot.workflowStates.find(
      (state: { teamId: string; type: string }) => state.teamId === teamId && state.type === "completed",
    ).id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("validates assignment, counts completed work and cleans up at both deletion entry points", async () => {
    const project = await create("/projects", { name: "Milestone project" });
    const other = await create("/projects", { name: "Other project" });
    const url = `/projects/${project.id}/milestones`;
    const milestone = await create(url, { name: "Release", targetDate: "2026-12-01" });
    const open = await create("/tasks", {
      title: "Open",
      teamId,
      projectId: project.id,
      milestoneId: milestone.id,
    });
    const done = await create("/tasks", {
      title: "Done",
      teamId,
      stateId: doneId,
      projectId: project.id,
      milestoneId: milestone.id,
    });
    expect(
      (
        await call("/tasks", "POST", {
          title: "Mismatch",
          teamId,
          projectId: other.id,
          milestoneId: milestone.id,
        })
      ).status,
    ).toBe(400);
    const boot = await (await call("/bootstrap?taskWindow=recent")).json();
    expect(boot.closedWindow.milestoneCounts[milestone.id]).toEqual({ completed: 1, total: 2 });
    expect(boot.projectMilestones).toContainEqual(expect.objectContaining({ id: milestone.id }));
    const query = new URLSearchParams({
      filter: JSON.stringify({
        version: 1,
        expression: { field: "milestoneId", op: "eq", value: milestone.id },
      }),
    });
    const matches = await (await call(`/tasks?${query}`)).json();
    expect(new Set(matches.tasks.map((task: { id: string }) => task.id))).toEqual(
      new Set([open.id, done.id]),
    );
    const moved = await call(`/tasks/${open.id}`, "PATCH", { projectId: other.id });
    expect(await moved.json()).toMatchObject({ projectId: other.id, milestoneId: null });
    const completed = await call(`${url}/${milestone.id}`, "PATCH", { completed: true });
    expect(await completed.json()).toMatchObject({ completedAt: expect.any(String) });
    expect((await call(`${url}/${milestone.id}`, "DELETE")).status).toBe(204);
    expect(await (await call(`/tasks/${done.id}`)).json()).toMatchObject({
      projectId: project.id,
      milestoneId: null,
    });
    const another = await create(url, { name: "Second milestone" });
    expect((await call(`/tasks/${done.id}`, "PATCH", { milestoneId: another.id })).status).toBe(200);
    expect((await call(`/projects/${project.id}`, "DELETE")).status).toBe(204);
    expect(await (await call(`/tasks/${done.id}`)).json()).toMatchObject({
      projectId: null,
      milestoneId: null,
    });
    expect((await (await call("/bootstrap")).json()).projectMilestones).toEqual([]);
  });

  it("declares and links the kickoff milestone once when a template command is retried", async () => {
    const input = {
      commandId: newId(),
      templateId: "client_kickoff",
      name: "Kickoff test",
      teamId,
      leadId,
      startDate: "2026-12-04",
    };
    const project = await create("/projects/from-template", input);
    expect(await create("/projects/from-template", input)).toEqual(project);
    const milestones = await (await call(`/projects/${project.id}/milestones`)).json();
    expect(milestones.milestones).toMatchObject([{ name: "Kickoff date", targetDate: input.startDate }]);
    const result = await (await call(`/tasks?projectId=${project.id}`)).json();
    for (const task of result.tasks) {
      expect(task.milestoneId).toBe(task.dueDate <= input.startDate ? milestones.milestones[0].id : null);
    }
  });
});
