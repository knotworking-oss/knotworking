import {
  hostHeaderValidationResponse,
  originValidationResponse,
  readRequestBody,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { tokenActionIds } from "@knotworking/core";
import { Hono } from "hono";
import pkg from "../package.json" with { type: "json" };
import { createApi } from "./api";
import type { McpConfig } from "./config";
import { toolListing } from "./model";
import { RateLimiter, rateLimitKey } from "./rate-limit";
import { createKnotworkingServer, narrowModules, parseToolScope } from "./tools";

export interface McpAppOptions {
  config: McpConfig;
  /** Override for tests: the `fetch` used to reach the API. */
  fetch?: typeof fetch;
  /** Override for tests: the clock (ms) the rate limiter uses. */
  now?: () => number;
}

const API_TOKEN = /^[Bb]earer\s+(knw_\S+)\s*$/;

const jsonError = (
  status: 400 | 401 | 405 | 413 | 429 | 500,
  message: string,
  headers: Record<string, string> = {},
  code = -32000,
) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/**
 * Streamable HTTP MCP endpoint, stateless: every request gets its own McpServer and transport, and the
 * caller's `Authorization: Bearer knw_…` header is forwarded to the API on each tool call. Nothing is
 * stored, so the server holds no credentials and scales (or restarts) freely.
 */
export function createMcpApp({ config, fetch: fetchImpl, now }: McpAppOptions) {
  const app = new Hono();
  // One limiter per app, keyed by a hash of the token; nothing about a request outlives it except counters.
  const limiter = new RateLimiter(config.rateLimitPerMinute, now);

  // Liveness only; deliberately outside the Host/auth checks so container health checks work.
  app.get("/health", (c) => c.json({ ok: true }));

  app.all("/mcp", async (c) => {
    const req = c.req.raw;

    // DNS-rebinding protection: browsers send these headers and a hostile page can't forge them.
    const rejected =
      hostHeaderValidationResponse(req, config.allowedHosts) ??
      originValidationResponse(req, config.allowedHosts);
    if (rejected) return rejected;

    if (req.method !== "POST")
      return jsonError(405, "Method not allowed: this server is stateless and only accepts POST", {
        allow: "POST",
      });

    // Only personal API tokens are forwarded; a browser session token has no business here.
    const token = API_TOKEN.exec(req.headers.get("authorization") ?? "")?.[1];
    if (!token)
      return jsonError(401, "Missing or invalid Authorization header: send `Authorization: Bearer knw_…`", {
        "www-authenticate": 'Bearer realm="knotworking-mcp"',
      });

    // `?tools=read` and `?modules=…` narrow the tool set; `?list=all` lists every tool natively (docs/mcp.md).
    const url = new URL(req.url);
    const scope = parseToolScope({
      tools: url.searchParams.get("tools"),
      modules: url.searchParams.get("modules"),
      list: url.searchParams.get("list"),
    });
    if ("error" in scope) return jsonError(400, `Invalid tool selection: ${scope.error}`);

    const body = await readRequestBody(req, config.maxBodyBytes);
    if (body.tooLarge) return jsonError(413, `Request body exceeds ${config.maxBodyBytes} bytes`);
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body.text);
    } catch {
      return jsonError(400, "Request body is not valid JSON");
    }

    // The SDK accepts batches of up to 100 messages; every message can fan out into API requests, so the
    // (much lower) cap is enforced here, on the body we already parsed, before any work starts.
    const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
    if (messages.length > config.maxBatch)
      return jsonError(
        400,
        `Invalid Request: a batch may contain at most ${config.maxBatch} messages (got ${messages.length})`,
        {},
        -32600,
      );

    // Only tool calls are metered: initialize, tools/list and notifications are cheap and must keep working.
    const toolCalls = messages.filter(
      (m) => typeof m === "object" && m !== null && (m as { method?: unknown }).method === "tools/call",
    ).length;
    const limited = limiter.consume(rateLimitKey(token), toolCalls);
    if (!limited.ok)
      return jsonError(
        429,
        `Rate limit exceeded: at most ${config.rateLimitPerMinute} tool calls per minute per token. Retry in ${limited.retryAfterSeconds}s.`,
        { "retry-after": String(limited.retryAfterSeconds) },
      );

    // `memoize`: one request's tool calls (a batch) share the workspace snapshot instead of refetching it.
    // The Api object is built per request from this request's token, so nothing is shared across callers.
    const api = createApi({
      baseUrl: config.apiUrl,
      token,
      memoize: true,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    // Two views (catalogue.ts): calls run against every active module and token action, since the
    // API checks module access and actions on every request; what is shown (tools/list,
    // list_modules, describe_module, the overview's modules, names in errors) follows this user's
    // module access and enabled actions, read lazily once per request and only when something is
    // shown. So adding a describing call to a batch never changes what the batch's other calls do.
    const server = createKnotworkingServer({
      getApi: () => api,
      defaultWorkspace: config.defaultWorkspace,
      version: pkg.version,
      modules: narrowModules(config.activeModules, scope.modules),
      tokenActions: tokenActionIds,
      readOnly: scope.readOnly,
      listMode: scope.listMode,
      discover: async () => {
        const access = await toolListing(api, {
          active: config.activeModules,
          defaultWorkspace: config.defaultWorkspace,
        });
        return { modules: narrowModules(access.modules, scope.modules), tokenActions: access.tokenActions };
      },
    });
    // JSON responses (not SSE): every tool is a plain request/response, which is friendlier to proxies.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(req, { parsedBody });
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  app.onError((err, c) => {
    // Message only: never headers, so a bearer token can't end up in logs.
    console.error("knotworking-mcp: request failed:", err instanceof Error ? err.message : "unknown error");
    return c.json({ error: { code: "internal", message: "Internal server error" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

  return app;
}
