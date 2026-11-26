import type { AllergenCode, StorageCondition } from "@knotworking/core";
import { integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { workspaceRef } from "./helpers";
import { items } from "./items";

export const foodItems = pgTable("food_items", {
  itemId: uuid("item_id")
    .primaryKey()
    .references(() => items.id, { onDelete: "cascade" }),
  workspaceId: workspaceRef(),
  allergens: jsonb("allergens").$type<AllergenCode[]>().notNull().default([]),
  mayContain: jsonb("may_contain").$type<AllergenCode[]>().notNull().default([]),
  storage: text("storage").$type<StorageCondition>().notNull().default("ambient"),
  shelfLifeDays: integer("shelf_life_days"),
});
