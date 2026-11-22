/**
 * Demand module: demand per product per ISO week (by customer), CSV imports, and the history of
 * every change. See docs/modules.md and `@knotworking/core` demand.ts.
 */
import type { DemandAction, DemandSource } from "@knotworking/core";
import { sql } from "drizzle-orm";
import { date, index, integer, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { items } from "./items";

/** One CSV import: who imported which file, and what it did. */
export const demandImports = pgTable(
  "demand_imports",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    fileName: text("file_name"),
    /** Data rows in the file. */
    rowCount: integer("row_count").notNull(),
    createdCount: integer("created_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    removedCount: integer("removed_count").notNull().default(0),
    unchangedCount: integer("unchanged_count").notNull().default(0),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("demand_imports_workspace_created_idx").on(t.workspaceId, t.createdAt)],
);

/**
 * A unit of sale for an item: a named pack (case, tray, pallet) with its size in the item's base
 * unit (g, ml or each), e.g. case = 12 each. Demand can be entered in a pack unit; it is stored in
 * base units. Names are unique per item among live rows, case-insensitively.
 */
export const demandPackUnits = pgTable(
  "demand_pack_units",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    name: text("name").notNull(),
    /** Base units (g, ml or each) in one pack. */
    size: numeric("size", { precision: 18, scale: 4, mode: "number" }).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("demand_pack_units_key")
      .on(t.workspaceId, t.itemId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} is null`),
    index("demand_pack_units_item_idx").on(t.itemId),
  ],
);

/**
 * Demand for one item in one ISO week (`period_start` is its Monday), optionally for one customer
 * or channel. One live line per item, week and customer (case-insensitive): writing the same key
 * again replaces the quantity. The quantity is in the item's base unit (g, ml or each).
 */
export const demandLines = pgTable(
  "demand_lines",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    periodStart: date("period_start").notNull(),
    /** Customer or channel; `null` for demand not split by customer. */
    customer: text("customer"),
    quantity: numeric("quantity", { precision: 18, scale: 4, mode: "number" }).notNull(),
    /** What was typed when it was in a pack unit (`5`), with the pack's name (`case`); else null. */
    enteredQuantity: numeric("entered_quantity", { precision: 18, scale: 4, mode: "number" }),
    enteredUnit: text("entered_unit"),
    note: text("note"),
    /** Where the current quantity came from: manual, import, api or forecast. */
    source: text("source").$type<DemandSource>().notNull(),
    /** The sales system's reference for this line (an order or forecast line id). */
    externalRef: text("external_ref"),
    /** The import that last set this line, if it came from one. */
    importId: uuid("import_id").references(() => demandImports.id),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("demand_lines_key")
      .on(t.workspaceId, t.itemId, t.periodStart, sql`lower(coalesce(${t.customer}, ''))`)
      .where(sql`${t.deletedAt} is null`),
    index("demand_lines_workspace_period_idx").on(t.workspaceId, t.periodStart),
    index("demand_lines_item_period_idx").on(t.itemId, t.periodStart),
  ],
);

/**
 * Every change to a demand line, **append-only**: what the quantity was and became (base unit;
 * `null` before a create and after a remove), who changed it, how and when. Not in the sync log;
 * read per line.
 */
export const demandHistory = pgTable(
  "demand_history",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    lineId: uuid("line_id")
      .notNull()
      .references(() => demandLines.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    periodStart: date("period_start").notNull(),
    customer: text("customer"),
    action: text("action").$type<Exclude<DemandAction, "unchanged">>().notNull(),
    previousQuantity: numeric("previous_quantity", { precision: 18, scale: 4, mode: "number" }),
    quantity: numeric("quantity", { precision: 18, scale: 4, mode: "number" }),
    enteredQuantity: numeric("entered_quantity", { precision: 18, scale: 4, mode: "number" }),
    enteredUnit: text("entered_unit"),
    note: text("note"),
    source: text("source").$type<DemandSource>().notNull(),
    importId: uuid("import_id").references(() => demandImports.id),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("demand_history_line_idx").on(t.lineId, t.createdAt),
    index("demand_history_workspace_item_idx").on(t.workspaceId, t.itemId, t.periodStart),
  ],
);
