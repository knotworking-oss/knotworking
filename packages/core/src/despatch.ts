import { z } from "zod";
import { unitCodes } from "./items";

export const despatchLotParamSchema = z.object({ lotId: z.uuid() });

export const despatchStatuses = ["draft", "confirmed", "voided"] as const;
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();

export const despatchDraftSchema = z
  .object({
    customerId: z.uuid(),
    deliverySiteId: z.uuid().nullable().optional(),
    despatchedOn: z.iso.date(),
    deliveryAddress: z.string().trim().min(1).max(2000).optional(),
    externalReference: optionalText(200).optional(),
    notes: optionalText(4000).optional(),
    lines: z
      .array(
        z.object({
          lotId: z.uuid(),
          locationId: z.uuid(),
          quantity: z.number().positive().finite().max(1_000_000_000),
          unit: z.enum(unitCodes),
        }),
      )
      .min(1)
      .max(100),
  })
  .refine(
    ({ lines }) => new Set(lines.map((l) => `${l.lotId}:${l.locationId}`)).size === lines.length,
    "Combine quantities for the same lot and location into one line",
  );
export const despatchConfirmSchema = z.object({
  commandId: z.uuid(),
  expectedUpdatedAt: z.iso.datetime(),
});
export const despatchVoidSchema = z.object({
  commandId: z.uuid(),
  reason: z.string().trim().min(1).max(2000),
});
export const despatchListQuerySchema = z
  .object({
    status: z.enum([...despatchStatuses, "all"]).default("all"),
    customerId: z.uuid().optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, "From must be on or before to");
export const despatchRecipientQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type DespatchDraftInput = z.infer<typeof despatchDraftSchema>;
export type DespatchConfirmInput = z.infer<typeof despatchConfirmSchema>;
export type DespatchVoidInput = z.infer<typeof despatchVoidSchema>;
export type DespatchListQuery = z.infer<typeof despatchListQuerySchema>;
export type DespatchRecipientQuery = z.infer<typeof despatchRecipientQuerySchema>;
