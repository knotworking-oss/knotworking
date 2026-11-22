import { moduleIds } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { biCacheStats, resetBiCache } from "./services/bi/cache";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

/** The BI result cache: exact answers, shared only within an access class. */
describe("BI result cache", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: string;
  let teamId: string;
  const count = async (cookie: string) => {
    const spec = { dataset: "tasks", measures: ["task_count"] };
    const res = await ctx.req(`${WS}/bi/query?spec=${encodeURIComponent(JSON.stringify(spec))}`, { cookie });
    expect(res.status).toBe(200);
    return (await res.json()).rows[0].task_count as number;
  };

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, activeModules: moduleIds });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    teamId = (await (await ctx.req(`${WS}/bootstrap`, { cookie: ada })).json()).teams[0].id;
    resetBiCache();
  }, 120_000);
  afterAll(() => ctx.handle.close());

  it("answers a repeated query from the cache, and recomputes once data changes", async () => {
    const first = await count(ada);
    expect(biCacheStats()).toMatchObject({ hits: 0, misses: 1 });
    expect(await count(ada)).toBe(first);
    expect(biCacheStats()).toMatchObject({ hits: 1, misses: 1 });
    // Any recorded write moves the sync log, so the next answer is computed afresh.
    const res = await ctx.req(`${WS}/tasks`, { method: "POST", cookie: ada, json: { teamId, title: "New" } });
    expect(res.status).toBe(201);
    expect(await count(ada)).toBe(first + 1);
    expect(biCacheStats()).toMatchObject({ hits: 1, misses: 2 });
  });

  it("keeps answers apart for people with different access, and never caches refusals", async () => {
    resetBiCache();
    await count(ada);
    await count(marcus);
    expect(biCacheStats()).toMatchObject({ hits: 0, misses: 2 });
    const spec = encodeURIComponent(
      JSON.stringify({ dataset: "purchase_orders", measures: ["order_count"] }),
    );
    expect((await ctx.req(`${WS}/bi/query?spec=${spec}`, { cookie: marcus })).status).toBe(403);
    expect((await ctx.req(`${WS}/bi/query?spec=${spec}`, { cookie: marcus })).status).toBe(403);
    expect(biCacheStats().entries).toBe(2);
  });
});
