import { calendarScopes, type AttendeeResponse } from "@knotworking/core";
import {
  providerFetch,
  ProviderError,
  type CalendarProviderClient,
  type EventInput,
  type ExternalEvent,
  type Fetch,
} from "./types";

/** Scope requested when a member connects Outlook / Microsoft 365. */
export const MICROSOFT_CALENDAR_SCOPE = calendarScopes.microsoft;

const GRAPH = "https://graph.microsoft.com/v1.0";
// Ask Graph for UTC times and reasonable page sizes.
const PREFER = 'outlook.timezone="UTC", odata.maxpagesize=100';

interface GraphEvent {
  id: string;
  "@removed"?: { reason: string };
  iCalUId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  location?: { displayName?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
  start?: { dateTime: string; timeZone?: string };
  end?: { dateTime: string; timeZone?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  isOrganizer?: boolean;
  organizer?: { emailAddress?: { address?: string; name?: string } };
  attendees?: { emailAddress?: { address?: string; name?: string }; status?: { response?: string } }[];
  webLink?: string;
  lastModifiedDateTime?: string;
  type?: "singleInstance" | "occurrence" | "exception" | "seriesMaster";
  seriesMasterId?: string | null;
}

const responses: Record<string, AttendeeResponse> = {
  accepted: "accepted",
  organizer: "accepted",
  declined: "declined",
  tentativelyAccepted: "tentative",
  none: "needsAction",
  notResponded: "needsAction",
};

/** Graph returns "2026-11-10T09:00:00.0000000" (UTC because of the Prefer header). */
const utc = (s: string | undefined) => new Date(s ? (/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`) : 0);
/** All-day events are dates; Knotworking stores them as UTC midnight. */
const utcDate = (s: string | undefined) => new Date(s ? `${s.slice(0, 10)}T00:00:00Z` : 0);

const stripHtml = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();

export function mapGraphEvent(e: GraphEvent): ExternalEvent {
  const organizerEmail = e.organizer?.emailAddress?.address?.toLowerCase() ?? null;
  const description =
    e.body?.content && e.body.contentType === "html"
      ? stripHtml(e.body.content)
      : (e.body?.content ?? e.bodyPreview ?? null);
  return {
    externalId: e.id,
    iCalUid: e.iCalUId ?? null,
    title: e.subject || "(No title)",
    description: description || null,
    location: e.location?.displayName || null,
    conferenceUrl: e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? null,
    startsAt: e.isAllDay ? utcDate(e.start?.dateTime) : utc(e.start?.dateTime),
    endsAt: e.isAllDay ? utcDate(e.end?.dateTime) : utc(e.end?.dateTime),
    allDay: Boolean(e.isAllDay),
    status: e.isCancelled ? "cancelled" : e.showAs === "tentative" ? "tentative" : "confirmed",
    organizerEmail,
    isOrganizer: Boolean(e.isOrganizer),
    attendees: (e.attendees ?? [])
      .filter((a) => a.emailAddress?.address)
      .map((a) => {
        const email = a.emailAddress!.address!.toLowerCase();
        return {
          email,
          name: a.emailAddress?.name ?? null,
          response: responses[a.status?.response ?? ""] ?? "needsAction",
          organizer: email === organizerEmail,
          self: false,
        };
      }),
    htmlLink: e.webLink ?? null,
    updatedAt: e.lastModifiedDateTime ? new Date(e.lastModifiedDateTime) : null,
    recurring: e.type === "occurrence" || e.type === "exception" || Boolean(e.seriesMasterId),
  };
}

function toGraphBody(input: EventInput) {
  const graphTime = (d: Date) => ({ dateTime: d.toISOString().replace("Z", ""), timeZone: "UTC" });
  return {
    subject: input.title,
    body: { contentType: "text", content: input.description ?? "" },
    start: graphTime(input.startsAt),
    end: graphTime(input.endsAt),
    isAllDay: input.allDay,
    location: { displayName: input.location ?? "" },
    attendees: input.attendees.map((a) => ({
      emailAddress: { address: a.email, name: a.name ?? a.email },
      type: "required",
    })),
    ...(input.addVideoCall ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
  };
}

export function microsoftCalendar(fetchImpl: Fetch = fetch): CalendarProviderClient {
  const call = (url: string, accessToken: string, init: RequestInit = {}) =>
    providerFetch(fetchImpl, url, {
      ...init,
      accessToken,
      provider: "Microsoft Graph",
      headers: { prefer: PREFER, ...init.headers },
    });

  return {
    id: "microsoft",

    async listChanges(accessToken, cursor, window) {
      const events: ExternalEvent[] = [];
      const removedIds: string[] = [];
      let url =
        cursor ??
        `${GRAPH}/me/calendarView/delta?${new URLSearchParams({
          startDateTime: window.from.toISOString(),
          endDateTime: window.to.toISOString(),
        })}`;
      let deltaLink: string | undefined;
      try {
        for (;;) {
          const page = (await (await call(url, accessToken)).json()) as {
            value?: GraphEvent[];
            "@odata.nextLink"?: string;
            "@odata.deltaLink"?: string;
          };
          for (const item of page.value ?? []) {
            if (item["@removed"] || item.isCancelled) removedIds.push(item.id);
            else events.push(mapGraphEvent(item));
          }
          if (page["@odata.nextLink"]) url = page["@odata.nextLink"];
          else {
            deltaLink = page["@odata.deltaLink"];
            break;
          }
        }
      } catch (err) {
        // An expired delta token comes back as 410 or a SyncStateNotFound error.
        if (
          cursor &&
          err instanceof ProviderError &&
          (err.kind === "gone" || /SyncState/i.test(err.message))
        ) {
          throw new ProviderError("gone", err.message, err.status);
        }
        throw err;
      }
      if (!deltaLink) throw new Error("Microsoft Graph did not return a delta link");
      return { events, removedIds, cursor: deltaLink, full: !cursor };
    },

    async createEvent(accessToken, input) {
      const res = await call(`${GRAPH}/me/events`, accessToken, {
        method: "POST",
        body: JSON.stringify(toGraphBody(input)),
      });
      return mapGraphEvent((await res.json()) as GraphEvent);
    },

    async updateEvent(accessToken, externalId, input) {
      const body = toGraphBody(input);
      const res = await call(`${GRAPH}/me/events/${encodeURIComponent(externalId)}`, accessToken, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      return mapGraphEvent((await res.json()) as GraphEvent);
    },

    async cancelEvent(accessToken, externalId) {
      try {
        // `cancel` sends cancellation notices to attendees (organizer only).
        await call(`${GRAPH}/me/events/${encodeURIComponent(externalId)}/cancel`, accessToken, {
          method: "POST",
          body: JSON.stringify({ comment: "Cancelled in Knotworking" }),
        });
      } catch (err) {
        if (err instanceof ProviderError && (err.kind === "not_found" || err.kind === "gone")) return;
        throw err;
      }
    },
  };
}
