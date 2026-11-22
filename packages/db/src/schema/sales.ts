import type { SalesRecipientSnapshot, UnitCode } from "@knotworking/core";
import { sql } from "drizzle-orm";
import { date, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { customers, customerDeliverySites } from "./customers";
import { despatchLines } from "./despatch";
import { items } from "./items";
import { pk, ts, workspaceRef } from "./helpers";

export const salesOrders = pgTable(
  "sales_orders",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    reference: text("reference").notNull(),
    kind: text("kind").$type<"quote" | "order">().notNull(),
    status: text("status").$type<"draft" | "issued" | "confirmed" | "cancelled">().notNull().default("draft"),
    revision: integer("revision").notNull().default(1),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    deliverySiteId: uuid("delivery_site_id").references(() => customerDeliverySites.id),
    recipient: jsonb("recipient").$type<SalesRecipientSnapshot>().notNull(),
    customerReference: text("customer_reference").notNull().default(""),
    currency: text("currency").notNull(),
    validUntil: date("valid_until"),
    terms: text("terms").notNull().default(""),
    notes: text("notes").notNull().default(""),
    sourceQuoteId: uuid("source_quote_id"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    signedBy: uuid("signed_by").references(() => users.id),
    signedAt: ts("signed_at"),
    /** When an order was confirmed (kept if it is later cancelled). */
    confirmedAt: ts("confirmed_at"),
  },
  (t) => [
    uniqueIndex("sales_orders_reference_key").on(t.workspaceId, t.reference),
    // One order per quote, except orders cancelled while still drafts: those don't block converting
    // the quote again. An order that was ever confirmed keeps the quote converted, even if cancelled.
    uniqueIndex("sales_orders_source_quote_key")
      .on(t.workspaceId, t.sourceQuoteId)
      .where(sql`${t.status} <> 'cancelled' or ${t.confirmedAt} is not null`),
    index("sales_orders_workspace_status_idx").on(t.workspaceId, t.status, t.createdAt),
  ],
);

export const salesPrices = pgTable(
  "sales_prices",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    unit: text("unit").$type<UnitCode>().notNull(),
    currency: text("currency").notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 8, mode: "number" }).notNull(),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    contractReference: text("contract_reference").notNull(),
    terms: text("terms").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    archivedAt: ts("archived_at"),
    archivedBy: uuid("archived_by").references(() => users.id),
    archiveReason: text("archive_reason"),
  },
  (t) => [index("sales_prices_scope_idx").on(t.workspaceId, t.customerId, t.itemId, t.currency)],
);

export const salesOrderLines = pgTable(
  "sales_order_lines",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => salesOrders.id),
    position: integer("position").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    itemCode: text("item_code").notNull(),
    itemName: text("item_name").notNull(),
    unit: text("unit").$type<UnitCode>().notNull(),
    baseUnit: text("base_unit").$type<"g" | "ml" | "each">().notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4, mode: "number" }).notNull(),
    baseQuantity: numeric("base_quantity", { precision: 18, scale: 4, mode: "number" }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 8, mode: "number" }).notNull(),
    priceId: uuid("price_id").references(() => salesPrices.id),
    dueOn: date("due_on").notNull(),
    note: text("note").notNull(),
    removedAt: ts("removed_at"),
  },
  (t) => [
    index("sales_order_lines_order_idx").on(t.workspaceId, t.orderId),
    index("sales_order_lines_due_idx").on(t.workspaceId, t.dueOn),
  ],
);

export const salesEvents = pgTable(
  "sales_events",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => salesOrders.id),
    revision: integer("revision").notNull(),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    actorId: uuid("actor_id").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sales_events_revision_key").on(t.workspaceId, t.orderId, t.revision)],
);

/** Whole confirmed despatch lines are assigned once; corrections retain the old link. */
export const salesFulfilments = pgTable(
  "sales_fulfilments",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => salesOrders.id),
    orderLineId: uuid("order_line_id")
      .notNull()
      .references(() => salesOrderLines.id),
    despatchLineId: uuid("despatch_line_id")
      .notNull()
      .references(() => despatchLines.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    reason: text("reason").notNull(),
    voidedAt: ts("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
  },
  (t) => [
    uniqueIndex("sales_fulfilments_despatch_key")
      .on(t.workspaceId, t.despatchLineId)
      .where(sql`${t.voidedAt} is null`),
    index("sales_fulfilments_order_idx").on(t.workspaceId, t.orderId),
  ],
);

export const salesExternalReferences = pgTable(
  "sales_external_references",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    system: text("system").notNull(),
    entityType: text("entity_type").$type<"order" | "price" | "customer" | "item">().notNull(),
    entityId: uuid("entity_id").notNull(),
    externalId: text("external_id").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sales_external_refs_external_key").on(t.workspaceId, t.system, t.entityType, t.externalId),
    uniqueIndex("sales_external_refs_local_key").on(t.workspaceId, t.system, t.entityType, t.entityId),
  ],
);
