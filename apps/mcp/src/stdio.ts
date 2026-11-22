import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import pkg from "../package.json" with { type: "json" };
import { createApi } from "./api";
import { loadConfig } from "./config";
import { toolListing } from "./model";
import { createKnotworkingServer, narrowModules, parseToolScope } from "./tools";

// stdout carries the protocol, so everything human-readable goes to stderr.
const config = loadConfig();
const token = process.env.KNOTWORKING_API_TOKEN?.trim();
if (!token?.startsWith("knw_")) {
  console.error(
    "knotworking-mcp: set KNOTWORKING_API_TOKEN to a Knotworking API token (knw_…). See docs/mcp.md.",
  );
  process.exit(1);
}

const scope = parseToolScope({
  tools: process.env.KNOTWORKING_MCP_TOOLS,
  modules: process.env.KNOTWORKING_MCP_MODULES,
  list: process.env.KNOTWORKING_MCP_LIST,
});
if ("error" in scope) {
  console.error(`knotworking-mcp: ${scope.error}`);
  process.exit(1);
}

const api = createApi({ baseUrl: config.apiUrl, token });
// Resolved once at startup: restart the server after an admin changes this user's module access or
// the actions allowed under Settings -> API access.
const { modules, tokenActions } = await toolListing(api, {
  active: config.activeModules,
  defaultWorkspace: config.defaultWorkspace,
});
const server = createKnotworkingServer({
  getApi: () => api,
  defaultWorkspace: config.defaultWorkspace,
  version: pkg.version,
  modules: narrowModules(modules, scope.modules),
  tokenActions,
  readOnly: scope.readOnly,
  listMode: scope.listMode,
});
await server.connect(new StdioServerTransport());
console.error(
  `knotworking-mcp: ready (API ${config.apiUrl}; modules ${modules.join(", ") || "none"}; token actions ${tokenActions.join(", ") || "none"})`,
);
