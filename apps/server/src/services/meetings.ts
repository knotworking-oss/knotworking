import {
  d,
  sortKeyBetween,
  type AttendeeResponse,
  type MeetingCreateInput,
  type MeetingUpdateInput,
} from "@knotworking/core";
import {
  calendarConnections,
  calendarEvents,
  documents,
  meetingAttendees,
  meetings,
  recordChanges,
  users,
  type ChangeInput,
  type Database,
  type Transaction,
} from "@knotworking/db";
import { and, asc, desc, eq, gt, inArray, isNull, lt, max, ne, sql } from "drizzle-orm";
import { pushMeetingNow, type CalendarDeps } from "../calendar/sync";
import type { CurrentWorkspace } from "../env";
import { ApiError, badRequest, notFound } from "../errors";

type Meeting = typeof meetings.$inferSelect;

async function attendeesFor(db: Database | Transaction, meetingIds: string[]) {
  if (!meetingIds.length) return [];
  return db
    .select()
    .from(meetingAttendees)
    .where(and(inArray(meetingAttendees.meetingId, meetingIds), isNull(meetingAttendees.deletedAt)))
    .orderBy(desc(meetingAttendees.isOrganizer), asc(meetingAttendees.email));
}

function serialize(m: Meeting, attendees: (typeof meetingAttendees.$inferSelect)[]) {
  const { deletedAt: _d, workspaceId: _w, ...rest } = m;
  return {
    ...rest,
    attendees: attendees
      .filter((a) => a.meetingId === m.id)
      .map((a) => ({
        id: a.id,
        userId: a.userId,
        email: a.email,
        name: a.name,
        response: a.response,
        isOrganizer: a.isOrganizer,
      })),
  };
}

/** Everything the calendar view needs for a date range, for the current user. */
export async function getCalendar(db: Database, workspaceId: string, userId: string, from: Date, to: Date) {
  const rows = await db
    .select()
    .from(meetings)
    .where(
      and(
        eq(meetings.workspaceId, workspaceId),
        isNull(meetings.deletedAt),
        lt(meetings.startsAt, to),
        gt(meetings.endsAt, from),
      ),
    )
    .orderBy(asc(meetings.startsAt));
  const attendees = await attendeesFor(
    db,
    rows.map((m) => m.id),
  );

  // The user's own calendar, minus events that are copies of Knotworking meetings.
  const personal = await db
    .select({
      id: calendarEvents.id,
      provider: calendarConnections.provider,
      title: calendarEvents.title,
      location: calendarEvents.location,
      conferenceUrl: calendarEvents.conferenceUrl,
      startsAt: calendarEvents.startsAt,
      endsAt: calendarEvents.endsAt,
      allDay: calendarEvents.allDay,
      status: calendarEvents.status,
      isOrganizer: calendarEvents.isOrganizer,
      organizerEmail: calendarEvents.organizerEmail,
      attendeeCount: calendarEvents.attendees,
      htmlLink: calendarEvents.htmlLink,
    })
    .from(calendarEvents)
    .innerJoin(calendarConnections, eq(calendarConnections.id, calendarEvents.connectionId))
    .where(
      and(
        eq(calendarEvents.userId, userId),
        isNull(calendarEvents.meetingId),
        ne(calendarEvents.status, "cancelled"),
        lt(calendarEvents.startsAt, to),
        gt(calendarEvents.endsAt, from),
      ),
    )
    .orderBy(asc(calendarEvents.startsAt));

  return {
    meetings: rows.map((m) => serialize(m, attendees)),
    events: personal.map(({ attendeeCount, ...e }) => ({ ...e, attendeeCount: attendeeCount.length })),
  };
}

export async function getMeeting(db: Database, workspaceId: string, id: string) {
  const [m] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, id), eq(meetings.workspaceId, workspaceId), isNull(meetings.deletedAt)));
  if (!m) throw notFound("Meeting");
  return serialize(m, await attendeesFor(db, [m.id]));
}

async function userConnection(db: Database | Transaction, userId: string, provider?: string) {
  const conns = await db
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.userId, userId), ne(calendarConnections.status, "disconnected")));
  return conns.find((c) => c.provider === provider) ?? conns[0];
}

