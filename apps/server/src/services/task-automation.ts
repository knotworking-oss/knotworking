import { tickAutomationPipelines } from "./automation-pipelines";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  addDaysToIsoDate,
  effectiveTimeZone,
  hasModuleLevel,
  nextRecurrenceDate,
  taskCreateSchema,
  todayInZone,
  type AutomationAction,
  type AutomationRuleInput,
  type AutomationWebhookInput,
  type ModuleId,
  type RecurrenceSchedule,
} from "@knotworking/core";
import {
  automationRules,
  automationRuns,
  automationWebhooks,
  lockWorkspaceLog,
  notifications,
  taskLabels,
  taskRecurrences,
  tasks,
  teams,
  users,
  webhookDeliveries,
  workspaceMembers,
  workflowStates,
  workspaces,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { openSecret, sealSecret } from "./assistant-crypto";
import { matchAutomationTask, queueOverdueEvents, queueWebhook } from "./automation-events";
import { deliverAutomationWebhook, validateAutomationWebhookUrl } from "./automation-webhook-transport";
import { createTaskComment } from "./comments";
import { setCustomFieldValue } from "./custom-fields";
import { memberModuleLevels } from "./module-access";
import { deliverNotifications, type NotificationRow } from "./notifications";
import { createTask, updateTask } from "./tasks";
import { getActiveWorkspaceModules } from "./workspace-modules";

const WORK_LIMIT = 25;
const WEBHOOK_MAX_ATTEMPTS = 5;
type Rule = typeof automationRules.$inferSelect;
type Hook = typeof automationWebhooks.$inferSelect;
type Run = typeof automationRuns.$inferSelect;
type Recurrence = typeof taskRecurrences.$inferSelect;
const recurrenceScope = (workspaceId: string, sourceTaskId: string) =>
  and(eq(taskRecurrences.workspaceId, workspaceId), eq(taskRecurrences.sourceTaskId, sourceTaskId));
const ruleScope = (workspaceId: string) =>
  and(eq(automationRules.workspaceId, workspaceId), isNull(automationRules.deletedAt));
const webhookScope = (workspaceId: string) =>
  and(eq(automationWebhooks.workspaceId, workspaceId), isNull(automationWebhooks.deletedAt));
const publicRecurrence = ({
  workspaceId: _workspace,
  actorId: _actor,
  template: _template,
  ...row
}: Recurrence) => row;
const publicWebhook = ({ secretCiphertext: _secret, workspaceId: _workspace, ...hook }: Hook) => hook;
const webhookContext = (workspaceId: string, id: string) => `webhook:${workspaceId}:${id}`;
export const deriveAutomationKey = (secret: string) =>
  createHmac("sha256", secret).update("knotworking:automation-webhooks:v1").digest();

async function assertSourceTask(tx: Transaction, workspaceId: string, sourceTaskId: string) {
  const task = await matchAutomationTask(tx, workspaceId, sourceTaskId, null, null);
  if (!task) throw notFound("Task");
  return task;
}

export function getRecurrence(db: Database, workspaceId: string, taskId: string) {
  return db.transaction(async (tx) => {
    await assertSourceTask(tx, workspaceId, taskId);
    const [row] = await tx.select().from(taskRecurrences).where(recurrenceScope(workspaceId, taskId));
    return row ? publicRecurrence(row) : null;
  });
}

export function saveRecurrence(
  db: Database,
  workspaceId: string,
  actorId: string,
  taskId: string,
  today: string,
  schedule: RecurrenceSchedule,
  enabled: boolean,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const task = await assertSourceTask(tx, workspaceId, taskId);
    const [old] = await tx.select().from(taskRecurrences).where(recurrenceScope(workspaceId, taskId));
    const timingChanged =
      !old ||
      Object.keys(schedule).some((key) => {
        const field = key as keyof RecurrenceSchedule;
        return JSON.stringify(old.schedule[field]) !== JSON.stringify(schedule[field]);
      });
    if (timingChanged && schedule.firstOn < today)
      throw badRequest("The first occurrence must be today or later");
    const labelIds = await labelsForTask(tx, taskId);
    const template = taskCreateSchema.parse({
      teamId: task.teamId,
      title: task.title,
      description: task.description ?? undefined,
      priority: task.priority,
      estimateMinutes: task.estimateMinutes,
      assigneeId: task.assigneeId,
      projectId: task.projectId,
      milestoneId: task.milestoneId,
      sectionId: task.sectionId,
      parentId: task.parentId,
      startDate: task.startDate,
      dueDate: task.dueDate,
      labelIds,
    });
    const values = {
      actorId,
      template,
      schedule,
      enabled,
      lastError: null,
      nextOn:
        !old || timingChanged
          ? nextRecurrenceDate(schedule, addDaysToIsoDate(schedule.firstOn, -1))
          : old.nextOn,
      previousTaskId: old?.previousTaskId ?? taskId,
    };
    const [saved] = await tx
      .insert(taskRecurrences)
      .values({ workspaceId, sourceTaskId: taskId, ...values })
      .onConflictDoUpdate({
        target: [taskRecurrences.workspaceId, taskRecurrences.sourceTaskId],
        set: values,
      })
      .returning();
    return publicRecurrence(saved!);
  });
}

