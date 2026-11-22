import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const W = "/v1/workspaces/acme";

describe("client mistakes are 4xx, never 500", () => {
  let ctx: TestCtx;
  let ada: string;
  let teamId: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    teamId = (await (await ctx.req(`${W}/bootstrap`, { cookie: ada })).json()).teams[0].id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  const post = (path: string, json: unknown) => ctx.req(`${W}${path}`, { method: "POST", cookie: ada, json });
  const text = (t: string) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
  });
  const newId = () => crypto.randomUUID().replace(/^(.{14})4/, "$17"); // v7-shaped

  it("treats PATCH /tasks/:id with {} as a no-op", async () => {
    const task = await (await post("/tasks", { teamId, title: "Patch me" })).json();
    const res = await ctx.req(`${W}/tasks/${task.id}`, { method: "PATCH", cookie: ada, json: {} });
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe("Patch me");
  });

  it("returns 409 when a client-supplied id already exists", async () => {
    const conflict = async (res: Awaited<ReturnType<typeof post>>) => {
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("id_conflict");
    };

    const id = newId();
    expect((await post("/tasks", { id, teamId, title: "First" })).status).toBe(201);
    await conflict(await post("/tasks", { id, teamId, title: "Again" }));

    const docId = newId();
    expect((await post("/documents", { id: docId, title: "Doc" })).status).toBe(201);
    await conflict(await post("/documents", { id: docId, title: "Doc again" }));

    const projectId = newId();
    expect((await post("/projects", { id: projectId, name: "Proj" })).status).toBe(201);
    await conflict(await post("/projects", { id: projectId, name: "Proj again" }));

    const commentId = newId();
    expect((await post(`/tasks/${id}/comments`, { id: commentId, body: text("hi") })).status).toBe(201);
    await conflict(await post(`/tasks/${id}/comments`, { id: commentId, body: text("hi again") }));

    // An id that exists as a different kind of row collides only within its own table.
    expect((await post("/documents", { id, title: "Same uuid, other table" })).status).toBe(201);

    // The failed creates left nothing behind.
    const { tasks } = await (await ctx.req(`${W}/tasks`, { cookie: ada })).json();
    expect(tasks.filter((t: { id: string }) => t.id === id)).toHaveLength(1);
  });
});
