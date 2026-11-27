import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceMembers, workspaces } from "@knotworking/db";
import { and, eq } from "drizzle-orm";
import { withTimeZoneScope, workspaceTimeZone, workspaceToday } from "./services/time-zone";
import { addHaccpAsset, makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

/**
 * The workspace time zone decides business dates. These tests pick zones far enough apart that the
 * outcome doesn't depend on when they run: Kiritimati (UTC+14) is always a calendar day or two
 * ahead of Pago Pago (UTC-11).
 */
const AHEAD = "Pacific/Kiritimati";
const BEHIND = "Pacific/Pago_Pago";

describe("workspace time zone", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  let workspaceId: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const ok = async (res: { status: number; json(): Promise<any> }, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const code = async (res: { json(): Promise<any> }) => (await res.json()).error.code;
  const setZone = async (timeZone: string) => ok(await as(ada).send("PATCH", "/settings", { timeZone }));

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    marcus = {
      userId: members.find((x: { email: string }) => x.email === "marcus@knotworking.dev").userId,
      cookie: (await signIn(ctx, "marcus@knotworking.dev")).cookie,
    };
    token = (
      await ok(
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write" },
        }),
        201,
      )
    ).token;
    workspaceId = (await ok(await as(ada).get("/bootstrap"))).workspace.id;
  });
  afterAll(() => ctx.handle.close());

  describe("the setting", () => {
    it("defaults to Europe/London, and everyone (tokens too) can read it", async () => {
      expect(await ok(await as(marcus.cookie).get("/settings"))).toEqual({
        timeZone: DEFAULT_TIME_ZONE,
        timeZoneInvalid: false,
        currency: "GBP",
        financialYearStartMonth: 1,
        closedTaskWindowDays: 30,
      });
      const viaToken = await ctx.req(`${WS}/settings`, {
        headers: { authorization: `Bearer ${token}`, origin: "" },
      });
      expect(await ok(viaToken)).toEqual({
        timeZone: "Europe/London",
        timeZoneInvalid: false,
        currency: "GBP",
        financialYearStartMonth: 1,
        closedTaskWindowDays: 30,
      });
      expect((await ok(await as(ada).get("/bootstrap"))).workspace.timeZone).toBe("Europe/London");
    });

    it("is changed by owners and admins only, never by a token, and only to a real IANA zone", async () => {
      expect(
        await code(await as(marcus.cookie).send("PATCH", "/settings", { timeZone: "Europe/Paris" })),
      ).toBe("forbidden");
      const viaToken = await ctx.req(`${WS}/settings`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, origin: "" },
        json: { timeZone: "Europe/Paris" },
      });
      expect(viaToken.status).toBe(403);
      for (const timeZone of ["Mars/Olympus", "BST", "+01:00", ""]) {
        expect(await code(await as(ada).send("PATCH", "/settings", { timeZone }))).toBe("invalid_input");
      }
      expect(await setZone("america/new_york")).toEqual({
        timeZone: "America/New_York",
        timeZoneInvalid: false,
        currency: "GBP",
        financialYearStartMonth: 1,
        closedTaskWindowDays: 30,
      });
      expect(await ok(await as(marcus.cookie).get("/settings"))).toEqual({
        timeZone: "America/New_York",
        timeZoneInvalid: false,
        currency: "GBP",
        financialYearStartMonth: 1,
        closedTaskWindowDays: 30,
      });
      await setZone(DEFAULT_TIME_ZONE);
    });

    it("is the attendance settings' zone, read-only there", async () => {
      await setZone("Europe/Dublin");
      expect((await ok(await as(ada).get("/attendance/settings"))).timeZone).toBe("Europe/Dublin");
      expect(
        await code(
          await as(ada).send("PATCH", "/attendance/settings", {
            timeZone: "Europe/Paris",
            roundingMinutes: 5,
          }),
        ),
      ).toBe("invalid_input");
      const saved = await ok(await as(ada).send("PATCH", "/attendance/settings", { roundingMinutes: 5 }));
      expect(saved).toMatchObject({ roundingMinutes: 5, timeZone: "Europe/Dublin" });
      await setZone(DEFAULT_TIME_ZONE);
    });
  });

  it("lets only an owner set or clear a bounded avatar and syncs it to members", async () => {
    const icon =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAAAAADH8yjkAAAAIElEQVR4nO3BgQAAAADDoPlTX+AIVQEAAAAAAAAAAHQNJGAAAQbH8O4AAAAASUVORK5CYII=";
    const patch = (cookie: string, icon: string | null) => as(cookie).send("PATCH", "/settings", { icon });
    const { cursor } = await ok(await as(marcus.cookie).get("/bootstrap"));
    expect((await patch(marcus.cookie, icon)).status).toBe(403);
    const membership = and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, marcus.userId),
    );
    await ctx.handle.db.update(workspaceMembers).set({ role: "admin" }).where(membership);
    try {
      expect((await patch(marcus.cookie, icon)).status).toBe(403);
    } finally {
      await ctx.handle.db.update(workspaceMembers).set({ role: "member" }).where(membership);
    }
    expect(
      (
        await ctx.req(`${WS}/settings`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${token}`, origin: "" },
          json: { icon },
        })
      ).status,
    ).toBe(403);
    for (const invalid of [
      "https://example.test/avatar.png",
      "data:image/png;base64,AAAA",
      "data:image/svg+xml;base64,AAAA",
      `data:image/png;base64,${"A".repeat(65536)}`,
    ]) {
      expect((await patch(ada, invalid)).status).toBe(400);
    }
    await ok(await patch(ada, icon));
    expect((await ok(await as(marcus.cookie).get("/bootstrap"))).workspace.icon).toBe(icon);
    const { changes } = await ok(await as(marcus.cookie).get(`/sync?after=${cursor}`));
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: "workspace", data: expect.objectContaining({ icon }) }),
      ]),
    );
    await ok(await patch(ada, null));
    expect((await ok(await as(marcus.cookie).get("/bootstrap"))).workspace.icon).toBeNull();
  });

  describe("a stored zone the schema refuses", () => {
    const stored = async (timeZone: string) =>
      ctx.handle.db.update(workspaces).set({ timeZone }).where(eq(workspaces.id, workspaceId));

    it("falls back to the default everywhere, and says so on the settings and the bootstrap", async () => {
      for (const bad of ["GMT", "utc", "+01:00", "Etc/GMT+5"]) {
        await stored(bad);
        expect(await ok(await as(marcus.cookie).get("/settings")), bad).toEqual({
          timeZone: DEFAULT_TIME_ZONE,
          timeZoneInvalid: true,
          currency: "GBP",
          financialYearStartMonth: 1,
          closedTaskWindowDays: 30,
        });
        const { workspace } = await ok(await as(ada).get("/bootstrap"));
        expect(workspace).toMatchObject({ timeZone: DEFAULT_TIME_ZONE, timeZoneInvalid: true });
        expect(await workspaceTimeZone(ctx.handle.db, workspaceId)).toBe(DEFAULT_TIME_ZONE);
        // The workspace middleware agrees: the attendance settings read the zone in effect.
        expect((await ok(await as(ada).get("/attendance/settings"))).timeZone).toBe(DEFAULT_TIME_ZONE);
      }
      await stored("Asia/Tokyo");
      expect(await ok(await as(ada).get("/settings"))).toEqual({
        timeZone: "Asia/Tokyo",
        timeZoneInvalid: false,
        currency: "GBP",
        financialYearStartMonth: 1,
        closedTaskWindowDays: 30,
      });
      await setZone(DEFAULT_TIME_ZONE);
    });

    it("is replaced when an admin picks a proper zone", async () => {
      await stored("GMT");
      expect(await setZone("Europe/Paris")).toEqual({
        timeZone: "Europe/Paris",
        timeZoneInvalid: false,
        currency: "GBP",
        financialYearStartMonth: 1,
        closedTaskWindowDays: 30,
      });
      await setZone(DEFAULT_TIME_ZONE);
    });
  });

  describe("the zone lookup", () => {
    it("is read once per request scope, and a changed zone is seen by the next one", async () => {
      const db = ctx.handle.db;
      let selects = 0;
      const counting = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "select") selects++;
          return Reflect.get(target, prop, receiver);
        },
      });
      await withTimeZoneScope(async () => {
        expect(await workspaceTimeZone(counting, workspaceId)).toBe(DEFAULT_TIME_ZONE);
        expect(await workspaceTimeZone(counting, workspaceId)).toBe(DEFAULT_TIME_ZONE);
        expect(await workspaceToday(counting, workspaceId)).toBe(todayInZone(DEFAULT_TIME_ZONE));
      });
      expect(selects).toBe(1);
      // Outside a scope nothing is remembered.
      await workspaceTimeZone(counting, workspaceId);
      await workspaceTimeZone(counting, workspaceId);
      expect(selects).toBe(3);
      // A new request sees a zone changed by the previous one.
      await setZone("Asia/Tokyo");
      await withTimeZoneScope(async () => {
        expect(await workspaceTimeZone(db, workspaceId)).toBe("Asia/Tokyo");
      });
      await setZone(DEFAULT_TIME_ZONE);
    });
  });

  describe("business dates follow it", () => {
    it("works out today in the workspace's zone, not UTC", async () => {
      // 23:30 UTC on a summer evening is already the next day in London.
      const evening = new Date("2026-07-15T23:30:00Z");
      expect(await workspaceToday(ctx.handle.db, workspaceId, evening)).toBe("2026-07-16");
      await setZone("UTC");
      expect(await workspaceToday(ctx.handle.db, workspaceId, evening)).toBe("2026-07-15");
      await setZone(DEFAULT_TIME_ZONE);
    });

    it("refuses future dates by the workspace's calendar (quality: no future complaints)", async () => {
      const aheadToday = todayInZone(AHEAD);
      const complaint = (receivedOn: string) =>
        as(ada).send("POST", "/quality/complaints", {
          receivedOn,
          source: "customer",
          category: "other",
          description: "Found a hair in the loaf",
        });
      await setZone(BEHIND);
      expect(await code(await complaint(aheadToday))).toBe("invalid_input");
      await setZone(AHEAD);
      expect((await ok(await complaint(aheadToday), 201)).receivedOn).toBe(aheadToday);
      await setZone(DEFAULT_TIME_ZONE);
    });

    it("dates a calibration on the workspace's calendar, so its next due date moves with the zone", async () => {
      const probe = await addHaccpAsset(as(ada).send, {
        kind: "equipment",
        code: "TZ-PRB",
        name: "Probe for the time zone test",
        calibrationFrequency: { every: 1, unit: "month" },
        calibrationTolerance: 0.5,
        measurementUnit: "°C",
      });
      const calibrate = async () =>
        (
          await ok(
            await as(ada).send("POST", "/haccp/calibration", {
              assetId: probe.id,
              referenceReading: 100,
              actualReading: 100.2,
              // A summer evening: 15 July in UTC, already 16 July in London.
              calibratedAt: "2026-07-15T23:30:00.000Z",
            }),
            201,
          )
        ).nextDueOn;
      expect(await calibrate()).toBe("2026-08-16");
      await setZone("UTC");
      expect(await calibrate()).toBe("2026-08-15");

      // Record ranges (the audit prints) are local days too: in London both were made on the 16th.
      const onDay = async (day: string) =>
        (await ok(await as(ada).get(`/haccp/calibration?assetId=${probe.id}&from=${day}&to=${day}`))).records
          .length;
      expect(await onDay("2026-07-15")).toBe(2);
      await setZone(DEFAULT_TIME_ZONE);
      expect(await onDay("2026-07-15")).toBe(0);
      expect(await onDay("2026-07-16")).toBe(2);
    });

    it("puts what's due in the workspace's zone (training: due windows end on its calendar)", async () => {
      await setZone(AHEAD);
      const ahead = await ok(await as(ada).get("/training/due"));
      await setZone(BEHIND);
      const behind = await ok(await as(ada).get("/training/due"));
      expect(ahead.today).toBe(todayInZone(AHEAD));
      expect(behind.today).toBe(todayInZone(BEHIND));
      expect(ahead.today > behind.today).toBe(true);
      await setZone(DEFAULT_TIME_ZONE);
    });
  });
});
