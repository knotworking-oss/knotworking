import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("attendance module", () => {
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
  const grant = (moduleId: string, level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
  const kiosk = (deviceToken: string) => (method: string, path: string, json?: unknown) =>
    ctx.req(`/v1/kiosk${path}`, {
      method,
      headers: { authorization: `Bearer ${deviceToken}`, origin: "" },
      json,
    });
  const code = async (res: { json(): Promise<any> }) => (await res.json()).error.code;
  const ok = async (res: { status: number; json(): Promise<any> }, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };

  const people: Record<string, { id: string; staffNumber: string }> = {};
  let device: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write" },
        })
      ).json()
    ).token;
    await grant("people", "read");
    for (const [firstName, staffNumber, pin, extra] of [
      ["Grace", "100001", "482915", {}],
      ["Alan", "100002", "735190", { userId: marcus.userId }],
      ["Kat", "100003", "908172", {}],
    ] as const) {
      const person = await ok(
        await as(ada).send("POST", "/people/staff", { firstName, lastName: "Tester", staffNumber, ...extra }),
        201,
      );
      await ok(await as(ada).send("PUT", `/people/staff/${person.id}/pin`, { pin }));
      people[firstName] = { id: person.id, staffNumber };
    }
  }, 90_000);
  afterAll(() => ctx.handle.close());

  describe("access", () => {
    it("is opt-in, and off with the module (kiosk included)", async () => {
      expect((await as(marcus.cookie).get("/attendance/on-site")).status).toBe(403);
      const off = await makeApp({ seed: true, activeModules: ["tasks", "people"] });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      expect(await code(await off.req(`${WS}/attendance/on-site`, { cookie }))).toBe("module_inactive");
      const pair = await off.req("/v1/public/kiosk/pair", { method: "POST", json: { code: "ABCDEFGH" } });
      expect(await code(pair)).toBe("module_inactive");
      await off.handle.close();
    }, 60_000);

    it("keeps shifts and payroll from read-level members", async () => {
      await grant("attendance", "read");
      expect((await as(marcus.cookie).get("/attendance/on-site")).status).toBe(200);
      expect((await as(marcus.cookie).get("/attendance/shifts?from=2026-03-01&to=2026-03-31")).status).toBe(
        403,
      );
      expect((await as(marcus.cookie).get("/attendance/payroll?from=2026-03-01&to=2026-03-31")).status).toBe(
        403,
      );
    });
  });

  describe("kiosk pairing", () => {
    it("pairs a tablet with a one-time code from a manager in person", async () => {
      expect((await viaToken("POST", "/attendance/devices", { name: "Front door" })).status).toBe(403);
      expect((await as(marcus.cookie).send("POST", "/attendance/devices", { name: "x" })).status).toBe(403);
      const created = await ok(
        await as(ada).send("POST", "/attendance/devices", { name: "Front door" }),
        201,
      );
      expect(created.pairingCode).toMatch(/^[A-Z2-9]{8}$/);
      const paired = await ok(
        await ctx.req("/v1/public/kiosk/pair", {
          method: "POST",
          json: { code: `${created.pairingCode.slice(0, 4)}-${created.pairingCode.slice(4).toLowerCase()}` },
        }),
      );
      expect(paired).toMatchObject({ device: { name: "Front door" }, workspace: { slug: "acme" } });
      expect(paired.token).toMatch(/^knk_/);
      device = paired.token;
      // Single use.
      const again = await ctx.req("/v1/public/kiosk/pair", {
        method: "POST",
        json: { code: created.pairingCode },
      });
      expect(await code(again)).toBe("pairing_code_invalid");
      const session = await ok(await kiosk(device)("GET", "/session"));
      expect(session).toMatchObject({
        device: { name: "Front door" },
        workspace: { name: expect.any(String) },
      });
      const list = await ok(await as(ada).get("/attendance/devices"));
      expect(list.devices[0]).toMatchObject({
        name: "Front door",
        pairedAt: expect.any(String),
        pairingExpiresAt: null,
      });
    });

    it("refuses personal tokens and sessions at the kiosk, and the kiosk credential elsewhere", async () => {
      expect(
        await code(await ctx.req("/v1/kiosk/session", { headers: { authorization: `Bearer ${token}` } })),
      ).toBe("device_required");
      const elsewhere = await ctx.req(`${WS}/attendance/on-site`, {
        headers: { authorization: `Bearer ${device}` },
      });
      expect(elsewhere.status).toBe(401);
    });

    it("pauses pairing and paired devices when Attendance is off in the workspace", async () => {
      const created = await ok(await as(ada).send("POST", "/attendance/devices", { name: "Side door" }), 201);
      const pair = () =>
        ctx.req("/v1/public/kiosk/pair", { method: "POST", json: { code: created.pairingCode } });
      try {
        await ok(await as(ada).send("PATCH", "/module-settings", { modules: ["tasks", "people"] }));
        expect(await code(await kiosk(device)("GET", "/session"))).toBe("module_inactive");
        expect(await code(await pair())).toBe("module_inactive");
      } finally {
        await ok(await as(ada).send("PATCH", "/module-settings", { modules: null }));
      }
      expect((await kiosk(device)("GET", "/session")).status).toBe(200);
      expect((await pair()).status).toBe(200);
    });

    it("stops working once revoked; a new code replaces a lost tablet", async () => {
      const spare = await ok(await as(ada).send("POST", "/attendance/devices", { name: "Canteen" }), 201);
      const { token: spareToken } = await ok(
        await ctx.req("/v1/public/kiosk/pair", { method: "POST", json: { code: spare.pairingCode } }),
      );
      const renewed = await ok(
        await as(ada).send("POST", `/attendance/devices/${spare.device.id}/pairing-code`),
      );
      expect(await code(await kiosk(spareToken)("GET", "/session"))).toBe("device_required");
      const { token: second } = await ok(
        await ctx.req("/v1/public/kiosk/pair", { method: "POST", json: { code: renewed.pairingCode } }),
      );
      expect((await kiosk(second)("GET", "/session")).status).toBe(200);
      await ok(await as(ada).send("DELETE", `/attendance/devices/${spare.device.id}`));
      expect(await code(await kiosk(second)("GET", "/session"))).toBe("device_required");
    });
  });

  describe("clocking at the kiosk", () => {
    it("identifies people by staff number and PIN, with one answer for every mismatch", async () => {
      const k = kiosk(device);
      const grace = await ok(await k("POST", "/identify", { staffNumber: "100001", pin: "482915" }));
      expect(grace).toEqual({ firstName: "Grace", expected: "in", last: null });
      expect(await code(await k("POST", "/identify", { staffNumber: "100001", pin: "000001" }))).toBe(
        "pin_invalid",
      );
      expect(await code(await k("POST", "/identify", { staffNumber: "999999", pin: "482915" }))).toBe(
        "pin_invalid",
      );
    });

    it("clocks in and out, ignoring a double tap", async () => {
      const k = kiosk(device);
      const first = await ok(
        await k("POST", "/clock", { staffNumber: "100001", pin: "482915", kind: "in" }),
        201,
      );
      expect(first).toMatchObject({ firstName: "Grace", kind: "in", repeated: false });
      const tap = await ok(
        await k("POST", "/clock", { staffNumber: "100001", pin: "482915", kind: "in" }),
        201,
      );
      expect(tap.repeated).toBe(true);
      const now = await ok(await k("POST", "/identify", { staffNumber: "100001", pin: "482915" }));
      expect(now.expected).toBe("out");
      await ok(await k("POST", "/clock", { staffNumber: "100002", pin: "735190", kind: "in" }), 201);
    });

    it("locks a staff number after repeated wrong PINs, and refuses leavers", async () => {
      const k = kiosk(device);
      for (let i = 0; i < 4; i++) await k("POST", "/identify", { staffNumber: "100003", pin: "111112" });
      const locked = await k("POST", "/identify", { staffNumber: "100003", pin: "111112" });
      expect(locked.status).toBe(423);
      expect(await code(await k("POST", "/identify", { staffNumber: "100003", pin: "908172" }))).toBe(
        "pin_locked",
      );
      await ok(await as(ada).send("POST", `/people/staff/${people.Kat!.id}/unlock`));
      await ok(await as(ada).send("PATCH", `/people/staff/${people.Kat!.id}`, { status: "leaver" }));
      expect(await code(await k("POST", "/identify", { staffNumber: "100003", pin: "908172" }))).toBe(
        "staff_inactive",
      );
      await ok(await as(ada).send("PATCH", `/people/staff/${people.Kat!.id}`, { status: "active" }));
    });

    it("lets people change their own PIN", async () => {
      const k = kiosk(device);
      await ok(await k("POST", "/pin", { staffNumber: "100003", currentPin: "908172", newPin: "516273" }));
      expect((await k("POST", "/identify", { staffNumber: "100003", pin: "516273" })).status).toBe(200);
      expect(
        await code(
          await k("POST", "/pin", { staffNumber: "100003", currentPin: "516273", newPin: "123456" }),
        ),
      ).toBe("weak_pin");
    });
  });

  describe("visitors and the on-site register", () => {
    it("signs visitors in and out by name", async () => {
      const k = kiosk(device);
      await ok(await k("POST", "/visitors/sign-in", { firstName: "Mary", lastName: "Somerville" }), 201);
      await ok(await k("POST", "/visitors/sign-in", { firstName: "Charles", lastName: "Babbage" }), 201);
      expect(
        await code(await k("POST", "/visitors/sign-out", { firstName: "Nobody", lastName: "Here" })),
      ).toBe("visitor_not_found");
      await ok(await k("POST", "/visitors/sign-out", { firstName: "charles", lastName: " BABBAGE " }));
    });

    it("lists who is on site for fire marshals (read level)", async () => {
      const here = await ok(await as(marcus.cookie).get("/attendance/on-site"));
      expect(here.staff.map((s: { firstName: string }) => s.firstName)).toEqual(["Alan", "Grace"]);
      expect(here.visitors.map((v: { firstName: string }) => v.firstName)).toEqual(["Mary"]);
    });

    it("runs a roll call: a frozen list, marked by a fire marshal, ended once", async () => {
      expect((await viaToken("POST", "/attendance/roll-calls", { kind: "drill" })).status).toBe(403);
      const call = await ok(
        await as(marcus.cookie).send("POST", "/attendance/roll-calls", { kind: "drill" }),
        201,
      );
      expect(call.entries.map((e: { name: string }) => e.name)).toEqual([
        "Alan Tester",
        "Grace Tester",
        "Mary Somerville",
      ]);
      expect(await code(await as(ada).send("POST", "/attendance/roll-calls", { kind: "real" }))).toBe(
        "roll_call_open",
      );
      for (const entry of call.entries.slice(0, 2)) {
        await ok(
          await as(marcus.cookie).send("POST", `/attendance/roll-calls/${call.id}/entries/${entry.id}`, {
            status: "safe",
          }),
        );
      }
      const ended = await ok(
        await as(marcus.cookie).send("POST", `/attendance/roll-calls/${call.id}/end`, {
          notes: "Mary was in the car park",
        }),
      );
      expect(ended).toMatchObject({ endedAt: expect.any(String), notes: "Mary was in the car park" });
      expect(ended.entries.find((e: { name: string }) => e.name === "Mary Somerville").status).toBe(
        "unaccounted",
      );
      const list = await ok(await as(marcus.cookie).get("/attendance/roll-calls"));
      expect(list.rollCalls[0].counts).toEqual({ safe: 2, missing: 0, unaccounted: 1 });
      const late = await as(marcus.cookie).send(
        "POST",
        `/attendance/roll-calls/${call.id}/entries/${call.entries[2].id}`,
        {
          status: "safe",
        },
      );
      expect(await code(late)).toBe("roll_call_ended");
    });
  });

  describe("shifts and payroll", () => {
    const manual = (staffId: string, kind: string, at: string) =>
      as(ada).send("POST", "/attendance/events", { staffId, kind, at, reason: "Paper timesheet" });

    beforeAll(async () => {
      await grant("attendance", "write");
      // March is GMT in London, so local times equal UTC. Grace: 5 days of 8h30m; Alan: one day and a missed clock-out.
      for (const day of ["02", "03", "04", "05", "06"]) {
        await ok(await manual(people.Grace!.id, "in", `2026-03-${day}T07:55:00Z`), 201);
        await ok(await manual(people.Grace!.id, "out", `2026-03-${day}T16:25:00Z`), 201);
      }
      await ok(await manual(people.Alan!.id, "in", "2026-03-02T08:00:00Z"), 201);
      await ok(await manual(people.Alan!.id, "out", "2026-03-02T12:00:00Z"), 201);
      await ok(await manual(people.Alan!.id, "in", "2026-03-03T08:00:00Z"), 201);
      await ok(
        await as(ada).send("PATCH", "/attendance/settings", {
          roundingMinutes: 15,
          breakAfterHours: 6,
          breakMinutes: 30,
          overtimeAfterWeeklyHours: 37.5,
        }),
      );
    });

    it("needs a person and a reason for manual events, and refuses the future", async () => {
      const base = { staffId: people.Kat!.id, kind: "in", reason: "x" };
      expect(
        (await viaToken("POST", "/attendance/events", { ...base, at: "2026-03-02T08:00:00Z" })).status,
      ).toBe(403);
      expect(
        (await as(ada).send("POST", "/attendance/events", { ...base, at: "2099-01-01T08:00:00Z" })).status,
      ).toBe(400);
      expect(
        (
          await as(ada).send("POST", "/attendance/events", {
            ...base,
            reason: "",
            at: "2026-03-02T08:00:00Z",
          })
        ).status,
      ).toBe(400);
    });

    it("builds shifts with rounding, breaks and issues", async () => {
      const res = await ok(await as(marcus.cookie).get("/attendance/shifts?from=2026-03-01&to=2026-03-08"));
      const grace = res.people.find((p: any) => p.staff.id === people.Grace!.id);
      // 07:55 → 08:00, 16:25 → 16:30: 8h30m less 30m = 8h a day.
      expect(grace.shifts).toHaveLength(5);
      expect(grace.shifts[0]).toMatchObject({
        date: "2026-03-02",
        minutes: 510,
        paidMinutes: 480,
        issue: null,
      });
      expect(grace.totals).toMatchObject({
        shifts: 5,
        paidMinutes: 2400,
        basicMinutes: 2250,
        overtimeMinutes: 150,
        issues: 0,
      });
      const alan = res.people.find((p: any) => p.staff.id === people.Alan!.id);
      expect(alan.shifts.map((s: any) => s.issue)).toEqual([null, "missing_out"]);
      expect(res.issues).toBe(1);
      const onlyIssues = await ok(
        await as(marcus.cookie).get("/attendance/shifts?from=2026-03-01&to=2026-03-08&issues=true"),
      );
      expect(onlyIssues.people.map((p: any) => p.staff.id)).toEqual([people.Alan!.id]);
    });

    it("previews and exports payroll; Sage 50 needs its payment references", async () => {
      const generic = await ok(
        await as(ada).get("/attendance/payroll?from=2026-03-01&to=2026-03-08&format=generic"),
      );
      expect(generic.rows.map((r: any) => [r.firstName, r.basicMinutes, r.overtimeMinutes])).toEqual([
        ["Alan", 240, 0],
        ["Grace", 2250, 150],
      ]);
      expect(generic.exceptions).toHaveLength(1);
      expect(generic.warnings[0]).toMatch(/1 shift has a missing/);
      const csv = await as(ada).get("/attendance/payroll.csv?from=2026-03-01&to=2026-03-08&format=generic");
      expect(csv.headers.get("content-type")).toContain("text/csv");
      expect(csv.headers.get("content-disposition")).toContain("hours-2026-03-01-to-2026-03-08.csv");
      expect(await csv.text()).toContain("100001,,Grace,Tester,2026-03-01,2026-03-08,5,37.5,2.5,40");

      const sage = await ok(
        await as(ada).get("/attendance/payroll?from=2026-03-01&to=2026-03-08&format=sage50"),
      );
      expect(sage.format.verified).toBe(false);
      expect(sage.problems).toHaveLength(2);
      expect(
        await code(await as(ada).get("/attendance/payroll.csv?from=2026-03-01&to=2026-03-08&format=sage50")),
      ).toBe("payroll_export_blocked");
      await ok(
        await as(ada).send("PATCH", "/attendance/settings", {
          sageBasicPaymentRef: "1",
          sageOvertimePaymentRef: "4",
        }),
      );
      await ok(await as(ada).send("PATCH", `/people/staff/${people.Grace!.id}`, { payrollReference: "17" }));
      const file = await as(ada).get("/attendance/payroll.csv?from=2026-03-01&to=2026-03-08&format=sage50");
      expect((await file.text()).split("\r\n")).toEqual([
        "Employee Reference,Payment Reference,Hours",
        "100002,1,4",
        "17,1,37.5",
        "17,4,2.5",
        "",
      ]);
      // Agents may preview but not download the file.
      expect((await viaToken("GET", "/attendance/payroll.csv?from=2026-03-01&to=2026-03-08")).status).toBe(
        403,
      );
    });

    it("warns when people are still clocked in", async () => {
      const today = todayInZone(DEFAULT_TIME_ZONE);
      const preview = await ok(
        await as(ada).get(`/attendance/payroll?from=${today}&to=${today}&format=generic`),
      );
      expect(preview.warnings.some((w: string) => /still clocked in/.test(w))).toBe(true);
    });

    it("voids an event: kept, shown, never counted", async () => {
      const before = await ok(
        await as(ada).get(`/attendance/shifts?from=2026-03-06&to=2026-03-06&staffId=${people.Grace!.id}`),
      );
      const out = before.people[0].events.find((e: any) => e.kind === "out");
      expect(
        (await as(marcus.cookie).send("POST", `/attendance/events/${out.id}/void`, { reason: "x" })).status,
      ).toBe(403);
      await ok(
        await as(ada).send("POST", `/attendance/events/${out.id}/void`, {
          reason: "Clocked out on the wrong day",
        }),
      );
      const after = await ok(
        await as(ada).get(`/attendance/shifts?from=2026-03-06&to=2026-03-06&staffId=${people.Grace!.id}`),
      );
      expect(after.people[0].shifts[0].issue).toBe("missing_out");
      expect(after.people[0].events.find((e: any) => e.id === out.id)).toMatchObject({
        voidReason: "Clocked out on the wrong day",
        voidedByName: "Ada Park",
      });
      expect(
        await code(await as(ada).send("POST", `/attendance/events/${out.id}/void`, { reason: "again" })),
      ).toBe("event_voided");
    });

    it("keeps people from editing their own clock record, unless they are the only manager", async () => {
      const at = "2026-03-09T08:00:00Z";
      const mine = (kind: string) =>
        as(marcus.cookie).send("POST", "/attendance/events", {
          staffId: people.Alan!.id,
          kind,
          at,
          reason: "Forgot",
        });
      // Marcus (write) is linked to Alan: refused for himself, fine for someone else.
      expect(await code(await mine("in"))).toBe("own_attendance");
      expect((await mine("in")).status).toBe(403);
      await ok(
        await as(marcus.cookie).send("POST", "/attendance/events", {
          staffId: people.Kat!.id,
          kind: "in",
          at,
          reason: "Forgot",
        }),
        201,
      );
      // Ada adds an event for Marcus's record; Marcus (manage, with Ada also a manager) can't void it.
      const own = await ok(
        await as(ada).send("POST", "/attendance/events", {
          staffId: people.Alan!.id,
          kind: "in",
          at: "2026-03-10T08:00:00Z",
          reason: "Paper timesheet",
        }),
        201,
      );
      await grant("attendance", "manage");
      expect(
        await code(
          await as(marcus.cookie).send("POST", `/attendance/events/${own.id}/void`, { reason: "x" }),
        ),
      ).toBe("own_attendance");
      expect((await mine("in")).status).toBe(403);
      // The owner isn't the sole manager while Marcus (a member, with people access) also manages.
      const adaId = (await (await as(ada).get("/members")).json()).members.find(
        (x: { email: string }) => x.email === "ada@knotworking.dev",
      ).userId;
      const adaStaff = await ok(
        await as(ada).send("POST", "/people/staff", {
          firstName: "Ada",
          lastName: "Owner",
          staffNumber: "300009",
          userId: adaId,
        }),
        201,
      );
      expect(
        await code(
          await as(ada).send("POST", "/attendance/events", {
            staffId: adaStaff.id,
            kind: "in",
            at,
            reason: "Forgot",
          }),
        ),
      ).toBe("own_attendance");
      // Later tests expect Ada to have no staff record.
      expect((await as(ada).send("DELETE", `/people/staff/${adaStaff.id}`)).status).toBe(204);
      // Someone else's event is fine for Marcus.
      const others = await ok(
        await as(ada).get(`/attendance/shifts?from=2026-03-09&to=2026-03-09&staffId=${people.Kat!.id}`),
      );
      await ok(
        await as(marcus.cookie).send("POST", `/attendance/events/${others.people[0].events[0].id}/void`, {
          reason: "Duplicate",
        }),
      );
      // The sole manager may. Ada is the owner (always manage), so a lone manager needs a workspace without her.
      const solo = await makeApp({ seed: true });
      const cookie = (await signIn(solo, "ada@knotworking.dev")).cookie;
      const soloReq = (method: string, path: string, json?: unknown) =>
        solo.req(`${WS}${path}`, { method, cookie, json });
      const staffRow = await ok(
        await soloReq("POST", "/people/staff", {
          firstName: "Ada",
          lastName: "Park",
          staffNumber: "300001",
          userId: (await (await soloReq("GET", "/members")).json()).members.find(
            (x: { email: string }) => x.email === "ada@knotworking.dev",
          ).userId,
        }),
        201,
      );
      const event = await ok(
        await soloReq("POST", "/attendance/events", {
          staffId: staffRow.id,
          kind: "in",
          at: "2026-03-09T08:00:00Z",
          reason: "Forgot",
        }),
        201,
      );
      await ok(await soloReq("POST", `/attendance/events/${event.id}/void`, { reason: "Wrong day" }));
      await solo.handle.close();
      await grant("attendance", "write");
    }, 90_000);

    it("shows people their own times, and keeps people with records", async () => {
      const mine = await ok(await as(marcus.cookie).get("/attendance/me?from=2026-03-01&to=2026-03-08"));
      expect(mine).toMatchObject({ linked: true, totals: { paidMinutes: 240 } });
      expect((await as(marcus.cookie).get("/attendance/me?from=2026-01-01&to=2026-06-01")).status).toBe(400);
      const notLinked = await ok(await as(ada).get("/attendance/me?from=2026-03-01&to=2026-03-08"));
      expect(notLinked.linked).toBe(false);
      expect(
        await code(
          await as(ada).send("PATCH", `/people/staff/${people.Grace!.id}`, { staffNumber: "200001" }),
        ),
      ).toBe("staff_number_fixed");
      expect(await code(await as(ada).send("DELETE", `/people/staff/${people.Grace!.id}`))).toBe(
        "staff_has_records",
      );
    });

    it("validates settings, and never writes the sync log", async () => {
      expect((await as(ada).send("PATCH", "/attendance/settings", { timeZone: "Mars/Olympus" })).status).toBe(
        400,
      );
      expect((await as(ada).send("PATCH", "/attendance/settings", { payrollFormat: "nope" })).status).toBe(
        400,
      );
      expect(
        (await as(marcus.cookie).send("PATCH", "/attendance/settings", { breakMinutes: 0 })).status,
      ).toBe(403);
      const page = await ok(await as(ada).get("/sync?after=0&limit=1000"));
      expect(page.changes.some((c: { entity: string }) => c.entity.startsWith("attendance"))).toBe(false);
    });
  });
});
