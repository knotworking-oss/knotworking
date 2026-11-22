import { accounts, calendarConnections, meetings, users, workspaceMembers } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCalendarService } from "./calendar/fake-provider";
import { GOOGLE_CALENDAR_SCOPE } from "./calendar/google";
import { syncableConnections } from "./calendar/scheduler";
import { pushMeetingNow, syncConnection } from "./calendar/sync";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const fake = new FakeCalendarService("google");
const tokenFor = (userId: string) => `token-${userId}`;

describe("calendar sync", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: string;
  let ids: Record<string, string>;
  const day = (offsetDays: number, hour: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offsetDays);
    d.setUTCHours(hour, 0, 0, 0);
    return d;
  };
  const sync = (who: "ada" | "marcus") =>
    ctx.handle.db
      .select()
      .from(calendarConnections)
      .where(eq(calendarConnections.userId, ids[who]!))
      .then(([c]) => syncConnection(ctx.calendar, c!.id));

  beforeAll(async () => {
    ctx = await makeApp({
      seed: true,
      calendar: () => ({
        providers: { google: fake.client() },
        getAccessToken: async (_accountId, userId) => tokenFor(userId),
      }),
    });
    const people = await ctx.handle.db.select().from(users);
    ids = Object.fromEntries(people.map((u) => [u.email.split("@")[0]!, u.id]));
    // Ada and Marcus "connected Google Calendar": a linked account with the calendar scope.
    for (const who of ["ada", "marcus"] as const) {
      await ctx.handle.db.insert(accounts).values({
        userId: ids[who]!,
        providerId: "google",
        accountId: `google-${who}`,
        scope: `openid,email,profile,${GOOGLE_CALENDAR_SCOPE}`,
      });
      fake.addAccount(tokenFor(ids[who]!), `${who}@knotworking.dev`);
    }
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("detects connected calendars from linked accounts", async () => {
    const res = await (await ctx.req("/v1/calendar/connections", { cookie: ada })).json();
    expect(res.available).toEqual(["google"]);
    expect(res.connections).toEqual([expect.objectContaining({ provider: "google", status: "active" })]);
    await ctx.req("/v1/calendar/connections", { cookie: marcus });
  });

  it("mirrors a member's own events privately", async () => {
    fake.put(tokenFor(ids.ada!), {
      externalId: "dentist",
      title: "Dentist",
      startsAt: day(1, 9),
      endsAt: day(1, 10),
      attendees: [],
    });
    const r = await sync("ada");
    expect(r).toMatchObject({ full: true, pulled: 1 });

    const range = `from=${day(-1, 0).toISOString()}&to=${day(7, 0).toISOString()}`;
    const mine = await (await ctx.req(`/v1/workspaces/acme/calendar?${range}`, { cookie: ada })).json();
    expect(mine.events.map((e: { title: string }) => e.title)).toEqual(["Dentist"]);
    const theirs = await (await ctx.req(`/v1/workspaces/acme/calendar?${range}`, { cookie: marcus })).json();
    expect(theirs.events).toEqual([]); // never visible to teammates
  });

  it("pushes a new Knotworking meeting to the organizer's calendar and invites attendees", async () => {
    const res = await ctx.req("/v1/workspaces/acme/meetings", {
      method: "POST",
      cookie: ada,
      json: {
        title: "Release planning",
        startsAt: day(2, 14).toISOString(),
        endsAt: day(2, 15).toISOString(),
        attendeeEmails: ["marcus@knotworking.dev", "client@example.com"],
        addVideoCall: true,
        createNotes: true,
      },
    });
    expect(res.status).toBe(201);
    const meeting = await res.json();
    expect(meeting).toMatchObject({
      syncState: "synced",
      provider: "google",
      conferenceUrl: "https://meet.example/abc-defg-hij",
    });
    expect(meeting.documentId).toBeTruthy();
    expect(meeting.attendees.map((a: { email: string }) => a.email).sort()).toEqual([
      "ada@knotworking.dev",
      "client@example.com",
      "marcus@knotworking.dev",
    ]);
    const inAdasCalendar = fake.events(tokenFor(ids.ada!)).find((e) => e.title === "Release planning");
    expect(inAdasCalendar?.attendees.map((a) => a.email)).toContain("client@example.com");
    // The provider delivered an invite to Marcus's calendar.
    expect(fake.events(tokenFor(ids.marcus!)).some((e) => e.iCalUid === meeting.iCalUid)).toBe(true);
  });

  it("links invitees' copies (no duplicates) and syncs RSVPs back", async () => {
    const [m] = await ctx.handle.db.select().from(meetings).where(eq(meetings.title, "Release planning"));
    fake.respond(tokenFor(ids.marcus!), m!.iCalUid!, "accepted");
    await sync("marcus");

    const range = `from=${day(-1, 0).toISOString()}&to=${day(7, 0).toISOString()}`;
    const view = await (await ctx.req(`/v1/workspaces/acme/calendar?${range}`, { cookie: marcus })).json();
    expect(view.events.find((e: { title: string }) => e.title === "Release planning")).toBeUndefined();
    const meeting = view.meetings.find((x: { title: string }) => x.title === "Release planning");
    expect(
      meeting.attendees.find((a: { email: string }) => a.email === "marcus@knotworking.dev").response,
    ).toBe("accepted");
  });

  it("keeps the organizer's external calendar links and guests' view of emails out of other viewers' hands", async () => {
    const [m] = await ctx.handle.db.select().from(meetings).where(eq(meetings.title, "Release planning"));
    expect(m!.connectionId && m!.externalEventId).toBeTruthy();
    const linkFields = ["connectionId", "externalEventId", "htmlLink"] as const;

    // A guest (outside collaborator).
    const invite = await (
      await ctx.req("/v1/workspaces/acme/invitations", {
        method: "POST",
        cookie: ada,
        json: { email: "guest@partner.test", role: "guest" },
      })
    ).json();
    await ctx.req(`/v1/public/invitations/${invite.url.split("/invite/")[1]}/accept`, {
      method: "POST",
      json: { name: "Gail Guest", password: "guest-password-1" },
    });
    const guest = (await signIn(ctx, "guest@partner.test", "guest-password-1")).cookie;

    const syncLog = async (cookie: string) => {
      const page = await (await ctx.req("/v1/workspaces/acme/sync?after=0&limit=1000", { cookie })).json();
      return page.changes as { entity: string; action: string; data: Record<string, unknown> | null }[];
    };
    const meetingRow = (changes: Awaited<ReturnType<typeof syncLog>>) =>
      changes.findLast((c) => c.entity === "meeting" && c.data?.id === m!.id)!.data!; // latest version

    // The organizer and admins keep the links, and calendar sync itself is untouched.
    const adaRow = meetingRow(await syncLog(ada));
    expect(adaRow.connectionId).toBe(m!.connectionId);
    expect(adaRow.externalEventId).toBe(m!.externalEventId);
    const boot = (cookie: string) =>
      ctx.req("/v1/workspaces/acme/bootstrap", { cookie }).then((r) => r.json());
    const adaMeeting = (await boot(ada)).meetings.find((x: { id: string }) => x.id === m!.id);
    expect(adaMeeting.externalEventId).toBe(m!.externalEventId);

    // Other members and guests get nulls — in /sync, bootstrap and the meeting endpoints.
    for (const cookie of [marcus, guest]) {
      const log = await syncLog(cookie);
      const row = meetingRow(log);
      expect(row.title).toBe("Release planning");
      // Every version of every meeting in the log, not just the latest.
      for (const change of log.filter((c) => c.entity === "meeting" && c.data))
        for (const f of linkFields) expect(change.data![f], `/sync ${f}`).toBeNull();

      const bm = (await boot(cookie)).meetings.find((x: { id: string }) => x.id === m!.id);
      for (const f of linkFields) expect(bm[f], `bootstrap ${f}`).toBeNull();

      const single = await (await ctx.req(`/v1/workspaces/acme/meetings/${m!.id}`, { cookie })).json();
      for (const f of linkFields) expect(single[f], `meeting ${f}`).toBeNull();
    }

    // Guests additionally get no attendee email addresses anywhere.
    const attendeeRows = (await syncLog(guest)).filter((c) => c.entity === "meeting_attendee");
    expect(attendeeRows.length).toBeGreaterThan(0);
    expect(attendeeRows.every((c) => c.data?.email === "")).toBe(true);
    const memberAttendees = (await syncLog(marcus)).filter((c) => c.entity === "meeting_attendee");
    expect(memberAttendees.some((c) => c.data?.email === "client@example.com")).toBe(true);
    // The stored rows are not modified by redaction.
    const [stored] = await ctx.handle.db.select().from(meetings).where(eq(meetings.id, m!.id));
    expect(stored!.externalEventId).toBe(m!.externalEventId);
  });

  it("applies changes the organizer makes in their calendar app", async () => {
    const [m] = await ctx.handle.db.select().from(meetings).where(eq(meetings.title, "Release planning"));
    fake.put(tokenFor(ids.ada!), {
      externalId: m!.externalEventId!,
      title: "Release planning (moved)",
      startsAt: day(3, 10),
      endsAt: day(3, 11),
    });
    await sync("ada");
    const updated = await (await ctx.req(`/v1/workspaces/acme/meetings/${m!.id}`, { cookie: ada })).json();
    expect(updated.title).toBe("Release planning (moved)");
    expect(new Date(updated.startsAt).toISOString()).toBe(day(3, 10).toISOString());
  });

  it("pushes Knotworking edits and cancellations out", async () => {
    const [m] = await ctx.handle.db
      .select()
      .from(meetings)
      .where(eq(meetings.title, "Release planning (moved)"));
    const patched = await ctx.req(`/v1/workspaces/acme/meetings/${m!.id}`, {
      method: "PATCH",
      cookie: ada,
      json: { location: "Room 4", attendeeEmails: ["marcus@knotworking.dev"] },
    });
    expect((await patched.json()).syncState).toBe("synced");
    const remote = fake.events(tokenFor(ids.ada!)).find((e) => e.externalId === m!.externalEventId);
    expect(remote?.location).toBe("Room 4");
    expect(remote?.attendees.map((a) => a.email)).not.toContain("client@example.com");

    // Only the organizer (or an admin) may edit.
    const denied = await ctx.req(`/v1/workspaces/acme/meetings/${m!.id}`, {
      method: "PATCH",
      cookie: marcus,
      json: { title: "x" },
    });
    expect(denied.status).toBe(403);

    await ctx.req(`/v1/workspaces/acme/meetings/${m!.id}/cancel`, { method: "POST", cookie: ada });
    expect(fake.events(tokenFor(ids.ada!)).some((e) => e.externalId === m!.externalEventId)).toBe(false);
    expect(fake.events(tokenFor(ids.marcus!)).some((e) => e.iCalUid === m!.iCalUid)).toBe(false);
  });

  it("cancels the meeting when the organizer deletes the event externally", async () => {
    const created = await (
      await ctx.req("/v1/workspaces/acme/meetings", {
        method: "POST",
        cookie: ada,
        json: { title: "1:1", startsAt: day(4, 9).toISOString(), endsAt: day(4, 10).toISOString() },
      })
    ).json();
    fake.remove(tokenFor(ids.ada!), created.externalEventId);
    await sync("ada");
    const after = await (await ctx.req(`/v1/workspaces/acme/meetings/${created.id}`, { cookie: ada })).json();
    expect(after.status).toBe("cancelled");
  });

  it("shares an external event with the workspace (read-only when you're not the organizer)", async () => {
    fake.put(tokenFor(ids.marcus!), {
      externalId: "vendor-call",
      title: "Vendor call",
      startsAt: day(5, 16),
      endsAt: day(5, 17),
      isOrganizer: false,
      organizerEmail: "vendor@example.com",
      attendees: [
        { email: "vendor@example.com", name: "Vendor", response: "accepted", organizer: true, self: false },
        { email: "marcus@knotworking.dev", name: null, response: "accepted", organizer: false, self: true },
      ],
    });
    await sync("marcus");
    const range = `from=${day(-1, 0).toISOString()}&to=${day(7, 0).toISOString()}`;
    const view = await (await ctx.req(`/v1/workspaces/acme/calendar?${range}`, { cookie: marcus })).json();
    const ev = view.events.find((e: { title: string }) => e.title === "Vendor call");

    const imported = await (
      await ctx.req("/v1/workspaces/acme/meetings/import", {
        method: "POST",
        cookie: marcus,
        json: { calendarEventId: ev.id },
      })
    ).json();
    expect(imported.syncState).toBe("external");
    const edit = await ctx.req(`/v1/workspaces/acme/meetings/${imported.id}`, {
      method: "PATCH",
      cookie: marcus,
      json: { title: "x" },
    });
    expect(edit.status).toBe(409);

    // Ada sees it as a workspace meeting now.
    const adaView = await (await ctx.req(`/v1/workspaces/acme/calendar?${range}`, { cookie: ada })).json();
    expect(adaView.meetings.some((m: { title: string }) => m.title === "Vendor call")).toBe(true);

    // Updates from the external organizer flow in.
    fake.put(tokenFor(ids.marcus!), { externalId: "vendor-call", title: "Vendor call (rescheduled)" });
    await sync("marcus");
    const after = await (
      await ctx.req(`/v1/workspaces/acme/meetings/${imported.id}`, { cookie: ada })
    ).json();
    expect(after.title).toBe("Vendor call (rescheduled)");
  });

  it("shares a personal event that has no guest list", async () => {
    fake.put(tokenFor(ids.ada!), {
      externalId: "lunch",
      title: "Lunch",
      startsAt: day(2, 12),
      endsAt: day(2, 13),
      attendees: [],
    });
    await sync("ada");
    const range = `from=${day(-1, 0).toISOString()}&to=${day(7, 0).toISOString()}`;
    const view = await (await ctx.req(`/v1/workspaces/acme/calendar?${range}`, { cookie: ada })).json();
    const ev = view.events.find((e: { title: string }) => e.title === "Lunch");
    const res = await ctx.req("/v1/workspaces/acme/meetings/import", {
      method: "POST",
      cookie: ada,
      json: { calendarEventId: ev.id },
    });
    expect(res.status).toBe(201);
    const meeting = await res.json();
    expect(meeting).toMatchObject({ syncState: "synced", organizerId: ids.ada });
    expect(meeting.attendees).toEqual([
      expect.objectContaining({ email: "ada@knotworking.dev", isOrganizer: true }),
    ]);
  });

  it("keeps meetings in Knotworking when a member has no connected calendar", async () => {
    const priya = (await signIn(ctx, "priya@knotworking.dev")).cookie;
    const m = await (
      await ctx.req("/v1/workspaces/acme/meetings", {
        method: "POST",
        cookie: priya,
        json: { title: "Design crit", startsAt: day(1, 13).toISOString(), endsAt: day(1, 14).toISOString() },
      })
    ).json();
    expect(m.syncState).toBe("local");
  });

  it("records a clear error when calendar access is revoked", async () => {
    fake.failAuthFor.add(tokenFor(ids.marcus!));
    const r = await sync("marcus");
    expect(r.error).toMatch(/token revoked/);
    const { connections } = await (await ctx.req("/v1/calendar/connections", { cookie: marcus })).json();
    expect(connections[0]).toMatchObject({ status: "error" });
    fake.failAuthFor.delete(tokenFor(ids.marcus!));
    expect((await sync("marcus")).error).toBeUndefined();
  });
});

