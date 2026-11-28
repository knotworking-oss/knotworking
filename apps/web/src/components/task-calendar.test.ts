import { describe, expect, it } from "vitest";
import { fromDay, toDay } from "@/lib/timeline";
import { taskCalendarDays } from "./task-calendar";

describe("task calendar ranges", () => {
  it("uses the Monday–Sunday week across a year boundary", () => {
    const { start, end } = taskCalendarDays(toDay("2027-01-01")!, "week");
    expect([fromDay(start), fromDay(end)]).toEqual(["2026-12-28", "2027-01-03"]);
  });

  it("extends a leap-year month to complete weeks", () => {
    const { start, end } = taskCalendarDays(toDay("2028-02-29")!, "month");
    expect([fromDay(start), fromDay(end)]).toEqual(["2028-01-31", "2028-03-05"]);
  });

  it("uses six rows when a 31-day month spills into another week", () => {
    const { start, end } = taskCalendarDays(toDay("2026-08-31")!, "month");
    expect(end - start + 1).toBe(42);
  });
});
