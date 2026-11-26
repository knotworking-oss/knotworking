import { z } from "zod";
import {
  convertQuantity,
  roundQuantity,
  unitCodes,
  type SupplierApprovalStatus,
  type UnitBridge,
  type UnitCode,
} from "./items";
import { addDays, expiryTypes, receivableItemTypes } from "./stock";

/**
 * Purchasing module: purchase orders raised from the material shortfall, goods-in against an
 * order (part, over and under deliveries, and deliveries refused at the door), and supplier
 * performance (on time, in full, rejected deliveries). Builds on items and stock. No DOM or Node
 * APIs.
 *
 * Quantities on lines and receipts are in the item's **base unit** (g, ml or each), rounded to
 * `QUANTITY_DECIMALS`. A line remembers the unit it was entered in (`unit`), and its price is per
 * that unit. A receipt's price is per base unit (what costing reads).
 *
 * Sending, closing and cancelling an order are a person's acts (API tokens refused); drafting and
 * recording deliveries are not.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/** What is stored on the order. */
export const purchaseOrderStatuses = ["draft", "sent", "closed", "cancelled"] as const;
export type PurchaseOrderStatus = (typeof purchaseOrderStatuses)[number];
export const purchaseOrderStatusLabels: Record<PurchaseOrderStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  closed: "Closed",
  cancelled: "Cancelled",
};

/**
 * What is shown: derived from the status and the receipts (`purchaseOrderState`). A sent order is
 * `sent` until something is received, `part_received` while any line is short, and `received`
 * once every line has had its ordered quantity or more.
 */
export const purchaseOrderStates = [
  "draft",
  "sent",
  "part_received",
  "received",
  "closed",
  "cancelled",
] as const;
export type PurchaseOrderState = (typeof purchaseOrderStates)[number];
export const purchaseOrderStateLabels: Record<PurchaseOrderState, string> = {
  draft: "Draft",
  sent: "Sent",
  part_received: "Part received",
  received: "Received",
  closed: "Closed",
  cancelled: "Cancelled",
};

/** `accepted`: received into stock. `rejected`: refused at the door (no stock moves). */
export const purchaseReceiptOutcomes = ["accepted", "rejected"] as const;
export type PurchaseReceiptOutcome = (typeof purchaseReceiptOutcomes)[number];
export const purchaseReceiptOutcomeLabels: Record<PurchaseReceiptOutcome, string> = {
  accepted: "Accepted",
  rejected: "Rejected",
};

/** Where one line stands against what was ordered. */
export const lineReceiptStates = ["none", "partial", "full", "over"] as const;
export type LineReceiptState = (typeof lineReceiptStates)[number];
export const lineReceiptStateLabels: Record<LineReceiptState, string> = {
  none: "Not received",
  partial: "Part received",
  full: "Received",
  over: "Over-delivered",
};

/** Suppliers that can't be ordered from or delivered by. A `pending` one can (into quarantine). */
export const blockedSupplierStatuses: readonly SupplierApprovalStatus[] = ["suspended", "rejected"];
export const canOrderFromSupplier = (status: SupplierApprovalStatus) =>
  !blockedSupplierStatuses.includes(status);

// ─── References ──────────────────────────────────────────────────────────────

export const PURCHASE_ORDER_REFERENCE_PREFIX = "PO";

/**
 * `PO-2026-001`: the prefix, the year of the date (the creation date: drafts get a reference too)
 * and a sequence that restarts each year. Never reused, deleted orders included.
 */
export const purchaseOrderReference = (isoDate: string, sequence: number) =>
  `${PURCHASE_ORDER_REFERENCE_PREFIX}-${isoDate.slice(0, 4)}-${String(sequence).padStart(3, "0")}`;

/** The sequence number of a reference made by `purchaseOrderReference`, or null. */
export const purchaseOrderReferenceSequence = (reference: string) => {
  const match = /^PO-(\d{4})-(\d+)$/.exec(reference);
  return match ? Number(match[2]) : null;
};

/** The stock movement reference of a delivery: `PO-2026-001`, or `PO-2026-001 / DN4471`. */
export const purchaseReceiptMovementReference = (
  orderReference: string,
  deliveryReference?: string | null,
) => (deliveryReference ? `${orderReference} / ${deliveryReference}` : orderReference);

