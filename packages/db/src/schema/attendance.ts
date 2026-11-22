/**
 * Attendance module: clock events, kiosk devices, visitors and evacuation roll calls.
 * See docs/modules.md and `@knotworking/core` attendance.ts.
 *
 * Clock times are personal data: none of these tables are written to the sync log (like private
 * calendar events). They are read through paginated endpoints only.
 */
import type { ClockKind, ClockSource, PayPeriodKind, RollCallKind, RollCallStatus } from "@knotworking/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { staff } from "./people";

/**
 * One row per workspace; defaults live in `defaultAttendanceSettings` until someone saves. Shifts
 * are dated in the workspace's own time zone (`workspaces.time_zone`), which is not stored here.
 */
export const attendanceSettings = pgTable("attendance_settings", {
  workspaceId: workspaceRef().primaryKey(),
  roundingMinutes: integer("rounding_minutes").notNull(),
  breakAfterHours: numeric("break_after_hours", { precision: 5, scale: 2, mode: "number" }),
  breakMinutes: integer("break_minutes").notNull(),
  maxShiftHours: integer("max_shift_hours").notNull(),
  overtimeAfterWeeklyHours: numeric("overtime_after_weekly_hours", {
    precision: 6,
    scale: 2,
    mode: "number",
  }),
  payrollFormat: text("payroll_format").notNull(),
  /** The pay period payroll runs for; the anchor is the first day of any period (null: calendar months). */
  payPeriodKind: text("pay_period_kind").$type<PayPeriodKind>().notNull().default("monthly"),
  payPeriodAnchor: date("pay_period_anchor"),
  sageBasicPaymentRef: text("sage_basic_payment_ref"),
  sageOvertimePaymentRef: text("sage_overtime_payment_ref"),
  visitorRetentionMonths: integer("visitor_retention_months").notNull(),
  /** A scanned badge still asks for the PIN. */
  badgeRequiresPin: boolean("badge_requires_pin").notNull().default(true),
  /** How far back a kiosk may replay events it queued offline. */
  offlineReplayHours: integer("offline_replay_hours").notNull().default(72),
  /** Rules visitors accept at sign-in (none: nothing to accept). */
  visitorSiteRules: text("visitor_site_rules"),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  ...timestamps(),
});

/**
 * A paired tablet. A manager creates it and gets a one-time pairing code; the tablet swaps the
 * code for a device credential (`knk_…`). Both are stored as SHA-256 hashes. A device can only
 * post clock events and visitor sign-ins for its workspace.
 */
export const attendanceDevices = pgTable(
  "attendance_devices",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    pairingCodeHash: text("pairing_code_hash"),
    pairingExpiresAt: ts("pairing_expires_at"),
    tokenHash: text("token_hash"),
    pairedAt: ts("paired_at"),
    lastSeenAt: ts("last_seen_at"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: ts("revoked_at"),
    revokedBy: uuid("revoked_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("attendance_devices_token_key")
      .on(t.tokenHash)
      .where(sql`${t.tokenHash} is not null`),
    uniqueIndex("attendance_devices_pairing_key")
      .on(t.pairingCodeHash)
      .where(sql`${t.pairingCodeHash} is not null`),
    index("attendance_devices_workspace_idx").on(t.workspaceId),
  ],
);

/**
 * Clocking in or out. Append-only: the time is never edited. A wrong event is voided (who, when
 * and why; kept and shown), and a missed one is added by a manager with a reason.
 */
export const attendanceEvents = pgTable(
  "attendance_events",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "restrict" }),
    kind: text("kind").$type<ClockKind>().notNull(),
    at: ts("at").notNull(),
    source: text("source").$type<ClockSource>().notNull(),
    deviceId: uuid("device_id").references(() => attendanceDevices.id, { onDelete: "set null" }),
    /** The manager who added it (manual events). */
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason"),
    /** The kiosk's own id for the event: a retry or an offline replay with the same id never clocks twice. */
    clientId: uuid("client_id"),
    /** Queued on the kiosk while it was offline and replayed later (`at` is the tablet's time, corrected). */
    offline: boolean("offline").notNull().default(false),
    voidedAt: ts("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),
    ...timestamps(),
  },
  (t) => [
    index("attendance_events_staff_idx").on(t.workspaceId, t.staffId, t.at),
    index("attendance_events_at_idx").on(t.workspaceId, t.at),
    uniqueIndex("attendance_events_client_key")
      .on(t.workspaceId, t.clientId)
      .where(sql`${t.clientId} is not null`),
  ],
);

