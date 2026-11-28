import { z } from "zod";
import { biDashboardViewParamsSchema, biQuerySpecSchema } from "./bi";
import type { ModuleId } from "./modules";
import { dateInZone, timeZoneOffsetMinutes } from "./time-zone";

const title = z.string().trim().min(1).max(120);
const ref = z.uuid();
const condition = z.strictObject({
  stepId: ref,
  metric: z.string().min(1).max(100),
  operator: z.enum(["gt", "gte", "lt", "lte", "eq"]),
  value: z.number().finite(),
});
const step = z.strictObject({ id: ref, title });
const stock = step.extend({
  kind: z.literal("stock.position"),
  locationId: ref.nullable(),
  limit: z.number().int().min(1).max(100),
});
const quality = step.extend({ kind: z.literal("quality.audit_requirements") });
const governance = step.extend({ kind: z.literal("governance.standard_gaps"), standardId: ref });
const query = step.extend({ kind: z.literal("bi.query"), query: biQuerySpecSchema });
const snapshot = step.extend({
  kind: z.literal("bi.snapshot"),
  dashboardId: ref,
  params: biDashboardViewParamsSchema.optional(),
});
const draft = step.extend({
  kind: z.literal("bi.dashboard_draft"),
  dashboardId: ref,
  params: biDashboardViewParamsSchema.optional(),
});
const task = step.extend({
  kind: z.literal("tasks.follow_up"),
  teamId: ref,
  assigneeId: ref.nullable(),
  condition,
});
const notify = step.extend({ kind: z.literal("automation.notify"), recipients: z.array(ref).min(1).max(30) });

export const pipelineStepSchema = z.discriminatedUnion("kind", [
  stock,
  quality,
  governance,
  query,
  snapshot,
  draft,
  task,
  notify,
]);
export type PipelineStep = z.infer<typeof pipelineStepSchema>;
export type PipelineKind = PipelineStep["kind"];
export type PipelineCondition = z.infer<typeof condition>;

export const pipelineCapabilities = {
  "stock.position": {
    module: "stock",
    level: "read",
    label: "Stock position",
    metrics: ["items", "expiring"],
  },
  "quality.audit_requirements": {
    module: "quality",
    level: "read",
    label: "Audit requirements",
    metrics: ["overdue_audits", "upcoming_audits", "overdue_actions"],
  },
  "governance.standard_gaps": {
    module: "governance",
    level: "read",
    label: "Standard gaps",
    metrics: ["open_gaps", "overdue_findings"],
  },
  "bi.query": { module: "bi", level: "read", label: "Run a data query", metrics: ["rows"] },
  "bi.snapshot": { module: "bi", level: "manage", label: "Save dashboard snapshot", metrics: [] },
  "bi.dashboard_draft": { module: "bi", level: "write", label: "Create dashboard draft", metrics: [] },
  "tasks.follow_up": { module: "tasks", level: "write", label: "Create follow-up task", metrics: [] },
  "automation.notify": {
    module: "automation",
    level: "manage",
    label: "Notify workspace members",
    metrics: [],
  },
} as const satisfies Record<
  PipelineKind,
  {
    module: ModuleId;
    level: "read" | "write" | "manage";
    label: string;
    metrics: readonly string[];
  }
>;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a time in HH:MM format");
export const pipelineScheduleSchema = z.discriminatedUnion("frequency", [
  z.strictObject({ frequency: z.literal("daily"), time }),
  z.strictObject({
    frequency: z.literal("weekly"),
    time,
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  }),
  z.strictObject({ frequency: z.literal("monthly"), time, day: z.number().int().min(1).max(31) }),
]);
export type PipelineSchedule = z.infer<typeof pipelineScheduleSchema>;

export const pipelineEventKinds = ["stock.received", "quality.audit_planned"] as const;
export type PipelineEventKind = (typeof pipelineEventKinds)[number];
export const pipelineEvents = {
  "stock.received": { module: "stock", label: "Stock receipt recorded" },
  "quality.audit_planned": { module: "quality", label: "Audit planned" },
} as const satisfies Record<PipelineEventKind, { module: ModuleId; label: string }>;

export const automationPipelineSchema = z
  .strictObject({
    name: title,
    enabled: z.boolean(),
    schedule: pipelineScheduleSchema.nullable(),
    eventTriggers: z.array(z.enum(pipelineEventKinds)).max(pipelineEventKinds.length).default([]),
    steps: z.array(pipelineStepSchema).min(1).max(12),
  })
  .superRefine(({ steps }, ctx) => {
    const earlier = new Map<string, PipelineStep>();
    for (const [index, value] of steps.entries()) {
      if (earlier.has(value.id))
        ctx.addIssue({ code: "custom", path: ["steps", index], message: "Step IDs must be unique" });
      if (value.kind === "tasks.follow_up") {
        const source = earlier.get(value.condition.stepId);
        const metrics: readonly string[] = source ? pipelineCapabilities[source.kind].metrics : [];
        if (!metrics.includes(value.condition.metric)) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", index, "condition"],
            message: "Choose a metric from an earlier step",
          });
        }
      }
      earlier.set(value.id, value);
    }
  });

export type AutomationPipelineInput = z.infer<typeof automationPipelineSchema>;

export type PipelineValue = string | number | boolean | null;
export type PipelineOutput = {
  status: "completed" | "unavailable" | "skipped" | "failed";
  metrics?: Record<string, number>;
  columns?: string[];
  rows?: PipelineValue[][];
  note?: string;
  artifact?: { kind: "task" | "snapshot" | "dashboard"; id: string };
};

export function duePipelineDate(schedule: PipelineSchedule, zone: string, now: Date): string | null {
  const day = dateInZone(now, zone);
  const local = new Date(now.getTime() + timeZoneOffsetMinutes(now, zone) * 60_000);
  if (local.toISOString().slice(11, 16) < schedule.time) return null;
  if (schedule.frequency === "weekly" && !schedule.weekdays.includes(((local.getUTCDay() + 6) % 7) + 1))
    return null;
  if (schedule.frequency === "monthly") {
    const end = new Date(local);
    end.setUTCMonth(local.getUTCMonth() + 1, 0);
    if (local.getUTCDate() !== Math.min(schedule.day, end.getUTCDate())) return null;
  }
  return day;
}

export function matchesPipelineCondition(condition: PipelineCondition, value: number): boolean {
  switch (condition.operator) {
    case "gt":
      return value > condition.value;
    case "gte":
      return value >= condition.value;
    case "lt":
      return value < condition.value;
    case "lte":
      return value <= condition.value;
    case "eq":
      return value === condition.value;
  }
}
