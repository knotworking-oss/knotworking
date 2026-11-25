import { z } from "zod";

/**
 * Assets module (`assets`): one register of the business's areas, equipment, vehicles, IT, tools
 * and other assets, usable by any business. Food modules build on it: the HACCP cleaning and
 * calibration schedule (`haccp`) and the site programmes (`site`) keep their own settings per asset
 * and point at rows of this register. No DOM or Node APIs.
 *
 * Assets are archived, never deleted. A code is unique (case-insensitive) among a workspace's live
 * assets when set.
 */

export const assetKinds = ["area", "equipment", "vehicle", "it", "tool", "other"] as const;
export type AssetKind = (typeof assetKinds)[number];
export const assetKindLabels: Record<AssetKind, string> = {
  area: "Area",
  equipment: "Equipment",
  vehicle: "Vehicle",
  it: "IT",
  tool: "Tool",
  other: "Other",
};

export const assetStatuses = ["active", "archived"] as const;
export type AssetStatus = (typeof assetStatuses)[number];
export const assetStatusLabels: Record<AssetStatus, string> = { active: "Active", archived: "Archived" };

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const requiredText = (max: number) => z.string().trim().min(1).max(max);
const twoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

const assetFields = {
  kind: z.enum(assetKinds),
  /** Short reference or asset tag, e.g. `PRB-01`; unique among live assets when set. */
  code: optionalText(40),
  name: requiredText(200),
  /** The area (an asset of kind `area`) this asset is in. An area can sit in another area. */
  parentAreaId: z.uuid().nullable(),
  /** Free-text location within the area or site. */
  location: optionalText(200),
  manufacturer: optionalText(200),
  model: optionalText(200),
  serialNumber: optionalText(200),
  purchasedOn: z.iso.date().nullable(),
  /** What it cost, in the workspace currency. */
  purchaseCost: z
    .number()
    .finite()
    .min(0)
    .max(10_000_000_000)
    .refine(twoDecimals, "At most 2 decimal places")
    .nullable(),
  warrantyExpiresOn: z.iso.date().nullable(),
  /** The member who looks after it. */
  custodianId: z.uuid().nullable(),
  notes: optionalText(4000),
};

export const assetCreateSchema = z.object({
  id: z.uuid().optional(),
  kind: assetFields.kind,
  code: assetFields.code.optional(),
  name: assetFields.name,
  parentAreaId: assetFields.parentAreaId.optional(),
  location: assetFields.location.optional(),
  manufacturer: assetFields.manufacturer.optional(),
  model: assetFields.model.optional(),
  serialNumber: assetFields.serialNumber.optional(),
  purchasedOn: assetFields.purchasedOn.optional(),
  purchaseCost: assetFields.purchaseCost.optional(),
  warrantyExpiresOn: assetFields.warrantyExpiresOn.optional(),
  custodianId: assetFields.custodianId.optional(),
  notes: assetFields.notes.optional(),
});
export type AssetCreateInput = z.infer<typeof assetCreateSchema>;

/**
 * A change to an asset. Archiving and restoring are separate actions (`manage`). `expectedRevision`
 * refuses the change when someone else changed the asset since it was read.
 */
export const assetUpdateSchema = z
  .object({ ...assetFields, expectedRevision: z.number().int().min(1) })
  .partial()
  .refine(
    ({ expectedRevision: _r, ...patch }) => Object.values(patch).some((v) => v !== undefined),
    "Nothing to update",
  );
export type AssetUpdateInput = z.infer<typeof assetUpdateSchema>;

export const assetListQuerySchema = z.object({
  /** Matches name, code, serial number, manufacturer or model. */
  q: z.string().trim().max(200).optional(),
  kind: z.enum(assetKinds).optional(),
  /** Assets directly in this area. */
  areaId: z.uuid().optional(),
  status: z.enum([...assetStatuses, "all"]).default("active"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AssetListQuery = z.infer<typeof assetListQuerySchema>;
