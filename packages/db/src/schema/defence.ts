/**
 * Food defence module: threat assessments and their versions, security controls and their
 * checks, and exercises. See docs/modules.md and `@knotworking/core` defence.ts.
 *
 * An assessment is the stable identity; its threats live in versions. At most one draft and one
 * approved version per assessment; approving supersedes the previous approved version, which is
 * kept. Only metadata goes to the sync log: threats, check notes and exercise findings describe
 * the site's weak points and are read through endpoints.
 */
import type {
  DefenceCheckOutcome,
  DefenceControlKind,
  DefenceExerciseOutcome,
  DefenceReviewTrigger,
  DefenceThreat,
  DefenceVersionStatus,
} from "@knotworking/core";
import { sql } from "drizzle-orm";
import { date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";

export const defenceAssessments = pgTable(
  "defence_assessments",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    title: text("title").notNull(),
    scope: text("scope"),
    /** `active` or `archived`. */
    status: text("status").$type<"active" | "archived">().notNull().default("active"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [index("defence_assessments_workspace_idx").on(t.workspaceId, t.status)],
);

export const defenceAssessmentVersions = pgTable(
  "defence_assessment_versions",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    assessmentId: uuid("assessment_id")
      .notNull()
      .references(() => defenceAssessments.id, { onDelete: "cascade" }),
    /** 1, 2, … per assessment. */
    versionNumber: integer("version_number").notNull(),
    status: text("status").$type<DefenceVersionStatus>().notNull().default("draft"),
    summary: text("summary"),
    threats: jsonb("threats").$type<DefenceThreat[]>().notNull().default([]),
    reviewDueOn: date("review_due_on"),
    /** Why this version was started (null for the first). */
    reviewTrigger: text("review_trigger").$type<DefenceReviewTrigger>(),
    reviewReason: text("review_reason"),
    lastEditedBy: uuid("last_edited_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: ts("approved_at"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("defence_assessment_versions_number_key").on(t.assessmentId, t.versionNumber),
    uniqueIndex("defence_assessment_versions_one_draft_key")
      .on(t.assessmentId)
      .where(sql`${t.status} = 'draft' and ${t.deletedAt} is null`),
    uniqueIndex("defence_assessment_versions_one_approved_key")
      .on(t.assessmentId)
      .where(sql`${t.status} = 'approved' and ${t.deletedAt} is null`),
  ],
);

export const defenceControls = pgTable(
  "defence_controls",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    kind: text("kind").$type<DefenceControlKind>().notNull(),
    area: text("area"),
    frequencyDays: integer("frequency_days").notNull(),
    instructions: text("instructions"),
    status: text("status").$type<"active" | "archived">().notNull().default("active"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [index("defence_controls_workspace_idx").on(t.workspaceId, t.status)],
);

/** A person's check of a control. A failure stays open until someone resolves it. */
export const defenceChecks = pgTable(
  "defence_checks",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    controlId: uuid("control_id")
      .notNull()
      .references(() => defenceControls.id, { onDelete: "cascade" }),
    checkedOn: date("checked_on").notNull(),
    outcome: text("outcome").$type<DefenceCheckOutcome>().notNull(),
    notes: text("notes"),
    actionTaken: text("action_taken"),
    checkedBy: uuid("checked_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: ts("resolved_at"),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolution: text("resolution"),
    ...timestamps(),
  },
  (t) => [
    index("defence_checks_control_idx").on(t.controlId, t.checkedOn),
    index("defence_checks_open_idx")
      .on(t.workspaceId)
      .where(sql`${t.outcome} = 'fail' and ${t.resolvedAt} is null`),
  ],
);

export const defenceExercises = pgTable(
  "defence_exercises",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    title: text("title").notNull(),
    scenario: text("scenario").notNull(),
    heldOn: date("held_on").notNull(),
    assessmentId: uuid("assessment_id").references(() => defenceAssessments.id, { onDelete: "set null" }),
    participants: text("participants"),
    outcome: text("outcome").$type<DefenceExerciseOutcome>().notNull(),
    findings: text("findings"),
    actions: text("actions"),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [index("defence_exercises_workspace_idx").on(t.workspaceId, t.heldOn)],
);
