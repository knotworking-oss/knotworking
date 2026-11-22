import { z } from "zod";
import { roundQuantity, type UnitCode } from "./items";
import type { ApprovedCreditTotals } from "./purchase-credit-notes";
import { PRICE_DECIMALS, VALUE_DECIMALS } from "./purchasing";

/**
 * Purchasing module: supplier invoices and the three-way match (order, delivery, invoice). No DOM
 * or Node APIs.
 *
 * An invoice belongs to one supplier. Its lines are either matched to a purchase order line
 * (quantity and unit price per the **order line's unit**) or are non-stock charges (carriage).
 * Amounts are plain numbers (there is no currency setting) and VAT is a plain amount.
 *
 * - **Three-way match** (`matchInvoiceLine`): each order line on an invoice is compared with the
 *   order (price) and with what was received and not yet invoiced (quantity), against the
 *   workspace's tolerances. Each line, and the invoice, is `matched`, `within_tolerance` or
 *   `mismatch`. A draft's is computed on read (deliveries and reversals keep moving it). Approval
 *   freezes it: each line keeps what it was matched against (`ApprovedInvoiceLineMatch`: the order
 *   price and unit, the unit conversion, what was received and invoiced elsewhere, the match) and
 *   the invoice keeps the tolerances, so an approved invoice never re-grades.
 * - **Approval** for payment is a person's act (`manage`, API tokens refused). A `mismatch` needs a
 *   reason. An approved invoice is immutable.
 * - **Corrections** are new versions (`revise`): a draft copy of an approved invoice with the same
 *   supplier and number and the next version. The original stays approved and in force until the
 *   new version is approved; then it is `superseded`. Every version is kept.
 * - **Costing** reads the matched prices of approved invoices: they become the cost of the lots
 *   received against those order lines, over the order (receipt) price.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * `draft`: being entered (people and agents). `approved`: approved for payment by a person;
 * immutable. `superseded`: an approved invoice replaced by a later approved version.
 */
export const purchaseInvoiceStatuses = ["draft", "approved", "superseded"] as const;
export type PurchaseInvoiceStatus = (typeof purchaseInvoiceStatuses)[number];
export const purchaseInvoiceStatusLabels: Record<PurchaseInvoiceStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  superseded: "Superseded",
};

/** Where an invoice line (or the invoice, its worst line) stands in the three-way match. */
export const invoiceMatchStatuses = ["matched", "within_tolerance", "mismatch"] as const;
export type InvoiceMatchStatus = (typeof invoiceMatchStatuses)[number];
export const invoiceMatchStatusLabels: Record<InvoiceMatchStatus, string> = {
  matched: "Matched",
  within_tolerance: "Within tolerance",
  mismatch: "Mismatch",
};

/** `order`: matched to a purchase order line. `charge`: a non-stock line (carriage, a surcharge). */
export const purchaseInvoiceLineKinds = ["order", "charge"] as const;
export type PurchaseInvoiceLineKind = (typeof purchaseInvoiceLineKinds)[number];

/** Why a line is not simply matched. */
export const invoiceMatchIssues = [
  /** The order line has no price, so the invoice price can't be checked. */
  "no_order_price",
  /** The price differs from the order's by more than the tolerance. */
  "price_over_tolerance",
  /** The price differs from the order's, within tolerance. */
  "price_within_tolerance",
  /** More is invoiced than was received and not yet invoiced, beyond tolerance. */
  "over_invoiced",
  /** More is invoiced than was received and not yet invoiced, within tolerance. */
  "over_invoiced_within_tolerance",
  /**
   * The item's quantities can't be converted to the line's unit (a unit weight or density was
   * cleared), or the invoice line's item no longer matches the order line's: nothing can be
   * compared, so always a mismatch.
   */
  "unit_not_convertible",
] as const;
export type InvoiceMatchIssue = (typeof invoiceMatchIssues)[number];
export const invoiceMatchIssueLabels: Record<InvoiceMatchIssue, string> = {
  no_order_price: "The order line has no price",
  price_over_tolerance: "Price differs from the order beyond tolerance",
  price_within_tolerance: "Price differs from the order within tolerance",
  over_invoiced: "Invoiced more than received beyond tolerance",
  over_invoiced_within_tolerance: "Invoiced more than received within tolerance",
  unit_not_convertible: "The line's quantities can't be converted to the order line's unit or item",
};

