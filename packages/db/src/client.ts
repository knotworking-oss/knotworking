import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as relations from "./relations";
import * as tables from "./schema";

export const schema = { ...tables, ...relations };
export type Schema = typeof schema;

/** Driver-agnostic database handle (works for both Postgres and PGlite). */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Anything you can run queries against: the db or an open transaction. */
export type Executor = Database | Transaction;

export interface DbHandle {
  db: Database;
  driver: "postgres" | "pglite";
  close: () => Promise<void>;
}

/**
 * Connection targets (`DATABASE_URL`):
 *   postgres://… / postgresql://…  → Postgres via postgres.js — local Docker, or a free hosted
 *                                    Postgres such as Neon or Supabase (see docs/database.md)
 *   pglite://<path>                → embedded PGlite persisted to <path>
 *   memory://                      → in-memory PGlite (tests)
 *   (unset)                        → embedded PGlite in <repo>/.data/pglite (zero-setup dev)
 *
 * PGlite is real Postgres compiled to WASM, so schema, SQL and migrations are
 * identical across environments.
 */
export function createDb(
  url: string | undefined = process.env.DATABASE_URL,
  options: {
    /** Decide pooler mode from the URL alone, ignoring DATABASE_POOLED (direct migration URLs). */
    ignorePooledOverride?: boolean;
  } = {},
): DbHandle {
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const client = postgres(sanitizePostgresUrl(url), {
      max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
      // Transaction-mode poolers (Neon "-pooler" hosts, Supabase port 6543) don't support
      // prepared statements. TLS comes from `?sslmode=require` in the URL.
      prepare: !isTransactionPooler(url, options.ignorePooledOverride ? "" : process.env.DATABASE_POOLED),
      // Postgres truncates identifiers over 63 characters (some generated foreign-key names) and
      // says so with a NOTICE for each; that flooded the log on every first run. Show the rest.
      onnotice: (notice) => {
        if (notice.code !== "42622") console.warn(`postgres: ${notice.severity} ${notice.message}`);
      },
    });
    return {
      db: drizzlePostgres({ client, schema }) as unknown as Database,
      driver: "postgres",
      close: () => client.end(),
    };
  }

  let dataDir: string | undefined;
  if (!url) dataDir = defaultPgliteDir();
  else if (url.startsWith("pglite://")) dataDir = resolve(url.slice("pglite://".length));
  else if (url !== "memory://") throw new Error(`Unsupported DATABASE_URL: ${url}`);

  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  return {
    db: drizzlePglite({ client, schema }) as unknown as Database,
    driver: "pglite",
    close: () => client.close(),
  };
}

/**
 * Connection options that only libpq understands. postgres.js forwards every unknown query
 * parameter to the server as a startup parameter, and Postgres rejects them ("unrecognized
 * configuration parameter"). Neon's default connection string ends in `channel_binding=require`.
 * `sslmode`, `sslrootcert=system`, `target_session_attrs`, `connect_timeout` and
 * `application_name` are understood by postgres.js and kept.
 */
const LIBPQ_ONLY_PARAMS = new Set([
  "channel_binding",
  "gssencmode",
  "gsslib",
  "krbsrvname",
  "keepalives",
  "keepalives_idle",
  "keepalives_interval",
  "keepalives_count",
  "tcp_user_timeout",
  "passfile",
  "requirepeer",
  "requiressl",
  "service",
  "sslcert",
  "sslkey",
  "sslpassword",
  "sslcrl",
  "sslcrldir",
  "sslcompression",
  "sslsni",
  "ssl_min_protocol_version",
  "ssl_max_protocol_version",
]);

/**
 * Drops libpq-only query parameters from a Postgres URL. Works on the string so passwords,
 * multi-host lists and encoding are left exactly as written.
 */
export function sanitizePostgresUrl(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const hash = url.indexOf("#", q);
  const query = url.slice(q + 1, hash === -1 ? undefined : hash);
  const kept = query.split("&").filter((pair) => {
    if (!pair) return false;
    const raw = pair.split("=")[0]!;
    let key = raw;
    try {
      key = decodeURIComponent(raw);
    } catch {
      // keep the raw key
    }
    return !LIBPQ_ONLY_PARAMS.has(key.toLowerCase());
  });
  return url.slice(0, q) + (kept.length ? `?${kept.join("&")}` : "") + (hash === -1 ? "" : url.slice(hash));
}

/**
 * URL used for migrations: `MIGRATE_DATABASE_URL` (a direct, non-pooled connection — transaction
 * poolers can break DDL) if set, otherwise `DATABASE_URL`.
 */
export function migrationDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.MIGRATE_DATABASE_URL || env.DATABASE_URL || undefined;
}

export function isTransactionPooler(
  url: string,
  forced: string | undefined = process.env.DATABASE_POOLED,
): boolean {
  if (forced) return forced === "true";
  try {
    const { hostname, port } = new URL(url);
    return hostname.includes("-pooler.") || (hostname.endsWith("pooler.supabase.com") && port === "6543");
  } catch {
    return false;
  }
}

/** `<repo root>/.data/pglite`, found by walking up to pnpm-workspace.yaml. */
export function defaultPgliteDir(): string {
  let dir = process.cwd();
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) return resolve(".data/pglite");
    dir = parent;
  }
  return join(dir, ".data", "pglite");
}
