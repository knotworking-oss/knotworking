/** Shared checklist templates and history. The original table names preserve existing records. */
import type {
  CheckItemResult,
  ChecklistActionStatus,
  ChecklistKind,
  CheckOutcome,
  CheckSignOffStatus,
  ScheduleFrequencyUnit,
  SiteStatus,
} from "@knotworking/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "../schema";
import { assets } from "./assets";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { productionBatches } from "./production";

const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });
const areaRef = (name = "area_id") => uuid(name).references(() => assets.id);

// ─── Pre-start and allergen changeover checks ────────────────────────────────

/** A checklist for a line or area. Archived, never deleted. Its items are in `site_checklist_items`. */
export const siteChecklistTemplates = pgTable(
  "site_checklist_templates",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    kind: text("kind").$type<ChecklistKind>().notNull(),
    areaId: areaRef(),
    line: text("line"),
    frequencyEvery: integer("frequency_every"),
    frequencyUnit: text("frequency_unit").$type<ScheduleFrequencyUnit>(),
    duringProduction: boolean("during_production").notNull().default(false),
    status: text("status").$type<SiteStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [index("site_checklist_templates_workspace_idx").on(t.workspaceId, t.name)],
);

/** An item of a checklist. Removing one from the template deletes it softly; past checks keep its wording. */
export const siteChecklistItems = pgTable(
  "site_checklist_items",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => siteChecklistTemplates.id),
    sortOrder: integer("sort_order").notNull().default(0),
    prompt: text("prompt").notNull(),
    guidance: text("guidance"),
    ...timestamps(),
  },
  (t) => [index("site_checklist_items_template_idx").on(t.templateId, t.sortOrder)],
);

/**
 * A completed check. **Append-only**, except the one-time sign-off stamp. The template's name,
 * kind, area and line are copied when written. A correction is a new check with
 * `corrects_check_id`.
 */
export const siteChecklistChecks = pgTable(
  "site_checklist_checks",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => siteChecklistTemplates.id),
    templateName: text("template_name").notNull(),
    kind: text("kind").$type<ChecklistKind>().notNull(),
    areaId: areaRef(),
    line: text("line"),
    performedAt: ts("performed_at").notNull(),
    performedBy: userRef("performed_by"),
    outcome: text("outcome").$type<CheckOutcome>().notNull(),
    note: text("note"),
    /** Allergen changeover: the batch that ran before and the one that follows. */
    previousBatchId: uuid("previous_batch_id").references(() => productionBatches.id),
    nextBatchId: uuid("next_batch_id").references(() => productionBatches.id),
    /** The sign-off before production starts. */
    signOffStatus: text("sign_off_status").$type<CheckSignOffStatus>().notNull().default("pending"),
    signedOffBy: userRef("signed_off_by"),
    signedOffAt: ts("signed_off_at"),
    signOffNote: text("sign_off_note"),
    correctsCheckId: uuid("corrects_check_id").references((): AnyPgColumn => siteChecklistChecks.id),
    correctionReason: text("correction_reason"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("site_checklist_checks_template_idx").on(t.templateId, t.performedAt),
    index("site_checklist_checks_workspace_idx").on(t.workspaceId, t.performedAt),
    index("site_checklist_checks_pending_idx")
      .on(t.workspaceId, t.performedAt)
      .where(sql`${t.signOffStatus} = 'pending'`),
    uniqueIndex("site_checklist_checks_corrects_key")
      .on(t.correctsCheckId)
      .where(sql`${t.correctsCheckId} is not null`),
  ],
);

/** One item's result in a check, with the wording it was done against. Append-only with its check. */
export const siteChecklistCheckItems = pgTable(
  "site_checklist_check_items",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    checkId: uuid("check_id")
      .notNull()
      .references(() => siteChecklistChecks.id),
    itemId: uuid("item_id").references(() => siteChecklistItems.id),
    sortOrder: integer("sort_order").notNull().default(0),
    prompt: text("prompt").notNull(),
    result: text("result").$type<CheckItemResult>().notNull(),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("site_checklist_check_items_check_idx").on(t.checkId, t.sortOrder)],
);

/** An automatically raised follow-up for each failed general checklist result. */
export const checklistActions = pgTable(
  "checklist_actions",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    checkId: uuid("check_id")
      .notNull()
      .references(() => siteChecklistChecks.id),
    status: text("status").$type<ChecklistActionStatus>().notNull().default("open"),
    resolution: text("resolution"),
    resolvedBy: userRef("resolved_by"),
    resolvedAt: ts("resolved_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("checklist_actions_check_key").on(t.checkId),
    index("checklist_actions_workspace_idx").on(t.workspaceId, t.status, t.createdAt),
  ],
);