// ─── Quantities and prices ───────────────────────────────────────────────────

/**
 * Decimal places of a line's price per its unit (`numeric(18,8)`): a line entered in grams of an
 * item costed at £3.45 a kilo is priced 0.00345 a gram, which 4 places would round to 0.0035
 * (a 1.4% error on the order's value). Display may round.
 */
export const PRICE_DECIMALS = 8;
/**
 * Decimal places of a receipt's price per base unit (`numeric(24,14)`), what costing reads. Base
 * units are small (mm², mm, g, ml): £2.994 per m² is £0.000002994 per mm², which 8 places would
 * round to 0.00000299 (500 m² valued at £1,495 instead of £1,497). Money rounds only at the total.
 */
export const BASE_PRICE_DECIMALS = 14;
/** Decimal places of an order's or line's value (money). */
export const VALUE_DECIMALS = 4;

/**
 * A price per `from` unit as a price per `to` unit (£2 per kg is £0.002 per g), rounded to
 * `decimals`. Null when the units don't convert for this item.
 */
export function convertUnitPrice(
  price: number,
  from: UnitCode,
  to: UnitCode,
  bridge: UnitBridge = {},
  decimals = PRICE_DECIMALS,
): number | null {
  // One `to` unit is this many `from` units.
  const factor = convertQuantity(1, to, from, bridge);
  return factor === null ? null : roundQuantity(price * factor, decimals);
}

/** What is still to come: ordered minus received, never below zero. */
export const outstanding = (ordered: number, received: number): number =>
  roundQuantity(Math.max(roundQuantity(ordered) - roundQuantity(received), 0));

/**
 * Where a line stands. Compared after rounding to the stored 4 decimals, so float noise from
 * summing receipts never turns a full delivery into a part or an over-delivery.
 */
export function lineReceiptState(ordered: number, received: number): LineReceiptState {
  const o = roundQuantity(ordered);
  const r = roundQuantity(received);
  if (r <= 0) return "none";
  if (r < o) return "partial";
  return r === o ? "full" : "over";
}

/** One line as `purchaseOrderState` needs it: ordered and accepted (unreversed) quantities. */
export interface PurchaseOrderLineProgress {
  quantity: number;
  received: number;
}

/**
 * The displayed state. Draft, closed and cancelled are the stored status. A sent order is
 * `received` when every line has its ordered quantity or more (an order with no lines stays
 * `sent`), `part_received` when anything has arrived, else `sent`.
 */
export function purchaseOrderState(order: {
  status: PurchaseOrderStatus;
  lines: readonly PurchaseOrderLineProgress[];
}): PurchaseOrderState {
  if (order.status !== "sent") return order.status;
  const states = order.lines.map((l) => lineReceiptState(l.quantity, l.received));
  if (states.length > 0 && states.every((s) => s === "full" || s === "over")) return "received";
  if (states.some((s) => s !== "none")) return "part_received";
  return "sent";
}

/** States that are still expecting goods: what the `open` list filter shows. */
export const openPurchaseOrderStates: readonly PurchaseOrderState[] = ["sent", "part_received"];

/**
 * The value of an order: Σ quantity × price over lines whose price is known, with `complete`
 * false when any line has no price. `quantity` is in the unit the price is per (the line's unit).
 */
export function purchaseOrderValue(lines: readonly { quantity: number; unitPrice: number | null }[]) {
  let value = 0;
  let complete = true;
  for (const line of lines) {
    if (line.unitPrice === null) complete = false;
    else value += line.quantity * line.unitPrice;
  }
  return { value: roundQuantity(value, VALUE_DECIMALS), complete };
}

// ─── Supplier performance ────────────────────────────────────────────────────

/** One receipt row, as performance needs it. Accepted rows must leave out reversed receipts. */
export interface PerformanceReceipt {
  outcome: PurchaseReceiptOutcome;
  /** Base unit. */
  quantity: number;
  receivedOn: string;
  deliveryId: string;
}

