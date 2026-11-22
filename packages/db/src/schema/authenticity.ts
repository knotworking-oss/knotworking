import type { AuthenticityDraft, AuthenticityVersion, AuthenticityTrigger } from "@knotworking/core";
import { sql } from "drizzle-orm";
import { date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, ts, workspaceRef } from "./helpers";
import { items, suppliers } from "./items";

export const authenticityAssessments = pgTable(
  "authenticity_assessments",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    status: text("status").$type<"active" | "archived">().notNull().default("active"),
    currentVersionId: uuid("current_version_id"),
    draftVersionId: uuid("draft_version_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    archivedAt: ts("archived_at"),
    archivedBy: uuid("archived_by").references(() => users.id),
    archiveReason: text("archive_reason"),
  },
  (t) => [
    uniqueIndex("authenticity_assessments_reference_key").on(t.workspaceId, t.reference),
    uniqueIndex("authenticity_assessments_active_subject_key")
      .on(
        t.workspaceId,
        t.itemId,
        sql`coalesce(${t.supplierId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`${t.status} = 'active'`),
    index("authenticity_assessments_workspace_idx").on(t.workspaceId, t.status),
  ],
);
export const authenticityVersions = pgTable(
  "authenticity_versions",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    assessmentId: uuid("assessment_id")
      .notNull()
      .references(() => authenticityAssessments.id),
    number: integer("number").notNull(),
    status: text("status").$type<AuthenticityVersion["status"]>().notNull(),
    body: jsonb("body").$type<AuthenticityDraft>().notNull(),
    subject: jsonb("subject").$type<AuthenticityVersion["subject"]>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id),
    approvedAt: ts("approved_at"),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvalNote: text("approval_note"),
  },
  (t) => [
    uniqueIndex("authenticity_versions_number_key").on(t.assessmentId, t.number),
    uniqueIndex("authenticity_versions_draft_key")
      .on(t.assessmentId)
      .where(sql`${t.status} = 'draft'`),
    uniqueIndex("authenticity_versions_approved_key")
      .on(t.assessmentId)
      .where(sql`${t.status} = 'approved'`),
  ],
);
export const authenticityTriggers = pgTable(
  "authenticity_triggers",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    assessmentId: uuid("assessment_id")
      .notNull()
      .references(() => authenticityAssessments.id),
    kind: text("kind").$type<AuthenticityTrigger["kind"]>().notNull(),
    note: text("note").notNull(),
    reference: text("reference").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    actorId: uuid("actor_id").references(() => users.id),
    resolvedByVersionId: uuid("resolved_by_version_id").references(() => authenticityVersions.id),
  },
  (t) => [index("authenticity_triggers_assessment_idx").on(t.workspaceId, t.assessmentId)],
);
export const authenticityVerifications = pgTable(
  "authenticity_verifications",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    assessmentId: uuid("assessment_id")
      .notNull()
      .references(() => authenticityAssessments.id),
    versionId: uuid("version_id")
      .notNull()
      .references(() => authenticityVersions.id),
    controlId: uuid("control_id").notNull(),
    verifiedOn: date("verified_on").notNull(),
    outcome: text("outcome").$type<"pass" | "fail">().notNull(),
    evidenceReference: text("evidence_reference").notNull(),
    evidenceValidUntil: date("evidence_valid_until"),
    note: text("note").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    actorId: uuid("actor_id").references(() => users.id),
    voidedAt: ts("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
  },
  (t) => [index("authenticity_verifications_version_idx").on(t.workspaceId, t.versionId)],
);
