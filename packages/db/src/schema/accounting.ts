import { newId } from "@knotworking/core";
import type { AccountingPosting, AccountingPostingState, AccountingReceipt } from "@knotworking/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  primaryKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, ts, workspaceRef } from "./helpers";

/** Private connector records: never publish payloads or receipts to workspace sync. */
export const accountingPostings = pgTable(
  "accounting_postings",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    provider: text("provider").notNull(),
    connectionId: uuid("connection_id").notNull(),
    companyId: text("company_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<AccountingPosting>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    state: text("state").$type<AccountingPostingState>().notNull().default("queued"),
    attemptId: uuid("attempt_id"),
    attempts: integer("attempts").notNull().default(0),
    externalId: text("external_id"),
    receipt: jsonb("receipt").$type<AccountingReceipt>(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // One immutable posting per source and configured accounting connection.
    uniqueIndex("accounting_postings_source_key").on(t.workspaceId, t.connectionId, t.kind, t.sourceId),
    uniqueIndex("accounting_postings_external_key").on(t.workspaceId, t.connectionId, t.externalId),
    index("accounting_postings_queue_idx").on(t.workspaceId, t.state, t.createdAt),
    check("accounting_postings_state_check", sql`${t.state} in ('queued', 'unknown', 'failed', 'posted')`),
  ],
);

/** Append-only attempt and reconciliation evidence; stored outside shared sync. */
export const accountingPostingEvents = pgTable(
  "accounting_posting_events",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    postingId: uuid("posting_id")
      .notNull()
      .references(() => accountingPostings.id),
    attemptId: uuid("attempt_id"),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    evidence: text("evidence").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("accounting_posting_events_history_idx").on(t.workspaceId, t.postingId, t.createdAt)],
);

/** Optional configuration, private to signed-in workspace administrators. */
export const accountingConnections = pgTable(
  "accounting_connections",
  {
    id: uuid("id").notNull().$defaultFn(newId),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    companyId: text("company_id").notNull(),
    disabled: boolean("disabled").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    index("accounting_connections_destination_idx").on(t.workspaceId, t.provider, t.companyId),
  ],
);

export const accountingMappings = pgTable(
  "accounting_mappings",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    connectionId: uuid("connection_id").notNull(),
    kind: text("kind").$type<"supplier" | "customer" | "account" | "tax">().notNull(),
    localReference: text("local_reference").notNull(),
    externalReference: text("external_reference").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    reviewedBy: uuid("reviewed_by")
      .notNull()
      .references(() => users.id),
    reviewedAt: ts("reviewed_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [accountingConnections.workspaceId, accountingConnections.id],
    }),
    uniqueIndex("accounting_mappings_local_key").on(t.workspaceId, t.connectionId, t.kind, t.localReference),
  ],
);

export const accountingConfigurationEvents = pgTable(
  "accounting_configuration_events",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    connectionId: uuid("connection_id").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    revision: integer("revision").notNull(),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [accountingConnections.workspaceId, accountingConnections.id],
    }),
    index("accounting_configuration_events_history_idx").on(t.workspaceId, t.connectionId, t.revision),
  ],
);
