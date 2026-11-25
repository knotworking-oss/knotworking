/**
 * Purchasing module: purchase orders, their lines, and goods-in against them.
 * See docs/modules.md and `@knotworking/core` purchasing.ts.
 *
 * Stock lines' quantities are in the item's base unit (g, ml or each); non-stock lines' (services,
 * subscriptions, goods not kept in stock) are as entered. An order's displayed state (part
 * received, received) is derived from its receipts, never stored. Received quantities are the sum
 * of accepted receipts whose stock movement has not been reversed and that are not voided.
 */
import type {
  ApprovedInvoiceLineMatch,
  InvoiceMatchStatus,
  InvoiceTolerances,
  PurchaseCreditLineKind,
  PurchaseCreditLineReason,
  PurchaseCreditNoteStatus,
  PurchaseInvoiceLineKind,
  PurchaseInvoiceStatus,
  PurchaseOrderEmailStatus,
  PurchaseOrderLineKind,
  PurchaseOrderStatus,
  PurchaseReceiptOutcome,
  SupplierControlsOverride,
  UnitCode,
} from "@knotworking/core";
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { items, suppliers } from "./items";
import { stockLocations, stockLots, stockMovements } from "./stock";

const quantity = (name: string) => numeric(name, { precision: 14, scale: 4, mode: "number" });

/** An order to one supplier. Its reference (`PO-2026-001`) is unique in the workspace, never reused. */
export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    reference: text("reference").notNull(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    status: text("status").$type<PurchaseOrderStatus>().notNull().default("draft"),
    /** Set when sent. */
    orderedOn: date("ordered_on"),
    /** Requested delivery date (lines may override it). */
    expectedOn: date("expected_on"),
    /** The default location in the receive form. */
    deliveryLocationId: uuid("delivery_location_id").references(() => stockLocations.id),
    /** The supplier's order confirmation number. */
    supplierReference: text("supplier_reference"),
    notes: text("notes"),
    sentAt: ts("sent_at"),
    sentBy: uuid("sent_by").references(() => users.id, { onDelete: "set null" }),
    /** Closed short: nothing more is expected. */
    closedAt: ts("closed_at"),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    closeReason: text("close_reason"),
    cancelledAt: ts("cancelled_at"),
    cancelledBy: uuid("cancelled_by").references(() => users.id, { onDelete: "set null" }),
    cancelReason: text("cancel_reason"),
    /**
     * Approval to send an order above the workspace's threshold: by a manager other than the
     * creator, covering orders up to `sendApprovedValue` (the value when approved). Cleared when
     * the supplier changes.
     */
    sendApprovedBy: uuid("send_approved_by").references(() => users.id, { onDelete: "set null" }),
    sendApprovedAt: ts("send_approved_at"),
    sendApprovedValue: numeric("send_approved_value", { precision: 14, scale: 4, mode: "number" }),
    sendApprovalNote: text("send_approval_note"),
    /** Sent despite open supplier control issues (enforcement `block`): the reason and those issues. */
    sendControlsOverride: jsonb("send_controls_override").$type<SupplierControlsOverride>(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("purchase_orders_reference_key").on(t.workspaceId, t.reference),
    index("purchase_orders_status_idx").on(t.workspaceId, t.status),
    index("purchase_orders_supplier_idx").on(t.supplierId),
  ],
);

/**
 * One line of an order. A `stock` line is an item received into stock (quantity in the item's base
 * unit, `unit` the unit it was entered in). A `non_stock` line is a service, subscription or goods
 * not kept in stock: a description, an optional item it refers to, the quantity as entered in its
 * own free-text unit (`unitLabel`) and an expense or nominal code. The same item may be on several
 * lines.
 */
