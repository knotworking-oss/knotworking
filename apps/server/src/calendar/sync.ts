import type { CalendarProvider, MeetingSyncState } from "@knotworking/core";
import {
  calendarConnections,
  calendarEvents,
  meetingAttendees,
  meetings,
  recordChanges,
  users,
  workspaceMembers,
  type ChangeInput,
  type Database,
  type Transaction,
} from "@knotworking/db";
import { and, eq, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { ProviderError, type CalendarProviderClient, type EventInput, type ExternalEvent } from "./types";

export interface CalendarDeps {
  db: Database;
  providers: Partial<Record<CalendarProvider, CalendarProviderClient>>;
  /** Fresh OAuth access token for a linked account (refreshing when needed). */
  getAccessToken(accountId: string, userId: string): Promise<string>;
  now?: () => Date;
}

type Connection = typeof calendarConnections.$inferSelect;
type Meeting = typeof meetings.$inferSelect;

const DAY = 86_400_000;
/** Mirror this window of each member's calendar. */
export const WINDOW_PAST_DAYS = 30;
export const WINDOW_FUTURE_DAYS = 180;
/** Re-baseline the delta cursor weekly so the window keeps moving forward. */
const REBASELINE_AFTER_MS = 7 * DAY;
const LEASE_MS = 10 * 60_000;

/** Meeting states that hold Knotworking edits not yet in the organizer's calendar. */
const UNPUSHED: MeetingSyncState[] = ["pending", "error"];

export interface SyncResult {
  skipped?: boolean;
  pushed: number;
  pulled: number;
  removed: number;
  full: boolean;
  error?: string;
}

// ─── Lease ───────────────────────────────────────────────────────────────────

/**
 * Runs `fn` while holding the connection's lease, so a scheduled sync and an
 * on-demand push never work on the same calendar at once. The lease value is
 * also the token: only the holder can release it. Returns null if busy.
 */
export async function withConnectionLease<T>(
  deps: CalendarDeps,
  connectionId: string,
  fn: (conn: Connection) => Promise<T>,
  { attempts = 1 }: { attempts?: number } = {},
): Promise<T | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const now = deps.now?.() ?? new Date();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    const [conn] = await deps.db
      .update(calendarConnections)
      .set({ syncLeaseUntil: leaseUntil })
      .where(
        and(
          eq(calendarConnections.id, connectionId),
          ne(calendarConnections.status, "disconnected"),
          or(isNull(calendarConnections.syncLeaseUntil), lt(calendarConnections.syncLeaseUntil, now)),
        ),
      )
      .returning();
    if (conn) {
      try {
        return await fn(conn);
      } finally {
        await deps.db
          .update(calendarConnections)
          .set({ syncLeaseUntil: null })
          .where(
            and(eq(calendarConnections.id, connectionId), eq(calendarConnections.syncLeaseUntil, leaseUntil)),
          );
      }
    }
    if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  return null;
}

/**
 * Two-way sync for one connected calendar:
 *   1. push Knotworking meetings with unpushed changes to the organizer's calendar
 *   2. pull changes since the last cursor (or reload the window)
 *   3. mirror events privately, and apply organizer-side edits/cancellations
 *      and RSVPs to the linked Knotworking meetings
 */
export async function syncConnection(deps: CalendarDeps, connectionId: string): Promise<SyncResult> {
  const result = await withConnectionLease(deps, connectionId, (conn) => runSync(deps, conn));
  return result ?? { skipped: true, pushed: 0, pulled: 0, removed: 0, full: false };
}

