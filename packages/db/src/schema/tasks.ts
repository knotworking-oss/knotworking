/**
 * Tasks module (`tasks`): workflow states, labels, projects, tasks, their labels and
 * dependencies, and comments. Teams are platform (`../schema`). See docs/modules.md.
 */
import type {
  DocContent,
  ProjectHealth,
  ProjectStatus,
  TagColorName,
  WorkflowStateType,
} from "@knotworking/core";
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { teams, users } from "../schema";
import { documents } from "./docs";
import { pk, timestamps, ts, workspaceRef } from "./helpers";

// ─── Workflow ────────────────────────────────────────────────────────────────

export const workflowStates = pgTable(
  "workflow_states",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").$type<WorkflowStateType>().notNull(),
    description: text("description"),
    sortOrder: text("sort_order").notNull(),
    ...timestamps(),
  },
  (t) => [index("workflow_states_team_idx").on(t.teamId)],
);

export const labels = pgTable(
  "labels",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** Null = workspace-wide label, available to every team. */
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").$type<TagColorName>().notNull().default("gray"),
    ...timestamps(),
  },
  (t) => [index("labels_workspace_idx").on(t.workspaceId)],
);

// ─── Projects ────────────────────────────────────────────────────────────────

export const projects = pgTable(
  "projects",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon"),
    color: text("color").$type<TagColorName>().notNull().default("purple"),
    status: text("status").$type<ProjectStatus>().notNull().default("planned"),
    health: text("health").$type<ProjectHealth>(),
    leadId: uuid("lead_id").references(() => users.id, { onDelete: "set null" }),
    startDate: date("start_date"),
    targetDate: date("target_date"),
    sortOrder: text("sort_order").notNull(),
    completedAt: ts("completed_at"),
    ...timestamps(),
  },
  (t) => [index("projects_workspace_idx").on(t.workspaceId)],
);

/** Projects can span multiple teams. */
export const projectTeams = pgTable(
  "project_teams",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    ...timestamps(),
  },
  (t) => [uniqueIndex("project_teams_project_team_key").on(t.projectId, t.teamId)],
);

// ─── Tasks ──────────────────────────────────────────────────────────────────

export const tasks = pgTable(
  "tasks",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: jsonb("description").$type<DocContent>(),
    stateId: uuid("state_id")
      .notNull()
      .references(() => workflowStates.id),
    /** 0 none · 1 urgent · 2 high · 3 medium · 4 low */
    priority: smallint("priority").notNull().default(0),
    /** Time estimate in minutes, compared with the task's logged `time_entries`. */
    estimateMinutes: integer("estimate_minutes"),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    creatorId: uuid("creator_id").references(() => users.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => tasks.id, { onDelete: "set null" }),
    /** When work is planned to begin (Gantt bars run start → due). Never after `due_date`. */
    startDate: date("start_date"),
    dueDate: date("due_date"),
    sortOrder: text("sort_order").notNull(),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    canceledAt: ts("canceled_at"),
    ...timestamps(),
  },
  (t) => [
    index("tasks_workspace_updated_idx").on(t.workspaceId, t.updatedAt),
    index("tasks_team_state_idx").on(t.teamId, t.stateId),
    index("tasks_assignee_idx").on(t.assigneeId),
    index("tasks_project_idx").on(t.projectId),
    index("tasks_parent_idx").on(t.parentId),
  ],
);

export const taskLabels = pgTable(
  "task_labels",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
    ...timestamps(),
  },
  (t) => [uniqueIndex("task_labels_task_label_key").on(t.taskId, t.labelId)],
);

/**
 * Dependencies: `blocking_task_id` blocks `blocked_task_id` (read the other way,
 * the blocked task is "blocked by" it). One row per ordered pair; self-relations
 * and cycles are rejected by the API. Like `task_labels`, rows are hard-deleted
 * (the unique pair can then be re-created) and the delete is still recorded in
 * the sync log as a tombstone.
 */
export const taskRelations = pgTable(
  "task_relations",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    blockingTaskId: uuid("blocking_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    blockedTaskId: uuid("blocked_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    creatorId: uuid("creator_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("task_relations_blocking_blocked_key").on(t.blockingTaskId, t.blockedTaskId),
    index("task_relations_blocked_idx").on(t.blockedTaskId),
    index("task_relations_workspace_idx").on(t.workspaceId),
    check("task_relations_not_self", sql`${t.blockingTaskId} <> ${t.blockedTaskId}`),
  ],
);

// ─── Comments ────────────────────────────────────────────────────────────────

export const comments = pgTable(
  "comments",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
    /** Threaded replies. */
    parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    body: jsonb("body").$type<DocContent>().notNull(),
    editedAt: ts("edited_at"),
    ...timestamps(),
  },
  (t) => [index("comments_task_idx").on(t.taskId), index("comments_document_idx").on(t.documentId)],
);
