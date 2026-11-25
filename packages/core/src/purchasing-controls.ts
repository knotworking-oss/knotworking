import { z } from "zod";
import { roundQuantity, unitCodes } from "./items";
import { PRICE_DECIMALS, VALUE_DECIMALS } from "./purchasing";

/**
 * Purchasing controls: the approval threshold for sending an order, the over-delivery tolerance,
 * supplier price lists, voiding a rejected receipt, and emailing an order to the supplier. Pure
 * rules and the schemas shared by server, web and MCP. No DOM or Node APIs.
 */

// ─── Workspace settings ──────────────────────────────────────────────────────

/** The order controls a workspace sets. Null switches a control off (the default). */
export interface PurchaseOrderSettings {
  /** Orders worth more than this need a manager's approval, not the creator's, before sending. */
  sendApprovalThreshold: number | null;
  /** Accepted deliveries above ordered + this percentage need a reason. */
  overDeliveryTolerancePercent: number | null;
}

export const defaultPurchaseOrderSettings: PurchaseOrderSettings = {
  sendApprovalThreshold: null,
  overDeliveryTolerancePercent: null,
};

export const purchaseOrderSettingsUpdateSchema = z
  .object({
    sendApprovalThreshold: z
      .number()
      .min(0)
      .max(1_000_000_000)
      .finite()
      .transform((v) => roundQuantity(v, VALUE_DECIMALS))
      .nullable(),
    overDeliveryTolerancePercent: z
      .number()
      .min(0)
      .max(1000)
      .finite()
      .transform((v) => roundQuantity(v, 2))
      .nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type PurchaseOrderSettingsUpdateInput = z.infer<typeof purchaseOrderSettingsUpdateSchema>;

// ─── Approval to send ────────────────────────────────────────────────────────

/**
 * - `not_required`: no threshold, or the order is within it.
 * - `needed`: above the threshold and nobody has approved it.
 * - `approved`: a manager other than the creator approved at least this value.
 * - `stale`: it was approved, but the order is worth more now (or the approver is the creator):
 *   it needs approving again.
 */
export const sendApprovalStates = ["not_required", "needed", "approved", "stale"] as const;
export type SendApprovalState = (typeof sendApprovalStates)[number];
export const sendApprovalStateLabels: Record<SendApprovalState, string> = {
  not_required: "No approval needed",
  needed: "Needs approval",
  approved: "Approved to send",
  stale: "Approval out of date",
};

/**
 * Whether an order may be sent, given the workspace's threshold. Unpriced lines count for nothing
 * (their value is unknown, so only priced lines are weighed against the threshold). An approval
 * covers orders up to the value they were approved at, and only counts when it is not the
 * creator's (four-eyes: no exception for a sole manager; clear the threshold instead).
 */
export function sendApprovalState(input: {
  threshold: number | null;
  value: number;
  createdBy: string | null;
  approvedBy: string | null;
  approvedValue: number | null;
}): SendApprovalState {
  const { threshold } = input;
  if (threshold === null || roundQuantity(input.value, VALUE_DECIMALS) <= threshold) return "not_required";
  if (input.approvedBy === null) return "needed";
  const covers =
    input.approvedValue !== null &&
    roundQuantity(input.value, VALUE_DECIMALS) <= roundQuantity(input.approvedValue, VALUE_DECIMALS);
  return covers && input.approvedBy !== input.createdBy ? "approved" : "stale";
}

/** Whoever raised an order can't approve sending it. */
export const canApproveOrderSend = (input: { createdBy: string | null; approverId: string }) =>
  input.createdBy !== input.approverId;

export const purchaseOrderApproveSchema = z.object({
  note: z
    .string()
    .trim()
    .max(500)
    .transform((v) => v || null)
    .nullable()
    .optional(),
});
export type PurchaseOrderApproveInput = z.infer<typeof purchaseOrderApproveSchema>;

// ─── Over-delivery ───────────────────────────────────────────────────────────

/** The most that may be accepted against a line without a reason: ordered plus the tolerance. */
export const overDeliveryLimit = (ordered: number, tolerancePercent: number) =>
  roundQuantity(roundQuantity(ordered) * (1 + tolerancePercent / 100));

/**
 * Whether accepting `receiving` more, on top of `received` already, is over the line's tolerance
 * (all base units). Never over when no tolerance is set. Compared at the stored 4 decimals, so
 * float noise never turns a delivery of exactly the limit into an excess.
 */
export function isOverDeliveryTolerance(input: {
  ordered: number;
  received: number;
  receiving: number;
  tolerancePercent: number | null;
}): boolean {
  if (input.tolerancePercent === null) return false;
  const total = roundQuantity(roundQuantity(input.received) + roundQuantity(input.receiving));
  return total > overDeliveryLimit(input.ordered, input.tolerancePercent);
}

// ─── Supplier price lists ────────────────────────────────────────────────────

export interface PriceListEntry {
  effectiveFrom: string;
  effectiveTo: string | null;
}

/**
 * The entry in force on a date: effective from on or before it and not ended before it; when
 * several overlap, the one that took effect last. Null when none is.
 */
export function priceInForce<T extends PriceListEntry>(entries: readonly T[], on: string): T | null {
  let best: T | null = null;
  for (const e of entries) {
    if (e.effectiveFrom > on || (e.effectiveTo !== null && e.effectiveTo < on)) continue;
    if (best === null || e.effectiveFrom > best.effectiveFrom) best = e;
  }
  return best;
}

const isoDate = z.iso.date();
const priceValue = z
  .number()
  .min(0)
  .finite()
  .max(1_000_000_000)
  .transform((v) => roundQuantity(v, PRICE_DECIMALS));
const optionalNotes = z
  .string()
  .trim()
  .max(1000)
  .transform((v) => v || null)
  .nullable();

const priceListFields = {
  supplierId: z.uuid(),
  itemId: z.uuid(),
  /** The price is per this unit. */
  unit: z.enum(unitCodes),
  unitPrice: priceValue,
  effectiveFrom: isoDate,
  /** Inclusive; null: in force until replaced. */
  effectiveTo: isoDate.nullable(),
  notes: optionalNotes,
};

export const supplierPriceCreateSchema = z
  .object({
    id: z.uuid().optional(),
    ...priceListFields,
    effectiveTo: priceListFields.effectiveTo.optional(),
    notes: priceListFields.notes.optional(),
  })
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, {
    path: ["effectiveTo"],
    message: "`effectiveTo` is before `effectiveFrom`",
  });
export type SupplierPriceCreateInput = z.infer<typeof supplierPriceCreateSchema>;

/** The supplier and item of an entry can't change: add another entry instead. */
export const supplierPriceUpdateSchema = z
  .object({
    unit: priceListFields.unit,
    unitPrice: priceListFields.unitPrice,
    effectiveFrom: priceListFields.effectiveFrom,
    effectiveTo: priceListFields.effectiveTo,
    notes: priceListFields.notes,
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update")
  .refine((v) => !v.effectiveFrom || !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, {
    path: ["effectiveTo"],
    message: "`effectiveTo` is before `effectiveFrom`",
  });
export type SupplierPriceUpdateInput = z.infer<typeof supplierPriceUpdateSchema>;

export const supplierPriceListQuerySchema = z.object({
  supplierId: z.uuid().optional(),
  itemId: z.uuid().optional(),
  /** Only entries in force on this date. */
  on: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
export type SupplierPriceListQuery = z.infer<typeof supplierPriceListQuerySchema>;

// ─── Voiding a rejected receipt ──────────────────────────────────────────────

export const purchaseReceiptVoidSchema = z.object({ reason: z.string().trim().min(1).max(500) });
export type PurchaseReceiptVoidInput = z.infer<typeof purchaseReceiptVoidSchema>;

// ─── Emailing an order ───────────────────────────────────────────────────────

export const purchaseOrderEmailStatuses = ["sent", "failed"] as const;
export type PurchaseOrderEmailStatus = (typeof purchaseOrderEmailStatuses)[number];

export const purchaseOrderEmailSchema = z.object({
  /** Defaults to the supplier's email in the register. */
  to: z.email().max(254).optional(),
  /** A short covering note above the order. */
  message: z
    .string()
    .trim()
    .max(1000)
    .transform((v) => v || null)
    .nullable()
    .optional(),
});
export type PurchaseOrderEmailInput = z.infer<typeof purchaseOrderEmailSchema>;

export interface PurchaseOrderEmailLine {
  lineNo: number;
  /** The item's code; null for a non-stock line without an item. */
  code: string | null;
  /** The item's name, or a non-stock line's description. */
  name: string;
  quantity: number;
  /** A unit code, a non-stock line's own unit, or "" for none. */
  unit: string;
  unitPrice: number | null;
  value: number | null;
  expectedOn: string | null;
}

export interface PurchaseOrderEmailContent {
  workspaceName: string;
  reference: string;
  supplierName: string;
  supplierReference: string | null;
  orderedOn: string | null;
  expectedOn: string | null;
  deliveryLocation: string | null;
  notes: string | null;
  message: string | null;
  senderName: string;
  lines: readonly PurchaseOrderEmailLine[];
  /** Order value; `complete` is false when a line has no price. */
  value: number;
  complete: boolean;
}

const escapeHtml = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );

/** A number without trailing zeros, at most `places` decimals (a price per gram needs 5 or more). */
const plain = (v: number, places: number) =>
  roundQuantity(v, places)
    .toFixed(places)
    .replace(/\.?0+$/, "");

/**
 * The email that goes to the supplier: a subject, a plain text body and an HTML body with the same
 * print-style summary of the order (reference, dates, delivery location, lines with quantity and
 * price, total, notes). There are no links in it: the supplier has no access to the workspace.
 * Prices are plain numbers (there is no currency setting).
 */
export function renderPurchaseOrderEmail(input: PurchaseOrderEmailContent) {
  const subject = `Purchase order ${input.reference} from ${input.workspaceName}`;
  const price = (v: number | null) => (v === null ? "-" : plain(v, PRICE_DECIMALS));
  const amount = (v: number | null) => (v === null ? "-" : roundQuantity(v, 2).toFixed(2));
  const header: [string, string | null][] = [
    ["Order", input.reference],
    ["Your reference", input.supplierReference],
    ["Order date", input.orderedOn],
    ["Requested delivery", input.expectedOn],
    ["Deliver to", input.deliveryLocation],
  ];
  const shown = header.filter((row): row is [string, string] => Boolean(row[1]));
  const total = `${amount(input.value)}${input.complete ? "" : " (lines without a price are not included)"}`;

  const textLines = input.lines.map((l) => {
    const date = l.expectedOn ? ` - for ${l.expectedOn}` : "";
    const cost = l.unitPrice === null ? "" : ` @ ${price(l.unitPrice)} = ${amount(l.value)}`;
    return `${l.lineNo}. ${l.code ? `${l.code} ` : ""}${l.name}: ${plain(l.quantity, 4)}${l.unit ? ` ${l.unit}` : ""}${cost}${date}`;
  });
  const text = [
    `Purchase order ${input.reference}`,
    `From ${input.workspaceName} to ${input.supplierName}`,
    "",
    ...(input.message ? [input.message, ""] : []),
    ...shown.map(([k, v]) => `${k}: ${v}`),
    "",
    "Lines",
    ...textLines,
    "",
    `Total: ${total}`,
    ...(input.notes ? ["", "Notes", input.notes] : []),
    "",
    `Sent by ${input.senderName}. Please reply to this email to confirm the order and delivery date.`,
  ].join("\n");

  const cell = (v: string, align = "left") =>
    `<td style="padding:4px 8px;border-bottom:1px solid #ddd;text-align:${align}">${escapeHtml(v)}</td>`;
  const head = (v: string, align = "left") =>
    `<th style="padding:4px 8px;border-bottom:2px solid #333;text-align:${align}">${escapeHtml(v)}</th>`;
  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">`,
    `<h2 style="margin:0 0 4px">Purchase order ${escapeHtml(input.reference)}</h2>`,
    `<p style="margin:0 0 12px">From ${escapeHtml(input.workspaceName)} to ${escapeHtml(input.supplierName)}</p>`,
    ...(input.message ? [`<p>${escapeHtml(input.message)}</p>`] : []),
    `<table style="border-collapse:collapse;margin-bottom:12px">`,
    ...shown.map(
      ([k, v]) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#555">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`,
    ),
    `</table>`,
    `<table style="border-collapse:collapse;width:100%">`,
    `<tr>${head("#")}${head("Item")}${head("Quantity", "right")}${head("Unit price", "right")}${head("Value", "right")}${head("Needed by")}</tr>`,
    ...input.lines.map(
      (l) =>
        `<tr>${cell(String(l.lineNo))}${cell(`${l.code ? `${l.code} ` : ""}${l.name}`)}${cell(`${plain(l.quantity, 4)}${l.unit ? ` ${l.unit}` : ""}`, "right")}${cell(price(l.unitPrice), "right")}${cell(amount(l.value), "right")}${cell(l.expectedOn ?? "")}</tr>`,
    ),
    `</table>`,
    `<p style="margin:8px 0"><strong>Total: ${escapeHtml(total)}</strong></p>`,
    ...(input.notes
      ? [`<p><strong>Notes</strong><br>${escapeHtml(input.notes).replace(/\n/g, "<br>")}</p>`]
      : []),
    `<p style="color:#555">Sent by ${escapeHtml(input.senderName)}. Please reply to this email to confirm the order and delivery date.</p>`,
    `</div>`,
  ].join("\n");
  return { subject, text, html };
}