async function runSync(deps: CalendarDeps, conn: Connection): Promise<SyncResult> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const provider = deps.providers[conn.provider];
  const result: SyncResult = { pushed: 0, pulled: 0, removed: 0, full: false };
  try {
    if (!provider)
      throw new ProviderError("failed", `${conn.provider} calendar isn't configured on this server`);
    const token = await accessToken(deps, conn);

    result.pushed = await pushPendingMeetings(deps, conn, provider, token);

    const window = {
      from: new Date(now.getTime() - WINDOW_PAST_DAYS * DAY),
      to: new Date(now.getTime() + WINDOW_FUTURE_DAYS * DAY),
    };
    const stale =
      !conn.cursorStartedAt || now.getTime() - conn.cursorStartedAt.getTime() > REBASELINE_AFTER_MS;
    let page;
    try {
      page = await provider.listChanges(token, stale ? null : conn.syncCursor, window);
    } catch (err) {
      if (!(err instanceof ProviderError && err.kind === "gone")) throw err;
      page = await provider.listChanges(token, null, window); // cursor expired → full reload
    }
    result.full = page.full;
    result.pulled = page.events.length;
    result.removed = page.removedIds.length;

    await db.transaction(async (tx) => {
      await applyChanges(tx, conn, page.events, page.removedIds, page.full);
      await tx
        .update(calendarConnections)
        .set({
          syncCursor: page.cursor,
          cursorStartedAt: page.full ? now : conn.cursorStartedAt,
          lastSyncedAt: now,
          lastError: null,
          status: "active",
        })
        .where(and(eq(calendarConnections.id, conn.id), ne(calendarConnections.status, "disconnected")));
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = message;
    await db
      .update(calendarConnections)
      .set({ lastError: message.slice(0, 500), status: "error" })
      .where(and(eq(calendarConnections.id, conn.id), ne(calendarConnections.status, "disconnected")));
  }
  return result;
}

async function accessToken(deps: CalendarDeps, conn: Connection) {
  return deps.getAccessToken(conn.accountId, conn.userId).catch((err) => {
    throw new ProviderError("auth", `Couldn't get an access token: ${(err as Error).message}`);
  });
}

// ─── Push ────────────────────────────────────────────────────────────────────

async function meetingInput(db: Database | Transaction, m: Meeting): Promise<EventInput> {
  const attendees = await db
    .select({
      email: meetingAttendees.email,
      name: meetingAttendees.name,
      isOrganizer: meetingAttendees.isOrganizer,
    })
    .from(meetingAttendees)
    .where(and(eq(meetingAttendees.meetingId, m.id), isNull(meetingAttendees.deletedAt)));
  return {
    title: m.title,
    description: m.description,
    location: m.location,
    startsAt: m.startsAt,
    endsAt: m.endsAt,
    allDay: m.allDay,
    attendees: attendees.filter((a) => !a.isOrganizer).map((a) => ({ email: a.email, name: a.name })),
    // Only ask for a new video call when the event doesn't have one yet.
    addVideoCall: m.addVideoCall && !m.conferenceUrl,
  };
}

/** Updates a meeting and records it in the workspace sync log. */
async function saveMeeting(db: Database, m: Meeting, patch: Partial<Meeting>, where = eq(meetings.id, m.id)) {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(meetings).set(patch).where(where).returning();
    if (row)
      await recordChanges(tx, m.workspaceId, null, [
        { entity: "meeting", entityId: m.id, action: "upsert", data: row },
      ]);
    return row;
  });
}

/**
 * Pushes this organizer's meetings that have unpushed changes. Must be called
 * while holding the connection lease. Returns how many were pushed.
 */
export async function pushPendingMeetings(
  deps: CalendarDeps,
  conn: Connection,
  provider: CalendarProviderClient,
  token: string,
  onlyMeetingId?: string,
): Promise<number> {
  const { db } = deps;
  const pending = await db
    .select()
    .from(meetings)
    .where(
      and(
        eq(meetings.connectionId, conn.id),
        inArray(meetings.syncState, UNPUSHED),
        onlyMeetingId ? eq(meetings.id, onlyMeetingId) : undefined,
      ),
    );
  let pushed = 0;
  for (const m of pending) {
    try {
      if (m.status === "cancelled" || m.deletedAt) {
        if (m.externalEventId) await provider.cancelEvent(token, m.externalEventId);
        await saveMeeting(db, m, { syncState: "synced", syncError: null }, sameVersion(m));
      } else {
        const input = await meetingInput(db, m);
        let event: ExternalEvent;
        try {
          event = m.externalEventId
            ? await provider.updateEvent(token, m.externalEventId, input)
            : await provider.createEvent(token, input);
        } catch (err) {
          // The organizer deleted the event in their calendar app: the meeting is cancelled.
          if (
            m.externalEventId &&
            err instanceof ProviderError &&
            (err.kind === "not_found" || err.kind === "gone")
          ) {
            await saveMeeting(db, m, { status: "cancelled", syncState: "synced", syncError: null });
            pushed++;
            continue;
          }
          throw err;
        }
        const link = {
          externalEventId: event.externalId,
          iCalUid: event.iCalUid,
          htmlLink: event.htmlLink,
          conferenceUrl: event.conferenceUrl ?? m.conferenceUrl,
          externalUpdatedAt: event.updatedAt,
        };
        // Only mark synced if nobody edited the meeting while we were pushing;
        // otherwise keep it pending (the edit goes out next) but remember the event id.
        const saved = await saveMeeting(
          db,
          m,
          { ...link, syncState: "synced", syncError: null },
          sameVersion(m),
        );
        if (!saved) await saveMeeting(db, m, link);
      }
      pushed++;
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "auth") throw err;
      await saveMeeting(
        db,
        m,
        { syncState: "error", syncError: (err as Error).message.slice(0, 500) },
        sameVersion(m),
      );
    }
  }
  return pushed;
}

