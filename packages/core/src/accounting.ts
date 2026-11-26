import { z } from "zod";
import { currencyDigits, currencySchema } from "./currency";

const label = z.string().trim().min(1).max(200);
/** Open identifiers let separately maintained adapters extend the shared contract. */
export const accountingProviderSchema = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
// Canonical decimal strings. The document currency determines the required precision.
export const accountingAmountSchema = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,4})?$/);
const minorUnits = (value: string) => BigInt(value.replace(".", ""));
function validPrecision(currency: string, amounts: string[], ctx: z.RefinementCtx): boolean {
  if (amounts.some((amount) => !accountingAmountSchema.safeParse(amount).success)) return false;
  if (!currencySchema.safeParse(currency).success) return false;
  const digits = currencyDigits(currency);
  if (amounts.some((amount) => (amount.split(".")[1]?.length ?? 0) !== digits)) {
    ctx.addIssue({
      code: "custom",
      message: `Amounts in ${currency} must have exactly ${digits} decimal places`,
    });
    return false;
  }
  return true;
}
const destination = {
  provider: accountingProviderSchema,
  connectionId: z.uuid(),
  companyId: label,
};
const postingFields = {
  version: z.literal(1),
  ...destination,
  sourceId: z.uuid(),
  sourceRevision: z.number().int().positive(),
  reference: label,
  date: z.iso.date(),
  currency: currencySchema,
  lines: z
    .array(
      z
        .object({
          accountReference: label,
          taxReference: label,
          description: label,
          net: accountingAmountSchema,
          tax: accountingAmountSchema,
        })
        .strict(),
    )
    .min(1)
    .max(500),
  net: accountingAmountSchema,
  tax: accountingAmountSchema,
  gross: accountingAmountSchema,
};
export const accountingPostingSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...postingFields,
      kind: z.literal("purchase_invoice"),
      supplierReference: label,
      dueDate: z.iso.date().optional(),
    }),
    z.strictObject({
      ...postingFields,
      kind: z.literal("customer_invoice"),
      customerReference: label,
      dueDate: z.iso.date(),
    }),
    z.strictObject({
      ...postingFields,
      kind: z.literal("customer_credit_note"),
      customerReference: label,
      originalInvoice: z.strictObject({ externalId: label, reference: label, allocate: z.boolean() }),
    }),
  ])
  .superRefine((v, ctx) => {
    const amounts = [v.net, v.tax, v.gross, ...v.lines.flatMap((l) => [l.net, l.tax])];
    if (!validPrecision(v.currency, amounts, ctx)) return;
    const net = v.lines.reduce((sum, l) => sum + minorUnits(l.net), 0n);
    const tax = v.lines.reduce((sum, l) => sum + minorUnits(l.tax), 0n);
    if (net !== minorUnits(v.net) || tax !== minorUnits(v.tax) || net + tax !== minorUnits(v.gross))
      ctx.addIssue({ code: "custom", message: "Line amounts and document totals must reconcile exactly" });
    if (minorUnits(v.gross) === 0n)
      ctx.addIssue({ code: "custom", message: "A posting must have a positive gross amount" });
  });
export type AccountingPosting = z.infer<typeof accountingPostingSchema>;
export type AccountingPostingState = "queued" | "unknown" | "failed" | "posted";
/**
 * A posted credit note's requested allocation to its original invoice, tracked apart from the credit:
 * `pending` until read back from the ledger, `allocated` once verified, `recorded` when finance settled
 * it in the ledger another way (for example after the invoice was paid). Null when none was requested.
 */
export type AccountingAllocationState = "pending" | "allocated" | "recorded";

/** Read-back from the destination ledger, not an HTTP success or an invented ID. */
export const accountingReceiptSchema = z
  .object({
    ...destination,
    postingKey: z.uuid(),
    externalId: label,
    currency: currencySchema,
    net: accountingAmountSchema,
    tax: accountingAmountSchema,
    gross: accountingAmountSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!validPrecision(v.currency, [v.net, v.tax, v.gross], ctx)) return;
    if (minorUnits(v.net) + minorUnits(v.tax) !== minorUnits(v.gross))
      ctx.addIssue({ code: "custom", message: "Receipt totals must reconcile exactly" });
  });
