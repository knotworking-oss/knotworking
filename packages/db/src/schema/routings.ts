/**
 * Routings module (`routings`): work centres, versioned routings of ordered operations for a bill
 * of materials (a recipe), and job cards per operation of a production batch.
 * See docs/modules.md and `@knotworking/core` routings.ts.
 *
 * Production keeps the ledger: materials and output posted from a job card are ordinary batch
 * records, linked here (`job_card_records`) so a card shows what it used and made.
 */
import type {
  JobCardExceptionKind,
  JobCardExceptionStatus,
  JobCardStatus,
  RoutingStatus,
  RoutingVersionStatus,
  WorkCentreStatus,
} from "@knotworking/core";
import { sql } from "drizzle-orm";
import { check, index, integer, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { productionBatches, productionRecords } from "./production";
import { recipes } from "./recipes";

/** Where an operation is done: a cell, a machine, a bench. Archived, never deleted. */
export const workCentres = pgTable(
  "work_centres",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** Unique among live work centres, case-insensitively. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Hours a day each station can work. */
    hoursPerDay: numeric("hours_per_day", { precision: 5, scale: 2, mode: "number" }).notNull().default(8),
    /** Stations (machines, benches, people) that can work at once. */
    stations: integer("stations").notNull().default(1),
    /** Cost of an hour of work here (labour and machine), in the workspace currency. */
    costPerHour: numeric("cost_per_hour", { precision: 14, scale: 4, mode: "number" }).notNull().default(0),
    notes: text("notes"),
    status: text("status").$type<WorkCentreStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("work_centres_workspace_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null`),
    check("work_centres_stations_check", sql`${t.stations} >= 1`),
  ],
);

/** A bill of materials' routing. The operations live in versions; this row is the identity. */
export const routings = pgTable(
  "routings",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** The bill of materials it makes: one live routing per bill. */
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipes.id),
    description: text("description"),
    status: text("status").$type<RoutingStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("routings_workspace_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex("routings_recipe_key")
      .on(t.recipeId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * One version of a routing. At most one draft (the only editable version) and one approved per
 * routing; approving a draft supersedes the approved one. Approved and superseded never change.
 */
export const routingVersions = pgTable(
  "routing_versions",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    routingId: uuid("routing_id")
      .notNull()
      .references(() => routings.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    status: text("status").$type<RoutingVersionStatus>().notNull().default("draft"),
    changeNote: text("change_note"),
    approvedAt: ts("approved_at"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("routing_versions_number_key").on(t.routingId, t.versionNumber),
    uniqueIndex("routing_versions_one_draft_key")
      .on(t.routingId)
      .where(sql`${t.status} = 'draft' and ${t.deletedAt} is null`),
    uniqueIndex("routing_versions_one_approved_key")
      .on(t.routingId)
      .where(sql`${t.status} = 'approved' and ${t.deletedAt} is null`),
  ],
);

/** An operation of a version, in order (`position` 1 first). */
export const routingOperations = pgTable(
  "routing_operations",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => routingVersions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    workCentreId: uuid("work_centre_id")
      .notNull()
      .references(() => workCentres.id),
    /** Minutes to set up, once per batch. */
    setupMinutes: numeric("setup_minutes", { precision: 10, scale: 2, mode: "number" }).notNull().default(0),
    /** Minutes to run one batch of the bill's yield. */
    runMinutes: numeric("run_minutes", { precision: 10, scale: 2, mode: "number" }).notNull().default(0),
    instructions: text("instructions"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("routing_operations_position_key").on(t.versionId, t.position),
    index("routing_operations_work_centre_idx").on(t.workCentreId),
  ],
);

/**
 * One operation of a production batch, made from the approved routing version. What it expects
 * (minutes, the work centre's cost rate) is copied when it is made, so a later routing or rate
 * change never rewrites a card. Good and scrap are summed from `job_card_quantities`.
 */
export const jobCards = pgTable(
  "job_cards",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => productionBatches.id),
    routingVersionId: uuid("routing_version_id")
      .notNull()
      .references(() => routingVersions.id),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => routingOperations.id),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    workCentreId: uuid("work_centre_id")
      .notNull()
      .references(() => workCentres.id),
    /** The batch's planned output when the card was made, base unit. */
    plannedQuantity: numeric("planned_quantity", { precision: 18, scale: 4, mode: "number" }).notNull(),
    expectedSetupMinutes: numeric("expected_setup_minutes", { precision: 12, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    expectedRunMinutes: numeric("expected_run_minutes", { precision: 12, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    /** The work centre's rate when the card was made. */
    costPerHour: numeric("cost_per_hour", { precision: 14, scale: 4, mode: "number" }).notNull().default(0),
    status: text("status").$type<JobCardStatus>().notNull().default("pending"),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    completedBy: uuid("completed_by").references(() => users.id, { onDelete: "set null" }),
    completionNote: text("completion_note"),
    cancelledAt: ts("cancelled_at"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("job_cards_batch_position_key")
      .on(t.batchId, t.position)
      .where(sql`${t.status} <> 'cancelled' and ${t.deletedAt} is null`),
    index("job_cards_workspace_status_idx").on(t.workspaceId, t.status),
    index("job_cards_work_centre_idx").on(t.workCentreId, t.status),
  ],
);

const voidColumns = () => ({
  voidedAt: ts("voided_at"),
  voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
  voidReason: text("void_reason"),
});

/**
 * Time worked on a job card: a running timer (`ended_at` null) or a finished log (`minutes` set).
 * One running timer per person per card. Append-only: a mistake is voided with a reason.
 */
export const jobCardTimeLogs = pgTable(
  "job_card_time_logs",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    jobCardId: uuid("job_card_id")
      .notNull()
      .references(() => jobCards.id),
    /** Who worked. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    startedAt: ts("started_at").notNull(),
    endedAt: ts("ended_at"),
    minutes: integer("minutes"),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
    ...voidColumns(),
  },
  (t) => [
    index("job_card_time_logs_card_idx").on(t.jobCardId),
    uniqueIndex("job_card_time_logs_running_key")
      .on(t.jobCardId, t.userId)
      .where(sql`${t.endedAt} is null and ${t.voidedAt} is null`),
    check("job_card_time_logs_minutes_check", sql`${t.minutes} is null or ${t.minutes} >= 0`),
  ],
);

/** Good and scrap an operation reported, base unit. Append-only: voided with a reason. */
export const jobCardQuantities = pgTable(
  "job_card_quantities",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    jobCardId: uuid("job_card_id")
      .notNull()
      .references(() => jobCards.id),
    good: numeric("good", { precision: 18, scale: 4, mode: "number" }).notNull().default(0),
    scrap: numeric("scrap", { precision: 18, scale: 4, mode: "number" }).notNull().default(0),
    scrapReason: text("scrap_reason"),
    note: text("note"),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    ...voidColumns(),
  },
  (t) => [
    index("job_card_quantities_card_idx").on(t.jobCardId),
    check("job_card_quantities_non_negative_check", sql`${t.good} >= 0 and ${t.scrap} >= 0`),
  ],
);

/** Something that went wrong at an operation. An open exception blocks completing the card. */
export const jobCardExceptions = pgTable(
  "job_card_exceptions",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    jobCardId: uuid("job_card_id")
      .notNull()
      .references(() => jobCards.id),
    kind: text("kind").$type<JobCardExceptionKind>().notNull(),
    description: text("description").notNull(),
    status: text("status").$type<JobCardExceptionStatus>().notNull().default("open"),
    raisedBy: uuid("raised_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    resolvedAt: ts("resolved_at"),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolution: text("resolution"),
  },
  (t) => [index("job_card_exceptions_card_idx").on(t.jobCardId, t.status)],
);

/** A batch record (consumption or output) posted from a job card. */
export const jobCardRecords = pgTable(
  "job_card_records",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    jobCardId: uuid("job_card_id")
      .notNull()
      .references(() => jobCards.id),
    productionRecordId: uuid("production_record_id")
      .notNull()
      .references(() => productionRecords.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("job_card_records_card_idx").on(t.jobCardId),
    uniqueIndex("job_card_records_record_key").on(t.productionRecordId),
  ],
);
