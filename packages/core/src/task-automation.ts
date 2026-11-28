import { z } from "zod";
import { addDaysToIsoDate, addMonthsToIsoDate } from "./sops";
import { taskFilterSchema } from "./task-filter";
import { customFieldValueSchema } from "./custom-fields";

export const recurrenceScheduleSchema = z
  .strictObject({
    frequency: z.enum(["daily", "weekly", "monthly"]),
    interval: z.number().int().min(1).max(365),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    firstOn: z.iso.date(),
    timing: z.enum(["on_schedule", "after_completion"]),
  })
  .refine((schedule) => schedule.frequency === "weekly" || schedule.weekdays.length === 0, {
    message: "Weekdays apply to weekly schedules",
  });
export type RecurrenceSchedule = z.infer<typeof recurrenceScheduleSchema>;

/** Advance a workspace calendar date. Keep the original day of month after a short month. */
export function nextRecurrenceDate(schedule: RecurrenceSchedule, after: string): string {
  const anchor = new Date(schedule.firstOn + "T00:00:00Z");
  const cursor = new Date(after + "T00:00:00Z");
  if (schedule.frequency === "monthly") {
    const elapsed =
      (cursor.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + cursor.getUTCMonth() - anchor.getUTCMonth();
    for (let count = Math.max(0, Math.floor(elapsed / schedule.interval)); ; count++) {
      const candidate = addMonthsToIsoDate(schedule.firstOn, count * schedule.interval);
      if (Date.parse(candidate) > cursor.valueOf()) return candidate;
    }
  }
  const dayMs = 86_400_000;
  const elapsed = Math.floor((cursor.valueOf() - anchor.valueOf()) / dayMs);
  if (schedule.frequency === "daily") {
    const days = Math.max(0, Math.floor(elapsed / schedule.interval) + 1) * schedule.interval;
    return addDaysToIsoDate(schedule.firstOn, days);
  }
  const firstWeekday = ((anchor.getUTCDay() + 6) % 7) + 1;
  const weekdays = [...new Set(schedule.weekdays.length ? schedule.weekdays : [firstWeekday])].sort(
    (a, b) => a - b,
  );
  const lastWeek = Math.floor((elapsed + firstWeekday - 1) / 7);
  for (
    let week = Math.max(0, Math.floor(lastWeek / schedule.interval) * schedule.interval);
    ;
    week += schedule.interval
  ) {
    for (const weekday of weekdays) {
      const offset = week * 7 + weekday - firstWeekday;
      if (offset >= 0 && offset > elapsed) return addDaysToIsoDate(schedule.firstOn, offset);
    }
  }
}

export const automationTriggers = [
  "task_created",
  "state_changed",
  "assignee_changed",
  "label_added",
  "due_date_passed",
] as const;
export type AutomationTrigger = (typeof automationTriggers)[number];
const shortText = z.string().trim().min(1).max(1000);
export const automationActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("set_state"), stateId: z.uuid() }),
  z.strictObject({ kind: z.literal("assign"), assigneeId: z.uuid().nullable() }),
  z.strictObject({ kind: z.literal("add_label"), labelId: z.uuid() }),
  z.strictObject({
    kind: z.literal("set_field"),
    fieldId: z.uuid(),
    value: customFieldValueSchema.shape.value,
  }),
  z.strictObject({ kind: z.literal("create_subtask"), title: z.string().trim().min(1).max(512) }),
  z.strictObject({ kind: z.literal("comment"), text: shortText }),
  z.strictObject({ kind: z.literal("notify"), userId: z.uuid(), text: shortText }),
  z.strictObject({ kind: z.literal("call_webhook"), webhookId: z.uuid() }),
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;
export const automationRuleSchema = z
  .strictObject({
    name: shortText,
    teamId: z.uuid().nullable(),
    trigger: z.enum(automationTriggers),
    filter: taskFilterSchema.nullable(),
    actions: z.array(automationActionSchema).min(1).max(10),
    enabled: z.boolean(),
  })
  .refine((rule) => rule.teamId !== null || !rule.actions.some((action) => action.kind === "set_state"), {
    path: ["teamId"],
    message: "Choose a team for the Set status action",
  });
export const automationWebhookSchema = z.strictObject({
  name: shortText,
  url: z.url().max(2048),
  events: z.array(z.enum(automationTriggers)).max(automationTriggers.length),
  filter: taskFilterSchema.nullable(),
  enabled: z.boolean(),
});
export type AutomationRuleInput = z.infer<typeof automationRuleSchema>;
export type AutomationWebhookInput = z.infer<typeof automationWebhookSchema>;

export const taskRecurrenceSchema = z.strictObject({
  schedule: recurrenceScheduleSchema,
  enabled: z.boolean(),
});
