/** Pure helpers for the personal API token settings page (no DOM or Node APIs, so they are easy to test). */

export const TOKEN_EXPIRY_OPTIONS = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "180 days" },
  { days: 365, label: "1 year" },
] as const;

export const DEFAULT_TOKEN_EXPIRY_DAYS = 90;

/** The API refuses to create more than this many active (not revoked, not expired) tokens per user. */
export const MAX_ACTIVE_TOKENS = 25;

export type TokenScope = "read" | "write";

export interface TokenLike {
  expiresAt: string | null;
}

/** Whether a token's expiry has passed (a token without an expiry never expires). */
export function isTokenExpired(token: TokenLike, now = Date.now()) {
  return token.expiresAt !== null && new Date(token.expiresAt).getTime() <= now;
}

/** Display form of the stored prefix: `knw_ku9d…`. */
export function tokenPrefixLabel(prefix: string) {
  return `${prefix}…`;
}

/** Expiry text for a list row: "Expired 3 days ago", "Expires in 12 days" or "Never expires". */
export function expiryText(token: TokenLike, relative: (value: string) => string, now = Date.now()): string {
  if (token.expiresAt === null) return "Never expires";
  const when = relative(token.expiresAt);
  return isTokenExpired(token, now) ? `Expired ${when}` : `Expires ${when}`;
}

/** Quote a value for a POSIX shell inside double quotes. Tokens and origins rarely need it. */
function dq(value: string) {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** The URL MCP clients connect to when the app is served behind the compose reverse proxy. */
export function mcpUrl(origin: string) {
  return `${origin.replace(/\/+$/, "")}/mcp`;
}

/** `claude mcp add` command for the Streamable HTTP transport. */
export function claudeCodeCommand(origin: string, token: string) {
  return `claude mcp add --transport http knotworking ${mcpUrl(origin)} --header ${dq(`Authorization: Bearer ${token}`)}`;
}

/**
 * `mcpServers` entry for clients that launch the stdio server as a local process (Claude Desktop).
 * The API URL goes through the web app's `/api` proxy, which works for self-hosted servers whose
 * API isn't reachable directly. `distPath` is a placeholder the user must replace.
 */
export function stdioConfig(
  origin: string,
  token: string,
  options: { workspaceSlug?: string; distPath?: string } = {},
) {
  const env: Record<string, string> = {
    KNOTWORKING_API_URL: `${origin.replace(/\/+$/, "")}/api`,
    KNOTWORKING_API_TOKEN: token,
  };
  if (options.workspaceSlug) env.KNOTWORKING_DEFAULT_WORKSPACE = options.workspaceSlug;
  return JSON.stringify(
    {
      mcpServers: {
        knotworking: {
          command: "node",
          args: [options.distPath ?? "/absolute/path/to/knotworking/apps/mcp/dist/stdio.js"],
          env,
        },
      },
    },
    null,
    2,
  );
}

/** User-facing text for a failed token request. Errors carry the API's `code` (see `ApiError`). */
/**
 * The order limit field: blank is no limit (`null`); otherwise a positive amount with at most two
 * places (the API refuses anything else, so a typo shows as an error rather than a silent change).
 */
export const ORDER_LIMIT_HELP =
  "Enter the largest order as an amount such as 500 or 500.50, or leave it blank for no limit.";

export function parseOrderLimit(text: string): number | null {
  const trimmed = text.trim().replace(/,/g, "");
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : Number.NaN;
}

export function tokenErrorMessage(err: unknown): string {
  const code = err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
  switch (code) {
    case "too_many_tokens":
      return `You already have ${MAX_ACTIVE_TOKENS} active tokens. Revoke one you no longer use, then try again.`;
    case "rate_limited":
      return "Too many requests. Wait a moment and try again.";
    case "session_required":
    case "unauthenticated":
      return "Your session has ended. Sign in again to manage tokens.";
  }
  if (err instanceof Error) {
    // `fetch` rejects with a TypeError when the server can't be reached.
    if (err instanceof TypeError) return "Couldn't reach the server. Check your connection and try again.";
    if (code) return err.message;
  }
  return "Something went wrong. Please try again.";
}
