/**
 * Recipes module: versioned bills of materials.
 * See docs/modules.md and `@knotworking/core` recipes.ts.
 */
import type { AllergenRollup, RecipeStatus, RecipeVersionStatus, UnitCode } from "@knotworking/core";
import { sql } from "drizzle-orm";
import { index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { items } from "./items";
import { pk, timestamps, ts, workspaceRef } from "./helpers";

/** A product's recipe. The content lives in versions; this row is the stable identity. */
export const recipes = pgTable(
  "recipes",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** Unique among live recipes, case-insensitively. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** The work-in-progress or finished item one batch makes. */
    outputItemId: uuid("output_item_id")
      .notNull()
      .references(() => items.id),
    description: text("description"),
    status: text("status").$type<RecipeStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("recipes_workspace_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null`),
    index("recipes_output_item_idx").on(t.outputItemId),
  ],
);

/**
 * One version of a recipe. At most one draft per recipe (the only editable version); approving it
 * supersedes the previously approved version. Approved and superseded versions never change.
 */
export const recipeVersions = pgTable(
  "recipe_versions",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    /** 1, 2, … per recipe. */
    versionNumber: integer("version_number").notNull(),
    status: text("status").$type<RecipeVersionStatus>().notNull().default("draft"),
    /** What one batch makes, in `yieldUnit` (same dimension as the output item's unit). */
    yieldQuantity: numeric("yield_quantity", { precision: 18, scale: 4, mode: "number" })
      .notNull()
      .default(0),
    yieldUnit: text("yield_unit").$type<UnitCode>().notNull(),
    method: text("method"),
    changeNote: text("change_note"),
    /**
     * The allergen roll-up of the ingredients when the version was approved (null before this was
     * kept). Compared with the roll-up computed now to flag an ingredient's declaration changing.
     */
    approvedAllergens: jsonb("approved_allergens").$type<AllergenRollup>(),
    approvedAt: ts("approved_at"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("recipe_versions_number_key").on(t.recipeId, t.versionNumber),
    // At most one draft and one approved version per recipe, enforced by the database.
    uniqueIndex("recipe_versions_one_draft_key")
      .on(t.recipeId)
      .where(sql`${t.status} = 'draft' and ${t.deletedAt} is null`),
    uniqueIndex("recipe_versions_one_approved_key")
      .on(t.recipeId)
      .where(sql`${t.status} = 'approved' and ${t.deletedAt} is null`),
  ],
);

/** An ingredient line of a version. */
export const recipeLines = pgTable(
  "recipe_lines",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => recipeVersions.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    quantity: numeric("quantity", { precision: 18, scale: 4, mode: "number" }).notNull(),
    unit: text("unit").$type<UnitCode>().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    note: text("note"),
    ...timestamps(),
  },
  (t) => [
    index("recipe_lines_version_idx").on(t.versionId, t.sortOrder),
    index("recipe_lines_item_idx").on(t.itemId),
  ],
);