/** One line of a sent, closed or cancelled order. */
export interface PerformanceLine {
  supplierId: string;
  lineId: string;
  /**
   * The date promised when the order was sent (or when the line was added to a sent order): the
   * line's effective expected date then, never moved by later edits, so re-dating a late line
   * can't improve the score. A line without one is never due.
   */
  promisedOn: string | null;
  /** Ordered, base unit. */
  quantity: number;
  /**
   * When given: lines of draft orders are left out, and lines of cancelled orders are never due
   * (their deliveries, refusals included, still count).
   */
  orderStatus?: PurchaseOrderStatus;
  receipts: readonly PerformanceReceipt[];
}

export interface SupplierPerformance {
  supplierId: string;
  /** Lines promised in the period and by today. */
  linesDue: number;
  /** Due lines whose first accepted delivery came on or before the promised date. */
  onTime: number;
  /** Due lines that have had the ordered quantity or more accepted, whenever. */
  inFull: number;
  /** Due lines that had the ordered quantity accepted by the promised date. */
  otif: number;
  /** Percentages with one decimal; null when nothing was due. */
  onTimePercent: number | null;
  inFullPercent: number | null;
  otifPercent: number | null;
  /** Distinct deliveries with a receipt in the period (by received date), accepted or rejected. */
  deliveries: number;
  /** Of those, the deliveries with anything refused. */
  rejectedDeliveries: number;
}

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/**
 * On time, in full (OTIF) and rejected deliveries per supplier for a period (inclusive dates):
 *
 *  - a line counts when its promised date (`promisedOn`) is in the period and not after `today`
 *    (lines not yet due are left out, so an order placed yesterday for next week doesn't count
 *    against anyone);
 *  - lines of cancelled orders are never due, but their deliveries and refusals still count (an
 *    order cancelled after a refused delivery must not hide the refusal); lines of draft orders
 *    are left out; lines of orders closed short count, and fail in full;
 *  - over-delivery is in full;
 *  - deliveries are counted by `deliveryId`, by received date in the period, whichever line they
 *    were for.
 *
 * Only suppliers with a line due or a delivery in the period are returned, in order of first
 * appearance.
 */
export function supplierPerformance(
  lines: readonly PerformanceLine[],
  period: { from: string; to: string; today: string },
): SupplierPerformance[] {
  const lastDue = period.to < period.today ? period.to : period.today;
  const rows = new Map<
    string,
    {
      linesDue: number;
      onTime: number;
      inFull: number;
      otif: number;
      deliveries: Set<string>;
      rejected: Set<string>;
    }
  >();
  const rowOf = (supplierId: string) => {
    let row = rows.get(supplierId);
    if (!row) {
      row = { linesDue: 0, onTime: 0, inFull: 0, otif: 0, deliveries: new Set(), rejected: new Set() };
      rows.set(supplierId, row);
    }
    return row;
  };
  for (const line of lines) {
    if (line.orderStatus === "draft") continue;
    for (const r of line.receipts) {
      if (r.receivedOn < period.from || r.receivedOn > period.to) continue;
      const row = rowOf(line.supplierId);
      row.deliveries.add(r.deliveryId);
      if (r.outcome === "rejected") row.rejected.add(r.deliveryId);
    }
    if (line.orderStatus === "cancelled") continue;
    const due = line.promisedOn;
    if (due === null || due < period.from || due > lastDue) continue;
    const row = rowOf(line.supplierId);
    row.linesDue += 1;
    const accepted = line.receipts.filter((r) => r.outcome === "accepted" && r.quantity > 0);
    const ordered = roundQuantity(line.quantity);
    const total = roundQuantity(accepted.reduce((sum, r) => sum + r.quantity, 0));
    const byDue = roundQuantity(
      accepted.filter((r) => r.receivedOn <= due).reduce((sum, r) => sum + r.quantity, 0),
    );
    const first = accepted.reduce<string | null>(
      (min, r) => (min === null || r.receivedOn < min ? r.receivedOn : min),
      null,
    );
    if (first !== null && first <= due) row.onTime += 1;
    if (total >= ordered) row.inFull += 1;
    if (byDue >= ordered) row.otif += 1;
  }
  return [...rows].map(([supplierId, r]) => ({
    supplierId,
    linesDue: r.linesDue,
    onTime: r.onTime,
    inFull: r.inFull,
    otif: r.otif,
    onTimePercent: percent(r.onTime, r.linesDue),
    inFullPercent: percent(r.inFull, r.linesDue),
    otifPercent: percent(r.otif, r.linesDue),
    deliveries: r.deliveries.size,
    rejectedDeliveries: r.rejected.size,
  }));
}

