/**
 * Site programmes module (`site`): pest control, the glass and brittle plastics register, planned
 * maintenance, storage temperature logging, and pre-start and allergen changeover checks.
 * See docs/modules.md and `@knotworking/core` site.ts.
 *
 * Records (visits, checks, maintenance records, storage readings, check results) are append-only:
 * no route updates or deletes them, except one-time stamps (a storage reading's review, a
 * maintenance record's hygiene clearance, a check's sign-off). A correction is a new row that
 * points at the one it corrects. Areas and maintained equipment are rows of the asset register
 * (`assets`; areas are kind `area`), which is why the module needs `assets`.
 */
import type {
  BreakageStatus,
  CcpLogReviewStatus,
  CheckItemResult,
  CheckOutcome,
  CheckSignOffStatus,
  ChecklistKind,
  DeviationReason,
  GlassCondition,
  GlassItemKind,
  GlassItemStatus,
  PestActivity,
  PestDeviceKind,
  ScheduleFrequencyUnit,
  SiteActionStatus,
  SiteSource,
  SiteStatus,
  StorageMeasure,
  StorageUnitKind,
  WorkOrderKind,
  WorkOrderPriority,
  WorkOrderStatus,
} from "@knotworking/core";
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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "../schema";
import { assets } from "./assets";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { productionBatches } from "./production";

const value = (name: string) => numeric(name, { precision: 14, scale: 4, mode: "number" });
const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: "number" });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });
const areaRef = (name = "area_id") => uuid(name).references(() => assets.id);

// ─── Pest control ────────────────────────────────────────────────────────────

