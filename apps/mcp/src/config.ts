import { parseActiveModules, type ModuleId } from "@knotworking/core";
import { localhostAllowedHostnames } from "@modelcontextprotocol/server";

export interface McpConfig {
  /** Base URL of the Knotworking API (no trailing slash). */
  apiUrl: string;
  /** HTTP mode: listen address and port. */
  host: string;
  port: number;
  /** HTTP mode: hostnames (no port) accepted in the `Host` and `Origin` headers. */
  allowedHosts: string[];
  /** Workspace slug used when a tool call omits `workspace`. */
  defaultWorkspace: string | undefined;
  /** HTTP mode: largest accepted request body, in bytes. */
  maxBodyBytes: number;
  /** HTTP mode: most JSON-RPC messages accepted in one batched request. */
  maxBatch: number;
  /** HTTP mode: tool calls allowed per token per minute (token bucket). 0 disables the limit. */
  rateLimitPerMinute: number;
  /** Modules switched on in this environment (`KNOTWORKING_MODULES`, the API's setting). */
  activeModules: ModuleId[];
}

/** A whole-number env var; unset or empty gives `fallback`, anything invalid fails at startup. */
function intEnv(name: string, value: string | undefined, fallback: number, min: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min)
    throw new Error(`Invalid ${name}: ${value} (whole number, at least ${min})`);
  return n;
}

const hostnameOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

/**
 * Reads configuration from the environment (see .env.example).
 *
 * Deliberately not `PORT` / `API_URL`: those belong to the API and the web app and are shared through
 * the repo's root `.env`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const port = Number(env.MCP_PORT || 4100);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`Invalid MCP_PORT: ${env.MCP_PORT}`);

  // Explicit list wins. Otherwise: localhost, plus the hostnames people already use for the web app
  // (APP_URL and TRUSTED_ORIGINS) when the compose file passes them through.
  const explicit = list(env.MCP_ALLOWED_HOSTS);
  const derived = [env.APP_URL, ...(env.TRUSTED_ORIGINS ?? "").split(",")]
    .map((u) => (u ? hostnameOf(u.trim()) : undefined))
    .filter((h): h is string => Boolean(h));
  // The address the API itself reaches this server on (the assistant's tools, `MCP_INTERNAL_URL`,
  // e.g. http://mcp:4100/mcp in compose) is accepted even when the list above is set explicitly.
  const internal = env.MCP_INTERNAL_URL ? hostnameOf(env.MCP_INTERNAL_URL.trim()) : undefined;
  const allowedHosts = [
    ...new Set([
      ...(explicit.length ? explicit : [...localhostAllowedHostnames(), ...derived]),
      ...(internal ? [internal] : []),
    ]),
  ];

  return {
    apiUrl: (env.KNOTWORKING_API_URL || "http://127.0.0.1:4000").replace(/\/+$/, ""),
    host: env.MCP_HOST || "127.0.0.1",
    port,
    allowedHosts,
    defaultWorkspace: env.KNOTWORKING_DEFAULT_WORKSPACE?.trim() || undefined,
    maxBodyBytes: Math.max(1024, Number(env.MCP_MAX_BODY_BYTES || 1_000_000)),
    maxBatch: intEnv("MCP_MAX_BATCH", env.MCP_MAX_BATCH, 10, 1),
    rateLimitPerMinute: intEnv("MCP_RATE_LIMIT_PER_MINUTE", env.MCP_RATE_LIMIT_PER_MINUTE, 120, 0),
    activeModules: parseActiveModules(env.KNOTWORKING_MODULES, (message) => console.warn(message)),
  };
}