/**
 * Every supplier together: lines due, and the share delivered on time, in full and both (OTIF), as
 * percentages of the lines due. The certified metric `supplier_otif` and the supplier performance
 * page both use this.
 */
export function supplierPerformanceTotals(
  rows: ReadonlyArray<{ linesDue: number; onTime: number; inFull: number; otif: number }>,
) {
  const sum = (k: "linesDue" | "onTime" | "inFull" | "otif") => rows.reduce((t, r) => t + r[k], 0);
  const due = sum("linesDue");
  return {
    linesDue: due,
    onTimePercent: percent(sum("onTime"), due),
    inFullPercent: percent(sum("inFull"), due),
    otifPercent: percent(sum("otif"), due),
  };
}

// ─── Suggestions from the material shortfall ─────────────────────────────────

/** One item's shortfall (base unit), e.g. from production's material requirements. */
export interface SuggestionRequirement {
  itemId: string;
  shortfall: number;
}

/** The outstanding quantity (base unit) of one line of a draft or sent order. */
export interface SuggestionOnOrder {
  itemId: string;
  status: PurchaseOrderStatus;
  outstanding: number;
}

/** A supplier an item can be bought from (`item_suppliers`). */
export interface SuggestionSupplierLink {
  supplierId: string;
  preferred: boolean;
  /** When given, suspended and rejected suppliers are never suggested or offered. */
  status?: SupplierApprovalStatus;
}

export interface PurchaseSuggestion<R extends SuggestionRequirement = SuggestionRequirement> {
  requirement: R;
  itemId: string;
  shortfall: number;
  /** Outstanding on sent orders: subtracted. */
  onOrder: number;
  /** Outstanding on drafts: shown, not subtracted (a draft isn't a commitment yet). */
  onDraft: number;
  /** shortfall − onOrder, never below zero. */
  toOrder: number;
  /** The preferred supplier, else the only one, else null (someone has to choose). */
  supplierId: string | null;
  /** The item's other suppliers that can be ordered from. */
  otherSupplierIds: string[];
}

export interface PurchaseSuggestionGroup<R extends SuggestionRequirement = SuggestionRequirement> {
  /** Null: items with no single obvious supplier. */
  supplierId: string | null;
  suggestions: PurchaseSuggestion<R>[];
}

/** Why an item in production's shortfall can't go on a purchase order. */
export const notPurchasableReasons = ["made_in_house", "archived"] as const;
export type NotPurchasableReason = (typeof notPurchasableReasons)[number];
export const notPurchasableReasonLabels: Record<NotPurchasableReason, string> = {
  made_in_house: "Made in house",
  archived: "Archived",
};

/**
 * Whether an item can be bought: only active (and not deleted) ingredients and packaging. Null
 * when it can; otherwise why not. Work in progress and finished goods in production's shortfall
 * are made in house, so suggestions list them apart rather than offering to order them.
 */
export function notPurchasableReason(item: {
  type: string;
  status: string;
  deleted?: boolean;
}): NotPurchasableReason | null {
  if (!(receivableItemTypes as readonly string[]).includes(item.type)) return "made_in_house";
  if (item.status !== "active" || item.deleted) return "archived";
  return null;
}

/** The supplier to suggest for an item: the preferred one, else the only one, else null. */
export function suggestedSupplier(links: readonly SuggestionSupplierLink[]): {
  supplierId: string | null;
  otherSupplierIds: string[];
} {
  const usable = links.filter((l) => !l.status || canOrderFromSupplier(l.status));
  const supplierId =
    usable.find((l) => l.preferred)?.supplierId ?? (usable.length === 1 ? usable[0]!.supplierId : null);
  return {
    supplierId,
    otherSupplierIds: usable.filter((l) => l.supplierId !== supplierId).map((l) => l.supplierId),
  };
}

/**
 * What to order: each item's shortfall minus what is outstanding on sent orders (drafts are listed
 * as `onDraft`, not subtracted; closed and cancelled orders are ignored), never below zero.
 * Items still to order are grouped by suggested supplier (groups with a supplier first, in order of
 * first appearance, then the `null` group); items that sent orders already cover are in `covered`.
 * Requirements without a shortfall are left out. Pure: the server feeds it, nothing is stored.
 */
