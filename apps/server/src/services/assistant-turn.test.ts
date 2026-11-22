import { APICallError, RetryError, tool, type ToolSet } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  describeTurnError,
  historyMessages,
  LOAD_MODULES_TOOL,
  mcpUrlFor,
  parseCatalogue,
  readCatalogue,
  StreamTranslator,
  ToolCatalogueUnavailable,
  ToolPlan,
  toolOutputText,
} from "./assistant-turn";

describe("StreamTranslator", () => {
  const t = () => new StreamTranslator();

  it("turns text blocks into deltas, then one finished text that replaces them", () => {
    const x = t();
    expect(x.translate({ type: "text-start", id: "a" } as never)).toEqual([]);
    expect(x.translate({ type: "text-delta", id: "a", text: "Two " } as never)).toEqual([
      { type: "text_delta", text: "Two " },
    ]);
    expect(x.translate({ type: "text-delta", id: "a", text: "tasks." } as never)).toEqual([
      { type: "text_delta", text: "tasks." },
    ]);
    expect(x.translate({ type: "text-end", id: "a" } as never)).toEqual([
      { type: "text", text: "Two tasks." },
    ]);
    expect(x.translate({ type: "text-end", id: "a" } as never)).toEqual([]);
  });

  it("reports tool calls and results, with MCP errors and thrown errors marked", () => {
    const x = t();
    expect(
      x.translate({ type: "tool-call", toolCallId: "1", toolName: "list_tasks", input: { a: 1 } } as never),
    ).toEqual([{ type: "tool_use", id: "1", name: "list_tasks", input: '{"a":1}' }]);
    expect(
      x.translate({
        type: "tool-result",
        toolCallId: "1",
        output: { content: [{ type: "text", text: "3 tasks" }] },
      } as never),
    ).toEqual([{ type: "tool_result", id: "1", isError: false, output: "3 tasks" }]);
    expect(
      x.translate({
        type: "tool-result",
        toolCallId: "2",
        output: { content: [{ type: "text", text: "token_read_only" }], isError: true },
      } as never),
    ).toEqual([{ type: "tool_result", id: "2", isError: true, output: "token_read_only" }]);
    expect(x.translate({ type: "tool-error", toolCallId: "3", error: new Error("boom") } as never)).toEqual([
      { type: "tool_result", id: "3", isError: true, output: "boom" },
    ]);
  });

  it("cuts oversized tool text and remembers the finish reason, error and abort", () => {
    const x = t();
    const [use] = x.translate({
      type: "tool-call",
      toolCallId: "1",
      toolName: "t",
      input: { big: "x".repeat(9_000) },
    } as never);
    expect((use as { input: string }).input.length).toBeLessThan(4_100);
    x.translate({ type: "finish-step", finishReason: "tool-calls" } as never);
    expect(x.finishReason).toBe("tool-calls");
    x.translate({ type: "error", error: "nope" } as never);
    expect(x.error).toBe("nope");
    x.translate({ type: "abort" } as never);
    expect(x.aborted).toBe(true);
    expect(x.translate({ type: "start" } as never)).toEqual([]);
  });
});

