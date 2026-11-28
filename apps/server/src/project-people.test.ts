import { moduleIds, textToDoc } from "@knotworking/core";
import { projects } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";
import { sweepDueNotifications } from "./services/notification-sweep";

describe("project contributors and followers", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: string;
  let leadId: string;
  let memberId: string;
  let workspaceId: string;
  const call = (path: string, method = "GET", json?: unknown, cookie = ada) =>
    ctx.req(`/v1/workspaces/acme${path}`, { method, cookie, json });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const boot = await (await call("/bootstrap")).json();
    workspaceId = boot.workspace.id;
    leadId = boot.users.find((user: { email: string }) => user.email.startsWith("ada@")).id;
    memberId = boot.users.find((user: { email: string }) => user.email.startsWith("marcus@")).id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("inherits lead and contributor followers while preserving explicit choices", async () => {
    const project = await (await call("/projects", "POST", { name: "Audience", leadId })).json();
    const path = `/projects/${project.id}`;
    const follow = (following: boolean) => call(`${path}/following`, "PUT", { following }, marcus);
    expect(await (await call(`${path}/members`)).json()).toEqual({
      members: [{ userId: leadId, role: "lead" }],
      following: true,
      followerCount: 1,
    });
    expect((await call(`${path}/members`, "POST", { userId: memberId })).status).toBe(200);
    expect(await (await call(`${path}/members`, "GET", undefined, marcus)).json()).toMatchObject({
      following: true,
      followerCount: 2,
    });
    expect(await (await follow(false)).json()).toMatchObject({ following: false, followerCount: 1 });
    expect((await call(`${path}/members/${memberId}`, "DELETE")).status).toBe(200);
    expect((await call(`${path}/members`, "POST", { userId: memberId })).status).toBe(200);
    expect(await (await call(`${path}/members`, "GET", undefined, marcus)).json()).toMatchObject({
      following: false,
      followerCount: 1,
    });
    expect(await (await follow(true)).json()).toMatchObject({ following: true, followerCount: 2 });
    expect((await call(`${path}/members/${leadId}`, "DELETE")).status).toBe(400);
  });

  it("posts updates with health, notifies followers and supports a paginated discussion", async () => {
    const project = await (await call("/projects", "POST", { name: "Release work", leadId })).json();
    const url = `/projects/${project.id}`;
    expect((await call(`${url}/members`, "POST", { userId: memberId })).status).toBe(200);
    const posted = await call(`${url}/updates`, "POST", {
      health: "at_risk",
      body: textToDoc("Scope changed"),
    });
    expect(posted.status).toBe(201);
    const update = await posted.json();
    const bootstrap = await (await call("/bootstrap")).json();
    expect(bootstrap.projects.find((row: { id: string }) => row.id === project.id)).toMatchObject({
      health: "at_risk",
      lastUpdateAt: update.createdAt,
    });
    expect(
      (await (await call("/notifications", "GET", undefined, marcus)).json()).notifications,
    ).toContainEqual(
      expect.objectContaining({
        type: "project_update_posted",
        data: expect.objectContaining({ subjectId: project.id }),
      }),
    );
    const thread = `${url}/updates/${update.id}/comments`;
    expect((await call(thread, "POST", { body: textToDoc("First") }, marcus)).status).toBe(201);
    expect((await call(thread, "POST", { body: textToDoc("Second") }, marcus)).status).toBe(201);
    const page = await (await call(`${thread}?limit=1`)).json();
    expect(page.items).toMatchObject([{ body: textToDoc("Second") }]);
    expect(await (await call(`${thread}?before=${page.nextCursor}`)).json()).toMatchObject({
      items: [{ body: textToDoc("First") }],
      nextCursor: null,
    });
  });

  it("reminds an active project's lead at most once per workspace week", async () => {
    const project = await (
      await call("/projects", "POST", { name: "Needs a weekly update", status: "active", leadId })
    ).json();
    await ctx.handle.db
      .update(projects)
      .set({ createdAt: new Date("2026-11-01T12:00:00Z") })
      .where(eq(projects.id, project.id));
    const sweep = async (now: string) =>
      (
        await sweepDueNotifications(ctx.handle.db, {
          activeModules: moduleIds,
          workspaceId,
          now: new Date(now),
        })
      ).created.filter((row) => row.type === "project_update_due" && row.data.subjectId === project.id);
    expect(await sweep("2026-11-23T12:00:00Z")).toHaveLength(1);
    expect(await sweep("2026-11-27T12:00:00Z")).toHaveLength(0);
    expect(await sweep("2026-11-30T12:00:00Z")).toHaveLength(1);
  });
});
