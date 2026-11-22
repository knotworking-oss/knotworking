import { createMigrationDb, migrateDb } from "../migrate";

const handle = createMigrationDb();
console.log(`→ migrating (${handle.driver})…`);
await migrateDb(handle);
await handle.close();
console.log("✓ migrations applied");