export type AccountingReceipt = z.infer<typeof accountingReceiptSchema>;

export const accountingConnectionCreateSchema = z
  .object({
    commandId: z.uuid(),
    name: label,
    provider: accountingProviderSchema,
    companyId: z.string().trim().max(200).default(""),
  })
  .strict();
export const accountingConnectionUpdateSchema = z
  .object({
    commandId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    name: label,
    disabled: z.boolean(),
    companyId: z.string().trim().max(200).default(""),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export const accountingMappingKinds = ["supplier", "customer", "account", "tax"] as const;
export const accountingMappingSchema = z
  .object({
    commandId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    kind: z.enum(accountingMappingKinds),
    localReference: label,
    externalReference: label,
    enabled: z.boolean().default(true),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export const accountingPageSchema = z.object({
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export const accountingReferencesSchema = z.object({
  kind: z.enum(["supplier", "customer"]),
  q: z.string().trim().max(200).default(""),
});
/**
 * A finance reviewer's coding of one approved purchase invoice for one connection. Purchasing has a
 * single header VAT amount and unrounded line values, so the reviewer supplies each line's account
 * and tax keys (local names resolved through reviewed mappings) and its net and tax as printed on
 * the supplier's invoice. The server checks them against the approved invoice; nothing is guessed.
 */
export const accountingInvoicePrepareSchema = z
  .object({
    commandId: z.uuid(),
    /** The connection revision reviewed, so mappings cannot change unseen. */
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2000),
    lines: z
      .array(
        z
          .object({
            invoiceLineId: z.uuid(),
            accountKey: label,
            taxKey: label,
            description: label,
            net: accountingAmountSchema,
            tax: accountingAmountSchema,
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = v.lines.map((l) => l.invoiceLineId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "Code each invoice line once" });
  });
export type AccountingInvoicePrepareInput = z.infer<typeof accountingInvoicePrepareSchema>;
export const accountingCustomerPrepareSchema = z
  .strictObject({
    commandId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2000),
    lines: z
      .array(z.strictObject({ id: z.uuid(), accountKey: label, taxKey: label }))
      .max(500)
      .default([]),
    allocate: z.boolean().default(false),
  })
  .refine(
    (input) => new Set(input.lines.map((line) => line.id)).size === input.lines.length,
    "Code each invoice line once",
  );
export type AccountingCustomerPrepareInput = z.infer<typeof accountingCustomerPrepareSchema>;

export const accountingInvoiceListSchema = accountingPageSchema.extend({
  /** `open`: approved invoices not yet prepared for this connection. */
  show: z.enum(["open", "all"]).default("open"),
});
export const accountingQueueListSchema = accountingPageSchema.extend({
  state: z.enum(["queued", "unknown", "failed", "posted"]).default("queued"),
});
/** Requeue the current definitively rejected attempt. */
export const accountingRetrySchema = z
  .object({ attemptId: z.uuid(), reason: z.string().trim().min(1).max(2000) })
  .strict();
/** Reconcile the current uncertain attempt from a transaction found in the accounting system. */
export const accountingReadBackSchema = z
  .object({ attemptId: z.uuid(), externalId: label.optional(), reason: z.string().trim().min(1).max(2000) })
  .strict();
/** Finish a posted credit's pending allocation (`allocate`), or record that finance settled it in the ledger. */
export const accountingAllocationSchema = z
  .object({ action: z.enum(["allocate", "record"]), reason: z.string().trim().min(1).max(2000) })
  .strict();
/** Catalogue entries are candidates, not installed or authenticated connections. */
export const accountingProviderCandidates = [
  { id: "sage_50_accounts_uk", name: "Sage 50 Accounts (UK)" },
  { id: "xero", name: "Xero" },
  { id: "quickbooks_online", name: "QuickBooks Online" },
] as const;