export function purchaseSuggestions<R extends SuggestionRequirement>(
  requirements: readonly R[],
  onOrder: readonly SuggestionOnOrder[],
  itemSuppliers: Readonly<Record<string, readonly SuggestionSupplierLink[]>>,
): { groups: PurchaseSuggestionGroup<R>[]; covered: PurchaseSuggestion<R>[] } {
  const sent = new Map<string, number>();
  const draft = new Map<string, number>();
  for (const line of onOrder) {
    const into = line.status === "sent" ? sent : line.status === "draft" ? draft : null;
    if (!into || line.outstanding <= 0) continue;
    into.set(line.itemId, roundQuantity((into.get(line.itemId) ?? 0) + line.outstanding));
  }
  const groups = new Map<string | null, PurchaseSuggestion<R>[]>();
  const covered: PurchaseSuggestion<R>[] = [];
  for (const requirement of requirements) {
    const shortfall = roundQuantity(requirement.shortfall);
    if (shortfall <= 0) continue;
    const onOrderQty = sent.get(requirement.itemId) ?? 0;
    const suggestion: PurchaseSuggestion<R> = {
      requirement,
      itemId: requirement.itemId,
      shortfall,
      onOrder: onOrderQty,
      onDraft: draft.get(requirement.itemId) ?? 0,
      toOrder: outstanding(shortfall, onOrderQty),
      ...suggestedSupplier(itemSuppliers[requirement.itemId] ?? []),
    };
    if (suggestion.toOrder <= 0) {
      covered.push(suggestion);
      continue;
    }
    const list = groups.get(suggestion.supplierId) ?? [];
    list.push(suggestion);
    groups.set(suggestion.supplierId, list);
  }
  const ordered = [...groups].sort(([a], [b]) => (a === null ? 1 : 0) - (b === null ? 1 : 0));
  return { groups: ordered.map(([supplierId, suggestions]) => ({ supplierId, suggestions })), covered };
}

// ─── Date ranges ─────────────────────────────────────────────────────────────

export const SUPPLIER_PERFORMANCE_DEFAULT_DAYS = 90;
export const PURCHASE_SUGGESTIONS_DEFAULT_DAYS = 28;
/** At most a year at a time, like production's material requirements. */
export const PURCHASE_SUGGESTIONS_MAX_DAYS = 366;

const spanDays = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

/** The supplier performance period: default the last 90 days up to today (both included). */
export function supplierPerformanceRange(
  query: { from?: string | undefined; to?: string | undefined },
  today: string,
) {
  const to = query.to ?? (query.from && query.from > today ? query.from : today);
  const from = query.from ?? addDays(to, 1 - SUPPLIER_PERFORMANCE_DEFAULT_DAYS);
  return { from, to };
}

/**
 * The suggestions window: default today to 28 days ahead. `error` when it is longer than a year
 * (possible when only `to` is given); answer 400 with it.
 */
