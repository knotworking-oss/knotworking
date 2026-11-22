import { describe, expect, it } from "vitest";
import { makeTask } from "@/test/fixtures";
import { loggedByTask, projectTime, runningTimer, type TimeEntry } from "./time";

const entry = (id: string, taskId: string, minutes: number | null, userId = "u1") =>
  ({ id, taskId, userId, minutes, startedAt: minutes === null ? "2026-01-01T00:00:00Z" : null }) as TimeEntry;

describe("time totals", () => {
  const entries = [
    entry("1", "a", 30),
    entry("2", "a", 15, "u2"),
    entry("3", "b", 60),
    entry("4", "b", null),
  ];

  it("sums finished minutes per task", () => {
    expect(Object.fromEntries(loggedByTask(entries))).toEqual({ a: 45, b: 60 });
  });

  it("totals logged and estimated time per project over live tasks only", () => {
    const tasks = [
      makeTask({ id: "a", projectId: "p", estimateMinutes: 60 }),
      makeTask({ id: "b", projectId: "p" }),
      makeTask({ id: "c", projectId: "q", estimateMinutes: 30 }),
      makeTask({ id: "d" }),
    ];
    // "gone" is a deleted task: its entries don't count.
    const logged = loggedByTask([...entries, entry("5", "gone", 99)]);
    expect(Object.fromEntries(projectTime(tasks, logged))).toEqual({
      p: { logged: 105, estimate: 60 },
      q: { logged: 0, estimate: 30 },
    });
  });

  it("finds a user's running timer", () => {
    expect(runningTimer(entries, "u1")?.id).toBe("4");
    expect(runningTimer(entries, "u2")).toBeUndefined();
  });
});
