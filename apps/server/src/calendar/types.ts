import type { AttendeeResponse, CalendarProvider } from "@knotworking/core";

/** Provider-neutral calendar event. Times are UTC; all-day events span [start, end) days. */
export interface ExternalEvent {
  externalId: string;
  iCalUid: string | null;
  title: string;
  description: string | null;
  location: string | null;
  conferenceUrl: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  organizerEmail: string | null;
  isOrganizer: boolean;
  attendees: {
    email: string;
    name: string | null;
    response: AttendeeResponse;
    organizer: boolean;
    self: boolean;
  }[];
  htmlLink: string | null;
  updatedAt: Date | null;
  /** An occurrence of a recurring series (all occurrences share one iCalUID). */
  recurring: boolean;
}

/** What Knotworking writes to a calendar. */
export interface EventInput {
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  attendees: { email: string; name: string | null }[];
  addVideoCall: boolean;
}

export interface ChangePage {
  /** Created or updated events (cancelled ones are listed in `removedIds`). */
  events: ExternalEvent[];
  removedIds: string[];
  /** Cursor for the next incremental sync. */
  cursor: string;
  /** True when this was a full (re)load of the window rather than a delta. */
  full: boolean;
}

export interface SyncWindow {
  from: Date;
  to: Date;
}

export interface CalendarProviderClient {
  id: CalendarProvider;
  /** Delta since `cursor`, or a full load of `window` when cursor is null. */
  listChanges(accessToken: string, cursor: string | null, window: SyncWindow): Promise<ChangePage>;
  createEvent(accessToken: string, input: EventInput): Promise<ExternalEvent>;
  updateEvent(accessToken: string, externalId: string, input: EventInput): Promise<ExternalEvent>;
  /** Cancels (organizer) — attendees get a cancellation from the provider. */
  cancelEvent(accessToken: string, externalId: string): Promise<void>;
}

export type ProviderErrorKind = "auth" | "gone" | "not_found" | "rate_limited" | "failed";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type Fetch = typeof fetch;

export async function providerFetch(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit & { accessToken: string; provider: string },
): Promise<Response> {
  const { accessToken, provider, ...rest } = init;
  const res = await fetchImpl(url, {
    ...rest,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...rest.headers },
  });
  if (res.ok) return res;
  const body = await res.text().catch(() => "");
  const kind: ProviderErrorKind =
    res.status === 401 || res.status === 403
      ? "auth"
      : res.status === 410
        ? "gone"
        : res.status === 404
          ? "not_found"
          : res.status === 429
            ? "rate_limited"
            : "failed";
  throw new ProviderError(kind, `${provider} ${res.status}: ${body.slice(0, 300)}`, res.status);
}
