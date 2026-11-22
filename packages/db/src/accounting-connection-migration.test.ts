import { readFileSync } from "node:fs";
import { newId } from "@knotworking/core";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder } from "./migrate";
import { accountingConnections, accountingPostings } from "./schema";
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
    const legacy = (workspaceId: string, provider: string) => ({
      workspaceId,
      connectionId,
      provider,
      companyId: "company",
      sourceId: newId(),
      kind: "purchase_invoice",
      payload: {} as any,
      payloadHash: "legacy",
      state: "unknown" as const,
      attemptId: newId(),
      attempts: 1,
    });
    await handle.db
      .insert(accountingPostings)
      .values([legacy(a, "xero"), legacy(a, "xero"), legacy(b, "community_ledger")]);
    await apply(tag);
    const connections = await handle.db.select().from(accountingConnections);
    expect(connections).toHaveLength(2);
    expect(connections.map((c) => c.id)).toEqual([connectionId, connectionId]);
    expect(new Set(connections.map((c) => c.provider))).toEqual(new Set(["xero", "community_ledger"]));
    expect(connections.every((c) => c.createdBy === null && !c.disabled && c.revision === 1)).toBe(true);
    expect(
      (await handle.db.select().from(accountingPostings)).every(
        (p) => p.state === "unknown" && p.attempts === 1,
      ),
    ).toBe(true);
  } finally {
    await handle.close();
  }
}, 60000);
