/**
 * Costing module: what people set. Costs themselves are computed on read and never stored; these
 * tables hold period closes (frozen figures), standard cost history and absorption rates.
 * See docs/modules.md and `@knotworking/core` costing.ts.
 */
import type {
  CostingCloseSnapshot,
  CostingCloseStatus,
  CostingCloseSummary,
  CostingPeriod,
} from "@knotworking/core";
import { sql } from "drizzle-orm";
import { date, index, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { items } from "./items";
import { productionLines } from "./production";

/**
 * A closed costing period: the figures at the moment a person with `manage` signed it off. A
 * reopened close stays (status `reopened`, with who, when and why); closing again adds a new row,
 * so the rows of one period are its audit trail. At most one is `closed` per period.
 */
export const costingPeriodCloses = pgTable(
  "costing_period_closes",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    period: text("period").$type<CostingPeriod>().notNull(),
    /** First and last day of the period. */
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    status: text("status").$type<CostingCloseStatus>().notNull().default("closed"),
    /** The headline figures: small, so this is what the sync log carries. */
    summary: jsonb("summary").$type<CostingCloseSummary>().notNull(),
    /** Every figure the period showed when it was closed. Not in the sync log; read from its own route. */
    snapshot: jsonb("snapshot").$type<CostingCloseSnapshot>().notNull(),
    note: text("note"),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    closedAt: ts("closed_at").notNull().defaultNow(),
    reopenedBy: uuid("reopened_by").references(() => users.id, { onDelete: "set null" }),
    reopenedAt: ts("reopened_at"),
    reopenReason: text("reopen_reason"),
    ...timestamps(),
  },
  (t) => [
    index("costing_period_closes_period_idx").on(t.workspaceId, t.period, t.periodStart),
    /** A period is closed at most once at a time. */
    uniqueIndex("costing_period_closes_open_key")
      .on(t.workspaceId, t.period, t.periodStart)
      .where(sql`${t.status} = 'closed'`),
  ],
);

/**
 * An item's standard cost from a date (per the item's own unit; null: none from then on). The
 * standard side of a batch uses the entry in force on its completion date. `items.standard_cost`
 * stays the current figure; changing it adds an entry effective today.
 */
export const itemStandardCosts = pgTable(
  "item_standard_costs",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    effectiveFrom: date("effective_from").notNull(),
    cost: numeric("cost", { precision: 14, scale: 4, mode: "number" }),
    note: text("note"),
    setBy: uuid("set_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [uniqueIndex("item_standard_costs_item_date_key").on(t.itemId, t.effectiveFrom)],
);

const rate = (name: string) =>
  numeric(name, { precision: 14, scale: 4, mode: "number" }).notNull().default(0);

/**
 * Labour and overhead absorption rates for a production line (`line_id` null: the workspace
 * default) from a date: an amount per batch hour and per kilogram made. A batch absorbs the rates
 * in force on its completion date.
 */
export const costingAbsorptionRates = pgTable(
  "costing_absorption_rates",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    lineId: uuid("line_id").references(() => productionLines.id),
    effectiveFrom: date("effective_from").notNull(),
    labourPerHour: rate("labour_per_hour"),
    labourPerKg: rate("labour_per_kg"),
    overheadPerHour: rate("overhead_per_hour"),
    overheadPerKg: rate("overhead_per_kg"),
    note: text("note"),
    setBy: uuid("set_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("costing_absorption_rates_line_key")
      .on(t.workspaceId, t.lineId, t.effectiveFrom)
      .where(sql`${t.lineId} is not null`),
    uniqueIndex("costing_absorption_rates_default_key")
      .on(t.workspaceId, t.effectiveFrom)
      .where(sql`${t.lineId} is null`),
  ],
);
