import { afterAll, beforeAll, describe, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { createPasswordUser, workspaceMembers, workspaces } from "@knotworking/db";
import { newId } from "@knotworking/core";
import { makeApp, signIn, type TestCtx } from "../src/test-utils";

const UUID = "00000000-0000-7000-8000-000000000001";

describe("route sweep", () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await makeApp({ seed: true, publicRateLimit: { max: 1_000_000, windowMs: 60_000 } });
  }, 120_000);
  afterAll(() => ctx.handle.close());

  it("sweeps every route", async () => {
    const routes = (ctx.app.routes as { method: string; path: string }[])
      .filter((r) => r.method !== "ALL" && !/stream|\/events$|\/sync\/stream/.test(r.path))
      .map((r) => ({
        method: r.method,
        path: r.path.replace(/:slug/g, "acme").replace(/:(\w+)(\{[^}]*\})?\??/g, UUID),
      }));
    const seen = new Set<string>();
    const uniq = routes.filter((r) => (seen.has(r.method + r.path) ? false : seen.add(r.method + r.path)));
    console.log("ROUTES", routes.length, "unique", uniq.length);

    const ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    // A second tenant with its own admin.
    const { db } = ctx.handle;
    const other = await createPasswordUser(db, {
      email: "boss@other-tenant.test",
      name: "Other Boss",
      password: "other-password-123",
    });
    const [ws2] = await db
      .insert(workspaces)
      .values({ slug: "othertenant", name: "Other tenant" })
      .returning();
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws2!.id, userId: other.id, role: "owner" } as never);
    const boss = (await signIn(ctx, "boss@other-tenant.test", "other-password-123")).cookie;
    // A guest and a member with no module grants in acme.
    for (const [email, role] of [
      ["guest@acme.test", "guest"],
      ["plain@acme.test", "member"],
    ] as const) {
      const inv = await (
        await ctx.req("/v1/workspaces/acme/invitations", {
          method: "POST",
          cookie: ada,
          json: { email, role },
        })
      ).json();
      await ctx.req(`/v1/public/invitations/${inv.url.split("/invite/")[1]}/accept`, {
        method: "POST",
        json: { name: email, password: "plain-password-123" },
      });
    }
    const guest = (await signIn(ctx, "guest@acme.test", "plain-password-123")).cookie;
    const plain = (await signIn(ctx, "plain@acme.test", "plain-password-123")).cookie;

    const hist: Record<string, number> = {};
    const hit = async (r: { method: string; path: string }, cookie: string | undefined, json?: unknown) => {
      const res = await ctx.req(r.path, {
        method: r.method,
        cookie,
        json: r.method === "GET" || r.method === "DELETE" ? undefined : json,
      });
      hist[`${r.method === "GET" ? "R" : "W"}${Math.floor(res.status / 100)}xx`] =
        (hist[`${r.method === "GET" ? "R" : "W"}${Math.floor(res.status / 100)}xx`] ?? 0) + 1;
      return res.status;
    };
    const out: Record<string, string[]> = {
      unauth_2xx: [],
      cross_tenant_2xx: [],
      guest_write_2xx: [],
      plain_member_write_2xx: [],
      server_500: [],
      empty_body_500: [],
      garbage_body_500: [],
    };
    const ws = uniq.filter((r) => r.path.startsWith("/v1/workspaces/acme"));
    for (const r of uniq) {
      const tag = `${r.method} ${r.path.replaceAll(UUID, ":id")}`;
      const isPublic =
        r.path.startsWith("/v1/public") ||
        r.path.startsWith("/api/auth") ||
        r.path === "/health" ||
        r.path === "/";
      if (!isPublic) {
        const s = await hit(r, undefined, {});
        if (s >= 200 && s < 300) out.unauth_2xx!.push(`${tag} ${s}`);
        if (s >= 500) out.server_500!.push(`unauth ${tag} ${s}`);
      }
    }
    for (const r of ws) {
      const tag = `${r.method} ${r.path.replaceAll(UUID, ":id").replace("/v1/workspaces/acme", "")}`;
      const mut = r.method !== "GET";
      let s = await hit(r, boss, {});
      if (s >= 200 && s < 300) out.cross_tenant_2xx!.push(`${tag} ${s}`);
      if (s >= 500) out.server_500!.push(`cross-tenant ${tag} ${s}`);
      if (mut) {
        s = await hit(r, guest, {});
        if (s >= 200 && s < 300) out.guest_write_2xx!.push(`${tag} ${s}`);
        if (s >= 500) out.server_500!.push(`guest ${tag} ${s}`);
        s = await hit(r, plain, {});
        if (s >= 200 && s < 300) out.plain_member_write_2xx!.push(`${tag} ${s}`);
        if (s >= 500) out.server_500!.push(`plain ${tag} ${s}`);
      }
      // Robustness as the owner: empty and hostile input must be a 4xx, never a 500.
      s = await hit(r, ada, mut ? {} : undefined);
      if (s >= 500) out.empty_body_500!.push(`${tag} ${s}`);
      if (mut) {
        s = await hit(r, ada, {
          id: UUID,
          name: "x".repeat(70_000),
          lines: "nope",
          quantity: -1,
          commandId: "not-a-uuid",
          expectedRevision: "x",
          amount: 1e308,
        });
        if (s >= 500) out.garbage_body_500!.push(`${tag} ${s}`);
      }
    }
    mkdirSync("sim/out", { recursive: true });
    writeFileSync(
      "sim/out/route-sweep.json",
      JSON.stringify({ routes: uniq.length, workspaceRoutes: ws.length, ...out }, null, 2),
    );
    console.log("HIST", JSON.stringify(hist), "workspace routes", ws.length);
    console.log(
      "SWEEP",
      JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]))),
    );
    for (const [k, v] of Object.entries(out)) for (const line of v.slice(0, 40)) console.log("  ", k, line);
  }, 3_000_000);
});
