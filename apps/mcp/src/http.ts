import { serve } from "@hono/node-server";
import { createMcpApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = createMcpApp({ config });

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`▲ Knotworking MCP server listening on http://${config.host}:${info.port}/mcp`);
  console.log(`  API ${config.apiUrl} · allowed hosts ${config.allowedHosts.join(", ")}`);
  console.log("  clients authenticate with `Authorization: Bearer knw_…` (a Knotworking API token)");
});

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
