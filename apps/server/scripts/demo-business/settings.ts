import { randomBytes } from "node:crypto";

/** Validate the target before the loader opens a session or writes demo data. */
export function demoSettings(env: NodeJS.ProcessEnv) {
  const url = new URL(env.KNW_URL ?? "http://localhost:3000");
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "KNW_URL must be an HTTP or HTTPS origin without credentials, a path, or query parameters.",
    );
  }

  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!local && (env.KNW_ALLOW_REMOTE !== "1" || url.protocol !== "https:")) {
    throw new Error(
      "Remote demo targets require HTTPS and KNW_ALLOW_REMOTE=1. Use an isolated demo instance.",
    );
  }

  const savedPassword = env.KNW_DEMO_PASSWORD;
  if (savedPassword !== undefined && !/^[A-Za-z0-9_-]{32}$/.test(savedPassword)) {
    throw new Error("KNW_DEMO_PASSWORD must be the 32-character password from the first run.");
  }
  return {
    base: url.origin,
    demoPassword: savedPassword ?? randomBytes(24).toString("base64url"),
    generatedPassword: savedPassword === undefined,
  };
}
