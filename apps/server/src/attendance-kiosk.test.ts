import { createHash, randomUUID } from "node:crypto";
import {
  addDays,
  DEFAULT_TIME_ZONE,
  KIOSK_SEAL_HKDF_SALT,
  type KioskOfflineType,
  kioskSealAad,
  textToDoc,
  todayInZone,
} from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { attendanceKioskRejections, staff, users } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { HOST_SEARCHES_PER_MINUTE } from "./routes/kiosk";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const HOUR = 3_600_000;

interface Session {
  seal: { version: string; kid: string; publicKey: string };
}

/** Seals a payload the way the kiosk page does (WebCrypto: ECDH P-256, HKDF-SHA-256, AES-256-GCM). */
async function seal(
  session: Session,
  event: { clientId: string; type: KioskOfflineType; at: string },
  payload: unknown,
) {
  const subtle = globalThis.crypto.subtle;
  const enc = (s: string) => new TextEncoder().encode(s);
  const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as ArrayBuffer).toString("base64url");
  const server = await subtle.importKey(
    "raw",
    Buffer.from(session.seal.publicKey, "base64url"),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "ECDH", public: server }, eph.privateKey, 256);
  const hkdf = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const aes = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc(KIOSK_SEAL_HKDF_SALT), info: enc("aes-256-gcm") },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc(kioskSealAad(event)) },
    aes,
    enc(JSON.stringify(payload)),
  );
  const epk = await subtle.exportKey("raw", eph.publicKey);
  return [session.seal.version, session.seal.kid, b64u(epk), b64u(iv), b64u(data)].join(".");
}

