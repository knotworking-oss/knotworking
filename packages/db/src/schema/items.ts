/**
 * Items module: the master data every manufacturing module builds on.
 * See docs/modules.md and `@knotworking/core` items.ts.
 */
import type {
  ItemStatus,
  ItemType,
  SupplierApprovalStatus,
  SupplierCategory,
  SupplierControl,
  SupplierControlEnforcement,
  SupplierControlsOverride,
  SupplierHazard,
  SupplierQuestionnaireStatus,
  SupplierRiskLevel,
  UnitCode,
} from "@knotworking/core";
import { sql } from "drizzle-orm";
import { boolean, date, index, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";

/**
 * A supplier of ingredients or packaging. Approval is a food-safety control (BRCGS supplier
 * approval): only an approved supplier should be bought from, and the approval is reviewed by
 * `reviewDueAt`. Who approved and when is recorded on the row and in the sync log.
 */
export const suppliers = pgTable(
  "suppliers",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    /** Short reference used on paperwork; unique among live suppliers when set. */
    code: text("code"),
    contactName: text("contact_name"),
    email: text("email"),
    phone: text("phone"),
    address: text("address"),
    notes: text("notes"),
    /** e.g. "BRCGS Food Safety AA", "SALSA". Free text; the certificate itself is an attachment later. */
    certification: text("certification"),
    certificateExpiresOn: date("certificate_expires_on"),
    approvalStatus: text("approval_status").$type<SupplierApprovalStatus>().notNull().default("pending"),
    /** Set whenever `approvalStatus` changes. */
    approvalChangedAt: ts("approval_changed_at"),
    approvalChangedBy: uuid("approval_changed_by").references(() => users.id, { onDelete: "set null" }),
    approvalNote: text("approval_note"),
    /** When the approval must be reviewed again. */
    reviewDueOn: date("review_due_on"),
    /**
     * Set when the current approval was given despite open supplier control issues (enforcement
     * `block`): the reason and the issues it overrode. Cleared by the next approval decision.
     */
    approvalControlsOverride: jsonb("approval_controls_override").$type<SupplierControlsOverride>(),
    /** Goods or a service provider (pest control, laboratory, cleaning, transport). */
    category: text("category").$type<SupplierCategory>().notNull().default("goods"),
    serviceType: text("service_type"),
    ...timestamps(),
  },
  (t) => [
    index("suppliers_workspace_idx").on(t.workspaceId, t.name),
    uniqueIndex("suppliers_workspace_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null and ${t.code} is not null`),
  ],
);

/**
 * Anything that is bought, made, stored or sold. Quantities in the stock ledger are held in
 * the base unit of the item's dimension. `unit` is how people enter and read them.
 */
export const items = pgTable(
  "items",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** Stock code / SKU; unique among live items, case-insensitively. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: text("type").$type<ItemType>().notNull(),
    status: text("status").$type<ItemStatus>().notNull().default("active"),
    description: text("description"),
    /** Display and entry unit; its dimension never changes once set. */
    unit: text("unit").$type<UnitCode>().notNull(),
    /** For converting between volume and mass (liquids measured by weight). */
    densityGPerMl: numeric("density_g_per_ml", { precision: 12, scale: 6, mode: "number" }),
    /** For converting between count and mass (an egg, a case). */
    unitWeightG: numeric("unit_weight_g", { precision: 14, scale: 4, mode: "number" }),
    /** Standard cost per `unit`, in the workspace's currency. */
    standardCost: numeric("standard_cost", { precision: 14, scale: 4, mode: "number" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("items_workspace_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null`),
    index("items_workspace_type_idx").on(t.workspaceId, t.type),
  ],
);

/** Which suppliers an item can be bought from. */
export const itemSuppliers = pgTable(
  "item_suppliers",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    /** The supplier's own product code. */
    supplierCode: text("supplier_code"),
    preferred: boolean("preferred").notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("item_suppliers_key").on(t.itemId, t.supplierId),
    index("item_suppliers_supplier_idx").on(t.supplierId),
  ],
);

/**
 * A supplier risk assessment (milestone 3.2.4): for one item the supplier provides, or for the
 * supplier as a whole (`item_id` null: a service provider, or every item). Append-only: a new
 * assessment of the same supplier and item supersedes the current one, which is kept.
 */
export const supplierRiskAssessments = pgTable(
  "supplier_risk_assessments",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    itemId: uuid("item_id").references(() => items.id),
    riskLevel: text("risk_level").$type<SupplierRiskLevel>().notNull(),
    hazards: jsonb("hazards").$type<SupplierHazard[]>().notNull().default([]),
    rationale: text("rationale").notNull(),
    controls: jsonb("controls").$type<SupplierControl[]>().notNull().default([]),
    controlNotes: text("control_notes"),
    reviewDueOn: date("review_due_on").notNull(),
    assessedBy: uuid("assessed_by").references(() => users.id, { onDelete: "set null" }),
    assessedAt: ts("assessed_at").notNull().defaultNow(),
    supersededAt: ts("superseded_at"),
    ...timestamps(),
  },
  (t) => [
    index("supplier_risk_assessments_supplier_idx").on(t.supplierId, t.assessedAt),
    // One current assessment per supplier and item (or per supplier as a whole).
    uniqueIndex("supplier_risk_assessments_current_key")
      .on(t.supplierId, sql`coalesce(${t.itemId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
      .where(sql`${t.supersededAt} is null and ${t.deletedAt} is null`),
  ],
);

/** A self-assessment questionnaire sent to a supplier, its return and its review. */
export const supplierQuestionnaires = pgTable(
  "supplier_questionnaires",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    title: text("title").notNull(),
    status: text("status").$type<SupplierQuestionnaireStatus>().notNull().default("sent"),
    sentOn: date("sent_on").notNull(),
    receivedOn: date("received_on"),
    validUntil: date("valid_until"),
    notes: text("notes"),
    reviewNote: text("review_note"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: ts("reviewed_at"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [index("supplier_questionnaires_supplier_idx").on(t.supplierId, t.sentOn)],
);

/**
 * Whether open supplier control issues only show (`report`, the default) or also stop approving a
 * supplier and sending it purchase orders (`block`), unless a manager records an override reason.
 */
export const supplierControlSettings = pgTable("supplier_control_settings", {
  workspaceId: workspaceRef().primaryKey(),
  enforcement: text("enforcement").$type<SupplierControlEnforcement>().notNull().default("report"),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  ...timestamps(),
});