// ─── Tolerances ──────────────────────────────────────────────────────────────

/**
 * A workspace's match tolerances. Percentages are of the order price (price) and of the quantity
 * received and not yet invoiced (quantity). Amounts are money: the value of the difference (the
 * price difference times the quantity invoiced; the quantity over-invoiced times the invoice
 * price). A difference is within tolerance when it is within **both** the percentage and the
 * amount, so small lines are held by the percentage and large ones by the amount. 0 and 0 accept
 * only exact matches.
 */
export interface InvoiceTolerances {
  pricePercent: number;
  priceAmount: number;
  quantityPercent: number;
  quantityAmount: number;
}

/**
 * Defaults until a workspace saves its own: 2% and 10.00 for price and for quantity. Small enough
 * that a wrong price or a short delivery always shows, large enough that rounding on a supplier's
 * invoice (a price per kg quoted to 2 places, a sack weighing 24.8 kg) doesn't.
 */
export const defaultInvoiceTolerances: InvoiceTolerances = {
  pricePercent: 2,
  priceAmount: 10,
  quantityPercent: 2,
  quantityAmount: 10,
};

// ─── Matching ────────────────────────────────────────────────────────────────

/** One invoice line matched to an order line. Quantities and prices are per the order line's unit. */
export interface InvoiceLineMatchInput {
  /** Invoiced. */
  quantity: number;
  /** Invoiced, per unit. */
  unitPrice: number;
  /** The order line's price per unit; null when the order line has none. */
  orderUnitPrice: number | null;
  /**
   * The order's price is in a unit that can't be converted to the line's (`orderUnitPrice` is
   * null then): a `unit_not_convertible` mismatch rather than `no_order_price`.
   */
  orderPriceNotConvertible?: boolean;
  /**
   * Accepted against the order line, net of reversed receipts; null when it can't be converted to
   * the line's unit (a `unit_not_convertible` mismatch).
   */
  received: number | null;
  /**
   * Already invoiced for the order line on other approved invoices (the version this one replaces
   * left out), so a second invoice for the same delivery shows as over-invoicing. Null when it
   * can't be converted to the line's unit.
   */
  invoicedElsewhere: number | null;
  /**
   * False when the invoice line's quantities couldn't be put in the order line's terms (its item
   * changed, or a unit no longer converts): the figures above are then unreliable and the line is
   * a `mismatch`. Defaults to true.
   */
  convertible?: boolean;
}

export interface InvoiceLineMatch {
  /**
   * Received and not yet invoiced elsewhere: what this line may invoice. Never below zero. Null
   * when the quantities can't be converted to the line's unit.
   */
  uninvoiced: number | null;
  /** Invoice price − order price, per unit (8 places); null when the order has no price. */
  priceVariance: number | null;
  /** The price variance as a percentage of the order price (2 places); null when not defined. */
  priceVariancePercent: number | null;
  /** The price variance times the quantity invoiced (money); null when not defined. */
  priceVarianceValue: number | null;
  priceStatus: InvoiceMatchStatus;
  /**
   * Invoiced − uninvoiced (4 places): positive is over-invoicing, negative a part invoice. Null
   * when the quantities can't be converted.
   */
  quantityVariance: number | null;
  /** The quantity variance as a percentage of the uninvoiced quantity; null when nothing is. */
  quantityVariancePercent: number | null;
  /** The over-invoiced quantity times the invoice price (money); 0 when not over-invoiced. */
  quantityVarianceValue: number;
  quantityStatus: InvoiceMatchStatus;
  /** The worse of the two. */
  status: InvoiceMatchStatus;
  issues: InvoiceMatchIssue[];
}

