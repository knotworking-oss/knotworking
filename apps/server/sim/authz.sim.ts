import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { addDays, modules as moduleDefs, moduleIds, type SyncChange } from "@knotworking/core";
import { World, PASSWORD } from "./lib/world";
import { createMaster, createPeople } from "./lib/setup";
import { Plant } from "./lib/plant";
import { makeRng } from "./lib/rng";
import { runDays } from "./lib/run";
import { replaySync } from "./lib/sync";
import { moduleOfRoute, workspaceSubPath } from "../src/modules/routes";
import { signIn } from "../src/test-utils";

const UUID = "00000000-0000-7000-8000-000000000001";
const out: Record<string, unknown> = {};
const bad: string[] = [];
const flag = (s: string) => {
  bad.push(s);
  console.log("ISSUE", s);
};

describe("authorization probes on a populated workspace", () => {
  const w = new World();
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T06:00:00Z"));
    await w.boot();
  }, 120_000);
  afterAll(() => w.ctx.handle.close());

  it("probes", async () => {
    const rng = makeRng(3);
    w.setDay("2026-10-26");
    await createPeople(w);
    const master = await createMaster(w, rng);
    const plant = new Plant(w, master, rng);
    await plant.raiseOrders("2026-10-26", 2, 0);
    await plant.goodsIn("2026-10-26");
    await plant.qaRelease("2026-10-26");
    await runDays(w, plant, "2026-10-27", "2026-11-03");
    w.setDay("2026-11-04");
    const md = w.people.get("md")!,
      hr = w.people.get("hr")!;
    // staff data with sensitive references exists from the people setup; add a payroll reference.
    const mkUser = async (email: string, role: string) => {
      const inv = await w.call(md, "POST", "/invitations", { email, role });
      await w.call(
        md,
        "POST",
        `/v1/public/invitations/${inv.body.url.split("/invite/")[1]}/accept`,
        { name: email, password: PASSWORD },
        [200],
      );
      const c = (await signIn(w.ctx, email, PASSWORD)).cookie;
      const mem = (await w.call(md, "GET", "/members")).body.members.find((m: any) => m.email === email);
      return {
        key: email,
        email,
        name: email,
        title: "",
        role,
        access: {},
        userId: mem.userId,
        cookie: c,
      } as any;
    };
    const plain = await mkUser("plain2@acme.test", "member");
    const guest = await mkUser("guest2@acme.test", "guest");

    // A. Every GET route as a person with no grants: which modules answer?
    const routes = (w.ctx.app.routes as { method: string; path: string }[]).filter(
      (r) => r.method === "GET" && r.path.startsWith("/v1/workspaces/:slug/") && !/stream/.test(r.path),
    );
    const exposed: Record<string, Record<string, number>> = { plain: {}, guest: {} };
    for (const r of routes) {
      const sub = workspaceSubPath(r.path.replace(":slug", "acme")) ?? "";
      const mod = moduleOfRoute(sub.replace(/:\w+/g, "x")) ?? "unclassified";
      const path = r.path.replace(":slug", "acme").replace(/:(\w+)(\{[^}]*\})?\??/g, UUID);
      for (const [who, u] of [
        ["plain", plain],
        ["guest", guest],
      ] as const) {
        const res = await w.ctx.req(path, { cookie: u.cookie });
        if (res.status !== 401 && res.status !== 403)
          exposed[who]![String(mod)] = (exposed[who]![String(mod)] ?? 0) + 1;
      }
    }
    out.getRoutesReachableWithNoGrants = exposed;
    const roleDefault = new Set(moduleIds.filter((id) => moduleDefs[id].defaultAccess === "role"));
    for (const [who, mods] of Object.entries(exposed))
      for (const [m, n] of Object.entries(mods))
        if (!roleDefault.has(m as never) && m !== "platform")
          flag(`${who} with no grants reaches ${n} GET route(s) of module '${m}'`);

    // B. What does bootstrap and sync hand to someone without access?
    const scan = async (u: any) => {
      const boot = (await w.call(u, "GET", "/bootstrap")).body ?? {};
      const types = new Map<string, number>();
      const grants: SyncChange[] = [];
      for await (const c of replaySync(async (after) => {
        const page = await w.call(u, "GET", `/sync?after=${after}&limit=500`);
        if (!page.ok) throw new Error(`Sync replay failed: ${page.status}`);
        return page.body;
      })) {
        types.set(c.entity, (types.get(c.entity) ?? 0) + 1);
        if (c.entity === "module_access") grants.push(c);
      }
      return { summary: { bootKeys: Object.keys(boot), syncTypes: Object.fromEntries(types) }, grants };
    };
    const mdScan = await scan(md),
      plainScan = await scan(plain),
      guestScan = await scan(guest);
    out.bootstrapAndSync = { md: mdScan.summary, plain: plainScan.summary, guest: guestScan.summary };
    // Whose grants can a guest read through the sync log?
    {
      const rows = guestScan.grants;
      const others = rows.filter((c: any) => c.data && c.data.userId !== guest.userId);
      const sensitive = others.filter(
        (c: any) =>
          ["accounting", "workforce_hr", "people", "costing"].includes(c.data.moduleId) && c.data.level,
      );
      out.guestSeesOthersModuleAccess = {
        rows: rows.length,
        ofOtherPeople: others.length,
        sensitiveModuleGrants: sensitive.length,
        sample: sensitive.slice(0, 2).map((c: any) => c.data),
      };
      if (others.length)
        flag(
          `a guest can read ${others.length} module-access grants belonging to other people through /sync (${sensitive.length} on people/accounting/costing/workforce_hr)`,
        );
    }
    const wsSecret = ["payrollReference", "staffNumber", "unitPrice", "email"];
    const bootPlain = JSON.stringify((await w.call(plain, "GET", "/bootstrap")).body);
    for (const k of wsSecret)
      if (bootPlain.includes(`"${k}"`)) flag(`bootstrap for a member with no grants contains '${k}'`);

    // C. Role escalation and last-owner protection.
    const sole = await w.call(md, "PATCH", `/members/${md.userId}`, { role: "admin" }, [200, 400, 403, 409]);
    if (sole.status === 200) {
      flag("sole owner could demote themselves (workspace would have no owner)");
      await w.call(md, "PATCH", `/members/${md.userId}`, { role: "owner" }, [200, 403]);
    }
    const self = await w.call(md, "POST", `/members/${md.userId}/deactivate`, {}, [200, 204, 400, 403, 409]);
    if (self.status === 200 || self.status === 204) flag("sole owner could deactivate themselves");
    const esc = await w.call(plain, "PATCH", `/members/${plain.userId}`, { role: "admin" }, [403]);
    if (esc.status === 200) flag("member promoted themselves to admin");
    const adminSelfOwner = await w.call(
      hr,
      "PATCH",
      `/members/${hr.userId}`,
      { role: "owner" },
      [200, 400, 403, 409],
    );
    out.adminPromotesSelfToOwner = adminSelfOwner.status;
    if (adminSelfOwner.status === 200) flag("an admin promoted themselves to owner");
    const demoteOwner = await w.call(
      hr,
      "PATCH",
      `/members/${md.userId}`,
      { role: "member" },
      [200, 400, 403, 409],
    );
    out.adminDemotesOwner = demoteOwner.status;
    if (demoteOwner.status === 200) {
      flag("an admin demoted the owner");
      await w.call(md, "PATCH", `/members/${md.userId}`, { role: "owner" }, [200, 403]);
    }
    const invOwner = await w.call(
      hr,
      "POST",
      "/invitations",
      { email: "ownerinvite@acme.test", role: "owner" },
      [201, 400, 403],
    );
    out.adminInvitesOwner = invOwner.status;
    if (invOwner.status === 201) flag("an admin (not owner) invited a new owner");
    const reset = await w.call(hr, "POST", `/members/${md.userId}/password-reset`, {}, [200, 403, 409]);
    out.adminResetsOwnerPassword = reset.status;
    if (reset.status === 200) flag("an admin obtained a password-reset link for the workspace owner");

    // D. Invitation lifecycle.
    const inv = await w.call(md, "POST", "/invitations", { email: "late@acme.test", role: "member" });
    const tok = inv.body.url.split("/invite/")[1];
    const twice = await w.call(
      md,
      "POST",
      "/invitations",
      { email: "late@acme.test", role: "member" },
      [201, 409],
    );
    out.duplicateInvite = twice.status;
    vi.setSystemTime(new Date(Date.now() + 40 * 864e5));
    const exp = await w.ctx.req(`/v1/public/invitations/${tok}`);
    out.inviteAfter40Days = exp.status;
    if (exp.status === 200) flag("a 40-day-old invitation link is still valid");
    vi.setSystemTime(new Date(Date.now() - 40 * 864e5));
    const exist = await w.call(
      md,
      "POST",
      "/invitations",
      { email: plain.email, role: "member" },
      [201, 400, 409],
    );
    out.inviteExistingMember = exist.status;

    // E. Sessions.
    const so = await signIn(w.ctx, "plain2@acme.test", PASSWORD);
    const before = await w.ctx.req(`/v1/workspaces/acme/bootstrap`, { cookie: so.cookie });
    await w.ctx.req("/api/auth/sign-out", { method: "POST", cookie: so.cookie, json: {} });
    const after = await w.ctx.req(`/v1/workspaces/acme/bootstrap`, { cookie: so.cookie });
    out.cookieAfterSignOut = { before: before.status, after: after.status };
    if (after.status === 200) flag("session cookie still works after sign-out");
    const tampered = await w.ctx.req(`/v1/workspaces/acme/bootstrap`, {
      cookie: plain.cookie.replace(/.$/, (c: string) => (c === "a" ? "b" : "a")),
    });
    if (tampered.status === 200) flag("tampered session cookie accepted");
    const s1 = (await signIn(w.ctx, "plain2@acme.test", PASSWORD)).cookie,
      s2 = (await signIn(w.ctx, "plain2@acme.test", PASSWORD)).cookie;
    const pw = await w.ctx.req("/api/auth/change-password", {
      method: "POST",
      cookie: s1,
      json: { currentPassword: PASSWORD, newPassword: "a-new-password-98765", revokeOtherSessions: true },
    });
    const other = await w.ctx.req(`/v1/workspaces/acme/bootstrap`, { cookie: s2 });
    out.otherSessionAfterPasswordChange = { change: pw.status, other: other.status };
    if (pw.status === 200 && other.status === 200)
      flag("another session survived a password change that asked to revoke others");

    // F. Cross-origin writes with a cookie.
    const task = { title: "csrf" };
    const mk = (headers: Record<string, string>) =>
      w.ctx.app.request(`/v1/workspaces/acme/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: guest.cookie.length ? md.cookie : md.cookie,
          ...headers,
        },
        body: JSON.stringify(task),
      });
    const foreign = await mk({ origin: "https://evil.example" });
    const none = await mk({});
    out.csrf = { foreignOrigin: foreign.status, noOrigin: none.status };
    if (foreign.status < 400) flag("cookie-authenticated write accepted from a foreign Origin");
    if (none.status < 400) flag("cookie-authenticated write accepted with no Origin header");

    // G. Writing into another record's scope: a body that names another workspace or a made-up team.
    const t = await w.call(
      md,
      "POST",
      "/tasks",
      { title: "x", teamId: UUID, workspaceId: UUID },
      [400, 404, 422],
    );
    if (t.status === 201) flag("task created in a team that does not exist");

    out.issues = bad;
    mkdirSync("sim/out", { recursive: true });
    writeFileSync("sim/out/authz.json", JSON.stringify(out, null, 2));
    console.log("AUTHZ", JSON.stringify({ issues: bad.length, ...out }).slice(0, 6000));
  }, 1_800_000);
});