export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    /** 1..n: the order of lines on the order. */
    lineNo: integer("line_no").notNull(),
    kind: text("kind").$type<PurchaseOrderLineKind>().notNull().default("stock"),
    /** Stock lines: the item (required). Non-stock lines: an optional reference. */
    itemId: uuid("item_id").references(() => items.id),
    /** Stock lines: ordered, in the item's base unit. Non-stock lines: as entered, in `unitLabel`. */
    quantity: quantity("quantity").notNull(),
    /** Stock lines: the unit the line was entered and is shown in (required). Null on non-stock lines. */
    unit: text("unit").$type<UnitCode>(),
    /** Non-stock lines: what is bought (required). */
    description: text("description"),
    /** Non-stock lines: the unit, as free text (`hour`, `month`); null for none. */
    unitLabel: text("unit_label"),
    /** Non-stock lines: the expense account or nominal code it is coded to, as text. */
    nominalCode: text("nominal_code"),
    /**
     * Per `unit` (8 places: a line in grams of an item costed per kilo has a small price); null
     * when the price is unknown.
     */
    unitPrice: numeric("unit_price", { precision: 18, scale: 8, mode: "number" }),
    /** Overrides the order's expected date. */
    expectedOn: date("expected_on"),
    /**
     * The date promised: the line's effective expected date when the order was sent (or when the
     * line was added to a sent order). Never changed by later edits; supplier performance measures
     * against it. Null on drafts.
     */
    promisedOn: date("promised_on"),
    notes: text("notes"),
    ...timestamps(),
  },
  (t) => [
    index("purchase_order_lines_order_idx").on(t.purchaseOrderId, t.lineNo),
    index("purchase_order_lines_item_idx").on(t.workspaceId, t.itemId),
    check("purchase_order_lines_kind_check", sql`${t.kind} in ('stock', 'non_stock')`),
    // A stock line is an item in a unit that converts; existing rows are all stock lines.
    check(
      "purchase_order_lines_stock_check",
      sql`${t.kind} <> 'stock' or (${t.itemId} is not null and ${t.unit} is not null)`,
    ),
    // A non-stock line is described and has no stock unit (its quantity is as entered).
    check(
      "purchase_order_lines_non_stock_check",
      sql`${t.kind} <> 'non_stock' or (${t.description} is not null and ${t.unit} is null)`,
    ),
  ],
);

/**
 * Goods-in against an order: one row per line per delivery. **Append-only**: an accepted receipt
 * is corrected by reversing its stock movement, not by editing or deleting the row.
 */
export const purchaseReceipts = pgTable(
  "purchase_receipts",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id),
    lineId: uuid("line_id")
      .notNull()
      .references(() => purchaseOrderLines.id),
    /** The order line's item; null for a non-stock line without one. */
    itemId: uuid("item_id").references(() => items.id),
    /** Shared by every row of one delivery. */
    deliveryId: uuid("delivery_id").notNull(),
    outcome: text("outcome").$type<PurchaseReceiptOutcome>().notNull(),
    /**
     * Accepted (received; into stock for a stock line) or refused at the door (rejected). Stock
     * lines: base unit. Non-stock lines: the line's own unit.
     */
    quantity: quantity("quantity").notNull(),
    receivedOn: date("received_on").notNull(),
    /** Set for accepted rows of stock lines; null for rejected ones and non-stock lines. */
    lotId: uuid("lot_id").references(() => stockLots.id),
    stockMovementId: uuid("stock_movement_id").references(() => stockMovements.id),
    /**
     * Per base unit (8 places: a price per gram is small), what costing reads; per the line's own
     * unit on a non-stock line. Null when unknown.
     */
    unitPrice: numeric("unit_price", { precision: 18, scale: 8, mode: "number" }),
    /** The delivery note number. */
    deliveryReference: text("delivery_reference"),
    /** Why it was refused (rejected rows). */
    reason: text("reason"),
    /** Accepted rows: why more than the over-delivery tolerance was accepted. */
    overDeliveryReason: text("over_delivery_reason"),
    notes: text("notes"),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * A row recorded in error is voided, never deleted or edited: it stays on the order (struck
     * through) and counts nowhere. Rejected rows and accepted rows of non-stock lines are voided;
     * accepted rows of stock lines are corrected by reversing the stock movement instead.
     */
    voidedAt: ts("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),
    ...timestamps(),
  },
  (t) => [
    index("purchase_receipts_line_idx").on(t.lineId),
    index("purchase_receipts_order_idx").on(t.purchaseOrderId),
    index("purchase_receipts_received_idx").on(t.workspaceId, t.receivedOn),
    index("purchase_receipts_lot_idx").on(t.lotId),
    // Only an item's receipt can put a lot into stock.
    check(
      "purchase_receipts_stock_check",
      sql`${t.itemId} is not null or (${t.lotId} is null and ${t.stockMovementId} is null)`,
    ),
  ],
);