const rank: Record<InvoiceMatchStatus, number> = { matched: 0, within_tolerance: 1, mismatch: 2 };

/** The worse of several statuses (`matched` when there are none). */
export const worstMatchStatus = (statuses: readonly InvoiceMatchStatus[]): InvoiceMatchStatus =>
  statuses.reduce<InvoiceMatchStatus>((worst, s) => (rank[s] > rank[worst] ? s : worst), "matched");

/** Percentages are compared at 4 places, so float noise never pushes 2% past a 2% tolerance. */
const pct = (part: number, whole: number) => roundQuantity((part / whole) * 100, 4);

/**
 * The three-way match of one line:
 *
 * - **Price**: invoice price against the order line's price. Equal (at 8 places) is `matched`;
 *   otherwise `within_tolerance` when the difference is within both the price percentage (of the
 *   order price) and the price amount (the difference times the quantity invoiced), else
 *   `mismatch`. Either direction counts: a much lower price is as likely a wrong unit or item. An
 *   order line without a price is a `mismatch` (nothing to check against).
 * - **Quantity**: invoiced against received and not yet invoiced on other approved invoices.
 *   Invoicing no more than that is `matched` (a part invoice; the rest can come on a later one).
 *   Over-invoicing is `within_tolerance` when within both the quantity percentage (of the
 *   uninvoiced quantity) and the quantity amount (the excess times the invoice price), else
 *   `mismatch`; invoicing anything when nothing is left to invoice is a `mismatch`.
 *
 * Boundaries are inclusive: a difference of exactly the tolerance is within it. A line that isn't
 * `convertible` is a `mismatch` on both counts.
 */
export function matchInvoiceLine(
  input: InvoiceLineMatchInput,
  tolerances: InvoiceTolerances = defaultInvoiceTolerances,
): InvoiceLineMatch {
  const issues: InvoiceMatchIssue[] = [];
  const quantity = roundQuantity(input.quantity);
  const unitPrice = roundQuantity(input.unitPrice, PRICE_DECIMALS);

  // Price.
  let priceVariance: number | null = null;
  let priceVariancePercent: number | null = null;
  let priceVarianceValue: number | null = null;
  let priceStatus: InvoiceMatchStatus;
  if (input.orderUnitPrice === null) {
    priceStatus = "mismatch";
    issues.push(input.orderPriceNotConvertible ? "unit_not_convertible" : "no_order_price");
  } else {
    const orderPrice = roundQuantity(input.orderUnitPrice, PRICE_DECIMALS);
    priceVariance = roundQuantity(unitPrice - orderPrice, PRICE_DECIMALS);
    priceVarianceValue = roundQuantity(priceVariance * quantity, VALUE_DECIMALS);
    priceVariancePercent = orderPrice > 0 ? pct(priceVariance, orderPrice) : null;
    if (priceVariance === 0) priceStatus = "matched";
    else if (
      priceVariancePercent !== null &&
      Math.abs(priceVariancePercent) <= tolerances.pricePercent &&
      Math.abs(priceVarianceValue) <= tolerances.priceAmount
    ) {
      priceStatus = "within_tolerance";
      issues.push("price_within_tolerance");
    } else {
      priceStatus = "mismatch";
      issues.push("price_over_tolerance");
    }
  }

  // Quantity.
  if (input.received === null || input.invoicedElsewhere === null) {
    if (!issues.includes("unit_not_convertible")) issues.push("unit_not_convertible");
    return {
      uninvoiced: null,
      priceVariance,
      priceVariancePercent: priceVariancePercent === null ? null : roundQuantity(priceVariancePercent, 2),
      priceVarianceValue,
      priceStatus: input.convertible === false ? "mismatch" : priceStatus,
      quantityVariance: null,
      quantityVariancePercent: null,
      quantityVarianceValue: 0,
      quantityStatus: "mismatch",
      status: "mismatch",
      issues,
    };
  }
  const uninvoiced = roundQuantity(
    Math.max(roundQuantity(input.received) - roundQuantity(input.invoicedElsewhere), 0),
  );
  const quantityVariance = roundQuantity(quantity - uninvoiced);
  const over = Math.max(quantityVariance, 0);
  const quantityVariancePercent = uninvoiced > 0 ? pct(quantityVariance, uninvoiced) : null;
  const quantityVarianceValue = roundQuantity(over * unitPrice, VALUE_DECIMALS);
  let quantityStatus: InvoiceMatchStatus;
  if (over === 0) quantityStatus = "matched";
  else if (
    quantityVariancePercent !== null &&
    quantityVariancePercent <= tolerances.quantityPercent &&
    quantityVarianceValue <= tolerances.quantityAmount
  ) {
    quantityStatus = "within_tolerance";
    issues.push("over_invoiced_within_tolerance");
  } else {
    quantityStatus = "mismatch";
    issues.push("over_invoiced");
  }

  if (input.convertible === false) {
    priceStatus = "mismatch";
    quantityStatus = "mismatch";
    if (!issues.includes("unit_not_convertible")) issues.push("unit_not_convertible");
  }

  return {
    uninvoiced,
    priceVariance,
    priceVariancePercent: priceVariancePercent === null ? null : roundQuantity(priceVariancePercent, 2),
    priceVarianceValue,
    priceStatus,
    quantityVariance,
    quantityVariancePercent:
      quantityVariancePercent === null ? null : roundQuantity(quantityVariancePercent, 2),
    quantityVarianceValue,
    quantityStatus,
    status: worstMatchStatus([priceStatus, quantityStatus]),
    issues,
  };
}

