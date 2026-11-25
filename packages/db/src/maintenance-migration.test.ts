import { readFileSync } from "node:fs";
import { newId } from "@knotworking/core";
import { sql, type SQL } from "drizzle-orm";
import { expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder } from "./migrate";

const migration = "0098_maintenance";

it("carries forward Site access and reminders while retaining maintenance history", async () => {
  const handle = createDb("memory://");
  const run = async (query: SQL) =>
    ((await handle.db.execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows;
  const apply = async (tag: string) => {
    const text = readFileSync(`${migrationsFolder}/${tag}.sql`, "utf8");
    await handle.db.transaction(async (tx) => {
      for (const statement of text.split("--> statement-breakpoint")) {
        if (statement.trim()) await tx.execute(sql.raw(statement));
      }
    });
  };
  try {
    const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8")) as {
      entries: { tag: string }[];
    };
    for (const { tag } of journal.entries) {
      if (tag === migration) break;
      await apply(tag);
    }
    const workspace = newId();
    const other = newId();
    const user = newId();
    const asset = newId();
    const task = newId();
    const record = newId();
    const token = newId();
    await run(sql`insert into users (id, email, name) values (${user}, 'engineer@example.test', 'Engineer')`);
    await run(sql`insert into workspaces (id, slug, name, enabled_modules) values
      (${workspace}, 'factory', 'Factory', ARRAY['assets', 'site']),
      (${other}, 'office', 'Office', ARRAY['docs'])`);
    await run(sql`insert into member_module_access (id, workspace_id, user_id, module_id, level)
      values (${newId()}, ${workspace}, ${user}, 'site', 'write')`);
    await run(sql`insert into api_tokens (id, user_id, name, token_hash, prefix, scope, modules)
      values (${token}, ${user}, 'Agent', 'test-hash', 'knw_a', 'write', '["assets","site"]')`);
    await run(
      sql`insert into assets (id, workspace_id, kind, name) values (${asset}, ${workspace}, 'equipment', 'Lathe')`,
    );
    await run(sql`insert into site_maintenance_tasks (id, workspace_id, asset_id, title, frequency_every, frequency_unit)
      values (${task}, ${workspace}, ${asset}, 'Check drive belt', 1, 'month')`);
    await run(sql`insert into site_maintenance_records (id, workspace_id, task_id, asset_id, completed_at, next_due_on)
      values (${record}, ${workspace}, ${task}, ${asset}, now(), current_date + 30)`);
    const key = `site:maintenance:${task}:2026-12-01`;
    await run(sql`insert into notifications (id, workspace_id, user_id, type, module, data, dedupe_key)
      values (${newId()}, ${workspace}, ${user}, 'maintenance_due', 'site', '{}', ${key})`);
    await run(sql`insert into notification_sweeps (workspace_id, module) values (${workspace}, 'site')`);

    await apply(migration);

    expect(await run(sql`select module_id, level from member_module_access order by module_id`)).toEqual([
      { module_id: "maintenance", level: "write" },
      { module_id: "site", level: "write" },
    ]);
    expect(await run(sql`select enabled_modules from workspaces order by slug`)).toEqual([
      { enabled_modules: ["assets", "site", "maintenance"] },
      { enabled_modules: ["docs"] },
    ]);
    expect(await run(sql`select modules from api_tokens where id = ${token}`)).toEqual([
      { modules: ["assets", "site", "maintenance"] },
    ]);
    expect(await run(sql`select module, dedupe_key from notifications`)).toEqual([
      { module: "maintenance", dedupe_key: key },
    ]);
    expect(await run(sql`select module from notification_sweeps order by module`)).toEqual([
      { module: "maintenance" },
      { module: "site" },
    ]);
    expect(await run(sql`select id, task_id, asset_id from site_maintenance_records`)).toEqual([
      { id: record, task_id: task, asset_id: asset },
    ]);
  } finally {
    await handle.close();
  }
}, 120_000);
