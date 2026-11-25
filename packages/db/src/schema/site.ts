/**
 * Site programmes module (`site`): pest control, the glass and brittle plastics register,
 * and storage temperature logging. Site checklists share the checklist schema.
 * See docs/modules.md and `@knotworking/core` site.ts.
 *
 * Records (visits, glass checks and storage readings) are append-only:
 * no route updates or deletes them, except one-time stamps (a storage reading's review). A correction is a new row that
 * points at the one it corrects. Areas are rows of the asset register
 * (`assets`; areas are kind `area`), which is why the module needs `assets`.
 */
import type {
  BreakageStatus,
  CcpLogReviewStatus,
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

const value = (name: string) => numeric(name, { precision: 14, scale: 4, mode: "number" });
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
