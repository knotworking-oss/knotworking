import * as tables from "@knotworking/db/schema";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

/**
 * Every table in the Drizzle schema by its SQL name, with its SQL column names. The BI compiler
 * only ever names tables and columns found here, and `bi-catalogue.test.ts` checks that every
 * catalogue reference resolves.
 */
export interface RegisteredTable {
  name: string;
  columns: ReadonlySet<string>;
  hasWorkspaceId: boolean;
  hasDeletedAt: boolean;
}

const registry = new Map<string, RegisteredTable>();
for (const value of Object.values(tables)) {
  if (!is(value, PgTable)) continue;
  const config = getTableConfig(value);
  const columns = new Set(config.columns.map((c) => c.name));
  registry.set(config.name, {
    name: config.name,
    columns,
    hasWorkspaceId: columns.has("workspace_id"),
    hasDeletedAt: columns.has("deleted_at"),
  });
}

export const registeredTable = (name: string): RegisteredTable | undefined => registry.get(name);

/** The table, or an error: the catalogue must only name real tables (a test keeps it so). */
export function requireTable(name: string): RegisteredTable {
  const table = registry.get(name);
  if (!table) throw new Error(`BI catalogue names unknown table "${name}"`);
  return table;
}