async function writeAttendees(
  tx: Transaction,
  m: Meeting,
  organizer: { id: string; email: string; name: string },
  emails: string[],
): Promise<ChangeInput[]> {
  const wanted = [
    ...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e && e !== organizer.email)),
  ];
  const known = wanted.length ? await tx.select().from(users).where(inArray(users.email, wanted)) : [];
  const existing = await tx.select().from(meetingAttendees).where(eq(meetingAttendees.meetingId, m.id));
  const changes: ChangeInput[] = [];
  const rows = [
    {
      email: organizer.email,
      name: organizer.name,
      userId: organizer.id,
      isOrganizer: true,
      response: "accepted" as AttendeeResponse,
    },
    ...wanted.map((email) => {
      const u = known.find((k) => k.email === email);
      return {
        email,
        name: u?.name ?? null,
        userId: u?.id ?? null,
        isOrganizer: false,
        response: "needsAction" as AttendeeResponse,
      };
    }),
  ];
  for (const r of rows) {
    const current = existing.find((x) => x.email === r.email);
    if (current && !current.deletedAt) continue;
    if (current) {
      const [row] = await tx
        .update(meetingAttendees)
        .set({ deletedAt: null })
        .where(eq(meetingAttendees.id, current.id))
        .returning();
      changes.push({ entity: "meeting_attendee", entityId: row!.id, action: "upsert", data: row });
    } else {
      const [row] = await tx
        .insert(meetingAttendees)
        .values({ workspaceId: m.workspaceId, meetingId: m.id, ...r })
        .returning();
      changes.push({ entity: "meeting_attendee", entityId: row!.id, action: "upsert", data: row });
    }
  }
  for (const gone of existing.filter((x) => !x.isOrganizer && !x.deletedAt && !wanted.includes(x.email))) {
    await tx.update(meetingAttendees).set({ deletedAt: new Date() }).where(eq(meetingAttendees.id, gone.id));
    changes.push({ entity: "meeting_attendee", entityId: gone.id, action: "delete" });
  }
  return changes;
}

const DAY = 86_400_000;
const utcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * All-day meetings are dates, stored as UTC midnight (end exclusive) — the same
 * convention Google and Microsoft use — so they never shift with time zones.
 */
function normalizeTimes(startsAt: Date, endsAt: Date, allDay: boolean) {
  if (allDay) {
    const start = utcMidnight(startsAt);
    const end = utcMidnight(endsAt);
    return { startsAt: start, endsAt: end > start ? end : new Date(start.getTime() + DAY) };
  }
  if (endsAt <= startsAt) throw badRequest("A meeting must end after it starts");
  return { startsAt, endsAt };
}

export async function createMeeting(
  deps: CalendarDeps,
  ws: CurrentWorkspace,
  actorId: string,
  input: MeetingCreateInput,
) {
  const { db } = deps;
  const times = normalizeTimes(input.startsAt, input.endsAt, input.allDay ?? false);
  const [organizer] = await db.select().from(users).where(eq(users.id, actorId));
  const conn = await userConnection(db, actorId, input.provider);

  const id = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(meetings)
      .values({
        workspaceId: ws.id,
        title: input.title,
        description: input.description ?? null,
        location: input.location ?? null,
        ...times,
        allDay: input.allDay ?? false,
        addVideoCall: input.addVideoCall ?? false,
        organizerId: actorId,
        connectionId: conn?.id ?? null,
        provider: conn?.provider ?? null,
        syncState: conn ? "pending" : "local",
      })
      .returning();
    const changes = await writeAttendees(tx, m!, organizer!, input.attendeeEmails ?? []);
    await recordChanges(tx, ws.id, actorId, [
      { entity: "meeting", entityId: m!.id, action: "upsert", data: m },
      ...changes,
    ]);
    return m!.id;
  });

  if (input.createNotes) await createMeetingNotes(db, ws, actorId, id);
  if (conn) await pushMeetingNow(deps, id);
  return getMeeting(db, ws.id, id);
}

