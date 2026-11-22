import { newId } from "@knotworking/core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpApp } from "./app";
import { loadConfig, type McpConfig } from "./config";
import { createFakeApi, READ_TOKEN, WRITE_TOKEN } from "./testing/fake-api";

const config = (over: Partial<McpConfig> = {}): McpConfig => ({
  apiUrl: "http://api.test",
  host: "127.0.0.1",
  port: 4100,
  allowedHosts: ["localhost", "127.0.0.1", "[::1]", "knotworking.example.com"],
  defaultWorkspace: undefined,
  maxBodyBytes: 100_000,
  maxBatch: 10,
  rateLimitPerMinute: 0,
  activeModules: [
    "tasks",
    "docs",
    "time",
    "calendar",
    "items",
    "recipes",
    "sops",
    "stock",
    "customers",
    "despatch",
    "demand",
    "production",
    "haccp",
    "people",
    "training",
    "attendance",
    "quality",
    "purchasing",
    "costing",
    "site",
    "labels",
  ],
  ...over,
});

function setup(over: Partial<McpConfig> = {}) {
  const fake = createFakeApi();
  const app = createMcpApp({ config: config(over), fetch: fake.fetch });
  /** Like a real HTTP server, which always supplies a Host header. */
  const request = (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("host")) headers.set("host", "localhost:4100");
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      headers.set("accept", "application/json, text/event-stream");
    }
    return app.request(`http://localhost:4100${path}`, {
      ...init,
      headers,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
  };
  return { fake, app, request };
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "curl", version: "0" } },
};
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("HTTP endpoint", () => {
  it("serves /health without credentials", async () => {
    const { request } = setup();
    const res = await request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers 401 with WWW-Authenticate: Bearer when the Authorization header is missing", async () => {
    const { request, fake } = setup();
    const res = await request("/mcp", { method: "POST", json: initialize });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    ["a non-token bearer", "Bearer eyJhbGciOiJIUzI1NiJ9.session"],
    ["a non-bearer scheme", `Basic ${btoa("a:b")}`],
    ["an empty bearer", "Bearer "],
  ])("rejects %s with 401", async (_name, authorization) => {
    const { request } = setup();
    const res = await request("/mcp", { method: "POST", json: initialize, headers: { authorization } });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("accepts only POST (stateless server)", async () => {
    const { request } = setup();
    for (const method of ["GET", "DELETE"]) {
      const res = await request("/mcp", { method, headers: bearer(WRITE_TOKEN) });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("refuses unexpected Host and Origin headers (DNS rebinding)", async () => {
    const { request } = setup();
    const evilHost = await request("/mcp", {
      method: "POST",
      json: initialize,
      headers: { ...bearer(WRITE_TOKEN), host: "evil.example" },
    });
    expect(evilHost.status).toBe(403);
    const evilOrigin = await request("/mcp", {
      method: "POST",
      json: initialize,
      headers: { ...bearer(WRITE_TOKEN), origin: "https://evil.example" },
    });
    expect(evilOrigin.status).toBe(403);
    const ok = await request("/mcp", {
      method: "POST",
      json: initialize,
      headers: {
        ...bearer(WRITE_TOKEN),
        host: "knotworking.example.com",
        origin: "https://knotworking.example.com",
      },
    });
    expect(ok.status).toBe(200);
  });

  it("sends no CORS headers", async () => {
    const { request } = setup();
    const res = await request("/mcp", { method: "OPTIONS", headers: { origin: "http://localhost:3000" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const post = await request("/mcp", { method: "POST", json: initialize, headers: bearer(WRITE_TOKEN) });
    expect(post.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("limits the request body size and validates JSON", async () => {
    const { request } = setup({ maxBodyBytes: 2048 });
    const big = await request("/mcp", {
      method: "POST",
      json: { ...initialize, padding: "x".repeat(5000) },
      headers: bearer(WRITE_TOKEN),
    });
    expect(big.status).toBe(413);
    const bad = await request("/mcp", {
      method: "POST",
      body: "{nope",
      headers: {
        ...bearer(WRITE_TOKEN),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
    });
    expect(bad.status).toBe(400);
  });

  it("returns 404 JSON for other paths", async () => {
    const { request } = setup();
    expect((await request("/")).status).toBe(404);
  });
});

const toolCall = (id: number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});
const listTools = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list" });

describe("modules", () => {
  const names = async (s: ReturnType<typeof setup>, query = "") => {
    const res = await s.request(`/mcp${query ? `${query}&` : "?"}list=all`, {
      method: "POST",
      json: listTools(1),
      headers: bearer(WRITE_TOKEN),
    });
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    return body.result.tools.map((t) => t.name);
  };

  it("lets a connection choose read-only tools or some modules, and refuses unknown choices", async () => {
    const s = setup();
    const all = await names(s);
    const read = await names(s, "?tools=read");
    expect(read).toContain("list_tasks");
    expect(read).not.toContain("create_task");
    expect(read.length).toBeLessThan(all.length);
    const some = await names(s, "?modules=docs");
    expect(some).toContain("get_document");
    expect(some).toContain("list_workspaces");
    expect(some).not.toContain("list_tasks");
    // A write tool that isn't listed can't be called either.
    const res = await s.request("/mcp?tools=read&list=all", {
      method: "POST",
      json: toolCall(2, "create_task", { title: "x" }),
      headers: bearer(WRITE_TOKEN),
    });
    const body = (await res.json()) as { error?: unknown; result?: { isError?: boolean } };
    expect(Boolean(body.error) || body.result?.isError === true).toBe(true);
    for (const bad of ["?tools=write", "?modules=docs,nope"]) {
      const refused = await s.request(`/mcp${bad}`, {
        method: "POST",
        json: listTools(3),
        headers: bearer(WRITE_TOKEN),
      });
      expect(refused.status, bad).toBe(400);
    }
  });

  it("offers only the tools of modules active in this environment", async () => {
    const tools = await names(setup({ activeModules: ["docs"] }));
    expect(tools).toContain("list_workspaces");
    expect(tools).toContain("get_document");
    expect(tools).not.toContain("list_tasks");
    expect(tools).not.toContain("log_time");
  });

  it("hides the tools of modules the token's user can't read", async () => {
    const s = setup();
    s.fake.moduleAccess.docs = "none";
    const tools = await names(s);
    expect(tools).toContain("list_tasks");
    expect(tools).not.toContain("get_document");
    expect(tools).not.toContain("create_document");
  });

  it("offers customer/despatch tools only with their active modules and readable grants", async () => {
    const s = setup({ activeModules: ["items", "stock", "customers", "despatch"] });
    const offered = await names(s);
    expect(offered).toContain("list_customers");
    expect(offered).toContain("draft_despatch");
    expect(offered).not.toContain("get_distribution_impact");
    expect(offered).not.toContain("confirm_despatch");
    s.fake.moduleAccess.despatch = "none";
    const restricted = await names(s);
    expect(restricted).toContain("list_customers");
    expect(restricted).not.toContain("get_lot_recipients");
    expect(restricted).not.toContain("draft_despatch");
  });

  it("hides distribution impact unless production is readable as well as despatch", async () => {
    const s = setup();
    expect(await names(s)).toContain("get_distribution_impact");
    s.fake.moduleAccess.production = "none";
    expect(await names(s)).not.toContain("get_distribution_impact");
    s.fake.moduleAccess.production = "read";
    s.fake.moduleAccess.despatch = "none";
    expect(await names(s)).not.toContain("get_distribution_impact");
  });

  it("falls back to the environment's modules when the API can't say", async () => {
    const s = setup();
    delete s.fake.moduleAccess.docs;
    s.fake.hooks.failModules = true;
    expect(await names(s)).toContain("get_document");
  });

  it("reads /me once for a listing, shared by the module and token-action lookups", async () => {
    const s = setup({ defaultWorkspace: undefined });
    await names(s);
    expect(s.fake.hits("/me")).toBe(1);
    expect(s.fake.hits("/modules")).toBe(1);
    expect(s.fake.hits("/token-actions")).toBe(1);
  });

  it("does not look module access up for tool calls (the API enforces it)", async () => {
    const s = setup();
    await s.request("/mcp?list=all", {
      method: "POST",
      json: toolCall(1, "list_projects", { workspace: "acme" }),
      headers: bearer(WRITE_TOKEN),
    });
    expect(s.fake.hits("/modules", "GET")).toBe(0);
  });

  it("reads KNOTWORKING_MODULES like the API does", () => {
    expect(loadConfig({ KNOTWORKING_MODULES: "docs" }).activeModules).toEqual(["docs"]);
    expect(() => loadConfig({ KNOTWORKING_MODULES: "time" })).toThrow(/needs "tasks"/);
  });
});

describe("request amplification limits", () => {
  const post = (s: ReturnType<typeof setup>, json: unknown, token = WRITE_TOKEN) =>
    s.request("/mcp?list=all", { method: "POST", json, headers: bearer(token) });

  it("rejects batches over MCP_MAX_BATCH with 400 and a JSON-RPC error, before doing any work", async () => {
    const s = setup({ maxBatch: 3 });
    const ok = await post(
      s,
      [1, 2, 3].map((i) => toolCall(i, "list_projects", { workspace: "acme" })),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toHaveLength(3);

    s.fake.requests.length = 0;
    const tooBig = await post(
      s,
      [1, 2, 3, 4].map((i) => toolCall(i, "list_projects", { workspace: "acme" })),
    );
    expect(tooBig.status).toBe(400);
    const body = (await tooBig.json()) as { error: { message: string } };
    expect(body).toMatchObject({ jsonrpc: "2.0", error: { code: -32600 } });
    expect(body.error.message).toMatch(/at most 3 messages \(got 4\)/);
    expect(s.fake.requests).toHaveLength(0);
  });

  it("allows a single (non-batch) message with MCP_MAX_BATCH=1", async () => {
    const s = setup({ maxBatch: 1 });
    expect((await post(s, listTools(1))).status).toBe(200);
    expect((await post(s, [listTools(1), listTools(2)])).status).toBe(400);
  });

  it("shares the workspace snapshot and /v1/me between the tool calls of one request", async () => {
    const s = setup();
    // No workspace argument: each call needs /v1/me to choose one, then the bootstrap for names.
    const res = await post(s, [
      toolCall(1, "list_projects"),
      toolCall(2, "list_documents"),
      toolCall(3, "list_tasks"),
    ]);
    const results = (await res.json()) as { result: { isError?: boolean } }[];
    expect(results).toHaveLength(3);
    for (const r of results) expect(r.result.isError).toBeFalsy();
    expect(s.fake.hits("/v1/me")).toBe(1);
    expect(s.fake.hits("/bootstrap")).toBe(1);
  });

  it("never shares that memo between requests or tokens", async () => {
    const s = setup();
    const call = [toolCall(1, "list_projects"), toolCall(2, "list_documents")];
    await post(s, call);
    await post(s, call);
    await post(s, call, READ_TOKEN);
    expect(s.fake.hits("/v1/me")).toBe(3);
    expect(s.fake.hits("/bootstrap")).toBe(3);
    // Each of them went out with its own caller's token.
    const auth = s.fake.requests.map((r) => r.authorization);
    expect(auth.filter((a) => a === `Bearer ${READ_TOKEN}`)).toHaveLength(2);
    expect(auth.filter((a) => a === `Bearer ${WRITE_TOKEN}`)).toHaveLength(4);
  });

  it("a write in one request is visible to the next (nothing is cached across requests)", async () => {
    const s = setup();
    const created = (await (
      await post(s, toolCall(1, "create_task", { workspace: "acme", team: "ENG", title: "Batched" }))
    ).json()) as any;
    expect(created.result.isError).toBeFalsy();
    const list = (await (await post(s, toolCall(2, "list_tasks", { workspace: "acme" }))).json()) as any;
    expect(JSON.parse(list.result.content[0].text).total).toBe(3);
  });

  describe("per-token rate limit", () => {
    const clockedSetup = (limit: number, over: Partial<McpConfig> = {}) => {
      let t = 1_000_000;
      const fake = createFakeApi();
      const app = createMcpApp({
        config: config({ rateLimitPerMinute: limit, ...over }),
        fetch: fake.fetch,
        now: () => t,
      });
      const request = (json: unknown, token = WRITE_TOKEN) =>
        app.request("http://localhost:4100/mcp?list=all", {
          method: "POST",
          headers: {
            host: "localhost:4100",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...bearer(token),
          },
          body: JSON.stringify(json),
        });
      return { fake, request, advance: (ms: number) => (t += ms) };
    };
    const call = (i = 1) => toolCall(i, "list_projects", { workspace: "acme" });

    it("answers 429 with Retry-After and a JSON-RPC error once the token's budget is spent", async () => {
      const s = clockedSetup(3);
      for (let i = 0; i < 3; i++) expect((await s.request(call(i))).status).toBe(200);
      const apiCalls = s.fake.requests.length;
      const limited = await s.request(call(9));
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(limited.headers.get("content-type")).toMatch(/json/);
      const body = (await limited.json()) as any;
      expect(body).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });
      expect(body.error.message).toMatch(/3 tool calls per minute/);
      expect(s.fake.requests).toHaveLength(apiCalls); // refused before touching the API
    });

    it("refills with time (3 per minute = one every 20 seconds)", async () => {
      const s = clockedSetup(3);
      for (let i = 0; i < 3; i++) await s.request(call(i));
      const limited = await s.request(call());
      expect(limited.headers.get("retry-after")).toBe("20");
      s.advance(19_000);
      expect((await s.request(call())).status).toBe(429);
      s.advance(1_000);
      expect((await s.request(call())).status).toBe(200);
      expect((await s.request(call())).status).toBe(429);
    });

    it("counts tool calls only, not initialize, tools/list or notifications", async () => {
      const s = clockedSetup(1);
      expect((await s.request(call())).status).toBe(200);
      expect((await s.request(call())).status).toBe(429);
      expect((await s.request(initialize)).status).toBe(200);
      expect((await s.request(listTools(2))).status).toBe(200);
      expect((await s.request({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBeLessThan(
        300,
      );
    });

    it("charges every tool call in a batch, and refuses a batch that does not fit without charging it", async () => {
      const s = clockedSetup(3);
      expect((await s.request([call(1), call(2)])).status).toBe(200); // 1 left
      expect((await s.request([call(3), call(4)])).status).toBe(429); // needs 2
      expect((await s.request(call(5))).status).toBe(200); // the 1 that was left
      expect((await s.request(call(6))).status).toBe(429);
    });

    it("keeps separate counters for different tokens", async () => {
      const s = clockedSetup(2);
      expect((await s.request(call(1))).status).toBe(200);
      expect((await s.request(call(2))).status).toBe(200);
      expect((await s.request(call(3))).status).toBe(429);
      // Another token is unaffected, and spending it does not affect the first.
      expect((await s.request(call(4), READ_TOKEN)).status).toBe(200);
      expect((await s.request(call(5), READ_TOKEN)).status).toBe(200);
      expect((await s.request(call(6), READ_TOKEN)).status).toBe(429);
      s.advance(30_000);
      expect((await s.request(call(7))).status).toBe(200);
    });

    it("is off with 0", async () => {
      const s = clockedSetup(0);
      for (let i = 0; i < 30; i++) expect((await s.request(call(i))).status).toBe(200);
    });
  });
});

describe("MCP over Streamable HTTP, end to end", () => {
  const clients: Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  });

  async function connectHttp(token: string, over: Partial<McpConfig> = {}) {
    const s = setup(over);
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost:4100/mcp?list=all"), {
      requestInit: { headers: bearer(token) },
      fetch: async (url, init) => {
        const u = new URL(String(url));
        return s.request(u.pathname + u.search, init as RequestInit);
      },
    });
    const client = new Client({ name: "e2e", version: "0.0.0" });
    clients.push(client);
    await client.connect(transport);
    return { ...s, client };
  }

  it("initializes, lists tools and calls them, forwarding the caller's bearer token to the API", async () => {
    const { client, fake } = await connectHttp(WRITE_TOKEN);
    expect(client.getServerVersion()?.name).toBe("knotworking");
    expect(client.getInstructions()).toMatch(/not instructions/);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("create_task");
    expect(tools.find((t) => t.name === "list_tasks")?.annotations?.readOnlyHint).toBe(true);

    const res = await client.callTool({ name: "list_tasks", arguments: { workspace: "acme", team: "ENG" } });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(data.total).toBe(2);

    const created = await client.callTool({
      name: "create_task",
      arguments: { team: "ENG", title: "From HTTP", state: "Todo" },
    });
    expect(created.isError).toBeFalsy();
    expect(fake.store.tasks.at(-1)?.title).toBe("From HTTP");

    expect(fake.requests.length).toBeGreaterThan(0);
    for (const r of fake.requests) expect(r.authorization).toBe(`Bearer ${WRITE_TOKEN}`);
  });

  it("lists the API-access tools only while their action is enabled, but lets a call reach the API", async () => {
    const { client, fake } = await connectHttp(WRITE_TOKEN, { defaultWorkspace: "acme" });
    const names = async () => (await client.listTools()).tools.map((t) => t.name);
    expect(await names()).not.toContain("record_stock_waste");

    fake.tokenActions.add("stock.waste");
    expect(await names()).toContain("record_stock_waste");

    fake.tokenActions.clear();
    expect(await names()).not.toContain("record_stock_waste");
    // A call is not shaped by the listing: the API answers, and says why it refused.
    const res = await client.callTool({
      name: "record_stock_waste",
      arguments: { lot: newId(), location: newId(), quantity: 1, unit: "kg", reason: "x" },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content as { text: string }[])[0]!.text).error.code).toBe("token_not_allowed");

    // The token's own allowlist counts too: on in the workspace but not for this token, it stays hidden.
    fake.tokenActions.add("stock.waste");
    fake.tokenActionsDenied.add("stock.waste");
    expect(await names()).not.toContain("record_stock_waste");
    fake.tokenActionsDenied.clear();
    expect(await names()).toContain("record_stock_waste");

    // Fail closed: if the actions can't be read, the gated tools stay hidden.
    fake.hooks.failTokenActions = true;
    expect(await names()).not.toContain("record_stock_waste");
  });

  it("uses each request's own token: a read-only token cannot write even on the same server", async () => {
    const { client, fake } = await connectHttp(READ_TOKEN);
    expect((await client.callTool({ name: "list_workspaces", arguments: {} })).isError).toBeFalsy();
    const res = await client.callTool({ name: "create_task", arguments: { team: "ENG", title: "nope" } });
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(body.error).toMatchObject({ code: "token_read_only", status: 403 });
    expect(JSON.stringify(res)).not.toContain(READ_TOKEN);
    expect(fake.store.tasks).toHaveLength(2);
  });

  it("applies the configured default workspace", async () => {
    const { client } = await connectHttp(WRITE_TOKEN, { defaultWorkspace: "acme" });
    const res = await client.callTool({ name: "list_projects", arguments: {} });
    expect(JSON.parse((res.content as { text: string }[])[0]!.text).total).toBe(1);
  });
});

describe("loadConfig", () => {
  it("has safe defaults: loopback, port 4100, localhost hosts only", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      apiUrl: "http://127.0.0.1:4000",
      host: "127.0.0.1",
      port: 4100,
      defaultWorkspace: undefined,
    });
    expect(c.allowedHosts).toEqual(expect.arrayContaining(["localhost", "127.0.0.1"]));
    expect(c.allowedHosts).not.toContain("*");
  });

  it("ignores PORT and API_URL, which belong to the API and web app", () => {
    const c = loadConfig({ PORT: "4000", API_URL: "http://elsewhere:1" });
    expect(c.port).toBe(4100);
    expect(c.apiUrl).toBe("http://127.0.0.1:4000");
  });

  it("trims the API URL and reads the overrides", () => {
    const c = loadConfig({
      KNOTWORKING_API_URL: "http://api:4000/",
      MCP_PORT: "5000",
      MCP_HOST: "0.0.0.0",
      KNOTWORKING_DEFAULT_WORKSPACE: " acme ",
      MCP_MAX_BODY_BYTES: "5000",
    });
    expect(c).toMatchObject({
      apiUrl: "http://api:4000",
      port: 5000,
      host: "0.0.0.0",
      defaultWorkspace: "acme",
      maxBodyBytes: 5000,
    });
  });

  it("allows the hostnames of APP_URL and TRUSTED_ORIGINS unless MCP_ALLOWED_HOSTS is set, which wins", () => {
    const derived = loadConfig({
      APP_URL: "https://kw.example.com",
      TRUSTED_ORIGINS: "http://192.168.1.20:3000, http://kw.lan:3000",
    });
    expect(derived.allowedHosts).toEqual(
      expect.arrayContaining(["localhost", "kw.example.com", "192.168.1.20", "kw.lan"]),
    );
    const explicit = loadConfig({
      APP_URL: "https://kw.example.com",
      MCP_ALLOWED_HOSTS: "Mcp.Example.com, localhost",
    });
    expect(explicit.allowedHosts).toEqual(["mcp.example.com", "localhost"]);
    // The API's own address for this server (the assistant's tools) is always accepted.
    const internal = loadConfig({
      MCP_ALLOWED_HOSTS: "mcp.example.com",
      MCP_INTERNAL_URL: "http://mcp:4100/mcp",
    });
    expect(internal.allowedHosts).toEqual(["mcp.example.com", "mcp"]);
    expect(loadConfig({ MCP_INTERNAL_URL: "http://mcp:4100/mcp" }).allowedHosts).toContain("mcp");
  });

  it("reads MCP_MAX_BATCH (default 10) and MCP_RATE_LIMIT_PER_MINUTE (default 120, 0 disables)", () => {
    expect(loadConfig({})).toMatchObject({ maxBatch: 10, rateLimitPerMinute: 120 });
    expect(loadConfig({ MCP_MAX_BATCH: "3", MCP_RATE_LIMIT_PER_MINUTE: "0" })).toMatchObject({
      maxBatch: 3,
      rateLimitPerMinute: 0,
    });
    expect(loadConfig({ MCP_MAX_BATCH: "", MCP_RATE_LIMIT_PER_MINUTE: " " })).toMatchObject({
      maxBatch: 10,
      rateLimitPerMinute: 120,
    });
  });

  it.each([
    ["MCP_MAX_BATCH", "0"],
    ["MCP_MAX_BATCH", "ten"],
    ["MCP_RATE_LIMIT_PER_MINUTE", "-1"],
    ["MCP_RATE_LIMIT_PER_MINUTE", "1.5"],
  ])("rejects an invalid %s=%s at startup", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(new RegExp(name));
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ MCP_PORT: "99999" })).toThrow(/MCP_PORT/);
  });
});

describe("what a caller is shown over HTTP, in both list modes", () => {
  type Rpc = { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } };
  const rpc = async (s: ReturnType<typeof setup>, query: string, json: unknown, token = WRITE_TOKEN) => {
    const res = await s.request(`/mcp${query}`, { method: "POST", json, headers: bearer(token) });
    return (await res.json()) as Rpc | Rpc[];
  };
  const listed = async (s: ReturnType<typeof setup>, query: string) =>
    ((await rpc(s, query, listTools(1))) as Rpc).result!.tools!.map((t) => t.name);
  const callData = async (s: ReturnType<typeof setup>, query: string, name: string, args = {}) => {
    const body = (await rpc(s, query, toolCall(1, name, args))) as Rpc;
    return { data: JSON.parse(body.result!.content![0]!.text), isError: body.result!.isError === true };
  };
  /** Every tool name `list_modules` mentions (core, module tools and, in list=all, resource tools). */
  const mentioned = async (s: ReturnType<typeof setup>, query: string) => {
    const { data } = await callData(s, query, "list_modules");
    return {
      ids: data.modules.map((m: { id: string }) => m.id) as string[],
      names: [...data.core, ...data.modules.flatMap((m: { tools: string[] }) => m.tools)] as string[],
      resources: data.modules.flatMap((m: { resources: string[] }) => m.resources) as string[],
    };
  };

  for (const query of ["?list=catalogue", "?list=all"]) {
    describe(query, () => {
      it("shows token-action tools only while their action is enabled", async () => {
        const s = setup({ defaultWorkspace: "acme" });
        expect((await mentioned(s, query)).names).not.toContain("record_stock_waste");
        if (query === "?list=catalogue") {
          const stock = (await callData(s, query, "describe_module", { module: "stock" })).data;
          expect(stock.tools.map((t: { name: string }) => t.name)).not.toContain("record_stock_waste");
        } else expect(await listed(s, query)).not.toContain("record_stock_waste");
        s.fake.tokenActions.add("stock.waste");
        expect((await mentioned(s, query)).names).toContain("record_stock_waste");
        s.fake.tokenActionsDenied.add("stock.waste");
        expect((await mentioned(s, query)).names).not.toContain("record_stock_waste");
      });

      it("hides modules the user can't read, and cross-module tools missing a module", async () => {
        const s = setup({ defaultWorkspace: "acme" });
        s.fake.moduleAccess.docs = "none";
        s.fake.moduleAccess.production = "none";
        const seen = await mentioned(s, query);
        expect(seen.ids).not.toContain("docs");
        expect(seen.resources).not.toContain("documents");
        expect(seen.names).not.toContain("get_document");
        expect(seen.names).not.toContain("get_distribution_impact");
        const natively = await listed(s, query);
        expect(natively).not.toContain("get_document");
        expect(natively).not.toContain("get_distribution_impact");
        if (query === "?list=catalogue") {
          const docs = await callData(s, query, "describe_module", { module: "docs" });
          expect(docs.data.error.code).toBe("not_found");
        }
      });

      it("shows no write tools on a read-only connection", async () => {
        const s = setup({ defaultWorkspace: "acme" });
        const q = `${query}&tools=read`;
        const seen = await mentioned(s, q);
        expect(seen.names).not.toContain("create_task");
        expect(seen.names).not.toContain("create_item");
        expect(seen.names).toContain("get_task");
      });

      it("names only visible resources in errors, and answers a hidden resource like a misspelt one", async () => {
        const s = setup({ defaultWorkspace: "acme" });
        s.fake.moduleAccess.docs = "none";
        const unknown = await callData(s, query, "find_records", { resource: "widgets" });
        expect(unknown.data.error.code).toBe("not_found");
        expect(unknown.data.error.message).toContain("complaints");
        expect(unknown.data.error.message).not.toContain("documents");
        // A malformed call to a hidden resource doesn't reveal its fields.
        const hidden = await callData(s, query, "find_records", {
          resource: "documents",
          filters: { bogus: 1 },
        });
        expect(hidden.data.error.code).toBe("not_found");
        expect(hidden.data.error.message).not.toMatch(/title_contains/);
        expect(hidden.data.error.message.replace("documents", "X")).toBe(
          unknown.data.error.message.replace("widgets", "X"),
        );
      });
    });
  }

  it("runs a call the same whether or not a describing call shares its batch", async () => {
    const s = setup({ defaultWorkspace: "acme" });
    // The API (not the listing) decides calls: hidden from what is shown, the call still reaches it.
    s.fake.moduleAccess.quality = "none";
    const find = toolCall(2, "find_records", { resource: "complaints" });
    const alone = (await rpc(s, "?list=catalogue", find)) as Rpc;
    const batched = (await rpc(s, "?list=catalogue", [toolCall(1, "list_modules"), find])) as Rpc[];
    const second = batched.find((r) => (r as { id?: number }).id === 2)!;
    expect(second.result).toEqual(alone.result);
    expect(alone.result!.isError).toBeFalsy();
    expect(JSON.parse(alone.result!.content![0]!.text)).toHaveProperty("complaints");
  });
});
