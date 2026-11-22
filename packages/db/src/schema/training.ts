/**
 * Training module: courses, the training matrix (which job roles need which course) and
 * append-only training records. See docs/modules.md and `@knotworking/core` training.ts.
 */
import type { TrainingCourseKind, TrainingCourseStatus, TrainingOutcome } from "@knotworking/core";
import { sql } from "drizzle-orm";
import { boolean, date, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { jobRoles, staff } from "./people";
import { sops, sopVersions } from "./sops";

/** Something people are trained on: an SOP, an induction, on-the-job training or an outside course. */
export const trainingCourses = pgTable(
  "training_courses",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** Unique among live courses, case-insensitively. */
    code: text("code").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    kind: text("kind").$type<TrainingCourseKind>().notNull(),
    /** The SOP an `sop` course trains on; a new approved version makes earlier training outdated. */
    sopId: uuid("sop_id").references(() => sops.id, { onDelete: "set null" }),
    /** Months training stays valid; null = never expires. */
    validityMonths: integer("validity_months"),
    requiresSignOff: boolean("requires_sign_off").notNull().default(true),
    status: text("status").$type<TrainingCourseStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("training_courses_workspace_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null`),
    index("training_courses_sop_idx").on(t.sopId),
  ],
);

/** A job role needs a course: together these rows are the training matrix. */
export const trainingRequirements = pgTable(
  "training_requirements",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => trainingCourses.id, { onDelete: "cascade" }),
    jobRoleId: uuid("job_role_id")
      .notNull()
      .references(() => jobRoles.id, { onDelete: "cascade" }),
    /** Days after the person's start date by which they must be trained; null = no deadline. */
    dueWithinDays: integer("due_within_days"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("training_requirements_key").on(t.courseId, t.jobRoleId),
    index("training_requirements_role_idx").on(t.jobRoleId),
  ],
);

/**
 * One person trained on one course on one day. Append-only: nothing edits the training itself.
 * Two one-way decisions are recorded on the row: the competency sign-off (who and when; a
 * manager in person) and voiding a record made in error (who, when and why). A voided record
 * never counts and is kept.
 */
export const trainingRecords = pgTable(
  "training_records",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "restrict" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => trainingCourses.id, { onDelete: "restrict" }),
    /** For SOP courses: the approved SOP version the person was trained on. */
    sopVersionId: uuid("sop_version_id").references(() => sopVersions.id, { onDelete: "restrict" }),
    completedOn: date("completed_on").notNull(),
    outcome: text("outcome").$type<TrainingOutcome>().notNull(),
    /** `completedOn` + the course's validity at the time; null = never expires. */
    expiresOn: date("expires_on"),
    trainerUserId: uuid("trainer_user_id").references(() => users.id, { onDelete: "set null" }),
    trainerName: text("trainer_name"),
    notes: text("notes"),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    signedOffAt: ts("signed_off_at"),
    signedOffBy: uuid("signed_off_by").references(() => users.id, { onDelete: "set null" }),
    voidedAt: ts("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),
    ...timestamps(),
  },
  (t) => [
    index("training_records_staff_idx").on(t.workspaceId, t.staffId, t.courseId),
    index("training_records_course_idx").on(t.courseId),
  ],
);
