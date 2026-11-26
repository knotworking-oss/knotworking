import {
  parseItemsCsv,
  hasFoodItemFields,
  type FoodItemPatch,
  parseSuppliersCsv,
  unitDimension,
  type CsvImportInput,
  type CsvImportRowError,
  type ItemCsvColumn,
  type ItemEntry,
  type SupplierCsvColumn,
  type SupplierEntry,
} from "@knotworking/core";
import {
  items,
  lockWorkspaceLog,
  recordChanges,
  suppliers,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { chunks, importResult, invalidRows, type ImportChange } from "./csv-import";
import { recordStandardCostChange } from "./costing-settings";
import { foodItemFields, saveFoodItem, selectFoodItems } from "./food-items";
import { itemChange, supplierChange } from "./items";

/**
 * CSV import of items and suppliers (the parsers are in core). Each import checks every row
 * against what exists (a dry run stops there) and then writes all rows in one transaction, or
 * none. Every row is created or updated by its key and written to the sync log like the app's own
 * edits.
 */

type ItemRow = typeof items.$inferSelect & ReturnType<typeof foodItemFields>;
type SupplierRow = typeof suppliers.$inferSelect;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ─── Items ───────────────────────────────────────────────────────────────────

/** Entry field → the CSV column it came from, for error messages. */
const itemColumn: Record<string, ItemCsvColumn> = {
  name: "name",
  type: "type",
  unit: "unit",
  description: "description",
  densityGPerMl: "density",
  unitWeightG: "unitWeight",
  allergens: "allergens",
  mayContain: "mayContain",
  storage: "storage",
  shelfLifeDays: "shelfLife",
  standardCost: "standardCost",
  status: "status",
};
const itemFields = Object.keys(itemColumn) as (keyof typeof itemColumn & keyof ItemEntry)[];

type ItemPlan =
  | { action: "create"; entry: ItemEntry; values: typeof items.$inferInsert & FoodItemPatch }
  | { action: "update"; entry: ItemEntry; current: ItemRow; patch: Partial<ItemRow> }
  | { action: "unchanged"; entry: ItemEntry };

async function planItems(tx: Executor, workspaceId: string, entries: ItemEntry[]) {
  const existing = new Map<string, ItemRow>();
  for (const batch of chunks(entries.map((e) => e.code.toLowerCase()))) {
    const rows = await selectFoodItems(tx).where(
      and(
        eq(items.workspaceId, workspaceId),
        isNull(items.deletedAt),
        inArray(sql<string>`lower(${items.code})`, batch),
      ),
    );
    for (const { food, ...row } of rows) {
      existing.set(row.code.toLowerCase(), { ...row, ...foodItemFields(food) });
    }
  }

  const errors: CsvImportRowError<ItemCsvColumn>[] = [];
  const plan: ItemPlan[] = [];
  for (const entry of entries) {
    const current = existing.get(entry.code.toLowerCase());
    const given = Object.fromEntries(
      itemFields.flatMap((f) => (entry[f] !== undefined ? [[f, entry[f]]] : [])),
    );
    if (!current) {
      const missing = (["name", "type", "unit"] as const).filter((f) => entry[f] === undefined);
      for (const f of missing) {
        errors.push({
          row: entry.row,
          column: f,
          message: `"${entry.code}" is a new item, so it needs a ${f}`,
        });
      }
      if (missing.length) continue;
      plan.push({
        action: "create",
        entry,
        values: { ...given, code: entry.code, workspaceId } as typeof items.$inferInsert,
      });
      continue;
    }
    // Stored quantities are in the dimension's base unit, so the dimension can never change.
    if (entry.unit && unitDimension(entry.unit) !== unitDimension(current.unit)) {
      errors.push({
        row: entry.row,
        column: "unit",
        message: `"${entry.code}" is measured by ${unitDimension(current.unit)}; its unit can't change to ${entry.unit}`,
      });
      continue;
    }
    const patch = Object.fromEntries(
      Object.entries(given).filter(([f, v]) => !same(current[f as keyof ItemRow], v)),
    ) as Partial<ItemRow>;
    plan.push(
      Object.keys(patch).length
        ? { action: "update", entry, current, patch }
        : { action: "unchanged", entry },
    );
  }
  return { plan, errors };
}

async function applyItems(tx: Transaction, workspaceId: string, actorId: string, plan: ItemPlan[]) {
  const changes: ChangeInput[] = [];
  const creates = plan.flatMap((p) => (p.action === "create" ? [p.values] : []));
  for (const batch of chunks(creates)) {
    const rows = await tx
      .insert(items)
      .values(batch.map(({ allergens, mayContain, storage, shelfLifeDays, ...values }) => values))
      .returning();
    const byCode = new Map(batch.map((entry) => [entry.code, entry]));
    for (const row of rows) {
      const { allergens, mayContain, storage, shelfLifeDays } = byCode.get(row.code)!;
      changes.push(
        itemChange(row),
        ...(await saveFoodItem(tx, workspaceId, row.id, { allergens, mayContain, storage, shelfLifeDays })),
      );
    }
  }
  for (const p of plan) {
    if (p.action !== "update") continue;
    const { allergens, mayContain, storage, shelfLifeDays, ...values } = p.patch;
    const [row] = await tx
      .update(items)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(items.id, p.current.id))
      .returning();
    changes.push(
      itemChange(row!),
      ...(await saveFoodItem(tx, workspaceId, row!.id, { allergens, mayContain, storage, shelfLifeDays })),
    );
    // A changed standard cost is kept in the item's cost history (costing) from today.
    const next = p.patch.standardCost;
    if (next !== undefined && next !== p.current.standardCost)
      changes.push(...(await recordStandardCostChange(tx, workspaceId, actorId, p.current, next)));
  }
  for (const batch of chunks(changes, 1000)) await recordChanges(tx, workspaceId, actorId, batch);
}

