import { calendarScopes, newId, type AttendeeResponse } from "@knotworking/core";
import {
  providerFetch,
  type CalendarProviderClient,
  type EventInput,
  type ExternalEvent,
  type Fetch,
} from "./types";

/** Scope requested when a member connects Google Calendar. */
export const GOOGLE_CALENDAR_SCOPE = calendarScopes.google;

const BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

interface GoogleEvent {
  id: string;
  iCalUID?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  organizer?: { email?: string; self?: boolean };
  attendees?: {
    email?: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    organizer?: boolean;
  }[];
  htmlLink?: string;
  updated?: string;
  recurringEventId?: string;
}

const responses: Record<string, AttendeeResponse> = {
  accepted: "accepted",
  declined: "declined",
  tentative: "tentative",
  needsAction: "needsAction",
};

const dateOnly = (d: string) => new Date(`${d}T00:00:00Z`);

export function mapGoogleEvent(e: GoogleEvent): ExternalEvent {
  const allDay = Boolean(e.start?.date);
  return {
    externalId: e.id,
    iCalUid: e.iCalUID ?? null,
    title: e.summary ?? "(No title)",
    description: e.description ?? null,
    location: e.location ?? null,
    conferenceUrl:
      e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ?? null,
    startsAt: allDay ? dateOnly(e.start!.date!) : new Date(e.start?.dateTime ?? 0),
    endsAt: allDay ? dateOnly(e.end!.date!) : new Date(e.end?.dateTime ?? e.start?.dateTime ?? 0),
    allDay,
    status: e.status ?? "confirmed",
    organizerEmail: e.organizer?.email?.toLowerCase() ?? null,
    isOrganizer: Boolean(e.organizer?.self),
    attendees: (e.attendees ?? [])
      .filter((a) => a.email)
      .map((a) => ({
        email: a.email!.toLowerCase(),
        name: a.displayName ?? null,
        response: responses[a.responseStatus ?? ""] ?? "needsAction",
        organizer: Boolean(a.organizer),
        self: Boolean(a.self),
      })),
    htmlLink: e.htmlLink ?? null,
    updatedAt: e.updated ? new Date(e.updated) : null,
    recurring: Boolean(e.recurringEventId),
  };
}

function toGoogleBody(input: EventInput) {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return {
    summary: input.title,
    description: input.description ?? undefined,
    location: input.location ?? undefined,
    start: input.allDay ? { date: day(input.startsAt) } : { dateTime: input.startsAt.toISOString() },
    end: input.allDay ? { date: day(input.endsAt) } : { dateTime: input.endsAt.toISOString() },
    attendees: input.attendees.map((a) => ({ email: a.email, displayName: a.name ?? undefined })),
    ...(input.addVideoCall
      ? {
          conferenceData: {
            createRequest: { requestId: newId(), conferenceSolutionKey: { type: "hangoutsMeet" } },
          },
        }
      : {}),
  };
}

export function googleCalendar(fetchImpl: Fetch = fetch): CalendarProviderClient {
  const call = (url: string, accessToken: string, init: RequestInit = {}) =>
    providerFetch(fetchImpl, url, { ...init, accessToken, provider: "Google Calendar" });

  return {
    id: "google",

    async listChanges(accessToken, cursor, window) {
      const events: ExternalEvent[] = [];
      const removedIds: string[] = [];
      let pageToken: string | undefined;
      let nextSyncToken: string | undefined;
      do {
        const params = new URLSearchParams({ singleEvents: "true", showDeleted: "true", maxResults: "250" });
        if (cursor) params.set("syncToken", cursor);
        else params.set("timeMin", window.from.toISOString());
        if (pageToken) params.set("pageToken", pageToken);
        const page = (await (await call(`${BASE}?${params}`, accessToken)).json()) as {
          items?: GoogleEvent[];
          nextPageToken?: string;
          nextSyncToken?: string;
        };
        for (const item of page.items ?? []) {
          if (item.status === "cancelled") removedIds.push(item.id);
          else {
            const event = mapGoogleEvent(item);
            // A full load has no upper bound in Google's API; keep to our window.
            if (!cursor && event.startsAt > window.to) continue;
            events.push(event);
          }
        }
        pageToken = page.nextPageToken;
        nextSyncToken = page.nextSyncToken ?? nextSyncToken;
      } while (pageToken);
      if (!nextSyncToken) throw new Error("Google Calendar did not return a sync token");
      return { events, removedIds, cursor: nextSyncToken, full: !cursor };
    },

    async createEvent(accessToken, input) {
      const res = await call(`${BASE}?sendUpdates=all&conferenceDataVersion=1`, accessToken, {
        method: "POST",
        body: JSON.stringify(toGoogleBody(input)),
      });
      return mapGoogleEvent((await res.json()) as GoogleEvent);
    },

    async updateEvent(accessToken, externalId, input) {
      // Callers set addVideoCall only when the event doesn't have a call yet.
      const body = toGoogleBody(input);
      const res = await call(
        `${BASE}/${encodeURIComponent(externalId)}?sendUpdates=all&conferenceDataVersion=1`,
        accessToken,
        { method: "PATCH", body: JSON.stringify(body) },
      );
      return mapGoogleEvent((await res.json()) as GoogleEvent);
    },

    async cancelEvent(accessToken, externalId) {
      try {
        await call(`${BASE}/${encodeURIComponent(externalId)}?sendUpdates=all`, accessToken, {
          method: "DELETE",
        });
      } catch (err) {
        // Already gone is fine.
        if ((err as { kind?: string }).kind === "gone" || (err as { kind?: string }).kind === "not_found")
          return;
        throw err;
      }
    },
  };
}
