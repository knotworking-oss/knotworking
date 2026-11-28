import { describe, expect, it } from "vitest";
import { duePipelineDate, automationPipelineSchema } from "./automation-pipeline";

describe("automation pipeline schedules", () => {
  it("uses the same local hour across the daylight saving change", () => {
    const schedule = { frequency: "daily", time: "07:00" } as const;
    expect(duePipelineDate(schedule, "Europe/London", new Date("2026-03-28T06:59:00Z"))).toBeNull();
    expect(duePipelineDate(schedule, "Europe/London", new Date("2026-03-28T07:00:00Z"))).toBe("2026-03-28");
    expect(duePipelineDate(schedule, "Europe/London", new Date("2026-03-29T05:59:00Z"))).toBeNull();
    expect(duePipelineDate(schedule, "Europe/London", new Date("2026-03-29T06:00:00Z"))).toBe("2026-03-29");
  });

  it("handles selected weekdays and clamps monthly runs to the end of a short month", () => {
    const weekend = { frequency: "weekly", time: "07:00", weekdays: [6, 7] } as const;
    expect(
      duePipelineDate(
        { ...weekend, weekdays: [...weekend.weekdays] },
        "Europe/London",
        new Date("2026-02-27T07:00:00Z"),
      ),
    ).toBeNull();
    expect(
      duePipelineDate(
        { frequency: "monthly", time: "07:00", day: 31 },
        "Europe/London",
        new Date("2026-02-28T07:00:00Z"),
      ),
    ).toBe("2026-02-28");
  });

  it("validates a threshold against metrics from earlier steps", () => {
    const source = {
      id: "00000000-0000-4000-8000-000000000001",
      kind: "quality.audit_requirements",
      title: "Audits",
    };
    const task = {
      id: "00000000-0000-4000-8000-000000000002",
      kind: "tasks.follow_up",
      title: "Check audits",
      teamId: "00000000-0000-4000-8000-000000000003",
      assigneeId: null,
      condition: { stepId: source.id, metric: "overdue_audits", operator: "gt", value: 0 },
    };
    const base = { name: "Audit pipeline", enabled: false, schedule: null };
    expect(automationPipelineSchema.safeParse({ ...base, steps: [source, task] }).success).toBe(true);
    expect(automationPipelineSchema.safeParse({ ...base, steps: [task, source] }).success).toBe(false);
  });
});
