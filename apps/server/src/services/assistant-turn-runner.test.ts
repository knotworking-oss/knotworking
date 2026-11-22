import { newId } from "@knotworking/core";
import {
  apiTokens,
  assistantConversations,
  assistantMessages,
  users,
  workspaces,
  type DbHandle,
} from "@knotworking/db";
import { createTestDb } from "@knotworking/db/testing";
import { desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AssistantHub } from "../assistant-hub";
import {
  fakeProviders,
  fakeTools,
  mcpText,
  scriptedModel,
  textStep,
  toolStep,
  VALID_KEY,
} from "../assistant-testkit";
import { startTurn as storeTurn } from "./assistant";
import { deriveAssistantKeyKey } from "./assistant-crypto";
import { saveKey } from "./assistant-keys";
import { AssistantTurnRunner, type OpenTools } from "./assistant-turn";

/** The runner against a real database, to reach the failures a route test can't cause. */
describe("AssistantTurnRunner failure handling", () => {
  let handle: DbHandle, userId: string, workspaceId: string;
  const keyKey = deriveAssistantKeyKey("runner-test-secret-0123456789abcdef");
  let hub: AssistantHub;
  let runner: AssistantTurnRunner;
  let openTools: OpenTools;
  let model = scriptedModel([textStep("hi")]);
  const providers = fakeProviders(() => model);

  beforeAll(async () => {
    handle = await createTestDb({ seed: true });
    userId = (await handle.db.select().from(users))[0]!.id;
    workspaceId = (await handle.db.select().from(workspaces))[0]!.id;
    await saveKey(handle.db, keyKey, providers.registry, userId, "claude", {
      key: VALID_KEY,
      model: "fake-large",
    });
  }, 60_000);
  afterAll(() => handle.close());
  afterEach(() => {
    vi.restoreAllMocks();
    hub?.stop();
  });

  const setup = (deps: { openTools: OpenTools }, options = {}) => {
    hub = new AssistantHub(handle.db, { sweepMs: 0 });
    openTools = deps.openTools;
    runner = new AssistantTurnRunner(
      handle.db,
      hub,
      keyKey,
      { providers: providers.registry, openTools: (t, s) => openTools(t, s) },
      { flushMs: 10, pollMs: 20, connectTimeoutMs: 150, timeoutMs: 5_000, ...options },
    );
  };
  const begin = async (modules = ["tasks", "docs"] as const) => {
    const id = newId();
    await handle.db.insert(assistantConversations).values({ id, workspaceId, userId, title: "T" });
    const [row] = await handle.db
      .select()
      .from(assistantConversations)
      .where(eq(assistantConversations.id, id));
    const turnId = newId();
    const { reply } = await storeTurn(handle.db, row!, "hello", null, async (tx, r) => {
      await hub.queueTurn(tx, { turnId, conversationId: id, userId, workspaceId, messageId: r.id });
    });
    const params = {
      turnId,
      conversationId: id,
      messageId: reply.id,
      userId,
      workspace: { slug: "acme", name: "Acme" },
      user: { name: "Ada" },
      provider: "claude" as const,
      model: null,
      scope: "write" as const,
      modules: modules as never,
      prompt: "hello",
      context: null,
    };
    return { id, turnId, messageId: reply.id, params };
  };
  const message = async (id: string) =>
    (await handle.db.select().from(assistantMessages).where(eq(assistantMessages.id, id)))[0]!;
  const lastToken = async () =>
    (
      await handle.db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.kind, "assistant"))
        .orderBy(desc(apiTokens.createdAt))
        .limit(1)
    )[0]!;

  it("limits the token to the modules the member chose, at the API", async () => {
    const tools = fakeTools({ list_tasks: () => mcpText("ok") });
    setup(tools);
    model = scriptedModel([textStep("hi")]);
    const t = await begin(["tasks", "docs"]);
    runner.start(t.params);
    await runner.idle();
    expect((await message(t.messageId)).status).toBe("done");
    expect((await lastToken()).modules).toEqual(["tasks", "docs"]);
  });

  it("retries a failed event write once and still finishes the reply", async () => {
    const tools = fakeTools({ list_tasks: () => mcpText("ok") });
    setup(tools);
    model = scriptedModel([textStep("Recovered.")]);
    const real = hub.ingest.bind(hub);
    let failed = false;
    vi.spyOn(hub, "ingest").mockImplementation(async (turnId, events) => {
      if (!failed) {
        failed = true;
        throw new Error("connection reset");
      }
      return real(turnId, events);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await begin();
    runner.start(t.params);
    await runner.idle();
    expect(failed).toBe(true);
    expect(await message(t.messageId)).toMatchObject({ status: "done" });
  });

  it("survives event writes that keep failing: no crash, the turn stops, its token is revoked", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    // A slow tool, so the write fails mid-turn with nothing awaiting it yet (like a real outage).
    const tools = fakeTools({
      list_tasks: async () => {
        await new Promise((r) => setTimeout(r, 300));
        return mcpText("ok");
      },
    });
    setup(tools);
    model = scriptedModel([toolStep("c1", "list_tasks"), textStep("never stored")]);
    vi.spyOn(hub, "ingest").mockRejectedValue(new Error("database is down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await begin();
    runner.start(t.params);
    await runner.idle();
    await new Promise((r) => setTimeout(r, 50));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(logged).toHaveBeenCalled();
    expect((await lastToken()).revokedAt).not.toBeNull();
    expect(tools.opened[0]!.closed).toBe(true);
    // The reply is left running; the hub's sweep ends it once it goes quiet.
    vi.restoreAllMocks();
    expect((await message(t.messageId)).status).toBe("running");
    await hub.cancel(t.id);
  });

  it("gives up on an MCP connection that never answers, and cleans up if it answers late", async () => {
    let late: { closed: boolean } | undefined;
    const hung: OpenTools = (_token, _sel) =>
      new Promise((resolve) => {
        setTimeout(() => {
          late = { closed: false };
          resolve({ tools: {}, close: async () => void (late!.closed = true) });
        }, 400);
      });
    setup({ openTools: hung });
    const t = await begin();
    const started = Date.now();
    runner.start(t.params);
    await runner.idle();
    expect(Date.now() - started).toBeLessThan(380);
    const done = await message(t.messageId);
    expect(done.status).toBe("error");
    expect(done.error).toContain("MCP server");
    expect((await lastToken()).revokedAt).not.toBeNull();
    await vi.waitFor(() => expect(late?.closed).toBe(true));
  });

  it("ends running replies on shutdown with an error and revokes their tokens", async () => {
    const tools = fakeTools({ list_tasks: () => mcpText("ok") });
    setup(tools);
    model = scriptedModel([textStep("slow")], { holdMs: 3_000 });
    const t = await begin();
    runner.start(t.params);
    await vi.waitFor(() => expect(tools.opened).toHaveLength(1));
    await hub.drain();
    const done = await message(t.messageId);
    expect(done).toMatchObject({ status: "error" });
    expect(done.error).toContain("server restarted");
    expect((await lastToken()).revokedAt).not.toBeNull();
    expect(tools.opened[0]!.closed).toBe(true);
  });
});
