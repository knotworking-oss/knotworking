/**
 * Production module: batches and their append-only batch records.
 * See docs/modules.md and `@knotworking/core` production.ts.
 *
 * A batch pins the approved recipe version it is made to. Its records link the lots it consumed
 * and produced to the stock movements they posted, which is what lot tracing follows.
 */
import type {
  DowntimeReason,
  PackingCheckKind,
  PackingLabelSummary,
  PackingReconciliationLine,
  PackingRunStatus,
  PackingSpecificationSummary,
  ProductionBatchStatus,
  RejectReason,
  ProductionRecordKind,
  ReservationReleaseReason,
  ReservationStatus,
} from "@knotworking/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { items } from "./items";
import { productLabels } from "./labels";
import { specificationVersions } from "./specifications";
import { recipes, recipeVersions } from "./recipes";
import { stockLocations, stockLots, stockMovements } from "./stock";

/**
 * A production line (a mixer and oven, a packing line): where batches are made and the hours a
 * day it can run. Deactivated, never deleted.
 */
export const productionLines = pgTable(
  "production_lines",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    /** Hours of production per day: the capacity the schedule loads against. */
    hoursPerDay: numeric("hours_per_day", { precision: 5, scale: 2, mode: "number" }).notNull().default(8),
    /** Minutes to change between recipes when no changeover rule applies (3.5.1). */
    changeoverMinutes: integer("changeover_minutes").notNull().default(0),
    /** Minutes an allergen clean-down takes; the longer of this and the changeover applies. */
    allergenCleanMinutes: integer("allergen_clean_minutes").notNull().default(0),
    /** People who can work the line at once; null: not limited. */
    crewAvailable: integer("crew_available"),
    active: boolean("active").notNull().default(true),
    notes: text("notes"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("production_lines_workspace_name_key")
      .on(t.workspaceId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * A recipe a line can make, with its rate: how much output the line makes per hour, in the
 * output item's base unit (g, ml or each). Removing it soft-deletes the row.
 */
export const productionLineRecipes = pgTable(
  "production_line_recipes",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    lineId: uuid("line_id")
      .notNull()
      .references(() => productionLines.id),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipes.id),
    ratePerHour: numeric("rate_per_hour", { precision: 18, scale: 4, mode: "number" }).notNull(),
    /** People the line needs to make the recipe; null: not set. */
    crewSize: integer("crew_size"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("production_line_recipes_line_recipe_key")
      .on(t.lineId, t.recipeId)
      .where(sql`${t.deletedAt} is null`),
    index("production_line_recipes_recipe_idx").on(t.recipeId),
  ],
);

/**
 * A planned or recorded production batch. Size is stored once, as the planned output in the
 * output item's base unit; the number of batches is derived from the pinned version's yield.
 * Completing it is a sign-off (who and when); after that only reversals reference its records.
 */
export const productionBatches = pgTable(
  "production_batches",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** Unique among live batches, case-insensitively. Default lot code of what it produces. */
    batchCode: text("batch_code").notNull(),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipes.id),
    /** The approved version the batch is made to: answers "which batches used which version". */
    recipeVersionId: uuid("recipe_version_id")
      .notNull()
      .references(() => recipeVersions.id),
    /** Denormalised from the recipe: the item the batch makes. */
    outputItemId: uuid("output_item_id")
      .notNull()
      .references(() => items.id),
    plannedOn: date("planned_on").notNull(),
    /** The line it is made on (capacity scheduling); optional. */
    lineId: uuid("line_id").references(() => productionLines.id),
    /** Order on its line's day (1 first), set by applying a sequence; null: unordered, after the rest. */
    sequence: integer("sequence"),
    /** Planned output in the output item's base unit (g, ml or each). */
    plannedQuantity: numeric("planned_quantity", { precision: 18, scale: 4, mode: "number" }).notNull(),
    outputLocationId: uuid("output_location_id").references(() => stockLocations.id),
    status: text("status").$type<ProductionBatchStatus>().notNull().default("planned"),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: ts("started_at"),
    startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
    /** The sign-off. */
    completedAt: ts("completed_at"),
    completedBy: uuid("completed_by").references(() => users.id, { onDelete: "set null" }),
    completionNote: text("completion_note"),
    cancelledAt: ts("cancelled_at"),
    cancelledBy: uuid("cancelled_by").references(() => users.id, { onDelete: "set null" }),
    cancelReason: text("cancel_reason"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("production_batches_workspace_code_key")
      .on(t.workspaceId, sql`lower(${t.batchCode})`)
      .where(sql`${t.deletedAt} is null`),
    index("production_batches_workspace_planned_idx").on(t.workspaceId, t.plannedOn),
    index("production_batches_version_idx").on(t.recipeVersionId),
    index("production_batches_recipe_idx").on(t.recipeId),
    index("production_batches_line_idx").on(t.lineId, t.plannedOn),
  ],
);

/**
 * A batch record line. **Append-only**: never updated or deleted. Each row posted one stock
 * movement (`consumption` out of a lot, or `production` into the produced lot). A correction is
 * a new row with the opposite quantity that points at the one it corrects.
 */
export const productionRecords = pgTable(
  "production_records",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => productionBatches.id),
    kind: text("kind").$type<ProductionRecordKind>().notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => stockLots.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => stockLocations.id),
    /** Consumed or produced, in the item's base unit: positive, negative on a reversal. */
    quantity: numeric("quantity", { precision: 18, scale: 4, mode: "number" }).notNull(),
    /** The ledger row this record posted. */
    movementId: uuid("movement_id")
      .notNull()
      .references(() => stockMovements.id),
    reversesRecordId: uuid("reverses_record_id").references((): AnyPgColumn => productionRecords.id),
    note: text("note"),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("production_records_batch_idx").on(t.batchId, t.occurredAt),
    /** Tracing: which batches consumed or produced a lot. */
    index("production_records_lot_idx").on(t.lotId, t.kind),
    uniqueIndex("production_records_movement_key").on(t.movementId),
    /** A record can be reversed once. */
    uniqueIndex("production_records_reverses_key")
      .on(t.reversesRecordId)
      .where(sql`${t.reversesRecordId} is not null`),
  ],
);