describe("attendance kiosk extras", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  let device: string;
  let session: Session;
  const people: Record<string, { id: string; staffNumber: string; pin: string }> = {};

  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const kiosk = (method: string, path: string, json?: unknown) =>
    ctx.req(`/v1/kiosk${path}`, { method, headers: { authorization: `Bearer ${device}`, origin: "" }, json });
  const code = async (res: { json(): Promise<any> }) => (await res.json()).error.code;
  const ok = async (res: { status: number; json(): Promise<any> }, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const settings = async (patch: object) => ok(await as(ada).send("PATCH", "/attendance/settings", patch));

  /** One queued event, sealed, `hoursAgo` by the tablet's clock. */
  const queued = async (
    type: KioskOfflineType,
    payload: unknown,
    hoursAgo: number,
    clientId = randomUUID(),
  ) => {
    const event = { clientId, type, at: new Date(Date.now() - hoursAgo * HOUR).toISOString() };
    return { ...event, sealed: await seal(session, event, payload) };
  };
  const replay = async (events: unknown[], sentAt = new Date().toISOString()) =>
    (await ok(await kiosk("POST", "/replay", { sentAt, events }))).results as {
      clientId: string;
      status: string;
      code?: string;
      message?: string;
    }[];
  const shifts = async (staffId: string) => {
    const today = todayInZone(DEFAULT_TIME_ZONE);
    const from = addDays(todayInZone(DEFAULT_TIME_ZONE), -6);
    const res = await ok(await as(ada).get(`/attendance/shifts?from=${from}&to=${today}&staffId=${staffId}`));
    return (res.people[0]?.events ?? []) as { id: string; kind: string; at: string; offline: boolean }[];
  };

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
    const role = await ok(await as(ada).send("POST", "/people/job-roles", { name: "Line operative" }), 201);
    const startDate = addDays(todayInZone(DEFAULT_TIME_ZONE), -30);
    for (const [firstName, staffNumber, pin, extra] of [
      ["Grace", "100001", "482915", {}],
      ["Alan", "100002", "735190", { userId: marcus.userId, jobRoleIds: [role.id], startDate }],
      ["Kat", "100003", "908172", {}],
      ["Lin", "100004", "614283", {}],
    ] as const) {
      const person = await ok(
        await as(ada).send("POST", "/people/staff", {
          firstName,
          lastName: "Tester",
          staffNumber,
          department: "Bakery",
          ...extra,
        }),
        201,
      );
      await ok(await as(ada).send("PUT", `/people/staff/${person.id}/pin`, { pin }));
      people[firstName] = { id: person.id, staffNumber, pin };
    }
    const created = await ok(await as(ada).send("POST", "/attendance/devices", { name: "Gate" }), 201);
    device = (
      await ok(
        await ctx.req("/v1/public/kiosk/pair", { method: "POST", json: { code: created.pairingCode } }),
      )
    ).token;
    session = await ok(await kiosk("GET", "/session"));

    // Training: Alan's role needs an induction within 7 days of starting (30 days ago): overdue.
    const course = await ok(
      await as(ada).send("POST", "/training/courses", {
        code: "IND-1",
        title: "Site induction",
        kind: "induction",
      }),
      201,
    );
    await ok(
      await as(ada).send("PUT", `/training/courses/${course.id}/requirements`, {
        requirements: [{ jobRoleId: role.id, dueWithinDays: 7 }],
      }),
    );
    // SOPs: one approved procedure Alan's login (marcus) hasn't acknowledged.
    await ok(
      await ctx.req(`${WS}/members/${marcus.userId}/module-access/sops`, {
        method: "PUT",
        cookie: ada,
        json: { level: "write" },
      }),
    );
    const sop = await ok(
      await as(marcus.cookie).send("POST", "/sops", {
        code: "SOP-HW",
        title: "Handwashing",
        content: textToDoc("Wash for twenty seconds."),
      }),
      201,
    );
    const version = await ok(
      await as(marcus.cookie).send("POST", `/sops/${sop.id}/submit`, { changeSummary: "First issue" }),
      201,
    );
    await ok(
      await as(ada).send("POST", `/sops/${sop.id}/versions/${version.id}/decision`, { decision: "approve" }),
    );
  }, 120_000);
  afterAll(() => ctx.handle.close());

  describe("the kiosk session", () => {
    it("gives the kiosk its settings and the public key to seal offline events to", async () => {
      expect(session).toMatchObject({
        settings: { badgeRequiresPin: true, offlineReplayHours: 72, visitorSiteRules: null },
        seal: { version: "s1", kid: expect.stringMatching(/^[0-9a-f]{12}$/), publicKey: expect.any(String) },
      });
      expect(Buffer.from((session as any).seal.publicKey, "base64url")).toHaveLength(65);
    });
  });

  describe("idempotent clocking", () => {
    it("never clocks twice for the same client id, even past the double-tap window", async () => {
      const clientId = randomUUID();
      const { staffNumber, pin } = people.Lin!;
      const first = await ok(await kiosk("POST", "/clock", { staffNumber, pin, kind: "in", clientId }), 201);
      expect(first.repeated).toBe(false);
      const retry = await ok(await kiosk("POST", "/clock", { staffNumber, pin, kind: "in", clientId }), 201);
      expect(retry).toMatchObject({ repeated: true, at: first.at });
      expect((await shifts(people.Lin!.id)).filter((e) => e.kind === "in")).toHaveLength(1);
    });
  });

  describe("offline replay", () => {
    it("records queued events at the time they happened, marked offline, and accepts retries idempotently", async () => {
      const { staffNumber, pin } = people.Grace!;
      const clockIn = await queued("clock_in", { staffNumber, pin }, 3);
      const visitor = await queued(
        "visitor_in",
        { firstName: "Mary", lastName: "Somerville", company: "Analytical Ltd", acceptedRules: true },
        2,
      );
      const first = await replay([clockIn, visitor]);
      expect(first.map((r) => r.status)).toEqual(["accepted", "accepted"]);
      // A lost response: the kiosk sends the same batch again.
      const again = await replay([clockIn, visitor]);
      expect(again.map((r) => r.status)).toEqual(["duplicate", "duplicate"]);
      const events = await shifts(people.Grace!.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "in", offline: true });
      expect(Math.abs(Date.parse(events[0]!.at) - Date.parse(clockIn.at))).toBeLessThan(5_000);
      const here = await ok(await as(ada).get("/attendance/on-site"));
      expect(here.visitors.find((v: any) => v.firstName === "Mary")).toMatchObject({
        company: "Analytical Ltd",
        offline: true,
      });
    });

    it("corrects the tablet's clock by the offset sealed in the entry, never by sentAt", async () => {
      const { staffNumber, pin } = people.Grace!;
      // The tablet runs three minutes fast; it learnt so at its last session and sealed the offset.
      const fast = (ms: number) => new Date(ms + 3 * 60_000).toISOString();
      const event = {
        clientId: randomUUID(),
        type: "clock_out" as const,
        at: fast(Date.now() - 30 * 60_000),
      };
      const sealed = await seal(session, event, { staffNumber, pin, clockOffsetMs: -3 * 60_000 });
      // A batch `sentAt` claiming another time changes nothing: it isn't authenticated.
      const results = await replay([{ ...event, sealed }], new Date(Date.now() + 40 * HOUR).toISOString());
      expect(results[0]!.status).toBe("accepted");
      const out = (await shifts(people.Grace!.id)).find((e) => e.kind === "out")!;
      expect(Math.abs(Date.parse(out.at) - (Date.now() - 30 * 60_000))).toBeLessThan(10_000);
    });

    it("refuses an entry whose clock correction is more than a few minutes, and is never moved by sentAt", async () => {
      const visitor = { firstName: "Clock", lastName: "Skew" };
      // Sealed: an hour fast is more than the cap.
      const hourFast = await queued("visitor_in", { ...visitor, clockOffsetMs: -HOUR }, 0.5);
      expect((await replay([hourFast]))[0]).toMatchObject({ status: "rejected", code: "clock_skew" });
      // Queued before kiosks sealed their offset: `sentAt` is used, but only within the cap.
      const legacy = await queued("visitor_in", visitor, 0.01);
      const moved = await replay([legacy], new Date(Date.parse(legacy.at) + 40 * HOUR).toISOString());
      expect(moved[0]).toMatchObject({ status: "rejected", code: "clock_skew" });
      const legacyOk = await queued("visitor_in", { firstName: "Clock", lastName: "Drift" }, 0.5);
      // The tablet's clock two minutes slow: sentAt says two minutes earlier than now.
      const corrected = await replay([legacyOk], new Date(Date.now() - 2 * 60_000).toISOString());
      expect(corrected[0]!.status).toBe("accepted");
      const today = todayInZone(DEFAULT_TIME_ZONE);
      const { visits } = await ok(
        await as(ada).get(`/attendance/visits?from=${addDays(today, -1)}&to=${today}`),
      );
      const drift = visits.find((v: any) => v.lastName === "Drift");
      expect(Math.abs(Date.parse(drift.signedInAt) - (Date.parse(legacyOk.at) + 2 * 60_000))).toBeLessThan(
        5_000,
      );
      expect(visits.some((v: any) => v.lastName === "Skew")).toBe(false);
      await ok(await as(ada).send("POST", `/attendance/visits/${drift.id}/sign-out`));
    });

    it("refuses events outside the replay window or in the future, and keeps the refusal", async () => {
      const { staffNumber, pin } = people.Kat!;
      const old = await queued("clock_in", { staffNumber, pin }, 80);
      const future = await queued("clock_in", { staffNumber, pin }, -1);
      const [tooOld, ahead] = await replay([old, future]);
      expect(tooOld).toMatchObject({ status: "rejected", code: "replay_too_old" });
      expect(ahead).toMatchObject({ status: "rejected", code: "replay_in_future" });
      // A retry gets the same answer.
      expect((await replay([old]))[0]).toMatchObject({ status: "rejected", code: "replay_too_old" });
      // The window is a setting.
      await settings({ offlineReplayHours: 1 });
      const twoHours = await queued("clock_in", { staffNumber, pin }, 2);
      expect((await replay([twoHours]))[0]!.code).toBe("replay_too_old");
      await settings({ offlineReplayHours: 72 });
      expect(await shifts(people.Kat!.id)).toHaveLength(0);
    });

    it("refuses events that contradict the recorded clock events", async () => {
      const grace = { staffNumber: people.Grace!.staffNumber, pin: people.Grace!.pin };
      // Grace clocked in 3h ago and out 30 min ago: a clock-out inside that shift contradicts it.
      const outInside = await queued("clock_out", grace, 1);
      const [conflict] = await replay([outInside]);
      expect(conflict).toMatchObject({ status: "rejected", code: "replay_conflict" });
      expect(conflict!.message).toMatch(/clock-out .* already recorded/);
      // Kat has no clock-in: a clock-out can't close anything yet. It isn't refused for good (the
      // clock-in may be on another offline kiosk): it is deferred, and nothing is stored.
      const kat = { staffNumber: people.Kat!.staffNumber, pin: people.Kat!.pin };
      const [orphan] = await replay([await queued("clock_out", kat, 1)]);
      expect(orphan).toMatchObject({ status: "deferred", code: "awaiting_clock_in" });
      expect(orphan!.message).toMatch(/No clock-in/);
      // An offline in-then-out pair for Kat fits, in time order whatever order they are sent in.
      const pairIn = await queued("clock_in", kat, 5);
      const pairOut = await queued("clock_out", kat, 4);
      expect((await replay([pairOut, pairIn])).map((r) => r.status)).toEqual(["accepted", "accepted"]);
      // Clocking in again within that shift contradicts it; the same clock within two minutes is a duplicate.
      const [inside] = await replay([await queued("clock_in", kat, 4.5)]);
      expect(inside!.code).toBe("replay_conflict");
      const [tap] = await replay([await queued("clock_in", kat, 5 - 1 / 60)]);
      expect(tap!.status).toBe("duplicate");
      expect(await shifts(people.Kat!.id)).toHaveLength(2);
    });

    it("keeps a clock-out that reaches the server before its clock-in from another kiosk", async () => {
      // Lin clocks in on kiosk A and out on kiosk B, both offline; B replays first.
      const lin = { staffNumber: people.Lin!.staffNumber, pin: people.Lin!.pin };
      const before = (await shifts(people.Lin!.id)).length;
      const inA = await queued("clock_in", lin, 30);
      const outB = await queued("clock_out", lin, 26);
      expect((await replay([outB]))[0]).toMatchObject({ status: "deferred", code: "awaiting_clock_in" });
      const { rejections } = await ok(await as(ada).get("/attendance/kiosk-rejections?include=all"));
      expect(rejections.some((r: any) => r.clientId === outB.clientId)).toBe(false);
      expect((await replay([inA]))[0]!.status).toBe("accepted");
      // B tries again: now it fits.
      expect((await replay([outB]))[0]!.status).toBe("accepted");
      const events = await shifts(people.Lin!.id);
      expect(events.length).toBe(before + 2);
      // Once older than the replay window, a clock-out still waiting is refused for good.
      await settings({ offlineReplayHours: 1 });
      const late = await queued(
        "clock_out",
        { staffNumber: people.Kat!.staffNumber, pin: people.Kat!.pin },
        2,
      );
      expect((await replay([late]))[0]).toMatchObject({ status: "rejected", code: "replay_too_old" });
      await settings({ offlineReplayHours: 72 });
    });

    it("checks the PIN on replay, counting a wrong one once however often it is retried", async () => {
      const wrong = await queued("clock_in", { staffNumber: people.Kat!.staffNumber, pin: "111112" }, 1);
      for (let i = 0; i < 6; i++) {
        expect((await replay([wrong]))[0]).toMatchObject({ status: "rejected", code: "pin_invalid" });
      }
      // Five wrong PINs would have locked the number: one was counted.
      const kat = await ok(
        await kiosk("POST", "/identify", { staffNumber: people.Kat!.staffNumber, pin: people.Kat!.pin }),
      );
      expect(kat.firstName).toBe("Kat");
      const unknown = await queued("clock_in", { staffNumber: "999999", pin: "482915" }, 1);
      expect((await replay([unknown]))[0]!.code).toBe("pin_invalid");
    });

    it("counts a wrong PIN once when the same event is replayed concurrently", async () => {
      const lin = people.Lin!;
      const failures = async () =>
        (await ctx.handle.db.select().from(staff).where(eq(staff.id, lin.id)))[0]!.pinFailedAttempts;
      const before = await failures();
      const wrong = await queued("clock_in", { staffNumber: lin.staffNumber, pin: "000000" }, 0.5);
      const all = await Promise.all([replay([wrong]), replay([wrong]), replay([wrong])]);
      expect(all.map((r) => r[0]!.code)).toEqual(["pin_invalid", "pin_invalid", "pin_invalid"]);
      expect(await failures()).toBe(before + 1);
    });

    it("counts a wrong PIN once when the same batch is replayed concurrently", async () => {
      const wrong = await queued("clock_in", { staffNumber: people.Lin!.staffNumber, pin: "111113" }, 1);
      const results = await Promise.all(Array.from({ length: 6 }, () => replay([wrong])));
      for (const [r] of results) expect(r).toMatchObject({ status: "rejected", code: "pin_invalid" });
      const lin = await ok(
        await kiosk("POST", "/identify", { staffNumber: people.Lin!.staffNumber, pin: people.Lin!.pin }),
      );
      expect(lin.firstName).toBe("Lin");
    });

    it("refuses a seal moved to another event", async () => {
      const real = await queued(
        "clock_in",
        { staffNumber: people.Lin!.staffNumber, pin: people.Lin!.pin },
        1,
      );
      const [moved] = await replay([{ ...real, clientId: randomUUID() }]);
      expect(moved).toMatchObject({ status: "rejected", code: "seal_invalid" });
    });

    it("lists refused events for managers, who dismiss them once dealt with", async () => {
      expect((await as(marcus.cookie).get("/attendance/kiosk-rejections")).status).toBe(403);
      const { rejections } = await ok(await as(ada).get("/attendance/kiosk-rejections"));
      const codes = rejections.map((r: { code: string }) => r.code);
      expect(codes).toEqual(expect.arrayContaining(["replay_too_old", "replay_conflict", "pin_invalid"]));
      const wrongPin = rejections.find((r: any) => r.code === "pin_invalid" && r.staff?.firstName === "Kat");
      expect(wrongPin).toMatchObject({ type: "clock_in", staff: { firstName: "Kat" } });
      expect(rejections.find((r: any) => r.detail === "Staff number 999999")).toBeTruthy();
      const viaToken = await ctx.req(`${WS}/attendance/kiosk-rejections/${wrongPin.id}/dismiss`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin: "" },
      });
      expect(viaToken.status).toBe(403);
      expect(await code(viaToken)).toBe("token_not_allowed");
      await ok(await as(ada).send("POST", `/attendance/kiosk-rejections/${wrongPin.id}/dismiss`));
      const after = await ok(await as(ada).get("/attendance/kiosk-rejections"));
      expect(after.rejections.some((r: any) => r.id === wrongPin.id)).toBe(false);
      const all = await ok(await as(ada).get("/attendance/kiosk-rejections?include=all"));
      expect(all.rejections.find((r: any) => r.id === wrongPin.id).dismissedByName).toBe("Ada Park");
    });
  });

  describe("badges", () => {
    let badge: string;

    it("are issued by a manager in person, and hold an opaque code", async () => {
      const staffId = people.Grace!.id;
      expect(
        (
          await ctx.req(`${WS}/attendance/badges`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, origin: "" },
            json: { staffId },
          })
        ).status,
      ).toBe(403);
      const issued = await ok(await as(ada).send("POST", "/attendance/badges", { staffId }), 201);
      expect(issued.code).toMatch(/^[A-HJ-NP-Z2-9]{16}$/);
      expect(issued.code).not.toContain(people.Grace!.staffNumber);
      expect(issued.printed).toMatch(/^(\w{4}-){3}\w{4}$/);
      badge = issued.code;
      const list = await ok(await as(ada).get("/attendance/badges"));
      const row = list.people.find((p: any) => p.staff.id === staffId);
      expect(row.badge).toMatchObject({ hint: badge.slice(-4), issuedByName: "Ada Park" });
      expect(JSON.stringify(list)).not.toContain(badge);
    });

    it("signs in with the badge and the PIN by default", async () => {
      const lastUsed = async () =>
        (await ok(await as(ada).get("/attendance/badges"))).people.find(
          (p: any) => p.staff.id === people.Grace!.id,
        ).badge.lastUsedAt;
      expect(await code(await kiosk("POST", "/identify", { badge }))).toBe("pin_required");
      expect(await code(await kiosk("POST", "/identify", { badge, pin: "000002" }))).toBe("pin_invalid");
      // Refused or abandoned scans don't count as the badge being used.
      expect(await lastUsed()).toBeNull();
      const who = await ok(
        await kiosk("POST", "/identify", { badge: `knb:${badge.toLowerCase()}`, pin: people.Grace!.pin }),
      );
      expect(who.firstName).toBe("Grace");
      expect(await lastUsed()).toEqual(expect.any(String));
      expect(await code(await kiosk("POST", "/identify", { badge, pin: "000001" }))).toBe("pin_invalid");
    });

    it("signs in with the badge alone when the workspace allows it", async () => {
      await settings({ badgeRequiresPin: false });
      expect((await ok(await kiosk("POST", "/identify", { badge }))).firstName).toBe("Grace");
      await settings({ badgeRequiresPin: true });
    });

    it("stops working when reissued or revoked, online and offline", async () => {
      const reissued = await ok(
        await as(ada).send("POST", "/attendance/badges", { staffId: people.Grace!.id }),
        201,
      );
      expect(await code(await kiosk("POST", "/identify", { badge, pin: people.Grace!.pin }))).toBe(
        "badge_invalid",
      );
      const fresh = reissued.code as string;
      expect((await kiosk("POST", "/identify", { badge: fresh, pin: people.Grace!.pin })).status).toBe(200);
      const queuedBefore = await queued("clock_in", { badge: fresh, pin: people.Grace!.pin }, 0.1);
      expect((await as(marcus.cookie).send("DELETE", `/attendance/badges/${reissued.badge.id}`)).status).toBe(
        403,
      );
      await ok(await as(ada).send("DELETE", `/attendance/badges/${reissued.badge.id}`));
      expect(await code(await kiosk("POST", "/identify", { badge: fresh, pin: people.Grace!.pin }))).toBe(
        "badge_invalid",
      );
      // Queued before the revocation, replayed after: refused.
      expect((await replay([queuedBefore]))[0]).toMatchObject({ status: "rejected", code: "badge_invalid" });
      expect(await code(await as(ada).send("DELETE", `/attendance/badges/${reissued.badge.id}`))).toBe(
        "not_found",
      );
    });
  });

  describe("visitors", () => {
    it("finds hosts among staff and members by the start of a name, names only", async () => {
      expect((await kiosk("GET", "/hosts?q=a")).status).toBe(400);
      expect((await kiosk("GET", "/hosts?q=ad")).status).toBe(400);
      expect((await kiosk("GET", "/hosts?q=gr")).status).toBe(400);
      const { hosts } = await ok(await kiosk("GET", "/hosts?q=grace"));
      // No department: the kiosk is a shared screen.
      expect(hosts).toEqual([{ kind: "staff", id: people.Grace!.id, name: "Grace Tester" }]);
      // The start of a first or last name, never the middle, and `%` or `_` match literally.
      expect((await ok(await kiosk("GET", "/hosts?q=race"))).hosts).toEqual([]);
      expect((await ok(await kiosk("GET", `/hosts?q=${encodeURIComponent("%_%")}`))).hosts).toEqual([]);
      expect((await ok(await kiosk("GET", "/hosts?q=tes"))).hosts.length).toBeGreaterThan(1);
      const adaHosts = (await ok(await kiosk("GET", "/hosts?q=ada"))).hosts;
      expect(adaHosts.some((h: any) => h.kind === "member" && h.name === "Ada Park")).toBe(true);
      expect(
        (await ok(await kiosk("GET", "/hosts?q=par"))).hosts.some((h: any) => h.name === "Ada Park"),
      ).toBe(true);
      // Marcus is Alan on the staff list, so he appears once, as Alan.
      const marcusHosts = (await ok(await kiosk("GET", "/hosts?q=marcus"))).hosts;
      expect(marcusHosts.some((h: any) => h.kind === "member")).toBe(false);
      // Guests aren't hosts.
      const { members } = await ok(await as(ada).get("/members"));
      const other = members.find(
        (m: any) => m.role === "member" && m.userId !== marcus.userId && m.name.length >= 3,
      );
      const before = (await ok(await kiosk("GET", `/hosts?q=${encodeURIComponent(other.name)}`))).hosts;
      expect(before.some((h: any) => h.kind === "member" && h.id === other.userId)).toBe(true);
      await ok(await as(ada).send("PATCH", `/members/${other.userId}`, { role: "guest" }));
      const after = (await ok(await kiosk("GET", `/hosts?q=${encodeURIComponent(other.name)}`))).hosts;
      expect(after.some((h: any) => h.id === other.userId)).toBe(false);
      await ok(await as(ada).send("PATCH", `/members/${other.userId}`, { role: "member" }));
    });

    it("never offers guests, deleted accounts, or a leaver in place of their member", async () => {
      const { members } = await ok(await as(ada).get("/members"));
      const idOf = (email: string) => members.find((m: any) => m.email === email).userId as string;
      expect((await ok(await kiosk("GET", "/hosts?q=noor"))).hosts).toHaveLength(1);
      await ok(await as(ada).send("PATCH", `/members/${idOf("noor@knotworking.dev")}`, { role: "guest" }));
      expect((await ok(await kiosk("GET", "/hosts?q=noor"))).hosts).toEqual([]);
      expect((await ok(await kiosk("GET", "/hosts?q=hadd"))).hosts).toEqual([]);

      expect((await ok(await kiosk("GET", "/hosts?q=tom"))).hosts).toHaveLength(1);
      await ctx.handle.db
        .update(users)
        .set({ deletedAt: new Date() })
        .where(eq(users.id, idOf("tomas@knotworking.dev")));
      expect((await ok(await kiosk("GET", "/hosts?q=tom"))).hosts).toEqual([]);

      // Alan (linked to Marcus) leaves: Marcus can still be visited, as a member.
      await ok(await as(ada).send("PATCH", `/people/staff/${people.Alan!.id}`, { status: "leaver" }));
      expect((await ok(await kiosk("GET", "/hosts?q=marcus"))).hosts).toEqual([
        { kind: "member", id: marcus.userId, name: "Marcus Chen" },
      ]);
      await ok(await as(ada).send("PATCH", `/people/staff/${people.Alan!.id}`, { status: "active" }));
    });

    it("records company, host and the site rules accepted", async () => {
      await settings({ visitorSiteRules: "Wear a hairnet. No glass beyond this point." });
      expect((await ok(await kiosk("GET", "/session"))).settings.visitorSiteRules).toMatch(/hairnet/);
      const visit = { firstName: "Ada", lastName: "Byron", company: "Engines plc" };
      expect(await code(await kiosk("POST", "/visitors/sign-in", visit))).toBe("site_rules_required");
      expect(
        await code(
          await kiosk("POST", "/visitors/sign-in", {
            ...visit,
            acceptedRules: true,
            host: { kind: "staff", id: randomUUID() },
          }),
        ),
      ).toBe("host_not_found");
      const clientId = randomUUID();
      const body = {
        ...visit,
        acceptedRules: true,
        host: { kind: "staff", id: people.Grace!.id },
        clientId,
      };
      const signedIn = await ok(await kiosk("POST", "/visitors/sign-in", body), 201);
      expect((await ok(await kiosk("POST", "/visitors/sign-in", body), 201)).repeated).toBe(true);
      expect(signedIn.repeated).toBe(false);
      await ok(
        await kiosk("POST", "/visitors/sign-in", {
          firstName: "Charles",
          lastName: "Babbage",
          acceptedRules: true,
          host: { kind: "member", id: marcus.userId },
        }),
        201,
      );

      const today = todayInZone(DEFAULT_TIME_ZONE);
      const { visits } = await ok(await as(ada).get(`/attendance/visits?from=${today}&to=${today}`));
      expect(visits.find((v: any) => v.lastName === "Byron")).toMatchObject({
        company: "Engines plc",
        hostName: "Grace Tester",
        hostStaffId: people.Grace!.id,
        siteRules: "Wear a hairnet. No glass beyond this point.",
        siteRulesAcceptedAt: expect.any(String),
      });
      const here = await ok(await as(ada).get("/attendance/on-site"));
      expect(here.visitors.find((v: any) => v.lastName === "Babbage")).toMatchObject({
        hostName: "Marcus Chen",
      });
      const call = await ok(await as(ada).send("POST", "/attendance/roll-calls", { kind: "drill" }), 201);
      expect(call.entries.find((e: any) => e.name === "Ada Byron").detail).toBe(
        "Visitor · Engines plc · visiting Grace Tester",
      );
      await ok(await as(ada).send("POST", `/attendance/roll-calls/${call.id}/end`, {}));
      await settings({ visitorSiteRules: null });
    });

    it("records an offline sign-in against what the kiosk showed, whatever changed since", async () => {
      const hash = (text: string) => createHash("sha256").update(text).digest("hex");
      const today = todayInZone(DEFAULT_TIME_ZONE);
      const visitsByName = async () => {
        const { visits } = await ok(
          await as(ada).get(`/attendance/visits?from=${addDays(today, -1)}&to=${today}`),
        );
        return new Map(visits.map((v: any) => [v.lastName, v]));
      };
      // Rules were added while the kiosk was offline: it showed none.
      await settings({ visitorSiteRules: "Hairnets beyond the yellow line." });
      const noRules = await queued(
        "visitor_in",
        { firstName: "Off", lastName: "Norules", siteRules: null },
        1,
      );
      // Rules changed while it was offline: it showed the old ones, which she accepted.
      const oldRules = await queued(
        "visitor_in",
        { firstName: "Off", lastName: "Oldrules", acceptedRules: true, siteRules: "No glass." },
        1,
      );
      // Today's rules, as shown.
      const sameRules = await queued(
        "visitor_in",
        {
          firstName: "Off",
          lastName: "Samerules",
          acceptedRules: true,
          siteRules: "Hairnets beyond the yellow line.",
        },
        1,
      );
      // Queued by a kiosk that didn't yet seal what it showed.
      const legacy = await queued("visitor_in", { firstName: "Off", lastName: "Legacy" }, 1);
      // The host was picked while online, then left before the sign-in was sent.
      const hostLeft = await queued(
        "visitor_in",
        {
          firstName: "Off",
          lastName: "Hostleft",
          host: { kind: "staff", id: people.Kat!.id },
          hostName: "Kat Tester",
          siteRules: null,
        },
        1,
      );
      await ok(await as(ada).send("PATCH", `/people/staff/${people.Kat!.id}`, { status: "leaver" }));
      const results = await replay([noRules, oldRules, sameRules, legacy, hostLeft]);
      expect(results.map((r) => r.status)).toEqual([
        "accepted",
        "accepted",
        "accepted",
        "accepted",
        "accepted",
      ]);

      const v = await visitsByName();
      expect(v.get("Norules")).toMatchObject({
        siteRules: null,
        siteRulesHash: null,
        siteRulesAcceptedAt: null,
      });
      expect(v.get("Oldrules")).toMatchObject({
        siteRules: "No glass.",
        siteRulesHash: hash("No glass."),
        siteRulesAcceptedAt: expect.any(String),
      });
      expect(v.get("Samerules")).toMatchObject({
        siteRules: "Hairnets beyond the yellow line.",
        siteRulesHash: hash("Hairnets beyond the yellow line."),
      });
      expect(v.get("Legacy")).toMatchObject({ siteRules: null, siteRulesAcceptedAt: null });
      expect(v.get("Hostleft")).toMatchObject({
        hostStaffId: null,
        hostName: "Kat Tester",
        hostMissing: true,
      });
      // Everyone physically there is on the register and in a roll call.
      const here = await ok(await as(ada).get("/attendance/on-site"));
      const onSite = here.visitors.map((x: any) => x.lastName);
      expect(onSite).toEqual(
        expect.arrayContaining(["Norules", "Oldrules", "Samerules", "Legacy", "Hostleft"]),
      );
      expect(here.visitors.find((x: any) => x.lastName === "Hostleft")).toMatchObject({ hostMissing: true });
      const call = await ok(await as(ada).send("POST", "/attendance/roll-calls", { kind: "drill" }), 201);
      expect(call.entries.find((e: any) => e.name === "Off Hostleft").detail).toBe(
        "Visitor · visiting Kat Tester",
      );
      await ok(await as(ada).send("POST", `/attendance/roll-calls/${call.id}/end`, {}));

      // Live sign-ins still need today's rules and a current host.
      expect(
        await code(await kiosk("POST", "/visitors/sign-in", { firstName: "Live", lastName: "One" })),
      ).toBe("site_rules_required");
      expect(
        await code(
          await kiosk("POST", "/visitors/sign-in", {
            firstName: "Live",
            lastName: "One",
            acceptedRules: true,
            host: { kind: "staff", id: people.Kat!.id },
          }),
        ),
      ).toBe("host_not_found");

      await ok(await as(ada).send("PATCH", `/people/staff/${people.Kat!.id}`, { status: "active" }));
      await settings({ visitorSiteRules: null });
      for (const name of ["Norules", "Oldrules", "Samerules", "Legacy", "Hostleft"]) {
        await ok(await as(ada).send("POST", `/attendance/visits/${(v.get(name) as any).id}/sign-out`));
      }
    });

    it("records the site rules the tablet showed an offline visitor, not the rules in force on replay", async () => {
      await settings({ visitorSiteRules: "New rules: hard hats." });
      // Queued while the kiosk showed the old rules, replayed after a manager changed them.
      const shown = await queued(
        "visitor_in",
        { firstName: "Emmy", lastName: "Noether", acceptedRules: true, siteRules: "Old rules: hairnets." },
        0.5,
      );
      // Queued when the kiosk had no rules to show: no acceptance needed.
      const none = await queued(
        "visitor_in",
        { firstName: "Hedy", lastName: "Lamarr", acceptedRules: false, siteRules: null },
        0.5,
      );
      // An older tablet's event without the rules it showed is recorded too (the person is on
      // site), with no rules accepted.
      const legacy = await queued("visitor_in", { firstName: "Rosalind", lastName: "Franklin" }, 0.5);
      const results = await replay([shown, none, legacy]);
      expect(results.map((r) => r.status)).toEqual(["accepted", "accepted", "accepted"]);
      const today = todayInZone(DEFAULT_TIME_ZONE);
      const { visits } = await ok(await as(ada).get(`/attendance/visits?from=${today}&to=${today}`));
      expect(visits.find((v: any) => v.lastName === "Noether")).toMatchObject({
        siteRules: "Old rules: hairnets.",
        siteRulesAcceptedAt: expect.any(String),
      });
      expect(visits.find((v: any) => v.lastName === "Lamarr")).toMatchObject({
        siteRules: null,
        siteRulesAcceptedAt: null,
      });
      expect(visits.find((v: any) => v.lastName === "Franklin")).toMatchObject({
        siteRules: null,
        siteRulesAcceptedAt: null,
      });
      await settings({ visitorSiteRules: null });
    });

    it("purges refused visitor entries (which name the visitor) with old visits", async () => {
      // A sign-out for someone who never signed in is refused, naming them.
      const ghost = await queued("visitor_out", { firstName: "Rosalind", lastName: "Ghost" }, 0.5);
      expect((await replay([ghost]))[0]).toMatchObject({ status: "rejected", code: "visitor_not_found" });
      const { rejections } = await ok(await as(ada).get("/attendance/kiosk-rejections?include=all"));
      const refused = rejections.find((r: any) => r.detail === "Visitor Rosalind Ghost");
      expect(refused).toBeTruthy();
      const longAgo = new Date(Date.now() - 30 * 31 * 24 * HOUR);
      await ctx.handle.db
        .update(attendanceKioskRejections)
        .set({ at: longAgo })
        .where(eq(attendanceKioskRejections.id, refused.id));
      // Any visitor write purges what is past retention.
      await ok(await kiosk("POST", "/visitors/sign-in", { firstName: "Ida", lastName: "Lovelace" }), 201);
      const after = await ok(await as(ada).get("/attendance/kiosk-rejections?include=all"));
      expect(after.rejections.some((r: any) => r.id === refused.id)).toBe(false);
      // Clock refusals stay.
      expect(after.rejections.some((r: any) => r.code === "pin_invalid")).toBe(true);
    });

    it("signs visitors out offline at the time they left, once", async () => {
      const out = await queued("visitor_out", { firstName: "ada", lastName: "byron" }, 0);
      expect((await replay([out]))[0]!.status).toBe("accepted");
      expect((await replay([out]))[0]!.status).toBe("duplicate");
      const missing = await queued("visitor_out", { firstName: "No", lastName: "One" }, 0.25);
      expect((await replay([missing]))[0]).toMatchObject({ status: "rejected", code: "visitor_not_found" });
      const today = todayInZone(DEFAULT_TIME_ZONE);
      const { visits } = await ok(await as(ada).get(`/attendance/visits?from=${today}&to=${today}`));
      const byron = visits.find((v: any) => v.lastName === "Byron");
      expect(byron.signedOutOffline).toBe(true);
      expect(Math.abs(Date.parse(byron.signedOutAt) - Date.parse(out.at))).toBeLessThan(5_000);
    });
  });

  describe("host search limit", () => {
    it("rate-limits host searches per kiosk", async () => {
      let status = 200;
      for (let i = 0; i <= HOST_SEARCHES_PER_MINUTE && status === 200; i++) {
        status = (await kiosk("GET", "/hosts?q=zzz")).status;
      }
      expect(status).toBe(429);
    });
  });

  describe("prompts at clock-in", () => {
    let prompts: any;

    it("shows overdue training and unacknowledged SOPs after clocking in", async () => {
      const { staffNumber, pin } = people.Alan!;
      const res = await ok(await kiosk("POST", "/clock", { staffNumber, pin, kind: "in" }), 201);
      prompts = res.prompts;
      expect(prompts.training).toEqual([
        expect.objectContaining({ code: "IND-1", title: "Site induction", status: "missing", overdue: true }),
      ]);
      expect(prompts.sops).toEqual([expect.objectContaining({ code: "SOP-HW", title: "Handwashing" })]);
      expect(prompts.promptToken).toEqual(expect.any(String));
      // Nothing for clocking out, and no SOPs for staff without a login.
      expect(
        (await ok(await kiosk("POST", "/clock", { staffNumber, pin, kind: "out" }), 201)).prompts,
      ).toBeNull();
      const lin = await ok(
        await kiosk("POST", "/clock", {
          staffNumber: people.Lin!.staffNumber,
          pin: people.Lin!.pin,
          kind: "in",
        }),
        201,
      );
      expect(lin.prompts).toMatchObject({ sops: [], promptToken: null });
    });

    it("lets the prompt token lapse two minutes after its last use", async () => {
      const sop = prompts.sops[0];
      const read = (promptToken: string) => kiosk("POST", `/sops/${sop.sopId}/read`, { promptToken });
      const start = Date.now();
      const renewed = (await ok(await read(prompts.promptToken))).promptToken as string;
      try {
        vi.useFakeTimers({ now: start + 90_000, toFake: ["Date"] });
        const later = (await ok(await read(renewed))).promptToken as string;
        vi.setSystemTime(start + 150_000);
        // The token from clock-in has lapsed; the one renewed 60 seconds ago hasn't.
        expect(await code(await read(prompts.promptToken))).toBe("prompt_expired");
        expect(await code(await read(renewed))).toBe("prompt_expired");
        expect((await read(later)).status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    });

    it("lets a linked member read and acknowledge an SOP with the prompt token", async () => {
      const sop = prompts.sops[0];
      const read = await ok(
        await kiosk("POST", `/sops/${sop.sopId}/read`, { promptToken: prompts.promptToken }),
      );
      expect(JSON.stringify(read.content)).toContain("twenty seconds");
      expect(
        await code(
          await kiosk("POST", `/sops/${sop.sopId}/read`, { promptToken: `${prompts.promptToken}x` }),
        ),
      ).toBe("prompt_expired");
      const ack = await ok(
        await kiosk("POST", `/sops/${sop.sopId}/acknowledge`, {
          promptToken: prompts.promptToken,
          versionId: sop.versionId,
        }),
        201,
      );
      expect(ack.versionId).toBe(sop.versionId);
      expect(ack.promptToken).toEqual(expect.any(String));
      const detail = await ok(await as(marcus.cookie).get(`/sops/${sop.sopId}`));
      expect(detail.acknowledged).toBe(true);
      expect(
        await code(
          await kiosk("POST", `/sops/${sop.sopId}/acknowledge`, {
            promptToken: prompts.promptToken,
            versionId: sop.versionId,
          }),
        ),
      ).toBe("already_acknowledged");
    });

    it("respects module activation", async () => {
      const off = await makeApp({ seed: true, activeModules: ["tasks", "people", "attendance"] });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const person = await (
        await off.req(`${WS}/people/staff`, {
          method: "POST",
          cookie,
          json: { firstName: "Solo", lastName: "Tester", staffNumber: "100009" },
        })
      ).json();
      await off.req(`${WS}/people/staff/${person.id}/pin`, {
        method: "PUT",
        cookie,
        json: { pin: "482915" },
      });
      const created = await (
        await off.req(`${WS}/attendance/devices`, { method: "POST", cookie, json: { name: "x" } })
      ).json();
      const { token: offDevice } = await (
        await off.req("/v1/public/kiosk/pair", { method: "POST", json: { code: created.pairingCode } })
      ).json();
      const res = await off.req("/v1/kiosk/clock", {
        method: "POST",
        headers: { authorization: `Bearer ${offDevice}`, origin: "" },
        json: { staffNumber: "100009", pin: "482915", kind: "in" },
      });
      expect((await res.json()).prompts).toEqual({ training: [], sops: [], sopsTotal: 0, promptToken: null });
      await off.handle.close();
    }, 60_000);
  });
});