export function purchaseSuggestionsRange(
  query: { from?: string | undefined; to?: string | undefined },
  today: string,
): { from: string; to: string; error: string | null } {
  const from = query.from ?? (query.to && query.to < today ? query.to : today);
  const to = query.to ?? addDays(from, PURCHASE_SUGGESTIONS_DEFAULT_DAYS);
  const error =
    from > to
      ? "`to` is before `from`"
      : spanDays(from, to) > PURCHASE_SUGGESTIONS_MAX_DAYS
        ? "At most a year at a time"
        : null;
  return { from, to, error };
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
/**
 * A bound on the number entered. It is in the entered unit, so it doesn't bound what is stored:
 * the server converts to the base unit (1e9 kg is 1e12 g) and refuses a base quantity above
 * `PURCHASE_MAX_BASE_QUANTITY`.
 */
const MAX_QUANTITY = 1_000_000_000;
const positiveQuantity = z.number().positive().finite().max(MAX_QUANTITY);
/** Up to `PRICE_DECIMALS` (8) places; more are rounded. Below the `numeric(18,8)` limit. */
const price = z
  .number()
  .min(0)
  .finite()
  .max(1_000_000_000)
  .transform((v) => roundQuantity(v, PRICE_DECIMALS));
const page = {
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
};

/**
 * The largest quantity a line or receipt may hold in the item's base unit: the `numeric(14,4)`
 * columns hold less than 1e10, so 1e9 leaves room (a tonne is 1e6 g).
 */
export const PURCHASE_MAX_BASE_QUANTITY = 1_000_000_000;

export const PURCHASE_ORDER_MAX_LINES = 200;
export const PURCHASE_RECEIPT_MAX_LINES = 100;
/** How many orders one `POST /purchasing/suggestions` may create. */
export const PURCHASE_SUGGESTIONS_MAX_ORDERS = 50;

/**
 * What an order line buys. `stock`: an item (ingredient or packaging) received into stock as a lot,
 * with its quantity in the item's base unit; needs the stock module. `non_stock`: a service,
 * subscription or goods not kept in stock, described in free text with its own unit, received
 * without a lot or stock movement.
 */
export const purchaseOrderLineKinds = ["stock", "non_stock"] as const;
export type PurchaseOrderLineKind = (typeof purchaseOrderLineKinds)[number];
export const purchaseOrderLineKindLabels: Record<PurchaseOrderLineKind, string> = {
  stock: "Stock item",
  non_stock: "Non-stock",
};

/** Longest free-text unit (`hour`, `month`, `licence`) on a non-stock line. */
export const PURCHASE_UNIT_LABEL_MAX = 40;
/** Longest expense or nominal code text on a non-stock line. */
export const PURCHASE_NOMINAL_CODE_MAX = 60;

const commonLineFields = {
  /** Per the line's unit. Stock lines: left out, the price list or the item's standard cost. Null: price unknown. */
  unitPrice: price.nullable().optional(),
  /** Overrides the order's expected date for this line. */
  expectedOn: isoDate.nullable().optional(),
  notes: optionalText(2000).optional(),
};

const stockLineFields = {
  /** Left out: a stock line (what every order line was before non-stock lines). */
  kind: z.literal("stock").default("stock"),
  itemId: z.uuid(),
  /** In `unit`; stored in the item's base unit. */
  quantity: positiveQuantity,
  unit: z.enum(unitCodes),
  ...commonLineFields,
};

const nonStockLineFields = {
  kind: z.literal("non_stock"),
  /** What is bought: "Window cleaning, March", "CRM subscription". */
  description: requiredText(500),
  /** Optional: an item this line is for (a reference only: nothing is converted or stocked). */
  itemId: z.uuid().nullable().optional(),
  /** In the line's own unit, stored as entered. */
  quantity: positiveQuantity,
  /** Free text or a unit code (`hour`, `month`, `each`); left out: no unit. */
  unit: optionalText(PURCHASE_UNIT_LABEL_MAX).optional(),
  /** The expense account or nominal code it is coded to, as text (`7500`, `Cleaning`). */
  nominalCode: optionalText(PURCHASE_NOMINAL_CODE_MAX).optional(),
  ...commonLineFields,
};

/** A stock line only: what suggestions create. */
export const purchaseOrderStockLineSchema = z.object(stockLineFields);
export type PurchaseOrderStockLineInput = z.infer<typeof purchaseOrderStockLineSchema>;
export const purchaseOrderNonStockLineSchema = z.object(nonStockLineFields);
export type PurchaseOrderNonStockLineInput = z.infer<typeof purchaseOrderNonStockLineSchema>;

/** A line: `kind` left out is a stock line. */
export const purchaseOrderLineSchema = z.discriminatedUnion("kind", [
  purchaseOrderStockLineSchema,
  purchaseOrderNonStockLineSchema,
]);
export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineSchema>;

/**
 * A line in an update: `id` keeps (and edits) an existing line; without one it is a new line. A
 * line's kind can't change once it has deliveries or is on an invoice.
 */
export const purchaseOrderLineUpdateSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.uuid().optional(), ...stockLineFields }),
  z.object({ id: z.uuid().optional(), ...nonStockLineFields }),
]);
export type PurchaseOrderLineUpdateInput = z.infer<typeof purchaseOrderLineUpdateSchema>;

