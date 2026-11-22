import { createMCPClient } from "@ai-sdk/mcp";
import {
  ASSISTANT_MAX_STEPS,
  ASSISTANT_OPENAI_TOOL_LIMIT,
  ASSISTANT_TEXT_MAX,
  ASSISTANT_TOOL_TEXT_MAX,
  ASSISTANT_TURN_TIMEOUT_MS,
  assistantModuleForPath,
  assistantProviderNames,
  assistantSystemPrompt,
  assistantTurnPrompt,
  type ApiTokenScope,
  type AssistantContext,
  type AssistantEvent,
  type AssistantProvider,
  type ModuleId,
} from "@knotworking/core";
import type { Database } from "@knotworking/db";
import {
  AISDKError,
  APICallError,
  RetryError,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import { z } from "zod";
import type { AssistantHub } from "../assistant-hub";
import { redactSecret } from "./assistant-crypto";
import { getProviderKey } from "./assistant-keys";
import type { AssistantProviderRegistry } from "./assistant-providers";
import { listMessages } from "./assistant";
import { createAssistantToken, revokeAssistantToken } from "./api-tokens";

/**
 * Runs one assistant turn inside the API process: the member's own API key and model drive an agent
 * loop (Vercel AI SDK) whose tools are the Knotworking MCP tools, reached with a temporary token of
 * the member's. The loop's output becomes `AssistantEvent`s that the hub stores and streams to the
 * browser. Nothing else is offered to the model: no files, shell or web. See docs/assistant.md.
 */

/** What the MCP server offers, by module: its `list_modules` answer (docs/mcp.md). */
export interface ToolCatalogue {
  /** Tools every turn is given (orientation, the most used tools). */
  core: string[];
  modules: Array<{ id: string; name: string; tools: string[] }>;
}

/** The MCP tools for one turn, opened with the turn's token. `close` is always called. */
export interface OpenedTools {
  tools: ToolSet;
  /** Without it (an older MCP server), every tool is given to the model at once. */
  catalogue?: ToolCatalogue | undefined;
  close: () => Promise<void>;
}
/** Which tools a turn is offered: read-only ones for a read member, and only these modules' (docs/mcp.md). */
export interface ToolSelection {
  readOnly: boolean;
  modules: readonly ModuleId[];
}
export type OpenTools = (token: string, selection: ToolSelection) => Promise<OpenedTools>;

/**
 * The MCP URL for a tool selection (`?tools=read&modules=a,b`, see docs/mcp.md). `list=all`: the
 * turn gets every tool definition once and gives the model only some of them per step (`ToolPlan`).
 */
export function mcpUrlFor(base: string, selection: ToolSelection): string {
  const url = new URL(base);
  url.searchParams.set("list", "all");
  if (selection.readOnly) url.searchParams.set("tools", "read");
  // An empty list would mean "every module" to the MCP server, so it is never sent.
  if (selection.modules.length) url.searchParams.set("modules", selection.modules.join(","));
  return url.toString();
}

/** Connects to the MCP server over HTTP. The token is the turn's own and dies with it. */
export const mcpTools =
  (base: string): OpenTools =>
  async (token, selection) => {
    const client = await createMCPClient({
      transport: {
        type: "http",
        url: mcpUrlFor(base, selection),
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
      },
    });
    try {
      const tools = (await client.tools()) as ToolSet;
      const catalogue = await readCatalogue(tools, () =>
        client.callTool({ name: "list_modules", arguments: {} }),
      );
      return { tools, catalogue, close: () => client.close() };
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
  };

/** The MCP server offers `list_modules` but it failed twice: the turn can't tell modules apart. */
export class ToolCatalogueUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`list_modules failed: ${reason}`);
    this.name = "ToolCatalogueUnavailable";
  }
}

/**
 * Which module each tool belongs to, from `list_modules`. A server without that tool (older than
 * catalogue mode) gives undefined, and the turn offers every tool as before. A server that has it
 * but fails to answer (a 429, a bad answer) is retried once and then reported, rather than quietly
 * offering every tool, which could pass a provider's tool limit for a reason the member can't fix.
 */
