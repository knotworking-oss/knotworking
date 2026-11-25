import { RESERVED_WORKSPACE_SLUGS, isReservedWorkspaceSlug } from "@knotworking/core";
import { workspaces } from "@knotworking/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { slugify } from "./services/setup";
import { SETUP_TOKEN, makeApp, signIn, type TestCtx } from "./test-utils";

describe("workspace slugs", () => {
  it("slugify never produces a reserved slug", () => {
    expect(slugify("API")).toBe("api-workspace");
    expect(slugify("MCP")).toBe("mcp-workspace");
    expect(slugify("Login!")).toBe("login-workspace");
    expect(slugify("Acme Inc")).toBe("acme-inc");
    expect(slugify("!!!")).toBe("workspace");
    for (const reserved of RESERVED_WORKSPACE_SLUGS) {
      expect(isReservedWorkspaceSlug(slugify(reserved))).toBe(false);
    }
  });

  describe("first-run setup", () => {
    let ctx: TestCtx;
    beforeAll(async () => {
      ctx = await makeApp({ seed: false });
    }, 30_000);
    afterAll(() => ctx.handle.close());

    it("creates a reserved-name workspace under a safe slug", async () => {
      const res = await ctx.req("/v1/public/setup", {
        method: "POST",
        json: {
          workspaceName: "MCP",
          name: "Owner",
          email: "owner@mcp.test",
          password: "correct-horse-battery",
          token: SETUP_TOKEN,
        },
      });
      expect(res.status).toBe(201);
      const rows = await ctx.handle.db.select({ slug: workspaces.slug }).from(workspaces);
      expect(rows.map((r) => r.slug)).toEqual(["mcp-workspace"]);
    });
  });
});

describe("first-run workspace preset", () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await makeApp({
      seed: false,
      activeModules: [
        "tasks",
        "docs",
        "time",
        "items",
        "stock",
        "customers",
        "purchase_requests",
        "client_services",
      ],
    });
  }, 30_000);
  afterAll(() => ctx.handle.close());

  it("starts General Business with its available work modules and blocks factory modules", async () => {
    const email = "owner@office.test";
    const password = "correct-horse-battery";
    const setup = await ctx.req("/v1/public/setup", {
      method: "POST",
      json: {
        workspaceName: "Office",
        name: "Owner",
        email,
        password,
        token: SETUP_TOKEN,
        preset: "general_business",
      },
    });
    expect(setup.status).toBe(201);
    const { status, cookie } = await signIn(ctx, email, password);
    expect(status).toBe(200);
    const base = "/v1/workspaces/office";
    const settings = await ctx.req(`${base}/module-settings`, { cookie });
    expect(await settings.json()).toEqual({
      available: [
        "tasks",
        "docs",
        "time",
        "items",
        "stock",
        "customers",
        "purchase_requests",
        "client_services",
      ],
      enabled: ["tasks", "docs", "time", "customers", "purchase_requests", "client_services"],
      followsServer: false,
    });
    expect((await ctx.req(`${base}/tasks`, { cookie })).status).toBe(200);
    expect((await ctx.req(`${base}/purchase-requests`, { cookie })).status).toBe(200);
    expect((await ctx.req(`${base}/client-services`, { cookie })).status).toBe(200);
    expect((await ctx.req(`${base}/items`, { cookie })).status).toBe(404);
    const uninstalled = await ctx.req(`${base}/module-settings`, {
      method: "PATCH",
      cookie,
      json: { modules: ["bi"] },
    });
    expect(uninstalled.status).toBe(400);
    expect((await uninstalled.json()).error.code).toBe("invalid_modules");
  });
});
