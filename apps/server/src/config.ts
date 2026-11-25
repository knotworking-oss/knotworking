import { parseActiveModules } from "@knotworking/core";
import { DEFAULT_UPLOAD_MAX_BYTES } from "@knotworking/core";
import { DEFAULT_TOKEN_READS_PER_MINUTE, DEFAULT_TOKEN_WRITES_PER_MINUTE } from "./middleware/rate-limit";
import { defaultUploadDir, type StorageConfig } from "./storage";

/** It signs sessions and encrypts stored OAuth tokens, so a short one is brute-forceable. */
const MIN_SECRET_LENGTH = 32;
const DEVELOPMENT_SECRET = "knotworking-development-secret-do-not-use-in-production";

/**
 * A non-negative integer setting (`0` usually means "off"). Unset or blank gives the default; a
 * typo is an error rather than a silently different limit.
 */
function limitSetting(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a whole number, 0 or more (0 turns the limit off); got "${raw}"`);
  return value;
}

/** Reads server configuration from the environment (see .env.example). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === "production";
  const appUrl = (env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  let secret = env.BETTER_AUTH_SECRET;
  if (!secret) {
    if (production)
      throw new Error(
        "BETTER_AUTH_SECRET is required in production (generate one with `openssl rand -base64 32`)",
      );
    secret = DEVELOPMENT_SECRET;
    console.warn("⚠ BETTER_AUTH_SECRET not set — using an insecure development secret");
  } else if (production && secret.length < MIN_SECRET_LENGTH)
    throw new Error(
      `BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production (generate one with \`openssl rand -base64 32\`)`,
    );
  if (production && secret === DEVELOPMENT_SECRET)
    throw new Error("BETTER_AUTH_SECRET must not be the public development secret in production");
  const pair = (id?: string, secretValue?: string) =>
    id && secretValue ? { clientId: id, clientSecret: secretValue } : undefined;
  const activeModules = parseActiveModules(env.KNOTWORKING_MODULES);
  const xero = pair(env.XERO_CLIENT_ID?.trim(), env.XERO_CLIENT_SECRET?.trim());
  if (
    xero &&
    activeModules.includes("accounting") &&
    (secret === DEVELOPMENT_SECRET || secret.length < MIN_SECRET_LENGTH)
  )
    throw new Error("Xero requires a private BETTER_AUTH_SECRET of at least 32 characters");
  return {
    xero,
    port: Number(env.PORT ?? 4000),
    hostname: env.API_HOST?.trim() || "127.0.0.1",
    appUrl,
    /** Extra origins allowed to sign in (e.g. a second hostname for the same server). */
    trustedOrigins: (env.TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim().replace(/\/$/, ""))
      .filter(Boolean),
    secret,
    google: pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    github: pair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
    microsoft:
      env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
        ? {
            clientId: env.MICROSOFT_CLIENT_ID,
            clientSecret: env.MICROSOFT_CLIENT_SECRET,
            // "common" = work/school and personal accounts; use your tenant ID to restrict.
            tenantId: env.MICROSOFT_TENANT_ID || "common",
          }
        : undefined,
    /**
     * Where this process reaches the MCP server, for the assistant's tools (docs/assistant.md). In
     * compose it is the `mcp` service; its host must be in the MCP server's `MCP_ALLOWED_HOSTS`.
     */
    assistantMcpUrl: env.MCP_INTERNAL_URL?.trim() || `http://127.0.0.1:${env.MCP_PORT ?? 4100}/mcp`,
    /** Requests per minute per personal API token, per API process (`0` = off). Sessions are not limited. */
    apiTokenRateLimit: {
      reads: limitSetting(env, "API_TOKEN_READ_LIMIT_PER_MINUTE", DEFAULT_TOKEN_READS_PER_MINUTE),
      writes: limitSetting(env, "API_TOKEN_WRITE_LIMIT_PER_MINUTE", DEFAULT_TOKEN_WRITES_PER_MINUTE),
    },
    /** How often connected calendars are polled for changes. */
    calendarSyncIntervalMs: Math.max(60, Number(env.CALENDAR_SYNC_INTERVAL_SECONDS ?? 300)) * 1000,
    /**
     * How often the due-date notification sweep runs in this process (`0` turns it off, e.g. on all
     * but one of several API instances, though running it on each is safe). Default 15 minutes.
     */
    notificationSweepIntervalMs: limitSetting(env, "NOTIFICATION_SWEEP_INTERVAL_SECONDS", 900) * 1000,
    /**
     * How often queued accounting postings are sent through installed adapters (`0` turns it off).
     * Only runs when the accounting module is on and an adapter is installed. Default 5 minutes.
     */
    accountingDispatchIntervalMs: limitSetting(env, "ACCOUNTING_DISPATCH_INTERVAL_SECONDS", 300) * 1000,
    uploads: uploadConfig(env),
    /** Modules switched on in this environment. Throws on an unknown id or a missing dependency. */
    activeModules,
  };
}

/**
 * Attachment storage: local disk by default (`UPLOAD_DIR`, a volume in compose), or an
 * S3-compatible bucket with `UPLOAD_STORAGE=s3`. `UPLOAD_MAX_BYTES` caps one upload.
 */
export function uploadConfig(env: NodeJS.ProcessEnv = process.env): {
  maxBytes: number;
  storage: StorageConfig;
} {
  const maxBytes = limitSetting(env, "UPLOAD_MAX_BYTES", DEFAULT_UPLOAD_MAX_BYTES);
  if (maxBytes < 1) throw new Error("UPLOAD_MAX_BYTES must be at least 1");
  // Uploads are held in memory for S3 (and S3 single PUTs stop at 5 GB); keep it sane.
  if (maxBytes > 1024 * 1024 * 1024) throw new Error("UPLOAD_MAX_BYTES can be at most 1 GiB (1073741824)");
  const driver = (env.UPLOAD_STORAGE?.trim() || "local").toLowerCase();
  if (driver === "local") {
    return { maxBytes, storage: { kind: "local", dir: env.UPLOAD_DIR?.trim() || defaultUploadDir() } };
  }
  if (driver !== "s3") throw new Error(`UPLOAD_STORAGE must be "local" or "s3"; got "${driver}"`);
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required when UPLOAD_STORAGE=s3`);
    return value;
  };
  const endpoint = env.S3_ENDPOINT?.trim() || undefined;
  if (endpoint && !/^https?:\/\//.test(endpoint))
    throw new Error("S3_ENDPOINT must start with http:// or https://");
  return {
    maxBytes,
    storage: {
      kind: "s3",
      bucket: required("S3_BUCKET"),
      region: env.S3_REGION?.trim() || "us-east-1",
      endpoint,
      accessKeyId: required("S3_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
      forcePathStyle: /^(1|true|yes)$/i.test(env.S3_FORCE_PATH_STYLE?.trim() ?? ""),
      prefix: env.S3_PREFIX?.trim() || undefined,
    },
  };
}
