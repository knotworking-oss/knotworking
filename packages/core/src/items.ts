import { supplierCategories } from "./supplier-controls";
import { z } from "zod";

/**
 * Items module: shared vocabulary for the master data (items, units, allergens, suppliers) that
 * recipes, stock, demand and production build on. No DOM or Node APIs.
 */

// ─── Units ───────────────────────────────────────────────────────────────────

export const unitDimensions = ["mass", "volume", "count", "length", "area", "time"] as const;
export type UnitDimension = (typeof unitDimensions)[number];

/**
 * Units people enter quantities in. `toBase` converts to the dimension's base unit, which is
 * what quantities are stored in.
 */
export const units = {
  mg: { label: "mg", dimension: "mass", toBase: 0.001 },
  g: { label: "g", dimension: "mass", toBase: 1 },
  kg: { label: "kg", dimension: "mass", toBase: 1000 },
  ml: { label: "ml", dimension: "volume", toBase: 1 },
  l: { label: "l", dimension: "volume", toBase: 1000 },
  each: { label: "each", dimension: "count", toBase: 1 },
  mm: { label: "mm", dimension: "length", toBase: 1 },
  cm: { label: "cm", dimension: "length", toBase: 10 },
  m: { label: "m", dimension: "length", toBase: 1000 },
  mm2: { label: "mm²", dimension: "area", toBase: 1 },
  cm2: { label: "cm²", dimension: "area", toBase: 100 },
  m2: { label: "m²", dimension: "area", toBase: 1_000_000 },
  s: { label: "s", dimension: "time", toBase: 1 },
  min: { label: "min", dimension: "time", toBase: 60 },
  h: { label: "h", dimension: "time", toBase: 3600 },
} as const satisfies Record<string, { label: string; dimension: UnitDimension; toBase: number }>;

export type UnitCode = keyof typeof units;
export const unitCodes = Object.keys(units) as [UnitCode, ...UnitCode[]];
export const baseUnits: Record<UnitDimension, UnitCode> = {
  mass: "g",
  volume: "ml",
  count: "each",
  length: "mm",
  area: "mm2",
  time: "s",
};
export const unitDimension = (unit: UnitCode): UnitDimension => units[unit].dimension;

/** What an item needs to say for quantities to cross dimensions. */
export interface UnitBridge {
  /** Grams per millilitre: volume ↔ mass. */
  densityGPerMl?: number | null | undefined;
  /** Grams per each: count ↔ mass. */
  unitWeightG?: number | null | undefined;
}

/**
 * Converts a quantity between units. Within a dimension it always works; across dimensions it
 * goes through grams and needs the item's density or unit weight. Returns `null` when the item
 * doesn't say enough (never a guess).
 */
export function convertQuantity(
  quantity: number,
  from: UnitCode,
  to: UnitCode,
  bridge: UnitBridge = {},
): number | null {
  const a = units[from];
  const b = units[to];
  const base = quantity * a.toBase;
  if (a.dimension === b.dimension) return base / b.toBase;
  const gramsPer = {
    mass: 1,
    volume: bridge.densityGPerMl,
    count: bridge.unitWeightG,
    length: null,
    area: null,
    time: null,
  } satisfies Record<UnitDimension, number | null | undefined>;
  const fromFactor = gramsPer[a.dimension];
  const toFactor = gramsPer[b.dimension];
  if (!fromFactor || !toFactor) return null;
  return (base * fromFactor) / toFactor / b.toBase;
}

/** Decimal places quantities are stored with (`numeric(18,4)`) in recipes and the stock ledger. */
export const QUANTITY_DECIMALS = 4;

/** Rounds a quantity to the stored precision (sign-safe; never returns `-0`). */
export const roundQuantity = (quantity: number, decimals = QUANTITY_DECIMALS): number => {
  const factor = 10 ** decimals;
  const rounded = Math.round((quantity + Number.EPSILON * Math.sign(quantity)) * factor) / factor;
  return rounded === 0 ? 0 : rounded;
};

/**
 * Units a quantity of this item can be entered in: its own dimension always, another dimension
 * only when the item has the density or unit weight that `convertQuantity` needs.
 */
export const unitsForItem = (item: { unit: UnitCode } & UnitBridge): UnitCode[] =>
  unitCodes.filter((unit) => convertQuantity(1, unit, item.unit, item) !== null);

// ─── Allergens ───────────────────────────────────────────────────────────────

