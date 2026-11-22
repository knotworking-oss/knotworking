import { describe, expect, it } from "vitest";
import { createNudgeWaiter } from "./nudge-wait";

describe("createNudgeWaiter", () => {
  it("wakes a pending wait with the new cursor", async () => {
    const w = createNudgeWaiter();
    const waiting = w.wait("1", 10_000);
    w.push("2");
    expect(await waiting).toBe("2");
  });

  it("returns immediately when a newer cursor arrived while the loop was busy", async () => {
    const w = createNudgeWaiter();
    // Pushed while no wait is pending (e.g. during `writeSSE`): the wake-up has nobody to wake.
    w.push("3");
    const started = Date.now();
    expect(await w.wait("2", 10_000)).toBe("3");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("delivers two rapid cursors back to back without waiting for a heartbeat", async () => {
    const w = createNudgeWaiter();
    const waiting = w.wait("1", 10_000);
    w.push("2"); // wakes the wait
    w.push("3"); // lands while the first nudge is still being written
    expect(await waiting).toBe("3");
    expect(await w.wait("3", 20)).toBeNull();
    w.push("4");
    expect(await w.wait("3", 10_000)).toBe("4");
  });

  it("times out with null (heartbeat) when nothing new arrived", async () => {
    const w = createNudgeWaiter();
    expect(await w.wait("1", 20)).toBeNull();
    w.push("1"); // same cursor as already sent is not news
    expect(await w.wait("1", 20)).toBeNull();
  });

  it("interrupt ends a pending wait early", async () => {
    const w = createNudgeWaiter();
    const waiting = w.wait("1", 10_000);
    w.interrupt();
    expect(await waiting).toBeNull();
  });
});
