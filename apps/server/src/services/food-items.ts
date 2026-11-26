import { foodItemFieldNames, hasFoodItemFields, type FoodItemPatch } from "@knotworking/core";
import { foodItems, items, type ChangeInput, type Executor, type Transaction } from "@knotworking/db";
import { and, eq, getTableColumns, inArray } from "drizzle-orm";

export type FoodItem = Pick<typeof foodItems.$inferSelect, keyof FoodItemPatch>;

const defaults: FoodItem = { allergens: [], mayContain: [], storage: "ambient", shelfLifeDays: null };

export function foodItemFields(food: FoodItem | null | undefined): FoodItem {
  if (!food) return defaults;
  const { allergens, mayContain, storage, shelfLifeDays } = food;
  return { allergens, mayContain, storage, shelfLifeDays };
}

export const foodItemJoin = and(eq(foodItems.itemId, items.id), eq(foodItems.workspaceId, items.workspaceId));

/** A catalogue query for food workflows, with defaults for items without a declaration. */
export const selectFoodItems = (db: Executor) =>
  db
    .select({ ...getTableColumns(items), food: foodItems })
    .from(items)
    .leftJoin(foodItems, foodItemJoin);

export async function foodFieldsByItem(db: Executor, workspaceId: string, ids: string[]) {
  if (!ids.length) return new Map<string, FoodItem>();
  const rows = await db
    .select()
    .from(foodItems)
    .where(and(eq(foodItems.workspaceId, workspaceId), inArray(foodItems.itemId, ids)));
  return new Map(rows.map((row) => [row.itemId, foodItemFields(row)]));
}

export async function saveFoodItem(
  tx: Transaction,
  workspaceId: string,
  itemId: string,
  fields: FoodItemPatch,
): Promise<ChangeInput[]> {
  if (!hasFoodItemFields(fields)) return [];
  const patch = Object.fromEntries(
    foodItemFieldNames.flatMap((key) => (fields[key] === undefined ? [] : [[key, fields[key]]])),
  ) as FoodItemPatch;
  const [row] = await tx
    .insert(foodItems)
    .values({ ...patch, workspaceId, itemId })
    .onConflictDoUpdate({ target: foodItems.itemId, set: patch })
    .returning();
  return [
    { entity: "food_item", entityId: itemId, action: "upsert", data: { itemId, ...foodItemFields(row) } },
  ];
}
