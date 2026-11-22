/** Applies pending database migrations (run before starting the API in production). */
import { createMigrationDb, migrateDb, migrationsFolder } from "@knotworking/db";

// Uses MIGRATE_DATABASE_URL (a direct, non-pooled connection) when set, else DATABASE_URL.
const handle = createMigrationDb();
console.log(`→ applying migrations from ${migrationsFolder} (${handle.driver})…`);
await migrateDb(handle);
await handle.close();
console.log("✓ database is up to date");