/**
 * Stock set aside for a batch: a quantity of one lot (base unit). Available stock is on hand minus
 * what is reserved. Consumption fulfils it (`fulfilledQuantity`); the rest is released when the
 * batch completes or is cancelled, or by hand. A released row stays as the history; consumption
 * never needs a reservation.
 */
export const productionReservations = pgTable(
  "production_reservations",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => productionBatches.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => stockLots.id),
    /** Set: the reservation is of the lot's balance at this location; null: of the lot as a whole. */
    locationId: uuid("location_id").references(() => stockLocations.id),
    /** Reserved, in the item's base unit. */
    quantity: numeric("quantity", { precision: 18, scale: 4, mode: "number" }).notNull(),
    /** How much of it the batch has consumed so far. */
    fulfilledQuantity: numeric("fulfilled_quantity", { precision: 18, scale: 4, mode: "number" })
      .notNull()
      .default(0),
    status: text("status").$type<ReservationStatus>().notNull().default("active"),
    /** The last day it holds; released (reason `expired`) after it. Null: until released. */
    expiresOn: date("expires_on"),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    releasedAt: ts("released_at"),
    releasedBy: uuid("released_by").references(() => users.id, { onDelete: "set null" }),
    releaseReason: text("release_reason").$type<ReservationReleaseReason>(),
    releaseNote: text("release_note"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("production_reservations_batch_idx").on(t.batchId, t.status),
    index("production_reservations_lot_idx").on(t.lotId, t.status),
    index("production_reservations_workspace_idx").on(t.workspaceId, t.status, t.itemId),
  ],
);

/**
 * A day the workspace (`line_id` null) or one production line does not produce: a bank holiday, a
 * shutdown, a line down. Advisory: planning and the cover view warn about it. Removing one
 * soft-deletes the row.
 */
