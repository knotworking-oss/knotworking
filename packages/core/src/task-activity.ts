import { z } from "zod";

export const taskActivityFields = [
  "title",
  "teamId",
  "description",
  "stateId",
  "priority",
  "estimateMinutes",
  "assigneeId",
  "projectId",
  "milestoneId",
  "parentId",
  "startDate",
  "dueDate",
  "sortOrder",
  "labelIds",
] as const;

export type TaskActivityField = (typeof taskActivityFields)[number];
export type TaskActivitySource = "session" | "token" | "internal" | "automation";
export type TaskActivityValue = string | number | boolean | null | string[];
export type TaskActivityChange = { from: TaskActivityValue; to: TaskActivityValue };
export type TaskActivityDetails =
  | { kind: "created" | "deleted" }
  | { kind: "updated"; changes: Partial<Record<TaskActivityField, TaskActivityChange>> }
  | { kind: "dependency_added" | "dependency_removed"; blockingTaskId: string; blockedTaskId: string };

export const taskActivityQuerySchema = z.object({
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
