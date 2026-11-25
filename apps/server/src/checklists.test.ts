import { addDays, DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

async function body(res: Res, status = 200) {
  const json = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(status);
  return json;
}

describe("standalone Checklists", () => {
  let ctx: TestCtx;
  let cookie: string;
  let token: string;

  const req = (path: string, method = "GET", json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const viaToken = (path: string, method = "GET", json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  const template = async () =>
    body(
      await req("/checklists/templates", "POST", {
        name: "Office close",
        frequency: { every: 1, unit: "day" },
        items: [{ prompt: "Secure the entrance" }, { prompt: "Turn off the lights" }],
      }),
      201,
    );

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, activeModules: ["checklists"] });
    cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    token = (
      await body(
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie,
          json: { name: "agent", scope: "write", modules: ["checklists"] },
        }),
        201,
      )
    ).token;
  }, 60_000);
  afterAll(() => ctx?.handle.close());

  it("runs recurring and on-demand templates with no other module", async () => {
    const daily = await template();
    const oneOff = await body(
      await req("/checklists/templates", "POST", {
        name: "Move office",
        items: [{ prompt: "Hand over keys" }],
      }),
      201,
    );
    expect(daily).toMatchObject({
      kind: "general",
      due: { state: "due" },
      frequency: { every: 1, unit: "day" },
    });
    expect(oneOff).toMatchObject({ due: null });

    const due = await body(await req("/checklists/due"));
    expect(due.items).toEqual([expect.objectContaining({ subjectId: daily.id, state: "due" })]);

    const performedAt = new Date().toISOString();
    const check = await body(
      await req("/checklists/checks", "POST", {
        templateId: daily.id,
        performedAt,
        results: daily.items.map((item: { id: string }) => ({ itemId: item.id, result: "pass" })),
      }),
      201,
    );
    expect(check).toMatchObject({ outcome: "passed", signOffStatus: "not_required", awaitingSignOff: false });
    const after = await body(await req("/checklists/due?include=all"));
    expect(after.items[0]).toMatchObject({
      subjectId: daily.id,
      dueOn: addDays(todayInZone(DEFAULT_TIME_ZONE), 1),
    });
    expect((await body(await req("/site/due"), 404)).error.code).toBe("module_inactive");
  });

  it("opens, supersedes and resolves follow-ups while retaining original results", async () => {
    const daily = await template();
    const [door, lights] = daily.items;
    const failing = [
      { itemId: door.id, result: "fail", note: "Door latch needs replacement" },
      { itemId: lights.id, result: "pass" },
    ];
    expect(
      (
        await body(
          await viaToken("/checklists/checks", "POST", { templateId: daily.id, results: failing }),
          403,
        )
      ).error.code,
    ).toBe("token_not_allowed");
    const failed = await body(
      await req("/checklists/checks", "POST", { templateId: daily.id, results: failing }),
      201,
    );
    const initial = (await body(await req("/checklists/actions"))).actions[0];
    expect(initial).toMatchObject({
      status: "open",
      checkId: failed.id,
      failures: [
        expect.objectContaining({ prompt: "Secure the entrance", note: "Door latch needs replacement" }),
      ],
    });

    await body(
      await req(`/checklists/templates/${daily.id}`, "PATCH", {
        items: [
          { id: door.id, prompt: "Lock the outside door" },
          { id: lights.id, prompt: lights.prompt },
        ],
      }),
    );
    const replacement = await body(
      await req(`/checklists/checks/${failed.id}/correct`, "POST", {
        reason: "The latch was broken before the inspection",
        results: failing,
      }),
      201,
    );
    expect(replacement.results[0].prompt).toBe("Secure the entrance");
    expect((await body(await req("/checklists/actions?status=superseded"))).actions).toMatchObject([
      { id: initial.id, status: "superseded" },
    ]);
    const opened = (await body(await req("/checklists/actions"))).actions;
    expect(opened).toMatchObject([{ status: "open", checkId: replacement.id }]);

    const resolve = `/checklists/actions/${opened[0].id}/resolve`;
    expect(
      (await body(await viaToken(resolve, "POST", { note: "Replaced the latch" }), 403)).error.code,
    ).toBe("token_not_allowed");
    const resolution = await body(await req(resolve, "POST", { note: "Replaced the latch" }));
    expect(resolution).toMatchObject({ status: "resolved", resolution: "Replaced the latch" });
    expect((await body(await req("/checklists/actions"))).actions).toEqual([]);
    expect((await body(await req(`/checklists/checks/${failed.id}`))).correctedByCheckId).toBe(
      replacement.id,
    );
    const sync = await body(await req("/sync?after=0&limit=1000"));
    expect(sync.changes.some(({ entity }: { entity: string }) => entity === "checklist_action")).toBe(true);
  });
});

describe("the Site checklist extension", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, activeModules: ["assets", "site", "checklists"] });
    const owner = await signIn(ctx, "ada@knotworking.dev");
    ada = owner.cookie;
    const member = await signIn(ctx, "marcus@knotworking.dev");
    marcus = { cookie: member.cookie, userId: member.body.user.id };
  }, 60_000);
  afterAll(() => ctx?.handle.close());

  it("keeps general and Site templates in their own access scopes", async () => {
    const create = (path: string, json: unknown) =>
      ctx.req(`${WS}${path}`, { method: "POST", cookie: ada, json });
    const items = [{ prompt: "Check the first line" }];
    const food = await body(
      await create("/site/checklists/templates", {
        name: "Food pre-start",
        kind: "prestart",
        frequency: { every: 1, unit: "day" },
        items,
      }),
      201,
    );
    const general = await body(await create("/checklists/templates", { name: "Open shop", items }), 201);
    for (const [module, level] of [
      ["assets", "read"],
      ["site", "read"],
    ]) {
      await body(
        await ctx.req(`${WS}/members/${marcus.userId}/module-access/${module}`, {
          method: "PUT",
          cookie: ada,
          json: { level },
        }),
      );
    }
    const read = (path: string, cookie = marcus.cookie) => ctx.req(`${WS}${path}`, { cookie });
    const before = await body(await read("/site/due?programme=checklist&include=all"));
    expect(before.items).toEqual([]);
    expect((await body(await read("/site/checklists/templates"), 403)).error.code).toBe("module_forbidden");

    await body(
      await ctx.req(`${WS}/members/${marcus.userId}/module-access/checklists`, {
        method: "PUT",
        cookie: ada,
        json: { level: "read" },
      }),
    );
    expect((await body(await read("/site/checklists/templates"))).templates).toMatchObject([{ id: food.id }]);
    expect((await body(await read("/checklists/templates"))).templates).toMatchObject([{ id: general.id }]);
    await body(await read(`/checklists/templates/${food.id}`, ada), 404);
    await body(await read(`/site/checklists/templates/${general.id}`, ada), 404);
    await body(
      await create("/site/checklists/templates", { name: "Wrong scope", kind: "general", items }),
      400,
    );
    await body(await create("/checklists/templates", { name: "Wrong scope", kind: "prestart", items }), 400);
    const after = await body(await read("/site/due?programme=checklist&include=all"));
    expect(after.items).toMatchObject([{ subjectId: food.id }]);
  });
});
