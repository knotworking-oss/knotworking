import { readFileSync } from "node:fs";
import { newId } from "@knotworking/core";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder } from "./migrate";
import { accountingConnections } from "./schema";
it("backfills existing outbox destinations without inventing a human author, preserving tenant namespaces", async () => {
  const handle = createDb("memory://");
  const tag = "0073_accounting_connections";
  const apply = async (name: string) => {
    for (const statement of readFileSync(`${migrationsFolder}/${name}.sql`, "utf8").split(
      "--> statement-breakpoint",
    ))
      if (statement.trim()) await handle.db.execute(sql.raw(statement));
  };
  try {
    const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8"));
    for (const entry of journal.entries) {
      if (entry.tag === tag) break;
      await apply(entry.tag);
    }
    const a = newId(),
      b = newId(),
      connectionId = newId();
    // Raw SQL naming only columns that existed at 0073: the Drizzle schema has later columns
    // (financial_year_start_month) that this older database doesn't have yet.
    await handle.db.execute(
      sql`insert into workspaces (id, name, slug) values (${a}, 'A', 'a'), (${b}, 'B', 'b')`,
    );
    // Raw SQL again: later migrations add posting columns (idempotency_key, allocation) that a
    // Drizzle insert would name.
    for (const [workspaceId, provider] of [
      [a, "xero"],
      [a, "xero"],
      [b, "community_ledger"],
    ])
      await handle.db.execute(
        sql`insert into accounting_postings (id, workspace_id, connection_id, provider, company_id, source_id, kind, payload, payload_hash, state, attempt_id, attempts)
            values (${newId()}, ${workspaceId}, ${connectionId}, ${provider}, 'company', ${newId()}, 'purchase_invoice', '{}'::jsonb, 'legacy', 'unknown', ${newId()}, 1)`,
      );
    await apply(tag);
    const connections = await handle.db.select().from(accountingConnections);
    expect(connections).toHaveLength(2);
    expect(connections.map((c) => c.id)).toEqual([connectionId, connectionId]);
    expect(new Set(connections.map((c) => c.provider))).toEqual(new Set(["xero", "community_ledger"]));
    expect(connections.every((c) => c.createdBy === null && !c.disabled && c.revision === 1)).toBe(true);
    const postings = (
      (await handle.db.execute(sql`select state, attempts from accounting_postings`)) as unknown as {
        rows: { state: string; attempts: number }[];
      }
    ).rows;
    expect(postings).toHaveLength(3);
    expect(postings.every((p) => p.state === "unknown" && p.attempts === 1)).toBe(true);
  } finally {
    await handle.close();
  }
}, 60000);
