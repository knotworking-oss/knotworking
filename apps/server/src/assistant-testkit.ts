import type { AssistantProvider } from "@knotworking/core";
import { tool, type ToolSet } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { z } from "zod";
import type { AssistantProviderRegistry } from "./services/assistant-providers";
import { ProviderKeyRejected, ProviderUnavailable } from "./services/assistant-providers";
import {
  ToolCatalogueUnavailable,
  type OpenTools,
  type ToolCatalogue,
  type ToolSelection,
} from "./services/assistant-turn";

/**
 * Fakes for the assistant's outside world, so a whole turn (key → model → tools → events → stored
 * reply) can run in tests with no network: a model that plays a script, providers that accept one
 * known key, and MCP tools that are plain functions.
 */

type Part = Record<string, unknown>;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
export const finish = (reason: "stop" | "tool-calls" | "length" = "stop"): Part => ({
  type: "finish",
  usage,
  finishReason: { unified: reason, raw: reason },
});
/** One model call that answers with text, in two chunks. */
export const textStep = (text: string, id = "t1"): Part[] => {
  const mid = Math.ceil(text.length / 2);
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id },
    { type: "text-delta", id, delta: text.slice(0, mid) },
    { type: "text-delta", id, delta: text.slice(mid) },
    { type: "text-end", id },
    finish("stop"),
  ];
};
/** One model call that asks for a tool. */
export const toolStep = (toolCallId: string, toolName: string, input: unknown = {}): Part[] => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
  finish("tool-calls"),
];

/** A model that plays one scripted step per call (the last repeats). `calls` records the prompts it was sent. */
export function scriptedModel(steps: Part[][], options: { holdMs?: number } = {}) {
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(n++, steps.length - 1)]!;
      if (options.holdMs) await new Promise((r) => setTimeout(r, options.holdMs));
      return { stream: convertArrayToReadableStream(step as never) };
    },
  });
  return model;
}

export const VALID_KEY = "sk-valid-key-1234567890";
export const MODELS = ["fake-large", "fake-small"];

/**
 * Providers that accept only {@link VALID_KEY} (anything else is rejected, `unreachable-key` simulates
 * an outage) and build the model the test supplies. `built` records every model constructed.
 */
export function fakeProviders(model: () => ReturnType<typeof scriptedModel>) {
  const built: { provider: AssistantProvider; key: string; modelId: string }[] = [];
  const listed: { provider: AssistantProvider; key: string }[] = [];
  const registry: AssistantProviderRegistry = {
    model: (provider, key, modelId) => {
      built.push({ provider, key, modelId });
      return model() as never;
    },
    listModels: async (provider, key) => {
      listed.push({ provider, key });
      if (key === "unreachable-key") throw new ProviderUnavailable("Couldn't reach the provider.");
      if (key !== VALID_KEY) throw new ProviderKeyRejected(provider);
      return MODELS;
    },
  };
  return { registry, built, listed };
}

/**
 * MCP tools as plain functions. `opened` records each token a turn connected with and whether the
 * connection was closed, so tests can check a turn cleans up after itself.
 */
export function fakeTools(
  handlers: Record<string, (input: Record<string, unknown>) => unknown> = {},
  options: {
    failToOpen?: boolean;
    extraTools?: number;
    catalogue?: ToolCatalogue;
    /** list_modules exists but keeps failing. */
    failCatalogue?: boolean;
  } = {},
) {
  const opened: { token: string; closed: boolean; selection: ToolSelection }[] = [];
  const openTools: OpenTools = async (token, selection) => {
    if (options.failToOpen) throw new Error("connect ECONNREFUSED");
    if (options.failCatalogue) throw new ToolCatalogueUnavailable("HTTP 429");
    const entry = { token, closed: false, selection };
    opened.push(entry);
    const tools: ToolSet = {};
    for (const [name, handler] of Object.entries(handlers)) {
      tools[name] = tool({
        description: `fake ${name}`,
        inputSchema: z.object({}).passthrough(),
        execute: async (input: Record<string, unknown>) => handler(input),
      } as never);
    }
    for (let i = 0; i < (options.extraTools ?? 0); i++) {
      tools[`filler_${i}`] = tool({
        description: "filler",
        inputSchema: z.object({}),
        execute: async () => "",
      } as never);
    }
    return {
      tools,
      ...(options.catalogue ? { catalogue: options.catalogue } : {}),
      close: async () => {
        entry.closed = true;
      },
    };
  };
  return { openTools, opened };
}

/** An MCP tool result with one text block. */
export const mcpText = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError });
