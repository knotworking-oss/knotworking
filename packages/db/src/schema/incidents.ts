import type { DespatchImpactReport, IncidentCloseInput, IncidentEvidence } from "@knotworking/core";
import { index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, ts, workspaceRef } from "./helpers";
import { stockLots } from "./stock";

export const qualityIncidents = pgTable(
  "quality_incidents",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    kind: text("kind").$type<"incident" | "withdrawal" | "recall">().notNull(),
    severity: text("severity").$type<"minor" | "major" | "critical">().notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    assessment: text("assessment").notNull(),
    status: text("status").$type<"open" | "closed">().notNull().default("open"),
    createdAt: ts("created_at").notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
    closedAt: ts("closed_at"),
    closedBy: uuid("closed_by").references(() => users.id),
    closure: jsonb("closure").$type<IncidentCloseInput>(),
  },
  (t) => [uniqueIndex("quality_incidents_reference_key").on(t.workspaceId, t.reference)],
);
export const qualityIncidentSnapshots = pgTable(
  "quality_incident_snapshots",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => qualityIncidents.id),
    report: jsonb("report").$type<DespatchImpactReport>().notNull(),
    note: text("note").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
  },
  (t) => [index("quality_incident_snapshots_case_idx").on(t.workspaceId, t.incidentId)],
);
/** Holds are independent of QA status. Releasing one case cannot release another case's hold. */
export const qualityIncidentHolds = pgTable(
  "quality_incident_holds",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => qualityIncidents.id),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => stockLots.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    releasedAt: ts("released_at"),
    releasedBy: uuid("released_by").references(() => users.id),
    releaseNote: text("release_note"),
  },
  (t) => [
    uniqueIndex("quality_incident_holds_case_lot_key").on(t.incidentId, t.lotId),
    index("quality_incident_holds_lot_idx").on(t.workspaceId, t.lotId),
  ],
);
export const qualityIncidentEvents = pgTable(
  "quality_incident_events",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => qualityIncidents.id),
    data: jsonb("data").$type<IncidentEvidence>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    actorId: uuid("actor_id").references(() => users.id),
  },
  (t) => [index("quality_incident_events_case_idx").on(t.workspaceId, t.incidentId)],
);
