/**
 * Stock module: locations, lots and an append-only movement ledger.
 * See docs/modules.md and `@knotworking/core` stock.ts.
 *
 * Balances are never stored: a lot's balance at a location is the sum of its movements there.
 */
import type {
  ExpiryType,
  LotStatus,
  StockLocationStatus,
  StockMovementType,
  StorageCondition,
  LotReleaseRule,
  ReleaseCheck,
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
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { items, suppliers } from "./items";

/** Where stock is kept: a store room, a chiller, a freezer, a production line. */
export const stockLocations = pgTable(
  "stock_locations",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    /** Short reference (e.g. "CH1"); unique among live locations when set. */
    code: text("code"),
    storage: text("storage").$type<StorageCondition>().notNull().default("ambient"),
    status: text("status").$type<StockLocationStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    index("stock_locations_workspace_idx").on(t.workspaceId, t.name),
    uniqueIndex("stock_locations_workspace_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null and ${t.code} is not null`),
  ],
);

/**
 * A lot (batch) of one item: what traceability follows. Goods-in creates it together with its
 * `receipt` movement. Its status is a QA decision (quarantine, release, reject) recorded with who
 * and when.
 */
export const stockLots = pgTable(
  "stock_lots",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    /** Our lot code; unique per item among live lots, case-insensitively. */
    lotCode: text("lot_code").notNull(),
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    /** The supplier's own batch code: one step back in the trace. */
    supplierLotCode: text("supplier_lot_code"),
    receivedOn: date("received_on").notNull(),
    expiresOn: date("expires_on"),
    expiryType: text("expiry_type").$type<ExpiryType>(),
    status: text("status").$type<LotStatus>().notNull().default("available"),
    statusChangedAt: ts("status_changed_at"),
    statusChangedBy: uuid("status_changed_by").references(() => users.id, { onDelete: "set null" }),
    statusNote: text("status_note"),
    notes: text("notes"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("stock_lots_item_code_key")
      .on(t.itemId, sql`lower(${t.lotCode})`)
      .where(sql`${t.deletedAt} is null`),
    index("stock_lots_workspace_item_idx").on(t.workspaceId, t.itemId),
    index("stock_lots_workspace_expiry_idx").on(t.workspaceId, t.expiresOn),
    /** Generated lot codes find the day's highest sequence by prefix (`lower(lot_code) like 'l261113-%'`). */
    index("stock_lots_workspace_code_prefix_idx").on(
      t.workspaceId,
      sql`lower(${t.lotCode}) text_pattern_ops`,
    ),
  ],
);

/**
 * The stock ledger. **Append-only**: rows are never updated or deleted. A correction is a new row
 * that points at the one it corrects (`reversesMovementId`). Quantities are signed and in the
 * item's base unit (g, ml or each).
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => stockLots.id),
    /** Denormalised from the lot, for item-level queries. */
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => stockLocations.id),
    quantity: numeric("quantity", { precision: 18, scale: 4, mode: "number" }).notNull(),
    type: text("type").$type<StockMovementType>().notNull(),
    reason: text("reason"),
    /** e.g. a delivery note number, or the reference shared by one stocktake's rows. */
    reference: text("reference"),
    /** Shared by the `transfer_out` and `transfer_in` rows of one transfer. */
    transferId: uuid("transfer_id"),
    reversesMovementId: uuid("reverses_movement_id").references((): AnyPgColumn => stockMovements.id),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  // References use the default `no action`: a lot, location or movement that the ledger names can't
  // be hard-deleted, while deleting a whole workspace still cascades through every table.
  (t) => [
    index("stock_movements_workspace_item_idx").on(t.workspaceId, t.itemId),
    index("stock_movements_lot_location_idx").on(t.lotId, t.locationId),
    index("stock_movements_workspace_occurred_idx").on(t.workspaceId, t.occurredAt),
    /** A movement can be reversed once. */
    uniqueIndex("stock_movements_reverses_key")
      .on(t.reversesMovementId)
      .where(sql`${t.reversesMovementId} is not null`),
  ],
);

/**
 * The balance of each lot at each location: the running sum of `stock_movements`, kept by the
 * `stock_balances_apply` trigger in the same statement that inserts a movement, so it cannot
 * drift from the ledger and every write path (the API, scripts, tests) is covered. Reads that
 * used to sum the whole ledger read this instead; its partial indexes cover only rows that hold
 * stock, so their cost follows the stock on hand, not the history. Rows are kept at zero (a lot
 * can come back with a reversal). Never written by the application: the ledger is the truth, and
 * `reconcileStockBalances` (`@knotworking/db`) can check this table against it.
 */
