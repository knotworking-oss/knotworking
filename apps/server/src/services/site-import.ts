import {
  parseGlassCsv,
  type CsvImportInput,
  type CsvImportRowError,
  type GlassCsvColumn,
  type GlassEntry,
} from "@knotworking/core";
import {
  haccpAssets,
  lockWorkspaceLog,
  recordChanges,
  siteGlassItems,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, eq, isNull } from "drizzle-orm";
import { chunks, importResult, invalidRows, type ImportChange } from "./csv-import";

/**
 * CSV import of the glass and brittle plastics register (the parser is in core). An item is
 * identified by its area (HACCP register area, by code or name) and its description, compared
 * without case: a row that matches updates the item, one that doesn't creates it. Items are never
 * deleted by an import, and nothing is written while any row is wrong.
 */

type GlassRow = typeof siteGlassItems.$inferSelect;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const itemChange = (row: GlassRow): ChangeInput => {
  const { workspaceId: _ws, deletedAt: _deleted, ...data } = row;
  return { entity: "site_glass_item", entityId: row.id, action: "upsert", data };
};

type GlassPlan =
  | { action: "create"; entry: GlassEntry; values: typeof siteGlassItems.$inferInsert }
  | { action: "update"; entry: GlassEntry; current: GlassRow; patch: Partial<GlassRow> }
  | { action: "unchanged"; entry: GlassEntry };

async function planGlass(tx: Executor, workspaceId: string, entries: GlassEntry[]) {
  const areas = await tx
    .select({
      id: haccpAssets.id,
      code: haccpAssets.code,
      name: haccpAssets.name,
      status: haccpAssets.status,
    })
    .from(haccpAssets)
    .where(
      and(
        eq(haccpAssets.workspaceId, workspaceId),
        eq(haccpAssets.kind, "area"),
        isNull(haccpAssets.deletedAt),
      ),
    );
  const byCode = new Map(areas.filter((a) => a.code).map((a) => [a.code!.toLowerCase(), a]));
  const byName = new Map<string, typeof areas>();
  for (const a of areas) {
    const list = byName.get(a.name.toLowerCase()) ?? [];
    list.push(a);
    byName.set(a.name.toLowerCase(), list);
  }
  const items = await tx
    .select()
    .from(siteGlassItems)
    .where(and(eq(siteGlassItems.workspaceId, workspaceId), isNull(siteGlassItems.deletedAt)));
  const itemKey = (areaId: string, description: string) => `${areaId}\n${description.toLowerCase()}`;
  const existing = new Map(items.map((i) => [itemKey(i.areaId, i.description), i]));

  const errors: CsvImportRowError<GlassCsvColumn>[] = [];
  const plan: GlassPlan[] = [];
  const claimed = new Map<string, number>();
  for (const entry of entries) {
    const fail = (column: GlassCsvColumn, message: string) =>
      errors.push({ row: entry.row, column, message });
    const lower = entry.area.toLowerCase();
    const named = byName.get(lower) ?? [];
    const area = byCode.get(lower) ?? (named.length === 1 ? named[0] : undefined);
    if (!area) {
      fail(
        "area",
        named.length > 1
          ? `More than one area is called "${entry.area}"; use its code`
          : `No area is called or coded "${entry.area}". Areas are kept in Cleaning & calibration`,
      );
      continue;
    }
    const key = itemKey(area.id, entry.description);
    const seen = claimed.get(key);
    if (seen !== undefined) {
      fail("description", `This item is the same as row ${seen}`);
      continue;
    }
    claimed.set(key, entry.row);
    const current = existing.get(key);
    const given: Partial<GlassRow> = {
      ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
      ...(entry.quantity !== undefined ? { quantity: entry.quantity } : {}),
      ...(entry.location !== undefined ? { location: entry.location } : {}),
      ...(entry.checkFrequency
        ? { checkEvery: entry.checkFrequency.every, checkUnit: entry.checkFrequency.unit }
        : {}),
      ...(entry.status !== undefined ? { status: entry.status } : {}),
    };
    if (!current) {
      if (area.status === "archived") {
        fail("area", `"${entry.area}" is archived in the food safety register`);
        continue;
      }
      plan.push({
        action: "create",
        entry,
        values: {
          kind: "glass",
          quantity: 1,
          checkEvery: 1,
          checkUnit: "month",
          ...given,
          workspaceId,
          areaId: area.id,
          description: entry.description,
        } as typeof siteGlassItems.$inferInsert,
      });
      continue;
    }
    const patch = Object.fromEntries(
      Object.entries(given).filter(([f, v]) => !same(current[f as keyof GlassRow], v)),
    ) as Partial<GlassRow>;
    plan.push(
      Object.keys(patch).length
        ? { action: "update", entry, current, patch }
        : { action: "unchanged", entry },
    );
  }
  return { plan, errors };
}

export async function importGlassCsv(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: CsvImportInput,
) {
  const parsed = parseGlassCsv(input.csv);
  const fileName = input.fileName ?? null;

  const check = async (tx: Executor) => {
    // A file that can't be read at all is not planned against the register.
    const { plan, errors } = await planGlass(tx, workspaceId, parsed.entries);
    const all = [...parsed.errors, ...errors].sort((a, b) => a.row - b.row);
    return { plan: all.length ? [] : plan, errors: all };
  };
  const result = (plan: GlassPlan[], errors: CsvImportRowError[], dryRun: boolean) => {
    const changes: ImportChange[] = plan.flatMap((p) =>
      p.action === "unchanged"
        ? []
        : [
            {
              row: p.entry.row,
              action: p.action,
              key: p.entry.area,
              name: p.entry.description,
              fields: p.action === "update" ? Object.keys(p.patch) : [],
            },
          ],
    );
    return importResult({
      dryRun,
      fileName,
      rowCount: parsed.rowCount,
      ignoredColumns: parsed.ignoredColumns,
      errors,
      changes,
      unchanged: plan.filter((p) => p.action === "unchanged").length,
    });
  };

  if (input.dryRun) {
    const { plan, errors } = await check(db);
    return result(plan, errors, true);
  }
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const { plan, errors } = await check(tx);
    if (errors.length) throw invalidRows(errors);
    const changes: ChangeInput[] = [];
    for (const batch of chunks(plan.flatMap((p) => (p.action === "create" ? [p.values] : [])))) {
      changes.push(...(await tx.insert(siteGlassItems).values(batch).returning()).map(itemChange));
    }
    for (const p of plan) {
      if (p.action !== "update") continue;
      const [row] = await tx
        .update(siteGlassItems)
        .set(p.patch)
        .where(eq(siteGlassItems.id, p.current.id))
        .returning();
      changes.push(itemChange(row!));
    }
    for (const batch of chunks(changes, 1000)) await recordChanges(tx, workspaceId, actorId, batch);
    return result(plan, [], false);
  });
}