/**
 * What an approved invoice's order line was matched against, stored on the line at approval so the
 * invoice never re-grades (a later change to the item's unit weight, the order or the tolerances
 * leaves it as it was approved). Costing reads `orderUnitPrice` and `basePerUnit` too.
 */
export interface ApprovedInvoiceLineMatch {
  /** The order line's unit then (the invoice line's unit). */
  orderUnit: UnitCode;
  /** The order's price per the invoice line's unit then; null when it had none. */
  orderUnitPrice: number | null;
  /**
   * Base units (g, ml, each) in one of the invoice line's units, by the item's conversion then;
   * null when it didn't convert.
   */
  basePerUnit: number | null;
  /** Received, in the line's unit, then (null when it didn't convert). */
  received: number | null;
  /** Invoiced on other approved invoices, in the line's unit, then (null when it didn't convert). */
  invoicedElsewhere: number | null;
  /** The match it was approved at. */
  match: InvoiceLineMatch;
}

/** A line's value: quantity × unit price, as money. */
export const invoiceLineValue = (quantity: number, unitPrice: number) =>
  roundQuantity(quantity * unitPrice, VALUE_DECIMALS);

/** Net (the lines), VAT and gross. */
export function purchaseInvoiceTotals(
  lines: readonly { quantity: number; unitPrice: number }[],
  vat: number,
) {
  const net = roundQuantity(
    lines.reduce((sum, l) => sum + invoiceLineValue(l.quantity, l.unitPrice), 0),
    VALUE_DECIMALS,
  );
  return { net, vat: roundQuantity(vat, VALUE_DECIMALS), gross: roundQuantity(net + vat, VALUE_DECIMALS) };
}

/**
 * The price per unit costing reads for one order line: the quantity-weighted average over the
 * order line's lines on approved invoices (per the order line's unit). Null when none.
 */
export function weightedInvoicePrice(
  lines: readonly { quantity: number; unitPrice: number }[],
): number | null {
  const quantity = lines.reduce((sum, l) => sum + l.quantity, 0);
  if (!(quantity > 0)) return null;
  return lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0) / quantity;
}

/**
 * What an order line still has to invoice: received less what approved invoices already bill
 * (never below zero), per the order line's unit. Null when the received quantity doesn't convert.
 * Entering an invoice from an order starts each line at this.
 */
export const uninvoicedQuantity = (received: number | null, invoiced: number): number | null =>
  received === null ? null : roundQuantity(Math.max(received - invoiced, 0));

