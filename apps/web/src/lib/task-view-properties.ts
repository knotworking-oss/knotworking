import { taskViewProperties, type TaskViewProperty } from "@knotworking/core";

export const taskPropertyLabels: Record<TaskViewProperty, string> = {
  priority: "Priority",
  blockers: "Blockers",
  labels: "Labels",
  project: "Project",
  time: "Time",
  dueDate: "Due date",
  createdAt: "Created date",
  assignee: "Assignee",
};

export const defaultBoardProperties: readonly TaskViewProperty[] = [
  "priority",
  "blockers",
  "labels",
  "time",
  "assignee",
];

export function parseTaskProperties(raw: string | null): TaskViewProperty[] | undefined {
  if (raw == null) return undefined;
  const values = raw.split(",").filter(Boolean);
  const parsed = taskViewProperties.filter((property) => values.includes(property));
  return values.every((value) => parsed.some((property) => property === value)) ? parsed : undefined;
}