export async function removeRecurrence(db: Database, workspaceId: string, taskId: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertSourceTask(tx, workspaceId, taskId);
    await tx.delete(taskRecurrences).where(recurrenceScope(workspaceId, taskId));
  });
}

export async function listAutomation(db: Database, workspaceId: string) {
  const [rules, recurrences, runs] = await Promise.all([
    db.select().from(automationRules).where(ruleScope(workspaceId)).orderBy(asc(automationRules.name)),
    db
      .select({ recurrence: taskRecurrences, title: tasks.title })
      .from(taskRecurrences)
      .innerJoin(tasks, eq(tasks.id, taskRecurrences.sourceTaskId))
      .innerJoin(teams, and(eq(teams.id, tasks.teamId), isNull(teams.deletedAt)))
      .where(and(eq(taskRecurrences.workspaceId, workspaceId), isNull(tasks.deletedAt)))
      .orderBy(asc(taskRecurrences.nextOn)),
    db
      .select({ run: automationRuns, ruleName: automationRules.name, taskTitle: tasks.title })
      .from(automationRuns)
      .innerJoin(automationRules, eq(automationRuns.ruleId, automationRules.id))
      .innerJoin(tasks, eq(automationRuns.taskId, tasks.id))
      .where(eq(automationRuns.workspaceId, workspaceId))
      .orderBy(desc(automationRuns.id))
      .limit(100),
  ]);
  return {
    rules: rules.map(({ workspaceId: _workspace, revision: _revision, ...row }) => row),
    recurrences: recurrences.map(({ recurrence, title }) => ({ ...publicRecurrence(recurrence), title })),
    runs: runs.map(
      ({ run: { workspaceId: _workspace, revision: _revision, ...run }, ruleName, taskTitle }) => ({
        ...run,
        ruleName,
        taskTitle,
      }),
    ),
  };
}

export function saveAutomationRule(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string | null,
  input: AutomationRuleInput,
  admin: boolean,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (input.teamId) {
      const [team] = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.workspaceId, workspaceId), eq(teams.id, input.teamId), isNull(teams.deletedAt)));
      if (!team) throw badRequest("Choose an active team");
      for (const action of input.actions) {
        if (action.kind !== "set_state") continue;
        const [state] = await tx
          .select({ id: workflowStates.id })
          .from(workflowStates)
          .where(
            and(
              eq(workflowStates.id, action.stateId),
              eq(workflowStates.teamId, team.id),
              isNull(workflowStates.deletedAt),
            ),
          );
        if (!state) throw badRequest("Choose a status from the rule's team");
      }
    }
    const webhookIds = input.actions.flatMap((action) =>
      action.kind === "call_webhook" ? [action.webhookId] : [],
    );
    if (webhookIds.length && !admin)
      throw new ApiError(403, "admin_required", "Only an admin can send a webhook");
    for (const webhookId of webhookIds) {
      const [hook] = await tx
        .select({ id: automationWebhooks.id })
        .from(automationWebhooks)
        .where(and(webhookScope(workspaceId), eq(automationWebhooks.id, webhookId)));
      if (!hook) throw badRequest("Choose a webhook in this workspace");
    }
    const values = { ...input, actorId, revision: randomUUID() };
    const [rule] = id
      ? await tx
          .update(automationRules)
          .set(values)
          .where(and(ruleScope(workspaceId), eq(automationRules.id, id)))
          .returning()
      : await tx
          .insert(automationRules)
          .values({ workspaceId, ...values })
          .returning();
    if (!rule) throw notFound("Rule");
    return { id: rule.id };
  });
}

