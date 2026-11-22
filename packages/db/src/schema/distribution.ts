import type { DespatchProofInput, UnitCode } from "@knotworking/core";
import { date, index, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, ts, workspaceRef } from "./helpers";
import { despatches, despatchLines } from "./despatch";
import { stockLots, stockLocations, stockMovements } from "./stock";
import { qualityIncidents } from "./incidents";
export const despatchHandlingUnits = pgTable(
  "despatch_handling_units",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    despatchId: uuid("despatch_id")
      .notNull()
      .references(() => despatches.id),
    reference: text("reference").notNull(),
    sscc: text("sscc"),
    contents: jsonb("contents").$type<{ lineId: string; quantity: number }[]>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
    supersededAt: ts("superseded_at"),
  },
  (t) => [
    uniqueIndex("despatch_handling_units_sscc_key").on(t.workspaceId, t.sscc),
    index("despatch_handling_units_despatch_idx").on(t.workspaceId, t.despatchId),
  ],
);
export const despatchOperationEvents = pgTable(
  "despatch_operation_events",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    despatchId: uuid("despatch_id")
      .notNull()
      .references(() => despatches.id),
    kind: text("kind").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    actorId: uuid("actor_id").references(() => users.id),
  },
  (t) => [index("despatch_operation_events_despatch_idx").on(t.workspaceId, t.despatchId)],
);
export const despatchProofs = pgTable(
  "despatch_proofs",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    despatchId: uuid("despatch_id")
      .notNull()
      .references(() => despatches.id),
    data: jsonb("data").$type<DespatchProofInput>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    actorId: uuid("actor_id").references(() => users.id),
  },
  (t) => [index("despatch_proofs_despatch_idx").on(t.workspaceId, t.despatchId)],
);
export const despatchReturns = pgTable(
  "despatch_returns",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    despatchId: uuid("despatch_id")
      .notNull()
      .references(() => despatches.id),
    lineId: uuid("line_id")
      .notNull()
      .references(() => despatchLines.id),
    originalLotId: uuid("original_lot_id")
      .notNull()
      .references(() => stockLots.id),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => stockLots.id),
    lotCode: text("lot_code").notNull(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => stockLocations.id),
    quantity: numeric("quantity", { precision: 18, scale: 4, mode: "number" }).notNull(),
    itemUnit: text("item_unit").$type<UnitCode>().notNull(),
    movementId: uuid("movement_id")
      .notNull()
      .references(() => stockMovements.id),
    reversalMovementId: uuid("reversal_movement_id").references(() => stockMovements.id),
    receivedOn: date("received_on").notNull(),
    reason: text("reason").notNull(),
    condition: text("condition").notNull(),
    incidentId: uuid("incident_id").references(() => qualityIncidents.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
    voidedAt: ts("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
  },
  (t) => [
    uniqueIndex("despatch_returns_movement_key").on(t.movementId),
    uniqueIndex("despatch_returns_lot_key").on(t.workspaceId, t.lotId),
    index("despatch_returns_despatch_idx").on(t.workspaceId, t.despatchId),
    index("despatch_returns_original_lot_idx").on(t.workspaceId, t.originalLotId),
    index("despatch_returns_case_idx").on(t.workspaceId, t.incidentId),
  ],
);