/** A visitor signed in at the kiosk. Deleted after the workspace's retention period. */
export const attendanceVisits = pgTable(
  "attendance_visits",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    company: text("company"),
    /** Who they are visiting: a member of staff or a workspace member, with the name as it was. */
    hostStaffId: uuid("host_staff_id").references(() => staff.id, { onDelete: "set null" }),
    hostUserId: uuid("host_user_id").references(() => users.id, { onDelete: "set null" }),
    hostName: text("host_name"),
    /** The site rules they accepted, as they read them, and when. */
    siteRules: text("site_rules"),
    siteRulesAcceptedAt: ts("site_rules_accepted_at"),
    /**
     * SHA-256 (hex) of the rules text the kiosk showed. An offline sign-in seals it, so the visit
     * records the rules the visitor saw even if a manager changed them while the kiosk was offline
     * (then `siteRules` is null: the text shown is no longer known, only its hash).
     */
    siteRulesHash: text("site_rules_hash"),
    /**
     * An offline sign-in whose host had left (or is no longer a member) by the time it was replayed:
     * the visit keeps the host's name as the kiosk showed it, without a link, for a manager to check.
     */
    hostMissing: boolean("host_missing").notNull().default(false),
    signedInAt: ts("signed_in_at").notNull(),
    signedOutAt: ts("signed_out_at"),
    /** `self` (at the kiosk), `manager` or `roll_call`. */
    signedOutHow: text("signed_out_how"),
    signedOutBy: uuid("signed_out_by").references(() => users.id, { onDelete: "set null" }),
    deviceId: uuid("device_id").references(() => attendanceDevices.id, { onDelete: "set null" }),
    /** The kiosk's ids for the sign-in and the sign-out (idempotent retries and offline replays). */
    clientId: uuid("client_id"),
    signOutClientId: uuid("sign_out_client_id"),
    /** Signed in, or out, on a kiosk that was offline at the time. */
    offline: boolean("offline").notNull().default(false),
    signedOutOffline: boolean("signed_out_offline").notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("attendance_visits_client_key")
      .on(t.workspaceId, t.clientId)
      .where(sql`${t.clientId} is not null`),
    uniqueIndex("attendance_visits_sign_out_client_key")
      .on(t.workspaceId, t.signOutClientId)
      .where(sql`${t.signOutClientId} is not null`),
    index("attendance_visits_open_idx").on(t.workspaceId, t.signedOutAt),
    index("attendance_visits_in_idx").on(t.workspaceId, t.signedInAt),
  ],
);

/** An evacuation roll call (a drill or the real thing): BRCGS and fire-safety evidence. */
export const attendanceRollCalls = pgTable(
  "attendance_roll_calls",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    kind: text("kind").$type<RollCallKind>().notNull(),
    startedAt: ts("started_at").notNull(),
    startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
    endedAt: ts("ended_at"),
    endedBy: uuid("ended_by").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes"),
    ...timestamps(),
  },
  (t) => [index("attendance_roll_calls_workspace_idx").on(t.workspaceId, t.startedAt)],
);

/** Who was on site when the roll call started (frozen), and whether they were found. */
export const attendanceRollCallEntries = pgTable(
  "attendance_roll_call_entries",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    rollCallId: uuid("roll_call_id")
      .notNull()
      .references(() => attendanceRollCalls.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "set null" }),
    visitId: uuid("visit_id").references(() => attendanceVisits.id, { onDelete: "set null" }),
    /** The name as it was at the time, so the record survives visitor deletion. */
    name: text("name").notNull(),
    /** Staff number or "Visitor". */
    detail: text("detail"),
    status: text("status").$type<RollCallStatus>().notNull().default("unaccounted"),
    markedAt: ts("marked_at"),
    markedBy: uuid("marked_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [index("attendance_roll_call_entries_call_idx").on(t.rollCallId)],
);

/**
 * A kiosk badge: a printable QR code holding an opaque code (`KIOSK_BADGE_*` in core), stored as a
 * SHA-256 hash. One live badge per person; issuing a new one revokes the old. Never holds the PIN.
 */
export const attendanceBadges = pgTable(
  "attendance_badges",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    /** The last four characters, so a printed badge can be matched to its row. */
    hint: text("hint").notNull(),
    issuedBy: uuid("issued_by").references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    revokedBy: uuid("revoked_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("attendance_badges_code_key").on(t.codeHash),
    uniqueIndex("attendance_badges_live_key")
      .on(t.staffId)
      .where(sql`${t.revokedAt} is null`),
    index("attendance_badges_workspace_idx").on(t.workspaceId),
  ],
);

/**
 * An event a kiosk queued offline that the server refused on replay (wrong PIN, outside the
 * replay window, contradicting the recorded events). Kept so a manager can see it and add the
 * missed event by hand; keyed on the kiosk's client id, so a retry gets the same answer and a
 * wrong PIN is never counted twice.
 */
export const attendanceKioskRejections = pgTable(
  "attendance_kiosk_rejections",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    deviceId: uuid("device_id").references(() => attendanceDevices.id, { onDelete: "set null" }),
    clientId: uuid("client_id").notNull(),
    /** `clock_in`, `clock_out`, `visitor_in` or `visitor_out`. */
    type: text("type").notNull(),
    /** When it happened (the tablet's clock, corrected). */
    at: ts("at").notNull(),
    code: text("code").notNull(),
    message: text("message").notNull(),
    /** The person, when the staff number or badge was recognised. */
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "set null" }),
    /** What else identifies it (an unknown staff number, a visitor's name). */
    detail: text("detail"),
    dismissedAt: ts("dismissed_at"),
    dismissedBy: uuid("dismissed_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("attendance_kiosk_rejections_client_key").on(t.workspaceId, t.clientId),
    index("attendance_kiosk_rejections_open_idx").on(t.workspaceId, t.dismissedAt),
  ],
);
