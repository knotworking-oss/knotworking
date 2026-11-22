import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config";

const long = "x".repeat(32);

describe("BETTER_AUTH_SECRET", () => {
  it("is required in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/required in production/);
    expect(() => loadConfig({ NODE_ENV: "production", BETTER_AUTH_SECRET: "" })).toThrow(/required/);
  });

  it("must be at least 32 characters in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production", BETTER_AUTH_SECRET: "short-secret" })).toThrow(
      /at least 32 characters/,
    );
    expect(() => loadConfig({ NODE_ENV: "production", BETTER_AUTH_SECRET: "x".repeat(31) })).toThrow(
      /at least 32/,
    );
    expect(loadConfig({ NODE_ENV: "production", BETTER_AUTH_SECRET: long }).secret).toBe(long);
  });

  it("keeps the development fallback and short secrets outside production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadConfig({}).secret).toMatch(/development-secret/);
    warn.mockRestore();
    expect(loadConfig({ BETTER_AUTH_SECRET: "short" }).secret).toBe("short");
  });

  it("rejects the public development secret even though it is long enough", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const developmentSecret = loadConfig({}).secret;
    warn.mockRestore();
    expect(() => loadConfig({ NODE_ENV: "production", BETTER_AUTH_SECRET: developmentSecret })).toThrow(
      /public development secret/,
    );
  });
});

describe("API_HOST", () => {
  it("defaults to loopback and accepts an explicit private-network binding", () => {
    expect(loadConfig({ BETTER_AUTH_SECRET: long }).hostname).toBe("127.0.0.1");
    expect(loadConfig({ BETTER_AUTH_SECRET: long, API_HOST: " 0.0.0.0 " }).hostname).toBe("0.0.0.0");
  });
});