/** The 14 allergens that must be declared under UK food information law (retained EU FIC, Annex II). */
export const allergens = {
  celery: "Celery",
  cereals_gluten: "Cereals containing gluten",
  crustaceans: "Crustaceans",
  eggs: "Eggs",
  fish: "Fish",
  lupin: "Lupin",
  milk: "Milk",
  molluscs: "Molluscs",
  mustard: "Mustard",
  nuts: "Tree nuts",
  peanuts: "Peanuts",
  sesame: "Sesame",
  soybeans: "Soybeans",
  sulphites: "Sulphur dioxide and sulphites",
} as const;
export type AllergenCode = keyof typeof allergens;
export const allergenCodes = Object.keys(allergens) as [AllergenCode, ...AllergenCode[]];

/** In declaration order (the order of `allergens`), without duplicates. */
export const sortAllergens = (codes: Iterable<AllergenCode>): AllergenCode[] => {
  const set = new Set(codes);
  return allergenCodes.filter((code) => set.has(code));
};

// ─── Items ───────────────────────────────────────────────────────────────────

export const foodItemTypes = ["ingredient"] as const;
export const genericItemTypes = [
  "raw_material",
  "component",
  "consumable",
  "spare_part",
  "merchandise",
  "service",
  "packaging",
  "wip",
  "finished",
] as const;
export const itemTypes = [...foodItemTypes, ...genericItemTypes] as const;
export const producibleItemTypes = ["component", "wip", "finished"] as const;
export const isProducibleItem = (type: ItemType) =>
  (producibleItemTypes as readonly ItemType[]).includes(type);
export type ItemType = (typeof itemTypes)[number];
/** Item types that can be despatched to a customer: made goods, goods bought for resale and spare parts. */
export const despatchableItemTypes = [
  "finished",
  "merchandise",
  "spare_part",
] as const satisfies readonly ItemType[];
export const isDespatchableItem = (type: ItemType) =>
  (despatchableItemTypes as readonly ItemType[]).includes(type);
/**
 * Item types that never hold food, so the Food items declaration (allergens, storage, shelf life)
 * doesn't apply: a service is no stock, and spare parts keep equipment running. Every other type
 * can be or can touch food (a recipe line, packaging, goods for resale) and keeps it.
 */
export const nonFoodItemTypes = ["service", "spare_part"] as const satisfies readonly ItemType[];
export const takesFoodDetails = (type: ItemType) => !(nonFoodItemTypes as readonly ItemType[]).includes(type);
/** Item types that can go on a sales order or commitment. Components stay internal. */
export const sellableItemTypes = [
  "finished",
  "wip",
  "merchandise",
  "spare_part",
] as const satisfies readonly ItemType[];
export const isSellableItem = (type: ItemType) => (sellableItemTypes as readonly ItemType[]).includes(type);
export const itemTypeLabels: Record<ItemType, string> = {
  ingredient: "Ingredient",
  raw_material: "Raw material",
  component: "Component",
  consumable: "Consumable",
  spare_part: "Spare part",
  merchandise: "Merchandise",
  service: "Service",
  packaging: "Packaging",
  wip: "Work in progress",
  finished: "Finished good",
};

export const itemStatuses = ["active", "archived"] as const;
export type ItemStatus = (typeof itemStatuses)[number];

export const storageConditions = ["ambient", "chilled", "frozen"] as const;
export type StorageCondition = (typeof storageConditions)[number];
export const storageLabels: Record<StorageCondition, string> = {
  ambient: "Ambient",
  chilled: "Chilled",
  frozen: "Frozen",
};

const allergenList = z
  .array(z.enum(allergenCodes))
  .max(allergenCodes.length)
  .transform((codes) => sortAllergens(codes));
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const positive = z.number().positive().finite();
/** `YYYY-MM-DD`. */
const isoDate = z.iso.date();

export const itemSupplierLinkSchema = z.object({
  supplierId: z.uuid(),
  supplierCode: optionalText(80).optional(),
  preferred: z.boolean().optional(),
});

const foodItemFields = {
  allergens: allergenList,
  mayContain: allergenList,
  storage: z.enum(storageConditions),
  shelfLifeDays: z.number().int().min(0).max(3650).nullable(),
};
export const foodItemFieldNames = Object.keys(foodItemFields) as (keyof typeof foodItemFields)[];
export const foodItemPatchSchema = z.object(foodItemFields).partial();
export type FoodItemPatch = z.infer<typeof foodItemPatchSchema>;

export function hasFoodItemFields(input: FoodItemPatch) {
  return foodItemFieldNames.some((key) => input[key] !== undefined);
}

