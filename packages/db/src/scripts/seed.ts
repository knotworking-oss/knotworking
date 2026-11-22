import { createDb } from "../client";
import { seed } from "../seed";
import { seedRefusal } from "../seed-guard";

const refusal = seedRefusal();
if (refusal) {
  console.error(`✗ ${refusal}`);
  process.exit(1);
}

const handle = createDb();
const result = await seed(handle.db);
await handle.close();
console.log(result.skipped ? "• already seeded — skipping" : `✓ seeded workspace "${result.workspaceSlug}"`);
