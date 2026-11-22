/**
 * Labels and nutrition module: items' labelling data (declared name, components, nutrition) and
 * product labels approved per recipe version.
 * See docs/modules.md and `@knotworking/core` labels.ts.
 *
 * Nutrition roll-ups, ingredient declarations and whether an approved label is out of date are
 * computed on read, never stored; a label keeps what was approved and a snapshot of what it was
 * drafted from (`source_snapshot`) to compare against.
 */
import type {
  AllergenCode,
  MicronutrientAmounts,
  MicronutrientRetention,
  CompoundStyle,
  EnergyMethod,
  LabelPanelSource,
  LabelSegment,
  LabelSourceSnapshot,
  NutritionBasis,
  NutritionPanel,
  ProductLabelStatus,
} from "@knotworking/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { items } from "./items";
import { recipes, recipeVersions } from "./recipes";

/** Per 100 g or 100 ml, 3 decimal places (salt can be 0.012 g). */
const nutrient = (name: string) => numeric(name, { precision: 10, scale: 3, mode: "number" });

/**
 * One row per item that has labelling data. Nutrition is present when `energy_kj` is set (the
 * service writes all mandatory values together); `fibre` is optional. For an item made in house
 * with an approved recipe, nutrition is computed from the recipe and this row's values are not
 * used.
 */
export const itemLabelData = pgTable(
  "item_label_data",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    /** How the item appears in an ingredients list; null: the item's name. */
    declarationName: text("declaration_name"),
    /** A bought-in compound ingredient's own ingredients, from its specification. */
    components: text("components"),
    nutritionBasis: text("nutrition_basis").$type<NutritionBasis>().notNull().default("100g"),
    energyKj: nutrient("energy_kj"),
    energyKcal: nutrient("energy_kcal"),
    fat: nutrient("fat"),
    saturates: nutrient("saturates"),
    carbohydrate: nutrient("carbohydrate"),
    sugars: nutrient("sugars"),
    fibre: nutrient("fibre"),
    protein: nutrient("protein"),
    salt: nutrient("salt"),
    /** Energy-carrying extras per 100 g / ml, for the energy calculation only (never declared). */
    polyols: nutrient("polyols"),
    erythritol: nutrient("erythritol"),
    organicAcids: nutrient("organic_acids"),
    alcohol: nutrient("alcohol"),
    /** Optional vitamins and minerals per 100 g / ml (never declared). */
    micronutrients: jsonb("micronutrients").$type<MicronutrientAmounts>(),
    /** Fraction of each micronutrient that survives cooking the item in a recipe (0 to 1). */
    retention: jsonb("retention").$type<MicronutrientRetention>(),
    /** Where the nutrition came from, e.g. "Supplier specification v3". */
    nutritionSource: text("nutrition_source"),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [uniqueIndex("item_label_data_item_key").on(t.itemId)],
);

/**
 * A product label drafted for a recipe's approved version. Document control as recipe versions:
 * at most one draft (the only editable one) and one approved label per recipe and variant; approving
 * supersedes the previous approved label. Approved and superseded labels never change.
 */
export const productLabels = pgTable(
  "product_labels",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipes.id),
    /** The recipe version the label was drafted from (approved when drafted). */
    recipeVersionId: uuid("recipe_version_id")
      .notNull()
      .references(() => recipeVersions.id),
    /**
     * Which of the recipe's labels this is (a pack size, a customer's own label). Document control
     * runs per recipe and variant: numbering, one draft, one approved. Fixed once drafted.
     */
    variant: text("variant").notNull().default("Standard"),
    /** 1, 2, … per recipe and variant. */
    versionNumber: integer("version_number").notNull(),
    status: text("status").$type<ProductLabelStatus>().notNull().default("draft"),
    productName: text("product_name").notNull(),
    /** The ingredients list as text runs, allergens emphasised. */
    ingredients: jsonb("ingredients").$type<LabelSegment[]>().notNull().default([]),
    allergenStatement: text("allergen_statement"),
    /** The allergens rolled up when the label was drafted. */
    allergens: jsonb("allergens")
      .$type<{ contains: AllergenCode[]; mayContain: AllergenCode[] }>()
      .notNull()
      .default({ contains: [], mayContain: [] }),
    /** False for a product exempt from the nutrition declaration. */
    includeNutrition: boolean("include_nutrition").notNull().default(true),
    /** The panel: raw values and the rounded declaration. Null when not declared or incomplete. */
    nutrition: jsonb("nutrition").$type<NutritionPanel>(),
    /**
     * Where the panel came from: `computed` (from a complete roll-up) or `entered` (typed in, e.g.
     * a laboratory analysis). Null when there is no panel.
     */
    panelSource: text("panel_source").$type<LabelPanelSource>(),
    storageInstructions: text("storage_instructions"),
    dateGuidance: text("date_guidance"),
    netQuantity: text("net_quantity"),
    /** The pack's barcode, an EAN-13 (13 digits, check digit validated); printed as bars. */
    gtin: text("gtin"),
    notes: text("notes"),
    compoundStyle: text("compound_style").$type<CompoundStyle>().notNull().default("bracketed"),
    /** Items whose percentage is declared (QUID). */
    quidItemIds: jsonb("quid_item_ids").$type<string[]>().notNull().default([]),
    /** Added water and volatile ingredients, listed by their weight in the finished product. */
    volatileItemIds: jsonb("volatile_item_ids").$type<string[]>().notNull().default([]),
    energyMethod: text("energy_method").$type<EnergyMethod>().notNull().default("declared"),
    /** Declare negligible amounts as "0 g" rather than "<0.5 g". */
    negligibleAsZero: boolean("negligible_as_zero").notNull().default(false),
    /** Portion size in g (ml for a liquid); null: no per-portion values. */
    portionSize: numeric("portion_size", { precision: 10, scale: 3, mode: "number" }),
    portionLabel: text("portion_label"),
    /** Whoever created, edited or refreshed the draft last: four-eyes keeps them from approving it. */
    lastEditedBy: uuid("last_edited_by").references(() => users.id, { onDelete: "set null" }),
    /** What the computed parts were drafted from; compared on read to tell if the label is stale. */
    sourceSnapshot: jsonb("source_snapshot").$type<LabelSourceSnapshot>().notNull(),
    /** When the computed parts were last drafted (create or refresh). */
    generatedAt: ts("generated_at").notNull().defaultNow(),
    approvedAt: ts("approved_at"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("product_labels_number_key").on(t.recipeId, sql`lower(${t.variant})`, t.versionNumber),
    uniqueIndex("product_labels_one_draft_key")
      .on(t.recipeId, sql`lower(${t.variant})`)
      .where(sql`${t.status} = 'draft' and ${t.deletedAt} is null`),
    uniqueIndex("product_labels_one_approved_key")
      .on(t.recipeId, sql`lower(${t.variant})`)
      .where(sql`${t.status} = 'approved' and ${t.deletedAt} is null`),
    index("product_labels_workspace_status_idx").on(t.workspaceId, t.status),
    index("product_labels_recipe_version_idx").on(t.recipeVersionId),
  ],
);
