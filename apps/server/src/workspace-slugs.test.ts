import { RESERVED_WORKSPACE_SLUGS, isReservedWorkspaceSlug } from "@knotworking/core";
import { workspaces } from "@knotworking/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { slugify } from "./services/setup";
import { SETUP_TOKEN, makeApp, type TestCtx } from "./test-utils";

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