export const stockBalances = pgTable(
  "stock_balances",
  {
    lotId: uuid("lot_id")
      .notNull()
      .references(() => stockLots.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => stockLocations.id),
    workspaceId: workspaceRef(),
    /** Denormalised from the lot, for item-level queries. */
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    /** A sum can exceed one movement's precision; its scale comes from the ledger. */
    quantity: numeric("quantity", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.lotId, t.locationId] }),
    index("stock_balances_live_lot_idx")
      .on(t.workspaceId, t.lotId)
      .where(sql`${t.quantity} <> 0`),
    index("stock_balances_live_item_idx")
      .on(t.workspaceId, t.itemId)
      .where(sql`${t.quantity} <> 0`),
    index("stock_balances_live_location_idx")
      .on(t.locationId, t.lotId)
      .where(sql`${t.quantity} <> 0`),
  ],
);

/**
 * QA release rule per item (milestone 3.2.3): what must be true before one of its lots can be
 * released, beyond the checks that always apply. Versioned: every change bumps `version`, and each
 * release records the version it was checked against.
 */
export const lotReleaseRules = pgTable(
  "lot_release_rules",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    version: integer("version").notNull().default(1),
    requirePassingTest: boolean("require_passing_test").notNull().default(false),
    requiredAnalytes: jsonb("required_analytes").$type<string[]>().notNull().default([]),
    requireApprovedSpecification: boolean("require_approved_specification").notNull().default(false),
    requireCcpReviewed: boolean("require_ccp_reviewed").notNull().default(false),
    note: text("note"),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("lot_release_rules_item_key")
      .on(t.itemId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * Each release of a lot (to `available`), append-only: who, when, the rule version and the checks
 * as they stood, and, for an authorised exception, its reason and evidence.
 */
export const lotReleases = pgTable(
  "lot_releases",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => stockLots.id),
    releasedBy: uuid("released_by").references(() => users.id, { onDelete: "set null" }),
    releasedAt: ts("released_at").notNull().defaultNow(),
    /** The status it was released from. */
    fromStatus: text("from_status").$type<LotStatus>().notNull(),
    note: text("note").notNull(),
    ruleVersion: integer("rule_version"),
    rule: jsonb("rule").$type<LotReleaseRule | null>(),
    checks: jsonb("checks").$type<ReleaseCheck[]>().notNull(),
    exception: boolean("exception").notNull().default(false),
    exceptionReason: text("exception_reason"),
    exceptionEvidence: text("exception_evidence"),
    /** For an exception: the request it approved and who asked (`releasedBy` approved it). */
    exceptionRequestId: uuid("exception_request_id"),
    exceptionRequestedBy: uuid("exception_requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** The requester approved their own exception because nobody else had stock `manage`. */
    exceptionSelfApproved: boolean("exception_self_approved").notNull().default(false),
  },
  (t) => [index("lot_releases_lot_idx").on(t.lotId, t.releasedAt)],
);

export type LotReleaseExceptionStatus = "pending" | "approved" | "rejected" | "withdrawn" | "superseded";

/**
 * A request to release a blocked lot as an exception. One manager asks, with the reason and
 * evidence; a different one approves (which releases the lot) or rejects it. Pending requests are
 * one per lot. The checks it was asked against are kept, so an approval can't cover new blockers.
 */
export const lotReleaseExceptionRequests = pgTable(
  "lot_release_exception_requests",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => stockLots.id),
    status: text("status").$type<LotReleaseExceptionStatus>().notNull().default("pending"),
    note: text("note").notNull(),
    reason: text("reason").notNull(),
    evidence: text("evidence").notNull(),
    ruleVersion: integer("rule_version"),
    checks: jsonb("checks").$type<ReleaseCheck[]>().notNull(),
    /** The lot's status as it was asked for; a status change since makes the request stale. */
    lotStatus: text("lot_status").$type<LotStatus>().notNull(),
    lotStatusChangedAt: ts("lot_status_changed_at"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    requestedAt: ts("requested_at").notNull().defaultNow(),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: ts("decided_at"),
    decisionNote: text("decision_note"),
  },
  (t) => [
    index("lot_release_exception_requests_lot_idx").on(t.lotId, t.requestedAt),
    uniqueIndex("lot_release_exception_requests_one_pending_key")
      .on(t.lotId)
      .where(sql`${t.status} = 'pending'`),
  ],
);