export async function readCatalogue(
  tools: ToolSet,
  call: () => Promise<unknown>,
): Promise<ToolCatalogue | undefined> {
  if (!Object.hasOwn(tools, "list_modules")) return undefined;
  let reason = "no answer";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await call();
      const text = toolOutputText(result);
      const parsed = toolOutputIsError(result) ? undefined : parseCatalogue(text);
      if (parsed) return parsed;
      reason = toolOutputIsError(result) ? text.slice(0, 200) : "not a module list";
    } catch (err) {
      reason = err instanceof Error ? err.message.slice(0, 200) : "request failed";
    }
  }
  throw new ToolCatalogueUnavailable(reason);
}

/** A `list_modules` answer, or undefined when it isn't one. */
export function parseCatalogue(text: string): ToolCatalogue | undefined {
  try {
    const data = JSON.parse(text) as Partial<ToolCatalogue>;
    if (!Array.isArray(data.core) || !Array.isArray(data.modules)) return undefined;
    return {
      core: data.core.filter((n): n is string => typeof n === "string"),
      modules: data.modules
        .filter((m) => m && typeof m.id === "string" && Array.isArray(m.tools))
        .map((m) => ({ id: m.id, name: String(m.name ?? m.id), tools: m.tools.map(String) })),
    };
  } catch {
    return undefined;
  }
}

/** The reusable reads every turn keeps, whatever is loaded. */
const GENERIC_TOOLS = ["list_modules", "find_records", "get_record"];
export const LOAD_MODULES_TOOL = "load_modules";

/**
 * Which tools the model sees at each step. A turn starts with the core tools (and the module of
 * the page the person had open); `load_modules` adds a module's tools from the next step. Every
 * tool definition is already in hand, so loading is local: nothing is fetched mid-turn.
 */
export class ToolPlan {
  private loaded = new Set<string>();
  constructor(
    private readonly tools: ToolSet,
    readonly catalogue: ToolCatalogue | undefined,
    /** The most tools the provider accepts in one request (OpenAI), if it has a limit. */
    private readonly limit?: number,
  ) {}

  private has = (name: string) => Object.hasOwn(this.tools, name);

  /** The modules that can be loaded (platform tools are always on). */
  /** The modules that can be loaded: not platform (always on), and with tools this turn has. */
  get loadable() {
    return (this.catalogue?.modules ?? []).filter(
      (m) => m.id !== "platform" && this.toolsOf(m.id).length > 0,
    );
  }

  private toolsOf(id: string) {
    return (this.catalogue?.modules.find((m) => m.id === id)?.tools ?? []).filter(this.has);
  }

  /** The tools for this step, in a stable order (core first, then modules in manifest order). */
  active(): string[] | undefined {
    if (!this.catalogue) return undefined;
    const names = [
      ...this.catalogue.core,
      ...GENERIC_TOOLS,
      ...this.toolsOf("platform"),
      LOAD_MODULES_TOOL,
      ...this.loadable.filter((m) => this.loaded.has(m.id)).flatMap((m) => this.toolsOf(m.id)),
    ];
    return [...new Set(names)].filter((n) => n === LOAD_MODULES_TOOL || this.has(n));
  }

  /** How many tool definitions the next request carries. */
  count() {
    return this.active()?.length ?? Object.keys(this.tools).length;
  }

  isLoaded(id: string) {
    return this.loaded.has(id);
  }

  /** Loads modules; refuses (loading none) when that would pass the provider's tool limit. */
  load(ids: readonly string[]) {
    const known = ids.filter((id) => this.loadable.some((m) => m.id === id));
    const unknown = ids.filter((id) => !known.includes(id));
    const before = new Set(this.loaded);
    for (const id of known) this.loaded.add(id);
    if (this.limit !== undefined && this.count() > this.limit) {
      this.loaded = before;
      return {
        error: `Loading ${known.join(", ")} would give the model more than ${this.limit} tools. Load fewer modules at once.`,
      };
    }
    return {
      loaded: known,
      tools: known.flatMap((id) => this.toolsOf(id)),
      ...(unknown.length ? { unknown, available: this.loadable.map((m) => m.id) } : {}),
    };
  }

