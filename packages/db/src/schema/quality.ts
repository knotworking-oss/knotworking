/**
 * Quality module: complaints, non-conformances (CAPA), internal audits and mock recall tests.
 * See docs/modules.md and `@knotworking/core` quality.ts.
 *
 * Every record has a reference (`CMP-2026-001`) unique in the workspace, never reused: rows are
 * closed, cancelled or voided, not deleted (only a planned audit with no findings can be).
 */
import type {
  AuditStatus,
  ComplaintCategory,
  ComplaintSource,
  ComplaintStatus,
  NonconformanceSource,
  NonconformanceStatus,
  QualitySeverity,
  RecallDirection,
  SupplierApprovalStatus,
} from "@knotworking/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { items, suppliers } from "./items";
import { stockLots } from "./stock";

/** A complaint from a consumer, a customer, a retailer, a regulator, or raised internally. */
export const qualityComplaints = pgTable(
  "quality_complaints",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    reference: text("reference").notNull(),
    receivedOn: date("received_on").notNull(),
    source: text("source").$type<ComplaintSource>().notNull(),
    category: text("category").$type<ComplaintCategory>().notNull(),
    severity: text("severity").$type<QualitySeverity>().notNull(),
    status: text("status").$type<ComplaintStatus>().notNull().default("open"),
    /** Personal data: never written to the sync log. */
    complainantName: text("complainant_name"),
    complainantContact: text("complainant_contact"),
    customer: text("customer"),
    itemId: uuid("item_id").references(() => items.id),
    lotId: uuid("lot_id").references(() => stockLots.id),
    reportedLotCode: text("reported_lot_code"),
    description: text("description").notNull(),
    investigation: text("investigation"),
    rootCause: text("root_cause"),
    response: text("response"),
    justified: boolean("justified"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    closedAt: ts("closed_at"),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    closeNote: text("close_note"),
    /** The last time a manager reopened it, and why. */
    reopenedAt: ts("reopened_at"),
    reopenReason: text("reopen_reason"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("quality_complaints_reference_key").on(t.workspaceId, t.reference),
    index("quality_complaints_received_idx").on(t.workspaceId, t.receivedOn),
    index("quality_complaints_item_idx").on(t.itemId),
    index("quality_complaints_lot_idx").on(t.lotId),
  ],
);

/**
 * A recurring audit programme: an area or standard audited every `intervalMonths`. The sweep (and
 * saving the programme) plans the next audits ahead as ordinary planned audits; `nextPlannedOn` is
 * the date of the next one not yet generated.
 */
export const qualityAuditProgrammes = pgTable(
  "quality_audit_programmes",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    title: text("title").notNull(),
    /** The area, process or standard clauses covered. */
    scope: text("scope"),
    intervalMonths: integer("interval_months").notNull(),
    nextPlannedOn: date("next_planned_on").notNull(),
    /** Pins each audit to this ISO weekday (1 Monday … 7 Sunday): the first such day on or after the date. */
    weekday: integer("weekday"),
    auditorUserId: uuid("auditor_user_id").references(() => users.id, { onDelete: "set null" }),
    auditorName: text("auditor_name"),
    active: boolean("active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    index("quality_audit_programmes_workspace_idx").on(t.workspaceId, t.active),
    check(
      "quality_audit_programmes_weekday_range",
      sql`${t.weekday} is null or ${t.weekday} between 1 and 7`,
    ),
  ],
);

/** Units sold (or shipped) of a product in a month, entered by hand: the denominator of complaint trends. */
export const qualitySalesVolumes = pgTable(
  "quality_sales_volumes",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    /** First day of the month. */
    periodStart: date("period_start").notNull(),
    units: numeric("units", { precision: 18, scale: 2, mode: "number" }).notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [uniqueIndex("quality_sales_volumes_key").on(t.workspaceId, t.itemId, t.periodStart)],
);

/** A planned internal audit and, once done, its outcome. Findings are non-conformances. */
export const qualityAudits = pgTable(
  "quality_audits",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    scope: text("scope"),
    plannedOn: date("planned_on").notNull(),
    auditorUserId: uuid("auditor_user_id").references(() => users.id, { onDelete: "set null" }),
    auditorName: text("auditor_name"),
    status: text("status").$type<AuditStatus>().notNull().default("planned"),
    completedOn: date("completed_on"),
    summary: text("summary"),
    /** Who recorded the outcome (a person, never a token). */
    completedBy: uuid("completed_by").references(() => users.id, { onDelete: "set null" }),
    completedAt: ts("completed_at"),
    cancelledAt: ts("cancelled_at"),
    cancelledBy: uuid("cancelled_by").references(() => users.id, { onDelete: "set null" }),
    cancelReason: text("cancel_reason"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    /** The recurring programme that generated this audit, if any. */
    programmeId: uuid("programme_id").references(() => qualityAuditProgrammes.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("quality_audits_reference_key").on(t.workspaceId, t.reference),
    index("quality_audits_planned_idx").on(t.workspaceId, t.plannedOn),
  ],
);

/** Something that went wrong, its root cause, and the corrective and preventive action (CAPA). */
export const qualityNonconformances = pgTable(
  "quality_nonconformances",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    reference: text("reference").notNull(),
    raisedOn: date("raised_on").notNull(),
    source: text("source").$type<NonconformanceSource>().notNull(),
    severity: text("severity").$type<QualitySeverity>().notNull(),
    status: text("status").$type<NonconformanceStatus>().notNull().default("open"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    complaintId: uuid("complaint_id").references(() => qualityComplaints.id),
    auditId: uuid("audit_id").references(() => qualityAudits.id),
    itemId: uuid("item_id").references(() => items.id),
    lotId: uuid("lot_id").references(() => stockLots.id),
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    containment: text("containment"),
    rootCause: text("root_cause"),
    correctiveAction: text("corrective_action"),
    preventiveAction: text("preventive_action"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    dueOn: date("due_on"),
    /** When it was last marked `action_taken`, and by whom (the verifier may not be the same person). */
    actionTakenAt: ts("action_taken_at"),
    actionTakenBy: uuid("action_taken_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    /** Closing is verifying the action worked: who, when and how it was checked. */
    closedAt: ts("closed_at"),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    verificationNote: text("verification_note"),
    reopenedAt: ts("reopened_at"),
    reopenReason: text("reopen_reason"),
    /**
     * Supplier non-conformances: a manager recorded that this one was weighed when the supplier's
     * approval was decided (the approval itself stays in the items module): when, by whom, and
     * the approval status it was left at.
     */
    supplierReviewedAt: ts("supplier_reviewed_at"),
    supplierReviewedBy: uuid("supplier_reviewed_by").references(() => users.id, { onDelete: "set null" }),
    supplierReviewStatus: text("supplier_review_status").$type<SupplierApprovalStatus>(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("quality_nonconformances_reference_key").on(t.workspaceId, t.reference),
    index("quality_nonconformances_status_idx").on(t.workspaceId, t.status, t.dueOn),
    index("quality_nonconformances_complaint_idx").on(t.complaintId),
    index("quality_nonconformances_audit_idx").on(t.auditId),
  ],
);

/**
 * A mock recall: one lot traced and reconciled against the clock. Append-only: the result is
 * worked out once, when it is recorded; a record made in error is voided (who, when, why), never
 * changed or deleted.
 */
export const qualityRecallTests = pgTable(
  "quality_recall_tests",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    reference: text("reference").notNull(),
    conductedOn: date("conducted_on").notNull(),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => stockLots.id),
    direction: text("direction").$type<RecallDirection>().notNull(),
    scenario: text("scenario"),
    startedAt: ts("started_at").notNull(),
    completedAt: ts("completed_at").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    /** In the lot item's unit at the time (`unit`). */
    quantityExpected: numeric("quantity_expected", { precision: 18, scale: 6, mode: "number" }).notNull(),
    quantityTraced: numeric("quantity_traced", { precision: 18, scale: 6, mode: "number" }).notNull(),
    unit: text("unit").notNull(),
    reconciledPercent: numeric("reconciled_percent", { precision: 8, scale: 1, mode: "number" }),
    passed: boolean("passed").notNull(),
    notes: text("notes"),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    voidedAt: ts("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("quality_recall_tests_reference_key").on(t.workspaceId, t.reference),
    index("quality_recall_tests_conducted_idx").on(t.workspaceId, t.conductedOn),
    index("quality_recall_tests_lot_idx").on(t.lotId),
  ],
);
