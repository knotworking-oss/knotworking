/**
 * Testing module: laboratories, sampling points, sampling plans, samples and results.
 * See docs/modules.md and `@knotworking/core` testing.ts.
 *
 * A sample's analytes and limits are copied onto its result rows when it is logged, so a later
 * change to a plan or specification never re-judges a recorded result. Results are corrected in
 * place with the previous values appended to `history`. Only metadata goes to the sync log.
 */
import type {
  AnalyteInput,
  SamplingPointKind,
  SpecificationParameterCategory,
  TestInvestigationStatus,
  TestOutcome,
  TestSampleStatus,
  TestSubject,
  TestingRecordStatus,
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
} from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { items } from "./items";
import { specificationParameters, specificationVersions } from "./specifications";
import { stockLots } from "./stock";

export const testingLaboratories = pgTable(
  "testing_laboratories",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    accreditation: text("accreditation"),
    accreditationExpiresOn: date("accreditation_expires_on"),
    inHouse: boolean("in_house").notNull().default(false),
    contact: text("contact"),
    notes: text("notes"),
    status: text("status").$type<TestingRecordStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [index("testing_laboratories_workspace_idx").on(t.workspaceId, t.name)],
);

export const testingSamplingPoints = pgTable(
  "testing_sampling_points",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: text("kind").$type<SamplingPointKind>().notNull(),
    zone: text("zone"),
    location: text("location"),
    status: text("status").$type<TestingRecordStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("testing_sampling_points_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/** A risk-based schedule: sample this item's lots, or this point, every `frequency_days`. */
export const testingPlans = pgTable(
  "testing_plans",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    subject: text("subject").$type<TestSubject>().notNull(),
    itemId: uuid("item_id").references(() => items.id),
    samplingPointId: uuid("sampling_point_id").references(() => testingSamplingPoints.id),
    frequencyDays: integer("frequency_days").notNull(),
    rationale: text("rationale"),
    laboratoryId: uuid("laboratory_id").references(() => testingLaboratories.id),
    /** Empty on a lot plan: the item's approved specification's parameters. */
    analytes: jsonb("analytes").$type<AnalyteInput[]>().notNull().default([]),
    /** The business date the plan started: due straight away until a sample is taken. */
    startedOn: date("started_on").notNull(),
    status: text("status").$type<TestingRecordStatus>().notNull().default("active"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [index("testing_plans_workspace_idx").on(t.workspaceId, t.status)],
);

export const testingSamples = pgTable(
  "testing_samples",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** `S-2026-0001`, unique in the workspace. */
    reference: text("reference").notNull(),
    subject: text("subject").$type<TestSubject>().notNull(),
    lotId: uuid("lot_id").references(() => stockLots.id),
    /** Denormalised from the lot. */
    itemId: uuid("item_id").references(() => items.id),
    samplingPointId: uuid("sampling_point_id").references(() => testingSamplingPoints.id),
    planId: uuid("plan_id").references(() => testingPlans.id),
    laboratoryId: uuid("laboratory_id").references(() => testingLaboratories.id),
    /** The approved specification version the limits came from, when they did. */
    specificationVersionId: uuid("specification_version_id").references(() => specificationVersions.id),
    sampledOn: date("sampled_on").notNull(),
    sampledBy: text("sampled_by"),
    notes: text("notes"),
    status: text("status").$type<TestSampleStatus>().notNull().default("awaiting_results"),
    /** From the results (stored for filtering): any fail fails the sample. */
    outcome: text("outcome").$type<TestOutcome>().notNull().default("pending"),
    completedAt: ts("completed_at"),
    cancelledAt: ts("cancelled_at"),
    cancelledBy: uuid("cancelled_by").references(() => users.id, { onDelete: "set null" }),
    cancelReason: text("cancel_reason"),
    /** Opened by a failed result; closed by a person with manage. */
    investigationStatus: text("investigation_status").$type<TestInvestigationStatus>(),
    investigationOpenedAt: ts("investigation_opened_at"),
    findings: text("findings"),
    rootCause: text("root_cause"),
    actionTaken: text("action_taken"),
    investigationClosedAt: ts("investigation_closed_at"),
    investigationClosedBy: uuid("investigation_closed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** True when a failed result of this sample put its lot on hold. */
    lotHeld: boolean("lot_held").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("testing_samples_reference_key").on(t.workspaceId, sql`lower(${t.reference})`),
    index("testing_samples_sampled_idx").on(t.workspaceId, t.sampledOn),
    index("testing_samples_lot_idx").on(t.lotId),
    index("testing_samples_point_idx").on(t.samplingPointId),
    index("testing_samples_plan_idx").on(t.planId, t.sampledOn),
  ],
);

export interface TestResultHistoryEntry {
  value: number | null;
  valueText: string | null;
  outcome: TestOutcome;
  reportedOn: string | null;
  reportReference: string | null;
  recordedBy: string | null;
  recordedAt: string | null;
  /** Why it was replaced. */
  reason: string;
}

/** One analyte of a sample: the limit it was judged against (a snapshot) and the result. */
export const testingResults = pgTable(
  "testing_results",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    sampleId: uuid("sample_id")
      .notNull()
      .references(() => testingSamples.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    category: text("category").$type<SpecificationParameterCategory>().notNull(),
    name: text("name").notNull(),
    unit: text("unit"),
    min: numeric("min", { precision: 18, scale: 6, mode: "number" }),
    max: numeric("max", { precision: 18, scale: 6, mode: "number" }),
    limitText: text("limit_text"),
    method: text("method"),
    /** The specification parameter the limit was copied from, when it was. */
    specificationParameterId: uuid("specification_parameter_id").references(() => specificationParameters.id),
    value: numeric("value", { precision: 18, scale: 6, mode: "number" }),
    valueText: text("value_text"),
    outcome: text("outcome").$type<TestOutcome>().notNull().default("pending"),
    reportedOn: date("reported_on"),
    reportReference: text("report_reference"),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    recordedAt: ts("recorded_at"),
    history: jsonb("history").$type<TestResultHistoryEntry[]>().notNull().default([]),
    ...timestamps(),
  },
  (t) => [
    index("testing_results_sample_idx").on(t.sampleId, t.sortOrder),
    index("testing_results_name_idx").on(t.workspaceId, sql`lower(${t.name})`),
  ],
);
