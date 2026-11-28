import { automationRuleSchema, automationWebhookSchema, taskRecurrenceSchema } from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { requireModuleLevel } from "../middleware/modules";
import { requireAdmin } from "../middleware/roles";
import { todayIn } from "../middleware/workspace";
import { isAdmin } from "../services/members";
import * as automation from "../services/task-automation";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const taskParam = z.object({ taskId: z.uuid() });
const dryRunSchema = z.strictObject({ taskId: z.uuid(), rule: automationRuleSchema });
const webhookUpdateSchema = automationWebhookSchema.extend({ rotateSecret: z.boolean().optional() });
const manage = requireModuleLevel("automation", "manage");
const readTasks = requireModuleLevel("tasks", "read");
const writeTasks = requireModuleLevel("tasks", "write");

export const taskAutomationRoutes = new Hono<WorkspaceEnv>()
  .get("/automation", readTasks, async (c) =>
    c.json(await automation.listAutomation(c.var.db, c.var.workspace.id)),
  )
  .get("/automation/recurrences/:taskId", readTasks, validate("param", taskParam), async (c) =>
    c.json({
      recurrence: await automation.getRecurrence(c.var.db, c.var.workspace.id, c.req.valid("param").taskId),
    }),
  )
  .put(
    "/automation/recurrences/:taskId",
    writeTasks,
    validate("param", taskParam),
    validate("json", taskRecurrenceSchema),
    async (c) => {
      const { schedule, enabled } = c.req.valid("json");
      const recurrence = await automation.saveRecurrence(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").taskId,
        todayIn(c),
        schedule,
        enabled,
      );
      return c.json({ recurrence });
    },
  )
  .delete("/automation/recurrences/:taskId", writeTasks, validate("param", taskParam), async (c) => {
    await automation.removeRecurrence(c.var.db, c.var.workspace.id, c.req.valid("param").taskId);
    return c.body(null, 204);
  })
  .post(
    "/automation/rules",
    manage,
    writeTasks,
    forbidTokens,
    validate("json", automationRuleSchema),
    async (c) =>
      c.json(
        await automation.saveAutomationRule(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          null,
          c.req.valid("json"),
          isAdmin(c.var.workspace.role),
        ),
        201,
      ),
  )
  .put(
    "/automation/rules/:id",
    manage,
    writeTasks,
    forbidTokens,
    validate("param", idParam),
    validate("json", automationRuleSchema),
    async (c) =>
      c.json(
        await automation.saveAutomationRule(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          isAdmin(c.var.workspace.role),
        ),
      ),
  )
  .delete(
    "/automation/rules/:id",
    manage,
    writeTasks,
    forbidTokens,
    validate("param", idParam),
    async (c) => {
      await automation.removeAutomationRule(c.var.db, c.var.workspace.id, c.req.valid("param").id);
      return c.body(null, 204);
    },
  )
  .post("/automation/dry-run", manage, readTasks, forbidTokens, validate("json", dryRunSchema), async (c) => {
    const { taskId, rule } = c.req.valid("json");
    return c.json(await automation.dryRunAutomationRule(c.var.db, c.var.workspace.id, taskId, rule));
  })
  .get("/automation/webhooks", readTasks, requireAdmin, async (c) =>
    c.json(await automation.listAutomationWebhooks(c.var.db, c.var.workspace.id)),
  )
  .post(
    "/automation/webhooks",
    readTasks,
    requireAdmin,
    validate("json", automationWebhookSchema),
    async (c) =>
      c.json(
        await automation.saveAutomationWebhook(
          c.var.db,
          c.var.workspace.id,
          c.var.automationKey,
          null,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .put(
    "/automation/webhooks/:id",
    readTasks,
    requireAdmin,
    validate("param", idParam),
    validate("json", webhookUpdateSchema),
    async (c) => {
      const { rotateSecret, ...input } = c.req.valid("json");
      return c.json(
        await automation.saveAutomationWebhook(
          c.var.db,
          c.var.workspace.id,
          c.var.automationKey,
          c.req.valid("param").id,
          input,
          rotateSecret,
        ),
      );
    },
  )
  .delete("/automation/webhooks/:id", readTasks, requireAdmin, validate("param", idParam), async (c) => {
    await automation.removeAutomationWebhook(c.var.db, c.var.workspace.id, c.req.valid("param").id);
    return c.body(null, 204);
  });
