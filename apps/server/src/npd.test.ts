import { moduleIds } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = new Date().toISOString().slice(0, 10);

describe("product development module", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  const ok = async (res: Response, status = 200): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const fails = async (res: Response, status: number, code?: string): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    if (code) expect(body.error?.code).toBe(code);
    return body;
  };
  const status = (p: { checklist: { key: string; status: string }[] }, key: string) =>
    p.checklist.find((c) => c.key === key)?.status;

  let tart: string;
  let flour: string;
  let recipe: string;
  let project: string;

  beforeAll(async () => {
    // Labels are switched off here, so the label check doesn't apply.
    ctx = await makeApp({ seed: true, activeModules: moduleIds.filter((m) => m !== "labels") });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "t", scope: "write" },
        })
      ).json()
    ).token;
    flour = (
      await ok(
        await as(ada).send("POST", "/items", { code: "FLR", name: "Flour", type: "ingredient", unit: "kg" }),
        201,
      )
    ).id;
    tart = (
      await ok(
        await as(ada).send("POST", "/items", {
          code: "TART",
          name: "Lemon tart",
          type: "finished",
          unit: "each",
          unitWeightG: 300,
        }),
        201,
      )
    ).id;
    recipe = (
      await ok(
        await as(ada).send("POST", "/recipes", {
          code: "R-TART",
          name: "Lemon tart",
          outputItemId: tart,
          draft: {
            yieldQuantity: 10,
            yieldUnit: "each",
            lines: [{ itemId: flour, quantity: 1, unit: "kg" }],
          },
        }),
        201,
      )
    ).id;
  });

  afterAll(() => ctx.handle.close());

  it("is opt-in and needs Items, Food items and Recipes", async () => {
    expect((await as(marcus.cookie).get("/npd/projects")).status).toBe(403);
    for (const [mod, level] of [
      ["npd", "write"],
      ["items", "read"],
      ["recipes", "read"],
    ] as const) {
      await ctx.req(`${WS}/members/${marcus.userId}/module-access/${mod}`, {
        method: "PUT",
        cookie: ada,
        json: { level },
      });
    }
    expect((await as(marcus.cookie).get("/npd/projects")).status).toBe(403);
    await ctx.req(`${WS}/members/${marcus.userId}/module-access/food_items`, {
      method: "PUT",
      cookie: ada,
      json: { level: "read" },
    });
    await ok(await as(marcus.cookie).get("/npd/projects"));
  });

  it("starts a project from a brief, with a checklist of what launch needs", async () => {
    const created = await ok(
      await viaToken("POST", "/npd/projects", {
        code: "NPD-001",
        name: "Lemon tart for Corner Shop",
        brief: "An individual lemon tart for the chilled range",
        customerName: "Corner Shop Ltd",
        targetLaunchOn: "2099-03-01",
        targetShelfLifeDays: 10,
        storage: "chilled",
        claims: ["Vegetarian"],
      }),
      201,
    );
    project = created.id;
    expect(created).toMatchObject({ status: "brief", readyToLaunch: false });
    expect(created.checklist.map((c: { key: string; status: string }) => [c.key, c.status])).toEqual([
      ["brief_complete", "met"],
      ["product_linked", "missing"],
      ["recipe_approved", "missing"],
      ["factory_trial", "missing"],
      ["shelf_life", "missing"],
      ["specification", "missing"],
      ["label", "na"],
      ["haccp_reviewed", "missing"],
      ["artwork_agreed", "missing"],
      ["customer_signoff", "missing"],
    ]);
    await fails(
      await as(ada).send("POST", "/npd/projects", { code: "npd-001", name: "Dup" }),
      409,
      "code_taken",
    );
    // A recipe must make the linked item.
    await fails(await as(ada).send("PATCH", `/npd/projects/${project}`, { outputItemId: flour }), 400);
    const linked = await ok(
      await as(ada).send("PATCH", `/npd/projects/${project}`, { outputItemId: tart, recipeId: recipe }),
    );
    expect(status(linked, "product_linked")).toBe("met");
  });

  it("records trials and proves the shelf life against the target", async () => {
    const version = (await ok(await as(ada).get(`/recipes/${recipe}`))).currentVersion.id;
    await fails(
      await as(ada).send("POST", `/npd/projects/${project}/trials`, {
        kind: "shelf_life",
        heldOn: today,
        description: "Chilled storage at 5 °C",
        outcome: "pass",
      }),
      400,
    );
    const short = await ok(
      await viaToken("POST", `/npd/projects/${project}/trials`, {
        kind: "shelf_life",
        heldOn: today,
        description: "Chilled storage at 5 °C",
        outcome: "pass",
        achievedShelfLifeDays: 8,
        storage: "chilled",
      }),
      201,
    );
    // The first trial moves the project on to trials.
    expect(short.status).toBe("trials");
    expect(short.checklist.find((c: { key: string }) => c.key === "shelf_life").detail).toContain(
      "short of the 10-day target",
    );
    await ok(
      await as(ada).send("POST", `/npd/projects/${project}/trials`, {
        kind: "shelf_life",
        heldOn: today,
        description: "Reformulated with lower water activity",
        outcome: "pass",
        achievedShelfLifeDays: 12,
      }),
      201,
    );
    const factory = await ok(
      await as(ada).send("POST", `/npd/projects/${project}/trials`, {
        kind: "factory",
        heldOn: today,
        description: "Line 2, 200 units",
        recipeVersionId: version,
        outcome: "pass",
      }),
      201,
    );
    expect(status(factory, "shelf_life")).toBe("met");
    expect(status(factory, "factory_trial")).toBe("met");
    expect(factory.trials.map((t: { trialNumber: number }) => t.trialNumber)).toEqual([3, 2, 1]);
    expect(factory.trials[0].recipeVersionNumber).toBe(1);
  });

  it("refuses to launch until every check is met, then launches by a person with manage", async () => {
    const blocked = await fails(
      await as(ada).send("POST", `/npd/projects/${project}/launch`),
      409,
      "not_ready",
    );
    expect(blocked.error.message).toContain("Recipe approved");
    await ok(await as(ada).send("POST", `/recipes/${recipe}/draft/approve`));
    await ok(
      await as(ada).send("POST", "/specifications", {
        code: "SPEC-TART",
        title: "Lemon tart",
        itemId: tart,
        customerName: "Corner Shop Ltd",
        draft: {
          storage: "chilled",
          shelfLifeDays: 10,
          reviewDueOn: "2099-01-01",
          agreedBy: "Buyer",
          agreedOn: today,
        },
      }),
      201,
    );
    const spec = (await ok(await as(ada).get("/specifications?itemId=" + tart))).specifications[0].id;
    await ctx.req(`${WS}/members/${marcus.userId}/module-access/specifications`, {
      method: "PUT",
      cookie: ada,
      json: { level: "manage" },
    });
    await ok(await as(marcus.cookie).send("POST", `/specifications/${spec}/draft/approve`));

    // Sign-offs are people's, never a token's; a customer sign-off needs a named customer.
    const signoff = { key: "haccp_reviewed", by: "Ada Park", on: today };
    expect((await viaToken("POST", `/npd/projects/${project}/signoffs`, signoff)).status).toBe(403);
    await ok(await as(ada).send("POST", `/npd/projects/${project}/signoffs`, signoff));
    await ok(
      await as(marcus.cookie).send("POST", `/npd/projects/${project}/signoffs`, {
        key: "artwork_agreed",
        by: "Design agency",
        on: today,
        reference: "Proof v3",
      }),
    );
    let p = await ok(
      await as(ada).send("POST", `/npd/projects/${project}/signoffs`, {
        key: "customer_signoff",
        by: "J. Buyer",
        on: today,
        reference: "PO-778",
      }),
    );
    expect(p.readyToLaunch).toBe(true);
    expect(p.checklist.find((c: { key: string }) => c.key === "customer_signoff").detail).toBe(
      `J. Buyer on ${today} (PO-778)`,
    );

    expect((await viaToken("POST", `/npd/projects/${project}/launch`)).status).toBe(403);
    expect((await as(marcus.cookie).send("POST", `/npd/projects/${project}/launch`)).status).toBe(403);
    p = await ok(await as(ada).send("POST", `/npd/projects/${project}/launch`));
    expect(p).toMatchObject({ status: "launched" });
    expect(p.launchedByName).toBeTruthy();
    // A launched project's record no longer changes.
    await fails(
      await as(ada).send("PATCH", `/npd/projects/${project}`, { name: "x" }),
      409,
      "project_closed",
    );
    await fails(
      await as(ada).send("POST", `/npd/projects/${project}/trials`, {
        kind: "sensory",
        heldOn: today,
        description: "x",
        outcome: "pass",
      }),
      409,
      "project_closed",
    );
  });

  it("cancels with a reason, lists open projects and syncs to readers", async () => {
    const other = await ok(
      await as(ada).send("POST", "/npd/projects", { code: "NPD-002", name: "Vegan brownie" }),
      201,
    );
    expect(other.checklist.find((c: { key: string }) => c.key === "customer_signoff").status).toBe("na");
    await fails(
      await as(ada).send("POST", `/npd/projects/${other.id}/signoffs`, {
        key: "customer_signoff",
        by: "x",
        on: today,
      }),
      400,
    );
    await fails(await as(ada).send("PATCH", `/npd/projects/${other.id}`, { status: "cancelled" }), 400);
    await ok(
      await as(ada).send("PATCH", `/npd/projects/${other.id}`, {
        status: "cancelled",
        cancelReason: "Customer withdrew",
      }),
    );
    expect((await ok(await as(ada).get("/npd/projects"))).projects).toEqual([]);
    const all = await ok(await as(ada).get("/npd/projects?status=all"));
    expect(all.projects.map((p: { code: string; trialCount: number }) => [p.code, p.trialCount])).toEqual([
      ["NPD-001", 3],
      ["NPD-002", 0],
    ]);
    const page = await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie: marcus.cookie })).json();
    expect(page.changes.some((c: { entity: string }) => c.entity === "npd_trial")).toBe(true);
  });
});
