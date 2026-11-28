import { createHash } from "node:crypto";
import { evaluateTaskFilter, type TaskFilter, type TaskListQuery } from "@knotworking/core";
import { taskLabels, taskRelations, tasks, teams, workflowStates } from "@knotworking/db";
import { and, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { badRequest } from "../errors";

const child = alias(tasks, "child");
const childTeam = alias(teams, "child_team");
const blocker = alias(tasks, "blocker");
const blockerTeam = alias(teams, "blocker_team");
const blockerState = alias(workflowStates, "blocker_state");

const taskColumns = {
  teamId: tasks.teamId,
  stateId: tasks.stateId,
  stateType: workflowStates.type,
  assigneeId: tasks.assigneeId,
  creatorId: tasks.creatorId,
  projectId: tasks.projectId,
  milestoneId: tasks.milestoneId,
  parentId: tasks.parentId,
  priority: tasks.priority,
  startDate: tasks.startDate,
  dueDate: tasks.dueDate,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  completedAt: tasks.completedAt,
};

const operators = {
  eq: sql`is not distinct from`,
  ne: sql`is distinct from`,
  lt: sql`<`,
  lte: sql`<=`,
  gt: sql`>`,
  gte: sql`>=`,
};

const activeLabels = sql`${taskLabels.taskId} = ${tasks.id}
  and ${taskLabels.workspaceId} = ${tasks.workspaceId} and ${taskLabels.deletedAt} is null`;

export const taskQueryLabelIds = sql<string[]>`to_jsonb(array(
  select ${taskLabels.labelId} from ${taskLabels} where ${activeLabels}
  order by ${taskLabels.labelId}
))`;

export function taskFilterSql(filter: TaskFilter) {
  return evaluateTaskFilter<SQL>(filter.expression, {
    and: (parts) => and(...parts)!,
    or: (parts) => or(...parts)!,
    condition: ({ field, op, value }) => {
      const compare = (left: SQLWrapper, right: unknown) => sql`${left} ${operators[op]} ${right}`;
      switch (field) {
        case "labelId":
          return compare(
            sql`exists (
            select 1 from ${taskLabels} where ${activeLabels} and ${taskLabels.labelId} = ${value}
          )`,
            true,
          );
        case "hasSubtasks":
          return compare(
            sql`exists (
            select 1 from ${tasks} as ${child}
            join ${teams} as ${childTeam} on ${childTeam.id} = ${child.teamId} and ${childTeam.deletedAt} is null
            where ${child.workspaceId} = ${tasks.workspaceId}
              and ${child.parentId} = ${tasks.id} and ${child.deletedAt} is null
          )`,
            value,
          );
        case "blocked":
          return compare(
            sql`exists (
            select 1 from ${taskRelations}
            join ${tasks} as ${blocker} on ${blocker.id} = ${taskRelations.blockingTaskId} and ${blocker.deletedAt} is null
            join ${teams} as ${blockerTeam} on ${blockerTeam.id} = ${blocker.teamId} and ${blockerTeam.deletedAt} is null
            join ${workflowStates} as ${blockerState} on ${blockerState.id} = ${blocker.stateId}
            where ${taskRelations.workspaceId} = ${tasks.workspaceId}
              and ${taskRelations.blockedTaskId} = ${tasks.id} and ${taskRelations.deletedAt} is null
              and ${blockerState.type} not in ('completed', 'canceled')
          )`,
            value,
          );
        case "createdAt":
        case "updatedAt":
        case "completedAt":
          // Task rows serialize instants at millisecond precision.
          return compare(
            sql`date_trunc('milliseconds', ${taskColumns[field]})`,
            value === null ? null : new Date(value).toISOString(),
          );
        default:
          return compare(taskColumns[field], value);
      }
    },
  });
}

const cursorSchema = z.object({
  scope: z.string(),
  keys: z.array(z.string().max(160)).max(4),
});
const keySchemas = {
  text: z.string(),
  numeric: z.string().regex(/^-?\d+(\.\d+)?$/),
  uuid: z.uuid(),
};
type Key = { expression: SQL; type: keyof typeof keySchemas };

export function taskQueryOrder(workspaceId: string, { cursor, limit: _limit, ...query }: TaskListQuery) {
  const { sort, group } = query;
  const groupColumn =
    group === "labelIds"
      ? sql`(select min(${taskLabels.labelId}::text)
        from ${taskLabels} where ${activeLabels})`
      : group === "dueWeek"
        ? sql`date_trunc('week', ${tasks.dueDate}::timestamp)::date`
        : group
          ? taskColumns[group]
          : null;
  const groupKey = groupColumn ? sql`coalesce(${groupColumn}::text, '') collate "C"` : null;
  const manual = sort ? sql`${tasks.sortOrder} collate "C"` : sql`${tasks.sortOrder}`;
  const timestamp = (column: typeof tasks.createdAt) =>
    sql`-extract(epoch from date_trunc('milliseconds', ${column}))`;
  const keys: Key[] = [];
  if (groupKey) keys.push({ expression: groupKey, type: "text" });
  if (sort === "created") keys.push({ expression: timestamp(tasks.createdAt), type: "numeric" });
  if (sort === "updated") keys.push({ expression: timestamp(tasks.updatedAt), type: "numeric" });
  if (sort === "priority") {
    keys.push({
      expression: sql`case when ${tasks.priority} = 0 then 5 else ${tasks.priority} end`,
      type: "numeric",
    });
  }
  keys.push({ expression: manual, type: "text" });
  if (!sort) keys.push({ expression: sql`-extract(epoch from ${tasks.createdAt})`, type: "numeric" });
  keys.push({ expression: sql`${tasks.id}`, type: "uuid" });

  const scope = createHash("sha256")
    .update(JSON.stringify([workspaceId, query]))
    .digest("base64url");
  const order = keys.map((key) => key.expression);
  let after: SQL | undefined;
  if (cursor) {
    const values = decodeCursor(cursor, scope, keys);
    const bound = values.map((value, i) => sql`cast(${value} as ${sql.raw(keys[i]!.type)})`);
    after = sql`(${sql.join(order, sql`, `)}) > (${sql.join(bound, sql`, `)})`;
  }
  return {
    after,
    order,
    groupKey: groupKey ? sql<string | null>`nullif(${groupKey}, '')` : sql<null>`null::text`,
    cursorKeys: sql<string[]>`jsonb_build_array(${sql.join(
      order.map((key) => sql`(${key})::text`),
      sql`, `,
    )})`,
    encodeCursor: (keys: string[]) => Buffer.from(JSON.stringify({ scope, keys })).toString("base64url"),
  };
}

function decodeCursor(cursor: string, scope: string, keys: Key[]): string[] {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (
      parsed.scope === scope &&
      parsed.keys.length === keys.length &&
      keys.every(({ type }, i) => keySchemas[type].safeParse(parsed.keys[i]).success)
    ) {
      return parsed.keys;
    }
  } catch {
    // Treat invalid encodings and cursors from a different query alike.
  }
  throw badRequest("Invalid task cursor for this query");
}