async function editable(db: Database, ws: CurrentWorkspace, actorId: string, id: string) {
  const [m] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, id), eq(meetings.workspaceId, ws.id), isNull(meetings.deletedAt)));
  if (!m) throw notFound("Meeting");
  if (m.syncState === "external") {
    throw new ApiError(
      409,
      "external_meeting",
      `This meeting is managed in the organizer's ${m.provider ?? "calendar"} — edit it there`,
    );
  }
  if (m.organizerId === actorId) return m;
  // Synced meetings are changed with the organizer's own calendar account, so only they may edit.
  if (m.connectionId) {
    throw new ApiError(
      403,
      "forbidden",
      "Only the organizer can change a meeting that's synced with their calendar",
    );
  }
  if (!["owner", "admin"].includes(ws.role))
    throw new ApiError(403, "forbidden", "Only the organizer can change this meeting");
  return m;
}

export async function updateMeeting(
  deps: CalendarDeps,
  ws: CurrentWorkspace,
  actorId: string,
  id: string,
  input: MeetingUpdateInput,
) {
  const { db } = deps;
  const m = await editable(db, ws, actorId, id);
  const { attendeeEmails, ...fields } = input;
  const times = normalizeTimes(
    fields.startsAt ?? m.startsAt,
    fields.endsAt ?? m.endsAt,
    fields.allDay ?? m.allDay,
  );

  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(meetings)
      .set({
        ...fields,
        ...times,
        syncState: m.connectionId ? "pending" : m.syncState,
        localVersion: sql`${meetings.localVersion} + 1`,
      })
      .where(eq(meetings.id, id))
      .returning();
    const changes: ChangeInput[] = [{ entity: "meeting", entityId: id, action: "upsert", data: row }];
    if (attendeeEmails) {
      const [organizer] = await tx
        .select()
        .from(users)
        .where(eq(users.id, m.organizerId ?? actorId));
      changes.push(...(await writeAttendees(tx, row!, organizer!, attendeeEmails)));
    }
    await recordChanges(tx, ws.id, actorId, changes);
  });
  if (m.connectionId) await pushMeetingNow(deps, id);
  return getMeeting(db, ws.id, id);
}

export async function cancelMeeting(deps: CalendarDeps, ws: CurrentWorkspace, actorId: string, id: string) {
  const { db } = deps;
  const m = await editable(db, ws, actorId, id);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(meetings)
      .set({
        status: "cancelled",
        syncState: m.connectionId ? "pending" : m.syncState,
        localVersion: sql`${meetings.localVersion} + 1`,
      })
      .where(eq(meetings.id, id))
      .returning();
    await recordChanges(tx, ws.id, actorId, [
      { entity: "meeting", entityId: id, action: "upsert", data: row },
    ]);
  });
  if (m.connectionId) await pushMeetingNow(deps, id);
  return getMeeting(db, ws.id, id);
}

/**
 * Shares one of your own calendar events with the workspace as a Knotworking
 * meeting. Events you organize stay two-way synced; others are read-only.
 */
