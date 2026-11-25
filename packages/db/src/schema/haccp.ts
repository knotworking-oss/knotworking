/**
 * Food safety records module (`haccp`): the HACCP plan under document control, CCP monitoring
 * logs, corrective actions, and cleaning and calibration records.
 * See docs/modules.md and `@knotworking/core` haccp.ts.
 *
 * Monitoring logs and cleaning and calibration records are append-only: no route updates or
 * deletes them (a cleaning record's verification and a CCP log's review are one-time stamps). A
 * correction is a new row that points at the one it corrects.
 */
import type {
  CcpInput,
  CcpLimitType,
  DecisionAnswers,
  CcpLogReviewStatus,
  CheckFrequencyUnit,
  CorrectiveActionStatus,
  DeviationReason,
  HaccpHazardType,
  HaccpPlanStatus,
  HaccpPlanVersionStatus,
  HaccpSource,
  ProcessStepInput,
  ScheduleFrequencyUnit,
} from "@knotworking/core";
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
import { assets } from "./assets";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { productionBatches } from "./production";
import { stockLots } from "./stock";

const value = (name: string) => numeric(name, { precision: 14, scale: 4, mode: "number" });

/** A HACCP plan: the stable identity of a controlled document. The content lives in versions. */
export const haccpPlans = pgTable(
  "haccp_plans",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** Document reference, e.g. `HACCP-01`. Unique among live plans, case-insensitively. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    reviewIntervalMonths: integer("review_interval_months").notNull().default(12),
    /**
     * The hazard analysis is reviewed on its own cycle, apart from the plan's review date (which
     * belongs to each approved version). Null interval: the plan's review interval applies.
     */
    hazardReviewIntervalMonths: integer("hazard_review_interval_months"),
    /** When the hazard analysis is next due for review. Null: no analysis has been approved yet. */
    hazardReviewDueOn: date("hazard_review_due_on"),
    /** The last review (an approval of a version with a hazard analysis counts as one). */
    hazardReviewedOn: date("hazard_reviewed_on"),
    hazardReviewedBy: uuid("hazard_reviewed_by").references(() => users.id, { onDelete: "set null" }),
    hazardReviewNote: text("hazard_review_note"),
    status: text("status").$type<HaccpPlanStatus>().notNull().default("active"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("haccp_plans_workspace_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * One version of a plan. At most one draft (the only editable version) and one approved version
 * per plan; approving supersedes the previous approved version. Approved and superseded versions
 * never change.
 */
export const haccpPlanVersions = pgTable(
  "haccp_plan_versions",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => haccpPlans.id, { onDelete: "cascade" }),
    /** 1, 2, … per plan. */
    versionNumber: integer("version_number").notNull(),
    status: text("status").$type<HaccpPlanVersionStatus>().notNull().default("draft"),
    /** Products (items) the plan covers. Empty with no recipes either: the whole site. */
    scopeItemIds: jsonb("scope_item_ids").$type<string[]>().notNull().default([]),
    scopeRecipeIds: jsonb("scope_recipe_ids").$type<string[]>().notNull().default([]),
    scopeNote: text("scope_note"),
    changeNote: text("change_note"),
    effectiveOn: date("effective_on"),
    reviewDueOn: date("review_due_on"),
    /** The sign-off. */
    approvedAt: ts("approved_at"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvalNote: text("approval_note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("haccp_plan_versions_number_key").on(t.planId, t.versionNumber),
    uniqueIndex("haccp_plan_versions_one_draft_key")
      .on(t.planId)
      .where(sql`${t.status} = 'draft' and ${t.deletedAt} is null`),
    uniqueIndex("haccp_plan_versions_one_approved_key")
      .on(t.planId)
      .where(sql`${t.status} = 'approved' and ${t.deletedAt} is null`),
  ],
);

/** A hazard at a process step: the analysis, the control measure and the decision tree answers. */
export interface StepHazard extends DecisionAnswers {
  hazardType: HaccpHazardType;
  description: string;
  likelihood: number;
  severity: number;
  controlMeasure: string | null;
  justification: string | null;
}

/**
 * A process step of a plan version's hazard analysis, in order, with its hazards. Versioned with
 * the plan: an approved version's steps never change (a draft's are replaced when it is saved).
 */
export const haccpProcessSteps = pgTable(
  "haccp_process_steps",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => haccpPlanVersions.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    name: text("name").notNull(),
    description: text("description"),
    hazards: jsonb("hazards").$type<StepHazard[]>().notNull().default([]),
    ...timestamps(),
  },
  (t) => [index("haccp_process_steps_version_idx").on(t.versionId, t.sortOrder)],
);

/**
 * The workspace's hazard library: reusable hazard entries a plan's hazard analysis copies from.
 * Copying is by value (the plan version keeps its own copy), so editing or deleting an entry never
 * changes an approved plan.
 */
export const haccpHazardLibrary = pgTable(
  "haccp_hazard_library",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** Short name to find it by, e.g. "Listeria in ready-to-eat chilled food". */
    title: text("title").notNull(),
    /** A process step it typically belongs to, e.g. "Cooking": a search aid, not a link. */
    stepName: text("step_name"),
    hazardType: text("hazard_type").$type<HaccpHazardType>().notNull(),
    description: text("description").notNull(),
    likelihood: integer("likelihood").notNull(),
    severity: integer("severity").notNull(),
    controlMeasure: text("control_measure"),
    justification: text("justification"),
    q1: boolean("q1"),
    q2: boolean("q2"),
    q3: boolean("q3"),
    q4: boolean("q4"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [index("haccp_hazard_library_workspace_idx").on(t.workspaceId, t.hazardType)],
);

/** A plan template's content: a hazard analysis and CCPs, in the shape of a draft (without scope). */
export interface PlanTemplateContent {
  steps: ProcessStepInput[];
  ccps: CcpInput[];
}

/**
 * A plan template: a reusable starting point (process steps with hazards, and CCPs) a new plan is
 * started from. Copied by value into the new plan's draft; it never links to the plan afterwards.
 */
export const haccpPlanTemplates = pgTable(
  "haccp_plan_templates",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    description: text("description"),
    content: jsonb("content").$type<PlanTemplateContent>().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [index("haccp_plan_templates_workspace_idx").on(t.workspaceId)],
);

/**
 * A critical control point of a plan version: the step, the hazard, the critical limits, how and
 * how often it is monitored, who by, what to do when the limit is breached, and how it is
 * verified. Rows of an approved version never change; logs pin the row they were checked against.
 */
export const haccpCcps = pgTable(
  "haccp_ccps",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => haccpPlanVersions.id, { onDelete: "cascade" }),
    /** e.g. `CCP1`; unique within the version. Logs follow a CCP across versions by its code. */
    code: text("code").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /** The step of the hazard analysis this CCP sits at, when the plan has one. */
    stepId: uuid("step_id").references((): AnyPgColumn => haccpProcessSteps.id, { onDelete: "set null" }),
    processStep: text("process_step").notNull(),
    hazardType: text("hazard_type").$type<HaccpHazardType>().notNull(),
    hazard: text("hazard").notNull(),
    limitType: text("limit_type").$type<CcpLimitType>().notNull(),
    limitMin: value("limit_min"),
    limitMax: value("limit_max"),
    limitUnit: text("limit_unit"),
    passCriterion: text("pass_criterion"),
    monitoringMethod: text("monitoring_method").notNull(),
    frequencyEvery: integer("frequency_every").notNull(),
    frequencyUnit: text("frequency_unit").$type<CheckFrequencyUnit>().notNull(),
    duringProduction: boolean("during_production").notNull().default(false),
    responsibleRole: text("responsible_role").notNull(),
    correctiveAction: text("corrective_action").notNull(),
    verification: text("verification").notNull(),
    ...timestamps(),
  },
  (t) => [
    index("haccp_ccps_version_idx").on(t.versionId, t.sortOrder),
    uniqueIndex("haccp_ccps_version_code_key").on(t.versionId, sql`lower(${t.code})`),
  ],
);

/**
 * A CCP check. **Append-only**: never deleted, and never updated except for the one-time review
 * stamp (`review_status`, `reviewed_by`, `reviewed_at`, `review_note`) on a reading an API token
 * recorded, like a cleaning record's verification. Pinned to the CCP row of the approved version it
 * was checked against; `within_limits` is worked out by `evaluateReading` when it is written. A
 * correction is a new row with `corrects_log_id`.
 */
export const haccpCcpLogs = pgTable(
  "haccp_ccp_logs",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => haccpPlans.id),
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => haccpPlanVersions.id),
    ccpId: uuid("ccp_id")
      .notNull()
      .references(() => haccpCcps.id),
    /** Denormalised from the CCP: follows it across versions. */
    ccpCode: text("ccp_code").notNull(),
    batchId: uuid("batch_id").references(() => productionBatches.id),
    /** A measured reading (range limits), in the CCP's unit. */
    value: value("value"),
    /** A pass/fail reading. */
    passed: boolean("passed"),
    withinLimits: boolean("within_limits").notNull(),
    deviationReason: text("deviation_reason").$type<DeviationReason>(),
    note: text("note"),
    source: text("source").$type<HaccpSource>().notNull().default("manual"),
    checkedAt: ts("checked_at").notNull(),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    correctsLogId: uuid("corrects_log_id").references((): AnyPgColumn => haccpCcpLogs.id),
    correctionReason: text("correction_reason"),
    /**
     * The review: a person's own reading is `approved` when written (stamped with them and the
     * time); a reading from an API token is `pending` until a person with `manage` approves or
     * rejects it. The only change a log ever takes, once.
     */
    reviewStatus: text("review_status").$type<CcpLogReviewStatus>().notNull().default("pending"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: ts("reviewed_at"),
    reviewNote: text("review_note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("haccp_ccp_logs_workspace_checked_idx").on(t.workspaceId, t.checkedAt),
    index("haccp_ccp_logs_ccp_idx").on(t.planId, t.ccpCode, t.checkedAt),
    index("haccp_ccp_logs_batch_idx").on(t.batchId),
    /** The review queue. */
    index("haccp_ccp_logs_pending_idx")
      .on(t.workspaceId, t.checkedAt)
      .where(sql`${t.reviewStatus} = 'pending'`),
    /** A log is corrected once. */
    uniqueIndex("haccp_ccp_logs_corrects_key")
      .on(t.correctsLogId)
      .where(sql`${t.correctsLogId} is not null`),
  ],
);

