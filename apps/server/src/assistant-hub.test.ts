import { newId, type AssistantStreamMessage } from "@knotworking/core";
import {
  apiTokens,
  assistantConversations,
  assistantMessages,
  assistantRuntimeEvents,
  assistantTurns,
  users,
  workspaces,
  type DbHandle,
} from "@knotworking/db";
import { createTestDb } from "@knotworking/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssistantHub } from "./assistant-hub";
import { createAssistantToken } from "./services/api-tokens";
import { startTurn as storeTurn } from "./services/assistant";

describe("shared AssistantHub", () => {
  let handle: DbHandle, userId: string, workspaceId: string;
  beforeAll(async () => {
    handle = await createTestDb({ seed: true });
    userId = (await handle.db.select().from(users))[0]!.id;
    workspaceId = (await handle.db.select().from(workspaces))[0]!.id;
  }, 60_000);
  afterAll(() => handle.close());
  const conversation = async () => {
    const id = newId();
    await handle.db.insert(assistantConversations).values({ id, workspaceId, userId, title: "Test" });
    return id;
  };
  const start = async (hub: AssistantHub, conversationId: string) => {
    const messageId = newId(),
      turnId = newId();
    await handle.db
      .insert(assistantMessages)
      .values({ id: messageId, conversationId, role: "assistant", status: "running" });
    await hub.startTurn({ turnId, conversationId, userId, workspaceId, messageId });
    return { turnId, messageId };
  };

  it("folds events into a stored reply and tells the caller when the turn ended", async () => {
    const hub = new AssistantHub(handle.db, { sweepMs: 0 });
    const id = await conversation();
    const { turnId, messageId } = await start(hub, id);
    expect(await hub.ingest(turnId, [{ type: "text_delta", text: "Two " }])).toBe(true);
    expect((await hub.liveReply(messageId))?.parts).toEqual([
      { type: "text", text: "Two ", streaming: true },
    ]);
    expect(await hub.ingest(turnId, [{ type: "text", text: "Two tasks." }, { type: "done" }])).toBe(false);
    const [stored] = await handle.db
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.id, messageId));
    expect(stored).toMatchObject({ status: "done", parts: [{ type: "text", text: "Two tasks." }] });
    // Late events after the end are ignored, and say so.
    expect(await hub.ingest(turnId, [{ type: "text", text: "late" }])).toBe(false);
    expect(await hub.runningTurn(id)).toBeUndefined();
    hub.stop();
  });

  it("never lets a stopped turn carry on: ingest and touch both say it ended", async () => {
    const hub = new AssistantHub(handle.db, { sweepMs: 0 });
    const id = await conversation();
    const { turnId } = await start(hub, id);
    expect(await hub.touch(turnId)).toBe(true);
    expect(await hub.cancel(id)).toBe(true);
    expect(await hub.touch(turnId)).toBe(false);
    expect(await hub.ingest(turnId, [{ type: "text", text: "x" }])).toBe(false);
    expect(await hub.cancel(id)).toBe(false);
    hub.stop();
  });

  it("rolls back the prompt and reply when starting the turn fails", async () => {
    const id = await conversation();
    const [row] = await handle.db
      .select()
      .from(assistantConversations)
      .where(eq(assistantConversations.id, id));
    await expect(
      storeTurn(handle.db, row!, "hello", null, async () => {
        throw new Error("queue unavailable");
      }),
    ).rejects.toThrow("queue unavailable");
    expect(
      await handle.db.select().from(assistantMessages).where(eq(assistantMessages.conversationId, id)),
    ).toEqual([]);
  });

  it("serializes simultaneous prompts across instances and releases failed claims", async () => {
    const first = new AssistantHub(handle.db, { sweepMs: 0 }),
      second = new AssistantHub(handle.db, { sweepMs: 0 });
    const id = await conversation();
    const claims = await Promise.all([first.reserve(id), second.reserve(id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await claims.find(Boolean)!();
    const retry = await second.reserve(id);
    expect(retry).not.toBeNull();
    await retry!();
    first.stop();
    second.stop();
  });

  it("routes events, streaming and cancellation through different instances", async () => {
    const first = new AssistantHub(handle.db, { sweepMs: 0 });
    const id = await conversation();
    const { turnId, messageId } = await start(first, id);
    first.stop();
    const second = new AssistantHub(handle.db, { sweepMs: 0 });
    const third = new AssistantHub(handle.db, { sweepMs: 0 });
    const streamed: AssistantStreamMessage[] = [];
    const off = await second.subscribe(userId, workspaceId, (m) => streamed.push(m));
    await third.ingest(turnId, [{ type: "text", text: "hello" }]);
    expect((await second.liveReply(messageId))?.parts.length).toBeGreaterThan(0);
    await third.cancel(id);
    await expect.poll(() => streamed.filter((m) => m.type === "ended").length).toBe(1);
    off();
    second.stop();
    third.stop();
  });

  it("stores and announces exactly one terminal state when cancellation races completion", async () => {
    const first = new AssistantHub(handle.db, { sweepMs: 0 }),
      second = new AssistantHub(handle.db, { sweepMs: 0 });
    const id = await conversation();
    const { turnId } = await start(first, id);
    const ended: AssistantStreamMessage[] = [];
    const off = await first.subscribe(userId, workspaceId, (m) => {
      if (m.type === "ended") ended.push(m);
    });
    await Promise.all([second.ingest(turnId, [{ type: "done" }]), first.cancel(id)]);
    await expect.poll(() => ended.length).toBe(1);
    expect(await first.runningTurn(id)).toBeUndefined();
    off();
    first.stop();
    second.stop();
  });

  it("allows a member only a few running replies at once, and frees a slot when one ends", async () => {
    const hub = new AssistantHub(handle.db, { sweepMs: 0 });
    const other = (await handle.db.select().from(users))[1]!.id;
    const running: { id: string; turnId: string }[] = [];
    const begin = async () => {
      const id = newId(),
        messageId = newId(),
        turnId = newId();
      await handle.db.insert(assistantConversations).values({ id, workspaceId, userId: other, title: "Cap" });
      await handle.db
        .insert(assistantMessages)
        .values({ id: messageId, conversationId: id, role: "assistant", status: "running" });
      await hub.startTurn({ turnId, conversationId: id, userId: other, workspaceId, messageId });
      return { id, turnId };
    };
    for (let i = 0; i < 3; i++) running.push(await begin());
    await expect(begin()).rejects.toMatchObject({ code: "assistant_too_many", status: 429 });
    await hub.cancel(running[0]!.id);
    running.push(await begin()); // a slot is free again
    // Another member is unaffected.
    const mine = await conversation();
    await start(hub, mine);
    await hub.cancel(mine);
    for (const r of running) await hub.cancel(r.id);
    hub.stop();
  });

  it("ends a turn nobody is touching any more (its server stopped), but not a live one", async () => {
    const hub = new AssistantHub(handle.db, { sweepMs: 0, staleMs: 60_000 });
    const idle = await conversation(),
      live = await conversation();
    const stale = await start(hub, idle);
    const fresh = await start(hub, live);
    await handle.db
      .update(assistantTurns)
      .set({ lastEventAt: new Date(Date.now() - 120_000) })
      .where(eq(assistantTurns.id, stale.turnId));
    await hub.sweep();
    const [a] = await handle.db
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.id, stale.messageId));
    const [b] = await handle.db
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.id, fresh.messageId));
    expect(a).toMatchObject({ status: "error" });
    expect(a!.error).toContain("server stopped");
    expect(b).toMatchObject({ status: "running" });
    await hub.cancel(live);
    hub.stop();
  });

  it("prunes old events and turns, and single-turn tokens that were never cleaned up", async () => {
    const hub = new AssistantHub(handle.db, { sweepMs: 0 });
    const id = await conversation();
    const { turnId } = await start(hub, id);
    await hub.ingest(turnId, [{ type: "done" }]);
    const longAgo = new Date(Date.now() - 2 * 86_400_000);
    await handle.db.update(assistantTurns).set({ endedAt: longAgo }).where(eq(assistantTurns.id, turnId));
    await handle.db.update(assistantRuntimeEvents).set({ createdAt: longAgo });
    const orphan = await createAssistantToken(handle.db, userId, "read");
    await handle.db.update(apiTokens).set({ createdAt: longAgo }).where(eq(apiTokens.id, orphan.id));
    await hub.sweep();
    expect(await handle.db.select().from(assistantTurns).where(eq(assistantTurns.id, turnId))).toEqual([]);
    expect(await handle.db.select().from(assistantRuntimeEvents)).toEqual([]);
    expect(await handle.db.select().from(apiTokens).where(eq(apiTokens.id, orphan.id))).toEqual([]);
    hub.stop();
  });
});