const sameVersion = (m: Meeting) => and(eq(meetings.id, m.id), eq(meetings.localVersion, m.localVersion));

/**
 * Pushes one meeting right away (after a create/edit in Knotworking). If a sync
 * is already running for that calendar it picks the meeting up instead.
 */
export async function pushMeetingNow(deps: CalendarDeps, meetingId: string) {
  const [m] = await deps.db.select().from(meetings).where(eq(meetings.id, meetingId));
  if (!m?.connectionId) return;
  await withConnectionLease(
    deps,
    m.connectionId,
    async (conn) => {
      const provider = deps.providers[conn.provider];
      if (!provider) return;
      try {
        await pushPendingMeetings(deps, conn, provider, await accessToken(deps, conn), meetingId);
      } catch (err) {
        const [current] = await deps.db.select().from(meetings).where(eq(meetings.id, meetingId));
        if (current) {
          await saveMeeting(
            deps.db,
            current,
            { syncState: "error", syncError: (err as Error).message.slice(0, 500) },
            sameVersion(current),
          );
        }
      }
    },
    { attempts: 4 },
  );
}

// ─── Pull ────────────────────────────────────────────────────────────────────

async function applyChanges(
  tx: Transaction,
  conn: Connection,
  events: ExternalEvent[],
  removedIds: string[],
  full: boolean,
) {
  const [owner] = await tx.select({ email: users.email }).from(users).where(eq(users.id, conn.userId));
  const ownerEmail = owner?.email.toLowerCase();
  // Invitee copies are only matched to meetings in workspaces this person belongs to.
  const memberOf = tx
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, conn.userId), isNull(workspaceMembers.deletedAt)));

  if (full) {
    // A full load replaces the mirrored window.
    const keep = events.map((e) => e.externalId);
    await tx
      .delete(calendarEvents)
      .where(
        and(
          eq(calendarEvents.connectionId, conn.id),
          keep.length ? notInArray(calendarEvents.externalId, keep) : undefined,
        ),
      );
  }

  if (removedIds.length) {
    await tx
      .delete(calendarEvents)
      .where(and(eq(calendarEvents.connectionId, conn.id), inArray(calendarEvents.externalId, removedIds)));
    // Organizer deleted/cancelled the event outside Knotworking → cancel the meeting.
    const cancelled = await tx
      .update(meetings)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(meetings.connectionId, conn.id),
          inArray(meetings.externalEventId, removedIds),
          inArray(meetings.syncState, ["synced", "external"] satisfies MeetingSyncState[]),
          eq(meetings.status, "confirmed"),
        ),
      )
      .returning();
    for (const m of cancelled) {
      await recordChanges(tx, m.workspaceId, null, [
        { entity: "meeting", entityId: m.id, action: "upsert", data: m },
      ]);
    }
  }

  for (const e of events) {
    const values = {
      connectionId: conn.id,
      userId: conn.userId,
      externalId: e.externalId,
      iCalUid: e.iCalUid,
      title: e.title,
      description: e.description,
      location: e.location,
      conferenceUrl: e.conferenceUrl,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      allDay: e.allDay,
      status: e.status,
      organizerEmail: e.organizerEmail,
      isOrganizer: e.isOrganizer,
      attendees: e.attendees,
      htmlLink: e.htmlLink,
      externalUpdatedAt: e.updatedAt,
    };

    // 1. This calendar's own event linked to a meeting (organizer copy, or an imported event).
    const [linked] = await tx
      .select()
      .from(meetings)
      .where(and(eq(meetings.connectionId, conn.id), eq(meetings.externalEventId, e.externalId)));
    let meetingId: string | null = linked?.id ?? null;
    if (linked) await applyExternalToMeeting(tx, linked, e);
    // 2. An invitee's copy of a Knotworking meeting — link it (hides the duplicate) and take their RSVP.
    //    Occurrences of a recurring series share an iCalUID, so they must also match the start time.
    else if (e.iCalUid) {
      const [copyOf] = await tx
        .select()
        .from(meetings)
        .where(
          and(
            eq(meetings.iCalUid, e.iCalUid),
            isNull(meetings.deletedAt),
            inArray(meetings.workspaceId, memberOf),
            e.recurring ? eq(meetings.startsAt, e.startsAt) : undefined,
          ),
        )
        .limit(1);
      if (copyOf) {
        meetingId = copyOf.id;
        const me = e.attendees.find((a) => a.self) ?? e.attendees.find((a) => a.email === ownerEmail);
        if (me) await setResponse(tx, copyOf, conn.userId, me.response);
      }
    }

    await tx
      .insert(calendarEvents)
      .values({ ...values, meetingId })
      .onConflictDoUpdate({
        target: [calendarEvents.connectionId, calendarEvents.externalId],
        set: { ...values, meetingId, updatedAt: new Date() },
      });
  }
}

