/**
 * Restricted HSE incidents, follow-up to milestone 3.4.3: the people hurt (read and written only by
 * signed-in `hse_incidents` managers) and owned corrective actions. Like the incidents themselves,
 * nothing here enters the workspace sync log. See docs/modules.md and `@knotworking/core`
 * hse-incidents.ts.
 */
import type { HseIncidentActionStatus, HsePersonType, HseTreatment } from "@knotworking/core";
import { date, index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { hseIncidents } from "./hse";
import { staff } from "./people";

export const hseIncidentInjuries = pgTable(
  "hse_incident_injuries",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => hseIncidents.id),
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "set null" }),
    personName: text("person_name").notNull(),
    personType: text("person_type").$type<HsePersonType>().notNull(),
    nature: text("nature").notNull(),
    bodyPart: text("body_part"),
    treatment: text("treatment").$type<HseTreatment>().notNull(),
    daysAbsent: integer("days_absent"),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    /** Replaced entries are kept (soft-deleted), so what was first recorded isn't lost. */
    ...timestamps(),
  },
  (t) => [index("hse_incident_injuries_incident_idx").on(t.incidentId)],
);

export const hseIncidentActions = pgTable(
  "hse_incident_actions",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => hseIncidents.id),
    description: text("description").notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    dueOn: date("due_on").notNull(),
    status: text("status").$type<HseIncidentActionStatus>().notNull().default("open"),
    completedBy: uuid("completed_by").references(() => users.id, { onDelete: "set null" }),
    completedAt: ts("completed_at"),
    completionNote: text("completion_note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    index("hse_incident_actions_incident_idx").on(t.incidentId),
    index("hse_incident_actions_due_idx").on(t.workspaceId, t.status, t.dueOn),
  ],
);