export async function importEvent(
  db: Database,
  ws: CurrentWorkspace,
  actorId: string,
  calendarEventId: string,
) {
  const [e] = await db
    .select()
    .from(calendarEvents)
    .where(and(eq(calendarEvents.id, calendarEventId), eq(calendarEvents.userId, actorId)));
  if (!e) throw notFound("Calendar event");
  if (e.meetingId) return getMeeting(db, ws.id, e.meetingId);
  const [conn] = await db
    .select()
    .from(calendarConnections)
    .where(eq(calendarConnections.id, e.connectionId));
  const emails = e.attendees.map((a) => a.email);
  const known = emails.length ? await db.select().from(users).where(inArray(users.email, emails)) : [];
  const organizerUser = e.isOrganizer
    ? actorId
    : (known.find((u) => u.email === e.organizerEmail)?.id ?? null);

  const id = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(meetings)
      .values({
        workspaceId: ws.id,
        title: e.title,
        description: e.description,
        location: e.location,
        conferenceUrl: e.conferenceUrl,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        allDay: e.allDay,
        organizerId: organizerUser,
        connectionId: e.connectionId,
        provider: conn?.provider ?? null,
        externalEventId: e.externalId,
        iCalUid: e.iCalUid,
        htmlLink: e.htmlLink,
        externalUpdatedAt: e.externalUpdatedAt,
        syncState: e.isOrganizer ? "synced" : "external",
      })
      .returning();
    // Personal events often have no guest list — the importer (or the organizer) is the only attendee.
    const [actor] = await tx.select().from(users).where(eq(users.id, actorId));
    const fallbackEmail = e.isOrganizer ? actor!.email : (e.organizerEmail ?? actor!.email);
    const attendeeRows = e.attendees.length
      ? e.attendees
      : [
          {
            email: fallbackEmail,
            name: e.isOrganizer ? actor!.name : null,
            response: "accepted" as const,
            organizer: true,
          },
        ];
    const values = attendeeRows
      .filter((a) => a.email)
      .map((a) => ({
        workspaceId: ws.id,
        meetingId: m!.id,
        email: a.email,
        name: a.name ?? null,
        response: a.response,
        isOrganizer: Boolean(a.organizer) || a.email === e.organizerEmail,
        userId: known.find((u) => u.email === a.email)?.id ?? (a.email === actor!.email ? actorId : null),
      }));
    const inserted = values.length
      ? await tx.insert(meetingAttendees).values(values).onConflictDoNothing().returning()
      : [];
    await tx.update(calendarEvents).set({ meetingId: m!.id }).where(eq(calendarEvents.id, e.id));
    await recordChanges(tx, ws.id, actorId, [
      { entity: "meeting", entityId: m!.id, action: "upsert", data: m },
      ...inserted.map((a) => ({
        entity: "meeting_attendee" as const,
        entityId: a.id,
        action: "upsert" as const,
        data: a,
      })),
    ]);
    return m!.id;
  });
  return getMeeting(db, ws.id, id);
}

/** Creates a notes doc for the meeting in the wiki (under "Meeting Notes" if it exists). */
export async function createMeetingNotes(db: Database, ws: CurrentWorkspace, actorId: string, id: string) {
  const meeting = await getMeeting(db, ws.id, id);
  if (meeting.documentId) return meeting;
  const [parent] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.workspaceId, ws.id),
        isNull(documents.parentId),
        eq(documents.title, "Meeting Notes"),
        isNull(documents.deletedAt),
      ),
    );
  // All-day meetings are UTC-midnight dates; timed ones fall on a day in the workspace's time zone.
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: meeting.allDay ? "UTC" : ws.timeZone,
  }).format(meeting.startsAt);
  await db.transaction(async (tx) => {
    const [last] = await tx
      .select({ value: max(documents.sortOrder) })
      .from(documents)
      .where(
        and(
          eq(documents.workspaceId, ws.id),
          parent ? eq(documents.parentId, parent.id) : isNull(documents.parentId),
        ),
      );
    const [doc] = await tx
      .insert(documents)
      .values({
        workspaceId: ws.id,
        parentId: parent?.id ?? null,
        title: `${meeting.title} — ${date}`,
        icon: "📝",
        sortOrder: sortKeyBetween(last?.value ?? null, null),
        creatorId: actorId,
        lastEditedById: actorId,
        content: d.doc(
          d.h(3, "Attendees"),
          d.p(meeting.attendees.map((a) => a.name ?? a.email).join(", ") || "—"),
          d.h(3, "Agenda"),
          d.bullets(""),
          d.h(3, "Notes"),
          d.p(""),
          d.h(3, "Action items"),
          d.tasks(["", false]),
        ),
      })
      .returning();
    const [row] = await tx
      .update(meetings)
      .set({ documentId: doc!.id })
      .where(eq(meetings.id, id))
      .returning();
    await recordChanges(tx, ws.id, actorId, [
      { entity: "document", entityId: doc!.id, action: "upsert", data: doc },
      { entity: "meeting", entityId: id, action: "upsert", data: row },
    ]);
  });
  return getMeeting(db, ws.id, id);
}
