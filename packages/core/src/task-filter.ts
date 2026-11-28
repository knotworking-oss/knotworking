import { z } from "zod";
import { priorities, workflowStateTypes, type WorkflowStateType } from "./enums";

const id = z.uuid().toLowerCase();
const equality = z.enum(["eq", "ne"]);
const comparison = z.enum(["eq", "ne", "lt", "lte", "gt", "gte"]);
const calendarDate = z.iso.date().refine((date) => !date.startsWith("0000"));
const instant = z.iso.datetime({ offset: true }).refine((date) => {
  const year = new Date(date).getUTCFullYear();
  return year >= 1 && year <= 9999;
});

const leafSchema = z.union([
  z.strictObject({ field: z.enum(["teamId", "stateId", "labelId"]), op: equality, value: id }),
  z.strictObject({
    field: z.enum(["assigneeId", "creatorId", "projectId", "parentId", "milestoneId"]),
    op: equality,
    value: id.nullable(),
  }),
  z.strictObject({ field: z.literal("stateType"), op: equality, value: z.enum(workflowStateTypes) }),
  z.strictObject({ field: z.literal("priority"), op: equality, value: z.literal(priorities) }),
  z.strictObject({ field: z.enum(["hasSubtasks", "blocked"]), op: equality, value: z.boolean() }),
  z.strictObject({ field: z.enum(["startDate", "dueDate"]), op: equality, value: z.null() }),
  z.strictObject({ field: z.enum(["startDate", "dueDate"]), op: comparison, value: calendarDate }),
  z.strictObject({ field: z.literal("completedAt"), op: equality, value: z.null() }),
  z.strictObject({
    field: z.enum(["createdAt", "updatedAt", "completedAt"]),
    op: comparison,
    value: instant,
  }),
]);

export type TaskFilterCondition = z.infer<typeof leafSchema>;
export type TaskFilterExpression =
  TaskFilterCondition | { and: TaskFilterExpression[] } | { or: TaskFilterExpression[] };

const expressionSchema: z.ZodType<TaskFilterExpression> = z.lazy(() =>
  z.union([
    z.strictObject({ and: z.array(expressionSchema).min(1).max(16) }),
    z.strictObject({ or: z.array(expressionSchema).min(1).max(16) }),
    leafSchema,
  ]),
);

// Bound the tree before recursive validation. This also bounds the compiled SQL.
const boundedExpressionSchema = z.unknown().refine((input) => {
  const pending = [{ node: input, depth: 1 }];
  let count = 0;
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    if (++count > 64 || depth > 5) return false;
    if (!node || typeof node !== "object") continue;
    for (const key of ["and", "or"] as const) {
      const children = key in node ? (node as Record<string, unknown>)[key] : undefined;
      if (!Array.isArray(children)) continue;
      if (children.length > 16) return false;
      for (const child of children) pending.push({ node: child, depth: depth + 1 });
    }
  }
  return true;
}, "Task filters support up to 64 nodes, five levels and 16 conditions per group");

export const taskFilterSchema = z.strictObject({
  version: z.literal(1),
  expression: boundedExpressionSchema.pipe(expressionSchema),
});
export type TaskFilter = z.infer<typeof taskFilterSchema>;

export const closedTaskStateTypes = ["completed", "canceled"] as const;

/** The complement of the recent-task bootstrap window, for historical task queries. */
export function olderClosedTaskFilter(cutoff: string): TaskFilterExpression {
  return {
    and: [
      { or: closedTaskStateTypes.map((value) => ({ field: "stateType", op: "eq", value })) },
      { field: "updatedAt", op: "lt", value: cutoff },
    ],
  };
}

export const taskFilterJsonSchema = z
  .string()
  .max(8192)
  .transform((input, ctx): unknown => {
    try {
      return JSON.parse(input);
    } catch {
      ctx.addIssue({ code: "custom", message: "Expected a JSON task filter" });
      return z.NEVER;
    }
  })
  .pipe(taskFilterSchema);

