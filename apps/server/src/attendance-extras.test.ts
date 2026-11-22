import { lastFinishedPayPeriod, moduleIds, todayInZone, DEFAULT_TIME_ZONE } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signInVisitor } from "./services/attendance";
import { sweepDueNotifications } from "./services/notification-sweep";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const HOUR = 3_600_000;

/** Pay periods, visitor passes, "your visitor has arrived" and missed clock-out notifications. */
describe("attendance: pay periods, visitor passes and notifications", () => {
  let ctx: TestCtx;
  let workspaceId: string;
  let ada: { cookie: string; userId: string };
  let marcus: { cookie: string; userId: string };
  let priya: { cookie: string; userId: string };
  let deviceToken: string;
  const staff: Record<string, string> = {};

  const send = (cookie: string, method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const ok = async (res: { status: number; json(): Promise<any> }, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const kiosk = (method: string, path: string, json?: unknown) =>
    ctx.req(`/v1/kiosk${path}`, {
      method,
      headers: { authorization: `Bearer ${deviceToken}`, origin: "" },
      json,
    });
  const inbox = async (cookie: string, type?: string) => {
    const { notifications } = await ok(await ctx.req(`${WS}/notifications?limit=100`, { cookie }));
    return (notifications as { type: string; data: Record<string, any> }[]).filter(
      (n) => !type || n.type === type,
    );
  };
  const grant = (userId: string, moduleId: string, level: string | null) =>
    send(ada.cookie, "PUT", `/members/${userId}/module-access/${moduleId}`, { level });
  const clock = (staffId: string, kind: "in" | "out", at: Date) =>
    send(ada.cookie, "POST", "/attendance/events", { staffId, kind, at: at.toISOString(), reason: "Test" });
  const sweep = (now: Date) =>
    sweepDueNotifications(ctx.handle.db, { activeModules: moduleIds, workspaceId, now });
  const settle = () => new Promise((r) => setTimeout(r, 200));

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = { cookie: (await signIn(ctx, "ada@knotworking.dev")).cookie, userId: "" };
    const { members } = await ok(await ctx.req(`${WS}/members`, { cookie: ada.cookie }));
    const who = async (name: string) => {
      const m = members.find((x: { email: string }) => x.email === `${name}@knotworking.dev`);
      return { userId: m.userId as string, cookie: (await signIn(ctx, m.email)).cookie };
    };
    ada = await who("ada");
    marcus = await who("marcus");
    priya = await who("priya");
    workspaceId = (await ok(await ctx.req(`${WS}/bootstrap`, { cookie: ada.cookie }))).workspace.id;
    await grant(marcus.userId, "people", "read");
    await grant(marcus.userId, "attendance", "read");
    for (const [firstName, staffNumber, extra] of [
      ["Grace", "100001", {}],
      ["Alan", "100002", { userId: marcus.userId }],
      ["Kat", "100003", {}],
    ] as const) {
      const person = await ok(
        await send(ada.cookie, "POST", "/people/staff", {
          firstName,
          lastName: "Tester",
          staffNumber,
          ...extra,
        }),
        201,
      );
      staff[firstName] = person.id;
    }
    const device = await ok(
      await send(ada.cookie, "POST", "/attendance/devices", { name: "Front door" }),
      201,
    );
    deviceToken = (
      await ok(await ctx.req("/v1/public/kiosk/pair", { method: "POST", json: { code: device.pairingCode } }))
    ).token;
  }, 90_000);
  afterAll(() => ctx.handle.close());

  describe("pay periods", () => {
    const today = () => todayInZone(DEFAULT_TIME_ZONE);

    it("default to the last finished calendar month", async () => {
      const settings = await ok(await send(ada.cookie, "GET", "/attendance/settings"));
      expect(settings).toMatchObject({ payPeriodKind: "monthly", payPeriodAnchor: null });
      const preview = await ok(await send(ada.cookie, "GET", "/attendance/payroll"));
      const last = lastFinishedPayPeriod(today(), { kind: "monthly", anchor: null });
      expect({ from: preview.from, to: preview.to }).toEqual(last);
      expect(last.from.endsWith("-01")).toBe(true);
    });

    it("follow the setting for the preview and the file, and an explicit range still wins", async () => {
      await ok(
        await send(ada.cookie, "PATCH", "/attendance/settings", {
          payPeriodKind: "fortnightly",
          payPeriodAnchor: "2026-01-05",
        }),
      );
      const last = lastFinishedPayPeriod(today(), { kind: "fortnightly", anchor: "2026-01-05" });
      const preview = await ok(await send(ada.cookie, "GET", "/attendance/payroll"));
      expect({ from: preview.from, to: preview.to }).toEqual(last);
      expect(Date.parse(last.to) - Date.parse(last.from)).toBe(13 * 86_400_000);
      const file = await send(ada.cookie, "GET", "/attendance/payroll.csv");
      expect(file.status).toBe(200);
      expect(file.headers.get("content-disposition")).toContain(`hours-${last.from}-to-${last.to}.csv`);
      const explicit = await ok(
        await send(ada.cookie, "GET", "/attendance/payroll?from=2026-03-01&to=2026-03-08"),
      );
      expect({ from: explicit.from, to: explicit.to }).toEqual({ from: "2026-03-01", to: "2026-03-08" });
    });

    it("refuse an unusable setting, and half a range", async () => {
      const bad = await send(ada.cookie, "PATCH", "/attendance/settings", {
        payPeriodKind: "weekly",
        payPeriodAnchor: null,
      });
      expect(bad.status).toBe(400);
      expect(
        (await send(ada.cookie, "PATCH", "/attendance/settings", { payPeriodKind: "yearly" })).status,
      ).toBe(400);
      expect((await send(ada.cookie, "GET", "/attendance/payroll?from=2026-03-01")).status).toBe(400);
      expect((await send(ada.cookie, "GET", "/attendance/payroll?to=2026-03-01")).status).toBe(400);
      // Nothing was saved by the refused patches.
      expect(await ok(await send(ada.cookie, "GET", "/attendance/settings"))).toMatchObject({
        payPeriodKind: "fortnightly",
      });
    });

    it("let a monthly period start on another day of the month", async () => {
      await ok(
        await send(ada.cookie, "PATCH", "/attendance/settings", {
          payPeriodKind: "monthly",
          payPeriodAnchor: "2024-01-26",
        }),
      );
      const preview = await ok(await send(ada.cookie, "GET", "/attendance/payroll"));
      expect(preview.from.endsWith("-26")).toBe(true);
      expect(preview.to.endsWith("-25")).toBe(true);
      await ok(
        await send(ada.cookie, "PATCH", "/attendance/settings", {
          payPeriodKind: "monthly",
          payPeriodAnchor: null,
        }),
      );
    });
  });

  describe("visitor passes and hosts", () => {
    let visitId: string;

    it("sends a host the arrival, once, whether or not they can read attendance", async () => {
      expect(await inbox(priya.cookie, "visitor_arrived")).toHaveLength(0);
      const body = {
        firstName: "Linus",
        lastName: "Visitor",
        company: "Engines plc",
        host: { kind: "member", id: marcus.userId },
        clientId: crypto.randomUUID(),
      };
      const done = await ok(await kiosk("POST", "/visitors/sign-in", body), 201);
      visitId = done.id;
      await ok(await kiosk("POST", "/visitors/sign-in", body), 201); // a retry
      const told = await inbox(marcus.cookie, "visitor_arrived");
      expect(told).toHaveLength(1);
      expect(told[0]!.data).toMatchObject({ title: "Linus Visitor (Engines plc)", subjectId: visitId });
      expect(await inbox(ada.cookie, "visitor_arrived")).toHaveLength(0);
      expect(await inbox(priya.cookie, "visitor_arrived")).toHaveLength(0);
    });

    it("finds the login of a staff host, and tells no one when the host has none", async () => {
      await ok(
        await kiosk("POST", "/visitors/sign-in", {
          firstName: "Ada",
          lastName: "Guest",
          host: { kind: "staff", id: staff.Alan },
        }),
        201,
      );
      expect(await inbox(marcus.cookie, "visitor_arrived")).toHaveLength(2);
      const before = (await inbox(marcus.cookie)).length;
      await ok(
        await kiosk("POST", "/visitors/sign-in", {
          firstName: "Bob",
          lastName: "Guest",
          host: { kind: "staff", id: staff.Grace },
        }),
        201,
      );
      await ok(await kiosk("POST", "/visitors/sign-in", { firstName: "Cy", lastName: "Guest" }), 201);
      expect((await inbox(marcus.cookie)).length).toBe(before);
      expect(await inbox(ada.cookie, "visitor_arrived")).toHaveLength(0);
    });

    it("emails the host, unless they turned the type off", async () => {
      ctx.mailer.sent.length = 0;
      await ok(
        await kiosk("POST", "/visitors/sign-in", {
          firstName: "Dee",
          lastName: "Guest",
          host: { kind: "member", id: marcus.userId },
        }),
        201,
      );
      await settle();
      expect(ctx.mailer.sent.some((m) => m.subject.includes("Dee Guest has arrived to see you"))).toBe(true);
      await ok(
        await send(marcus.cookie, "PUT", "/notifications/preferences", {
          emailTypes: { visitor_arrived: false },
        }),
      );
      ctx.mailer.sent.length = 0;
      await ok(
        await kiosk("POST", "/visitors/sign-in", {
          firstName: "Eve",
          lastName: "Guest",
          host: { kind: "member", id: marcus.userId },
        }),
        201,
      );
      await settle();
      expect(ctx.mailer.sent).toHaveLength(0);
      expect((await inbox(marcus.cookie, "visitor_arrived")).some((n) => n.data.title === "Eve Guest")).toBe(
        true,
      );
    });

    it("does not announce a sign-in replayed long after it happened, but records it", async () => {
      const before = (await inbox(marcus.cookie, "visitor_arrived")).length;
      const old = new Date(Date.now() - 3 * HOUR);
      await signInVisitor(
        ctx.handle.db,
        workspaceId,
        { deviceId: null, at: old, offline: true },
        {
          firstName: "Old",
          lastName: "Offline",
          host: { kind: "member", id: marcus.userId },
          clientId: crypto.randomUUID(),
        },
        { siteRules: null, hostName: "Marcus" },
      );
      const recent = new Date(Date.now() - 5 * 60_000);
      await signInVisitor(
        ctx.handle.db,
        workspaceId,
        { deviceId: null, at: recent, offline: true },
        {
          firstName: "Recent",
          lastName: "Offline",
          host: { kind: "member", id: marcus.userId },
          clientId: crypto.randomUUID(),
        },
        { siteRules: null, hostName: "Marcus" },
      );
      const after = await inbox(marcus.cookie, "visitor_arrived");
      expect(after).toHaveLength(before + 1);
      expect(after.some((n) => n.data.title === "Recent Offline")).toBe(true);
      expect(after.some((n) => n.data.title === "Old Offline")).toBe(false);
    });

    it("returns one visit for its printed pass, to people who can read visitors", async () => {
      const visit = await ok(await send(ada.cookie, "GET", `/attendance/visits/${visitId}`));
      expect(visit).toMatchObject({
        id: visitId,
        firstName: "Linus",
        company: "Engines plc",
        hostName: "Marcus Chen",
        signedOutAt: null,
      });
      expect((await send(marcus.cookie, "GET", `/attendance/visits/${visitId}`)).status).toBe(403);
      expect((await send(ada.cookie, "GET", `/attendance/visits/${crypto.randomUUID()}`)).status).toBe(404);
    });
  });

  describe("missed clock-out notifications", () => {
    const attendanceSwept = async () =>
      (
        await ctx.handle.db.query.notificationSweeps.findMany({
          where: (t, { eq, and }) => and(eq(t.workspaceId, workspaceId), eq(t.module, "attendance")),
        })
      ).length;

    it("tells the people who can fix it, and the person, once the shift is past the maximum", async () => {
      const now = new Date();
      // Grace clocked in 30 hours ago and never out; Alan (marcus's record) 20 hours ago: both past 16 hours.
      await ok(await clock(staff.Grace!, "in", new Date(now.getTime() - 30 * HOUR)), 201);
      await ok(await clock(staff.Alan!, "in", new Date(now.getTime() - 20 * HOUR)), 201);
      // Kat is still on a normal shift, and Alan's earlier shift was closed.
      await ok(await clock(staff.Kat!, "in", new Date(now.getTime() - 2 * HOUR)), 201);
      expect(await attendanceSwept()).toBe(0);
      ctx.mailer.sent.length = 0;

      const first = await sweep(now);
      const missed = first.created.filter((n) => n.type === "missed_clock_out");
      // Ada (owner) is told of both; Marcus (read only) of his own only.
      expect(missed).toHaveLength(3);
      expect((await inbox(ada.cookie, "missed_clock_out")).map((n) => n.data.staffName).sort()).toEqual([
        "Alan Tester",
        "Grace Tester",
      ]);
      const mine = await inbox(marcus.cookie, "missed_clock_out");
      expect(mine).toHaveLength(1);
      expect(mine[0]!.data).toMatchObject({ staffName: "Alan Tester", ownRecord: true });
      expect(await inbox(priya.cookie, "missed_clock_out")).toHaveLength(0);
      // The module's first sweep is seeded without email.
      await settle();
      expect(ctx.mailer.sent.some((m) => m.subject.includes("clock-out"))).toBe(false);
      expect(await attendanceSwept()).toBe(1);

      // Nothing twice.
      expect(
        (await sweep(new Date(now.getTime() + HOUR))).created.filter((n) => n.type === "missed_clock_out"),
      ).toHaveLength(0);
    });

    it("stops once the clock-out is added, and a later miss notifies (and emails) as a new one", async () => {
      const now = new Date();
      // Kat's clock-in from the last test is now far enough back to count after a day: sweep a day on.
      const later = new Date(now.getTime() + 24 * HOUR);
      ctx.mailer.sent.length = 0;
      await ok(await clock(staff.Grace!, "out", new Date(now.getTime() - 20 * HOUR)), 201);
      const swept = await sweep(later);
      const created = swept.created.filter((n) => n.type === "missed_clock_out");
      // Grace is fixed; Alan was told already; Kat is new (told: Ada).
      expect(created.map((n) => n.data.staffName)).toEqual(["Kat Tester"]);
      await settle();
      expect(ctx.mailer.sent.some((m) => m.subject.includes("Kat Tester has no clock-out"))).toBe(true);
      const hidden = await inbox(ada.cookie, "missed_clock_out");
      expect(hidden).toHaveLength(3);
    });

    it("leaves old misses to the pages, and respects module access", async () => {
      const now = new Date();
      const bob = await ok(
        await send(ada.cookie, "POST", "/people/staff", {
          firstName: "Bob",
          lastName: "Old",
          staffNumber: "100004",
        }),
        201,
      );
      await ok(await clock(bob.id, "in", new Date(now.getTime() - 20 * 86_400_000)), 201);
      expect((await sweep(now)).created.filter((n) => n.type === "missed_clock_out")).toHaveLength(0);

      // Without the module no sweep runs for it, and the Inbox hides what exists.
      const off = await sweepDueNotifications(ctx.handle.db, {
        activeModules: moduleIds.filter((m) => m !== "attendance"),
        workspaceId,
        now: new Date(now.getTime() + 48 * HOUR),
      });
      expect(off.created.filter((n) => n.type === "missed_clock_out")).toHaveLength(0);
      await grant(marcus.userId, "attendance", null);
      expect(await inbox(marcus.cookie, "missed_clock_out")).toHaveLength(0);
      await grant(marcus.userId, "attendance", "read");
      expect(await inbox(marcus.cookie, "missed_clock_out")).toHaveLength(1);
    });
  });
});