  /** The local `load_modules` tool (no API call: the definitions are already loaded). */
  loadTool(options: { cache?: boolean } = {}) {
    const available = this.loadable.map((m) => `${m.id} (${m.name})`).join(", ");
    return tool({
      // The last core tool (`active()` puts it after every core tool, before loaded modules): a
      // cache breakpoint here keeps the core tools cached when a module is loaded (Anthropic).
      ...(options.cache
        ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } } }
        : {}),
      description: `Give yourself the tools of one or more Knotworking modules, from the next step on. Read records first with find_records / get_record (no loading needed); load a module when you need its other tools, such as writes, reports and plans. Available: ${available || "none"}.`,
      inputSchema: z.object({
        modules: z.array(z.string().min(1).max(40)).min(1).max(10).describe("Module ids, e.g. quality."),
      }),
      execute: async ({ modules }) => this.load(modules),
    });
  }
}

export interface AssistantTurnDeps {
  providers: AssistantProviderRegistry;
  openTools: OpenTools;
}

export interface TurnParams {
  turnId: string;
  conversationId: string;
  messageId: string;
  userId: string;
  workspace: { slug: string; name: string };
  user: { name: string };
  provider: AssistantProvider;
  /** The conversation's model, or null to use the member's saved model for the provider. */
  model: string | null;
  scope: ApiTokenScope;
  /** Modules whose tools the model is given. */
  modules: readonly ModuleId[];
  prompt: string;
  context: AssistantContext | null;
}

const cut = (text: string, max = ASSISTANT_TOOL_TEXT_MAX) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** What a tool call returned, as text. MCP results are `{ content: [{ type: "text", text }], isError? }`. */
export function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  const content = (output as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((c) =>
        c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
          ? (c as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  try {
    return output === undefined ? "" : (JSON.stringify(output) ?? "");
  } catch {
    return "";
  }
}

const toolOutputIsError = (output: unknown) => (output as { isError?: unknown } | null)?.isError === true;

/**
 * Turns the AI SDK's stream parts into assistant events. Stateful (it assembles each text block so
 * the finished one replaces its deltas) but does no I/O, so it is tested on its own.
 */
export class StreamTranslator {
  private text = new Map<string, string>();
  /** Why the last model call ended (`tool-calls` after the step cap means the reply was cut short). */
  finishReason: string | undefined;
  /** The stream's own error part, when it had one. */
  error: unknown;
  aborted = false;

  translate(part: TextStreamPart<ToolSet>): AssistantEvent[] {
    switch (part.type) {
      case "text-start":
        this.text.set(part.id, "");
        return [];
      case "text-delta": {
        this.text.set(part.id, (this.text.get(part.id) ?? "") + part.text);
        return part.text ? [{ type: "text_delta", text: part.text.slice(0, ASSISTANT_TEXT_MAX) }] : [];
      }
      case "text-end": {
        const full = this.text.get(part.id);
        this.text.delete(part.id);
        return full ? [{ type: "text", text: full.slice(0, ASSISTANT_TEXT_MAX * 5) }] : [];
      }
      case "tool-call":
        return [
          {
            type: "tool_use",
            id: part.toolCallId,
            name: part.toolName,
            input: cut(JSON.stringify(part.input ?? {}) ?? "{}"),
          },
        ];
      case "tool-result":
        return [
          {
            type: "tool_result",
            id: part.toolCallId,
            isError: toolOutputIsError(part.output),
            output: cut(toolOutputText(part.output)),
          },
        ];
      case "tool-error":
        return [
          {
            type: "tool_result",
            id: part.toolCallId,
            isError: true,
            output: cut(part.error instanceof Error ? part.error.message : String(part.error)),
          },
        ];
      case "finish-step":
      case "finish":
        this.finishReason = part.finishReason;
        return [];
      case "abort":
        this.aborted = true;
        return [];
      case "error":
        this.error = part.error;
        return [];
      default:
        return [];
    }
  }
}

/**
 * The stored conversation as model messages: what was said, not how it was found (tool calls and
 * results are not replayed). Oldest messages are dropped past `budget` characters. The prompt of the
 * running turn is the last user message, with the page note.
 */
export function historyMessages(
  history: {
    id: string;
    role: "user" | "assistant";
    text: string | null;
    parts: { type: string; text?: string }[];
  }[],
  current: { messageId: string; prompt: string; context: AssistantContext | null },
  budget = 80_000,
): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of history) {
    if (m.id === current.messageId) continue;
    if (m.role === "user") {
      if (m.text) out.push({ role: "user", content: m.text });
    } else {
      const text = m.parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text)
        .join("\n")
        .trim();
      if (text) out.push({ role: "assistant", content: text });
    }
  }
  // The turn's own prompt is already stored as the last user message; replace it with the full one.
  if (out.at(-1)?.role === "user") out.pop();
  out.push({ role: "user", content: assistantTurnPrompt(current) });
  let used = 0;
  let from = out.length;
  while (from > 0) {
    const size = JSON.stringify(out[from - 1]!.content).length;
    if (used + size > budget && from < out.length) break;
    used += size;
    from--;
  }
  const kept = out.slice(from);
  // A cancelled or failed reply leaves no assistant text, so two user messages can meet. Providers
  // differ on whether they accept that, so merge neighbours of the same role into one.
  for (let i = kept.length - 1; i > 0; i--) {
    const prev = kept[i - 1]!;
    const next = kept[i]!;
    if (prev.role === next.role && typeof prev.content === "string" && typeof next.content === "string") {
      kept.splice(i - 1, 2, {
        role: prev.role,
        content: `${prev.content}\n\n${next.content}`,
      } as ModelMessage);
    }
  }
  // A conversation must start with the person, whatever was cut.
  while (kept.length > 1 && kept[0]!.role !== "user") kept.shift();
  return kept;
}