export function evaluateTaskFilter<T>(
  expression: TaskFilterExpression,
  evaluate: {
    condition: (condition: TaskFilterCondition) => T;
    and: (children: T[]) => T;
    or: (children: T[]) => T;
  },
): T {
  if ("and" in expression)
    return evaluate.and(expression.and.map((child) => evaluateTaskFilter(child, evaluate)));
  if ("or" in expression)
    return evaluate.or(expression.or.map((child) => evaluateTaskFilter(child, evaluate)));
  return evaluate.condition(expression);
}

type Scalar = string | number | boolean | null;

function matchesTaskFilter(
  filter: TaskFilter,
  read: (field: TaskFilterCondition["field"]) => Scalar | readonly string[],
): boolean {
  return evaluateTaskFilter<boolean>(filter.expression, {
    and: (children) => children.every(Boolean),
    or: (children) => children.some(Boolean),
    condition: ({ field, op, value }) => {
      const actual = read(field);
      if (field === "labelId") {
        const hasLabel = Array.isArray(actual) && actual.includes(value);
        return op === "eq" ? hasLabel : !hasLabel;
      }
      const timestamp = field === "createdAt" || field === "updatedAt" || field === "completedAt";
      const left = timestamp && typeof actual === "string" ? Date.parse(actual) : actual;
      const right = timestamp && typeof value === "string" ? Date.parse(value) : value;
      if (op === "eq") return left === right;
      if (op === "ne") return left !== right;
      if (typeof left !== "number" && typeof left !== "string") return false;
      if (typeof right !== "number" && typeof right !== "string") return false;
      switch (op) {
        case "lt":
          return left < right;
        case "lte":
          return left <= right;
        case "gt":
          return left > right;
        case "gte":
          return left >= right;
      }
    },
  });
}

export interface TaskFilterRow {
  id: string;
  teamId: string;
  stateId: string;
  assigneeId: string | null;
  creatorId: string | null;
  projectId: string | null;
  milestoneId?: string | null;
  parentId: string | null;
  priority: number;
  labelIds: readonly string[];
  startDate: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** Filter a full set of visible workspace tasks. Relationship predicates use that same snapshot. */
export function filterTaskRows<T extends TaskFilterRow>(
  rows: readonly T[],
  filter: TaskFilter,
  stateType: (stateId: string) => WorkflowStateType | null,
  relations: readonly { blockingTaskId: string; blockedTaskId: string }[],
): T[] {
  let parents: Set<string | null> | undefined;
  let blocked: Set<string> | undefined;
  function blockedTasks() {
    const open = new Set(
      rows
        .filter((row) => {
          const state = stateType(row.stateId);
          return state !== null && state !== "completed" && state !== "canceled";
        })
        .map((row) => row.id),
    );
    return new Set(
      relations
        .filter((relation) => open.has(relation.blockingTaskId))
        .map((relation) => relation.blockedTaskId),
    );
  }
  return rows.filter((row) =>
    matchesTaskFilter(filter, (field) => {
      switch (field) {
        case "stateType":
          return stateType(row.stateId);
        case "labelId":
          return row.labelIds;
        case "hasSubtasks":
          return (parents ??= new Set(rows.map((task) => task.parentId))).has(row.id);
        case "blocked":
          return (blocked ??= blockedTasks()).has(row.id);
        default:
          return row[field] ?? null;
      }
    }),
  );
}

export const taskOrderings = ["priority", "manual", "created", "updated"] as const;
export type TaskOrdering = (typeof taskOrderings)[number];
export const taskGroupFields = [
  "teamId",
  "projectId",
  "assigneeId",
  "stateId",
  "stateType",
  "priority",
  "labelIds",
  "dueWeek",
] as const;
export type TaskGroupField = (typeof taskGroupFields)[number];

export const taskDisplayGroups = [
  "status",
  "assigneeId",
  "projectId",
  "priority",
  "labelIds",
  "dueWeek",
] as const;
export type TaskDisplayGroup = (typeof taskDisplayGroups)[number];
