import { z } from "zod";
import { currencyDigits, currencySchema } from "./currency";
import { salesLineValue, salesPriceValueSchema } from "./sales";

export const serviceQuoteStatuses = ["draft", "issued", "accepted", "delivered", "cancelled"] as const;
export type ServiceQuoteStatus = (typeof serviceQuoteStatuses)[number];
export const serviceQuoteStatusLabels = {
  draft: "Draft",
  issued: "Issued",
  accepted: "In delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
} satisfies Record<ServiceQuoteStatus, string>;

const minutes = z.number().int().min(1).max(6_000_000);
const serviceQuoteFields = z.object({
  customerId: z.uuid(),
  title: z.string().trim().min(1).max(160),
  scope: z.string().trim().min(1).max(4000),
  currency: currencySchema,
  unitPrice: salesPriceValueSchema,
  quotedMinutes: minutes.nullable(),
  deliveryDate: z.iso.date().nullable(),
});
const command = { commandId: z.uuid() };
const revision = { expectedRevision: z.number().int().positive() };
export const serviceQuoteCreateSchema = serviceQuoteFields.extend(command);
export const serviceQuoteUpdateSchema = serviceQuoteCreateSchema.extend(revision);
const decision = z.object({ ...command, ...revision, reason: z.string().trim().min(1).max(2000) });
export const serviceQuoteDecisionSchema = z.discriminatedUnion("action", [
  decision.extend({ action: z.literal("issue") }),
  decision.extend({ action: z.literal("accept"), teamId: z.uuid(), leadId: z.uuid() }),
  decision.extend({ action: z.literal("deliver"), approvedMinutes: minutes.nullable() }),
  decision.extend({ action: z.literal("cancel") }),
]);
export const serviceQuoteListSchema = z.object({
  before: z.uuid().optional(),
  status: z.enum(serviceQuoteStatuses).optional(),
});

export type ServiceQuoteCreateInput = z.infer<typeof serviceQuoteCreateSchema>;
export type ServiceQuoteUpdateInput = z.infer<typeof serviceQuoteUpdateSchema>;
export type ServiceQuoteDecisionInput = z.infer<typeof serviceQuoteDecisionSchema>;

/** Price a fixed delivery or exact approved minutes, rounding once to the currency unit. */
export function serviceQuoteAmount(
  unitPrice: number,
  durationMinutes: number | null,
  currency: string,
): string {
  const digits = currencyDigits(currency);
  if (durationMinutes === null) return salesLineValue(1, unitPrice, digits);
  const price = BigInt(unitPrice.toFixed(8).replace(".", ""));
  const divisor = 60n * 10n ** BigInt(8 - digits);
  const value = (price * BigInt(durationMinutes) + divisor / 2n) / divisor;
  const unit = 10n ** BigInt(digits);
  return digits ? `${value / unit}.${String(value % unit).padStart(digits, "0")}` : String(value);
}