/**
 * A provider's failure as a sentence for the member, with their key removed. Only errors from the AI
 * SDK and the provider are shown as they are; anything else (a database error, say, whose message
 * carries SQL and parameters) is replaced by a generic sentence, and the caller logs the detail.
 */
export function describeTurnError(
  err: unknown,
  provider: AssistantProvider,
  model: string,
  key?: string,
): string {
  const name = assistantProviderNames[provider];
  // The SDK retries rate limits and server errors; what the member needs is the last real failure.
  const cause = RetryError.isInstance(err) && err.lastError ? err.lastError : err;
  if (!AISDKError.isInstance(cause)) {
    return `${name} or the assistant hit an unexpected error. Try again, and tell an admin if it keeps happening.`;
  }
  let message = cause.message;
  if (APICallError.isInstance(cause)) {
    if (cause.statusCode === 401 || cause.statusCode === 403)
      return `${name} rejected your API key. Update it under Settings → Assistant.`;
    if (cause.statusCode === 404)
      return `${name} doesn't have the model "${model}" for your key. Pick another model in the chat header.`;
    if (cause.statusCode === 429) message = `${name} says you are rate limited or out of quota. ${message}`;
  }
  return cut(redactSecret(message, key).replace(/\s+/g, " ").trim() || `${name} failed.`, 1_000);
}

/**
 * Waits for `work`, but no longer than `ms` and not past `signal`. If it loses the race and `work`
 * finishes later anyway, `onLate` gets the result so it can be cleaned up.
 */
