import type { ServiceQuoteStatus } from "@knotworking/core";
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "../schema";
import { customers } from "./customers";
import { pk, ts, workspaceRef } from "./helpers";
import { projects } from "./tasks";

export const serviceQuotes = pgTable(
  "service_quotes",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    reference: text("reference").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    recipient: jsonb("recipient").$type<{ name: string; code: string; address: string }>().notNull(),
    title: text("title").notNull(),
    scope: text("scope").notNull(),
    currency: text("currency").notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 8, mode: "number" }).notNull(),
    quotedMinutes: integer("quoted_minutes"),
    deliveryDate: date("delivery_date"),
    status: text("status").$type<ServiceQuoteStatus>().notNull().default("draft"),
    revision: integer("revision").notNull().default(1),
    projectId: uuid("project_id").references(() => projects.id),
    approvedMinutes: integer("approved_minutes"),
    deliveredAt: ts("delivered_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("service_quotes_workspace_reference_idx").on(t.workspaceId, t.reference),
    index("service_quotes_workspace_status_idx").on(t.workspaceId, t.status, t.id),
    check(
      "service_quotes_status_check",
      sql`${t.status} in ('draft', 'issued', 'accepted', 'delivered', 'cancelled')`,
    ),
    check(
      "service_quotes_amount_check",
      sql`${t.unitPrice} >= 0 and (${t.quotedMinutes} is null or ${t.quotedMinutes} > 0)`,
    ),
    check("service_quotes_delivery_check", sql`(${t.status} = 'delivered') = (${t.deliveredAt} is not null)`),
  ],
);

export const serviceQuoteEvents = pgTable(
  "service_quote_events",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => serviceQuotes.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("service_quote_events_revision_idx").on(t.workspaceId, t.quoteId, t.revision)],
);
