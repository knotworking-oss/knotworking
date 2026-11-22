import { defineConfig } from "drizzle-kit";

// `generate` only diffs the TypeScript schema against previous migrations — it
// never connects to a database. Migrations are applied by `src/scripts/migrate.ts`,
// which works for both PGlite (local dev) and Postgres.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
