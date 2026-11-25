/** Maintenance schedules, completed records and work orders. Table names are retained for upgrades. */
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

const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: "number" });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });
const areaRef = (name = "area_id") => uuid(name).references(() => assets.id);

// ─── Planned maintenance ─────────────────────────────────────────────────────

/**
 * Optional link from a maintained asset to its HACCP calibration instrument. Maintenance tasks,
 * records and work orders reference the asset directly.
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
    /** Require clearance before the asset returns to use. */
    clearanceRequired: boolean("clearance_required").notNull().default(false),
    status: text("status").$type<SiteStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [index("site_maintenance_tasks_asset_idx").on(t.assetId)],
);

/**
 * Maintenance done. **Append-only**, except the one-time return-to-service clearance stamp. `clearance_required`
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