/**
 * HACCP's part of an asset of the register (`assets`, kind `area` or `equipment`): its cleaning and
 * calibration schedule. One row per asset, keyed by the asset's id; an asset without a row is in
 * neither schedule. The asset itself (kind, code, name, location, status) lives in `assets`.
 */
export const haccpAssets = pgTable("haccp_assets", {
  id: uuid("id")
    .primaryKey()
    .references(() => assets.id),
  workspaceId: workspaceRef(),
  cleaningEvery: integer("cleaning_every"),
  cleaningUnit: text("cleaning_unit").$type<ScheduleFrequencyUnit>(),
  calibrationEvery: integer("calibration_every"),
  calibrationUnit: text("calibration_unit").$type<ScheduleFrequencyUnit>(),
  calibrationTolerance: value("calibration_tolerance"),
  measurementUnit: text("measurement_unit"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * A cleaning done. **Append-only**, except the one-time verification stamp by a second person.
 */
export const haccpCleaningRecords = pgTable(
  "haccp_cleaning_records",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    cleanedAt: ts("cleaned_at").notNull(),
    doneBy: uuid("done_by").references(() => users.id, { onDelete: "set null" }),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    verifiedAt: ts("verified_at"),
    verifiedBy: uuid("verified_by").references(() => users.id, { onDelete: "set null" }),
    verificationNote: text("verification_note"),
    /** A correction points at the record it replaces; a record is corrected once. */
    correctsRecordId: uuid("corrects_record_id").references((): AnyPgColumn => haccpCleaningRecords.id),
    correctionReason: text("correction_reason"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("haccp_cleaning_records_asset_idx").on(t.assetId, t.cleanedAt),
    uniqueIndex("haccp_cleaning_records_corrects_key")
      .on(t.correctsRecordId)
      .where(sql`${t.correctsRecordId} is not null`),
  ],
);

/**
 * A calibration check of a piece of equipment against a reference. **Append-only**. The tolerance
 * and unit are copied from the equipment at the time, so a later change doesn't rewrite history.
 */
export const haccpCalibrationRecords = pgTable(
  "haccp_calibration_records",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    calibratedAt: ts("calibrated_at").notNull(),
    referenceReading: value("reference_reading").notNull(),
    actualReading: value("actual_reading").notNull(),
    tolerance: value("tolerance"),
    unit: text("unit"),
    passed: boolean("passed").notNull(),
    method: text("method"),
    nextDueOn: date("next_due_on"),
    note: text("note"),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    correctsRecordId: uuid("corrects_record_id").references((): AnyPgColumn => haccpCalibrationRecords.id),
    correctionReason: text("correction_reason"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("haccp_calibration_records_asset_idx").on(t.assetId, t.calibratedAt),
    uniqueIndex("haccp_calibration_records_corrects_key")
      .on(t.correctsRecordId)
      .where(sql`${t.correctsRecordId} is not null`),
  ],
);

/**
 * A supervisor's sign-off of a plan's monitoring records for one day. **Append-only**, one per plan
 * per day. The counts are what the sign-off covered when it was made.
 */
export const haccpDaySignoffs = pgTable(
  "haccp_day_signoffs",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => haccpPlans.id),
    /** The calendar day in the workspace's time zone. */
    day: date("day").notNull(),
    signedBy: uuid("signed_by").references(() => users.id, { onDelete: "set null" }),
    signedAt: ts("signed_at").notNull().defaultNow(),
    note: text("note"),
    checkCount: integer("check_count").notNull(),
    deviationCount: integer("deviation_count").notNull(),
  },
  (t) => [uniqueIndex("haccp_day_signoffs_plan_day_key").on(t.planId, t.day)],
);

/**
 * A corrective action: what was done about a deviation, why it happened and how it is prevented.
 * Open while it is worked on; closed (and then never changed) by a person with `manage`.
 */
export const haccpCorrectiveActions = pgTable(
  "haccp_corrective_actions",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    title: text("title").notNull(),
    /** The deviation: an out-of-limit log. */
    logId: uuid("log_id").references(() => haccpCcpLogs.id),
    /** A failed calibration. */
    calibrationId: uuid("calibration_id").references(() => haccpCalibrationRecords.id),
    batchId: uuid("batch_id").references(() => productionBatches.id),
    /** A stock lot affected (e.g. put into quarantine on the stock lot page). */
    lotId: uuid("lot_id").references(() => stockLots.id),
    actionTaken: text("action_taken"),
    rootCause: text("root_cause"),
    preventiveAction: text("preventive_action"),
    status: text("status").$type<CorrectiveActionStatus>().notNull().default("open"),
    source: text("source").$type<HaccpSource>().notNull().default("manual"),
    raisedBy: uuid("raised_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    /** The sign-off. */
    closedAt: ts("closed_at"),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    closureNote: text("closure_note"),
    ...timestamps(),
  },
  (t) => [
    index("haccp_corrective_actions_workspace_idx").on(t.workspaceId, t.status, t.createdAt),
    index("haccp_corrective_actions_log_idx").on(t.logId),
    index("haccp_corrective_actions_batch_idx").on(t.batchId),
  ],
);