const headerFields = {
  supplierId: z.uuid(),
  /** Requested delivery date; needed (here or on every line) to send. */
  expectedOn: isoDate.nullable(),
  /** The default location in the receive form. */
  deliveryLocationId: z.uuid().nullable(),
  /** The supplier's order confirmation number. */
  supplierReference: optionalText(120),
  notes: optionalText(4000),
};

export const purchaseOrderCreateSchema = z.object({
  id: z.uuid().optional(),
  supplierId: headerFields.supplierId,
  expectedOn: headerFields.expectedOn.optional(),
  deliveryLocationId: headerFields.deliveryLocationId.optional(),
  supplierReference: headerFields.supplierReference.optional(),
  notes: headerFields.notes.optional(),
  lines: z.array(purchaseOrderLineSchema).max(PURCHASE_ORDER_MAX_LINES).default([]),
});
export type PurchaseOrderCreateInput = z.infer<typeof purchaseOrderCreateSchema>;

/**
 * Header fields to change and, optionally, the full list of lines (a replacement: lines left out
 * are removed). Once sent, the supplier can't change and lines with receipts can't be removed.
 */
export const purchaseOrderUpdateSchema = z
  .object({
    ...headerFields,
    lines: z
      .array(purchaseOrderLineUpdateSchema)
      .max(PURCHASE_ORDER_MAX_LINES)
      .refine((lines) => {
        const ids = lines.flatMap((l) => (l.id ? [l.id] : []));
        return new Set(ids).size === ids.length;
      }, "A line is listed twice"),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type PurchaseOrderUpdateInput = z.infer<typeof purchaseOrderUpdateSchema>;

/** Sending: a commitment to buy (a person). `orderedOn` defaults to today; not in the future. */
export const purchaseOrderSendSchema = z.object({
  orderedOn: isoDate.optional(),
  supplierReference: optionalText(120).optional(),
  /** Sending despite the supplier's open control issues when they block: why (people only, recorded). */
  controlsOverride: z.string().trim().min(1).max(2000).optional(),
});
export type PurchaseOrderSendInput = z.infer<typeof purchaseOrderSendSchema>;

/** Closing short: nothing more is expected. */
export const purchaseOrderCloseSchema = z.object({ reason: requiredText(500) });
export type PurchaseOrderCloseInput = z.infer<typeof purchaseOrderCloseSchema>;

export const purchaseOrderCancelSchema = z.object({ reason: requiredText(500) });
export type PurchaseOrderCancelInput = z.infer<typeof purchaseOrderCancelSchema>;

/**
 * An accepted line. For a **stock** line it is received into stock as a lot: `locationId` is
 * needed (or the order's delivery location), `unit` defaults to the order line's, and the lot
 * fields apply. For a **non-stock** line only the quantity (in the line's own unit), price and
 * over-delivery reason count: `unit` and the lot fields must be left out.
 */
const acceptedReceiptLine = z.object({
  lineId: z.uuid(),
  outcome: z.literal("accepted"),
  quantity: positiveQuantity,
  /** Stock lines: the unit of `quantity` (default the order line's). Non-stock lines: leave out. */
  unit: z.enum(unitCodes).optional(),
  /** Stock lines: where it goes (default the order's delivery location). */
  locationId: z.uuid().optional(),
  /** Generated (`L` + yymmdd + sequence) when left out. */
  lotCode: optionalText(60).optional(),
  /** The supplier's own batch code: one step back in the trace. */
  supplierLotCode: optionalText(80).optional(),
  expiresOn: isoDate.nullable().optional(),
  expiryType: z.enum(expiryTypes).nullable().optional(),
  /** Receive into quarantine (required while the supplier's approval is pending). */
  status: z.enum(["available", "quarantine"]).optional(),
  /** The invoice price per `unit`, when it differs from the order's. */
  unitPrice: price.nullable().optional(),
  /**
   * Why more than the over-delivery tolerance was accepted. Needed (`409`) when the workspace has
   * a tolerance and this line's accepted total goes past ordered plus that percentage; ignored
   * otherwise.
   */
  overDeliveryReason: optionalText(500).optional(),
});
const rejectedReceiptLine = z.object({
  lineId: z.uuid(),
  outcome: z.literal("rejected"),
  quantity: positiveQuantity,
  /** Stock lines: the unit of `quantity` (default the order line's). Non-stock lines: leave out. */
  unit: z.enum(unitCodes).optional(),
  /** Why it was refused. */
  reason: requiredText(500),
});
export const purchaseReceiptLineSchema = z.discriminatedUnion("outcome", [
  acceptedReceiptLine,
  rejectedReceiptLine,
]);
export type PurchaseReceiptLineInput = z.infer<typeof purchaseReceiptLineSchema>;
export type PurchaseReceiptAcceptedLineInput = z.infer<typeof acceptedReceiptLine>;
export type PurchaseReceiptRejectedLineInput = z.infer<typeof rejectedReceiptLine>;

/** One delivery against an order: every row shares a `deliveryId`. */
export const purchaseReceiveSchema = z
  .object({
    commandId: z.uuid().optional(),
    /** Not in the future (checked by the server, which knows today). */
    receivedOn: isoDate,
    /** The delivery note number. */
    deliveryReference: optionalText(120).optional(),
    notes: optionalText(2000).optional(),
    lines: z.array(purchaseReceiptLineSchema).min(1).max(PURCHASE_RECEIPT_MAX_LINES),
  })
  .superRefine((v, ctx) => {
    v.lines.forEach((line, i) => {
      if (line.outcome !== "accepted") return;
      if (line.expiresOn && !line.expiryType)
        ctx.addIssue({
          code: "custom",
          path: ["lines", i, "expiryType"],
          message: "Say whether the date is a use-by or a best-before date",
        });
      if (line.expiryType && !line.expiresOn)
        ctx.addIssue({
          code: "custom",
          path: ["lines", i, "expiresOn"],
          message: "An expiry type needs an expiry date",
        });
      if (line.expiresOn && line.expiresOn < v.receivedOn)
        ctx.addIssue({
          code: "custom",
          path: ["lines", i, "expiresOn"],
          message: "The expiry date is before the received date",
        });
    });
  });
export type PurchaseReceiveInput = z.infer<typeof purchaseReceiveSchema>;

/** `open`: sent and not fully received (`sent` or `part_received`). */
export const purchaseOrderListStatuses = ["open", ...purchaseOrderStates, "all"] as const;
export type PurchaseOrderListStatus = (typeof purchaseOrderListStatuses)[number];

export const purchaseOrderListQuerySchema = z
  .object({
    /** Matches the reference, the supplier's name or the supplier's reference. */
    q: z.string().trim().max(200).optional(),
    status: z.enum(purchaseOrderListStatuses).default("all"),
    supplierId: z.uuid().optional(),
    /** Orders with a line for this item. */
    itemId: z.uuid().optional(),
    /** Inclusive, on the order's expected date. */
    from: isoDate.optional(),
    to: isoDate.optional(),
    ...page,
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ["to"], message: "`to` is before `from`" });
export type PurchaseOrderListQuery = z.infer<typeof purchaseOrderListQuerySchema>;

/** Default: the last 90 days to today (`supplierPerformanceRange`). */
export const supplierPerformanceQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    supplierId: z.uuid().optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ["to"], message: "`to` is before `from`" });
export type SupplierPerformanceQuery = z.infer<typeof supplierPerformanceQuerySchema>;

/** Default: today to 28 days ahead, at most a year (`purchaseSuggestionsRange`). */
export const purchaseSuggestionsQuerySchema = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ["to"], message: "`to` is before `from`" })
  .refine((v) => !v.from || !v.to || spanDays(v.from, v.to) <= PURCHASE_SUGGESTIONS_MAX_DAYS, {
    path: ["to"],
    message: "At most a year at a time",
  });
export type PurchaseSuggestionsQuery = z.infer<typeof purchaseSuggestionsQuerySchema>;

/**
 * `POST /purchasing/suggestions`: draft orders to create together, all or nothing. Each is what
 * `POST /purchasing/orders` takes and is checked the same way.
 */
export const purchaseSuggestionsCreateSchema = z.object({
  orders: z
    .array(
      purchaseOrderCreateSchema.extend({
        lines: z.array(purchaseOrderStockLineSchema).min(1).max(PURCHASE_ORDER_MAX_LINES),
      }),
    )
    .min(1)
    .max(PURCHASE_SUGGESTIONS_MAX_ORDERS),
});
export type PurchaseSuggestionsCreateInput = z.infer<typeof purchaseSuggestionsCreateSchema>;