const money = (name: string) => numeric(name, { precision: 14, scale: 4, mode: "number" });
const percent = (name: string) => numeric(name, { precision: 6, scale: 2, mode: "number" });

/**
 * A supplier's invoice. The supplier's invoice number is unique per supplier (case-insensitive);
 * versions share it. A draft is edited freely (people and agents); approval for payment is a
 * person's and makes it immutable. A correction is a new version (`supersedesId`), a draft until it
 * is approved, when the version it replaces becomes `superseded`. Amounts are plain numbers.
 */
export const purchaseInvoices = pgTable(
  "purchase_invoices",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    invoiceNumber: text("invoice_number").notNull(),
    /** 1, then one more for each correction. */
    version: integer("version").notNull().default(1),
    /** The approved version this one corrects. */
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => purchaseInvoices.id),
    status: text("status").$type<PurchaseInvoiceStatus>().notNull().default("draft"),
    invoiceDate: date("invoice_date").notNull(),
    dueDate: date("due_date"),
    /** VAT as a plain amount. */
    vat: money("vat").notNull().default(0),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: ts("approved_at"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    /**
     * The three-way match when it was approved: the status shown and used for an approved or
     * superseded invoice (each line keeps its own in `approvedMatch`).
     */
    approvedMatchStatus: text("approved_match_status").$type<InvoiceMatchStatus>(),
    /** The workspace's tolerances it was approved against. */
    approvedTolerances: jsonb("approved_tolerances").$type<InvoiceTolerances>(),
    /** Why a mismatch was approved (required then). */
    approvalReason: text("approval_reason"),
    supersededAt: ts("superseded_at"),
    supersededById: uuid("superseded_by_id").references((): AnyPgColumn => purchaseInvoices.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("purchase_invoices_number_key")
      .on(t.workspaceId, t.supplierId, sql`lower(${t.invoiceNumber})`, t.version)
      .where(sql`${t.deletedAt} is null`),
    index("purchase_invoices_status_idx").on(t.workspaceId, t.status),
    index("purchase_invoices_supplier_idx").on(t.supplierId),
  ],
);

/**
 * One line of an invoice: matched to a purchase order line (quantity and price per that line's
 * unit), or a non-stock charge such as carriage.
 */
export const purchaseInvoiceLines = pgTable(
  "purchase_invoice_lines",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => purchaseInvoices.id, { onDelete: "cascade" }),
    /** 1..n: the order of lines on the invoice. */
    lineNo: integer("line_no").notNull(),
    kind: text("kind").$type<PurchaseInvoiceLineKind>().notNull(),
    /** `order` lines: the order line invoiced, and its order and item. */
    orderLineId: uuid("order_line_id").references(() => purchaseOrderLines.id),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id),
    itemId: uuid("item_id").references(() => items.id),
    /** In `unit` (the order line's), or a count for charges. */
    quantity: quantity("quantity").notNull(),
    /** The order line's unit; null for charges. */
    unit: text("unit").$type<UnitCode>(),
    /** Per `unit` (8 places, like order line prices). */
    unitPrice: numeric("unit_price", { precision: 18, scale: 8, mode: "number" }).notNull(),
    description: text("description"),
    /**
     * `order` lines of an approved or superseded invoice: what the line was matched against when
     * the invoice was approved (order price and unit, unit conversion, received, invoiced
     * elsewhere) and its match then. Null on drafts and charges.
     */
    approvedMatch: jsonb("approved_match").$type<ApprovedInvoiceLineMatch>(),
    ...timestamps(),
  },
  (t) => [
    index("purchase_invoice_lines_invoice_idx").on(t.invoiceId, t.lineNo),
    index("purchase_invoice_lines_order_line_idx").on(t.orderLineId),
    index("purchase_invoice_lines_order_idx").on(t.workspaceId, t.purchaseOrderId),
  ],
);

/** One row per workspace: the three-way match tolerances (`defaultInvoiceTolerances` until saved). */
export const purchasingSettings = pgTable("purchasing_settings", {
  workspaceId: workspaceRef().primaryKey(),
  priceTolerancePercent: percent("price_tolerance_percent").notNull(),
  priceToleranceAmount: money("price_tolerance_amount").notNull(),
  quantityTolerancePercent: percent("quantity_tolerance_percent").notNull(),
  quantityToleranceAmount: money("quantity_tolerance_amount").notNull(),
  /** Orders worth more than this need a manager's approval (not the creator's) to be sent; null: off. */
  sendApprovalThreshold: money("send_approval_threshold"),
  /** Accepted deliveries above ordered + this percentage need a reason; null: no tolerance check. */
  overDeliveryTolerancePercent: percent("over_delivery_tolerance_percent"),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  ...timestamps(),
});

