import {
  cleanMicronutrientMap,
  nutritionInputSchema,
  parseNutritionCsv,
  unitDimension,
  type CsvImportInput,
  type CsvImportRowError,
  type NutritionBasis,
  type NutritionCsvColumn,
  type NutritionEntryRow,
} from "@knotworking/core";
import {
  itemLabelData,
  items,
  lockWorkspaceLog,
  recordChanges,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { chunks, importResult, invalidRows, type ImportChange } from "./csv-import";
import { dataChange } from "./labels";

/**
 * CSV import of items' nutrition (the parser is in core): from a specification sheet, or
 * McCance and Widdowson's columns. Rows are matched to existing food items by stock code (or exact
 * name); nothing is created but labelling data. A dry run checks every row and previews what
 * changes; the real import writes every row in one transaction, or none, and writes each to the
 * sync log like the app's own edits.
 */

type ItemRow = typeof items.$inferSelect;
type DataRow = typeof itemLabelData.$inferSelect;
type DataValues = Omit<
  typeof itemLabelData.$inferInsert,
  "id" | "workspaceId" | "itemId" | "createdAt" | "updatedAt" | "deletedAt"
>;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

type Plan =
  | { action: "create"; entry: NutritionEntryRow; item: ItemRow; values: DataValues }
  | {
      action: "update";
      entry: NutritionEntryRow;
      item: ItemRow;
      current: DataRow;
      values: DataValues;
      fields: string[];
    }
  | { action: "unchanged"; entry: NutritionEntryRow; item: ItemRow };

async function planNutrition(
  tx: Executor,
  workspaceId: string,
  actorId: string,
  entries: NutritionEntryRow[],
  fileName: string | null,
) {
  const live = and(eq(items.workspaceId, workspaceId), isNull(items.deletedAt));
  const byCode = new Map<string, ItemRow>();
  const byName = new Map<string, ItemRow[]>();
  for (const batch of chunks(entries.flatMap((e) => (e.code ? [e.code.toLowerCase()] : [])))) {
    const rows = await tx
      .select()
      .from(items)
      .where(and(live, inArray(sql<string>`lower(${items.code})`, batch)));
    for (const row of rows) byCode.set(row.code.toLowerCase(), row);
  }
  for (const batch of chunks(entries.flatMap((e) => (e.name ? [e.name.toLowerCase()] : [])))) {
    const rows = await tx
      .select()
      .from(items)
      .where(and(live, inArray(sql<string>`lower(${items.name})`, batch)));
    for (const row of rows) {
      const list = byName.get(row.name.toLowerCase()) ?? [];
      list.push(row);
      byName.set(row.name.toLowerCase(), list);
    }
  }
  const itemIds = [...byCode.values(), ...[...byName.values()].flat()].map((i) => i.id);
  const existing = new Map<string, DataRow>();
  for (const batch of chunks(itemIds)) {
    const rows = await tx.select().from(itemLabelData).where(inArray(itemLabelData.itemId, batch));
    for (const row of rows) existing.set(row.itemId, row);
  }

  const errors: CsvImportRowError<NutritionCsvColumn>[] = [];
  const plan: Plan[] = [];
  const claimed = new Map<string, number>();
  for (const entry of entries) {
    const fail = (column: NutritionCsvColumn, message: string) =>
      errors.push({ row: entry.row, column, message });

    let item: ItemRow | undefined;
    if (entry.code) {
      item = byCode.get(entry.code.toLowerCase());
      if (!item) {
        fail(
          "code",
          `No item has the stock code "${entry.code}"; create it first (an import only sets nutrition)`,
        );
        continue;
      }
    } else {
      const named = byName.get(entry.name!.toLowerCase()) ?? [];
      if (named.length === 0) {
        fail("name", `No item is called "${entry.name}"; give its stock code`);
        continue;
      }
      if (named.length > 1) {
        fail("name", `More than one item is called "${entry.name}"; give the stock code`);
        continue;
      }
      item = named[0];
    }
    if (!item) continue;
    if (item.type === "packaging") {
      fail(entry.code ? "code" : "name", `${item.code} is packaging; only food items have nutrition`);
      continue;
    }
    const seen = claimed.get(item.id);
    if (seen !== undefined) {
      fail(entry.code ? "code" : "name", `${item.code} is the same item as row ${seen}`);
      continue;
    }
    claimed.set(item.id, entry.row);

    const current = existing.get(item.id);
    const basis: NutritionBasis =
      entry.basis ?? current?.nutritionBasis ?? (unitDimension(item.unit) === "volume" ? "100ml" : "100g");
    const checked = nutritionInputSchema.safeParse({ basis, ...entry.nutrition });
    if (!checked.success) {
      for (const issue of checked.error.issues) {
        const column = issue.path[0];
        fail(typeof column === "string" ? (column as NutritionCsvColumn) : "energyKj", issue.message);
      }
      continue;
    }
    const n = checked.data;
    const values: DataValues = {
      declarationName:
        entry.declarationName !== undefined ? entry.declarationName : (current?.declarationName ?? null),
      components: entry.components !== undefined ? entry.components : (current?.components ?? null),
      nutritionBasis: n.basis,
      energyKj: n.energyKj,
      energyKcal: n.energyKcal,
      fat: n.fat,
      saturates: n.saturates,
      carbohydrate: n.carbohydrate,
      sugars: n.sugars,
      fibre: n.fibre,
      protein: n.protein,
      salt: n.salt,
      polyols: n.polyols || null,
      erythritol: n.erythritol || null,
      organicAcids: n.organicAcids || null,
      alcohol: n.alcohol || null,
      // Only when the file has vitamin and mineral columns; retention factors are never imported.
      micronutrients:
        entry.micronutrients !== undefined
          ? cleanMicronutrientMap(entry.micronutrients)
          : (current?.micronutrients ?? null),
      retention: current?.retention ?? null,
      nutritionSource:
        entry.nutritionSource !== undefined
          ? entry.nutritionSource
          : fileName
            ? `Imported from ${fileName}`
            : (current?.nutritionSource ?? null),
      updatedBy: actorId,
    };
    if (!current) {
      plan.push({ action: "create", entry, item, values });
      continue;
    }
    const fields = (Object.keys(values) as (keyof DataValues)[]).filter(
      (f) => f !== "updatedBy" && !same(values[f], current[f as keyof DataRow]),
    );
    plan.push(
      fields.length
        ? { action: "update", entry, item, current, values, fields }
        : { action: "unchanged", entry, item },
    );
  }
  return { plan, errors };
}

async function applyNutrition(tx: Transaction, workspaceId: string, actorId: string, plan: Plan[]) {
  const changes: ChangeInput[] = [];
  for (const p of plan) {
    if (p.action === "create") {
      const [row] = await tx
        .insert(itemLabelData)
        .values({ ...p.values, workspaceId, itemId: p.item.id })
        .returning();
      changes.push(dataChange(row!));
    } else if (p.action === "update") {
      const [row] = await tx
        .update(itemLabelData)
        .set({ ...p.values, updatedAt: new Date() })
        .where(eq(itemLabelData.id, p.current.id))
        .returning();
      changes.push(dataChange(row!));
    }
  }
  for (const batch of chunks(changes, 1000)) await recordChanges(tx, workspaceId, actorId, batch);
}

export async function importNutritionCsv(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: CsvImportInput,
) {
  const parsed = parseNutritionCsv(input.csv);
  const fileName = input.fileName ?? null;

  const check = async (tx: Executor) => {
    const { plan, errors } = await planNutrition(tx, workspaceId, actorId, parsed.entries, fileName);
    const all = [...parsed.errors, ...errors].sort((a, b) => a.row - b.row);
    return { plan: all.length ? [] : plan, errors: all };
  };
  const result = (plan: Plan[], errors: CsvImportRowError[], dryRun: boolean) => {
    const changes: ImportChange[] = plan.flatMap((p) =>
      p.action === "unchanged"
        ? []
        : [
            {
              row: p.entry.row,
              action: p.action,
              key: p.item.code,
              name: p.item.name,
              fields: p.action === "update" ? p.fields : [],
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
    await applyNutrition(tx, workspaceId, actorId, plan);
    return result(plan, [], false);
  });
}
