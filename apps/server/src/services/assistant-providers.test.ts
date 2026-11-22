import { assistantProviders } from "@knotworking/core";
import { describe, expect, it } from "vitest";
import {
  assistantProviderDefs,
  createProviderRegistry,
  ProviderKeyRejected,
  ProviderUnavailable,
} from "./assistant-providers";

type Call = { url: string; init: RequestInit };
const respond = (status: number, body: unknown) => {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, registry: createProviderRegistry(assistantProviderDefs, fetchFn) };
};
const KEY = "sk-test-key-123456";

describe("assistant provider registry", () => {
  it("has an entry for every provider id", () => {
    expect(Object.keys(assistantProviderDefs).sort()).toEqual([...assistantProviders].sort());
  });

  it("lists chat models per provider and filters out the rest", async () => {
    const cases: [(typeof assistantProviders)[number], unknown, string[]][] = [
      ["claude", { data: [{ id: "claude-b" }, { id: "claude-a" }] }, ["claude-a", "claude-b"]],
      [
        "openai",
        {
          data: [
            { id: "gpt-x" },
            { id: "text-embedding-3-small" },
            { id: "whisper-1" },
            { id: "o3" },
            { id: "dall-e-3" },
          ],
        },
        ["gpt-x", "o3"],
      ],
      [
        "google",
        {
          models: [
            { name: "models/gemini-pro", supportedGenerationMethods: ["generateContent"] },
            { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
          ],
        },
        ["gemini-pro"],
      ],
      [
        "mistral",
        {
          data: [
            { id: "mistral-large", capabilities: { completion_chat: true } },
            { id: "mistral-embed" },
            { id: "x", capabilities: { completion_chat: false } },
          ],
        },
        ["mistral-large"],
      ],
      ["xai", { data: [{ id: "grok-4" }, { id: "grok-imagine-image" }] }, ["grok-4"]],
      [
        "groq",
        {
          data: [
            { id: "llama-3", active: true },
            { id: "whisper-large-v3", active: true },
            { id: "old", active: false },
          ],
        },
        ["llama-3"],
      ],
      ["deepseek", { data: [{ id: "deepseek-chat" }] }, ["deepseek-chat"]],
    ];
    for (const [provider, body, expected] of cases) {
      const { registry } = respond(200, body);
      expect(await registry.listModels(provider, KEY), provider).toEqual(expected);
    }
  });

  it("sends the key in a header, never in the URL, and refuses redirects", async () => {
    for (const provider of assistantProviders) {
      const { registry, calls } = respond(200, { data: [], models: [] });
      await registry.listModels(provider, KEY);
      const [call] = calls;
      expect(call!.url, provider).not.toContain(KEY);
      expect(call!.url.startsWith("https://"), provider).toBe(true);
      expect(JSON.stringify(call!.init.headers), provider).toContain(KEY);
      expect(call!.init.redirect, provider).toBe("error");
    }
  });

  it("tells a rejected key from an outage or a strange answer", async () => {
    await expect(respond(401, {}).registry.listModels("openai", KEY)).rejects.toBeInstanceOf(
      ProviderKeyRejected,
    );
    await expect(respond(403, {}).registry.listModels("claude", KEY)).rejects.toBeInstanceOf(
      ProviderKeyRejected,
    );
    await expect(respond(500, {}).registry.listModels("groq", KEY)).rejects.toBeInstanceOf(
      ProviderUnavailable,
    );
    const down = createProviderRegistry(assistantProviderDefs, (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch);
    await expect(down.listModels("xai", KEY)).rejects.toBeInstanceOf(ProviderUnavailable);
    const notJson = createProviderRegistry(
      assistantProviderDefs,
      (async () => new Response("<html>", { status: 200 })) as typeof fetch,
    );
    await expect(notJson.listModels("mistral", KEY)).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  it("builds a language model for every provider without calling the network", () => {
    const registry = createProviderRegistry();
    for (const provider of assistantProviders) {
      const model = registry.model(provider, KEY, "some-model") as { modelId?: string };
      expect(model.modelId, provider).toBe("some-model");
    }
  });
});