/**
 * A purchase order emailed to the supplier: one row per attempt, so a failed send is on record too.
 * The email's body is rebuilt from the order, never stored.
 */
export const purchaseOrderEmails = pgTable(
  "purchase_order_emails",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    status: text("status").$type<PurchaseOrderEmailStatus>().notNull(),
    /** Why a failed attempt failed. */
    error: text("error"),
    sentBy: uuid("sent_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [index("purchase_order_emails_order_idx").on(t.purchaseOrderId)],
);

/**
 * A supplier's price for an item (the price list): per `unit`, in force from `effectiveFrom` until
 * `effectiveTo` (inclusive; null: until replaced). The price in force when a line is added becomes
 * its default price, ahead of the item's standard cost.
 */
export const purchaseSupplierPrices = pgTable(
  "purchase_supplier_prices",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    unit: text("unit").$type<UnitCode>().notNull(),
    /** Per `unit` (8 places, like order line prices). */
    unitPrice: numeric("unit_price", { precision: 18, scale: 8, mode: "number" }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("purchase_supplier_prices_key")
      .on(t.workspaceId, t.supplierId, t.itemId, t.effectiveFrom)
      .where(sql`${t.deletedAt} is null`),
    index("purchase_supplier_prices_item_idx").on(t.workspaceId, t.itemId),
  ],
);

/**
 * A supplier's credit note against one approved invoice: its own document with the supplier's
 * credit note number (unique per supplier among live ones). Lines credit lines of that invoice
 * (a price reduction, or goods sent back) or are charges credited (carriage). A draft is edited
 * by people and agents; approval is a person's and makes it immutable; a wrong approved one is
 * voided, never edited. Amounts are plain numbers (positive: what is credited).
 */
export const purchaseCreditNotes = pgTable(
  "purchase_credit_notes",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    /** The invoice credited. */
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => purchaseInvoices.id),
    creditNoteNumber: text("credit_note_number").notNull(),
    status: text("status").$type<PurchaseCreditNoteStatus>().notNull().default("draft"),
    creditDate: date("credit_date").notNull(),
    /** VAT credited, as a plain amount. */
    vat: money("vat").notNull().default(0),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: ts("approved_at"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    voidedAt: ts("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("purchase_credit_notes_number_key")
      .on(t.workspaceId, t.supplierId, sql`lower(${t.creditNoteNumber})`)
      .where(sql`${t.deletedAt} is null and ${t.status} <> 'voided'`),
    index("purchase_credit_notes_invoice_idx").on(t.invoiceId),
    index("purchase_credit_notes_status_idx").on(t.workspaceId, t.status),
  ],
);

/** One line of a credit note: a credited invoice line, or a credited charge. */
export const purchaseCreditNoteLines = pgTable(
  "purchase_credit_note_lines",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    creditNoteId: uuid("credit_note_id")
      .notNull()
      .references(() => purchaseCreditNotes.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    kind: text("kind").$type<PurchaseCreditLineKind>().notNull(),
    /** `invoice_line`: the invoice line credited, and the order line it is on (what costing reads). */
    invoiceLineId: uuid("invoice_line_id").references(() => purchaseInvoiceLines.id),
    orderLineId: uuid("order_line_id").references(() => purchaseOrderLines.id),
    reason: text("reason").$type<PurchaseCreditLineReason>(),
    /** In the invoice line's unit, or a count for charges. */
    quantity: quantity("quantity").notNull(),
    /** Credited per unit (8 places). */
    unitPrice: numeric("unit_price", { precision: 18, scale: 8, mode: "number" }).notNull(),
    description: text("description"),
    ...timestamps(),
  },
  (t) => [
    index("purchase_credit_note_lines_note_idx").on(t.creditNoteId, t.lineNo),
    index("purchase_credit_note_lines_order_line_idx").on(t.orderLineId),
    index("purchase_credit_note_lines_invoice_line_idx").on(t.invoiceLineId),
  ],
);
