import { describe, expect, it } from "vitest";
import {
  claudeCodeCommand,
  expiryText,
  isTokenExpired,
  mcpUrl,
  parseOrderLimit,
  stdioConfig,
  tokenErrorMessage,
  tokenPrefixLabel,
  TOKEN_EXPIRY_OPTIONS,
  DEFAULT_TOKEN_EXPIRY_DAYS,
} from "./api-tokens";

const now = Date.parse("2026-11-09T12:00:00Z");
const TOKEN = "knw_AbC-123_xyz";

describe("isTokenExpired", () => {
  it("is false before the expiry and true at or after it", () => {
    expect(isTokenExpired({ expiresAt: "2026-11-09T12:00:01Z" }, now)).toBe(false);
    expect(isTokenExpired({ expiresAt: "2026-11-09T12:00:00Z" }, now)).toBe(true);
    expect(isTokenExpired({ expiresAt: "2026-01-01T00:00:00Z" }, now)).toBe(true);
  });

  it("treats a missing expiry as never expiring", () => {
    expect(isTokenExpired({ expiresAt: null }, now)).toBe(false);
  });
});

describe("expiryText", () => {
  const relative = (v: string) => `<${v}>`;

  it("labels live, expired and non-expiring tokens", () => {
    expect(expiryText({ expiresAt: "2026-12-01T00:00:00Z" }, relative, now)).toBe(
      "Expires <2026-12-01T00:00:00Z>",
    );
    expect(expiryText({ expiresAt: "2026-11-01T00:00:00Z" }, relative, now)).toBe(
      "Expired <2026-11-01T00:00:00Z>",
    );
    expect(expiryText({ expiresAt: null }, relative, now)).toBe("Never expires");
  });
});

describe("tokenPrefixLabel", () => {
  it("adds an ellipsis", () => {
    expect(tokenPrefixLabel("knw_ku9d")).toBe("knw_ku9d…");
  });
});

describe("expiry options", () => {
  it("includes the default and stays within the API's 1-365 day range", () => {
    expect(TOKEN_EXPIRY_OPTIONS.map((o) => o.days)).toEqual([30, 90, 180, 365]);
    expect(TOKEN_EXPIRY_OPTIONS.some((o) => o.days === DEFAULT_TOKEN_EXPIRY_DAYS)).toBe(true);
  });
});

describe("mcpUrl", () => {
  it("appends /mcp to the origin, ignoring trailing slashes", () => {
    expect(mcpUrl("https://knot.example.com")).toBe("https://knot.example.com/mcp");
    expect(mcpUrl("http://localhost:3000/")).toBe("http://localhost:3000/mcp");
  });
});

describe("claudeCodeCommand", () => {
  it("builds the claude mcp add command with the bearer header", () => {
    expect(claudeCodeCommand("https://knot.example.com", TOKEN)).toBe(
      `claude mcp add --transport http knotworking https://knot.example.com/mcp --header "Authorization: Bearer ${TOKEN}"`,
    );
  });

  it("escapes characters that are special inside shell double quotes", () => {
    expect(claudeCodeCommand("https://x.test", 'a"b$c`d\\e')).toContain(
      '"Authorization: Bearer a\\"b\\$c\\`d\\\\e"',
    );
  });
});

describe("stdioConfig", () => {
  it("emits valid JSON pointing at the web app's /api proxy", () => {
    const config = JSON.parse(stdioConfig("https://knot.example.com/", TOKEN, { workspaceSlug: "acme" }));
    expect(config.mcpServers.knotworking).toEqual({
      command: "node",
      args: ["/absolute/path/to/knotworking/apps/mcp/dist/stdio.js"],
      env: {
        KNOTWORKING_API_URL: "https://knot.example.com/api",
        KNOTWORKING_API_TOKEN: TOKEN,
        KNOTWORKING_DEFAULT_WORKSPACE: "acme",
      },
    });
  });

  it("omits the default workspace when none is given and honours a custom path", () => {
    const config = JSON.parse(stdioConfig("http://localhost:3000", TOKEN, { distPath: "/opt/mcp/stdio.js" }));
    expect(config.mcpServers.knotworking.args).toEqual(["/opt/mcp/stdio.js"]);
    expect(config.mcpServers.knotworking.env).not.toHaveProperty("KNOTWORKING_DEFAULT_WORKSPACE");
  });
});

describe("tokenErrorMessage", () => {
  const apiError = (code: string, message = "server text") => Object.assign(new Error(message), { code });

  it("explains the active-token limit", () => {
    expect(tokenErrorMessage(apiError("too_many_tokens"))).toMatch(/25 active tokens.*Revoke one/);
  });

  it("maps rate limiting and ended sessions", () => {
    expect(tokenErrorMessage(apiError("rate_limited"))).toMatch(/Too many requests/);
    expect(tokenErrorMessage(apiError("session_required"))).toMatch(/Sign in again/);
    expect(tokenErrorMessage(apiError("unauthenticated"))).toMatch(/Sign in again/);
  });

  it("passes through the API's message for other API errors", () => {
    expect(tokenErrorMessage(apiError("invalid_input", "Name is required"))).toBe("Name is required");
  });

  it("reports an unreachable server for network failures", () => {
    expect(tokenErrorMessage(new TypeError("Failed to fetch"))).toMatch(/Couldn't reach the server/);
  });

  it("falls back to a generic message", () => {
    expect(tokenErrorMessage(undefined)).toMatch(/Something went wrong/);
    expect(tokenErrorMessage("boom")).toMatch(/Something went wrong/);
  });
});

describe("parseOrderLimit", () => {
  it("reads a blank field as no limit and an amount to two places", () => {
    expect(parseOrderLimit("")).toBeNull();
    expect(parseOrderLimit("  ")).toBeNull();
    expect(parseOrderLimit("500")).toBe(500);
    expect(parseOrderLimit("1,250.505")).toBe(1250.51);
  });

  it("flags text that is not an amount, so it is never sent as 'no limit'", () => {
    expect(parseOrderLimit("lots")).toBeNaN();
  });
});
