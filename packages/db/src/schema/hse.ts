import type { HseContent, HseKind, HsePermitBody, HseIncidentBody } from "@knotworking/core";
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
import { pk, ts, workspaceRef } from "./helpers";
import { assets } from "./assets";
export const hseRecords = pgTable(
  "hse_records",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    title: text("title").notNull(),
    kind: text("kind").$type<HseKind>().notNull(),
    revision: integer("revision").notNull().default(1),
    status: text("status").$type<"active" | "archived">().notNull().default("active"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("hse_records_scope_idx").on(t.workspaceId, t.kind, t.status)],
);
export const hseVersions = pgTable(
  "hse_versions",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    recordId: uuid("record_id")
      .notNull()
      .references(() => hseRecords.id),
    number: integer("number").notNull(),
    status: text("status")
      .$type<"draft" | "approved" | "superseded" | "archived">()
      .notNull()
      .default("draft"),
    content: jsonb("content").$type<HseContent>().notNull(),
    reason: text("reason").notNull(),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: ts("approved_at"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("hse_versions_number_key").on(t.workspaceId, t.recordId, t.number),
    uniqueIndex("hse_versions_draft_key")
      .on(t.workspaceId, t.recordId)
      .where(sql`${t.status}='draft'`),
    uniqueIndex("hse_versions_approved_key")
      .on(t.workspaceId, t.recordId)
      .where(sql`${t.status}='approved'`),
  ],
);
export const hseEntries = pgTable(
  "hse_entries",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    recordId: uuid("record_id")
      .notNull()
      .references(() => hseRecords.id),
    versionId: uuid("version_id")
      .notNull()
      .references(() => hseVersions.id),
    performedOn: date("performed_on").notNull(),
    outcome: text("outcome").$type<"pass" | "fail" | "recorded">().notNull(),
    findings: text("findings").notNull(),
    actions: text("actions").notNull(),
    evidenceReference: text("evidence_reference").notNull(),
    nextDueOn: date("next_due_on"),
    periodFrom: date("period_from"),
    quantity: numeric("quantity", { precision: 18, scale: 4, mode: "number" }),
    unit: text("unit"),
    resolvesEntryId: uuid("resolves_entry_id").references((): AnyPgColumn => hseEntries.id),
    recordedBy: uuid("recorded_by").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    voidedAt: ts("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
  },
  (t) => [
    index("hse_entries_record_idx").on(t.workspaceId, t.recordId, t.performedOn),
    uniqueIndex("hse_entries_resolution_key")
      .on(t.workspaceId, t.resolvesEntryId)
      .where(sql`${t.voidedAt} is null`),
  ],
);
export const hsePermits = pgTable(
  "hse_permits",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    title: text("title").notNull(),
    revision: integer("revision").notNull().default(1),
    status: text("status")
      .$type<"draft" | "issued" | "suspended" | "closed" | "cancelled">()
      .notNull()
      .default("draft"),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    isolationRequired: boolean("isolation_required").notNull(),
    body: jsonb("body").$type<HsePermitBody>().notNull(),
    evidenceSnapshot: jsonb("evidence_snapshot").$type<Record<string, unknown>>(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("hse_permits_asset_idx").on(t.workspaceId, t.assetId, t.status)],
);
export const hsePermitEvents = pgTable(
  "hse_permit_events",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    permitId: uuid("permit_id")
      .notNull()
      .references(() => hsePermits.id),
    revision: integer("revision").notNull(),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    actorId: uuid("actor_id").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("hse_permit_events_revision_key").on(t.workspaceId, t.permitId, t.revision)],
);
/** Restricted incident records and history never enter workspace sync, including metadata. */
export const hseIncidents = pgTable(
  "hse_incidents",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    reference: text("reference").notNull(),
    revision: integer("revision").notNull().default(1),
    status: text("status").$type<"open" | "closed">().notNull().default("open"),
    body: jsonb("body").$type<HseIncidentBody>().notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("hse_incidents_scope_idx").on(t.workspaceId, t.status)],
);
export const hseIncidentEvents = pgTable(
  "hse_incident_events",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => hseIncidents.id),
    revision: integer("revision").notNull(),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    actorId: uuid("actor_id").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("hse_incident_events_revision_key").on(t.workspaceId, t.incidentId, t.revision)],
);
