import { roundQuantity } from "./items";
import { z } from "zod";
import {
  baseUnits,
  convertQuantity,
  itemTypes,
  storageConditions,
  unitCodes,
  unitDimension,
  type UnitBridge,
  type UnitCode,
} from "./items";

/**
 * Stock module: locations, lots and an append-only movement ledger.
 *
 * Shared vocabulary, validation schemas and the pure rules (unit conversion at the boundary,
 * lot codes, expiry classification, FEFO picking). No DOM or Node APIs.
 *
 * Quantities in the ledger are always in the base unit of the item's dimension (g, ml or each),
 * rounded to `QUANTITY_DECIMALS` places. A balance is the sum of a lot's movements at a location; the
 * database keeps that sum in `stock_balances` (a trigger on the ledger), so the ledger stays the truth.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const stockLocationStatuses = ["active", "archived"] as const;
export type StockLocationStatus = (typeof stockLocationStatuses)[number];

/** `quarantine`: held until QA releases it. `rejected`: must not be used. */
export const lotStatuses = ["available", "quarantine", "rejected"] as const;
export type LotStatus = (typeof lotStatuses)[number];
export const lotStatusLabels: Record<LotStatus, string> = {
  available: "Available",
  quarantine: "Quarantine",
  rejected: "Rejected",
};

/** `use_by` is a safety date (never use after it); `best_before` is a quality date. */
export const expiryTypes = ["use_by", "best_before"] as const;
export type ExpiryType = (typeof expiryTypes)[number];
export const expiryTypeLabels: Record<ExpiryType, string> = {
  use_by: "Use by",
  best_before: "Best before",
};

/**
 * Ledger row types. `consumption` and `production` are written by the production module (batch
 * records that consume and produce lots); the stock module's routes never post them.
 */
export const stockMovementTypes = [
  "receipt",
  "transfer_out",
  "transfer_in",
  "adjustment",
  "waste",
  "stocktake",
  "despatch",
  "customer_return",
  "consumption",
  "production",
] as const;
export type StockMovementType = (typeof stockMovementTypes)[number];
export const stockMovementTypeLabels: Record<StockMovementType, string> = {
  receipt: "Goods in",
  transfer_out: "Transfer out",
  transfer_in: "Transfer in",
  adjustment: "Adjustment",
  waste: "Waste",
  stocktake: "Stocktake",
  despatch: "Despatch",
  customer_return: "Customer return",
  consumption: "Consumption",
  production: "Production",
};

/** Item types that arrive through goods-in. WIP and finished goods come from production. */
export const receivableItemTypes = [
  "ingredient",
  "packaging",
  "raw_material",
  "component",
  "consumable",
  "spare_part",
  "merchandise",
] as const;

// ─── Quantities ──────────────────────────────────────────────────────────────

/** What the quantity helpers need to know about an item. */
export interface StockItemUnits extends UnitBridge {
  unit: UnitCode;
}

/** The unit an item's ledger quantities are held in: g, ml or each. */
export const itemBaseUnit = (item: Pick<StockItemUnits, "unit">): UnitCode =>
  baseUnits[unitDimension(item.unit)];

/**
 * A quantity entered in `unit`, in the item's base unit and rounded to the ledger's precision.
 * `null` when the unit is of another dimension and the item has no density / unit weight to
 * cross it (never a guess).
 */
export function toBaseQuantity(quantity: number, unit: UnitCode, item: StockItemUnits): number | null {
  const base = convertQuantity(quantity, unit, itemBaseUnit(item), item);
  return base === null ? null : roundQuantity(base);
}

/** A base quantity expressed in the item's own (display) unit. */
export const toDisplayQuantity = (baseQuantity: number, item: Pick<StockItemUnits, "unit">): number =>
  roundQuantity(convertQuantity(baseQuantity, itemBaseUnit(item), item.unit) ?? baseQuantity);

/** A ledger quantity as the API returns it: in the base unit, and in the item's own unit. */
export interface StockAmount {
  base: number;
  baseUnit: UnitCode;
  display: number;
  displayUnit: UnitCode;
}

