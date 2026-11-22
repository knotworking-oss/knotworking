import { describe, expect, it } from "vitest";
import { googleCalendar } from "./google";
import { microsoftCalendar } from "./microsoft";
import { ProviderError } from "./types";

/** Records requests and replies from a queue of canned responses. */
function mockFetch(responses: (object | { status: number; body?: object })[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = responses.shift() ?? {};
    const status = "status" in next && typeof next.status === "number" ? next.status : 200;
    const body =
      "status" in next && typeof next.status === "number" ? ((next as { body?: object }).body ?? {}) : next;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const window = { from: new Date("2026-10-09T00:00:00Z"), to: new Date("2027-05-08T00:00:00Z") };

describe("Google Calendar adapter", () => {
  it("does a full load with pagination and returns the sync token", async () => {
    const { impl, calls } = mockFetch([
      {
        items: [
          {
            id: "a1",
            iCalUID: "a1@google.com",
            status: "confirmed",
            summary: "Standup",
            start: { dateTime: "2026-11-09T09:00:00+01:00" },
            end: { dateTime: "2026-11-09T09:15:00+01:00" },
            hangoutLink: "https://meet.google.com/abc",
            organizer: { email: "Ada@Knotworking.dev", self: true },
            attendees: [
              { email: "ada@knotworking.dev", responseStatus: "accepted", self: true, organizer: true },
              { email: "marcus@knotworking.dev", responseStatus: "tentative" },
            ],
            updated: "2026-11-01T10:00:00.000Z",
          },
        ],
        nextPageToken: "p2",
      },
      {
        items: [
          { id: "a2", summary: "Offsite", start: { date: "2026-11-20" }, end: { date: "2026-11-22" } },
          { id: "gone1", status: "cancelled" },
        ],
        nextSyncToken: "sync-1",
      },
    ]);
    const page = await googleCalendar(impl).listChanges("tok", null, window);

    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(first.searchParams.get("timeMin")).toBe(window.from.toISOString());
    expect(first.searchParams.get("singleEvents")).toBe("true");
    expect(first.searchParams.get("showDeleted")).toBe("true");
    expect(new URL(calls[1]!.url).searchParams.get("pageToken")).toBe("p2");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");

    expect(page).toMatchObject({ cursor: "sync-1", full: true, removedIds: ["gone1"] });
    expect(page.events[0]).toMatchObject({
      externalId: "a1",
      iCalUid: "a1@google.com",
      conferenceUrl: "https://meet.google.com/abc",
      organizerEmail: "ada@knotworking.dev",
      isOrganizer: true,
      allDay: false,
    });
    expect(page.events[0]!.startsAt.toISOString()).toBe("2026-11-09T08:00:00.000Z");
    expect(page.events[0]!.attendees[1]).toMatchObject({
      email: "marcus@knotworking.dev",
      response: "tentative",
    });
    expect(page.events[1]).toMatchObject({ allDay: true, title: "Offsite" });
    expect(page.events[1]!.startsAt.toISOString()).toBe("2026-11-20T00:00:00.000Z");
  });

  it("uses the sync token for deltas and reports expired tokens", async () => {
    const { impl, calls } = mockFetch([
      { items: [], nextSyncToken: "sync-2" },
      { status: 410, body: { error: "gone" } },
    ]);
    const client = googleCalendar(impl);
    await client.listChanges("tok", "sync-1", window);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("syncToken")).toBe("sync-1");
    expect(url.searchParams.has("timeMin")).toBe(false);
    await expect(client.listChanges("tok", "sync-2", window)).rejects.toMatchObject({ kind: "gone" });
  });

  it("creates events that invite attendees and request a Meet link", async () => {
    const { impl, calls } = mockFetch([
      { id: "new1", iCalUID: "new1@google.com", start: { date: "2026-12-01" }, end: { date: "2026-12-02" } },
    ]);
    await googleCalendar(impl).createEvent("tok", {
      title: "Planning",
      description: null,
      location: "HQ",
      startsAt: new Date("2026-12-01T00:00:00Z"),
      endsAt: new Date("2026-12-02T00:00:00Z"),
      allDay: true,
      attendees: [{ email: "marcus@knotworking.dev", name: "Marcus" }],
      addVideoCall: true,
    });
    const url = new URL(calls[0]!.url);
    expect(calls[0]!.init.method).toBe("POST");
    expect(url.searchParams.get("sendUpdates")).toBe("all");
    expect(url.searchParams.get("conferenceDataVersion")).toBe("1");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.start).toEqual({ date: "2026-12-01" });
    expect(body.attendees).toEqual([{ email: "marcus@knotworking.dev", displayName: "Marcus" }]);
    expect(body.conferenceData.createRequest.conferenceSolutionKey.type).toBe("hangoutsMeet");
  });

  it("maps auth failures", async () => {
    const { impl } = mockFetch([{ status: 401, body: { error: "invalid_grant" } }]);
    const err = await googleCalendar(impl)
      .listChanges("tok", "x", window)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("auth");
  });
});