export async function removeAutomationRule(db: Database, workspaceId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [rule] = await tx
      .update(automationRules)
      .set({ deletedAt: new Date(), enabled: false })
      .where(and(ruleScope(workspaceId), eq(automationRules.id, id)))
      .returning({ id: automationRules.id });
    if (!rule) throw notFound("Rule");
  });
}

export function dryRunAutomationRule(
  db: Database,
  workspaceId: string,
  taskId: string,
  rule: AutomationRuleInput,
) {
  return db.transaction(async (tx) => {
    await assertSourceTask(tx, workspaceId, taskId);
    const task = await matchAutomationTask(tx, workspaceId, taskId, rule.teamId, rule.filter);
    return { matches: Boolean(task), actions: task ? rule.actions : [] };
  });
}

export async function listAutomationWebhooks(db: Database, workspaceId: string) {
  const [hooks, deliveries] = await Promise.all([
    db
      .select()
      .from(automationWebhooks)
      .where(webhookScope(workspaceId))
      .orderBy(asc(automationWebhooks.name)),
    db
      .select({
        id: webhookDeliveries.id,
        webhookId: webhookDeliveries.webhookId,
        name: automationWebhooks.name,
        status: webhookDeliveries.status,
        trigger: webhookDeliveries.trigger,
        attempts: webhookDeliveries.attempts,
        responseStatus: webhookDeliveries.responseStatus,
        nextAt: webhookDeliveries.nextAt,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .innerJoin(automationWebhooks, eq(webhookDeliveries.webhookId, automationWebhooks.id))
      .where(eq(webhookDeliveries.workspaceId, workspaceId))
      .orderBy(desc(webhookDeliveries.id))
      .limit(100),
  ]);
  return { webhooks: hooks.map(publicWebhook), deliveries };
}

export function saveAutomationWebhook(
  db: Database,
  workspaceId: string,
  key: Buffer,
  id: string | null,
  input: AutomationWebhookInput,
  rotateSecret = false,
) {
  let url: string;
  try {
    url = validateAutomationWebhookUrl(input.url).href;
  } catch {
    throw badRequest("Enter a public HTTPS webhook URL");
  }
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const webhookId = id ?? randomUUID();
    const secret = id && !rotateSecret ? null : randomBytes(32).toString("base64url");
    const values = { ...input, url, revision: randomUUID() };
    const sealed = secret && sealSecret(key, secret, webhookContext(workspaceId, webhookId));
    if (id) {
      const [updated] = await tx
        .update(automationWebhooks)
        .set({ ...values, ...(sealed ? { secretCiphertext: sealed } : {}) })
        .where(and(webhookScope(workspaceId), eq(automationWebhooks.id, id)))
        .returning();
      if (!updated) throw notFound("Webhook");
    } else {
      await tx
        .insert(automationWebhooks)
        .values({ id: webhookId, workspaceId, ...values, secretCiphertext: sealed! });
    }
    return { id: webhookId, secret };
  });
}

export async function removeAutomationWebhook(db: Database, workspaceId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [hook] = await tx
      .update(automationWebhooks)
      .set({ deletedAt: new Date(), enabled: false, secretCiphertext: "" })
      .where(and(webhookScope(workspaceId), eq(automationWebhooks.id, id)))
      .returning({ id: automationWebhooks.id });
    if (!hook) throw notFound("Webhook");
  });
}

