import { z } from "zod";
import { roundQuantity } from "./items";
import { PRICE_DECIMALS, VALUE_DECIMALS } from "./purchasing";

/**
 * Purchasing module: a supplier's credit notes. A credit note is its own document against one
 * approved invoice, with the supplier's credit note number. Its lines credit lines of that invoice
 * or credited charges (carriage). Amounts are plain numbers: positive here, subtracted wherever
 * they are used. No DOM or Node APIs.
 *
 * - **Price credits** (`price`) lower what a line cost (an invoiced price was too high, a rebate
 *   was agreed after the fact): the credited value is spread over the quantity invoiced.
 * - **Goods returned** (`goods_returned`) credit units sent back: the credited value comes off the
 *   line along with the returned quantity, so the cost per unit of what was kept is unchanged when
 *   the credit is at the invoice price. The stock side is the stock module's reversal.
 * - **Costing** reads the approved credit notes of an order line (`ApprovedCreditTotals`), so the
 *   invoice price a lot is costed at is net of its credits; the append-only receipts stay as they
 *   were.
 * - **Approval** is a person's act (API tokens refused) and makes the credit note immutable. A wrong
 *   one is voided with a reason (the credit then no longer counts) and entered again.
 */

export const purchaseCreditNoteStatuses = ["draft", "approved", "voided"] as const;
export type PurchaseCreditNoteStatus = (typeof purchaseCreditNoteStatuses)[number];
export const purchaseCreditNoteStatusLabels: Record<PurchaseCreditNoteStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  voided: "Voided",
};

/** `invoice_line`: credits a line of the invoice. `charge`: a credited charge (carriage). */
export const purchaseCreditLineKinds = ["invoice_line", "charge"] as const;
export type PurchaseCreditLineKind = (typeof purchaseCreditLineKinds)[number];

export const purchaseCreditLineReasons = ["price", "goods_returned"] as const;
export type PurchaseCreditLineReason = (typeof purchaseCreditLineReasons)[number];
export const purchaseCreditLineReasonLabels: Record<PurchaseCreditLineReason, string> = {
  price: "Price reduction",
  goods_returned: "Goods returned",
};

/** What approved credit notes take off one order line, per the order line's unit. */
export interface ApprovedCreditTotals {
  /** Credited value (money). */
  value: number;
  /** Units credited as returned. */
  returnedQuantity: number;
}

/** A credit line's value: quantity × credited price, as money. */
export const creditLineValue = (quantity: number, unitPrice: number) =>
  roundQuantity(quantity * unitPrice, VALUE_DECIMALS);

/** One credit line, as the caps need it. */
export interface CreditLike {
  kind: PurchaseCreditLineKind;
  reason: PurchaseCreditLineReason | null;
  quantity: number;
  unitPrice: number;
}

/** Credited value and returned quantity over some lines. */
export function creditTotals(lines: readonly CreditLike[]): ApprovedCreditTotals {
  let value = 0;
  let returnedQuantity = 0;
  for (const l of lines) {
    value += creditLineValue(l.quantity, l.unitPrice);
    if (l.kind === "invoice_line" && l.reason === "goods_returned") returnedQuantity += l.quantity;
  }
  return { value: roundQuantity(value, VALUE_DECIMALS), returnedQuantity: roundQuantity(returnedQuantity) };
}

/**
 * Whether crediting `adding` on top of what is `already` credited stays within what the invoice
 * line billed (`quantity` × `unitPrice`): the value may not exceed it, nor the returned quantity
 * the quantity. Null when it does; otherwise what is wrong.
 */
export function creditExcess(
  invoiceLine: { quantity: number; unitPrice: number },
  already: ApprovedCreditTotals,
  adding: ApprovedCreditTotals,
): "value" | "quantity" | null {
  const billed = creditLineValue(invoiceLine.quantity, invoiceLine.unitPrice);
  if (roundQuantity(already.value + adding.value, VALUE_DECIMALS) > billed) return "value";
  if (roundQuantity(already.returnedQuantity + adding.returnedQuantity) > roundQuantity(invoiceLine.quantity))
    return "quantity";
  return null;
}