/** A bait station, trap or fly killer. Archived, never deleted. */
export const sitePestDevices = pgTable(
  "site_pest_devices",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    kind: text("kind").$type<PestDeviceKind>().notNull(),
    /** The contractor's reference; unique among live devices. */
    code: text("code").notNull(),
    location: text("location").notNull(),
    areaId: areaRef(),
    status: text("status").$type<SiteStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("site_pest_devices_workspace_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * A contractor's visit. **Append-only**: a correction is a new visit with `corrects_visit_id`
 * (the findings are entered again with it).
 */
export const sitePestVisits = pgTable(
  "site_pest_visits",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    contractor: text("contractor").notNull(),
    technician: text("technician"),
    visitedOn: date("visited_on").notNull(),
    summary: text("summary"),
    recommendations: text("recommendations"),
    actionsTaken: text("actions_taken"),
    /** When the contractor is next due. What's due is computed from the latest visit. */
    nextVisitOn: date("next_visit_on"),
    source: text("source").$type<SiteSource>().notNull().default("manual"),
    recordedBy: userRef("recorded_by"),
    correctsVisitId: uuid("corrects_visit_id").references((): AnyPgColumn => sitePestVisits.id),
    correctionReason: text("correction_reason"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("site_pest_visits_workspace_idx").on(t.workspaceId, t.visitedOn),
    uniqueIndex("site_pest_visits_corrects_key")
      .on(t.correctsVisitId)
      .where(sql`${t.correctsVisitId} is not null`),
  ],
);

/** What a visit found at a device (or, with no device, at a place). Append-only with its visit. */
export const sitePestFindings = pgTable(
  "site_pest_findings",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    visitId: uuid("visit_id")
      .notNull()
      .references(() => sitePestVisits.id),
    deviceId: uuid("device_id").references(() => sitePestDevices.id),
    location: text("location"),
    activity: text("activity").$type<PestActivity>().notNull(),
    pest: text("pest"),
    count: integer("count"),
    note: text("note"),
    action: text("action"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("site_pest_findings_visit_idx").on(t.visitId),
    index("site_pest_findings_device_idx").on(t.deviceId),
  ],
);

// ─── Glass and brittle plastics ──────────────────────────────────────────────

/** An item in the register, by area. Removed (replaced or taken out), never deleted. */
export const siteGlassItems = pgTable(
  "site_glass_items",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    areaId: uuid("area_id")
      .notNull()
      .references(() => assets.id),
    kind: text("kind").$type<GlassItemKind>().notNull(),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    location: text("location"),
    checkEvery: integer("check_every").notNull(),
    checkUnit: text("check_unit").$type<ScheduleFrequencyUnit>().notNull(),
    status: text("status").$type<GlassItemStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [index("site_glass_items_workspace_idx").on(t.workspaceId, t.areaId)],
);

/** A periodic condition check of one item. **Append-only**; a correction points at the original. */
export const siteGlassChecks = pgTable(
  "site_glass_checks",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => siteGlassItems.id),
    /** Denormalised from the item: the area it was in when checked. */
    areaId: uuid("area_id")
      .notNull()
      .references(() => assets.id),
    condition: text("condition").$type<GlassCondition>().notNull(),
    note: text("note"),
    checkedAt: ts("checked_at").notNull(),
    recordedBy: userRef("recorded_by"),
    correctsCheckId: uuid("corrects_check_id").references((): AnyPgColumn => siteGlassChecks.id),
    correctionReason: text("correction_reason"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("site_glass_checks_item_idx").on(t.itemId, t.checkedAt),
    index("site_glass_checks_workspace_idx").on(t.workspaceId, t.checkedAt),
    uniqueIndex("site_glass_checks_corrects_key")
      .on(t.correctsCheckId)
      .where(sql`${t.correctsCheckId} is not null`),
  ],
);

/**
 * A breakage incident. Open from the moment it is raised (the area is held) while the quarantine
 * and clean-down are recorded; released by a person with `manage` (the sign-off), after which it
 * never changes.
 */
export const siteGlassBreakages = pgTable(
  "site_glass_breakages",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    areaId: uuid("area_id")
      .notNull()
      .references(() => assets.id),
    itemId: uuid("item_id").references(() => siteGlassItems.id),
    occurredAt: ts("occurred_at").notNull(),
    description: text("description").notNull(),
    /** What was quarantined. */
    quarantined: text("quarantined").notNull(),
    cleanDown: text("clean_down"),
    cleanDownAt: ts("clean_down_at"),
    cleanDownBy: userRef("clean_down_by"),
    status: text("status").$type<BreakageStatus>().notNull().default("open"),
    source: text("source").$type<SiteSource>().notNull().default("manual"),
    raisedBy: userRef("raised_by"),
    updatedBy: userRef("updated_by"),
    /** The sign-off. */
    releasedAt: ts("released_at"),
    releasedBy: userRef("released_by"),
    releaseNote: text("release_note"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("site_glass_breakages_workspace_idx").on(t.workspaceId, t.status, t.occurredAt)],
);

// ─── Planned maintenance ─────────────────────────────────────────────────────

/**
 * Site's part of an asset of the register: the instrument of the HACCP calibration register this
 * maintained asset is, if any (a reference only: HACCP's records are read, never written, from
 * here). One row per asset, keyed by the asset's id; an asset without a row has no link. Maintenance
 * tasks, records and work orders point at the asset itself (`assets`).
 */
export const siteAssets = pgTable("site_assets", {
  id: uuid("id")
    .primaryKey()
    .references(() => assets.id),
  workspaceId: workspaceRef(),
  calibrationInstrumentId: uuid("calibration_instrument_id").references(() => assets.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** A recurring maintenance task on an asset. Archived, never deleted. */
export const siteMaintenanceTasks = pgTable(
  "site_maintenance_tasks",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    title: text("title").notNull(),
    description: text("description"),
    frequencyEvery: integer("frequency_every").notNull(),
    frequencyUnit: text("frequency_unit").$type<ScheduleFrequencyUnit>().notNull(),
    startOn: date("start_on"),
    /** Work in a production area: the area needs a hygiene clearance before it restarts. */
    clearanceRequired: boolean("clearance_required").notNull().default(false),
    status: text("status").$type<SiteStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [index("site_maintenance_tasks_asset_idx").on(t.assetId)],
);

/**
 * Maintenance done. **Append-only**, except the one-time hygiene clearance stamp. `clearance_required`
 * is copied from the task when written; a correction is a new row that needs its own clearance.
 */
export const siteMaintenanceRecords = pgTable(
  "site_maintenance_records",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => siteMaintenanceTasks.id),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    /** The asset's area when the work was done. */
    areaId: areaRef(),
    completedAt: ts("completed_at").notNull(),
    doneBy: userRef("done_by"),
    contractor: text("contractor"),
    workDone: text("work_done"),
    nextDueOn: date("next_due_on").notNull(),
    note: text("note"),
    clearanceRequired: boolean("clearance_required").notNull().default(false),
    /** The sign-off: the area is safe to restart. */
    clearedAt: ts("cleared_at"),
    clearedBy: userRef("cleared_by"),
    clearanceNote: text("clearance_note"),
    recordedBy: userRef("recorded_by"),
    correctsRecordId: uuid("corrects_record_id").references((): AnyPgColumn => siteMaintenanceRecords.id),
    correctionReason: text("correction_reason"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("site_maintenance_records_task_idx").on(t.taskId, t.completedAt),
    index("site_maintenance_records_workspace_idx").on(t.workspaceId, t.completedAt),
    uniqueIndex("site_maintenance_records_corrects_key")
      .on(t.correctsRecordId)
      .where(sql`${t.correctsRecordId} is not null`),
  ],
);

/**
 * A breakdown or work request on a maintained asset. Open (requested, in progress) it can change;
 * completed or cancelled it never does. The completion is a person's attestation.
 */
export const siteWorkOrders = pgTable(
  "site_work_orders",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    /** The planned task this is about, if any. */
    taskId: uuid("task_id").references(() => siteMaintenanceTasks.id),
    /** The asset's area when raised. */
    areaId: areaRef(),
    kind: text("kind").$type<WorkOrderKind>().notNull().default("breakdown"),
    title: text("title").notNull(),
    description: text("description"),
    priority: text("priority").$type<WorkOrderPriority>().notNull().default("medium"),
    stopsProduction: boolean("stops_production").notNull().default(false),
    status: text("status").$type<WorkOrderStatus>().notNull().default("requested"),
    source: text("source").$type<SiteSource>().notNull().default("manual"),
    requestedBy: userRef("requested_by"),
    assignedTo: userRef("assigned_to"),
    contractor: text("contractor"),
    startedAt: ts("started_at"),
    /** Completion: what was done, by whom, spares and costs. */
    completedAt: ts("completed_at"),
    completedBy: userRef("completed_by"),
    doneBy: userRef("done_by"),
    workDone: text("work_done"),
    downtimeMinutes: integer("downtime_minutes"),
    sparesUsed: text("spares_used"),
    partsCost: money("parts_cost"),
    labourCost: money("labour_cost"),
    contractorCost: money("contractor_cost"),
    cancelledAt: ts("cancelled_at"),
    cancelledBy: userRef("cancelled_by"),
    cancelReason: text("cancel_reason"),
    updatedBy: userRef("updated_by"),
    ...timestamps(),
  },
  (t) => [
    index("site_work_orders_workspace_idx").on(t.workspaceId, t.status, t.createdAt),
    index("site_work_orders_asset_idx").on(t.assetId),
  ],
);

// ─── Storage temperatures ────────────────────────────────────────────────────

/** A chiller, freezer or ambient store with its limits. Archived, never deleted. */
export const siteStorageUnits = pgTable(
  "site_storage_units",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    code: text("code"),
    name: text("name").notNull(),
    kind: text("kind").$type<StorageUnitKind>().notNull(),
    /** What is read: temperature (default), humidity, pressure or another measure. */
    measure: text("measure").$type<StorageMeasure>().notNull().default("temperature"),
    location: text("location"),
    areaId: areaRef(),
    limitMin: value("limit_min"),
    limitMax: value("limit_max"),
    unit: text("unit").notNull().default("°C"),
    readingEvery: integer("reading_every").notNull(),
    readingUnit: text("reading_unit").$type<ScheduleFrequencyUnit>().notNull(),
    status: text("status").$type<SiteStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    index("site_storage_units_workspace_idx").on(t.workspaceId, t.name),
    uniqueIndex("site_storage_units_workspace_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null and ${t.code} is not null`),
  ],
);

/**
 * A storage reading. **Append-only**, except the one-time review stamp on a reading an API token
 * recorded (the same pattern as HACCP's CCP logs). The limits and unit are copied from the unit
 * when written, so changing a unit's limits later doesn't rewrite history.
 */
export const siteStorageReadings = pgTable(
  "site_storage_readings",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => siteStorageUnits.id),
    value: value("value").notNull(),
    limitMin: value("limit_min"),
    limitMax: value("limit_max"),
    unit: text("unit").notNull(),
    withinLimits: boolean("within_limits").notNull(),
    deviationReason: text("deviation_reason").$type<DeviationReason>(),
    note: text("note"),
    source: text("source").$type<SiteSource>().notNull().default("manual"),
    checkedAt: ts("checked_at").notNull(),
    recordedBy: userRef("recorded_by"),
    correctsReadingId: uuid("corrects_reading_id").references((): AnyPgColumn => siteStorageReadings.id),
    correctionReason: text("correction_reason"),
    reviewStatus: text("review_status").$type<CcpLogReviewStatus>().notNull().default("pending"),
    reviewedBy: userRef("reviewed_by"),
    reviewedAt: ts("reviewed_at"),
    reviewNote: text("review_note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("site_storage_readings_unit_idx").on(t.unitId, t.checkedAt),
    index("site_storage_readings_workspace_idx").on(t.workspaceId, t.checkedAt),
    index("site_storage_readings_pending_idx")
      .on(t.workspaceId, t.checkedAt)
      .where(sql`${t.reviewStatus} = 'pending'`),
    uniqueIndex("site_storage_readings_corrects_key")
      .on(t.correctsReadingId)
      .where(sql`${t.correctsReadingId} is not null`),
  ],
);

/**
 * A corrective action on a storage excursion (or raised by a person or an agent). Open while it is
 * worked on; closed by a person with `manage`, after which it never changes.
 */
export const siteCorrectiveActions = pgTable(
  "site_corrective_actions",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    title: text("title").notNull(),
    readingId: uuid("reading_id").references(() => siteStorageReadings.id),
    actionTaken: text("action_taken"),
    rootCause: text("root_cause"),
    preventiveAction: text("preventive_action"),
    status: text("status").$type<SiteActionStatus>().notNull().default("open"),
    source: text("source").$type<SiteSource>().notNull().default("manual"),
    raisedBy: userRef("raised_by"),
    updatedBy: userRef("updated_by"),
    /** The sign-off. */
    closedAt: ts("closed_at"),
    closedBy: userRef("closed_by"),
    closureNote: text("closure_note"),
    ...timestamps(),
  },
  (t) => [
    index("site_corrective_actions_workspace_idx").on(t.workspaceId, t.status, t.createdAt),
    index("site_corrective_actions_reading_idx").on(t.readingId),
  ],
);

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
