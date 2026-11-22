/**
 * Specifications module: controlled, versioned specifications for items.
 * See docs/modules.md and `@knotworking/core` specifications.ts.
 *
 * The specification row is the stable identity (document number, item, supplier or customer);
 * the content lives in versions under the same document control as recipes. Only metadata goes
 * to the sync log; a version's content and parameters are read through endpoints.
 */
import type {
  AllergenCode,
  SpecificationParameterCategory,
  SpecificationStatus,
  SpecificationVersionStatus,
  StorageCondition,
} from "@knotworking/core";
import { sql } from "drizzle-orm";
import { date, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { items, suppliers } from "./items";

export const specifications = pgTable(
  "specifications",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** Document number; unique among live specifications, case-insensitively. */
    code: text("code").notNull(),
    title: text("title").notNull(),
    /** The item specified. Fixed once created. */
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    /** A bought-in item's supplier whose specification this is; null otherwise. */
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    /** A product's customer this specification is agreed with; null otherwise. */
    customerName: text("customer_name"),
    status: text("status").$type<SpecificationStatus>().notNull().default("active"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("specifications_workspace_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null`),
    index("specifications_item_idx").on(t.itemId),
    index("specifications_supplier_idx").on(t.supplierId),
  ],
);

/**
 * One version of a specification. At most one draft (the only editable version) and one approved
 * version per specification, enforced by the database; approving supersedes the previous approved
 * version. Approved and superseded versions never change.
 */
export const specificationVersions = pgTable(
  "specification_versions",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    specificationId: uuid("specification_id")
      .notNull()
      .references(() => specifications.id, { onDelete: "cascade" }),
    /** 1, 2, … per specification. */
    versionNumber: integer("version_number").notNull(),
    status: text("status").$type<SpecificationVersionStatus>().notNull().default("draft"),
    description: text("description"),
    storage: text("storage").$type<StorageCondition>(),
    storageInstructions: text("storage_instructions"),
    shelfLifeDays: integer("shelf_life_days"),
    minimumLifeOnReceiptDays: integer("minimum_life_on_receipt_days"),
    allergens: jsonb("allergens").$type<AllergenCode[]>().notNull().default([]),
    mayContain: jsonb("may_contain").$type<AllergenCode[]>().notNull().default([]),
    countryOfOrigin: text("country_of_origin"),
    provenance: text("provenance"),
    claims: jsonb("claims").$type<string[]>().notNull().default([]),
    packagingDetails: text("packaging_details"),
    reviewDueOn: date("review_due_on"),
    /** The supplier's or customer's signatory and the date they agreed this version. */
    agreedBy: text("agreed_by"),
    agreedOn: date("agreed_on"),
    agreementReference: text("agreement_reference"),
    changeNote: text("change_note"),
    /** Whoever created or last saved the draft: four-eyes keeps them from approving it. */
    lastEditedBy: uuid("last_edited_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: ts("approved_at"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("specification_versions_number_key").on(t.specificationId, t.versionNumber),
    uniqueIndex("specification_versions_one_draft_key")
      .on(t.specificationId)
      .where(sql`${t.status} = 'draft' and ${t.deletedAt} is null`),
    uniqueIndex("specification_versions_one_approved_key")
      .on(t.specificationId)
      .where(sql`${t.status} = 'approved' and ${t.deletedAt} is null`),
    index("specification_versions_review_idx").on(t.workspaceId, t.status, t.reviewDueOn),
  ],
);

/**
 * A limit a version sets: what's tested and against what. Kept as rows (not JSON) so test results
 * can refer to the exact parameter of the version they were judged against.
 */
export const specificationParameters = pgTable(
  "specification_parameters",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => specificationVersions.id, { onDelete: "cascade" }),
    category: text("category").$type<SpecificationParameterCategory>().notNull(),
    name: text("name").notNull(),
    unit: text("unit"),
    min: numeric("min", { precision: 18, scale: 6, mode: "number" }),
    target: numeric("target", { precision: 18, scale: 6, mode: "number" }),
    max: numeric("max", { precision: 18, scale: 6, mode: "number" }),
    limitText: text("limit_text"),
    method: text("method"),
    note: text("note"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps(),
  },
  (t) => [index("specification_parameters_version_idx").on(t.versionId, t.sortOrder)],
);
