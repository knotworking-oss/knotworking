import type { AutomationPipelineInput, PipelineOutput } from "@knotworking/core";
import { sql } from "drizzle-orm";
import { date, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, ts, workspaceRef } from "./helpers";

export const automationPipelines = pgTable(
  "automation_pipelines",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    definition: jsonb("definition").$type<AutomationPipelineInput>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (row) => [
    index("automation_pipelines_workspace_idx")
      .on(row.workspaceId)
      .where(sql`${row.deletedAt} is null`),
  ],
);

export const automationPipelineRuns = pgTable(
  "automation_pipeline_runs",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => automationPipelines.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    definition: jsonb("definition").$type<AutomationPipelineInput>().notNull(),
    key: text("key").notNull(),
    asAt: date("as_at").notNull(),
    outputs: jsonb("outputs").$type<Record<string, PipelineOutput>>().notNull().default({}),
    recipientIds: uuid("recipient_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    status: text("status")
      .$type<"queued" | "running" | "completed" | "partial" | "failed" | "skipped">()
      .notNull()
      .default("queued"),
    leaseId: uuid("lease_id"),
    leaseUntil: ts("lease_until"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (row) => [
    uniqueIndex("automation_pipeline_runs_occurrence_key").on(row.pipelineId, row.key),
    index("automation_pipeline_runs_history_idx").on(row.workspaceId, row.createdAt),
    index("automation_pipeline_runs_queue_idx")
      .on(row.createdAt)
      .where(sql`${row.finishedAt} is null`),
  ],
);
