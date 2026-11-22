import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDb, migrationDatabaseUrl, type DbHandle } from "./client";

/** SQL migrations folder. Override with MIGRATIONS_DIR when running from a bundle (Docker). */
export const migrationsFolder =
  process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Opens the connection used for migrations: `MIGRATE_DATABASE_URL` (a direct, non-pooled
 * connection) when set, otherwise `DATABASE_URL`.
 */
export function createMigrationDb(env: Record<string, string | undefined> = process.env): DbHandle {
  return createDb(migrationDatabaseUrl(env), { ignorePooledOverride: Boolean(env.MIGRATE_DATABASE_URL) });
}

/** Apply pending SQL migrations from ./migrations with the right driver. */
export async function migrateDb(handle: DbHandle): Promise<void> {
  if (handle.driver === "pglite") {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(handle.db as never, { migrationsFolder });
  } else {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(handle.db as never, { migrationsFolder });
    await analyzeNeverAnalyzed(handle);
  }
}

/**
 * Gives the planner statistics for tables that have never been analyzed. Autovacuum
 * analyzes a table only after about 50 rows change, so a small master table (items, suppliers, locations)
 * never gets statistics, and the planner then assumes it has one row and picks plans that re-scan the big
 * tables once per row. Cheap (small tables) and idempotent; a failure is logged and never stops startup.
 */
export async function analyzeNeverAnalyzed(handle: DbHandle): Promise<string[]> {
  try {
    const rows = (await handle.db.execute(sql`
      select relname from pg_stat_user_tables
      where schemaname = current_schema() and last_analyze is null and last_autoanalyze is null`)) as unknown as {
      relname: string;
    }[];
    const names = rows.map((r) => r.relname);
    for (const name of names) await handle.db.execute(sql.raw(`analyze "${name.replaceAll('"', '""')}"`));
    return names;
  } catch (error) {
    console.warn("Could not analyze tables after migrating:", error);
    return [];
  }
}