/** One order line's line on an approved invoice, as costing reads it. */
export interface ApprovedInvoicePriceLine {
  /** Invoiced, per the order line's unit. */
  quantity: number;
  /** Invoiced, per the order line's unit. */
  unitPrice: number;
  /** What approval stored (null only for a line approved before it was stored). */
  approvedMatch: Pick<ApprovedInvoiceLineMatch, "orderUnitPrice" | "basePerUnit"> | null;
}

/**
 * Why an approved invoice's price couldn't be put on a receipt: the order line had no price (or
 * the receipt none) and the item's unit didn't convert when the invoice was approved.
 */
export type InvoicePriceResult =
  { pricePerBase: number; unpriced: false } | { pricePerBase: null; unpriced: boolean };

/**
 * The invoice price, per base unit, of one receipt (lot) received against an order line, from the
 * order line's lines on approved invoices. Never re-converted with the item's conversion today, so
 * a lot's cost doesn't drift when a unit weight or density changes:
 *
 * 1. Where every line had an order price at approval and the receipt has its (frozen) price: the
 *    receipt's price per base unit × the invoice-to-order price ratio, Σ(q × invoice price) ÷
 *    Σ(q × order price). The receipt's own conversion stands.
 * 2. Else, where every line's conversion at approval is stored: Σ(q × invoice price) ÷ Σ(q × base
 *    units per line unit then).
 * 3. Else it can't be priced (`unpriced`): costing keeps the receipt's price and says why.
 */
export function invoicePricePerBase(
  lines: readonly ApprovedInvoicePriceLine[],
  receiptPricePerBase: number | null,
  credits?: ApprovedCreditTotals | null,
): InvoicePriceResult {
  const billed = lines.filter((l) => l.quantity > 0);
  if (!billed.length) return { pricePerBase: null, unpriced: false };
  const billedQuantity = billed.reduce((sum, l) => sum + l.quantity, 0);
  // Approved credit notes: the credited value comes off the invoiced value, and the units returned
  // come off the quantity (at the average of what the lines were ordered at or weigh).
  const returned = credits ? Math.min(credits.returnedQuantity, billedQuantity) : 0;
  if (returned >= billedQuantity) return { pricePerBase: null, unpriced: false };
  const invoiced = billed.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0) - (credits?.value ?? 0);
  const round = (v: number) => roundQuantity(v, PRICE_DECIMALS);
  if (receiptPricePerBase !== null && billed.every((l) => (l.approvedMatch?.orderUnitPrice ?? 0) > 0)) {
    const ordered = billed.reduce((sum, l) => sum + l.quantity * l.approvedMatch!.orderUnitPrice!, 0);
    const keptOrdered = ordered - (returned * ordered) / billedQuantity;
    return {
      pricePerBase: round(receiptPricePerBase * (Math.max(invoiced, 0) / keptOrdered)),
      unpriced: false,
    };
  }
  if (billed.every((l) => (l.approvedMatch?.basePerUnit ?? 0) > 0)) {
    const base = billed.reduce((sum, l) => sum + l.quantity * l.approvedMatch!.basePerUnit!, 0);
    const keptBase = base - (returned * base) / billedQuantity;
    return { pricePerBase: round(Math.max(invoiced, 0) / keptBase), unpriced: false };
  }
  return { pricePerBase: null, unpriced: true };
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
/** Up to `PRICE_DECIMALS` (8) places; more are rounded. */
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

export const PURCHASE_INVOICE_MAX_LINES = 200;

const orderLine = z.object({
  kind: z.literal("order"),
  /** The purchase order line invoiced (an order of the same supplier, sent or closed). */
  orderLineId: z.uuid(),
  /** Per the order line's unit. */
  quantity: positiveQuantity,
  /** Per the order line's unit. */
  unitPrice: price,
  description: optionalText(200).optional(),
});
/** A charge's price may be negative: a discount ("Settlement discount", "Volume rebate"). */
const signedPrice = z
  .number()
  .min(-1_000_000_000)
  .max(1_000_000_000)
  .finite()
  .transform((v) => roundQuantity(v, PRICE_DECIMALS));
