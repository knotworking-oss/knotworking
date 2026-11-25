import { z } from "zod";
import { currencySchema } from "./currency";

export const invoiceSourceModules = {
  sales: "sales",
  despatch: "despatch",
  service: "client_services",
} as const;

const description = z.string().trim().min(1).max(200);
export const invoiceQuantity = z.string().regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/);
export const invoicePrice = z.string().regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/);
export const invoiceTaxRate = z
  .number()
  .finite()
  .min(0)
  .max(100)
  .refine((rate) => Number(rate.toFixed(4)) === rate);
const reason = z.string().trim().min(1).max(2000);
const commandId = z.uuid();
const dates = {
  date: z.iso.date(),
  dueDate: z.iso.date(),
  issuerAddress: z.string().trim().max(600).optional(),
};

export const invoiceManualLineSchema = z.object({
  description,
  unit: z.string().trim().max(24).default(""),
  quantity: invoiceQuantity.refine((v) => Number(v) > 0),
  unitPrice: invoicePrice,
  taxRate: invoiceTaxRate,
});

const manualLines = z.array(invoiceManualLineSchema).min(1).max(500);
export const invoiceDraftSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("manual"),
    commandId,
    ...dates,
    customerId: z.uuid(),
    currency: currencySchema,
    lines: manualLines,
  }),
  z.object({
    kind: z.enum(["sales", "despatch", "service"]),
    commandId,
    ...dates,
    sourceId: z.uuid(),
  }),
  z.object({
    kind: z.literal("credit"),
    commandId,
    date: z.iso.date(),
    sourceId: z.uuid(),
    lineIds: z.array(z.uuid()).min(1).max(500),
    reason,
  }),
]);

export const invoiceEditSchema = z.object({
  commandId,
  ...dates,
  expectedRevision: z.number().int().positive(),
  lines: manualLines.optional(),
  pricing: z
    .array(z.object({ id: z.uuid(), taxRate: invoiceTaxRate, unitPrice: invoicePrice }))
    .max(500)
    .optional(),
});

export const invoiceDecisionSchema = z.object({
  commandId,
  expectedRevision: z.number().int().positive(),
  action: z.enum(["issue", "discard"]),
  reason,
});
export const invoiceListSchema = z.object({
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export type InvoiceDraftInput = z.infer<typeof invoiceDraftSchema>;
export type InvoiceEditInput = z.infer<typeof invoiceEditSchema>;
export type InvoiceDecisionInput = z.infer<typeof invoiceDecisionSchema>;
export type InvoiceSource = InvoiceDraftInput["kind"];
export type InvoiceManualLine = z.infer<typeof invoiceManualLineSchema>;
export type InvoiceLine = InvoiceManualLine & {
  id: string;
  net: string;
  tax: string;
  priceLocked: boolean;
  pricePending?: boolean;
  /** Shipment, sales line or original invoice line which produced this line. */
  sourceLineId: string | null;
};
export type InvoiceParty = { name: string; address: string };
