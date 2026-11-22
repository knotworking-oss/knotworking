import { rmSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createDb, defaultPgliteDir } from "../client";

const url = process.env.DATABASE_URL;
if (!url || url.startsWith("pglite://")) {
  const dir = url ? url.slice("pglite://".length) : defaultPgliteDir();
  rmSync(dir, { recursive: true, force: true });
  console.log(`✓ removed ${dir}`);
} else {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset a production database");
  const handle = createDb(url);
  await handle.db.execute(sql`drop schema if exists public cascade; create schema public;`);
  await handle.db.execute(sql`drop schema if exists drizzle cascade;`);
  await handle.close();
  console.log("✓ dropped and recreated schema");
}
