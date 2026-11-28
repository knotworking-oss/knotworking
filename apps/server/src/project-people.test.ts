import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

describe("project contributors and followers", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: string;
  let leadId: string;
  let memberId: string;
  const call = (path: string, method = "GET", json?: unknown, cookie = ada) =>
    ctx.req(`/v1/workspaces/acme${path}`, { method, cookie, json });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const boot = await (await call("/bootstrap")).json();
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
});
