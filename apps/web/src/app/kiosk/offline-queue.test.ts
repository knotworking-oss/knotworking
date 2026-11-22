import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFERRED_RETRY_MS,
  flushQueue,
  readQueue,
  type QueuedEvent,
  type ReplayResults,
} from "./offline-queue";

const event = (clientId: string): QueuedEvent => ({
  clientId,
  type: "clock_out",
  at: "2026-11-13T08:00:00.000Z",
  sealed: "s1.x.y.z.w",
});

describe("the kiosk's offline queue", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("knotworking.kiosk.queue", JSON.stringify([event("a"), event("b"), event("c")]));
  });

  it("keeps a clock-out waiting for its clock-in, and sends it again after a pause", async () => {
    let t = Date.parse("2026-11-13T09:00:00.000Z");
    const sent: string[][] = [];
    const answer =
      (status: Record<string, { status: string; code?: string }>) =>
      async (batch: { events: QueuedEvent[] }): Promise<{ results: ReplayResults }> => {
        sent.push(batch.events.map((e) => e.clientId));
        return { results: batch.events.map((e) => ({ clientId: e.clientId, ...status[e.clientId]! })) };
      };
    const first = answer({
      a: { status: "deferred", code: "awaiting_clock_in" },
      b: { status: "accepted" },
      c: { status: "rejected", code: "pin_invalid" },
    });
    expect(await flushQueue(first, () => t)).toEqual({ refused: 1 });
    expect(sent).toEqual([["a", "b", "c"]]);
    const queue = readQueue();
    expect(queue.map((q) => q.clientId)).toEqual(["a"]);
    expect(Date.parse(queue[0]!.retryAt!)).toBe(t + DEFERRED_RETRY_MS);

    // Not before the pause is over.
    t += 1000;
    await flushQueue(answer({ a: { status: "accepted" } }), () => t);
    expect(sent).toHaveLength(1);
    t += DEFERRED_RETRY_MS;
    await flushQueue(answer({ a: { status: "accepted" } }), () => t);
    expect(sent.at(-1)).toEqual(["a"]);
    // The retry time isn't sent to the server.
    expect(readQueue()).toEqual([]);
  });

  it("stops at the wrong-PIN throttle and keeps the rest", async () => {
    const throttled = async (batch: { events: QueuedEvent[] }) => ({
      results: batch.events.map((e) => ({
        clientId: e.clientId,
        status: "deferred",
        code: "kiosk_throttled",
      })),
    });
    await flushQueue(throttled);
    expect(readQueue().map((q) => q.clientId)).toEqual(["a", "b", "c"]);
    expect(readQueue().every((q) => q.retryAt === undefined)).toBe(true);
  });
});