async function withLimit<T>(work: Promise<T>, signal: AbortSignal, ms: number, onLate: (value: T) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
    onAbort = () => reject(new Error("aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, limit]);
  } catch (err) {
    work.then(onLate, () => {});
    throw err;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Merges runs of `text_delta` so a busy stream is stored in fewer events. */
function coalesce(events: AssistantEvent[]): AssistantEvent[] {
  const out: AssistantEvent[] = [];
  for (const e of events) {
    const last = out.at(-1);
    if (e.type === "text_delta" && last?.type === "text_delta") {
      out[out.length - 1] = { type: "text_delta", text: (last.text + e.text).slice(0, ASSISTANT_TEXT_MAX) };
    } else out.push(e);
  }
  return out;
}

/** An error for the server log: its message only (no SQL parameters or stack), with the key removed. */
const errorSummary = (err: unknown, key: string | undefined) =>
  redactSecret(err instanceof Error ? `${err.name}: ${err.message}` : String(err), key).slice(0, 500);

export class AssistantTurnRunner {
  private pending = new Set<Promise<void>>();
  /** Running turns, each with a function that ends it with a message (shutdown). */
  private active = new Map<string, (message: string) => void>();
  constructor(
    private readonly db: Database,
    private readonly hub: AssistantHub,
    private readonly keyKey: Buffer,
    private readonly deps: AssistantTurnDeps,
    private readonly options: {
      timeoutMs?: number;
      maxSteps?: number;
      flushMs?: number;
      pollMs?: number;
      /** How long to wait for the MCP connection before giving up (default 15 s). */
      connectTimeoutMs?: number;
    } = {},
  ) {
    // On shutdown, end running replies and revoke their tokens instead of leaving them to expire.
    hub.addShutdownHook(() => this.abortAll());
  }

  /** Starts the turn in the background. It never throws: every failure ends the reply with an error. */
  start(params: TurnParams) {
    const run = this.run(params)
      .catch((err) => console.error("assistant turn failed", err))
      .finally(() => this.pending.delete(run));
    this.pending.add(run);
  }

  /** Ends every running turn with an error reply, revokes their tokens and waits for them to finish. */
  async abortAll(message = "The server restarted before this reply finished. Send it again.") {
    for (const stop of this.active.values()) stop(message);
    await this.idle();
  }

  /** Resolves when every started turn has finished (for tests and shutdown). */
  async idle() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private async run(p: TurnParams) {
    const started = Date.now();
    const timeoutMs = this.options.timeoutMs ?? ASSISTANT_TURN_TIMEOUT_MS;
    const abort = new AbortController();
    let key: string | undefined;
    let timedOut = false;
    let open = true;
    let finalEmitted = false;
    let buffer: AssistantEvent[] = [];
    let chain = Promise.resolve();
    // Events go to the hub in order, one batch at a time; a `false` answer means the turn ended. A
    // write that fails twice (the database is struggling) stops the turn rather than rejecting the
    // chain: nothing awaits the timer's flush, so a rejection would crash the process.
    const flush = () => {
      const events = coalesce(buffer);
      buffer = [];
      if (!events.length) return chain;
      chain = chain.then(async () => {
        try {
          let running: boolean;
          try {
            running = await this.hub.ingest(p.turnId, events);
          } catch {
            await new Promise((r) => setTimeout(r, 200));
            running = await this.hub.ingest(p.turnId, events);
          }
          if (!running) {
            open = false;
            abort.abort();
          }
        } catch (err) {
          console.error("assistant events could not be stored; ending the turn", errorSummary(err, key));
          open = false;
          abort.abort();
        }
      });
      return chain;
    };
    const emit = (events: AssistantEvent[]) => {
      if (!open || finalEmitted) return;
      for (const e of events) {
        buffer.push(e);
        if (e.type === "done" || e.type === "error") {
          finalEmitted = true;
          break;
        }
      }
    };
    this.active.set(p.turnId, (message) => {
      emit([{ type: "error", message }]);
      abort.abort();
    });
    const flushTimer = setInterval(() => void flush(), this.options.flushMs ?? 120);
    const pollTimer = setInterval(
      () =>
        void this.hub
          .touch(p.turnId)
          .then((running) => {
            if (!running) {
              open = false;
              abort.abort();
            }
          })
          .catch(() => {}),
      this.options.pollMs ?? 1_000,
    );
    const timeout = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, timeoutMs);
    flushTimer.unref?.();
    pollTimer.unref?.();
    timeout.unref?.();

    let modelId = p.model ?? "";
    let tokenId: string | undefined;
    let opened: OpenedTools | undefined;
    try {
      const saved = await getProviderKey(this.db, this.keyKey, p.userId, p.provider);
      if (!saved) {
        emit([
          {
            type: "error",
            message: `Your ${assistantProviderNames[p.provider]} API key is missing or can't be read. Add it again under Settings → Assistant.`,
          },
        ]);
        return;
      }
      key = saved.key;
      modelId = p.model ?? saved.model ?? "";
      if (!modelId) {
        emit([
          {
            type: "error",
            message: `Choose a ${assistantProviderNames[p.provider]} model in the chat header, or set one under Settings → Assistant.`,
          },
        ]);
        return;
      }
      const model = this.deps.providers.model(p.provider, key, modelId);
      const history = await listMessages(this.db, p.conversationId);
      const messages = historyMessages(history, p);

      const token = await createAssistantToken(this.db, p.userId, p.scope, p.modules);
      tokenId = token.id;
      try {
        opened = await withLimit(
          this.deps.openTools(token.token, { readOnly: p.scope === "read", modules: p.modules }),
          abort.signal,
          this.options.connectTimeoutMs ?? 15_000,
          // The connection finished after we gave up on it: close it, nobody will.
          (late) => void late.close().catch(() => {}),
        );
      } catch (err) {
        emit([
          {
            type: "error",
            message:
              err instanceof ToolCatalogueUnavailable
                ? "The assistant couldn't read which Knotworking tools you can use (the MCP server's module list failed). Try again in a moment."
                : "The assistant couldn't reach the Knotworking tools (the MCP server). Ask an admin to check it is running.",
          },
        ]);
        return;
      }

      const plan = new ToolPlan(
        opened.tools,
        opened.catalogue,
        p.provider === "openai" ? ASSISTANT_OPENAI_TOOL_LIMIT : undefined,
      );
      // Questions are usually about the page on screen: its module starts loaded.
      const pageModule = assistantModuleForPath(p.context?.path);
      if (pageModule && p.modules.includes(pageModule)) plan.load([pageModule]);
      const tools: ToolSet = plan.catalogue
        ? { ...opened.tools, [LOAD_MODULES_TOOL]: plan.loadTool({ cache: p.provider === "claude" }) }
        : opened.tools;

      const toolCount = plan.count();
      if (p.provider === "openai" && toolCount > ASSISTANT_OPENAI_TOOL_LIMIT) {
        emit([
          {
            type: "error",
            message: `That is ${toolCount} tools and OpenAI accepts at most ${ASSISTANT_OPENAI_TOOL_LIMIT}. Choose fewer modules under Settings → Assistant.`,
          },
        ]);
        return;
      }

      const translator = new StreamTranslator();
      const system = plan.catalogue
        ? `${assistantSystemPrompt(p)}\nRead records with find_records and get_record. Other tools of a module (writes, reports, plans) appear after you call load_modules for it.`
        : assistantSystemPrompt(p);
      const result = streamText({
        model,
        // Claude: cache the tools and instructions, which repeat on every step of the turn.
        system:
          p.provider === "claude"
            ? {
                role: "system",
                content: system,
                providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
              }
            : system,
        messages,
        tools,
        // Core tools first, then loaded modules: a stable order keeps the cached prefix valid.
        ...(plan.catalogue ? { activeTools: plan.active(), toolOrder: plan.active() } : {}),
        prepareStep: () => (plan.catalogue ? { activeTools: plan.active(), toolOrder: plan.active() } : {}),
        stopWhen: stepCountIs(this.options.maxSteps ?? ASSISTANT_MAX_STEPS),
        abortSignal: abort.signal,
        // Errors arrive as stream parts and are handled below; stop the SDK logging them too.
        onError: () => {},
      });
      for await (const part of result.fullStream) {
        emit(translator.translate(part));
        if (translator.error || !open) break;
      }
      if (!open) return; // stopped: the hub already ended the reply
      if (timedOut) {
        emit([{ type: "error", message: "The assistant took too long and was stopped." }]);
      } else if (translator.error) {
        emit([{ type: "error", message: describeTurnError(translator.error, p.provider, modelId, key) }]);
      } else if (translator.finishReason === "tool-calls") {
        emit([
          {
            type: "error",
            message: `Stopped after ${this.options.maxSteps ?? ASSISTANT_MAX_STEPS} tool steps. Ask it to continue if it isn't finished.`,
          },
        ]);
      } else {
        emit([{ type: "done", durationMs: Date.now() - started }]);
      }
    } catch (err) {
      if (open && !timedOut) console.error("assistant turn failed", errorSummary(err, key));
      if (open) {
        emit([
          {
            type: "error",
            message: timedOut
              ? "The assistant took too long and was stopped."
              : describeTurnError(err, p.provider, modelId, key),
          },
        ]);
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(pollTimer);
      clearInterval(flushTimer);
      this.active.delete(p.turnId);
      // Make sure the turn ends exactly once, whatever happened above.
      emit([{ type: "error", message: "The assistant stopped unexpectedly." }]);
      await flush();
      // Revoke first: the token is the credential, the connection only a convenience.
      if (tokenId)
        await revokeAssistantToken(this.db, tokenId).catch((err) =>
          console.error("assistant token revoke failed", errorSummary(err, key)),
        );
      await opened?.close().catch(() => {});
    }
  }
}
