import type {
  AbsenceKind,
  AbsenceState,
  PayrollRunSnapshot,
  PayrollRunState,
  StaffingAppliesWhen,
} from "@knotworking/core";
import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { jobRoles, staff } from "./people";
import { productionLines } from "./production";
import { pk, ts, workspaceRef } from "./helpers";
/** Private employment records: never add rows, reasons or medical notes to shared sync. */
export const workforceAbsences = pgTable(
  "workforce_absences",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id),
    kind: text("kind").$type<AbsenceKind>().notNull(),
    state: text("state").$type<AbsenceState>().notNull(),
    startOn: date("start_on").notNull(),
    endOn: date("end_on"),
    staffNote: text("staff_note").notNull().default(""),
    hrNote: text("hr_note").notNull().default(""),
    /** Self-service ownership remains bound to the author even if People relinks the login. */
    requestedBy: uuid("requested_by").references(() => users.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    revision: integer("revision").notNull().default(1),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("workforce_absences_staff_dates_idx").on(t.workspaceId, t.staffId, t.startOn),
    index("workforce_absences_state_idx").on(t.workspaceId, t.state, t.createdAt),
  ],
);
export const workforceAbsenceEvents = pgTable(
  "workforce_absence_events",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    absenceId: uuid("absence_id")
      .notNull()
      .references(() => workforceAbsences.id),
    revision: integer("revision").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("workforce_absence_events_history_idx").on(t.workspaceId, t.absenceId, t.revision)],
);

// ─── Rotas, patterns, agencies and staffing requirements (3.4.4.2–3.4.4.3) ─────
// Planning records for members with Workforce access. Like absences they stay out of shared
// sync: the module defaults to no member access and rotas show individual schedules.

/** A named working window (06:00–14:00), optionally on a production line. Deactivated, never deleted. */
export const workforceShifts = pgTable(
  "workforce_shifts",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    /** 24-hour HH:MM. An end at or before the start crosses midnight. */
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    lineId: uuid("line_id").references(() => productionLines.id),
    active: boolean("active").notNull().default(true),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workforce_shifts_name_key").on(t.workspaceId, sql`lower(${t.name})`)],
);

/** A staff member's recurring shift on chosen weekdays; generating a rota turns it into entries. */
export const workforceWorkingPatterns = pgTable(
  "workforce_working_patterns",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => workforceShifts.id),
    /** Bit 0 = Monday … bit 6 = Sunday. */
    weekdays: integer("weekdays").notNull(),
    jobRoleId: uuid("job_role_id").references(() => jobRoles.id),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    revision: integer("revision").notNull().default(1),
    endReason: text("end_reason"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("workforce_working_patterns_staff_idx").on(t.workspaceId, t.staffId)],
);

/** One person on one shift on one date. Cancelled rather than deleted, with who and why. */
export const workforceRotaEntries = pgTable(
  "workforce_rota_entries",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => workforceShifts.id),
    /** The date the shift starts. */
    workDate: date("work_date").notNull(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id),
    /** The role the person covers on this shift (one they hold). */
    jobRoleId: uuid("job_role_id").references(() => jobRoles.id),
    patternId: uuid("pattern_id").references(() => workforceWorkingPatterns.id),
    note: text("note").notNull().default(""),
    state: text("state").$type<"active" | "cancelled">().notNull().default("active"),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    cancelledBy: uuid("cancelled_by").references(() => users.id, { onDelete: "set null" }),
    cancelledAt: ts("cancelled_at"),
    cancelReason: text("cancel_reason"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workforce_rota_entries_active_key")
      .on(t.workspaceId, t.staffId, t.workDate, t.shiftId)
      .where(sql`${t.state} = 'active'`),
    index("workforce_rota_entries_date_idx").on(t.workspaceId, t.workDate),
  ],
);

/** A labour agency that supplies workers. Deactivated, never deleted. */
export const workforceAgencies = pgTable(
  "workforce_agencies",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    contact: text("contact").notNull().default(""),
    active: boolean("active").notNull().default(true),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workforce_agencies_name_key").on(t.workspaceId, sql`lower(${t.name})`)],
);

/**
 * A People record supplied by an agency over a period. The worker stays an ordinary staff record,
 * so training, kiosk clocking and rota rules apply to them unchanged.
 */
export const workforceAgencyEngagements = pgTable(
  "workforce_agency_engagements",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    agencyId: uuid("agency_id")
      .notNull()
      .references(() => workforceAgencies.id),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id),
    startOn: date("start_on").notNull(),
    endOn: date("end_on"),
    /** The agency's booking or worker reference. */
    reference: text("reference").notNull().default(""),
    revision: integer("revision").notNull().default(1),
    endReason: text("end_reason"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("workforce_agency_engagements_staff_idx").on(t.workspaceId, t.staffId, t.startOn)],
);

/**
 * What a shift needs: a headcount holding a job role and/or current on training courses.
 * Requirements are checked independently, so one person may count towards several.
 */
export const workforceStaffingRequirements = pgTable(
  "workforce_staffing_requirements",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => workforceShifts.id),
    name: text("name").notNull(),
    headcount: integer("headcount").notNull(),
    jobRoleId: uuid("job_role_id").references(() => jobRoles.id),
    /** Training courses every counted person must be current on for the shift date. */
    courseIds: jsonb("course_ids").$type<string[]>().notNull().default([]),
    weekdays: integer("weekdays").notNull(),
    appliesWhen: text("applies_when").$type<StaffingAppliesWhen>().notNull().default("always"),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    active: boolean("active").notNull().default(true),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("workforce_staffing_requirements_shift_idx").on(t.workspaceId, t.shiftId)],
);

// ─── Payroll runs (3.4.4.4) ──────────────────────────────────────────────────
// Private employment records (hours and sickness days): never add them to shared sync.

/**
 * A reviewed snapshot of one pay period that payroll exports are built from. Prepared by one
 * person and approved by another; never edited. A correction is a new version that supersedes
 * the run it corrects when approved.
 */
export const workforcePayrollRuns = pgTable(
  "workforce_payroll_runs",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),
    version: integer("version").notNull().default(1),
    supersedesId: uuid("supersedes_id"),
    state: text("state").$type<PayrollRunState>().notNull().default("prepared"),
    snapshot: jsonb("snapshot").$type<PayrollRunSnapshot>().notNull(),
    /** SHA-256 of the canonical snapshot, shown on exports. */
    snapshotHash: text("snapshot_hash").notNull(),
    note: text("note").notNull().default(""),
    preparedBy: uuid("prepared_by")
      .notNull()
      .references(() => users.id),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: ts("approved_at"),
    approvalNote: text("approval_note"),
    supersededAt: ts("superseded_at"),
    revision: integer("revision").notNull().default(1),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("workforce_payroll_runs_period_idx").on(t.workspaceId, t.periodFrom, t.periodTo)],
);

/** Append-only history: prepared, approved, exported (adapter, file hash), superseded. */
export const workforcePayrollRunEvents = pgTable(
  "workforce_payroll_run_events",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    runId: uuid("run_id")
      .notNull()
      .references(() => workforcePayrollRuns.id),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    action: text("action").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("workforce_payroll_run_events_run_idx").on(t.workspaceId, t.runId, t.createdAt)],
);