async function eligibleActor(
  db: Executor,
  workspaceId: string,
  actorId: string | null,
  active: readonly ModuleId[],
  level: "write" | "manage",
) {
  if (!actorId) return null;
  const [member] = await db
    .select({ userId: users.id, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(users, and(eq(users.id, workspaceMembers.userId), isNull(users.deletedAt)))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, actorId),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  if (!member) return null;
  const access = await memberModuleLevels(db, workspaceId, member, active);
  return hasModuleLevel(access.automation, level) && hasModuleLevel(access.tasks, "write") ? member : null;
}

function occurrenceId(recurrenceId: string, date: string) {
  const hex = createHash("sha256").update(`knotworking:recurrence:${recurrenceId}:${date}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function labelsForTask(tx: Transaction, taskId: string) {
  const rows = await tx
    .select({ labelId: taskLabels.labelId })
    .from(taskLabels)
    .where(and(eq(taskLabels.taskId, taskId), isNull(taskLabels.deletedAt)));
  return rows.map((row) => row.labelId);
}

async function runRecurrences(
  db: Database,
  workspaceId: string,
  today: string,
  active: readonly ModuleId[],
  notices: NotificationRow[],
) {
  const rows = await db
    .select({ id: taskRecurrences.id })
    .from(taskRecurrences)
    .leftJoin(tasks, eq(taskRecurrences.previousTaskId, tasks.id))
    .where(
      and(
        eq(taskRecurrences.workspaceId, workspaceId),
        eq(taskRecurrences.enabled, true),
        lte(taskRecurrences.nextOn, today),
        or(
          sql`${taskRecurrences.schedule}->>'timing' = 'on_schedule'`,
          isNotNull(tasks.completedAt),
          isNotNull(tasks.canceledAt),
          isNotNull(tasks.deletedAt),
          isNull(tasks.id),
        ),
      ),
    )
    .orderBy(asc(taskRecurrences.nextOn), asc(taskRecurrences.id))
    .limit(WORK_LIMIT);
  for (const { id } of rows) {
    const generated = await db.transaction(async (tx) => {
      await lockWorkspaceLog(tx, workspaceId);
      const [row] = await tx.select().from(taskRecurrences).where(eq(taskRecurrences.id, id));
      if (!row?.enabled || row.nextOn > today) return [];
      const currentModules = await getActiveWorkspaceModules(tx, workspaceId, active);
      if (!currentModules.includes("automation")) return [];
      const actor = await eligibleActor(tx, workspaceId, row.actorId, currentModules, "write");
      const previous = row.previousTaskId
        ? await matchAutomationTask(tx, workspaceId, row.previousTaskId, null, null)
        : null;
      const openPrevious = previous && !previous.completedAt && !previous.canceledAt;
      if (row.schedule.timing === "after_completion" && openPrevious) return [];
      const source = await matchAutomationTask(tx, workspaceId, row.sourceTaskId, null, null);
      const collected: NotificationRow[] = [];
      try {
        if (!source || !actor) throw badRequest("The source task or schedule owner can no longer be used");
        const dueDate = row.schedule.timing === "after_completion" ? today : row.nextOn;
        const occurrenceTaskId = occurrenceId(row.id, row.nextOn);
        const [existing] = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, occurrenceTaskId)));
        if (!existing) {
          const startOffset =
            row.template.startDate && row.template.dueDate
              ? (Date.parse(row.template.startDate) - Date.parse(row.template.dueDate)) / 86_400_000
              : null;
          await createTask(
            tx,
            workspaceId,
            actor.userId,
            {
              ...row.template,
              id: occurrenceTaskId,
              dueDate,
              startDate: startOffset === null ? null : addDaysToIsoDate(dueDate, startOffset),
            },
            (items) => collected.push(...items),
            "automation",
          );
        }
        await tx
          .update(taskRecurrences)
          .set({
            previousTaskId: occurrenceTaskId,
            nextOn: nextRecurrenceDate(row.schedule, dueDate),
            lastError: null,
          })
          .where(eq(taskRecurrences.id, id));
        return collected;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        await tx
          .update(taskRecurrences)
          .set({ enabled: false, lastError: error.message })
          .where(eq(taskRecurrences.id, id));
        return [];
      }
    });
    notices.push(...generated);
  }
}

async function applyAction(
  tx: Transaction,
  rule: Rule,
  run: Run,
  actor: { userId: string; role: string },
  active: readonly ModuleId[],
  action: AutomationAction,
  notices: NotificationRow[],
) {
  const workspaceId = run.workspaceId;
  const task = await matchAutomationTask(tx, workspaceId, run.taskId, rule.teamId, null);
  if (!task) throw notFound("Task");
  const collect = (items: NotificationRow[]) => notices.push(...items);
  switch (action.kind) {
    case "set_state":
      await updateTask(
        tx,
        workspaceId,
        actor.userId,
        task.id,
        { stateId: action.stateId },
        collect,
        "automation",
      );
      break;
    case "assign":
      await updateTask(
        tx,
        workspaceId,
        actor.userId,
        task.id,
        { assigneeId: action.assigneeId },
        collect,
        "automation",
      );
      break;
    case "add_label":
      await updateTask(
        tx,
        workspaceId,
        actor.userId,
        task.id,
        {
          labelIds: [...(await labelsForTask(tx, task.id)), action.labelId],
        },
        collect,
        "automation",
      );
      break;
    case "set_field":
      await setCustomFieldValue(tx, workspaceId, actor.userId, "task", task.id, action.fieldId, action.value);
      break;
    case "create_subtask":
      await createTask(
        tx,
        workspaceId,
        actor.userId,
        { teamId: task.teamId, projectId: task.projectId, parentId: task.id, title: action.title },
        collect,
        "automation",
      );
      break;
    case "comment":
      await createTaskComment(
        tx,
        workspaceId,
        actor.userId,
        task.id,
        {
          body: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: action.text }] }],
          },
        },
        collect,
      );
      break;
    case "notify": {
      const [recipient] = await tx
        .select({ userId: users.id, role: workspaceMembers.role })
        .from(workspaceMembers)
        .innerJoin(users, and(eq(users.id, workspaceMembers.userId), isNull(users.deletedAt)))
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, action.userId),
            isNull(workspaceMembers.deletedAt),
          ),
        );
      if (
        !recipient ||
        !hasModuleLevel((await memberModuleLevels(tx, workspaceId, recipient, active)).tasks, "read")
      )
        throw badRequest("The recipient cannot read the task");
      const rows = await tx
        .insert(notifications)
        .values({
          workspaceId,
          userId: recipient.userId,
          actorId: actor.userId,
          taskId: task.id,
          type: "automation_notice",
          module: "tasks",
          data: { taskTitle: task.title, snippet: action.text },
        })
        .returning();
      notices.push(...rows);
      break;
    }
    case "call_webhook": {
      if (actor.role !== "admin" && actor.role !== "owner")
        throw badRequest("Only an admin can send a webhook");
      const [hook] = await tx
        .select()
        .from(automationWebhooks)
        .where(
          and(
            webhookScope(workspaceId),
            eq(automationWebhooks.id, action.webhookId),
            eq(automationWebhooks.enabled, true),
          ),
        );
      if (!hook) throw badRequest("The webhook is disabled or deleted");
      await queueWebhook(tx, hook, task, run.eventKey, run.trigger);
      break;
    }
  }
}

async function runRules(
  db: Database,
  workspaceId: string,
  active: readonly ModuleId[],
  notices: NotificationRow[],
  now: Date,
) {
  const pending = await db
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(and(eq(automationRuns.workspaceId, workspaceId), eq(automationRuns.status, "queued")))
    .orderBy(asc(automationRuns.id))
    .limit(WORK_LIMIT);
  for (const { id } of pending) {
    const generated = await db.transaction(async (tx) => {
      await lockWorkspaceLog(tx, workspaceId);
      const [run] = await tx.select().from(automationRuns).where(eq(automationRuns.id, id));
      if (!run || run.status !== "queued") return [];
      const [rule] = await tx
        .select()
        .from(automationRules)
        .where(and(ruleScope(workspaceId), eq(automationRules.id, run.ruleId)));
      const currentModules = await getActiveWorkspaceModules(tx, workspaceId, active);
      if (!currentModules.includes("automation")) return [];
      const actor = rule
        ? await eligibleActor(tx, workspaceId, rule.actorId, currentModules, "manage")
        : null;
      const [recent] = await tx
        .select({ total: count() })
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.taskId, run.taskId),
            inArray(automationRuns.status, ["completed", "failed"]),
            gte(automationRuns.finishedAt, new Date(now.getTime() - 60_000)),
          ),
        );
      let status: Run["status"] = "skipped";
      let result: string | null = null;
      const collected: NotificationRow[] = [];
      if (!rule?.enabled || rule.revision !== run.revision) result = "Rule changed or was disabled";
      else if (!actor) result = "Rule owner no longer has access";
      else if ((recent?.total ?? 0) >= 20) result = "Task automation limit reached";
      else {
        try {
          // A failed action rolls back every action in this run before we save the failure.
          await tx.transaction(async (actions) => {
            for (const action of rule.actions)
              await applyAction(actions, rule, run, actor, currentModules, action, collected);
          });
          status = "completed";
        } catch (error) {
          status = "failed";
          result = error instanceof ApiError ? error.message : "An action could not finish";
        }
      }
      await tx
        .update(automationRuns)
        .set({ status, result, finishedAt: now })
        .where(eq(automationRuns.id, id));
      return status === "completed" ? collected : [];
    });
    notices.push(...generated);
  }
}

async function dispatchWebhooks(
  db: Database,
  workspaceId: string,
  active: readonly ModuleId[],
  key: Buffer,
  now: Date,
) {
  const candidates = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.workspaceId, workspaceId),
        eq(webhookDeliveries.status, "queued"),
        lte(webhookDeliveries.nextAt, now),
      ),
    )
    .orderBy(asc(webhookDeliveries.nextAt), asc(webhookDeliveries.id))
    .limit(WORK_LIMIT);
  for (const { id } of candidates) {
    const claim = await db.transaction(async (tx) => {
      await lockWorkspaceLog(tx, workspaceId);
      const [delivery] = await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
      if (!delivery || delivery.status !== "queued" || delivery.nextAt > now) return null;
      if (!(await getActiveWorkspaceModules(tx, workspaceId, active)).includes("automation")) return null;
      const [hook] = await tx
        .select()
        .from(automationWebhooks)
        .where(and(webhookScope(workspaceId), eq(automationWebhooks.id, delivery.webhookId)));
      if (!hook?.enabled || hook.revision !== delivery.revision) {
        await tx.update(webhookDeliveries).set({ status: "cancelled" }).where(eq(webhookDeliveries.id, id));
        return null;
      }
      if (delivery.attempts >= WEBHOOK_MAX_ATTEMPTS) {
        await tx.update(webhookDeliveries).set({ status: "failed" }).where(eq(webhookDeliveries.id, id));
        await tx.update(automationWebhooks).set({ enabled: false }).where(eq(automationWebhooks.id, hook.id));
        return null;
      }
      const attempts = delivery.attempts + 1;
      const leaseUntil = new Date(Math.max(now.getTime(), Date.now()) + 120_000);
      await tx
        .update(webhookDeliveries)
        .set({ attempts, nextAt: leaseUntil })
        .where(eq(webhookDeliveries.id, id));
      return { hook, delivery, attempts };
    });
    if (!claim) continue;
    const { hook, delivery, attempts } = claim;
    const secret = openSecret(key, hook.secretCiphertext, webhookContext(workspaceId, hook.id));
    let responseStatus: number | null = null;
    if (secret) {
      try {
        responseStatus = await deliverAutomationWebhook({
          url: hook.url,
          secret,
          deliveryId: id,
          body: delivery.body,
        });
      } catch {
        // A missing response is retried with the same delivery ID.
      }
    }
    const success = responseStatus !== null && responseStatus >= 200 && responseStatus < 300;
    const terminal = !secret || attempts >= WEBHOOK_MAX_ATTEMPTS;
    await db.transaction(async (tx) => {
      await lockWorkspaceLog(tx, workspaceId);
      const [updated] = await tx
        .update(webhookDeliveries)
        .set({
          status: success ? "delivered" : terminal ? "failed" : "queued",
          responseStatus,
          nextAt: new Date(Math.max(now.getTime(), Date.now()) + 60_000 * 2 ** (attempts - 1)),
        })
        .where(
          and(
            eq(webhookDeliveries.id, id),
            eq(webhookDeliveries.attempts, attempts),
            eq(webhookDeliveries.status, "queued"),
          ),
        )
        .returning({ id: webhookDeliveries.id });
      if (updated && terminal && !success) {
        await tx
          .update(automationWebhooks)
          .set({ enabled: false })
          .where(and(eq(automationWebhooks.id, hook.id), eq(automationWebhooks.revision, hook.revision)));
      }
    });
  }
}

export async function tickTaskAutomation(
  db: Database,
  available: readonly ModuleId[],
  key: Buffer,
  now = new Date(),
) {
  if (!available.includes("automation") || !available.includes("tasks")) return;
  const work = await db
    .select({ id: workspaces.id, timeZone: workspaces.timeZone })
    .from(workspaces)
    .where(
      and(
        isNull(workspaces.deletedAt),
        sql`(
      EXISTS (SELECT 1 FROM ${taskRecurrences} WHERE ${taskRecurrences.workspaceId} = ${workspaces.id} AND ${taskRecurrences.enabled}) OR
      EXISTS (SELECT 1 FROM ${automationRules} WHERE ${automationRules.workspaceId} = ${workspaces.id} AND ${automationRules.enabled}) OR
      EXISTS (SELECT 1 FROM ${automationWebhooks} WHERE ${automationWebhooks.workspaceId} = ${workspaces.id} AND ${automationWebhooks.enabled}) OR
      EXISTS (SELECT 1 FROM ${automationRuns} WHERE ${automationRuns.workspaceId} = ${workspaces.id} AND ${automationRuns.status} = 'queued') OR
      EXISTS (SELECT 1 FROM ${webhookDeliveries} WHERE ${webhookDeliveries.workspaceId} = ${workspaces.id} AND ${webhookDeliveries.status} = 'queued')
    )`,
      ),
    );
  const notices: NotificationRow[] = [];
  for (const workspace of work) {
    const active = await getActiveWorkspaceModules(db, workspace.id, available);
    if (!active.includes("automation") || !active.includes("tasks")) continue;
    const today = todayInZone(effectiveTimeZone(workspace.timeZone).timeZone, now);
    await runRecurrences(db, workspace.id, today, active, notices);
    await db.transaction(async (tx) => {
      await lockWorkspaceLog(tx, workspace.id);
      if ((await getActiveWorkspaceModules(tx, workspace.id, active)).includes("automation")) {
        await queueOverdueEvents(tx, workspace.id, today);
      }
    });
    await runRules(db, workspace.id, active, notices, now);
    await dispatchWebhooks(db, workspace.id, active, key, now);
  }
  if (notices.length) await deliverNotifications(db, notices);
}

export function startTaskAutomation(db: Database, available: readonly ModuleId[], key: Buffer) {
  let pending: Promise<void> | undefined;
  const tick = () => {
    pending ??= Promise.allSettled([
      tickTaskAutomation(db, available, key),
      tickAutomationPipelines(db, available),
    ])
      .then(([tasks, pipelines]) => {
        if (tasks.status === "rejected") console.error("Task automation worker failed");
        if (pipelines.status === "rejected") console.error("Automation pipeline worker failed");
      })
      .finally(() => {
        pending = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, 30_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}
