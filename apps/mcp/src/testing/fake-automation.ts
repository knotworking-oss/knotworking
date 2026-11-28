import { addDaysToIsoDate, newId, nextRecurrenceDate, taskRecurrenceSchema } from "@knotworking/core";
import type { Hono } from "hono";
import type { z } from "zod";

type Recurrence = z.infer<typeof taskRecurrenceSchema> & {
  id: string;
  sourceTaskId: string;
  nextOn: string;
  previousTaskId: string;
  lastError: null;
};

export function mountFakeAutomation(app: Hono, ws: string) {
  const recurrences = new Map<string, Recurrence>();
  app.get(`${ws}/automation`, (c) =>
    c.json({
      recurrences: [...recurrences.values()].map((row) => ({ ...row, title: "Recurring task" })),
      rules: [],
      runs: [],
    }),
  );
  app.get(`${ws}/automation/recurrences/:taskId`, (c) =>
    c.json({ recurrence: recurrences.get(c.req.param("taskId")) ?? null }),
  );
  app.put(`${ws}/automation/recurrences/:taskId`, async (c) => {
    const taskId = c.req.param("taskId");
    const parsed = taskRecurrenceSchema.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json({ error: { code: "invalid_input", message: "Invalid schedule" } }, 400);
    const { schedule, enabled } = parsed.data;
    const recurrence = {
      id: recurrences.get(taskId)?.id ?? newId(),
      sourceTaskId: taskId,
      schedule,
      enabled,
      nextOn: nextRecurrenceDate(schedule, addDaysToIsoDate(schedule.firstOn, -1)),
      previousTaskId: taskId,
      lastError: null,
    };
    recurrences.set(taskId, recurrence);
    return c.json({ recurrence });
  });
}
