import { AsyncLocalStorage } from "node:async_hooks";
import type { AutomationTrigger, TaskActivityDetails, TaskFilter } from "@knotworking/core";
import {
  automationRules,
  automationRuns,
  automationWebhooks,
  tasks,
  teams,
  webhookDeliveries,
  workflowStates,
  workspaces,
  type Transaction,
} from "@knotworking/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { taskFilterSql } from "./task-query";

const automationScope = new AsyncLocalStorage<boolean>();
export const withAutomationScope = <T>(enabled: boolean, work: () => T): T =>
  automationScope.run(enabled, work);
export const automationEnabledForRequest = () => automationScope.getStore() === true;

export function activityTriggers(details: TaskActivityDetails): AutomationTrigger[] {
  if (details.kind === "created") return ["task_created"];
  if (details.kind !== "updated") return [];
  const { stateId, assigneeId, labelIds } = details.changes;
  return [
    ...(stateId ? ["state_changed" as const] : []),
    ...(assigneeId ? ["assignee_changed" as const] : []),
    ...(Array.isArray(labelIds?.to) && labelIds.to.some((id) => !(labelIds.from as string[]).includes(id))
      ? ["label_added" as const]
      : []),
  ];
}

export async function matchAutomationTask(
  tx: Transaction,
  workspaceId: string,
  taskId: string,
  teamId: string | null,
  filter: TaskFilter | null,
) {
  const [row] = await tx
    .select({ task: tasks })
    .from(tasks)
    .innerJoin(teams, and(eq(teams.id, tasks.teamId), isNull(teams.deletedAt)))
    .innerJoin(workflowStates, eq(workflowStates.id, tasks.stateId))
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.id, taskId),
        isNull(tasks.deletedAt),
        teamId ? eq(tasks.teamId, teamId) : undefined,
        filter ? taskFilterSql(filter) : undefined,
      ),
    );
  return row?.task;
}

export async function queueWebhook(
  tx: Transaction,
  webhook: Pick<typeof automationWebhooks.$inferSelect, "id" | "revision">,
  task: Pick<
    typeof tasks.$inferSelect,
    "id" | "workspaceId" | "teamId" | "projectId" | "stateId" | "assigneeId" | "dueDate"
  >,
  eventKey: string,
  trigger: AutomationTrigger,
) {
  // Carry the stable task references a receiver needs. The signed envelope contains no task content.
  const { id, workspaceId, teamId, projectId, stateId, assigneeId, dueDate } = task;
  await tx
    .insert(webhookDeliveries)
    .values({
      workspaceId,
      webhookId: webhook.id,
      revision: webhook.revision,
      eventKey,
      trigger,
      body: JSON.stringify({
        version: 1,
        eventId: eventKey,
        event: trigger,
        workspaceId,
        task: {
          id,
          teamId,
          projectId,
          stateId,
          assigneeId,
          dueDate,
        },
      }),
    })
    .onConflictDoNothing();
}

export async function queueAutomationEvent(
  tx: Transaction,
  workspaceId: string,
  taskId: string,
  eventKey: string,
  triggers: AutomationTrigger[],
) {
  if (!triggers.length || !automationScope.getStore()) return;
  const [workspace] = await tx
    .select({ enabled: workspaces.enabledModules })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)));
  if (!workspace || (workspace.enabled && !workspace.enabled.includes("automation"))) return;
  for (const trigger of triggers) {
    const [rules, hooks] = await Promise.all([
      tx
        .select()
        .from(automationRules)
        .where(
          and(
            eq(automationRules.workspaceId, workspaceId),
            eq(automationRules.trigger, trigger),
            eq(automationRules.enabled, true),
            isNull(automationRules.deletedAt),
          ),
        ),
      tx
        .select()
        .from(automationWebhooks)
        .where(
          and(
            eq(automationWebhooks.workspaceId, workspaceId),
            sql`${trigger} = ANY(${automationWebhooks.events})`,
            eq(automationWebhooks.enabled, true),
            isNull(automationWebhooks.deletedAt),
          ),
        ),
    ]);
    for (const rule of rules) {
      if (!(await matchAutomationTask(tx, workspaceId, taskId, rule.teamId, rule.filter))) continue;
      await tx
        .insert(automationRuns)
        .values({
          workspaceId,
          ruleId: rule.id,
          revision: rule.revision,
          taskId,
          eventKey,
          trigger,
        })
        .onConflictDoNothing();
    }
    for (const hook of hooks) {
      const task = await matchAutomationTask(tx, workspaceId, taskId, null, hook.filter);
      if (task) await queueWebhook(tx, hook, task, eventKey, trigger);
    }
  }
}

export async function queueOverdueEvents(tx: Transaction, workspaceId: string, today: string) {
  // Find actionable pairs rather than repeatedly selecting the same already-processed overdue tasks.
  const eventKey = sql<string>`'due:' || ${tasks.id}::text || ':' || ${tasks.dueDate}::text`;
  const eligible = and(
    eq(tasks.workspaceId, workspaceId),
    isNull(tasks.deletedAt),
    sql`${tasks.dueDate} < ${today}`,
    sql`${workflowStates.type} NOT IN ('completed', 'canceled')`,
  );
  const rules = await tx
    .select()
    .from(automationRules)
    .where(
      and(
        eq(automationRules.workspaceId, workspaceId),
        eq(automationRules.enabled, true),
        eq(automationRules.trigger, "due_date_passed"),
        isNull(automationRules.deletedAt),
      ),
    );
  const hooks = await tx
    .select()
    .from(automationWebhooks)
    .where(
      and(
        eq(automationWebhooks.workspaceId, workspaceId),
        eq(automationWebhooks.enabled, true),
        sql`'due_date_passed' = ANY(${automationWebhooks.events})`,
        isNull(automationWebhooks.deletedAt),
      ),
    );
  const candidates = () =>
    tx
      .select({ task: tasks, eventKey })
      .from(tasks)
      .innerJoin(teams, and(eq(teams.id, tasks.teamId), isNull(teams.deletedAt)))
      .innerJoin(workflowStates, eq(workflowStates.id, tasks.stateId));
  for (const rule of rules) {
    const matches = await candidates()
      .where(
        and(
          eligible,
          rule.teamId ? eq(tasks.teamId, rule.teamId) : undefined,
          rule.filter ? taskFilterSql(rule.filter) : undefined,
          sql`NOT EXISTS (SELECT 1 FROM ${automationRuns} WHERE ${automationRuns.ruleId} = ${rule.id}
        AND ${automationRuns.eventKey} = ${eventKey})`,
        ),
      )
      .orderBy(tasks.dueDate, tasks.id)
      .limit(25);
    for (const { task, eventKey } of matches) {
      await tx
        .insert(automationRuns)
        .values({
          workspaceId,
          ruleId: rule.id,
          revision: rule.revision,
          taskId: task.id,
          eventKey,
          trigger: "due_date_passed",
        })
        .onConflictDoNothing();
    }
  }
  for (const hook of hooks) {
    const matches = await candidates()
      .where(
        and(
          eligible,
          hook.filter ? taskFilterSql(hook.filter) : undefined,
          sql`NOT EXISTS (SELECT 1 FROM ${webhookDeliveries} WHERE ${webhookDeliveries.webhookId} = ${hook.id}
        AND ${webhookDeliveries.eventKey} = ${eventKey})`,
        ),
      )
      .orderBy(tasks.dueDate, tasks.id)
      .limit(25);
    for (const { task, eventKey } of matches) await queueWebhook(tx, hook, task, eventKey, "due_date_passed");
  }
}