export async function importItemsCsv(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: CsvImportInput,
  requireFoodWrite: () => void,
) {
  const parsed = parseItemsCsv(input.csv);
  if (parsed.entries.some(hasFoodItemFields)) requireFoodWrite();
  const fileName = input.fileName ?? null;

  const check = async (tx: Executor) => {
    const { plan, errors } = await planItems(tx, workspaceId, parsed.entries);
    const all = [...parsed.errors, ...errors].sort((a, b) => a.row - b.row);
    return { plan: all.length ? [] : plan, errors: all };
  };
  const result = (plan: ItemPlan[], errors: CsvImportRowError[], dryRun: boolean) => {
    const changes: ImportChange[] = plan.flatMap((p) =>
      p.action === "unchanged"
        ? []
        : [
            {
              row: p.entry.row,
              action: p.action,
              key: p.entry.code,
              name: p.action === "create" ? p.values.name : (p.patch.name ?? p.current.name),
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
    await applyItems(tx, workspaceId, actorId, plan);
    return result(plan, [], false);
  });
}

// ─── Suppliers ───────────────────────────────────────────────────────────────

const supplierFieldColumn: Record<string, SupplierCsvColumn> = {
  code: "code",
  name: "name",
  contactName: "contactName",
  email: "email",
  phone: "phone",
  address: "address",
  notes: "notes",
  certification: "certification",
  certificateExpiresOn: "certificateExpiresOn",
};
const supplierFields = Object.keys(supplierFieldColumn) as (keyof typeof supplierFieldColumn &
  keyof SupplierEntry)[];

type SupplierPlan =
  | { action: "create"; entry: SupplierEntry; values: typeof suppliers.$inferInsert }
  | { action: "update"; entry: SupplierEntry; current: SupplierRow; patch: Partial<SupplierRow> }
  | { action: "unchanged"; entry: SupplierEntry; current: SupplierRow };

async function planSuppliers(tx: Executor, workspaceId: string, entries: SupplierEntry[]) {
  const byCode = new Map<string, SupplierRow>();
  const byName = new Map<string, SupplierRow[]>();
  const live = and(eq(suppliers.workspaceId, workspaceId), isNull(suppliers.deletedAt));
  const codes = entries.flatMap((e) => (e.code ? [e.code.toLowerCase()] : []));
  const names = entries.flatMap((e) => (e.name ? [e.name.toLowerCase()] : []));
  for (const batch of chunks(codes)) {
    const rows = await tx
      .select()
      .from(suppliers)
      .where(and(live, inArray(sql<string>`lower(${suppliers.code})`, batch)));
    for (const row of rows) byCode.set(row.code!.toLowerCase(), row);
  }
  for (const batch of chunks(names)) {
    const rows = await tx
      .select()
      .from(suppliers)
      .where(and(live, inArray(sql<string>`lower(${suppliers.name})`, batch)));
    for (const row of rows) {
      const list = byName.get(row.name.toLowerCase()) ?? [];
      list.push(row);
      byName.set(row.name.toLowerCase(), list);
    }
  }

  const errors: CsvImportRowError<SupplierCsvColumn>[] = [];
  const plan: SupplierPlan[] = [];
  const claimed = new Map<string, number>();
  for (const entry of entries) {
    const fail = (column: SupplierCsvColumn, message: string) =>
      errors.push({ row: entry.row, column, message });

    // Find the supplier: by code first, then by name.
    let current: SupplierRow | undefined;
    const label = entry.code ?? entry.name!;
    if (entry.code) current = byCode.get(entry.code.toLowerCase());
    if (!current && entry.name) {
      const sameName = byName.get(entry.name.toLowerCase()) ?? [];
      if (entry.code) {
        const uncoded = sameName.filter((s) => !s.code);
        const coded = sameName.filter((s) => s.code);
        if (uncoded.length === 1) current = uncoded[0];
        else if (uncoded.length > 1) {
          fail(
            "name",
            `More than one supplier is called "${entry.name}" and has no code; give the code of the one you mean`,
          );
          continue;
        } else if (coded.length) {
          fail(
            "code",
            `A supplier called "${entry.name}" already exists with code "${coded[0]!.code}", not "${entry.code}"`,
          );
          continue;
        }
      } else if (sameName.length === 1) current = sameName[0];
      else if (sameName.length > 1) {
        fail("name", `More than one supplier is called "${entry.name}"; give a code`);
        continue;
      }
    }

    const given = Object.fromEntries(
      supplierFields.flatMap((f) => (entry[f] !== undefined ? [[f, entry[f]]] : [])),
    );
    if (!current) {
      if (!entry.name) {
        fail("name", `No supplier has the code "${entry.code}", so a new one needs a name`);
        continue;
      }
      plan.push({
        action: "create",
        entry,
        values: { ...given, name: entry.name, workspaceId } as typeof suppliers.$inferInsert,
      });
      continue;
    }
    const seen = claimed.get(current.id);
    if (seen !== undefined) {
      fail(entry.code ? "code" : "name", `"${label}" is the same supplier as row ${seen}`);
      continue;
    }
    claimed.set(current.id, entry.row);
    // Found by name ignoring case: that is not a rename.
    if (!entry.code || !byCode.has(entry.code.toLowerCase())) {
      if (entry.name?.toLowerCase() === current.name.toLowerCase()) delete given.name;
    }
    // Found by code ignoring case: that is not a change to the code.
    if (current.code && entry.code?.toLowerCase() === current.code.toLowerCase()) delete given.code;
    const patch = Object.fromEntries(
      Object.entries(given).filter(([f, v]) => !same(current![f as keyof SupplierRow], v)),
    ) as Partial<SupplierRow>;
    plan.push(
      Object.keys(patch).length
        ? { action: "update", entry, current, patch }
        : { action: "unchanged", entry, current },
    );
  }
  return { plan, errors };
}

export async function importSuppliersCsv(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: CsvImportInput,
) {
  const parsed = parseSuppliersCsv(input.csv);
  const fileName = input.fileName ?? null;

  const check = async (tx: Executor) => {
    const { plan, errors } = await planSuppliers(tx, workspaceId, parsed.entries);
    const all = [...parsed.errors, ...errors].sort((a, b) => a.row - b.row);
    return { plan: all.length ? [] : plan, errors: all };
  };
  const result = (plan: SupplierPlan[], errors: CsvImportRowError[], dryRun: boolean) => {
    const changes: ImportChange[] = plan.flatMap((p) =>
      p.action === "unchanged"
        ? []
        : [
            {
              row: p.entry.row,
              action: p.action,
              key: p.entry.code ?? p.entry.name ?? "",
              name: p.action === "create" ? p.values.name : (p.patch.name ?? p.current.name),
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
    // Never the approval: new suppliers start `pending` (the column default), existing ones keep theirs.
    for (const batch of chunks(plan.flatMap((p) => (p.action === "create" ? [p.values] : [])))) {
      changes.push(...(await tx.insert(suppliers).values(batch).returning()).map(supplierChange));
    }
    for (const p of plan) {
      if (p.action !== "update") continue;
      const [row] = await tx.update(suppliers).set(p.patch).where(eq(suppliers.id, p.current.id)).returning();
      changes.push(supplierChange(row!));
    }
    for (const batch of chunks(changes, 1000)) await recordChanges(tx, workspaceId, actorId, batch);
    return result(plan, [], false);
  });
}