describe("toolOutputText", () => {
  it("reads MCP content, strings and falls back to JSON", () => {
    expect(
      toolOutputText({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
    expect(toolOutputText("plain")).toBe("plain");
    expect(toolOutputText({ rows: 2 })).toBe('{"rows":2}');
    expect(toolOutputText(undefined)).toBe("");
  });
});

describe("historyMessages", () => {
  const msg = (
    id: string,
    role: "user" | "assistant",
    text: string | null,
    parts: { type: string; text?: string }[] = [],
  ) => ({
    id,
    role,
    text,
    parts,
  });
  const current = {
    messageId: "r2",
    prompt: "And next week?",
    context: { path: "/acme/tasks", title: "Tasks" },
  };

  it("replays what was said (not tool calls), and ends with the full prompt including the page note", () => {
    const out = historyMessages(
      [
        msg("u1", "user", "What is due?"),
        msg("a1", "assistant", null, [
          { type: "tool", text: undefined },
          { type: "text", text: "Two tasks." },
        ]),
        msg("u2", "user", "And next week?"),
        msg("r2", "assistant", null, []),
      ],
      current,
    );
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[1]!.content).toBe("Two tasks.");
    expect(out[2]!.content).toContain("And next week?");
    expect(out[2]!.content).toContain('path "/acme/tasks"');
  });

  it("skips replies with no text and keeps the conversation starting with the person", () => {
    const out = historyMessages(
      [
        msg("a0", "assistant", null, [{ type: "text", text: "orphan" }]),
        msg("u1", "user", "hi"),
        msg("a1", "assistant", null, []),
        msg("u2", "user", "again"),
      ],
      { messageId: "r", prompt: "again", context: null },
    );
    // The two user messages with no reply between them are merged into one.
    expect(out.map((m) => m.role)).toEqual(["user"]);
    expect(out[0]!.content).toBe("hi\n\nagain");
  });

  it("drops the oldest messages past the budget but always keeps the prompt", () => {
    const history = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0
        ? msg(`u${i}`, "user", `question ${i} ${"x".repeat(200)}`)
        : msg(`a${i}`, "assistant", null, [{ type: "text", text: `answer ${i} ${"y".repeat(200)}` }]),
    );
    const out = historyMessages(history, { messageId: "r", prompt: "latest", context: null }, 600);
    expect(out.length).toBeLessThan(11);
    expect(out[0]!.role).toBe("user");
    expect(out.at(-1)!.content).toBe("latest");
  });
});

describe("describeTurnError", () => {
  const apiError = (statusCode: number, message = "failed") =>
    new APICallError({ message, url: "https://x", requestBodyValues: {}, statusCode });
  it("explains a rejected key, a missing model and rate limits", () => {
    expect(describeTurnError(apiError(401), "claude", "m")).toContain("rejected your API key");
    expect(describeTurnError(apiError(404), "openai", "gpt-zzz")).toContain('"gpt-zzz"');
    expect(describeTurnError(apiError(429, "slow down"), "groq", "m")).toContain("rate limited");
  });
  it("never repeats the key back, and caps length", () => {
    const key = "sk-secret-key-value-9999";
    const out = describeTurnError(apiError(500, `bad header ${key} ${"y".repeat(3000)}`), "xai", "m", key);
    expect(out).not.toContain(key);
    expect(out).toContain("[key]");
    expect(out.length).toBeLessThanOrEqual(1_001);
  });
});

describe("describeTurnError for other errors", () => {
  it("looks through the SDK's retry wrapper to the last real failure", () => {
    const last = new APICallError({
      message: "slow down",
      url: "https://x",
      requestBodyValues: {},
      statusCode: 429,
    });
    const retry = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [last, last, last],
    });
    expect(describeTurnError(retry, "groq", "m")).toContain("rate limited");
  });
  it("hides database and other internal errors behind a generic sentence", () => {
    const sql = new Error("Failed query: insert into api_tokens (token_hash) values ($1) params: abc123");
    const out = describeTurnError(sql, "claude", "m");
    expect(out).not.toContain("api_tokens");
    expect(out).not.toContain("abc123");
    expect(out).toContain("unexpected error");
  });
});

describe("mcpUrlFor", () => {
  it("asks the MCP server for read-only tools and the chosen modules", () => {
    expect(mcpUrlFor("http://mcp:4100/mcp", { readOnly: true, modules: ["tasks", "docs"] })).toBe(
      "http://mcp:4100/mcp?list=all&tools=read&modules=tasks%2Cdocs",
    );
    expect(mcpUrlFor("http://mcp:4100/mcp", { readOnly: false, modules: ["stock"] })).toBe(
      "http://mcp:4100/mcp?list=all&modules=stock",
    );
  });
  it("never sends an empty module list, which the MCP server reads as every module", () => {
    expect(mcpUrlFor("http://mcp:4100/mcp", { readOnly: false, modules: [] })).toBe(
      "http://mcp:4100/mcp?list=all",
    );
  });
});

