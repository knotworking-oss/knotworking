import type { UnitCode, DespatchLoadInput } from "@knotworking/core";
import { date, index, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { customerDeliverySites, customers } from "./customers";
import { pk, ts, workspaceRef } from "./helpers";
import { items } from "./items";
import { stockLocations, stockLots, stockMovements } from "./stock";

/** Confirmed recipient facts never follow later edits to customer master data. */
export const despatches = pgTable(
  "despatches",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    reference: text("reference").notNull(),
    status: text("status").$type<"draft" | "confirmed" | "voided">().notNull().default("draft"),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    customerCode: text("customer_code").notNull(),
    customerName: text("customer_name").notNull(),
    customerAddress: text("customer_address").notNull(),
    contactName: text("contact_name"),
    email: text("email"),
    phone: text("phone"),
    deliveryAddress: text("delivery_address").notNull(),
    deliverySiteId: uuid("delivery_site_id").references(() => customerDeliverySites.id),
    deliverySiteCode: text("delivery_site_code"),
    deliverySiteName: text("delivery_site_name"),
    allocatedAt: ts("allocated_at"),
    allocatedBy: uuid("allocated_by").references(() => users.id),
    packedAt: ts("packed_at"),
    packedBy: uuid("packed_by").references(() => users.id),
    loadCheck: jsonb("load_check").$type<DespatchLoadInput>(),
    loadCheckedAt: ts("load_checked_at"),
    loadCheckedBy: uuid("load_checked_by").references(() => users.id),
    despatchedOn: date("despatched_on").notNull(),
    externalReference: text("external_reference"),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    confirmedBy: uuid("confirmed_by").references(() => users.id, { onDelete: "set null" }),
    confirmedAt: ts("confirmed_at"),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
    voidedAt: ts("voided_at"),
    voidReason: text("void_reason"),
  },
  (t) => [
    uniqueIndex("despatches_workspace_reference_key").on(t.workspaceId, t.reference),
    index("despatches_workspace_date_idx").on(t.workspaceId, t.despatchedOn),
    index("despatches_customer_idx").on(t.customerId),
  ],
);

export const despatchLines = pgTable(
  "despatch_lines",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    despatchId: uuid("despatch_id")
      .notNull()
      .references(() => despatches.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => stockLots.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => stockLocations.id),
    itemCode: text("item_code").notNull(),
    itemName: text("item_name").notNull(),
    lotCode: text("lot_code").notNull(),
    locationName: text("location_name").notNull(),
    /** Always in the item's base unit; itemUnit preserves its original display dimension. */
    quantity: numeric("quantity", { precision: 18, scale: 4, mode: "number" }).notNull(),
    itemUnit: text("item_unit").$type<UnitCode>().notNull(),
    expiresOn: date("expires_on"),
    movementId: uuid("movement_id").references(() => stockMovements.id),
    reversalMovementId: uuid("reversal_movement_id").references(() => stockMovements.id),
  },
  (t) => [
    index("despatch_lines_workspace_lot_idx").on(t.workspaceId, t.lotId),
    index("despatch_lines_despatch_idx").on(t.despatchId),
    uniqueIndex("despatch_lines_movement_key").on(t.movementId),
  ],
);
