import { newId } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

describe("planner custom fields", () => {
  let ctx: TestCtx;
  let owner: string;
  let member: string;
  let teamId: string;
  let projectId: string;
  let taskId: string;

  const fieldsPath = "/tasks/custom-fields";
  const call = (path: string, method = "GET", json?: unknown, cookie = owner) =>
    ctx.req(`/v1/workspaces/acme${path}`, { method, cookie, json });
  const read = async (path: string) => (await call(path)).json();
  async function create(path: string, input: unknown) {
    const res = await call(path, "POST", input);
    expect(res.status).toBe(201);
    return res.json();
  }

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    owner = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    member = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const boot = await read("/bootstrap");
    teamId = boot.teams[0].id;
    projectId = (await create("/projects", { name: "Workspace rollout", teamIds: [teamId] })).id;
    taskId = (await create("/tasks", { teamId, projectId, title: "Test workflows" })).id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("lets writers edit values and restricts definitions to managers", async () => {
    const input = { name: "Confidence", target: "task", type: "number", teamId };
    expect((await call(fieldsPath, "POST", input, member)).status).toBe(403);
    const field = await create(fieldsPath, input);
    const base = `${fieldsPath}/task/${taskId}/values`;
    expect(await read(base)).toMatchObject({ fields: [{ id: field.id, value: null }] });
    expect((await call(`${base}/${field.id}`, "PUT", { value: "3" }, member)).status).toBe(400);
    expect((await call(`${base}/${field.id}`, "PUT", { value: 3.25 }, member)).status).toBe(200);
    expect(await read(base)).toMatchObject({ fields: [{ id: field.id, value: 3.25 }] });
    const anotherTeam = await create("/teams", { name: "Field test", key: "FIELD" });
    const other = await create("/tasks", { teamId: anotherTeam.id, title: "Other team" });
    expect(await read(`${fieldsPath}/task/${other.id}/values`)).toEqual({ fields: [] });
    expect(
      (await call(`${fieldsPath}/task/${other.id}/values/${field.id}`, "PUT", { value: 3.25 })).status,
    ).toBe(404);
    expect((await call(`${fieldsPath}/${field.id}`, "DELETE")).status).toBe(204);
    expect(await read(base)).toEqual({ fields: [] });
  });

  it("validates project select options and keeps stored values through a rename", async () => {
    const option = { id: newId(), label: "Phase one" };
    const field = await create(fieldsPath, {
      target: "project",
      type: "single_select",
      name: "Phase",
      teamId,
      options: [option],
    });
    const path = `${fieldsPath}/project/${projectId}/values`;
    expect((await call(`${path}/${field.id}`, "PUT", { value: newId() })).status).toBe(400);
    expect((await call(`${path}/${field.id}`, "PUT", { value: option.id })).status).toBe(200);
    expect(
      (await call(`${fieldsPath}/${field.id}`, "PATCH", { options: [{ ...option, label: "First" }] })).status,
    ).toBe(200);
    expect(
      (await call(`${fieldsPath}/${field.id}`, "PATCH", { options: [{ id: newId(), label: "Other" }] }))
        .status,
    ).toBe(400);
    expect(await read(path)).toMatchObject({
      fields: [{ id: field.id, value: option.id, options: [{ label: "First" }] }],
    });
    expect((await call(`${path}/${field.id}`, "PUT", { value: null })).status).toBe(200);
    expect(await read(path)).toMatchObject({ fields: [{ id: field.id, value: null }] });
  });

  it("searches stored task text while the field applies to the task", async () => {
    const field = await create(fieldsPath, { target: "task", type: "text", name: "Lookup", projectId });
    const path = `${fieldsPath}/task/${taskId}/values/${field.id}`;
    expect((await call(path, "PUT", { value: "Quokka reference" })).status).toBe(200);
    expect(await read("/search?q=quokka&scope=tasks")).toMatchObject({
      tasks: [{ id: taskId, snippet: "Quokka reference" }],
    });
    expect((await call(`/tasks/${taskId}`, "PATCH", { projectId: null })).status).toBe(200);
    expect(await read("/search?q=quokka&scope=tasks")).toMatchObject({ tasks: [] });
  });
});
