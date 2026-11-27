import {
  filterTaskRows,
  newId,
  taskFilterSchema,
  type TaskFilterExpression,
  type WorkflowStateType,
} from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const base = "/v1/workspaces/acme";

describe("task queries", () => {
  let ctx: TestCtx;
  let cookie: string;
  let teamId: string;
  let archivedTeamId: string;
  let labelId: string;
  let blockedId: string;
  let blockerId: string;
  let fixtureIds: string[];

  const call = (path: string, method = "GET", json?: unknown) =>
    ctx.req(base + path, { cookie, method, json });
  const post = async (path: string, json: unknown) => {
    const response = await call(path, "POST", json);
    expect(response.status).toBe(201);
    return response.json();
  };
  const query = (params: Record<string, string> = {}) =>
    call(`/tasks?${new URLSearchParams({ teamId, ...params })}`);

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    teamId = (await post("/teams", { key: "FILTER", name: "Task filters" })).id;
    archivedTeamId = (await post("/teams", { key: "HIDDEN", name: "Hidden tasks" })).id;
    const boot = await (await call("/bootstrap")).json();
    const stateId = boot.workflowStates.find(
      (s: { teamId: string; type: string }) => s.teamId === teamId && s.type === "completed",
    ).id;
    labelId = boot.labels[0].id;
    const create = (title: string, fields: object = {}) =>
      post("/tasks", { teamId, title, sortOrder: "a0", ...fields });
    const blocker = await create("Blocker", { labelIds: [labelId], dueDate: "2026-12-01", priority: 1 });
    const blocked = await create("Blocked", { parentId: blocker.id, dueDate: "2026-12-05", priority: 2 });
    const closed = await create("Closed", { stateId, priority: 1 });
    const plain = await create("Plain");
    const hidden = await create("Hidden", { teamId: archivedTeamId, parentId: blocked.id });
    await post("/task-relations", { blockingTaskId: blocker.id, blockedTaskId: blocked.id });
    await post("/task-relations", { blockingTaskId: closed.id, blockedTaskId: plain.id });
    await post("/task-relations", { blockingTaskId: hidden.id, blockedTaskId: plain.id });
    expect((await call(`/teams/${archivedTeamId}`, "PATCH", { archived: true })).status).toBe(200);
    blockedId = blocked.id;
    blockerId = blocker.id;
    fixtureIds = [blocker.id, blocked.id, closed.id, plain.id];
  }, 60_000);

  afterAll(() => ctx.handle.close());

  it("matches client evaluation for nested, null, date, label and relationship filters", async () => {
    const boot = await (await call("/bootstrap")).json();
    const states = new Map<string, WorkflowStateType>(
      boot.workflowStates.map((s: { id: string; type: WorkflowStateType }) => [s.id, s.type]),
    );
    const knownDate = boot.tasks.find((t: { id: string }) => t.id === blockedId).createdAt;
    const fixtures: TaskFilterExpression[] = [
      {
        and: [
          { field: "assigneeId", op: "eq", value: null },
          {
            or: [
              { field: "labelId", op: "eq", value: labelId },
              { field: "blocked", op: "eq", value: true },
            ],
          },
        ],
      },
      { field: "hasSubtasks", op: "eq", value: true },
      { field: "labelId", op: "ne", value: labelId },
      { field: "dueDate", op: "gte", value: "2026-12-05" },
      { field: "dueDate", op: "eq", value: null },
      { field: "dueDate", op: "ne", value: "2026-12-05" },
      { field: "createdAt", op: "eq", value: knownDate },
      { field: "updatedAt", op: "gte", value: knownDate },
      { field: "completedAt", op: "ne", value: null },
      { field: "parentId", op: "eq", value: blockerId },
      { field: "stateType", op: "eq", value: "completed" },
      { field: "priority", op: "eq", value: 1 },
    ];
    for (const expression of fixtures) {
      const filter = taskFilterSchema.parse({ version: 1, expression });
      const expected = filterTaskRows(boot.tasks, filter, (id) => states.get(id) ?? null, boot.taskRelations)
        .filter((t) => t.teamId === teamId)
        .map((t) => t.id)
        .sort();
      expect(expected.length, JSON.stringify(expression)).toBeGreaterThan(0);
      const res = await query({ filter: JSON.stringify(filter) });
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(body.tasks.map((t: { id: string }) => t.id).sort(), JSON.stringify(expression)).toEqual(
        expected,
      );
    }
  });

  it("paginates every sort and keeps group boundaries across pages", async () => {
    for (const sort of ["", "manual", "priority", "created", "updated"]) {
      const params = { ...(sort ? { sort } : {}), group: "assigneeId" };
      const full = await (await query(params)).json();
      const expected = full.tasks.map((t: { id: string }) => t.id);
      expect(new Set(expected)).toEqual(new Set(fixtureIds));
      expect(full.groups).toEqual([{ key: null, taskIds: expected }]);
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < expected.length; i++) {
        const res = await query({ ...params, limit: "1", ...(cursor ? { cursor } : {}) });
        expect(res.status).toBe(200);
        const page = await res.json();
        const id = page.tasks[0].id;
        expect(page.groups).toEqual([{ key: null, taskIds: [id] }]);
        ids.push(id);
        cursor = page.nextCursor;
      }
      expect(ids).toEqual(expected);
      expect(cursor).toBeNull();
    }
    const full = await (await query({ sort: "priority" })).json();
    expect(full.tasks.map((t: { priority: number }) => t.priority)).toEqual([1, 1, 2, 0]);
    const page = await (await query({ group: "priority", limit: "2" })).json();
    expect(page.groups.map((g: { key: string }) => g.key)).toEqual(["0", "1"]);
    const next = await (await query({ group: "priority", limit: "2", cursor: page.nextCursor })).json();
    expect(next.groups.map((g: { key: string }) => g.key)).toEqual(["1", "2"]);
    expect((await query({ group: "stateType", cursor: page.nextCursor })).status).toBe(400);
  });

  it("rejects malformed, oversized or unsupported expressions and cursors", async () => {
    const leaf = { field: "labelId", op: "eq", value: newId() };
    const deep = Array.from({ length: 5 }).reduce<TaskFilterExpression>(
      (expression) => ({ and: [expression] }),
      { ...leaf, field: "labelId", op: "eq" },
    );
    for (const filter of [
      "{",
      JSON.stringify({ version: 2, expression: leaf }),
      JSON.stringify({ version: 1, expression: { or: [] } }),
      JSON.stringify({ version: 1, expression: { ...leaf, op: "lt" } }),
      JSON.stringify({ version: 1, expression: deep }),
      JSON.stringify({
        version: 1,
        expression: { and: Array.from({ length: 5 }, () => ({ or: Array(13).fill(leaf) })) },
      }),
    ]) {
      expect((await query({ filter })).status, filter).toBe(400);
    }
    expect((await query({ cursor: "bogus" })).status).toBe(400);
  });
});
