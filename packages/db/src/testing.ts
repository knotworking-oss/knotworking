import { createDb, type DbHandle } from "./client";
import { migrateDb } from "./migrate";
import { seed } from "./seed";

/** Fresh, migrated (and optionally seeded) in-memory database for tests. */
export async function createTestDb(options: { seed?: boolean } = {}): Promise<DbHandle> {
  const handle = createDb("memory://");
  await migrateDb(handle);
  if (options.seed) await seed(handle.db);
  return handle;
}
