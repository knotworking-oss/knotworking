import { describe, expect, it } from "vitest";
import { nextRecurrenceDate, recurrenceScheduleSchema } from "./task-automation";

describe("task recurrence dates", () => {
  it("uses the named start date and preserves the daily interval", () => {
    const schedule = recurrenceScheduleSchema.parse({
      frequency: "daily",
      interval: 3,
      firstOn: "2026-03-28",
      timing: "on_schedule",
    });
    expect(nextRecurrenceDate(schedule, "2026-03-27")).toBe("2026-03-28");
    expect(nextRecurrenceDate(schedule, "2026-03-28")).toBe("2026-03-31");
    expect(nextRecurrenceDate(schedule, "2026-04-02")).toBe("2026-04-03");
  });

  it("keeps selected weekdays aligned to the first week of the cadence", () => {
    const schedule = recurrenceScheduleSchema.parse({
      frequency: "weekly",
      interval: 2,
      weekdays: [1, 5],
      firstOn: "2026-01-07",
      timing: "on_schedule",
    });
    expect(nextRecurrenceDate(schedule, "2026-01-06")).toBe("2026-01-09");
    expect(nextRecurrenceDate(schedule, "2026-01-09")).toBe("2026-01-19");
    expect(nextRecurrenceDate(schedule, "2026-01-19")).toBe("2026-01-23");
  });

  it("clamps to shorter months and resumes the original day afterward", () => {
    const schedule = recurrenceScheduleSchema.parse({
      frequency: "monthly",
      interval: 1,
      firstOn: "2028-01-31",
      timing: "after_completion",
    });
    expect(nextRecurrenceDate(schedule, "2028-01-31")).toBe("2028-02-29");
    expect(nextRecurrenceDate(schedule, "2028-02-29")).toBe("2028-03-31");
    expect(nextRecurrenceDate(schedule, "2028-03-31")).toBe("2028-04-30");
  });
});