export const productionNonWorkingDays = pgTable(
  "production_non_working_days",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    date: date("date").notNull(),
    lineId: uuid("line_id").references(() => productionLines.id),
    reason: text("reason"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("production_non_working_days_key")
      .on(t.workspaceId, t.date, sql`coalesce(${t.lineId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
      .where(sql`${t.deletedAt} is null`),
    index("production_non_working_days_date_idx").on(t.workspaceId, t.date),
  ],
);

/**
 * A shift window of a production line (3.5.1): the weekdays it starts on and its times in minutes
 * from midnight. `end_minute` is after `start_minute`, past 1440 when it crosses midnight. With any
 * shifts, the line's capacity on a day is the length of that day's windows. Replaced as a set.
 */
export const productionLineShifts = pgTable(
  "production_line_shifts",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    lineId: uuid("line_id")
      .notNull()
      .references(() => productionLines.id),
    name: text("name").notNull(),
    weekdays: jsonb("weekdays").$type<number[]>().notNull(),
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    ...timestamps(),
  },
  (t) => [index("production_line_shifts_line_idx").on(t.lineId)],
);

/**
 * Minutes to change a line from one recipe to another (3.5.1). A null side means any recipe; the
 * most specific rule wins. Replaced as a set.
 */
export const productionChangeovers = pgTable(
  "production_changeovers",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    lineId: uuid("line_id")
      .notNull()
      .references(() => productionLines.id),
    fromRecipeId: uuid("from_recipe_id").references(() => recipes.id),
    toRecipeId: uuid("to_recipe_id").references(() => recipes.id),
    minutes: integer("minutes").notNull(),
    note: text("note"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("production_changeovers_pair_key")
      .on(
        t.lineId,
        sql`coalesce(${t.fromRecipeId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`coalesce(${t.toRecipeId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`${t.deletedAt} is null`),
  ],
);

const voidColumns = () => ({
  voidedAt: ts("voided_at"),
  voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
  voidReason: text("void_reason"),
});

/**
 * Time a line didn't run on a production day (3.5.2), with its reason: planned reasons reduce
 * planned production time, unplanned ones availability. Append-only: a mistake is voided with a
 * reason and stays as history.
 */
export const productionDowntime = pgTable(
  "production_downtime",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    lineId: uuid("line_id")
      .notNull()
      .references(() => productionLines.id),
    batchId: uuid("batch_id").references(() => productionBatches.id),
    occurredOn: date("occurred_on").notNull(),
    minutes: integer("minutes").notNull(),
    reason: text("reason").$type<DowntimeReason>().notNull(),
    note: text("note"),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    ...voidColumns(),
  },
  (t) => [
    index("production_downtime_line_idx").on(t.workspaceId, t.lineId, t.occurredOn),
    index("production_downtime_batch_idx").on(t.batchId),
  ],
);

/**
 * Output a batch rejected (scrap), in the output item's base unit, with its reason (3.5.2). Never
 * put into stock. Append-only: voided with a reason.
 */
export const productionRejects = pgTable(
  "production_rejects",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => productionBatches.id),
    quantity: numeric("quantity", { precision: 18, scale: 4, mode: "number" }).notNull(),
    reason: text("reason").$type<RejectReason>().notNull(),
    note: text("note"),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    ...voidColumns(),
  },
  (t) => [index("production_rejects_batch_idx").on(t.batchId)],
);

/**
 * Actual labour on a batch (3.5.2): so many people for so many minutes. Append-only: voided with
 * a reason.
 */
export const productionLabour = pgTable(
  "production_labour",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => productionBatches.id),
    people: integer("people").notNull(),
    minutes: integer("minutes").notNull(),
    note: text("note"),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    ...voidColumns(),
  },
  (t) => [index("production_labour_batch_idx").on(t.batchId)],
);

/**
 * Packing a batch (3.5.3): the approved product label (and optionally specification version) its
 * packs carry, the codes they must show, and at close the packaging reconciliation. One open run
 * per batch at a time; a closed run never changes.
 */
export const productionPackingRuns = pgTable(
  "production_packing_runs",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => productionBatches.id),
    /** The approved label pinned; null when the labels module isn't used. */
    labelId: uuid("label_id").references(() => productLabels.id),
    /** Copied when opened, so the record reads without the labels module. */
    labelSummary: jsonb("label_summary").$type<PackingLabelSummary>(),
    specificationVersionId: uuid("specification_version_id").references(() => specificationVersions.id),
    specificationSummary: jsonb("specification_summary").$type<PackingSpecificationSummary>(),
    nominalQuantity: numeric("nominal_quantity", { precision: 12, scale: 3, mode: "number" }),
    expectedDateCode: text("expected_date_code").notNull(),
    expectedLotCode: text("expected_lot_code").notNull(),
    detectorRequired: boolean("detector_required").notNull().default(true),
    status: text("status").$type<PackingRunStatus>().notNull().default("open"),
    note: text("note"),
    openedBy: uuid("opened_by").references(() => users.id, { onDelete: "set null" }),
    openedAt: ts("opened_at").notNull().defaultNow(),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    closedAt: ts("closed_at"),
    packsProduced: integer("packs_produced"),
    reconciliation: jsonb("reconciliation").$type<PackingReconciliationLine[]>(),
    varianceReason: text("variance_reason"),
    closeNote: text("close_note"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("production_packing_runs_batch_idx").on(t.batchId),
    uniqueIndex("production_packing_runs_open_key")
      .on(t.batchId)
      .where(sql`${t.status} = 'open'`),
  ],
);

/**
 * A packing check (3.5.3): what was entered (`details`), whether it passed and why not, and what
 * was done about a failure. Append-only: voided with a reason.
 */
export const productionPackingChecks = pgTable(
  "production_packing_checks",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    runId: uuid("run_id")
      .notNull()
      .references(() => productionPackingRuns.id),
    kind: text("kind").$type<PackingCheckKind>().notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull(),
    passed: boolean("passed").notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    failureAction: text("failure_action"),
    note: text("note"),
    checkedAt: ts("checked_at").notNull().defaultNow(),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    ...voidColumns(),
  },
  (t) => [index("production_packing_checks_run_idx").on(t.runId, t.checkedAt)],
);
