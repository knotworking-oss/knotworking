import { newId } from "@knotworking/core";
import { describe, expect, it } from "vitest";
import { connect } from "../testing/harness";

describe("Automation tools", () => {
  it("sets, reads, lists and pauses a repeat schedule using the source task ID", async () => {
    const { call, close } = await connect({ modules: ["tasks", "automation"] });
    try {
      const task_id = newId();
      const schedule = {
        frequency: "weekly",
        interval: 1,
        firstOn: "2026-04-06",
        timing: "after_completion",
      };
      const { data } = await call("set_task_recurrence", { task_id, schedule, enabled: true });
      expect(data.recurrence).toMatchObject({
        enabled: true,
        sourceTaskId: task_id,
        nextOn: schedule.firstOn,
      });
      expect((await call("get_task_recurrence", { task_id })).data).toEqual(data);
      expect((await call("list_task_recurrences", {})).data.recurrences).toMatchObject([
        { id: task_id, recurrenceId: data.recurrence.id },
      ]);
      const paused = await call("set_task_recurrence", { task_id, schedule, enabled: false });
      expect(paused.data.recurrence).toMatchObject({ id: data.recurrence.id, enabled: false });
    } finally {
      await close();
    }
  });
});
