import { z } from "zod";
import { currencySchema } from "./currency";
import { unitCodes, roundQuantity } from "./items";
const isoDate = z.iso.date();

/** Local ownership now; adapters use stable UUIDs, command receipts and external mappings later. */
export const salesKinds = ["quote", "order"] as const;
export const salesStatuses = ["draft", "issued", "confirmed", "cancelled"] as const;
const text = (max: number) => z.string().trim().min(1).max(max);
const note = z.string().trim().max(4000).default("");
const command = { commandId: z.uuid() };
const reviewed = { ...command, expectedRevision: z.number().int().positive() };
export const salesPriceValueSchema = z
  .number()
  .finite()
  .min(0)
  .max(99_999_999)
  .transform((v) => roundQuantity(v, 8));
export const salesLineSchema = z.object({
  id: z.uuid().optional(),
  itemId: z.uuid(),
  quantity: z
    .number()
    .finite()
    .positive()
    .max(1_000_000_000)
    .refine((v) => roundQuantity(v, 4) > 0, "Quantity rounds to zero"),
  unit: z.enum(unitCodes),
  dueOn: isoDate,
  /** Omit to resolve an applicable customer price; zero is an explicit free-of-charge price. */
  unitPrice: salesPriceValueSchema.optional(),
  note: z.string().trim().max(500).default(""),
});
export const salesDocumentSchema = z
  .object({
    customerId: z.uuid(),
    deliverySiteId: z.uuid().nullable().default(null),
    customerReference: z.string().trim().max(120).default(""),
    currency: currencySchema,
    validUntil: isoDate.nullable().default(null),
    terms: note,
    notes: note,
    lines: z.array(salesLineSchema).min(1).max(200),
  })
  .refine((v) => {
    const ids = v.lines.flatMap((l) => (l.id ? [l.id] : []));
    return new Set(ids).size === ids.length;
  }, "Line IDs must be unique");
export const salesCreateSchema = z.object({
  ...command,
  kind: z.enum(salesKinds),
  document: salesDocumentSchema,
});
export const salesSaveSchema = z.object({ ...reviewed, document: salesDocumentSchema, reason: text(2000) });
export const salesActionSchema = z.object({ ...reviewed, reason: text(2000) });
export const salesPriceSchema = z
  .object({
    ...command,
    customerId: z.uuid(),
    itemId: z.uuid(),
    unit: z.enum(unitCodes),
    currency: currencySchema,
    unitPrice: salesPriceValueSchema,
    validFrom: isoDate,
    validTo: isoDate.nullable().default(null),
    contractReference: text(200),
    terms: note,
  })
  .refine((v) => !v.validTo || v.validTo >= v.validFrom, "End date precedes start date");
export const salesPriceArchiveSchema = z.object({ ...command, reason: text(2000) });
export const salesFulfilSchema = z.object({
  ...reviewed,
  orderLineId: z.uuid(),
  despatchLineId: z.uuid(),
  reason: text(2000),
});
export const salesUnlinkSchema = z.object({ ...reviewed, reason: text(2000) });
export const salesExternalTypes = ["order", "price", "customer", "item"] as const;
export const salesExternalSchema = z.object({
  ...command,
  system: text(80),
  entityType: z.enum(salesExternalTypes),
  entityId: z.uuid(),
  externalId: text(200),
});
export const salesListSchema = z.object({
  kind: z.enum(salesKinds).optional(),
  status: z.enum(salesStatuses).optional(),
  customerId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const salesPageSchema = salesListSchema.pick({ limit: true, offset: true });
export const salesCommitmentsSchema = z
  .object({ from: isoDate, to: isoDate, ...salesPageSchema.shape })
  .refine(
    (v) => v.to >= v.from && (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 366,
    "Choose a range of up to 367 days",
  );

export type SalesDocumentInput = z.infer<typeof salesDocumentSchema>;
export type SalesCreateInput = z.infer<typeof salesCreateSchema>;
export type SalesSaveInput = z.infer<typeof salesSaveSchema>;
export type SalesActionInput = z.infer<typeof salesActionSchema>;
export type SalesPriceInput = z.infer<typeof salesPriceSchema>;
export type SalesFulfilInput = z.infer<typeof salesFulfilSchema>;
export type SalesListQuery = z.infer<typeof salesListSchema>;
export type SalesPageQuery = z.infer<typeof salesPageSchema>;
export type SalesExternalInput = z.infer<typeof salesExternalSchema>;
export type SalesCommitmentsQuery = z.infer<typeof salesCommitmentsSchema>;
export interface SalesRecipientSnapshot {
  code: string;
  name: string;
  address: string;
  deliveryAddress: string;
  deliverySiteCode: string | null;
  deliverySiteName: string | null;
}

/** Exact decimal multiplication for persisted 4dp quantities × 8dp unit prices; round once per line. */
export function salesLineValue(quantity: number, unitPrice: number, digits = 2): string {
  const scaled = (value: number, places: number) => BigInt(value.toFixed(places).replace(".", ""));
  const divisor = 10n ** BigInt(12 - digits);
  const value = (scaled(quantity, 4) * scaled(unitPrice, 8) + divisor / 2n) / divisor;
  const whole = value / 10n ** BigInt(digits);
  return digits
    ? `${whole}.${(value % 10n ** BigInt(digits)).toString().padStart(digits, "0")}`
    : String(whole);
}

/** Sum already rounded line values without binary floating-point addition. */
export function salesTotal(values: readonly string[], digits = 2): string {
  const total = values.reduce((sum, value) => sum + BigInt(value.replace(".", "")), 0n);
  const scale = 10n ** BigInt(digits);
  return digits ? `${total / scale}.${(total % scale).toString().padStart(digits, "0")}` : String(total);
}
