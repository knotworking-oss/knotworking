import { readFileSync } from "node:fs";
import { newId } from "@knotworking/core";
import { sql as dsql, type SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder } from "./migrate";

const TAG = "0097_assets";

async function apply(handle: ReturnType<typeof createDb>, tag: string) {
  const text = readFileSync(`${migrationsFolder}/${tag}.sql`, "utf8");
  // One transaction per migration, as the migrator runs them (some take table locks).
  await handle.db.execute(dsql.raw("BEGIN"));
  for (const statement of text.split("--> statement-breakpoint")) {
    if (statement.trim()) await handle.db.execute(dsql.raw(statement));
  }
  await handle.db.execute(dsql.raw("COMMIT"));
}

async function dbBefore() {
  const handle = createDb("memory://");
  const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8")) as {
    entries: { tag: string }[];
  };
  for (const { tag } of journal.entries) {
    if (tag === TAG) break;
    await apply(handle, tag);
  }
  return handle;
}

type Row = Record<string, unknown>;

describe("0097 assets migration", () => {
  it("copies both registers into assets with the same ids and re-points every reference", async () => {
    const handle = await dbBefore();
    const run = async (q: SQL) => (await handle.db.execute(q)) as unknown as { rows: Row[] };
    try {
      const [ws, other, ada, bob, cy] = Array.from({ length: 5 }, () => newId()) as [
        string,
        string,
        string,
        string,
        string,
      ];
      await run(dsql`INSERT INTO users (id, email, name) VALUES
        (${ada}, 'ada@example.test', 'Ada'), (${bob}, 'bob@example.test', 'Bob'), (${cy}, 'cy@example.test', 'Cy')`);
      await run(dsql`INSERT INTO workspaces (id, slug, name, enabled_modules) VALUES
        (${ws}, 'acme', 'Acme', ARRAY['tasks','haccp','site']::text[]),
        (${other}, 'globex', 'Globex', ARRAY['tasks']::text[])`);

      // The HACCP register: an area, a probe and a deleted area.
      const [hall, probe, oldArea, mixer, probeTwin, oven, gone] = Array.from({ length: 7 }, () =>
        newId(),
      ) as [string, string, string, string, string, string, string];
      await run(dsql`INSERT INTO haccp_assets
        (id, workspace_id, kind, code, name, location, cleaning_every, cleaning_unit, calibration_every, calibration_unit, calibration_tolerance, measurement_unit, status, deleted_at)
        VALUES
        (${hall}, ${ws}, 'area', 'HALL', 'Packing hall', 'Ground floor', 1, 'day', NULL, NULL, NULL, NULL, 'active', NULL),
        (${probe}, ${ws}, 'equipment', 'PRB-01', 'Probe 1', NULL, NULL, NULL, 1, 'month', 0.5, '°C', 'active', NULL),
        (${oldArea}, ${ws}, 'area', 'OLD', 'Old store', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'archived', now())`);
      // Maintained assets: one plain, one whose code a HACCP asset uses (case-insensitive) and is
      // the probe, one whose code and "-M" suffix are both taken, and a deleted one with a used code.
      await run(dsql`INSERT INTO site_assets
        (id, workspace_id, code, name, location, area_id, calibration_instrument_id, status, deleted_at)
        VALUES
        (${mixer}, ${ws}, 'MX-1', 'Mixer', 'Line 1', ${hall}, NULL, 'active', NULL),
        (${probeTwin}, ${ws}, 'prb-01', 'Probe 1 (maintained)', NULL, NULL, ${probe}, 'active', NULL),
        (${oven}, ${ws}, 'HALL', 'Oven', NULL, ${hall}, NULL, 'archived', NULL),
        (${gone}, ${ws}, 'PRB-01', 'Scrapped probe', NULL, NULL, NULL, 'active', now())`);
      await run(
        dsql`INSERT INTO site_assets (id, workspace_id, code, name) VALUES (${newId()}, ${ws}, 'HALL-M', 'Hall mixer')`,
      );

      // References to both registers.
      const cleaning = newId();
      const calibration = newId();
      const task = newId();
      const glass = newId();
      await run(
        dsql`INSERT INTO haccp_cleaning_records (id, workspace_id, asset_id, cleaned_at) VALUES (${cleaning}, ${ws}, ${hall}, now())`,
      );
      await run(dsql`INSERT INTO haccp_calibration_records
        (id, workspace_id, asset_id, calibrated_at, reference_reading, actual_reading, passed)
        VALUES (${calibration}, ${ws}, ${probe}, now(), 0, 0.2, true)`);
      await run(dsql`INSERT INTO site_maintenance_tasks (id, workspace_id, asset_id, title, frequency_every, frequency_unit)
        VALUES (${task}, ${ws}, ${mixer}, 'Grease', 1, 'month')`);
      await run(dsql`INSERT INTO site_glass_items (id, workspace_id, area_id, kind, description, check_every, check_unit)
        VALUES (${glass}, ${ws}, ${hall}, 'glass', 'Window', 1, 'month')`);

      // Access: Bob has HACCP write and Site read; Cy has only a docs grant; Ada already has Assets.
      await run(dsql`INSERT INTO member_module_access (id, workspace_id, user_id, module_id, level) VALUES
        (${newId()}, ${ws}, ${bob}, 'haccp', 'write'),
        (${newId()}, ${ws}, ${bob}, 'site', 'read'),
        (${newId()}, ${ws}, ${cy}, 'docs', 'write'),
        (${newId()}, ${ws}, ${ada}, 'site', 'manage'),
        (${newId()}, ${ws}, ${ada}, 'assets', 'read')`);
      const [scoped, unscoped, unrelated] = [newId(), newId(), newId()];
      await run(dsql`INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, modules) VALUES
        (${scoped}, ${bob}, 'Sensor', 'h1', 'knw_a', 'write', '["haccp"]'::jsonb),
        (${unscoped}, ${bob}, 'All', 'h2', 'knw_b', 'write', NULL),
        (${unrelated}, ${bob}, 'Docs', 'h3', 'knw_c', 'read', '["docs"]'::jsonb)`);

      await apply(handle, TAG);

      const assets = new Map(
        (
          await run(
            dsql`SELECT id, workspace_id, kind, code, name, parent_area_id, location, status, deleted_at, revision FROM assets`,
          )
        ).rows.map((r) => [r.id as string, r]),
      );
      expect(assets.size).toBe(8);
      expect(assets.get(hall)).toMatchObject({
        kind: "area",
        code: "HALL",
        name: "Packing hall",
        location: "Ground floor",
        status: "active",
        revision: 1,
      });
      expect(assets.get(probe)).toMatchObject({ kind: "equipment", code: "PRB-01" });
      expect(assets.get(oldArea)).toMatchObject({ kind: "area", status: "archived" });
      expect(assets.get(oldArea)!.deleted_at).not.toBeNull();
      expect(assets.get(mixer)).toMatchObject({
        kind: "equipment",
        code: "MX-1",
        parent_area_id: hall,
        location: "Line 1",
      });
      // Collisions with a live HACCP code are renamed deterministically; HACCP keeps its codes.
      expect(assets.get(probeTwin)!.code).toBe("prb-01-M");
      expect(assets.get(oven)).toMatchObject({ code: `HALL-M-${oven.slice(0, 8)}`, status: "archived" });
      // A deleted row keeps its code: only live codes must be unique.
      expect(assets.get(gone)).toMatchObject({ code: "PRB-01" });
      expect(assets.get(gone)!.deleted_at).not.toBeNull();

      // The extension tables keep their rows and their own columns.
      const haccp = (await run(dsql`SELECT * FROM haccp_assets WHERE id = ${probe}`)).rows[0]!;
      expect(haccp).toMatchObject({
        calibration_every: 1,
        calibration_unit: "month",
        measurement_unit: "°C",
      });
      expect(Number(haccp.calibration_tolerance)).toBe(0.5);
      expect(haccp).not.toHaveProperty("name");
      const site = (await run(dsql`SELECT * FROM site_assets WHERE id = ${probeTwin}`)).rows[0]!;
      expect(site).toMatchObject({ calibration_instrument_id: probe });
      expect(site).not.toHaveProperty("code");

      // Every reference joins to the asset of the same id.
      const joined = await run(dsql`
        SELECT 'cleaning' AS what, a.id FROM haccp_cleaning_records r JOIN assets a ON a.id = r.asset_id
        UNION ALL SELECT 'calibration', a.id FROM haccp_calibration_records r JOIN assets a ON a.id = r.asset_id
        UNION ALL SELECT 'task', a.id FROM site_maintenance_tasks r JOIN assets a ON a.id = r.asset_id
        UNION ALL SELECT 'glass', a.id FROM site_glass_items r JOIN assets a ON a.id = r.area_id`);
      expect(Object.fromEntries(joined.rows.map((r) => [r.what, r.id]))).toEqual({
        cleaning: hall,
        calibration: probe,
        task: mixer,
        glass: hall,
      });
      const fks = await run(dsql`
        SELECT conrelid::regclass::text AS tbl, confrelid::regclass::text AS ref FROM pg_constraint
        WHERE contype = 'f' AND confrelid::regclass::text IN ('haccp_assets', 'site_assets')`);
      expect(fks.rows).toEqual([]);
      // New references are checked against assets.
      await expect(
        run(
          dsql`INSERT INTO haccp_cleaning_records (id, workspace_id, asset_id, cleaned_at) VALUES (${newId()}, ${ws}, ${newId()}, now())`,
        ),
      ).rejects.toThrow();
      // Codes are unique among live assets across what were two registers.
      await expect(
        run(
          dsql`INSERT INTO assets (id, workspace_id, kind, code, name) VALUES (${newId()}, ${ws}, 'tool', 'mx-1', 'Clash')`,
        ),
      ).rejects.toThrow();

      // Access: grants in HACCP or Site carry over to Assets at the higher level; explicit ones stay.
      const grants = await run(
        dsql`SELECT user_id, level FROM member_module_access WHERE module_id = 'assets' ORDER BY level`,
      );
      expect(Object.fromEntries(grants.rows.map((r) => [r.user_id, r.level]))).toEqual({
        [bob]: "write",
        [ada]: "read",
      });
      const enabled = await run(dsql`SELECT id, enabled_modules FROM workspaces`);
      expect(Object.fromEntries(enabled.rows.map((r) => [r.id, r.enabled_modules]))).toEqual({
        [ws]: ["tasks", "haccp", "site", "assets"],
        [other]: ["tasks"],
      });
      const tokens = await run(dsql`SELECT id, modules FROM api_tokens`);
      expect(Object.fromEntries(tokens.rows.map((r) => [r.id, r.modules]))).toEqual({
        [scoped]: ["haccp", "assets"],
        [unscoped]: null,
        [unrelated]: ["docs"],
      });
    } finally {
      await handle.close();
    }
  }, 120_000);
});
