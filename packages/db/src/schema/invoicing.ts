import type { InvoiceLine, InvoiceParty, InvoiceSource } from "@knotworking/core";
import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "../schema";
import { customers } from "./customers";
import { pk, ts, workspaceRef } from "./helpers";

export const customerDocuments = pgTable(
  "customer_documents",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    customer: jsonb("customer").$type<InvoiceParty>().notNull(),
    issuer: jsonb("issuer").$type<InvoiceParty>().notNull(),
    kind: text("kind").$type<"invoice" | "credit">().notNull(),
    status: text("status").$type<"draft" | "issued" | "discarded">().notNull().default("draft"),
    revision: integer("revision").notNull().default(1),
    serial: integer("serial"),
    number: text("number"),
    date: date("date").notNull(),
    dueDate: date("due_date"),
    currency: text("currency").notNull(),
    source: text("source").$type<InvoiceSource>().notNull(),
    sourceId: uuid("source_id"),
    sourceReference: text("source_reference"),
    creditOf: uuid("credit_of"),
    creditReason: text("credit_reason"),
    lines: jsonb("lines").$type<InvoiceLine[]>().notNull(),
    net: text("net").notNull(),
    tax: text("tax").notNull(),
    gross: text("gross").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    issuedAt: ts("issued_at"),
  },
  (t) => [
    uniqueIndex("customer_documents_workspace_id_key").on(t.workspaceId, t.id),
    uniqueIndex("customer_documents_serial_key").on(t.workspaceId, t.kind, t.serial),
    uniqueIndex("customer_documents_number_key").on(t.workspaceId, t.number),
    index("customer_documents_list_idx").on(t.workspaceId, t.createdAt),
    foreignKey({
      name: "customer_documents_credit_fk",
      columns: [t.workspaceId, t.creditOf],
      foreignColumns: [t.workspaceId, t.id],
    }),
    check("customer_documents_kind_check", sql`${t.kind} in ('invoice', 'credit')`),
    check("customer_documents_status_check", sql`${t.status} in ('draft', 'issued', 'discarded')`),
    check(
      "customer_documents_issued_check",
      sql`(${t.status} = 'issued') = (${t.serial} is not null and ${t.number} is not null and ${t.issuedAt} is not null)`,
    ),
    check(
      "customer_documents_credit_check",
      sql`(${t.kind} = 'credit' and ${t.creditOf} is not null and ${t.creditReason} is not null and ${t.dueDate} is null) or (${t.kind} = 'invoice' and ${t.creditOf} is null and ${t.dueDate} >= ${t.date} and ${t.dueDate} is not null)`,
    ),
  ],
);

/** A draft reserves the source; issuing retains the reservation and discarding releases it. */
export const customerDocumentClaims = pgTable(
  "customer_document_claims",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    documentId: uuid("document_id").notNull(),
    kind: text("kind").$type<"despatch_line" | "sales_line" | "service" | "credit_line">().notNull(),
    sourceId: uuid("source_id").notNull(),
    orderLineId: uuid("order_line_id"),
    /** Shipment quantities are stored in the dispatch base unit for approval revalidation. */
    quantity: text("quantity"),
    releasedAt: ts("released_at"),
  },
  (t) => [
    foreignKey({
      name: "customer_document_claims_document_fk",
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [customerDocuments.workspaceId, customerDocuments.id],
    }),
    uniqueIndex("customer_document_active_claim_key")
      .on(t.workspaceId, t.kind, t.sourceId)
      .where(sql`${t.releasedAt} is null`),
    index("customer_document_claims_document_idx").on(t.workspaceId, t.documentId),
    index("customer_document_claims_order_line_idx").on(t.workspaceId, t.orderLineId),
  ],
);

export const customerDocumentEvents = pgTable(
  "customer_document_events",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    documentId: uuid("document_id").notNull(),
    revision: integer("revision").notNull(),
    action: text("action").$type<"drafted" | "edited" | "issued" | "discarded">().notNull(),
    reason: text("reason").notNull(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    snapshot: jsonb("snapshot").$type<typeof customerDocuments.$inferSelect>().notNull(),
  },
  (t) => [
    foreignKey({
      name: "customer_document_events_document_fk",
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [customerDocuments.workspaceId, customerDocuments.id],
    }),
    uniqueIndex("customer_document_events_revision_key").on(t.workspaceId, t.documentId, t.revision),
  ],
);
