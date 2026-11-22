import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

describe("invitations when email delivery fails", () => {
  let ctx: TestCtx;
  let ada: string;
  const failingMailer = {
    configured: true,
    async send() {
      throw new Error("connect ECONNREFUSED 127.0.0.1:2525");
    },
  };
  beforeAll(async () => {
    ctx = await makeApp({ seed: true, mailer: failingMailer });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("still creates the invitation and returns the link with emailed:false", async () => {
    const res = await ctx.req("/v1/workspaces/acme/invitations", {
      method: "POST",
      cookie: ada,
      json: { email: "nora@example.com", role: "member" },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.emailed).toBe(false);
    expect(body.mailError).toMatch(/couldn't be sent.*ECONNREFUSED/);
    expect(body.url).toMatch(/\/invite\/.+/);
    expect(body.invitation).toMatchObject({ email: "nora@example.com", role: "member" });

    // The returned link works, and the invitation is listed for resending.
    const token = body.url.split("/invite/")[1];
    expect((await ctx.req(`/v1/public/invitations/${token}`)).status).toBe(200);
    const { invitations } = await (await ctx.req("/v1/workspaces/acme/invitations", { cookie: ada })).json();
    expect(invitations.map((i: { email: string }) => i.email)).toContain("nora@example.com");
  });
});

describe("invitations with a working mailer", () => {
  it("reports emailed:true and no mailError", async () => {
    const ctx = await makeApp({ seed: true });
    try {
      const ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
      const body = await (
        await ctx.req("/v1/workspaces/acme/invitations", {
          method: "POST",
          cookie: ada,
          json: { email: "ok@example.com", role: "member" },
        })
      ).json();
      expect(body.emailed).toBe(true);
      expect(body.mailError).toBeUndefined();
    } finally {
      await ctx.handle.close();
    }
  }, 60_000);
});
