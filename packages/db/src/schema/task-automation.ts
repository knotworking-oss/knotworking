import type {
  AutomationAction,
  AutomationTrigger,
  RecurrenceSchedule,
  TaskCreateInput,
  TaskFilter,
} from "@knotworking/core";
import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { teams, users } from "../schema";
import { pk, ts, workspaceRef } from "./helpers";
import { tasks } from "./tasks";

export const taskRecurrences = pgTable(
  "task_recurrences",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    sourceTaskId: uuid("source_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    template: jsonb("template").$type<TaskCreateInput>().notNull(),
    schedule: jsonb("schedule").$type<RecurrenceSchedule>().notNull(),
    nextOn: date("next_on").notNull(),
    previousTaskId: uuid("previous_task_id").references(() => tasks.id, { onDelete: "set null" }),
    enabled: boolean("enabled").notNull().default(true),
    lastError: text("last_error"),
  },
  (row) => [
    uniqueIndex("task_recurrences_source_key").on(row.workspaceId, row.sourceTaskId),
    index("task_recurrences_due_idx")
      .on(row.nextOn)
      .where(sql`${row.enabled}`),
  ],
);

export const automationWebhooks = pgTable("automation_webhooks", {
  id: pk(),
  workspaceId: workspaceRef(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  events: text("events").array().$type<AutomationTrigger[]>().notNull(),
  filter: jsonb("filter").$type<TaskFilter>(),
  enabled: boolean("enabled").notNull(),
  revision: uuid("revision").notNull(),
  deletedAt: ts("deleted_at"),
});

export const automationRules = pgTable(
  "automation_rules",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    trigger: text("trigger").$type<AutomationTrigger>().notNull(),
    filter: jsonb("filter").$type<TaskFilter>(),
    actions: jsonb("actions").$type<AutomationAction[]>().notNull(),
    enabled: boolean("enabled").notNull(),
    revision: uuid("revision").notNull(),
    deletedAt: ts("deleted_at"),
  },
  (row) => [
    index("automation_rules_active_idx")
      .on(row.workspaceId, row.trigger)
      .where(sql`${row.enabled} AND ${row.deletedAt} IS NULL`),
  ],
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => automationRules.id, { onDelete: "cascade" }),
    revision: uuid("revision").notNull(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    eventKey: text("event_key").notNull(),
    trigger: text("trigger").$type<AutomationTrigger>().notNull(),
    status: text("status").$type<"queued" | "completed" | "skipped" | "failed">().notNull().default("queued"),
    result: text("result"),
    createdAt: ts("created_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (row) => [
    uniqueIndex("automation_runs_rule_event_key").on(row.ruleId, row.eventKey, row.trigger),
    index("automation_runs_queue_idx")
      .on(row.id)
      .where(sql`${row.status} = 'queued'`),
    index("automation_runs_history_idx").on(row.workspaceId, row.id),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => automationWebhooks.id, { onDelete: "cascade" }),
    revision: uuid("revision").notNull(),
    eventKey: text("event_key").notNull(),
    trigger: text("trigger").$type<AutomationTrigger>().notNull(),
    body: text("body").notNull(),
    attempts: integer("attempts").notNull().default(0),
    status: text("status")
      .$type<"queued" | "delivered" | "failed" | "cancelled">()
      .notNull()
      .default("queued"),
    nextAt: ts("next_at").notNull().defaultNow(),
    createdAt: ts("created_at").notNull().defaultNow(),
    responseStatus: integer("response_status"),
  },
  (row) => [
    uniqueIndex("webhook_deliveries_event_key").on(row.webhookId, row.eventKey, row.trigger),
    index("webhook_deliveries_queue_idx")
      .on(row.nextAt)
      .where(sql`${row.status} = 'queued'`),
    index("webhook_deliveries_history_idx").on(row.workspaceId, row.id),
  ],
);
