import { DEFAULT_TIME_ZONE, STAFF_PIN_MAX_ATTEMPTS, todayInZone } from "@knotworking/core";
import { staff } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveStaffPinKey, changeOwnStaffPin, verifyStaffPin } from "./services/people";
import { makeApp, signIn, TEST_SECRET, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("people module", () => {
  let ctx: TestCtx;
  let ada: string;
  let workspaceId: string;
  let marcus: { cookie: string; userId: string };
  const key = deriveStaffPinKey(TEST_SECRET);
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const grant = (level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/people`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    const bootstrap = await (await ctx.req(`${WS}/bootstrap`, { cookie: ada })).json();
    workspaceId = bootstrap.workspace.id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("access", () => {
    it("is opt-in: a member needs a grant, and read can't write", async () => {
      expect((await as(marcus.cookie).get("/people/staff")).status).toBe(403);
      await grant("read");
      expect((await as(marcus.cookie).get("/people/staff")).status).toBe(200);
      const write = await as(marcus.cookie).send("POST", "/people/staff", { firstName: "A", lastName: "B" });
      expect(write.status).toBe(403);
      await grant("write");
    });

    it("is switched off with the module", async () => {
      const off = await makeApp({ seed: true, activeModules: ["tasks", "docs"] });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const res = await off.req(`${WS}/people/staff`, { cookie });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("module_inactive");
      await off.handle.close();
    }, 60_000);
  });

  describe("job roles", () => {
    it("creates, renames, archives and refuses duplicate names", async () => {
      const res = await as(marcus.cookie).send("POST", "/people/job-roles", { name: "Line operative" });
      expect(res.status).toBe(201);
      const role = await res.json();
      expect(role).toMatchObject({ name: "Line operative", status: "active" });
      const dupe = await as(ada).send("POST", "/people/job-roles", { name: "line OPERATIVE" });
      expect(dupe.status).toBe(409);
      expect((await dupe.json()).error.code).toBe("name_taken");
      const archived = await as(ada).send("PATCH", `/people/job-roles/${role.id}`, { status: "archived" });
      expect((await archived.json()).status).toBe("archived");
      const active = await (await as(ada).get("/people/job-roles")).json();
      expect(active.jobRoles.map((r: { id: string }) => r.id)).not.toContain(role.id);
      const all = await (await as(ada).get("/people/job-roles?status=all")).json();
      expect(all.jobRoles.map((r: { id: string }) => r.id)).toContain(role.id);
      await as(ada).send("PATCH", `/people/job-roles/${role.id}`, { status: "active" });
    });
  });

  describe("staff", () => {
    let roles: { id: string; name: string }[];
    let graceId: string;

    beforeAll(async () => {
      roles = [];
      for (const name of ["Hygiene", "First aider"]) {
        roles.push(await (await as(ada).send("POST", "/people/job-roles", { name })).json());
      }
    });

    it("suggests staff numbers from 100001 and keeps leading zeros", async () => {
      expect(await (await as(ada).get("/people/staff-number")).json()).toEqual({ next: "100001" });
      const auto = await as(marcus.cookie).send("POST", "/people/staff", {
        firstName: "Grace",
        lastName: "Hopper",
        department: "Production",
        startDate: "2026-01-05",
        jobRoleIds: roles.map((r) => r.id),
      });
      expect(auto.status).toBe(201);
      const grace = await auto.json();
      graceId = grace.id;
      expect(grace).toMatchObject({
        staffNumber: "100001",
        status: "active",
        hasPin: false,
        pinLockedUntil: null,
        user: null,
      });
      expect(grace.jobRoles.map((r: { name: string }) => r.name)).toEqual(["First aider", "Hygiene"]);
      expect(grace.pinHash).toBeUndefined();
      expect(grace.workspaceId).toBeUndefined();

      const zero = await as(marcus.cookie).send("POST", "/people/staff", {
        staffNumber: "000042",
        firstName: "Alan",
        lastName: "Turing",
      });
      expect((await zero.json()).staffNumber).toBe("000042");
      expect(await (await as(ada).get("/people/staff-number")).json()).toEqual({ next: "100002" });
    });

    it("validates staff numbers and refuses duplicates", async () => {
      for (const staffNumber of ["12345", "1234567", "12a456"]) {
        const res = await as(ada).send("POST", "/people/staff", {
          staffNumber,
          firstName: "X",
          lastName: "Y",
        });
        expect(res.status).toBe(400);
      }
      const dupe = await as(ada).send("POST", "/people/staff", {
        staffNumber: "100001",
        firstName: "X",
        lastName: "Y",
      });
      expect(dupe.status).toBe(409);
      expect((await dupe.json()).error.code).toBe("staff_number_taken");
    });

    it("never reuses a deleted person's number", async () => {
      const temp = await (
        await as(ada).send("POST", "/people/staff", {
          staffNumber: "555555",
          firstName: "Temp",
          lastName: "Mistake",
        })
      ).json();
      expect((await as(ada).send("DELETE", `/people/staff/${temp.id}`)).status).toBe(204);
      const again = await as(ada).send("POST", "/people/staff", {
        staffNumber: "555555",
        firstName: "X",
        lastName: "Y",
      });
      expect(again.status).toBe(409);
      expect((await again.json()).error.message).toMatch(/never reused/);
      expect(await (await as(ada).get("/people/staff-number")).json()).toEqual({ next: "555556" });
    });

    it("searches and filters by role, department and status", async () => {
      const byName = await (await as(ada).get("/people/staff?q=grace hop")).json();
      expect(byName.staff.map((s: { id: string }) => s.id)).toEqual([graceId]);
      const byNumber = await (await as(ada).get("/people/staff?q=00004")).json();
      expect(byNumber.staff.map((s: { lastName: string }) => s.lastName)).toEqual(["Turing"]);
      const byRole = await (await as(ada).get(`/people/staff?jobRoleId=${roles[0]!.id}`)).json();
      expect(byRole.total).toBe(1);
      const byDept = await (await as(ada).get("/people/staff?department=production")).json();
      expect(byDept.staff.map((s: { id: string }) => s.id)).toEqual([graceId]);
      const list = await (await as(ada).get("/people/job-roles")).json();
      expect(list.jobRoles.find((r: { name: string }) => r.name === "Hygiene").staffCount).toBe(1);
    });

    it("replaces job roles and records leavers with their last day", async () => {
      const patched = await (
        await as(marcus.cookie).send("PATCH", `/people/staff/${graceId}`, { jobRoleIds: [roles[1]!.id] })
      ).json();
      expect(patched.jobRoles.map((r: { name: string }) => r.name)).toEqual(["First aider"]);

      const left = await (
        await as(ada).send("PATCH", `/people/staff/${graceId}`, { status: "leaver" })
      ).json();
      expect(left.status).toBe("leaver");
      expect(left.endDate).toBe(todayInZone(DEFAULT_TIME_ZONE));
      const active = await (await as(ada).get("/people/staff")).json();
      expect(active.staff.map((s: { id: string }) => s.id)).not.toContain(graceId);
      const back = await (
        await as(ada).send("PATCH", `/people/staff/${graceId}`, { status: "active" })
      ).json();
      expect(back).toMatchObject({ status: "active", endDate: null });

      const badDates = await as(ada).send("PATCH", `/people/staff/${graceId}`, { endDate: "2025-01-01" });
      expect(badDates.status).toBe(400);
    });

    it("lets only managers in person link a login (it decides whose hours are 'mine')", async () => {
      // marcus has write: editing is fine, linking is not.
      expect(
        (await as(marcus.cookie).send("PATCH", `/people/staff/${graceId}`, { jobTitle: "Lead" })).status,
      ).toBe(200);
      const self = await as(marcus.cookie).send("PATCH", `/people/staff/${graceId}`, {
        userId: marcus.userId,
      });
      expect(self.status).toBe(403);
      expect(
        (await as(marcus.cookie).send("PATCH", `/people/staff/${graceId}`, { userId: null })).status,
      ).toBe(403);
      const created = await as(marcus.cookie).send("POST", "/people/staff", {
        firstName: "X",
        lastName: "Y",
        userId: marcus.userId,
      });
      expect(created.status).toBe(403);
      const { token } = await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write" },
        })
      ).json();
      const viaToken = await ctx.req(`${WS}/people/staff/${graceId}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, origin: "" },
        json: { userId: null },
      });
      expect((await viaToken.json()).error.code).toBe("token_not_allowed");
    });

    it("links a workspace member at most once", async () => {
      const linked = await as(ada).send("PATCH", `/people/staff/${graceId}`, { userId: marcus.userId });
      expect((await linked.json()).user).toMatchObject({
        id: marcus.userId,
        email: "marcus@knotworking.dev",
      });
      const twice = await as(ada).send("POST", "/people/staff", {
        firstName: "X",
        lastName: "Y",
        userId: marcus.userId,
      });
      expect(twice.status).toBe(409);
      expect((await twice.json()).error.code).toBe("user_already_linked");
      const stranger = await as(ada).send("PATCH", `/people/staff/${graceId}`, {
        userId: "01900000-0000-7000-8000-000000000000",
      });
      expect(stranger.status).toBe(400);
    });

    it("writes the sync log without PIN data", async () => {
      await as(ada).send("PUT", `/people/staff/${graceId}/pin`, { pin: "482915" });
      const page = await (await as(ada).get("/sync?after=0&limit=1000")).json();
      const rows = page.changes.filter((c: { entity: string }) => c.entity === "staff");
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.data?.pinHash).toBeUndefined();
        expect(row.data?.pinFailedAttempts).toBeUndefined();
      }
      expect(rows.at(-1).data.hasPin).toBe(true);
      // Members without the module don't see them.
      await grant(null);
      const hidden = await (await as(marcus.cookie).get("/sync?after=0&limit=1000")).json();
      expect(hidden.changes.some((c: { entity: string }) => c.entity === "staff")).toBe(false);
      await grant("write");
    });
  });

  describe("PINs", () => {
    let personId: string;
    const number = "200200";

    beforeAll(async () => {
      personId = (
        await (
          await as(ada).send("POST", "/people/staff", {
            staffNumber: number,
            firstName: "Kat",
            lastName: "Johnson",
          })
        ).json()
      ).id;
    });

    it("are set by a manager in person only", async () => {
      expect((await as(marcus.cookie).send("PUT", `/people/staff/${personId}/pin`, {})).status).toBe(403);
      const { token } = await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write" },
        })
      ).json();
      const viaToken = await ctx.req(`${WS}/people/staff/${personId}/pin`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, origin: "" },
        json: {},
      });
      expect(viaToken.status).toBe(403);
    });

    it("refuse weak PINs and generate a strong one when none is given", async () => {
      for (const pin of ["111111", "123456", "987654", "121212", "123123", number]) {
        const res = await as(ada).send("PUT", `/people/staff/${personId}/pin`, { pin });
        expect(res.status).toBe(400);
        expect((await res.json()).error.code).toBe("weak_pin");
      }
      const res = await as(ada).send("PUT", `/people/staff/${personId}/pin`, {});
      const body = await res.json();
      expect(body.pin).toMatch(/^\d{6}$/);
      expect(body.staff.hasPin).toBe(true);
      // The PIN is shown once: reading the person never returns it.
      const read = await (await as(ada).get(`/people/staff/${personId}`)).json();
      expect(JSON.stringify(read)).not.toContain(body.pin);
    });

    it("verify, and lock a number after repeated wrong PINs", async () => {
      await as(ada).send("PUT", `/people/staff/${personId}/pin`, { pin: "482915" });
      expect((await verifyStaffPin(ctx.handle.db, key, workspaceId, number, "482915")).ok).toBe(true);
      expect(await verifyStaffPin(ctx.handle.db, key, workspaceId, "999998", "482915")).toEqual({
        ok: false,
        reason: "unknown",
      });
      // A different server secret can't verify the stored hash.
      const otherKey = deriveStaffPinKey("another-secret-0123456789abcdef0123");
      expect((await verifyStaffPin(ctx.handle.db, otherKey, workspaceId, number, "482915")).ok).toBe(false);

      // The wrong-key check above was the first wrong attempt.
      for (let i = 2; i < STAFF_PIN_MAX_ATTEMPTS; i++) {
        expect(await verifyStaffPin(ctx.handle.db, key, workspaceId, number, "000001")).toEqual({
          ok: false,
          reason: "wrong",
        });
      }
      const locked = await verifyStaffPin(ctx.handle.db, key, workspaceId, number, "000001");
      expect(locked).toMatchObject({ ok: false, reason: "locked" });
      // Locked: even the right PIN is refused.
      expect(await verifyStaffPin(ctx.handle.db, key, workspaceId, number, "482915")).toMatchObject({
        reason: "locked",
      });
      const person = await (await as(ada).get(`/people/staff/${personId}`)).json();
      expect(person.pinLockedUntil).not.toBeNull();

      // After the lock runs out, the count starts again.
      const later = new Date(Date.now() + 16 * 60_000);
      expect((await verifyStaffPin(ctx.handle.db, key, workspaceId, number, "482915", later)).ok).toBe(true);
      const [row] = await ctx.handle.db.select().from(staff).where(eq(staff.id, personId));
      expect(row).toMatchObject({ pinFailedAttempts: 0, pinLockedUntil: null });
    });

    it("can be unlocked or cleared by a manager", async () => {
      for (let i = 0; i < STAFF_PIN_MAX_ATTEMPTS; i++) {
        await verifyStaffPin(ctx.handle.db, key, workspaceId, number, "000001");
      }
      const unlocked = await (await as(ada).send("POST", `/people/staff/${personId}/unlock`)).json();
      expect(unlocked.pinLockedUntil).toBeNull();
      expect((await verifyStaffPin(ctx.handle.db, key, workspaceId, number, "482915")).ok).toBe(true);

      const cleared = await (await as(ada).send("DELETE", `/people/staff/${personId}/pin`)).json();
      expect(cleared.hasPin).toBe(false);
      expect(await verifyStaffPin(ctx.handle.db, key, workspaceId, number, "482915")).toEqual({
        ok: false,
        reason: "no_pin",
      });
    });

    it("refuse leavers, and let people change their own PIN", async () => {
      await as(ada).send("PUT", `/people/staff/${personId}/pin`, { pin: "482915" });
      const change = { staffNumber: number, currentPin: "482915", newPin: "735190" };
      expect((await changeOwnStaffPin(ctx.handle.db, key, workspaceId, change)).ok).toBe(true);
      expect((await verifyStaffPin(ctx.handle.db, key, workspaceId, number, "735190")).ok).toBe(true);
      await expect(
        changeOwnStaffPin(ctx.handle.db, key, workspaceId, {
          ...change,
          currentPin: "735190",
          newPin: "222222",
        }),
      ).rejects.toMatchObject({ code: "weak_pin" });

      await as(ada).send("PATCH", `/people/staff/${personId}`, { status: "leaver" });
      expect(await verifyStaffPin(ctx.handle.db, key, workspaceId, number, "735190")).toEqual({
        ok: false,
        reason: "inactive",
      });
    });
  });
});
