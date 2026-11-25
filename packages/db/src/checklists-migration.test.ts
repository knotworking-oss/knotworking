import { readFileSync } from "node:fs";
import { newId } from "@knotworking/core";
import { sql, type SQL } from "drizzle-orm";
import { expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder } from "./migrate";

const migration = "0099_checklists";

it("preserves Site checklist history and grants access to the shared engine", async () => {
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
    const user = newId();
    const template = newId();
    const item = newId();
    const check = newId();
    const token = newId();
    await run(sql`insert into users (id, name, email) values (${user}, 'Operator', 'operator@example.test')`);
    await run(sql`insert into workspaces (id, slug, name, enabled_modules)
      values (${workspace}, 'factory', 'Factory', ARRAY['assets','site'])`);
    await run(sql`insert into member_module_access (id, workspace_id, user_id, module_id, level)
      values (${newId()}, ${workspace}, ${user}, 'site', 'write')`);
    await run(sql`insert into api_tokens (id, user_id, name, token_hash, prefix, scope, modules)
      values (${token}, ${user}, 'Agent', 'test-hash', 'knw_a', 'write', '["assets","site"]')`);
    await run(sql`insert into site_checklist_templates (id, workspace_id, name, kind)
      values (${template}, ${workspace}, 'Pre-start', 'prestart')`);
    await run(sql`insert into site_checklist_items (id, workspace_id, template_id, prompt)
      values (${item}, ${workspace}, ${template}, 'Inspect guard')`);
    await run(sql`insert into site_checklist_checks
      (id, workspace_id, template_id, template_name, kind, performed_at, outcome, sign_off_status)
      values (${check}, ${workspace}, ${template}, 'Pre-start', 'prestart', now(), 'passed', 'approved')`);
    await run(sql`insert into site_checklist_check_items (id, workspace_id, check_id, item_id, prompt, result)
      values (${newId()}, ${workspace}, ${check}, ${item}, 'Inspect guard', 'pass')`);

    await apply(migration);

    expect(await run(sql`select module_id, level from member_module_access order by module_id`)).toEqual([
      { module_id: "checklists", level: "write" },
      { module_id: "site", level: "write" },
    ]);
    expect(await run(sql`select enabled_modules from workspaces where id = ${workspace}`)).toEqual([
      { enabled_modules: ["assets", "site", "checklists"] },
    ]);
    expect(await run(sql`select modules from api_tokens where id = ${token}`)).toEqual([
      { modules: ["assets", "site", "checklists"] },
    ]);
    expect(await run(sql`select id, template_id, kind, sign_off_status from site_checklist_checks`)).toEqual([
      { id: check, template_id: template, kind: "prestart", sign_off_status: "approved" },
    ]);
    expect(await run(sql`select item_id, prompt, result from site_checklist_check_items`)).toEqual([
      { item_id: item, prompt: "Inspect guard", result: "pass" },
    ]);
    expect(await run(sql`select id from checklist_actions`)).toEqual([]);
  } finally {
    await handle.close();
  }
}, 120_000);
