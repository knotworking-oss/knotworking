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
/** A partial update: fields left out keep their saved value. */
export const invoicingSettingsSchema = z
  .object({
    taxRegistrationNumber: z
      .string()
      .trim()
      .max(40)
      .transform((v) => v || null)
      .nullable()
      .optional(),
    /** Four-eyes: whoever drafted or last edited a draft can't approve or issue it. */
    requireSecondApprover: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), "Change at least one setting");
export type InvoicingSettingsInput = z.infer<typeof invoicingSettingsSchema>;
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
  /** A line drafted from a source starts at 0% tax until a person chooses its rate. */
  taxPending?: boolean;
  /** Shipment, sales line or original invoice line which produced this line. */
  sourceLineId: string | null;
};
/**
 * A non-blocking note returned with a draft, an edit, an issue decision and a draft read.
 * `backdated`: the document is dated before the latest issued document of the same kind, so its
 * number will not follow date order. Nothing is renumbered or refused.
 */
export type InvoiceWarning = { code: "backdated"; latestNumber: string; latestDate: string };
/** `taxNumber`: the VAT or other tax registration number at drafting, when one was recorded. */
export type InvoiceParty = { name: string; address: string; taxNumber?: string };
