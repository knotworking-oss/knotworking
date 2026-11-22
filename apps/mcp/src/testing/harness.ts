import type { ModuleId, TokenActionId } from "@knotworking/core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createApi } from "../api";
import { enabledTokenActions } from "../model";
import { jsonSchemaOf, type ToolListMode } from "../catalogue";
import { catalogueOf, compactJsonSchema, createKnotworkingServer } from "../tools";
import { createFakeApi, WRITE_TOKEN, type FakeApi } from "./fake-api";

export const API_URL = "http://api.test";

/** An MCP client wired in-memory to the real tool set, which talks to the in-process fake API. */
export async function connect(
  options: {
    token?: string;
    fake?: FakeApi;
    defaultWorkspace?: string;
    modules?: readonly ModuleId[];
    fetch?: typeof fetch;
    /** Use one memoizing `Api` for every tool call, like a single HTTP request (e.g. one batch) does. */
    memoize?: boolean;
    /** Token actions an owner or admin has enabled (API access); the tool list is read from the fake API. */
    enable?: readonly TokenActionId[];
    /** Offer only read-only tools, as `?tools=read` does. */
    readOnly?: boolean;
    /**
     * How tools are listed. `all` (the default here) lists every tool, so `call` reaches it by name.
     * In `catalogue` mode `call` still takes the tool's name but goes through the generic tools,
     * as an agent would: find_records / get_record for resources, run_module_tool for the rest.
     * `MCP_TEST_LIST_MODE=catalogue` runs a whole suite that way.
     */
    listMode?: ToolListMode;
  } = {},
) {
  const fake = options.fake ?? createFakeApi();
  const listMode: ToolListMode =
    options.listMode ?? (process.env.MCP_TEST_LIST_MODE === "catalogue" ? "catalogue" : "all");
  const makeApi = () =>
    createApi({
      baseUrl: API_URL,
      token: options.token ?? WRITE_TOKEN,
      fetch: options.fetch ?? fake.fetch,
      ...(options.memoize ? { memoize: true } : {}),
    });
  for (const action of options.enable ?? []) fake.tokenActions.add(action);
  const shared = options.memoize ? makeApi() : undefined;
  const tokenActions = await enabledTokenActions(makeApi(), {
    defaultWorkspace: options.defaultWorkspace ?? "acme",
  });
  fake.requests.length = 0; // that read is setup, not something a test made the tools do
  const server = createKnotworkingServer({
    getApi: () => shared ?? makeApi(),
    defaultWorkspace: options.defaultWorkspace,
    modules: options.modules,
    readOnly: options.readOnly,
    listMode,
    // As the real entry points do: the gated tools are listed from what the API says is enabled.
    tokenActions,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  const catalogue = catalogueOf(server)!;
  const native = new Set((await client.listTools()).tools.map((t) => t.name));
  /** In catalogue mode: the generic call an agent makes to reach `name`. */
  function route(name: string, args: Record<string, unknown>) {
    if (listMode !== "catalogue" || native.has(name)) return { name, arguments: args };
    const entry = catalogue.entries.get(name);
    const { workspace, ...rest } = args;
    const ws = workspace === undefined ? {} : { workspace };
    if (entry?.resource?.op === "list")
      return { name: "find_records", arguments: { resource: entry.resource.name, filters: rest, ...ws } };
    if (entry?.resource?.op === "get") {
      const idParam = catalogue.idParamOf(entry.resource.name)!;
      const { [idParam]: id, ...options } = rest;
      return {
        name: "get_record",
        arguments: { resource: entry.resource.name, id, options, ...ws },
      };
    }
    return { name: "run_module_tool", arguments: { name, args } };
  }

  /** Calls a tool and returns the parsed JSON text plus the raw result. */
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool(route(name, args));
    const first = (result.content as { type: string; text: string }[])[0]!;
    let data: any = first.text;
    try {
      data = JSON.parse(first.text);
    } catch {
      // plain text result
    }
    return { data, isError: result.isError === true, result };
  }
  /**
   * In catalogue mode, `client.listTools()` answers with everything the connection is offered
   * (what `?list=all` would list), so the suites' "is this tool offered?" checks test the
   * catalogue's gate: an entry exists exactly when the dispatchers accept it.
   */
  if (listMode === "catalogue") {
    const listTools = client.listTools.bind(client);
    const dispatchers = new Set(["describe_module", "run_module_tool"]);
    client.listTools = (async (...args: Parameters<typeof listTools>) => {
      const listed = await listTools(...args);
      const offered = [...catalogue.entries.values()]
        .filter((e) => !native.has(e.name))
        .map((e) => ({
          name: e.name,
          title: e.title,
          description: e.description,
          inputSchema: jsonSchemaOf(e.input, compactJsonSchema) as { type: "object" },
          annotations: e.annotations,
        }));
      return { ...listed, tools: [...listed.tools.filter((t) => !dispatchers.has(t.name)), ...offered] };
    }) as typeof client.listTools;
  }
  return { client, call, fake, close: () => Promise.all([client.close(), server.close()]) };
}
