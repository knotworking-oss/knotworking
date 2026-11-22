/**
 * People module: the staff register that training and attendance build on.
 * See docs/modules.md and `@knotworking/core` people.ts.
 */
import type { JobRoleStatus, StaffStatus } from "@knotworking/core";
import { sql } from "drizzle-orm";
import { date, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";

/**
 * Someone who works on site. Most never sign in: they are identified by a 6-digit staff number
 * and a 6-digit PIN at the kiosk. Payroll history refers to the staff number, so it is unique per
 * workspace across every row ever created (leavers and deleted rows included) and never reused.
 *
 * Holds no sensitive HR data (NI number, date of birth, address, pay): the payroll package keeps
 * those. The PIN columns never leave the API.
 */
export const staff = pgTable(
  "staff",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    staffNumber: text("staff_number").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    jobTitle: text("job_title"),
    department: text("department"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    status: text("status").$type<StaffStatus>().notNull().default("active"),
    /** Employee number in the payroll package, when it isn't the staff number. */
    payrollReference: text("payroll_reference"),
    /** The workspace member this person signs in as, if any. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** HMAC-SHA-256 of the PIN under a server-held key (see `services/people.ts`). Never serialized. */
    pinHash: text("pin_hash"),
    pinSetAt: ts("pin_set_at"),
    pinSetBy: uuid("pin_set_by").references(() => users.id, { onDelete: "set null" }),
    /** Wrong PINs in a row; reset by a right one or by a manager. */
    pinFailedAttempts: integer("pin_failed_attempts").notNull().default(0),
    pinLockedUntil: ts("pin_locked_until"),
    ...timestamps(),
  },
  (t) => [
    // Deliberately not partial: a number is never reused, even after a delete.
    uniqueIndex("staff_workspace_number_key").on(t.workspaceId, t.staffNumber),
    uniqueIndex("staff_workspace_user_key")
      .on(t.workspaceId, t.userId)
      .where(sql`${t.deletedAt} is null and ${t.userId} is not null`),
    index("staff_workspace_name_idx").on(t.workspaceId, t.lastName, t.firstName),
  ],
);

/** A job role (line operative, hygiene, first aider). Training requirements hang on roles. */
export const jobRoles = pgTable(
  "job_roles",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").$type<JobRoleStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("job_roles_workspace_name_key")
      .on(t.workspaceId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/** Which roles a person holds; a person can hold several. */
export const staffJobRoles = pgTable(
  "staff_job_roles",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    jobRoleId: uuid("job_role_id")
      .notNull()
      .references(() => jobRoles.id, { onDelete: "cascade" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("staff_job_roles_key").on(t.staffId, t.jobRoleId),
    index("staff_job_roles_role_idx").on(t.jobRoleId),
  ],
);
