import type { CalendarProvider } from "@knotworking/core";
import { newId } from "@knotworking/core";
import { ProviderError, type CalendarProviderClient, type EventInput, type ExternalEvent } from "./types";

interface Stored {
  event: ExternalEvent;
  version: number;
  removed?: boolean;
}

/**
 * In-memory calendar service for tests. Behaves like Google/Microsoft in the
 * ways that matter to sync: one calendar per account (keyed by access token),
 * delta cursors, and invitations that put a copy of the event (same iCalUID,
 * different id) into each invitee's calendar.
 */
export class FakeCalendarService {
  private calendars = new Map<string, Map<string, Stored>>();
  private version = 0;
  /** token → email of the calendar owner */
  readonly owners = new Map<string, string>();
  failAuthFor = new Set<string>();
  /** Simulated provider latency for create/update (to exercise races). */
  delayMs = 0;
  createCount = 0;

  constructor(readonly id: CalendarProvider = "google") {}

  addAccount(token: string, email: string) {
    this.owners.set(token, email);
    this.calendars.set(token, new Map());
  }

  private cal(token: string) {
    if (this.failAuthFor.has(token)) throw new ProviderError("auth", "token revoked", 401);
    const c = this.calendars.get(token);
    if (!c) throw new ProviderError("auth", "unknown token", 401);
    return c;
  }

  /** Simulates the account owner editing or adding an event in the provider's own app. */
  put(token: string, event: Partial<ExternalEvent> & { externalId: string }) {
    const cal = this.cal(token);
    const prev = cal.get(event.externalId)?.event;
    const full: ExternalEvent = {
      iCalUid: `${event.externalId}@fake`,
      title: "Untitled",
      description: null,
      location: null,
      conferenceUrl: null,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3_600_000),
      allDay: false,
      status: "confirmed",
      organizerEmail: this.owners.get(token) ?? null,
      isOrganizer: true,
      attendees: [],
      htmlLink: null,
      recurring: false,
      ...prev,
      ...event,
      updatedAt: new Date(Date.now() + ++this.version), // strictly increasing
    };
    cal.set(event.externalId, { event: full, version: this.version });
    return full;
  }

  remove(token: string, externalId: string) {
    const stored = this.cal(token).get(externalId);
    if (stored) Object.assign(stored, { removed: true, version: ++this.version });
  }

  events(token: string) {
    return [...this.cal(token).values()].filter((s) => !s.removed).map((s) => s.event);
  }

  client(): CalendarProviderClient {
    return {
      id: this.id,
      listChanges: async (token, cursor) => {
        const since = cursor ? Number(cursor) : -1;
        const changed = [...this.cal(token).values()].filter((s) => s.version > since);
        return {
          events: changed.filter((s) => !s.removed).map((s) => s.event),
          removedIds: cursor ? changed.filter((s) => s.removed).map((s) => s.event.externalId) : [],
          cursor: String(this.version),
          full: !cursor,
        };
      },
      createEvent: async (token, input) => {
        this.createCount++;
        if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
        const id = `evt_${newId().slice(-8)}`;
        const created = this.put(token, { externalId: id, ...this.fromInput(token, input) });
        this.deliverInvites(created);
        return created;
      },
      updateEvent: async (token, externalId, input) => {
        if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
        if (!this.cal(token).get(externalId)) throw new ProviderError("not_found", "no such event", 404);
        const updated = this.put(token, { externalId, ...this.fromInput(token, input) });
        this.deliverInvites(updated);
        return updated;
      },
      cancelEvent: async (token, externalId) => {
        const ev = this.cal(token).get(externalId)?.event;
        this.remove(token, externalId);
        if (ev) for (const [t] of this.calendars) if (t !== token) this.removeCopy(t, ev.iCalUid);
      },
    };
  }

  private fromInput(token: string, input: EventInput): Partial<ExternalEvent> {
    const organizer = this.owners.get(token)!;
    return {
      title: input.title,
      description: input.description,
      location: input.location,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: input.allDay,
      conferenceUrl: input.addVideoCall ? "https://meet.example/abc-defg-hij" : undefined,
      organizerEmail: organizer,
      isOrganizer: true,
      attendees: [
        { email: organizer, name: null, response: "accepted", organizer: true, self: true },
        ...input.attendees.map((a) => ({
          email: a.email,
          name: a.name,
          response: "needsAction" as const,
          organizer: false,
          self: false,
        })),
      ],
    };
  }

  /** Invitees with an account here receive a copy with the same iCalUID. */
  private deliverInvites(ev: ExternalEvent) {
    for (const [token, email] of this.owners) {
      if (email === ev.organizerEmail || !ev.attendees.some((a) => a.email === email)) continue;
      const existing = this.events(token).find((e) => e.iCalUid === ev.iCalUid);
      this.put(token, {
        ...ev,
        externalId: existing?.externalId ?? `copy_${newId().slice(-8)}`,
        isOrganizer: false,
        attendees: ev.attendees.map((a) => ({
          ...a,
          self: a.email === email,
          response: existing?.attendees.find((x) => x.email === a.email)?.response ?? a.response,
        })),
      });
    }
  }

  private removeCopy(token: string, iCalUid: string | null) {
    const copy = this.events(token).find((e) => e.iCalUid === iCalUid);
    if (copy) this.remove(token, copy.externalId);
  }

  /** An invitee RSVPs in their own calendar app; the organizer's copy sees it too. */
  respond(token: string, iCalUid: string, response: "accepted" | "declined" | "tentative") {
    const email = this.owners.get(token)!;
    for (const [t] of this.calendars) {
      const ev = this.events(t).find((e) => e.iCalUid === iCalUid);
      if (ev)
        this.put(t, {
          externalId: ev.externalId,
          attendees: ev.attendees.map((a) => (a.email === email ? { ...a, response } : a)),
        });
    }
  }
}