describe("calendar sync edge cases", () => {
  const svc = new FakeCalendarService("google");
  let ctx: TestCtx;
  let ada: string;
  let marcus: string;
  let ids: Record<string, string>;
  const token = (who: string) => `token-${ids[who]}`;
  const day = (offsetDays: number, hour: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offsetDays);
    d.setUTCHours(hour, 0, 0, 0);
    return d;
  };
  const range = () => `from=${day(-2, 0).toISOString()}&to=${day(10, 0).toISOString()}`;
  const connId = async (who: string) =>
    (
      await ctx.handle.db.select().from(calendarConnections).where(eq(calendarConnections.userId, ids[who]!))
    )[0]!.id;
  const sync = async (who: string) => syncConnection(ctx.calendar, await connId(who));

  beforeAll(async () => {
    ctx = await makeApp({
      seed: true,
      calendar: () => ({
        providers: { google: svc.client() },
        getAccessToken: async (_a, userId) => `token-${userId}`,
      }),
    });
    const people = await ctx.handle.db.select().from(users);
    ids = Object.fromEntries(people.map((u) => [u.email.split("@")[0]!, u.id]));
    for (const who of ["ada", "marcus"]) {
      await ctx.handle.db.insert(accounts).values({
        userId: ids[who]!,
        providerId: "google",
        accountId: `g-${who}`,
        scope: GOOGLE_CALENDAR_SCOPE,
      });
      svc.addAccount(token(who), `${who}@knotworking.dev`);
    }
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    await ctx.req("/v1/calendar/connections", { cookie: ada });
    await ctx.req("/v1/calendar/connections", { cookie: marcus });
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("keeps a disconnected calendar disconnected until the member reconnects", async () => {
    svc.put(token("marcus"), {
      externalId: "focus",
      title: "Focus time",
      startsAt: day(1, 9),
      endsAt: day(1, 11),
    });
    await sync("marcus");
    const id = await connId("marcus");
    expect(
      (await ctx.req(`/v1/calendar/connections/${id}`, { method: "DELETE", cookie: marcus })).status,
    ).toBe(204);

    // Listing (which runs on every page refresh) must not resurrect it…
    const list = await (await ctx.req("/v1/calendar/connections", { cookie: marcus })).json();
    expect(list.connections).toEqual([]);
    // …the scheduler skips it, and the private mirror is gone.
    expect((await syncableConnections(ctx.handle.db)).map((c) => c.id)).not.toContain(id);
    const view = await (await ctx.req(`/v1/workspaces/acme/calendar?${range()}`, { cookie: marcus })).json();
    expect(view.events).toEqual([]);

    // Reconnecting (after the consent screen) turns it back on and syncs.
    const res = await ctx.req("/v1/calendar/connections/activate", {
      method: "POST",
      cookie: marcus,
      json: { provider: "google" },
    });
    expect(res.status).toBe(200);
    const again = await (await ctx.req(`/v1/workspaces/acme/calendar?${range()}`, { cookie: marcus })).json();
    expect(again.events.map((e: { title: string }) => e.title)).toEqual(["Focus time"]);
  });

  it("doesn't merge the other occurrences of a recurring series into a shared meeting", async () => {
    for (const d of [2, 3, 4]) {
      svc.put(token("marcus"), {
        externalId: `standup_${d}`,
        iCalUid: "standup-series@google.com",
        title: "Standup",
        startsAt: day(d, 9),
        endsAt: day(d, 10),
        recurring: true,
      });
    }
    await sync("marcus");
    let view = await (await ctx.req(`/v1/workspaces/acme/calendar?${range()}`, { cookie: marcus })).json();
    const first = view.events.find(
      (e: { title: string; startsAt: string }) =>
        e.title === "Standup" && e.startsAt === day(2, 9).toISOString(),
    );
    await ctx.req("/v1/workspaces/acme/meetings/import", {
      method: "POST",
      cookie: marcus,
      json: { calendarEventId: first.id },
    });
    svc.put(token("marcus"), { externalId: "standup_3", title: "Standup" }); // touch: forces re-apply on next delta
    await sync("marcus");

    view = await (await ctx.req(`/v1/workspaces/acme/calendar?${range()}`, { cookie: marcus })).json();
    expect(view.events.filter((e: { title: string }) => e.title === "Standup")).toHaveLength(2);
    expect(view.meetings.filter((m: { title: string }) => m.title === "Standup")).toHaveLength(1);
  });

  it("stores all-day meetings as dates (UTC midnight) and sends them as dates", async () => {
    const date = day(5, 0);
    const res = await ctx.req("/v1/workspaces/acme/meetings", {
      method: "POST",
      cookie: ada,
      json: { title: "Offsite", allDay: true, startsAt: date.toISOString(), endsAt: date.toISOString() },
    });
    const m = await res.json();
    expect(m.startsAt).toBe(date.toISOString());
    expect(m.endsAt).toBe(day(6, 0).toISOString());
    const remote = svc.events(token("ada")).find((e) => e.title === "Offsite")!;
    expect(remote).toMatchObject({ allDay: true });
    expect(remote.startsAt.toISOString()).toBe(date.toISOString());
  });

  it("only lets the organizer edit a meeting synced with their calendar", async () => {
    const m = await (
      await ctx.req("/v1/workspaces/acme/meetings", {
        method: "POST",
        cookie: marcus,
        json: { title: "Marcus 1:1", startsAt: day(3, 15).toISOString(), endsAt: day(3, 16).toISOString() },
      })
    ).json();
    expect(m.syncState).toBe("synced");
    // Ada is the workspace owner, but the change would be made with Marcus's Google account.
    const res = await ctx.req(`/v1/workspaces/acme/meetings/${m.id}`, {
      method: "PATCH",
      cookie: ada,
      json: { title: "x" },
    });
    expect(res.status).toBe(403);
  });

  it("never pushes the same meeting twice when a sync and a push overlap", async () => {
    svc.delayMs = 50;
    const before = svc.createCount;
    const created = ctx.req("/v1/workspaces/acme/meetings", {
      method: "POST",
      cookie: ada,
      json: {
        title: "Race",
        startsAt: day(4, 13).toISOString(),
        endsAt: day(4, 14).toISOString(),
        attendeeEmails: ["client@example.com"],
      },
    });
    const [res] = await Promise.all([created, sync("ada"), sync("ada")]);
    svc.delayMs = 0;
    expect(res.status).toBe(201);
    await sync("ada");
    expect(svc.createCount - before).toBe(1);
    expect(svc.events(token("ada")).filter((e) => e.title === "Race")).toHaveLength(1);
  });

  it("keeps an edit made while a push is in flight, and pushes it next", async () => {
    const m = await (
      await ctx.req("/v1/workspaces/acme/meetings", {
        method: "POST",
        cookie: ada,
        json: { title: "Draft", startsAt: day(6, 10).toISOString(), endsAt: day(6, 11).toISOString() },
      })
    ).json();
    // Simulate a push that started before an edit landed.
    await ctx.handle.db.update(meetings).set({ syncState: "pending" }).where(eq(meetings.id, m.id));
    svc.delayMs = 60;
    const push = pushMeetingNow(ctx.calendar, m.id);
    await new Promise((r) => setTimeout(r, 15));
    await ctx.handle.db
      .update(meetings)
      .set({ title: "Final", syncState: "pending", localVersion: 99 })
      .where(eq(meetings.id, m.id));
    await push;
    svc.delayMs = 0;
    const [mid] = await ctx.handle.db.select().from(meetings).where(eq(meetings.id, m.id));
    expect(mid!.syncState).toBe("pending"); // not clobbered to "synced"
    await sync("ada");
    expect(svc.events(token("ada")).find((e) => e.externalId === m.externalEventId)?.title).toBe("Final");
  });

  it("stops syncing a deactivated member's calendar", async () => {
    const id = await connId("ada");
    expect((await syncableConnections(ctx.handle.db)).map((c) => c.id)).toContain(id);
    await ctx.handle.db
      .update(workspaceMembers)
      .set({ deletedAt: new Date() })
      .where(eq(workspaceMembers.userId, ids.ada!));
    expect((await syncableConnections(ctx.handle.db)).map((c) => c.id)).not.toContain(id);
    await ctx.handle.db
      .update(workspaceMembers)
      .set({ deletedAt: null })
      .where(eq(workspaceMembers.userId, ids.ada!));
  });
});

describe("connecting a calendar", () => {
  let ctx: TestCtx;
  let ada: string;
  beforeAll(async () => {
    ctx = await makeApp({
      seed: true,
      auth: {
        google: { clientId: "google-client", clientSecret: "secret" },
        microsoft: { clientId: "ms-client", clientSecret: "secret", tenantId: "contoso-tenant" },
      },
    });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  const link = async (provider: "google" | "microsoft", scope: string) => {
    const res = await ctx.req("/api/auth/link-social", {
      method: "POST",
      cookie: ada,
      json: { provider, scopes: [scope], callbackURL: "/acme/settings/calendars?connected=" + provider },
    });
    expect(res.status).toBe(200);
    return new URL((await res.json()).url);
  };

  it("asks Google for calendar access with offline refresh tokens", async () => {
    const url = await link("google", "https://www.googleapis.com/auth/calendar.events");
    expect(url.host).toBe("accounts.google.com");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toContain("consent");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback/google");
  });

  it("asks Microsoft for Calendars.ReadWrite with offline access", async () => {
    const url = await link("microsoft", "Calendars.ReadWrite");
    expect(url.host).toBe("login.microsoftonline.com");
    expect(url.pathname).toContain("/contoso-tenant/");
    const scope = url.searchParams.get("scope")!;
    expect(scope).toContain("Calendars.ReadWrite");
    expect(scope).toContain("offline_access");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback/microsoft");
  });
});
