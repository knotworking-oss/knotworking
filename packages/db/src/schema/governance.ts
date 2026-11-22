/**
 * Governance module: objectives, the culture plan, confidential concerns, the requirement
 * register and management reviews. See docs/modules.md and `@knotworking/core` governance.ts.
 *
 * Confidential concerns are never written to the sync log, and an anonymous concern stores no
 * trace of who raised it.
 */
import type {
  ClauseAssessmentStatus,
  ClauseDraftState,
  EvidenceCheckId,
  GovernanceComplianceStatus,
  GovernanceConcernCategory,
  GovernanceConcernStatus,
  GovernanceCultureKind,
  GovernanceDecision,
  GovernanceObjectiveCategory,
  GovernanceObjectiveStatus,
  GovernanceProgress,
  GovernanceRequirementSource,
  GovernanceReviewStatus,
  StandardStatus,
} from "@knotworking/core";
import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { teams, users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";

export const governanceObjectives = pgTable(
  "governance_objectives",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    title: text("title").notNull(),
    category: text("category").$type<GovernanceObjectiveCategory>().notNull(),
    measure: text("measure"),
    target: text("target"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    dueOn: date("due_on"),
    status: text("status").$type<GovernanceObjectiveStatus>().notNull().default("open"),
    /** Progress reports, oldest first. */
    progress: jsonb("progress").$type<GovernanceProgress[]>().notNull().default([]),
    closedAt: ts("closed_at"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [index("governance_objectives_workspace_idx").on(t.workspaceId, t.status)],
);

export const governanceCultureActivities = pgTable(
  "governance_culture_activities",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    title: text("title").notNull(),
    kind: text("kind").$type<GovernanceCultureKind>().notNull(),
    plannedOn: date("planned_on").notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    measure: text("measure"),
    objectiveId: uuid("objective_id").references(() => governanceObjectives.id, { onDelete: "set null" }),
    completedOn: date("completed_on"),
    participants: integer("participants"),
    result: text("result"),
    cancelledAt: ts("cancelled_at"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [index("governance_culture_planned_idx").on(t.workspaceId, t.plannedOn)],
);

/** A confidential concern. Never synced; read only by members with `manage` on Governance. */
export const governanceConcerns = pgTable(
  "governance_concerns",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** CON-0001, … per workspace. */
    reference: text("reference").notNull(),
    category: text("category").$type<GovernanceConcernCategory>().notNull(),
    description: text("description").notNull(),
    /** Null when raised anonymously: nothing else records who raised it. */
    raisedBy: uuid("raised_by").references(() => users.id, { onDelete: "set null" }),
    raisedOn: date("raised_on").notNull(),
    status: text("status").$type<GovernanceConcernStatus>().notNull().default("open"),
    investigation: text("investigation"),
    /** What the reporter is told. */
    outcome: text("outcome"),
    handledBy: uuid("handled_by").references(() => users.id, { onDelete: "set null" }),
    closedAt: ts("closed_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("governance_concerns_reference_key").on(t.workspaceId, t.reference),
    index("governance_concerns_status_idx").on(t.workspaceId, t.status),
  ],
);

export const governanceRequirements = pgTable(
  "governance_requirements",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    source: text("source").$type<GovernanceRequirementSource>().notNull(),
    reference: text("reference"),
    title: text("title").notNull(),
    customerName: text("customer_name"),
    description: text("description"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    compliance: text("compliance").$type<GovernanceComplianceStatus>().notNull().default("not_assessed"),
    lastReviewedOn: date("last_reviewed_on"),
    lastReviewedBy: uuid("last_reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewNotes: text("review_notes"),
    reviewDueOn: date("review_due_on"),
    status: text("status").$type<"active" | "archived">().notNull().default("active"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [index("governance_requirements_workspace_idx").on(t.workspaceId, t.status)],
);

export const governanceReviews = pgTable(
  "governance_reviews",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    title: text("title").notNull(),
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),
    heldOn: date("held_on"),
    attendees: text("attendees"),
    notes: jsonb("notes").$type<Record<string, string>>().notNull().default({}),
    resources: text("resources"),
    decisions: jsonb("decisions")
      .$type<(GovernanceDecision & { taskId?: string | null })[]>()
      .notNull()
      .default([]),
    followUpTeamId: uuid("follow_up_team_id").references(() => teams.id, { onDelete: "set null" }),
    status: text("status").$type<GovernanceReviewStatus>().notNull().default("draft"),
    /** The evidence as it stood when the review was signed. */
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    signedAt: ts("signed_at"),
    signedBy: uuid("signed_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [index("governance_reviews_workspace_idx").on(t.workspaceId, t.periodTo)],
);

/**
 * A standard and issue in the library (G1): BRCGS Food Safety Issue 9, a customer's code. A new
 * issue is a new record, so assessments against the old one stay. Archived, never deleted.
 */
export const governanceStandards = pgTable(
  "governance_standards",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    issue: text("issue").notNull(),
    publisher: text("publisher"),
    status: text("status").$type<StandardStatus>().notNull().default("active"),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("governance_standards_code_issue_key")
      .on(t.workspaceId, sql`lower(${t.code})`, sql`lower(${t.issue})`)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * A clause of a standard, imported from the workspace's own licensed copy. Unique by reference
 * within the standard; a re-import updates its title and text.
 */
export const governanceStandardClauses = pgTable(
  "governance_standard_clauses",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    standardId: uuid("standard_id")
      .notNull()
      .references(() => governanceStandards.id),
    ref: text("ref").notNull(),
    title: text("title").notNull(),
    text: text("text"),
    section: text("section").notNull(),
    sectionTitle: text("section_title"),
    fundamental: boolean("fundamental").notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("governance_standard_clauses_ref_key")
      .on(t.standardId, sql`lower(${t.ref})`)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * A person's assessment of a clause. **Append-only**: the latest is the clause's state; earlier
 * ones are its history.
 */
export const governanceClauseAssessments = pgTable(
  "governance_clause_assessments",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    clauseId: uuid("clause_id")
      .notNull()
      .references(() => governanceStandardClauses.id),
    standardId: uuid("standard_id")
      .notNull()
      .references(() => governanceStandards.id),
    status: text("status").$type<ClauseAssessmentStatus>().notNull(),
    note: text("note"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    dueOn: date("due_on"),
    assessedBy: uuid("assessed_by").references(() => users.id, { onDelete: "set null" }),
    assessedAt: ts("assessed_at").notNull().defaultNow(),
  },
  (t) => [index("governance_clause_assessments_clause_idx").on(t.clauseId, t.assessedAt)],
);

/** A task raised to close a finding on a clause. */
export const governanceClauseTasks = pgTable(
  "governance_clause_tasks",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    clauseId: uuid("clause_id")
      .notNull()
      .references(() => governanceStandardClauses.id),
    taskId: uuid("task_id").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("governance_clause_tasks_clause_idx").on(t.clauseId)],
);

/**
 * An evidence check mapped to a clause by a person (G2): the clause's evidence includes the check's
 * live result. Replaced as a set per clause; removed rows are soft-deleted.
 */
export const governanceClauseEvidence = pgTable(
  "governance_clause_evidence",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    clauseId: uuid("clause_id")
      .notNull()
      .references(() => governanceStandardClauses.id),
    checkId: text("check_id").$type<EvidenceCheckId>().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("governance_clause_evidence_key")
      .on(t.clauseId, t.checkId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * A drafted finding on a clause (G3), usually from an agent: a proposal that counts for nothing
 * until a person accepts it (recording their own assessment) or dismisses it. One open per clause.
 */
export const governanceClauseDrafts = pgTable(
  "governance_clause_drafts",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    clauseId: uuid("clause_id")
      .notNull()
      .references(() => governanceStandardClauses.id),
    standardId: uuid("standard_id")
      .notNull()
      .references(() => governanceStandards.id),
    status: text("status").$type<ClauseAssessmentStatus>().notNull(),
    note: text("note").notNull(),
    rationale: text("rationale"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    dueOn: date("due_on"),
    /** Whether an agent (API token) or a person drafted it. */
    draftedVia: text("drafted_via").$type<"agent" | "person">().notNull(),
    draftedBy: uuid("drafted_by").references(() => users.id, { onDelete: "set null" }),
    state: text("state").$type<ClauseDraftState>().notNull().default("open"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: ts("decided_at"),
    decisionNote: text("decision_note"),
    /** The assessment the person recorded on accepting it. */
    assessmentId: uuid("assessment_id").references(() => governanceClauseAssessments.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("governance_clause_drafts_open_key")
      .on(t.clauseId)
      .where(sql`${t.state} = 'open' and ${t.deletedAt} is null`),
    index("governance_clause_drafts_standard_idx").on(t.standardId, t.state),
  ],
);

/**
 * A frozen copy of a standard's gap analysis (G3), e.g. taken before an audit. Never edited.
 * `payload` holds every clause as the taker saw it; evidence the viewer can't read is hidden on
 * read. Only the header is synced.
 */
export const governanceGapSnapshots = pgTable(
  "governance_gap_snapshots",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    standardId: uuid("standard_id")
      .notNull()
      .references(() => governanceStandards.id),
    label: text("label").notNull(),
    /** The workspace date it was taken on. */
    takenOn: date("taken_on").notNull(),
    takenBy: uuid("taken_by").references(() => users.id, { onDelete: "set null" }),
    clauseCount: integer("clause_count").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    ...timestamps(),
  },
  (t) => [index("governance_gap_snapshots_standard_idx").on(t.standardId, t.createdAt)],
);