/** Net (the lines), VAT credited and gross. */
export function creditNoteTotals(lines: readonly CreditLike[], vat: number) {
  const net = creditTotals(lines).value;
  return { net, vat: roundQuantity(vat, VALUE_DECIMALS), gross: roundQuantity(net + vat, VALUE_DECIMALS) };
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const requiredText = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.iso.date();
const positiveQuantity = z.number().positive().finite().max(1_000_000_000);
const price = z
  .number()
  .min(0)
  .finite()
  .max(1_000_000_000)
  .transform((v) => roundQuantity(v, PRICE_DECIMALS));
const money = z
  .number()
  .min(0)
  .finite()
  .max(1_000_000_000)
  .transform((v) => roundQuantity(v, VALUE_DECIMALS));

export const PURCHASE_CREDIT_NOTE_MAX_LINES = 200;

const invoiceLineCredit = z.object({
  kind: z.literal("invoice_line"),
  /** The invoice line credited (an order line of the credited invoice). */
  invoiceLineId: z.uuid(),
  reason: z.enum(purchaseCreditLineReasons),
  /** In the invoice line's unit: the quantity the credit covers (or that is returned). */
  quantity: positiveQuantity,
  /** Credited per unit. */
  unitPrice: price,
  description: optionalText(200).optional(),
});
const chargeCredit = z.object({
  kind: z.literal("charge"),
  /** What is credited: "Carriage". */
  description: requiredText(200),
  quantity: positiveQuantity.default(1),
  unitPrice: price,
});
export const purchaseCreditLineSchema = z.discriminatedUnion("kind", [invoiceLineCredit, chargeCredit]);
export type PurchaseCreditLineInput = z.infer<typeof purchaseCreditLineSchema>;

const lines = z
  .array(purchaseCreditLineSchema)
  .max(PURCHASE_CREDIT_NOTE_MAX_LINES)
  .refine((list) => {
    const ids = list.flatMap((l) => (l.kind === "invoice_line" ? [`${l.invoiceLineId}:${l.reason}`] : []));
    return new Set(ids).size === ids.length;
  }, "An invoice line is credited twice for the same reason; put it on one line");

export const purchaseCreditNoteCreateSchema = z.object({
  id: z.uuid().optional(),
  /** The approved invoice credited; the supplier is its supplier. */
  invoiceId: z.uuid(),
  /** The supplier's own credit note number; unique per supplier. */
  creditNoteNumber: requiredText(60),
  creditDate: isoDate,
  /** VAT credited as a plain amount. */
  vat: money.default(0),
  notes: optionalText(4000).optional(),
  lines: lines.default([]),
});
export type PurchaseCreditNoteCreateInput = z.infer<typeof purchaseCreditNoteCreateSchema>;

export const purchaseCreditNoteUpdateSchema = z
  .object({
    creditNoteNumber: requiredText(60),
    creditDate: isoDate,
    vat: money,
    notes: optionalText(4000),
    lines,
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type PurchaseCreditNoteUpdateInput = z.infer<typeof purchaseCreditNoteUpdateSchema>;

export const purchaseCreditNoteVoidSchema = z.object({ reason: requiredText(500) });
export type PurchaseCreditNoteVoidInput = z.infer<typeof purchaseCreditNoteVoidSchema>;

/** `current`: drafts and approved credit notes (voided ones left out). */
export const purchaseCreditNoteListStatuses = ["current", ...purchaseCreditNoteStatuses, "all"] as const;
export type PurchaseCreditNoteListStatus = (typeof purchaseCreditNoteListStatuses)[number];

export const purchaseCreditNoteListQuerySchema = z
  .object({
    /** Matches the credit note number, the invoice number and the supplier's name. */
    q: z.string().trim().max(200).optional(),
    status: z.enum(purchaseCreditNoteListStatuses).default("current"),
    supplierId: z.uuid().optional(),
    invoiceId: z.uuid().optional(),
    /** Inclusive, on the credit date. */
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ["to"], message: "`to` is before `from`" });
export type PurchaseCreditNoteListQuery = z.infer<typeof purchaseCreditNoteListQuerySchema>;
