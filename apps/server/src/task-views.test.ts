import { newId } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

describe("saved task views", () => {
  let ctx: TestCtx;
  let owner: string;
  let member: string;
  let teamId: string;
  const spec = {
    filter: { version: 1, expression: { field: "priority", op: "eq", value: 1 } },
    layout: "list",
    sort: "priority",
  };
  const call = (path: string, method = "GET", json?: unknown, cookie = owner) =>
    ctx.req(`/v1/workspaces/acme${path}`, { method, cookie, json });
  const read = async (path: string, cookie = owner) => (await call(path, "GET", undefined, cookie)).json();

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    owner = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    member = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    teamId = (await read("/bootstrap")).teams[0].id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("stores personal views and excludes them from anyone else's lists, bootstrap and sync", async () => {
    const cursor = (await read("/bootstrap")).cursor;
    const compact = { ...spec, properties: [] };
    const created = await call(
      "/tasks/views",
      "POST",
      { name: "Urgent", scope: "personal", spec: compact },
      member,
    );
    expect(created.status).toBe(201);
    const view = await created.json();
    const path = `/tasks/views/${view.id}`;
    expect(await read(path, member)).toMatchObject({ spec: compact });
    expect((await call(path)).status).toBe(404);
    expect((await read("/tasks/views")).views).toEqual([]);
    expect((await read("/bootstrap?taskWindow=recent")).taskViews).toEqual([]);
    expect((await read("/bootstrap", member)).taskViews).toMatchObject([{ id: view.id, spec: compact }]);
    expect((await call(path, "PATCH", { name: "Urgent follow-up" }, member)).status).toBe(200);
    expect((await call(path, "DELETE", undefined, member)).status).toBe(204);
    expect((await call(path, "GET", undefined, member)).status).toBe(404);
    expect(
      (await read(`/sync?after=${cursor}`)).changes.some((c: { entityId: string }) => c.entityId === view.id),
    ).toBe(false);
    expect(
      (await read(`/sync?after=${cursor}`, member)).changes.filter(
        (c: { entityId: string }) => c.entityId === view.id,
      ),
    ).toMatchObject([{ action: "upsert" }, { action: "upsert" }, { action: "delete" }]);
  });

  it("validates sharing and limits updates to a shared view's owner and Tasks managers", async () => {
    expect(
      (await call("/tasks/views", "POST", { name: "Workspace", scope: "workspace", spec }, member)).status,
    ).toBe(403);
    expect(
      (await call("/tasks/views", "POST", { name: "Missing", scope: "team", spec, teamId: newId() })).status,
    ).toBe(404);
    expect(
      (await call("/tasks/views", "POST", { name: "Bad", scope: "personal", spec, teamId })).status,
    ).toBe(400);
    const created = await call("/tasks/views", "POST", { name: "Team", scope: "team", spec, teamId });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect((await read("/tasks/views", member)).views).toMatchObject([{ id, teamId }]);
    expect((await call(`/tasks/views/${id}`, "PATCH", { name: "Other" }, member)).status).toBe(403);
    expect((await call(`/tasks/views/${id}`, "PATCH", { scope: "workspace" })).status).toBe(400);
  });
});