const itemFields = {
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  type: z.enum(itemTypes),
  unit: z.enum(unitCodes),
  description: optionalText(2000),
  densityGPerMl: positive.max(100).nullable(),
  unitWeightG: positive.max(10_000_000).nullable(),
  ...foodItemFields,
  standardCost: z.number().min(0).max(1_000_000_000).nullable(),
  /** Replaces the item's supplier links. */
  suppliers: z
    .array(itemSupplierLinkSchema)
    .max(20)
    .refine((list) => new Set(list.map((s) => s.supplierId)).size === list.length, "Duplicate supplier"),
};

export const itemCreateSchema = z.object({
  /** Client-generated id, like tasks. */
  id: z.uuid().optional(),
  code: itemFields.code,
  name: itemFields.name,
  type: itemFields.type,
  unit: itemFields.unit,
  description: itemFields.description.optional(),
  densityGPerMl: itemFields.densityGPerMl.optional(),
  unitWeightG: itemFields.unitWeightG.optional(),
  ...foodItemPatchSchema.shape,
  standardCost: itemFields.standardCost.optional(),
  suppliers: itemFields.suppliers.optional(),
});
export type ItemCreateInput = z.infer<typeof itemCreateSchema>;

export const itemUpdateSchema = z
  .object({ ...itemFields, status: z.enum(itemStatuses) })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type ItemUpdateInput = z.infer<typeof itemUpdateSchema>;

export const itemListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.enum(itemTypes).optional(),
  /** Default: active items only. */
  status: z.enum([...itemStatuses, "all"]).default("active"),
  /** Items that contain (or may contain) this allergen. */
  allergen: z.enum(allergenCodes).optional(),
  supplierId: z.uuid().optional(),
  /** `true`: only items that can go on a sales order (`sellableItemTypes`). */
  sellable: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ItemListQuery = z.infer<typeof itemListQuerySchema>;

// ─── Suppliers ───────────────────────────────────────────────────────────────

export const supplierApprovalStatuses = ["pending", "approved", "suspended", "rejected"] as const;
export type SupplierApprovalStatus = (typeof supplierApprovalStatuses)[number];
export const supplierApprovalLabels: Record<SupplierApprovalStatus, string> = {
  pending: "Pending approval",
  approved: "Approved",
  suspended: "Suspended",
  rejected: "Rejected",
};

const supplierFields = {
  name: z.string().trim().min(1).max(200),
  code: optionalText(40),
  contactName: optionalText(200),
  email: z
    .union([z.email().max(320), z.literal("")])
    .transform((v) => v || null)
    .nullable(),
  phone: optionalText(60),
  address: optionalText(1000),
  notes: optionalText(4000),
  certification: optionalText(200),
  certificateExpiresOn: isoDate.nullable(),
  /** Goods (ingredients, packaging) or a service provider (pest control, laboratory, cleaning, transport). */
  category: z.enum(supplierCategories),
  /** For a service provider: what they do. */
  serviceType: optionalText(100),
};

export const supplierCreateSchema = z.object({
  id: z.uuid().optional(),
  name: supplierFields.name,
  code: supplierFields.code.optional(),
  contactName: supplierFields.contactName.optional(),
  email: supplierFields.email.optional(),
  phone: supplierFields.phone.optional(),
  address: supplierFields.address.optional(),
  notes: supplierFields.notes.optional(),
  certification: supplierFields.certification.optional(),
  certificateExpiresOn: supplierFields.certificateExpiresOn.optional(),
  category: supplierFields.category.optional(),
  serviceType: supplierFields.serviceType.optional(),
});
export type SupplierCreateInput = z.infer<typeof supplierCreateSchema>;

export const supplierUpdateSchema = z
  .object(supplierFields)
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type SupplierUpdateInput = z.infer<typeof supplierUpdateSchema>;

/** A supplier approval decision: a food-safety sign-off, made by a person with `manage`. */
export const supplierApprovalSchema = z.object({
  status: z.enum(supplierApprovalStatuses),
  note: optionalText(2000).optional(),
  /** When the approval is next reviewed (expected with `approved`). */
  reviewDueOn: isoDate.nullable().optional(),
  /** Approving despite open supplier control issues when they block: why (recorded). */
  controlsOverride: z.string().trim().min(1).max(2000).optional(),
});
export type SupplierApprovalInput = z.infer<typeof supplierApprovalSchema>;

export const supplierListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(supplierApprovalStatuses).optional(),
  category: z.enum(supplierCategories).optional(),
});
export type SupplierListQuery = z.infer<typeof supplierListQuerySchema>;