async function setResponse(
  tx: Transaction,
  m: Meeting,
  userId: string,
  response: ExternalEvent["attendees"][number]["response"],
) {
  const [row] = await tx
    .update(meetingAttendees)
    .set({ response })
    .where(
      and(
        eq(meetingAttendees.meetingId, m.id),
        eq(meetingAttendees.userId, userId),
        sql`${meetingAttendees.response} <> ${response}`,
      ),
    )
    .returning();
  if (row)
    await recordChanges(tx, m.workspaceId, null, [
      { entity: "meeting_attendee", entityId: row.id, action: "upsert", data: row },
    ]);
}

/** Organizer-side changes win unless Knotworking has unpushed edits (those are pushed first). */
async function applyExternalToMeeting(tx: Transaction, m: Meeting, e: ExternalEvent) {
  if (UNPUSHED.includes(m.syncState)) return;
  if (m.externalUpdatedAt && e.updatedAt && e.updatedAt <= m.externalUpdatedAt) return;

  const [row] = await tx
    .update(meetings)
    .set({
      title: e.title,
      description: e.description,
      location: e.location,
      conferenceUrl: e.conferenceUrl,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      allDay: e.allDay,
      status: e.status === "cancelled" ? "cancelled" : "confirmed",
      htmlLink: e.htmlLink,
      iCalUid: e.iCalUid ?? m.iCalUid,
      externalUpdatedAt: e.updatedAt,
    })
    .where(eq(meetings.id, m.id))
    .returning();
  const changes: ChangeInput[] = [{ entity: "meeting", entityId: m.id, action: "upsert", data: row }];

  // Attendee list and RSVPs as the organizer's calendar sees them.
  const existing = await tx.select().from(meetingAttendees).where(eq(meetingAttendees.meetingId, m.id));
  const emails = e.attendees.map((a) => a.email);
  const known = emails.length
    ? await tx.select({ id: users.id, email: users.email }).from(users).where(inArray(users.email, emails))
    : [];
  for (const a of e.attendees) {
    const current = existing.find((x) => x.email === a.email);
    if (current) {
      if (current.response !== a.response || current.deletedAt) {
        const [upd] = await tx
          .update(meetingAttendees)
          .set({ response: a.response, deletedAt: null })
          .where(eq(meetingAttendees.id, current.id))
          .returning();
        changes.push({ entity: "meeting_attendee", entityId: upd!.id, action: "upsert", data: upd });
      }
    } else {
      const [ins] = await tx
        .insert(meetingAttendees)
        .values({
          workspaceId: m.workspaceId,
          meetingId: m.id,
          email: a.email,
          name: a.name,
          response: a.response,
          isOrganizer: a.organizer,
          userId: known.find((k) => k.email === a.email)?.id ?? null,
        })
        .returning();
      changes.push({ entity: "meeting_attendee", entityId: ins!.id, action: "upsert", data: ins });
    }
  }
  // Removed by the organizer (never drop the organizer row itself).
  for (const gone of existing.filter((x) => !x.isOrganizer && !x.deletedAt && !emails.includes(x.email))) {
    await tx.update(meetingAttendees).set({ deletedAt: new Date() }).where(eq(meetingAttendees.id, gone.id));
    changes.push({ entity: "meeting_attendee", entityId: gone.id, action: "delete" });
  }
  await recordChanges(tx, m.workspaceId, null, changes);
}