const chargeLine = z.object({
  kind: z.literal("charge"),
  /** What it is: "Carriage", "Pallet charge", or a discount (a negative price). */
  description: requiredText(200),
  quantity: positiveQuantity.default(1),
  unitPrice: signedPrice,
});
export const purchaseInvoiceLineSchema = z.discriminatedUnion("kind", [orderLine, chargeLine]);
export type PurchaseInvoiceLineInput = z.infer<typeof purchaseInvoiceLineSchema>;

const lines = z
  .array(purchaseInvoiceLineSchema)
  .max(PURCHASE_INVOICE_MAX_LINES)
  .refine((list) => {
    const ids = list.flatMap((l) => (l.kind === "order" ? [l.orderLineId] : []));
    return new Set(ids).size === ids.length;
  }, "An order line is on the invoice twice; put the whole quantity on one line");

const dueAfterInvoice = (v: { invoiceDate?: string | undefined; dueDate?: string | null | undefined }) =>
  !v.invoiceDate || !v.dueDate || v.dueDate >= v.invoiceDate;

export const purchaseInvoiceCreateSchema = z
  .object({
    id: z.uuid().optional(),
    supplierId: z.uuid(),
    /** The supplier's own invoice number; unique per supplier. */
    invoiceNumber: requiredText(60),
    invoiceDate: isoDate,
    dueDate: isoDate.nullable().optional(),
    /** VAT as a plain amount. */
    vat: money.default(0),
    notes: optionalText(4000).optional(),
    lines: lines.default([]),
  })
  .refine(dueAfterInvoice, { path: ["dueDate"], message: "The due date is before the invoice date" });
export type PurchaseInvoiceCreateInput = z.infer<typeof purchaseInvoiceCreateSchema>;

/** A draft's header fields to change and, optionally, all its lines (a replacement). */
export const purchaseInvoiceUpdateSchema = z
  .object({
    supplierId: z.uuid(),
    invoiceNumber: requiredText(60),
    invoiceDate: isoDate,
    dueDate: isoDate.nullable(),
    vat: money,
    notes: optionalText(4000),
    lines,
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type PurchaseInvoiceUpdateInput = z.infer<typeof purchaseInvoiceUpdateSchema>;

/** Approving for payment. A `mismatch` needs a reason. */
export const purchaseInvoiceApproveSchema = z.object({ reason: optionalText(1000).optional() });
export type PurchaseInvoiceApproveInput = z.infer<typeof purchaseInvoiceApproveSchema>;

/** `current`: drafts and approved invoices (superseded versions left out). */
export const purchaseInvoiceListStatuses = ["current", ...purchaseInvoiceStatuses, "all"] as const;
export type PurchaseInvoiceListStatus = (typeof purchaseInvoiceListStatuses)[number];

export const purchaseInvoiceListQuerySchema = z
  .object({
    /** Matches the invoice number and the supplier's name. */
    q: z.string().trim().max(200).optional(),
    status: z.enum(purchaseInvoiceListStatuses).default("current"),
    supplierId: z.uuid().optional(),
    /** Invoices with a line on this order. */
    purchaseOrderId: z.uuid().optional(),
    /** Inclusive, on the invoice date. */
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ["to"], message: "`to` is before `from`" });
export type PurchaseInvoiceListQuery = z.infer<typeof purchaseInvoiceListQuerySchema>;

const percentTolerance = z.number().min(0).max(100).finite();
const amountTolerance = z.number().min(0).max(1_000_000_000).finite();
export const invoiceTolerancesUpdateSchema = z
  .object({
    pricePercent: percentTolerance,
    priceAmount: amountTolerance,
    quantityPercent: percentTolerance,
    quantityAmount: amountTolerance,
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type InvoiceTolerancesUpdateInput = z.infer<typeof invoiceTolerancesUpdateSchema>;
