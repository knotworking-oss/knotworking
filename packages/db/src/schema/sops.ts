/**
 * SOPs module: standard operating procedures under document control.
 * See docs/modules.md and `@knotworking/core` sops.ts.
 */
import type { DocContent, SopCopyStatus, SopStatus, SopVersionStatus } from "@knotworking/core";
import { sql } from "drizzle-orm";
import { check, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { jobRoles } from "./people";
import { pk, timestamps, ts, workspaceRef } from "./helpers";

/**
 * A controlled procedure. The header and the working draft live here; every submitted version is
 * an immutable row in `sop_versions`. The current version is the one with status `approved`.
 */
export const sops = pgTable(
  "sops",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** Document reference, e.g. `SOP-001`; unique among live SOPs, case-insensitively. */
    code: text("code").notNull(),
    title: text("title").notNull(),
    category: text("category"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    reviewIntervalMonths: integer("review_interval_months").notNull().default(12),
    /** Days an acknowledgement may stay outstanding before the sweep reminds the reader and the managers. */
    ackReminderDays: integer("ack_reminder_days").notNull().default(14),
    /** Days between repeat reminders to a person still outstanding after the first; null: no repeat. */
    ackReminderRepeatDays: integer("ack_reminder_repeat_days"),
    /** The working draft; null when no draft is in progress. Never leaves the API without `write`. */
    draftContent: jsonb("draft_content").$type<DocContent>(),
    draftTitle: text("draft_title"),
    draftUpdatedAt: ts("draft_updated_at"),
    draftUpdatedBy: uuid("draft_updated_by").references(() => users.id, { onDelete: "set null" }),
    status: text("status").$type<SopStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("sops_workspace_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null`),
    index("sops_workspace_idx").on(t.workspaceId, t.title),
  ],
);

/** An immutable snapshot of an SOP, created on submission. Only its status and decision fields ever change. */
export const sopVersions = pgTable(
  "sop_versions",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    sopId: uuid("sop_id")
      .notNull()
      .references(() => sops.id, { onDelete: "cascade" }),
    /** 1, 2, … per SOP, assigned on submission. */
    versionNumber: integer("version_number").notNull(),
    title: text("title").notNull(),
    content: jsonb("content").$type<DocContent>().notNull(),
    changeSummary: text("change_summary").notNull(),
    status: text("status").$type<SopVersionStatus>().notNull().default("in_review"),
    submittedBy: uuid("submitted_by").references(() => users.id, { onDelete: "set null" }),
    submittedAt: ts("submitted_at").notNull().defaultNow(),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: ts("decided_at"),
    decisionNote: text("decision_note"),
    effectiveOn: date("effective_on"),
    reviewDueOn: date("review_due_on"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("sop_versions_number_key").on(t.sopId, t.versionNumber),
    index("sop_versions_workspace_idx").on(t.workspaceId, t.sopId),
  ],
);

/** A member's read-and-understood record against one approved version. */
export const sopAcknowledgements = pgTable(
  "sop_acknowledgements",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    sopId: uuid("sop_id")
      .notNull()
      .references(() => sops.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => sopVersions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    acknowledgedAt: ts("acknowledged_at").notNull().defaultNow(),
    /** `app`, or `kiosk` (a linked member of staff at the attendance kiosk, after their PIN). */
    source: text("source").notNull().default("app"),
  },
  (t) => [
    uniqueIndex("sop_acknowledgements_key").on(t.versionId, t.userId),
    index("sop_acknowledgements_sop_idx").on(t.sopId),
  ],
);

/**
 * Who must read an SOP: a job role (everyone holding it through their linked staff record) or a
 * named member. An SOP with no live targets is for everyone with `read` on SOPs.
 */
export const sopTargets = pgTable(
  "sop_targets",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    sopId: uuid("sop_id")
      .notNull()
      .references(() => sops.id, { onDelete: "cascade" }),
    jobRoleId: uuid("job_role_id").references(() => jobRoles.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    ...timestamps(),
  },
  (t) => [
    index("sop_targets_sop_idx").on(t.sopId),
    // Nulls are distinct, so each constrains only its own kind of target.
    uniqueIndex("sop_targets_role_key").on(t.sopId, t.jobRoleId),
    uniqueIndex("sop_targets_user_key").on(t.sopId, t.userId),
    check("sop_targets_one_kind", sql`(${t.jobRoleId} is null) <> (${t.userId} is null)`),
  ],
);

/**
 * The controlled-copy register: a printed copy of one approved SOP version issued to a person or a
 * place. Numbered per version (copy 1, 2, … of that version), append-only apart from the copy being
 * returned or destroyed. A copy of a version that is no longer current is one to call in.
 */
export const sopCopies = pgTable(
  "sop_copies",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    sopId: uuid("sop_id")
      .notNull()
      .references(() => sops.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => sopVersions.id, { onDelete: "cascade" }),
    /** 1, 2, … per version. */
    copyNumber: integer("copy_number").notNull(),
    /** Who holds it: a member (`issuedToUserId`) and/or a name or place ("Packing room, wall file"). */
    issuedToUserId: uuid("issued_to_user_id").references(() => users.id, { onDelete: "set null" }),
    issuedTo: text("issued_to").notNull(),
    /** Where it is kept, e.g. a wall file or a station. */
    location: text("location"),
    status: text("status").$type<SopCopyStatus>().notNull().default("issued"),
    issuedBy: uuid("issued_by").references(() => users.id, { onDelete: "set null" }),
    issuedAt: ts("issued_at").notNull().defaultNow(),
    /** When it was returned or destroyed, by whom, and a note (e.g. how it was destroyed). */
    closedAt: ts("closed_at"),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    closedNote: text("closed_note"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("sop_copies_number_key").on(t.versionId, t.copyNumber),
    index("sop_copies_sop_idx").on(t.workspaceId, t.sopId),
    index("sop_copies_status_idx").on(t.workspaceId, t.status),
  ],
);
