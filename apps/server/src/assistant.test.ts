import type { AssistantStreamMessage } from "@knotworking/core";
import { apiTokens, assistantProviderKeys, assistantSettings } from "@knotworking/db";
import { desc, eq } from "drizzle-orm";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  fakeProviders,
  fakeTools,
  mcpText,
  scriptedModel,
  textStep,
  toolStep,
  VALID_KEY,
} from "./assistant-testkit";
import { makeApp, signIn, type TestCtx } from "./test-utils";
import type { OpenTools } from "./services/assistant-turn";

type Model = ReturnType<typeof scriptedModel> | MockLanguageModelV4;

describe("assistant (member API keys)", () => {
  let ctx: TestCtx;
  let ada: string;
  let member: string;
  let model: Model;
  let tools: ReturnType<typeof fakeTools>;
  let providers: ReturnType<typeof fakeProviders>;
  let openTools: OpenTools;

  beforeAll(async () => {
    providers = fakeProviders(() => model as never);
    ctx = await makeApp({
      seed: true,
      assistantDeps: {
        providers: providers.registry,
        openTools: (token, selection) => openTools(token, selection),
        turnOptions: { flushMs: 10, pollMs: 20, maxSteps: 3, timeoutMs: 4_000 },
      },
    });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    member = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx.handle.close());
  beforeEach(() => {
    tools = fakeTools({ list_tasks: () => mcpText("3 tasks due") });
    openTools = tools.openTools;
    model = scriptedModel([toolStep("c1", "list_tasks"), textStep("Two tasks are due.")]);
  });

  const saveKey = (cookie: string, provider: string, key: string, extra: object = {}) =>
    ctx.req(`/v1/me/assistant/keys/${provider}`, { method: "PUT", cookie, json: { key, ...extra } });
  const newChat = async (cookie = ada, json: object = {}) =>
    (
      await (
        await ctx.req("/v1/workspaces/acme/assistant/conversations", { method: "POST", cookie, json })
      ).json()
    ).conversation as { id: string; provider: string; model: string | null };
  const send = (id: string, text: string, cookie = ada) =>
    ctx.req(`/v1/workspaces/acme/assistant/conversations/${id}/messages`, {
      method: "POST",
      cookie,
      json: { text, context: { path: "/acme/tasks", title: "Tasks" } },
    });
  const read = async (id: string, cookie = ada) =>
    (await (await ctx.req(`/v1/workspaces/acme/assistant/conversations/${id}`, { cookie })).json()) as {
      conversation: { title: string; provider: string; model: string | null };
      messages: { role: string; status: string; error: string | null; parts: any[] }[];
    };
  const waitDone = async (id: string, cookie = ada) => {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const c = await read(id, cookie);
      const last = c.messages.at(-1);
      if (last && last.status !== "running") return c;
      if (Date.now() > deadline) throw new Error("reply never finished");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const until = async (pred: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error("condition never became true");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("refuses keys to members without the module, and to API tokens", async () => {
    const res = await saveKey(member, "claude", VALID_KEY);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("module_forbidden");
    // Every route that uses or changes the key needs the module, not only saving it.
    for (const [path, method, json] of [
      ["/v1/me/assistant/keys/claude/models", "GET", undefined],
      ["/v1/me/assistant/keys/claude", "PATCH", { model: "x" }],
      ["/v1/me/assistant/settings", "PATCH", { scope: "write" }],
    ] as const) {
      const r = await ctx.req(path, { method, cookie: member, ...(json ? { json } : {}) });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    const minted = await (
      await ctx.req("/v1/me/api-tokens", {
        method: "POST",
        cookie: ada,
        json: { name: "agent", scope: "write" },
      })
    ).json();
    const headers = { authorization: `Bearer ${minted.token}`, origin: "" };
    for (const [path, method] of [
      ["/v1/me/assistant/keys", "GET"],
      ["/v1/me/assistant/keys/claude", "PUT"],
      ["/v1/me/assistant/settings", "GET"],
      ["/v1/workspaces/acme/assistant/status", "GET"],
    ] as const) {
      const r = await ctx.req(path, {
        method,
        headers,
        ...(method === "PUT" ? { json: { key: VALID_KEY } } : {}),
      });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
  });

  it("checks a key with the provider before storing it, and never returns or stores it in the clear", async () => {
    const bad = await saveKey(ada, "claude", "sk-not-a-real-key-000");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("key_rejected");
    const down = await saveKey(ada, "claude", "unreachable-key");
    expect(down.status).toBe(502);
    expect((await (await ctx.req("/v1/me/assistant/keys", { cookie: ada })).json()).keys).toEqual([]);

    const ok = await saveKey(ada, "claude", VALID_KEY);
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).not.toContain(VALID_KEY);
    const body = JSON.parse(text);
    expect(body.key).toMatchObject({ provider: "claude", last4: "7890", model: null });
    expect(body.models).toEqual(["fake-large", "fake-small"]);

    const listed = await (await ctx.req("/v1/me/assistant/keys", { cookie: ada })).text();
    expect(listed).not.toContain(VALID_KEY);
    expect(listed).not.toContain("ciphertext");
    const [row] = await ctx.handle.db.select().from(assistantProviderKeys);
    expect(row!.ciphertext).not.toContain(VALID_KEY);

    // The first key saved becomes the default provider.
    const settings = await (await ctx.req("/v1/me/assistant/settings", { cookie: ada })).json();
    expect(settings.settings).toMatchObject({ scope: "read", defaultProvider: "claude" });
    const models = await (await ctx.req("/v1/me/assistant/keys/claude/models", { cookie: ada })).json();
    expect(models.models).toEqual(["fake-large", "fake-small"]);
  });

  it("asks for a key or a model before it will run a turn", async () => {
    const other = await newChat(ada, { provider: "openai" });
    const noKey = await send(other.id, "hi");
    expect(noKey.status).toBe(409);
    expect((await noKey.json()).error.code).toBe("no_provider_key");

    const chat = await newChat();
    expect(chat.provider).toBe("claude");
    const noModel = await send(chat.id, "hi");
    expect(noModel.status).toBe(409);
    expect((await noModel.json()).error.code).toBe("no_model");
    // Nothing was stored for either refusal.
    expect((await read(chat.id)).messages).toEqual([]);
  });

  it("runs a turn: model → MCP tool → streamed events → stored reply, then cleans up its token", async () => {
    await ctx.req("/v1/me/assistant/keys/claude", {
      method: "PATCH",
      cookie: ada,
      json: { model: "fake-large" },
    });
    const chat = await newChat();

    const stream = await ctx.req("/v1/workspaces/acme/assistant/stream", { cookie: ada });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    const received: AssistantStreamMessage[] = [];
    let buffer = "";
    const readUntil = async (pred: (m: AssistantStreamMessage) => boolean) => {
      while (!received.some(pred)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += decoder.decode(value);
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop()!;
        for (const c of chunks) {
          const data = c.split("\n").find((l) => l.startsWith("data:"));
          if (data) received.push(JSON.parse(data.slice(5)));
        }
      }
    };

    const sent = await send(chat.id, "What is due this week?");
    expect(sent.status).toBe(201);
    expect((await sent.json()).reply.status).toBe("running");
    await readUntil((m) => m.type === "ended");
    await reader.cancel();
    const kinds = received.flatMap((m) => (m.type === "event" ? [m.event.type] : []));
    expect(kinds[0]).toBe("tool_use");
    expect(kinds.at(-1)).toBe("done");
    expect(kinds).toContain("tool_result");

    const done = await waitDone(chat.id);
    expect(done.conversation.title).toBe("What is due this week?");
    expect(done.messages.map((m) => [m.role, m.status])).toEqual([
      ["user", "done"],
      ["assistant", "done"],
    ]);
    expect(done.messages[1]!.parts).toEqual([
      { type: "tool", id: "c1", name: "list_tasks", input: "{}", status: "done", output: "3 tasks due" },
      { type: "text", text: "Two tasks are due." },
    ]);

    // The member's key and model were used, and the model saw who asked and which page.
    expect(providers.built.at(-1)).toMatchObject({
      provider: "claude",
      key: VALID_KEY,
      modelId: "fake-large",
    });
    const call = (model as MockLanguageModelV4).doStreamCalls[0]!;
    const prompt = JSON.stringify(call.prompt);
    expect(prompt).toContain("What is due this week?");
    expect(prompt).toContain('path \\"/acme/tasks\\"');
    expect(prompt).toContain('slug \\"acme\\"');

    // The tools were reached with a temporary, unlisted, read-only token that is gone again.
    expect(tools.opened).toHaveLength(1);
    expect(tools.opened[0]!.token).toMatch(/^knw_/);
    // A read-only member is offered read-only tools, and only the starter modules' (not all 275).
    expect(tools.opened[0]!.selection).toEqual({ readOnly: true, modules: ["tasks", "docs", "time"] });
    await until(() => tools.opened[0]!.closed);
    const [tokenRow] = await ctx.handle.db
      .select()
      .from(apiTokens)
      .orderBy(desc(apiTokens.createdAt))
      .limit(1);
    expect(tokenRow).toMatchObject({ kind: "assistant", scope: "read", name: "Assistant" });
    expect(tokenRow!.revokedAt).not.toBeNull();
    const after = await ctx.req("/v1/workspaces/acme/tasks", {
      headers: { authorization: `Bearer ${tools.opened[0]!.token}`, origin: "" },
    });
    expect(after.status).toBe(401);
    const listed = await (await ctx.req("/v1/me/api-tokens", { cookie: ada })).json();
    expect(JSON.stringify(listed)).not.toContain("Assistant");
  });

  it("gives the model the core tools and the page's module, and more only after load_modules", async () => {
    const handlers = Object.fromEntries(
      ["get_workspace_overview", "list_modules", "find_records", "get_record", "create_task", "log_time"].map(
        (n) => [n, () => mcpText("ok")],
      ),
    );
    tools = fakeTools(handlers, {
      catalogue: {
        core: ["get_workspace_overview"],
        modules: [
          { id: "tasks", name: "Tasks", tools: ["create_task"] },
          { id: "time", name: "Time", tools: ["log_time"] },
        ],
      },
    });
    openTools = tools.openTools;
    model = scriptedModel([toolStep("c1", "load_modules", { modules: ["time"] }), textStep("Loaded.")]);
    const chat = await newChat();
    await send(chat.id, "log an hour"); // sent from /acme/tasks
    const done = await waitDone(chat.id);
    expect(done.messages.at(-1)!.status).toBe("done");
    const calls = (model as MockLanguageModelV4).doStreamCalls;
    const offered = (i: number) => (calls[i]!.tools ?? []).map((t: { name: string }) => t.name);
    expect(offered(0)).toEqual([
      "get_workspace_overview",
      "list_modules",
      "find_records",
      "get_record",
      "load_modules",
      "create_task",
    ]);
    expect(offered(1)).toContain("log_time");
    // Claude: the instructions (and the tools before them) are marked for prompt caching.
    expect(calls[0]!.prompt[0]).toMatchObject({
      role: "system",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(JSON.stringify(calls[0]!.prompt[0])).toContain("load_modules");
    // ...and the last core tool too, so loading a module keeps the core tools cached.
    const loadModules = (step: number) =>
      calls[step]!.tools!.find((t: { name: string }) => t.name === "load_modules") as {
        providerOptions?: unknown;
      };
    expect(loadModules(0).providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    const names = (step: number) => calls[step]!.tools!.map((t: { name: string }) => t.name);
    expect(names(1).slice(0, names(0).indexOf("load_modules") + 1)).toEqual(
      names(0).slice(0, names(0).indexOf("load_modules") + 1),
    );
  });

  it("says the tool list couldn't be read, instead of offering every tool, when list_modules fails", async () => {
    tools = fakeTools({}, { failCatalogue: true });
    openTools = tools.openTools;
    const chat = await newChat();
    await send(chat.id, "hi");
    const done = await waitDone(chat.id);
    expect(done.messages.at(-1)!.status).toBe("error");
    expect(done.messages.at(-1)!.error).toMatch(/couldn't read which Knotworking tools/);
    expect((model as MockLanguageModelV4).doStreamCalls).toHaveLength(0);
  });

  it("follow-ups replay what was said, and the member's scope setting decides the token", async () => {
    const chat = await newChat();
    await send(chat.id, "first");
    await waitDone(chat.id);
    const patched = await ctx.req("/v1/me/assistant/settings", {
      method: "PATCH",
      cookie: ada,
      json: { scope: "write" },
    });
    expect((await patched.json()).settings.scope).toBe("write");
    model = scriptedModel([textStep("Second answer.")]);
    await send(chat.id, "second");
    await waitDone(chat.id);
    const prompt = JSON.parse(JSON.stringify((model as MockLanguageModelV4).doStreamCalls[0]!.prompt));
    const roles = prompt.map((m: { role: string }) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    expect(JSON.stringify(prompt)).toContain("Two tasks are due.");
    const [tokenRow] = await ctx.handle.db
      .select()
      .from(apiTokens)
      .orderBy(desc(apiTokens.createdAt))
      .limit(1);
    expect(tokenRow).toMatchObject({ kind: "assistant", scope: "write" });
    await ctx.req("/v1/me/assistant/settings", { method: "PATCH", cookie: ada, json: { scope: "read" } });
  });

  it("while a reply runs: one turn per chat, the token can't reach the assistant, and Stop ends it and cleans up", async () => {
    model = scriptedModel([textStep("slow")], { holdMs: 3_000 });
    const chat = await newChat();
    expect((await send(chat.id, "hold on")).status).toBe(201);
    expect((await send(chat.id, "again")).status).toBe(409);
    const busy = await send(chat.id, "again");
    expect((await busy.json()).error.code).toBe("assistant_busy");

    await until(() => tools.opened.length === 1);
    const headers = { authorization: `Bearer ${tools.opened[0]!.token}`, origin: "" };
    // It works on the workspace like any read token…
    expect((await ctx.req("/v1/workspaces/acme/tasks", { headers })).status).toBe(200);
    // …but cannot touch the assistant, keys or settings, and cannot write.
    expect((await ctx.req("/v1/workspaces/acme/assistant/conversations", { headers })).status).toBe(403);
    expect((await ctx.req("/v1/me/assistant/keys", { headers })).status).toBe(403);
    expect(
      (await ctx.req("/v1/workspaces/acme/tasks", { method: "POST", headers, json: { title: "nope" } }))
        .status,
    ).toBe(403);

    const stopped = await ctx.req(`/v1/workspaces/acme/assistant/conversations/${chat.id}/cancel`, {
      method: "POST",
      cookie: ada,
    });
    expect(await stopped.json()).toEqual({ cancelled: true });
    const final = await read(chat.id);
    expect(final.messages.at(-1)).toMatchObject({ status: "cancelled" });
    // The turn revokes the token before it closes the connection, so "closed" means already revoked.
    await until(() => tools.opened[0]!.closed);
    expect((await ctx.req("/v1/workspaces/acme/tasks", { headers })).status).toBe(401);
  });

  it("ends the reply with a readable error when the provider fails, without repeating the key", async () => {
    model = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          message: `invalid x-api-key ${VALID_KEY}`,
          url: "https://x",
          requestBodyValues: {},
          statusCode: 401,
        });
      },
    });
    const chat = await newChat();
    await send(chat.id, "hi");
    const done = await waitDone(chat.id);
    expect(done.messages.at(-1)).toMatchObject({ status: "error" });
    expect(done.messages.at(-1)!.error).toContain("rejected your API key");
    expect(JSON.stringify(done)).not.toContain(VALID_KEY);
  });

  it("ends the reply when the Knotworking tools can't be reached, and leaves no live token", async () => {
    tools = fakeTools({}, { failToOpen: true });
    openTools = tools.openTools;
    const chat = await newChat();
    await send(chat.id, "hi");
    const done = await waitDone(chat.id);
    expect(done.messages.at(-1)!.error).toContain("MCP server");
    const rows = await ctx.handle.db.select().from(apiTokens).where(eq(apiTokens.kind, "assistant"));
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it("stops a reply that keeps calling tools, and one that takes too long", async () => {
    model = scriptedModel([toolStep("c1", "list_tasks")]);
    const looping = await newChat();
    await send(looping.id, "loop");
    expect((await waitDone(looping.id)).messages.at(-1)!.error).toContain("Stopped after 3 tool steps");

    model = scriptedModel([textStep("never")], { holdMs: 10_000 });
    const slow = await newChat();
    await send(slow.id, "slow");
    // The test app's turn timeout is 4 s.
    const done = await waitDone(slow.id);
    expect(done.messages.at(-1)!.error).toContain("took too long");
  }, 20_000);

  it("lets the member choose which modules' tools the assistant gets, and offers writers the write tools", async () => {
    const start = await (await ctx.req("/v1/me/assistant/settings", { cookie: ada })).json();
    expect(start.settings).toMatchObject({ modules: ["tasks", "docs", "time"], modulesAreDefault: true });
    const empty = await ctx.req("/v1/me/assistant/settings", {
      method: "PATCH",
      cookie: ada,
      json: { modules: [] },
    });
    expect(empty.status).toBe(400);
    const unknown = await ctx.req("/v1/me/assistant/settings", {
      method: "PATCH",
      cookie: ada,
      json: { modules: ["nope"] },
    });
    expect(unknown.status).toBe(400);
    const set = await ctx.req("/v1/me/assistant/settings", {
      method: "PATCH",
      cookie: ada,
      json: { modules: ["stock", "tasks", "stock"], scope: "write" },
    });
    expect((await set.json()).settings).toMatchObject({
      modules: ["stock", "tasks"],
      modulesAreDefault: false,
      scope: "write",
    });

    const chat = await newChat();
    await send(chat.id, "stock?");
    await waitDone(chat.id);
    expect(tools.opened.at(-1)!.selection).toEqual({ readOnly: false, modules: ["stock", "tasks"] });

    const reset = await ctx.req("/v1/me/assistant/settings", {
      method: "PATCH",
      cookie: ada,
      json: { modules: null, scope: "read" },
    });
    expect((await reset.json()).settings).toMatchObject({
      modules: ["tasks", "docs", "time"],
      modulesAreDefault: true,
    });
  });

  it("falls back to the starter modules if every stored module id has become unknown", async () => {
    const me = await (await ctx.req("/v1/me", { cookie: ada })).json();
    await ctx.handle.db
      .insert(assistantSettings)
      .values({ userId: me.user.id, modules: ["renamed_module", "removed_module"] })
      .onConflictDoUpdate({
        target: assistantSettings.userId,
        set: { modules: ["renamed_module", "removed_module"] },
      });
    const settings = (await (await ctx.req("/v1/me/assistant/settings", { cookie: ada })).json()).settings;
    // An empty list would be read by the MCP server as "every module".
    expect(settings.modules).toEqual(["tasks", "docs", "time"]);
    expect(settings.modulesAreDefault).toBe(true);
    await ctx.req("/v1/me/assistant/settings", { method: "PATCH", cookie: ada, json: { modules: null } });
  });

  it("refuses to send OpenAI more tools than it accepts, with advice, but not other providers", async () => {
    await saveKey(ada, "openai", VALID_KEY, { model: "fake-large" });
    tools = fakeTools({ list_tasks: () => mcpText("ok") }, { extraTools: 130 });
    openTools = tools.openTools;
    const openai = await newChat(ada, { provider: "openai" });
    await send(openai.id, "hi");
    const refused = await waitDone(openai.id);
    expect(refused.messages.at(-1)!.status).toBe("error");
    expect(refused.messages.at(-1)!.error).toMatch(
      /131 tools and OpenAI accepts at most 128.*Settings → Assistant/,
    );
    await until(() => tools.opened[0]!.closed);
    expect((model as MockLanguageModelV4).doStreamCalls).toHaveLength(0);

    await saveKey(ada, "claude", VALID_KEY, { model: "fake-large" });
    model = scriptedModel([textStep("fine")]);
    const claude = await newChat(ada, { provider: "claude" });
    await send(claude.id, "hi");
    expect((await waitDone(claude.id)).messages.at(-1)!.status).toBe("done");
    await ctx.req("/v1/me/assistant/keys/openai", { method: "DELETE", cookie: ada });
  });

  it("keeps conversations and keys private to their owner", async () => {
    const me = await (await ctx.req("/v1/me", { cookie: member })).json();
    await ctx.req(`/v1/workspaces/acme/members/${me.user.id}/module-access/assistant`, {
      method: "PUT",
      cookie: ada,
      json: { level: "write" },
    });
    const list = await (await ctx.req("/v1/workspaces/acme/assistant/conversations", { cookie: ada })).json();
    const id = list.conversations[0].id;
    expect(
      (await ctx.req(`/v1/workspaces/acme/assistant/conversations/${id}`, { cookie: member })).status,
    ).toBe(404);
    expect(
      (
        await ctx.req(`/v1/workspaces/acme/assistant/conversations/${id}/messages`, {
          method: "POST",
          cookie: member,
          json: { text: "hi" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await (await ctx.req("/v1/workspaces/acme/assistant/conversations", { cookie: member })).json())
        .conversations,
    ).toEqual([]);
    expect((await (await ctx.req("/v1/me/assistant/keys", { cookie: member })).json()).keys).toEqual([]);

    // Their own chat has no key: Ada's key is never used for them.
    const mine = await newChat(member);
    const builtBefore = providers.built.length;
    const res = await send(mine.id, "hi", member);
    expect((await res.json()).error.code).toBe("no_provider_key");
    expect(providers.built.length).toBe(builtBefore);
  });

  it("switches a chat's provider and model, and removing a key stops its chats", async () => {
    const chat = await newChat();
    const patched = await ctx.req(`/v1/workspaces/acme/assistant/conversations/${chat.id}`, {
      method: "PATCH",
      cookie: ada,
      json: { provider: "openai" },
    });
    expect((await patched.json()).conversation).toMatchObject({ provider: "openai", model: null });
    const back = await ctx.req(`/v1/workspaces/acme/assistant/conversations/${chat.id}`, {
      method: "PATCH",
      cookie: ada,
      json: { provider: "claude", model: "fake-small" },
    });
    expect((await back.json()).conversation).toMatchObject({ provider: "claude", model: "fake-small" });

    expect((await ctx.req("/v1/me/assistant/keys/claude", { method: "DELETE", cookie: ada })).status).toBe(
      204,
    );
    expect((await ctx.req("/v1/me/assistant/keys/claude", { method: "DELETE", cookie: ada })).status).toBe(
      404,
    );
    const res = await send(chat.id, "still there?");
    expect((await res.json()).error.code).toBe("no_provider_key");
    const settings = await (await ctx.req("/v1/me/assistant/settings", { cookie: ada })).json();
    expect(settings.settings.defaultProvider).toBeNull();
    const refused = await ctx.req("/v1/me/assistant/settings", {
      method: "PATCH",
      cookie: ada,
      json: { defaultProvider: "claude" },
    });
    expect((await refused.json()).error.code).toBe("no_provider_key");
  });
});
