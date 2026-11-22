import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { assistantProviderNames, type AssistantProvider } from "@knotworking/core";
import type { LanguageModel } from "ai";

/**
 * The model providers a member can bring a key for. Each entry knows how to build an AI SDK
 * language model from a key and how to list the provider's chat models, which doubles as the
 * check that a pasted key works. Adding a provider is one entry here, one id in core and one
 * dependency. The list calls only ever go to the provider's own, fixed host. See docs/assistant.md.
 */

/** The provider said no to the key (HTTP 401/403). */
export class ProviderKeyRejected extends Error {
  constructor(provider: AssistantProvider) {
    super(`${assistantProviderNames[provider]} rejected that API key.`);
  }
}
/** The provider could not be reached, or answered something unexpected. */
export class ProviderUnavailable extends Error {}

type FetchLike = typeof fetch;

export interface AssistantProviderDef {
  /** A language model for `modelId` that bills the given key. */
  model(key: string, modelId: string): LanguageModel;
  /** Chat-capable model ids, sorted. Throws {@link ProviderKeyRejected} or {@link ProviderUnavailable}. */
  listModels(key: string, fetchFn: FetchLike, signal?: AbortSignal): Promise<string[]>;
}

async function getJson(
  provider: AssistantProvider,
  url: string,
  headers: Record<string, string>,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { accept: "application/json", ...headers },
      redirect: "error",
      signal: signal ?? AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ProviderUnavailable(
      `Couldn't reach ${assistantProviderNames[provider]}. Try again in a moment.`,
    );
  }
  if (res.status === 401 || res.status === 403) throw new ProviderKeyRejected(provider);
  if (!res.ok) {
    throw new ProviderUnavailable(
      `${assistantProviderNames[provider]} answered ${res.status} when checking the key.`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new ProviderUnavailable(`${assistantProviderNames[provider]} sent an unexpected answer.`);
  }
}

const rows = (body: unknown, field: string): Record<string, any>[] => {
  const list = (body as Record<string, unknown> | null)?.[field];
  return Array.isArray(list)
    ? list.filter((r): r is Record<string, any> => !!r && typeof r === "object")
    : [];
};
const ids = (list: Record<string, any>[], pick: (r: Record<string, any>) => unknown = (r) => r.id) =>
  [...new Set(list.map(pick).filter((v): v is string => typeof v === "string" && v.length > 0))].sort();
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
/** Models that aren't chat models (speech, images, embeddings, safety classifiers). */
const NOT_CHAT =
  /embed|moderation|whisper|tts|transcri|dall-e|image|imagine|video|realtime|audio|guard|ocr|rerank/i;

export const assistantProviderDefs: Record<AssistantProvider, AssistantProviderDef> = {
  claude: {
    model: (apiKey, id) => createAnthropic({ apiKey })(id),
    listModels: async (key, f, signal) =>
      ids(
        rows(
          await getJson(
            "claude",
            "https://api.anthropic.com/v1/models?limit=100",
            { "x-api-key": key, "anthropic-version": "2023-06-01" },
            f,
            signal,
          ),
          "data",
        ),
      ),
  },
  openai: {
    model: (apiKey, id) => createOpenAI({ apiKey })(id),
    listModels: async (key, f, signal) =>
      ids(
        rows(await getJson("openai", "https://api.openai.com/v1/models", bearer(key), f, signal), "data"),
      ).filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !NOT_CHAT.test(id) && !/instruct|search/.test(id)),
  },
  google: {
    model: (apiKey, id) => createGoogleGenerativeAI({ apiKey })(id),
    listModels: async (key, f, signal) =>
      ids(
        rows(
          await getJson(
            "google",
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
            { "x-goog-api-key": key },
            f,
            signal,
          ),
          "models",
        ).filter(
          (m) =>
            Array.isArray(m.supportedGenerationMethods) &&
            m.supportedGenerationMethods.includes("generateContent"),
        ),
        (m) => (typeof m.name === "string" ? m.name.replace(/^models\//, "") : undefined),
      ).filter((id) => !NOT_CHAT.test(id) && !/^aqa$/.test(id)),
  },
  mistral: {
    model: (apiKey, id) => createMistral({ apiKey })(id),
    listModels: async (key, f, signal) =>
      ids(
        rows(
          await getJson("mistral", "https://api.mistral.ai/v1/models", bearer(key), f, signal),
          "data",
        ).filter((m) => m.capabilities?.completion_chat !== false),
      ).filter((id) => !NOT_CHAT.test(id)),
  },
  xai: {
    model: (apiKey, id) => createXai({ apiKey })(id),
    listModels: async (key, f, signal) =>
      ids(rows(await getJson("xai", "https://api.x.ai/v1/models", bearer(key), f, signal), "data")).filter(
        (id) => !NOT_CHAT.test(id),
      ),
  },
  groq: {
    model: (apiKey, id) => createGroq({ apiKey })(id),
    listModels: async (key, f, signal) =>
      ids(
        rows(
          await getJson("groq", "https://api.groq.com/openai/v1/models", bearer(key), f, signal),
          "data",
        ).filter((m) => m.active !== false),
      ).filter((id) => !NOT_CHAT.test(id)),
  },
  deepseek: {
    model: (apiKey, id) => createDeepSeek({ apiKey })(id),
    listModels: async (key, f, signal) =>
      ids(rows(await getJson("deepseek", "https://api.deepseek.com/models", bearer(key), f, signal), "data")),
  },
};

/** The providers the server offers. Tests pass a fake one; production uses {@link assistantProviderDefs}. */
export interface AssistantProviderRegistry {
  model(provider: AssistantProvider, key: string, modelId: string): LanguageModel;
  listModels(provider: AssistantProvider, key: string, signal?: AbortSignal): Promise<string[]>;
}

export function createProviderRegistry(
  defs: Record<AssistantProvider, AssistantProviderDef> = assistantProviderDefs,
  fetchFn: FetchLike = (input, init) => fetch(input, init),
): AssistantProviderRegistry {
  return {
    model: (provider, key, modelId) => defs[provider].model(key, modelId),
    listModels: (provider, key, signal) => defs[provider].listModels(key, fetchFn, signal),
  };
}
