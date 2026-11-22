/**
 * Calendar module (`calendar`): each member's connected calendars and their private event
 * mirror, and workspace meetings. See docs/modules.md and docs/calendar.md.
 */
import type { AttendeeResponse, CalendarProvider, MeetingSyncState } from "@knotworking/core";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { accounts, users } from "../schema";
import { documents } from "./docs";
import { pk, timestamps, ts, workspaceRef } from "./helpers";

/**
 * A member's connected Google or Microsoft calendar. OAuth tokens live in the
 * linked Better Auth `accounts` row (encrypted at rest); this row tracks sync.
 */
export const calendarConnections = pgTable(
  "calendar_connections",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    provider: text("provider").$type<CalendarProvider>().notNull(),
    /** Google `nextSyncToken` or Microsoft Graph `deltaLink`. */
    syncCursor: text("sync_cursor"),
    /** When the current cursor's window was established (re-baselined weekly). */
    cursorStartedAt: ts("cursor_started_at"),
    lastSyncedAt: ts("last_synced_at"),
    lastError: text("last_error"),
    /** `disconnected` is kept as a tombstone so linked accounts don't silently reconnect. */
    status: text("status").$type<"active" | "error" | "disconnected">().notNull().default("active"),
    /** Prevents two sync runs for the same connection at once. */
    syncLeaseUntil: ts("sync_lease_until"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("calendar_connections_user_provider_key").on(t.userId, t.provider)],
);

export interface CalendarAttendee {
  email: string;
  name?: string | null;
  response: AttendeeResponse;
  organizer?: boolean;
  self?: boolean;
}

/**
 * Private mirror of a member's external calendar (a rolling window). Only the
 * owner ever sees these; they're never written to the workspace sync log.
 */
export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: pk(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => calendarConnections.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    iCalUid: text("ical_uid"),
    title: text("title").notNull().default(""),
    description: text("description"),
    location: text("location"),
    conferenceUrl: text("conference_url"),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    allDay: boolean("all_day").notNull().default(false),
    status: text("status").$type<"confirmed" | "tentative" | "cancelled">().notNull().default("confirmed"),
    organizerEmail: text("organizer_email"),
    isOrganizer: boolean("is_organizer").notNull().default(false),
    attendees: jsonb("attendees").$type<CalendarAttendee[]>().notNull().default([]),
    htmlLink: text("html_link"),
    externalUpdatedAt: ts("external_updated_at"),
    /** Set when this event is (a copy of) a Knotworking meeting — hides the duplicate. */
    meetingId: uuid("meeting_id").references((): AnyPgColumn => meetings.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("calendar_events_connection_external_key").on(t.connectionId, t.externalId),
    index("calendar_events_user_start_idx").on(t.userId, t.startsAt),
    index("calendar_events_ical_idx").on(t.iCalUid),
  ],
);

/** A meeting the whole workspace can see, optionally mirrored to the organizer's calendar. */
export const meetings = pgTable(
  "meetings",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    conferenceUrl: text("conference_url"),
    addVideoCall: boolean("add_video_call").notNull().default(false),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    allDay: boolean("all_day").notNull().default(false),
    status: text("status").$type<"confirmed" | "cancelled">().notNull().default("confirmed"),
    organizerId: uuid("organizer_id").references(() => users.id, { onDelete: "set null" }),
    /** Linked meeting notes in the wiki. */
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    // ── external calendar link ──
    connectionId: uuid("connection_id").references(() => calendarConnections.id, { onDelete: "set null" }),
    provider: text("provider").$type<CalendarProvider>(),
    externalEventId: text("external_event_id"),
    iCalUid: text("ical_uid"),
    htmlLink: text("html_link"),
    externalUpdatedAt: ts("external_updated_at"),
    syncState: text("sync_state").$type<MeetingSyncState>().notNull().default("local"),
    /** Bumped on every Knotworking edit; a push only marks the meeting synced if it hasn't changed since. */
    localVersion: integer("local_version").notNull().default(0),
    syncError: text("sync_error"),
    ...timestamps(),
  },
  (t) => [
    index("meetings_workspace_start_idx").on(t.workspaceId, t.startsAt),
    index("meetings_connection_external_idx").on(t.connectionId, t.externalEventId),
    index("meetings_ical_idx").on(t.iCalUid),
  ],
);

export const meetingAttendees = pgTable(
  "meeting_attendees",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    /** Set when the attendee is a Knotworking user. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    name: text("name"),
    response: text("response").$type<AttendeeResponse>().notNull().default("needsAction"),
    isOrganizer: boolean("is_organizer").notNull().default(false),
    ...timestamps(),
  },
  (t) => [uniqueIndex("meeting_attendees_meeting_email_key").on(t.meetingId, t.email)],
);