describe("ToolPlan", () => {
  const fakeTool = () => tool({ description: "x", inputSchema: z.object({}), execute: async () => "" });
  const names = [
    "get_workspace_overview",
    "get_task",
    "list_modules",
    "find_records",
    "get_record",
    "get_attachment_link",
    "log_complaint",
    "raise_nonconformance",
    "receive_stock",
    "adjust_stock",
  ];
  const tools: ToolSet = Object.fromEntries(names.map((n) => [n, fakeTool()]));
  const catalogue = {
    core: ["get_workspace_overview", "get_task"],
    modules: [
      { id: "platform", name: "Workspace", tools: ["get_attachment_link"] },
      { id: "quality", name: "Quality", tools: ["log_complaint", "raise_nonconformance"] },
      { id: "stock", name: "Stock", tools: ["receive_stock", "adjust_stock", "gone_from_server"] },
    ],
  };

  it("starts with the core, generic and platform tools plus load_modules", () => {
    const plan = new ToolPlan(tools, catalogue);
    expect(plan.active()).toEqual([
      "get_workspace_overview",
      "get_task",
      "list_modules",
      "find_records",
      "get_record",
      "get_attachment_link",
      LOAD_MODULES_TOOL,
    ]);
  });

  it("adds a module's tools once loaded, in a stable order, and reports unknown ids", () => {
    const plan = new ToolPlan(tools, catalogue);
    expect(plan.load(["stock", "nope"])).toEqual({
      loaded: ["stock"],
      tools: ["receive_stock", "adjust_stock"],
      unknown: ["nope"],
      available: ["quality", "stock"],
    });
    plan.load(["quality"]);
    expect(plan.active()!.slice(-4)).toEqual([
      "log_complaint",
      "raise_nonconformance",
      "receive_stock",
      "adjust_stock",
    ]);
    expect(plan.load(["platform"])).toMatchObject({ loaded: [] });
  });

  it("refuses to load past the provider's tool limit, loading nothing", () => {
    const plan = new ToolPlan(tools, catalogue, 10);
    const res = plan.load(["quality", "stock"]);
    expect(res).toMatchObject({ error: expect.stringMatching(/more than 10 tools/) });
    expect(plan.isLoaded("quality")).toBe(false);
    expect(plan.count()).toBe(7);
    expect(plan.load(["quality"])).toMatchObject({ loaded: ["quality"] });
  });

  it("doesn't offer modules this turn has no tools for", () => {
    const plan = new ToolPlan(tools, {
      ...catalogue,
      modules: [...catalogue.modules, { id: "haccp", name: "HACCP", tools: ["not_listed_here"] }],
    });
    expect(plan.loadable.map((m) => m.id)).toEqual(["quality", "stock"]);
    expect(plan.load(["haccp"])).toMatchObject({ loaded: [], unknown: ["haccp"] });
  });

  it("marks load_modules (the last core tool) for caching only when asked", () => {
    const plan = new ToolPlan(tools, catalogue);
    expect(plan.loadTool({ cache: true }).providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(plan.loadTool().providerOptions).toBeUndefined();
    expect(plan.active()!.indexOf(LOAD_MODULES_TOOL)).toBe(6);
    plan.load(["quality"]);
    expect(plan.active()!.indexOf(LOAD_MODULES_TOOL)).toBe(6);
  });

  it("gives every tool at once without a catalogue (an older MCP server)", () => {
    const plan = new ToolPlan(tools, undefined);
    expect(plan.active()).toBeUndefined();
    expect(plan.count()).toBe(names.length);
  });

  it("parses list_modules answers and rejects anything else", () => {
    expect(parseCatalogue(JSON.stringify({ howTo: "x", ...catalogue }))).toEqual(catalogue);
    expect(parseCatalogue("not json")).toBeUndefined();
    expect(parseCatalogue(JSON.stringify({ error: { code: "x" } }))).toBeUndefined();
  });
});

describe("readCatalogue", () => {
  const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });
  const good = text(JSON.stringify({ core: ["get_task"], modules: [] }));
  const withList: ToolSet = { list_modules: tool({ inputSchema: z.object({}), execute: async () => "" }) };

  it("treats a server without list_modules as an older one (every tool)", async () => {
    let calls = 0;
    expect(await readCatalogue({}, async () => (calls++, good))).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("retries once, then succeeds", async () => {
    const answers = [text('{"error":{"code":"rate_limited"}}', true), good];
    expect(await readCatalogue(withList, async () => answers.shift())).toEqual({
      core: ["get_task"],
      modules: [],
    });
  });

  it("reports a server that has list_modules but can't answer, instead of offering everything", async () => {
    await expect(readCatalogue(withList, async () => text("nonsense"))).rejects.toBeInstanceOf(
      ToolCatalogueUnavailable,
    );
    await expect(
      readCatalogue(withList, async () => {
        throw new Error("HTTP 429");
      }),
    ).rejects.toThrow(/429/);
  });
});
