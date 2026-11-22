import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("org chart", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcusCookie: string;
  const ids: Record<string, string> = {};
  const profile = (cookie: string, userId: string, json: unknown) =>
    ctx.req(`${WS}/members/${userId}/profile`, { method: "PATCH", cookie, json });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcusCookie = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    for (const m of members) ids[m.email.split("@")[0]] = m.userId;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("lets admins set title, department and manager, shown in members and bootstrap", async () => {
    const res = await profile(ada, ids.marcus!, {
      title: "Head of Technical",
      department: "Technical",
      reportsToUserId: ids.ada,
    });
    expect(res.status).toBe(200);
    await profile(ada, ids.priya!, {
      title: "QA Technician",
      department: "Technical",
      reportsToUserId: ids.marcus,
    });
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: marcusCookie })).json();
    expect(members.find((m: { userId: string }) => m.userId === ids.marcus)).toMatchObject({
      title: "Head of Technical",
      department: "Technical",
      reportsToUserId: ids.ada,
    });
    const boot = await (await ctx.req(`${WS}/bootstrap`, { cookie: marcusCookie })).json();
    expect(boot.users.find((u: { id: string }) => u.id === ids.priya)).toMatchObject({
      title: "QA Technician",
      reportsToUserId: ids.marcus,
    });
    // Only what is sent changes; blank clears.
    await profile(ada, ids.marcus!, { department: " " });
    const after = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    expect(after.members.find((m: { userId: string }) => m.userId === ids.marcus)).toMatchObject({
      title: "Head of Technical",
      department: null,
    });
  });

  it("refuses loops, self-reporting and managers who aren't active members", async () => {
    const loop = await profile(ada, ids.ada!, { reportsToUserId: ids.priya });
    expect(loop.status).toBe(409);
    expect((await loop.json()).error.code).toBe("reporting_cycle");
    expect((await profile(ada, ids.ada!, { reportsToUserId: ids.ada })).status).toBe(400);
    expect(
      (await profile(ada, ids.ada!, { reportsToUserId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" })).status,
    ).toBe(400);
  });

  it("is an admin's to edit, and never a token's", async () => {
    expect((await profile(marcusCookie, ids.marcus!, { title: "CEO" })).status).toBe(403);
    const { token } = await (
      await ctx.req("/v1/me/api-tokens", { method: "POST", cookie: ada, json: { name: "t", scope: "write" } })
    ).json();
    const viaToken = await ctx.req(`${WS}/members/${ids.marcus}/profile`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, origin: "" },
      json: { title: "x" },
    });
    expect(viaToken.status).toBe(403);
  });

  it("keeps the org chart from guests, like the team's email addresses", async () => {
    await ctx.req(`${WS}/members/${ids.noor}`, { method: "PATCH", cookie: ada, json: { role: "guest" } });
    const guest = (await signIn(ctx, "noor@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: guest })).json();
    expect(members.find((m: { userId: string }) => m.userId === ids.marcus)).toMatchObject({
      email: "",
      title: null,
      department: null,
      reportsToUserId: null,
    });
    const boot = await (await ctx.req(`${WS}/bootstrap`, { cookie: guest })).json();
    expect(boot.users.find((u: { id: string }) => u.id === ids.marcus)).toMatchObject({
      title: null,
      reportsToUserId: null,
    });
    const page = await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie: guest })).json();
    const leaked = page.changes.filter(
      (c: { entity: string; data: Record<string, unknown> | null }) =>
        c.entity === "workspace_member" && (c.data?.title || c.data?.reportsToUserId),
    );
    expect(leaked).toEqual([]);
  });

  it("refuses to change a deactivated member's place", async () => {
    await ctx.req(`${WS}/members/${ids.tomas}/deactivate`, { method: "POST", cookie: ada });
    const res = await profile(ada, ids.tomas!, { title: "Production Manager" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("member_deactivated");
  });

  it("writes the change to the sync log so open clients refresh", async () => {
    const page = await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie: ada })).json();
    const change = page.changes
      .filter((c: { entity: string }) => c.entity === "workspace_member")
      .find((c: { data: { title?: string } | null }) => c.data?.title === "Head of Technical");
    expect(change).toBeTruthy();
  });
});