describe("Microsoft Graph adapter", () => {
  it("loads calendarView delta pages and keeps the delta link", async () => {
    const { impl, calls } = mockFetch([
      {
        value: [
          {
            id: "AAMk1",
            iCalUId: "040000008200E0",
            subject: "Quarterly review",
            body: { contentType: "html", content: "<html><body><p>Agenda&nbsp;below</p></body></html>" },
            start: { dateTime: "2026-11-10T14:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-11-10T15:00:00.0000000", timeZone: "UTC" },
            location: { displayName: "Room 2" },
            onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/xyz" },
            isOrganizer: false,
            organizer: { emailAddress: { address: "Boss@Contoso.com", name: "Boss" } },
            attendees: [
              {
                emailAddress: { address: "marcus@knotworking.dev", name: "Marcus" },
                status: { response: "tentativelyAccepted" },
              },
            ],
            webLink: "https://outlook.office365.com/owa/?itemid=AAMk1",
            lastModifiedDateTime: "2026-11-02T09:00:00Z",
          },
        ],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=abc",
      },
      {
        value: [{ id: "AAMk2", "@removed": { reason: "deleted" } }],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=xyz",
      },
    ]);
    const page = await microsoftCalendar(impl).listChanges("tok", null, window);

    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe("/v1.0/me/calendarView/delta");
    expect(first.searchParams.get("startDateTime")).toBe(window.from.toISOString());
    expect(first.searchParams.get("endDateTime")).toBe(window.to.toISOString());
    expect((calls[0]!.init.headers as Record<string, string>).prefer).toContain('outlook.timezone="UTC"');
    expect(calls[1]!.url).toContain("$skiptoken=abc");

    expect(page.cursor).toContain("$deltatoken=xyz");
    expect(page.removedIds).toEqual(["AAMk2"]);
    expect(page.events[0]).toMatchObject({
      title: "Quarterly review",
      description: "Agenda below",
      location: "Room 2",
      conferenceUrl: "https://teams.microsoft.com/l/meetup-join/xyz",
      organizerEmail: "boss@contoso.com",
      isOrganizer: false,
    });
    expect(page.events[0]!.startsAt.toISOString()).toBe("2026-11-10T14:00:00.000Z");
    expect(page.events[0]!.attendees[0]).toMatchObject({
      email: "marcus@knotworking.dev",
      response: "tentative",
    });
  });

  it("follows the stored delta link and treats an expired one as gone", async () => {
    const delta = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=xyz";
    const { impl, calls } = mockFetch([{ status: 410, body: { error: { code: "SyncStateNotFound" } } }]);
    await expect(microsoftCalendar(impl).listChanges("tok", delta, window)).rejects.toMatchObject({
      kind: "gone",
    });
    expect(calls[0]!.url).toBe(delta);
  });

  it("creates events with attendees and a Teams link, and cancels via /cancel", async () => {
    const { impl, calls } = mockFetch([
      {
        id: "AAMk3",
        start: { dateTime: "2026-12-01T10:00:00.0000000" },
        end: { dateTime: "2026-12-01T11:00:00.0000000" },
      },
      { status: 404, body: {} },
    ]);
    const client = microsoftCalendar(impl);
    await client.createEvent("tok", {
      title: "Kickoff",
      description: "Hello",
      location: null,
      startsAt: new Date("2026-12-01T10:00:00Z"),
      endsAt: new Date("2026-12-01T11:00:00Z"),
      allDay: false,
      attendees: [{ email: "client@example.com", name: null }],
      addVideoCall: true,
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(calls[0]!.url).toBe("https://graph.microsoft.com/v1.0/me/events");
    expect(body.start).toEqual({ dateTime: "2026-12-01T10:00:00.000", timeZone: "UTC" });
    expect(body.attendees).toEqual([
      { emailAddress: { address: "client@example.com", name: "client@example.com" }, type: "required" },
    ]);
    expect(body).toMatchObject({ isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" });

    await client.cancelEvent("tok", "AAMk3"); // 404 → already gone, no throw
    expect(calls[1]!.url).toBe("https://graph.microsoft.com/v1.0/me/events/AAMk3/cancel");
    expect(calls[1]!.init.method).toBe("POST");
  });
});