export const stockAmount = (baseQuantity: number, item: Pick<StockItemUnits, "unit">): StockAmount => ({
  base: roundQuantity(baseQuantity),
  baseUnit: itemBaseUnit(item),
  display: toDisplayQuantity(baseQuantity, item),
  displayUnit: item.unit,
});

// ─── Dates, lot codes and expiry ─────────────────────────────────────────────

/** `YYYY-MM-DD` plus a number of days (calendar arithmetic in UTC, so no daylight-saving drift). */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`); negative when `to` is earlier. */
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The prefix of generated lot codes for a receipt date: `L` + yymmdd + `-`. */
export const lotCodePrefix = (receivedOn: string): string =>
  `L${receivedOn.slice(2, 4)}${receivedOn.slice(5, 7)}${receivedOn.slice(8, 10)}-`;

/** A generated lot code: `L` + yymmdd + a short sequence, e.g. `L261111-003`. */
export const generateLotCode = (receivedOn: string, sequence: number): string =>
  `${lotCodePrefix(receivedOn)}${String(sequence).padStart(3, "0")}`;

export const expiryStates = ["expired", "expiring_soon", "ok"] as const;
export type ExpiryState = (typeof expiryStates)[number];
export const EXPIRING_SOON_DAYS = 7;

/**
 * Where a lot stands against its date on `today`. A lot is good up to and including its date and
 * `expired` from the day after. Lots without a date are `ok`.
 */
export function classifyExpiry(
  expiresOn: string | null | undefined,
  today: string,
  soonDays = EXPIRING_SOON_DAYS,
): ExpiryState {
  if (!expiresOn) return "ok";
  const days = daysBetween(today, expiresOn);
  if (days < 0) return "expired";
  return days <= soonDays ? "expiring_soon" : "ok";
}

// ─── FEFO picking ────────────────────────────────────────────────────────────

/** One lot's balance at one location, as the picker needs it. */
export interface PickCandidate {
  lotId: string;
  locationId: string;
  /** On hand, in the item's base unit. */
  quantity: number;
  status: LotStatus;
  expiresOn: string | null;
  expiryType: ExpiryType | null;
  receivedOn: string;
  /** Final tie-break, so the suggestion is stable. */
  lotCode?: string;
}

export interface PickAllocation<T extends PickCandidate = PickCandidate> {
  candidate: T;
  /** How much to take from this lot at this location, in the base unit. */
  quantity: number;
  /** The lot is past a best-before date: still usable, but someone should look at it. */
  pastBestBefore: boolean;
}

export interface PickResult<T extends PickCandidate = PickCandidate> {
  allocations: PickAllocation<T>[];
  allocated: number;
  /** What could not be found; 0 when the stock covers the requirement. */
  shortfall: number;
}

/** Whether a lot may be picked on `today`: released by QA and not past a use-by date. */
export const isPickable = (
  lot: Pick<PickCandidate, "status" | "expiresOn" | "expiryType" | "quantity">,
  today: string,
): boolean =>
  lot.status === "available" &&
  lot.quantity > 0 &&
  !(lot.expiryType === "use_by" && lot.expiresOn !== null && lot.expiresOn < today);

/**
 * First expired, first out. Allocates `required` (base unit) across lot balances:
 *
 *  - only `available` lots (quarantined and rejected stock is never picked);
 *  - never a lot past its `use_by` date (a lot is usable on the date itself). A lot past a
 *    `best_before` date is a quality question, not a safety one: it stays pickable, comes first
 *    (it has the earliest date) and is flagged `pastBestBefore`;
 *  - earliest expiry first, lots without an expiry last, ties by received date, then lot code.
 *
 * Pure: it suggests, it reserves nothing.
 */
export function pickFefo<T extends PickCandidate>(
  candidates: readonly T[],
  required: number,
  today: string,
): PickResult<T> {
  const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const ordered = candidates
    .filter((c) => isPickable(c, today))
    .sort(
      (a, b) =>
        (a.expiresOn === null ? 1 : 0) - (b.expiresOn === null ? 1 : 0) ||
        text(a.expiresOn ?? "", b.expiresOn ?? "") ||
        text(a.receivedOn, b.receivedOn) ||
        text(a.lotCode ?? "", b.lotCode ?? "") ||
        text(a.lotId, b.lotId) ||
        text(a.locationId, b.locationId),
    );
  const allocations: PickAllocation<T>[] = [];
  let remaining = roundQuantity(Math.max(required, 0));
  for (const candidate of ordered) {
    if (remaining <= 0) break;
    const quantity = roundQuantity(Math.min(candidate.quantity, remaining));
    allocations.push({
      candidate,
      quantity,
      pastBestBefore: candidate.expiresOn !== null && candidate.expiresOn < today,
    });
    remaining = roundQuantity(remaining - quantity);
  }
  return {
    allocations,
    allocated: roundQuantity(allocations.reduce((sum, a) => sum + a.quantity, 0)),
    shortfall: remaining,
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const requiredText = (max: number) => z.string().trim().min(1).max(max);
/** `YYYY-MM-DD`. */
const isoDate = z.iso.date();
const MAX_QUANTITY = 1_000_000_000_000;
const positiveQuantity = z.number().positive().finite().max(MAX_QUANTITY);
const flag = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");
const paging = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};
const withinDays = z.coerce.number().int().min(0).max(3650).optional();

const locationFields = {
  name: requiredText(120),
  code: optionalText(40),
  storage: z.enum(storageConditions),
  status: z.enum(stockLocationStatuses),
};

export const stockLocationCreateSchema = z.object({
  id: z.uuid().optional(),
  name: locationFields.name,
  code: locationFields.code.optional(),
  storage: locationFields.storage.optional(),
});
export type StockLocationCreateInput = z.infer<typeof stockLocationCreateSchema>;

export const stockLocationUpdateSchema = z
  .object(locationFields)
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type StockLocationUpdateInput = z.infer<typeof stockLocationUpdateSchema>;

export const stockLocationListQuerySchema = z.object({
  /** Default: active locations only. */
  status: z.enum([...stockLocationStatuses, "all"]).default("active"),
});
export type StockLocationListQuery = z.infer<typeof stockLocationListQuerySchema>;

/** Goods-in: creates a lot and its `receipt` movement. */
export const stockReceiptSchema = z
  .object({
    commandId: z.uuid().optional(),
    itemId: z.uuid(),
    quantity: positiveQuantity,
    unit: z.enum(unitCodes),
    locationId: z.uuid(),
    receivedOn: isoDate,
    /** Generated (`L` + yymmdd + sequence) when left out. */
    lotCode: optionalText(60).optional(),
    supplierId: z.uuid().nullable().optional(),
    /** The supplier's own batch code: one step back in the trace. */
    supplierLotCode: optionalText(80).optional(),
    expiresOn: isoDate.nullable().optional(),
    expiryType: z.enum(expiryTypes).nullable().optional(),
    /** e.g. the delivery note number. */
    reference: optionalText(120).optional(),
    /** Receive straight into quarantine (required for a supplier whose approval is pending). */
    status: z.enum(["available", "quarantine"]).optional(),
    notes: optionalText(2000).optional(),
    /** Required when receiving WIP or finished goods (opening balances; needs `manage`). */
    reason: optionalText(500).optional(),
  })
  .refine((v) => !v.expiresOn || !!v.expiryType, {
    path: ["expiryType"],
    message: "Say whether the date is a use-by or a best-before date",
  })
  .refine((v) => !v.expiryType || !!v.expiresOn, {
    path: ["expiresOn"],
    message: "An expiry type needs an expiry date",
  })
  .refine((v) => !v.expiresOn || v.expiresOn >= v.receivedOn, {
    path: ["expiresOn"],
    message: "The expiry date is before the received date",
  });
export type StockReceiptInput = z.infer<typeof stockReceiptSchema>;

export const stockTransferSchema = z
  .object({
    lotId: z.uuid(),
    fromLocationId: z.uuid(),
    toLocationId: z.uuid(),
    quantity: positiveQuantity,
    unit: z.enum(unitCodes),
    reason: optionalText(500).optional(),
    reference: optionalText(120).optional(),
  })
  .refine((v) => v.fromLocationId !== v.toLocationId, {
    path: ["toLocationId"],
    message: "Choose a different location to move the stock to",
  });
export type StockTransferInput = z.infer<typeof stockTransferSchema>;

/** Stock thrown away. Destroys stock, so it is posted by a signed-in person. */
export const stockWasteSchema = z.object({
  lotId: z.uuid(),
  locationId: z.uuid(),
  quantity: positiveQuantity,
  unit: z.enum(unitCodes),
  reason: requiredText(500),
  reference: optionalText(120).optional(),
});
export type StockWasteInput = z.infer<typeof stockWasteSchema>;

/** A signed correction: positive adds stock, negative removes it. Needs `manage` and a person. */
export const stockAdjustmentSchema = z.object({
  lotId: z.uuid(),
  locationId: z.uuid(),
  quantity: z
    .number()
    .finite()
    .min(-MAX_QUANTITY)
    .max(MAX_QUANTITY)
    .refine((v) => v !== 0, "The adjustment can't be zero"),
  unit: z.enum(unitCodes),
  reason: requiredText(500),
  reference: optionalText(120).optional(),
});
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;

/**
 * Quarantine, release or reject a lot: a QA sign-off, made by a person with `manage`. A blocked
 * release goes through a release exception request instead (two people).
 */
export const lotStatusChangeSchema = z.object({
  status: z.enum(lotStatuses),
  note: requiredText(2000),
});
export type LotStatusChangeInput = z.infer<typeof lotStatusChangeSchema>;

export const stocktakeSchema = z.object({
  counts: z
    .array(
      z.object({
        lotId: z.uuid(),
        locationId: z.uuid(),
        countedQuantity: z.number().min(0).finite().max(MAX_QUANTITY),
        unit: z.enum(unitCodes),
      }),
    )
    .min(1)
    .max(500)
    .refine(
      (list) => new Set(list.map((c) => `${c.lotId}:${c.locationId}`)).size === list.length,
      "A lot is counted twice at the same location",
    ),
  /** Shared by the movements this stocktake posts; generated when left out. */
  reference: optionalText(120).optional(),
  reason: optionalText(500).optional(),
});
export type StocktakeInput = z.infer<typeof stocktakeSchema>;

export const stockMovementReverseSchema = z.object({ reason: requiredText(500) });
export type StockMovementReverseInput = z.infer<typeof stockMovementReverseSchema>;

export const stockLevelsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  itemType: z.enum(itemTypes).optional(),
  locationId: z.uuid().optional(),
  /** Items with a lot in stock that expires within this many days (0 = today or already expired). */
  expiringWithinDays: withinDays,
  /** Also list active items with nothing in stock. */
  includeZero: flag,
  ...paging,
});
export type StockLevelsQuery = z.infer<typeof stockLevelsQuerySchema>;

export const stockLotListQuerySchema = z.object({
  itemId: z.uuid().optional(),
  status: z.enum(lotStatuses).optional(),
  locationId: z.uuid().optional(),
  expiringWithinDays: withinDays,
  /** Matches the lot code or the supplier's lot code. */
  q: z.string().trim().max(200).optional(),
  /** Also list lots with nothing left. */
  includeEmpty: flag,
  /** `fefo` (default): first expiring first. `newest`: latest received first, for pickers of past lots. */
  order: z.enum(["fefo", "newest"]).default("fefo"),
  ...paging,
});
export type StockLotListQuery = z.infer<typeof stockLotListQuerySchema>;

export const stockMovementListQuerySchema = z.object({
  itemId: z.uuid().optional(),
  lotId: z.uuid().optional(),
  type: z.enum(stockMovementTypes).optional(),
  /** Inclusive dates (`YYYY-MM-DD`, UTC) on `occurredAt`. */
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...paging,
});
export type StockMovementListQuery = z.infer<typeof stockMovementListQuerySchema>;

export const stockPickQuerySchema = z.object({
  quantity: z.coerce.number().positive().finite().max(MAX_QUANTITY),
  unit: z.enum(unitCodes),
});
export type StockPickQuery = z.infer<typeof stockPickQuerySchema>;
