import { readFileSync } from "node:fs";
import { newId } from "@knotworking/core";
import { sql as dsql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder } from "./migrate";

const TAG = "0037_workspace_time_zone";
const raw = (text: string) => dsql.raw(text);

async function apply(handle: ReturnType<typeof createDb>, tag: string) {
  const text = readFileSync(`${migrationsFolder}/${tag}.sql`, "utf8");
  for (const statement of text.split("--> statement-breakpoint")) {
    if (statement.trim()) await handle.db.execute(raw(statement));
  }
}

/** Every migration before 0037, in journal order. */
async function dbBefore0037() {
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

describe("0037 workspace time zone migration", () => {
  it("carries over valid zones in canonical spelling and drops fixed-offset ones", async () => {
    const handle = await dbBefore0037();
    try {
      const saved: Record<string, string | null> = {
        "America/New_York": "America/New_York",
        "europe/paris": "Europe/Paris",
        utc: "UTC",
        "Etc/UTC": "UTC",
        GMT: "Europe/London",
        EST: "Europe/London",
        CET: "Europe/London",
        "+01:00": "Europe/London",
        "Etc/GMT+1": "Europe/London",
        "Not/AZone": "Europe/London",
        none: "Europe/London", // no attendance settings row at all
      };
      const ids = new Map<string, string>();
      let n = 0;
      for (const zone of Object.keys(saved)) {
        const id = newId();
        ids.set(zone, id);
        await handle.db.execute(
          dsql`INSERT INTO workspaces (id, slug, name) VALUES (${id}, ${`tz-${n++}`}, 'Tz')`,
        );
        if (zone === "none") continue;
        await handle.db.execute(dsql`
          INSERT INTO attendance_settings
            (workspace_id, time_zone, rounding_minutes, break_minutes, max_shift_hours, payroll_format, visitor_retention_months)
          VALUES (${id}, ${zone}, 0, 0, 12, 'csv', 12)`);
      }

      await apply(handle, TAG);

      for (const [zone, expected] of Object.entries(saved)) {
        const result = await handle.db.execute(
          dsql`SELECT time_zone FROM workspaces WHERE id = ${ids.get(zone)!}`,
        );
        const rows = (result as unknown as { rows: { time_zone: string }[] }).rows;
        expect([zone, rows[0]?.time_zone]).toEqual([zone, expected]);
      }
    } finally {
      await handle.close();
    }
  }, 60_000);
});
