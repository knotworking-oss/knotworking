import { executeLedgerCommand } from "./ledger-command";
import {
  BASE_PRICE_DECIMALS,
  PRICE_DECIMALS,
  PURCHASE_MAX_BASE_QUANTITY,
  canOrderFromSupplier,
  convertQuantity,
  moduleIds,
  type ModuleId,
  convertUnitPrice,
  isOverDeliveryTolerance,
  itemBaseUnit,
  newId,
  notPurchasableReason,
  orderValueLimitRefusal,
  lineReceiptState,
  outstanding,
  purchaseOrderReference,
  purchaseOrderReferenceSequence,
  purchaseOrderState,
  purchaseOrderStatusLabels,
  purchaseOrderValue,
  purchaseReceiptMovementReference,
  purchaseSuggestions,
  receivableItemTypes,
  roundQuantity,
  sendApprovalState,
  stockAmount,
  supplierPerformance,
  supplierPerformanceTotals,
  supplierPerformanceRange,
  type PerformanceLine,
  type PurchaseOrderCancelInput,
  type PurchaseOrderCloseInput,
  type PurchaseOrderCreateInput,
  type PurchaseOrderLineInput,
  type PurchaseOrderLineUpdateInput,
  type PurchaseOrderListQuery,
  type PurchaseOrderSendInput,
  type PurchaseOrderStatus,
  type PurchaseOrderUpdateInput,
  type PurchaseReceiveInput,
  type PurchaseSuggestionsCreateInput,
  type SuggestionSupplierLink,
  type SupplierPerformanceQuery,
  type UnitCode,
} from "@knotworking/core";
import {
  itemSuppliers,
  items,
  lockWorkspaceLog,
  purchaseInvoiceLines,
  purchaseInvoices,
  purchaseOrderEmails,
  purchaseOrderLines,
  purchaseOrders,
  purchaseReceipts,
  recordChanges,
  stockLocations,
  stockLots,
  stockMovements,
  suppliers,
  users,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ApiError, badRequest, notFound } from "../errors";
import { workspaceToday } from "./time-zone";
import {
  deliverNotifications,
  notifyPurchaseOrderApprovalNeeded,
  type NotificationRow,
} from "./notifications";
import { getMaterialRequirements } from "./ports/production";
import { getOrderSettings, listPriceFor } from "./purchasing-settings";
import { checkSupplierControls } from "./supplier-controls";
import {
  assertItemReceivable,
  assertSupplierCanDeliver,
  createLot,
  findActiveLocation,
  findItem,
  insertMovements,
  itemSummary,
  lotChange,
  movementChange,
  num,
  toBase,
} from "./ports/stock";

/**
 * Purchasing module: purchase orders, goods-in against them and supplier performance.
 *
 * - Quantities on lines and receipts are in the item's base unit; a line keeps the unit it was
 *   entered in (`unit`), and its price is per that unit. A receipt's price is per base unit.
 * - The displayed state (part received, received) is derived, never stored: received quantities
 *   are the accepted receipts whose stock movement has not been reversed (the stock module's
 *   reversal is how an accepted receipt is corrected; purchasing has no reversal of its own).
 * - Receipts are append-only: nothing here updates or deletes one.
 * - Every write takes the workspace lock (references, balances) and records its changes.
 *
 * "Today" is the UTC date.
 */

type OrderRow = typeof purchaseOrders.$inferSelect;
type LineRow = typeof purchaseOrderLines.$inferSelect;
type ReceiptRow = typeof purchaseReceipts.$inferSelect;
type ItemRow = typeof items.$inferSelect;
type SupplierRow = typeof suppliers.$inferSelect;

const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
const ilike = (column: unknown, q: string) => sql`${column} ilike ${like(q)} escape '!'`;

export const strip = <T extends { workspaceId: string; deletedAt: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
};

const notInFuture = (date: string, field: string, today: string) => {
  if (date > today) throw badRequest(`${field} can't be in the future`);
};

/** The stock movement that reverses a receipt's movement, if any. */
const reversal = alias(stockMovements, "reversal");

// ─── Sync log ────────────────────────────────────────────────────────────────

export const orderChange = (row: OrderRow): ChangeInput => ({
  entity: "purchase_order",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});
const lineChange = (row: LineRow): ChangeInput => ({
  entity: "purchase_order_line",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});
export const receiptChange = (row: ReceiptRow): ChangeInput => ({
  entity: "purchase_receipt",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

// ─── Lookups ─────────────────────────────────────────────────────────────────

export async function findOrder(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.id, id),
        eq(purchaseOrders.workspaceId, workspaceId),
        isNull(purchaseOrders.deletedAt),
      ),
    );
  if (!row) throw notFound("Purchase order");
  return row;
}

export async function liveLines(db: Executor, orderIds: string[]) {
  if (!orderIds.length) return [];
  return db
    .select()
    .from(purchaseOrderLines)
    .where(and(inArray(purchaseOrderLines.purchaseOrderId, orderIds), isNull(purchaseOrderLines.deletedAt)))
    .orderBy(asc(purchaseOrderLines.lineNo), asc(purchaseOrderLines.id));
}

export async function findSupplier(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, id), eq(suppliers.workspaceId, workspaceId), isNull(suppliers.deletedAt)));
  if (!row) throw notFound("Supplier");
  return row;
}

/** Suspended and rejected suppliers can't be ordered from; a pending one can. */
function assertOrderable(supplier: SupplierRow) {
  if (!canOrderFromSupplier(supplier.approvalStatus)) {
    throw new ApiError(
      409,
      "supplier_not_approved",
      `${supplier.name} is ${supplier.approvalStatus}; nothing can be ordered from them`,
    );
  }
}

const supplierSummary = (s: Pick<SupplierRow, "id" | "name" | "code" | "approvalStatus">) => ({
  id: s.id,
  name: s.name,
  code: s.code,
  approvalStatus: s.approvalStatus,
});

/** The orders' states need these: accepted (unreversed) and rejected totals per line. */
async function lineTotals(db: Executor, lineIds: string[]) {
  const map = new Map<string, { received: number; rejected: number; receipts: number }>();
  if (!lineIds.length) return map;
  const rows = await db
    .select({
      lineId: purchaseReceipts.lineId,
      received: sql<string>`coalesce(sum(${purchaseReceipts.quantity}) filter (where ${purchaseReceipts.outcome} = 'accepted' and ${reversal.id} is null), 0)`,
      rejected: sql<string>`coalesce(sum(${purchaseReceipts.quantity}) filter (where ${purchaseReceipts.outcome} = 'rejected' and ${purchaseReceipts.voidedAt} is null), 0)`,
      receipts: count(),
    })
    .from(purchaseReceipts)
    .leftJoin(reversal, eq(reversal.reversesMovementId, purchaseReceipts.stockMovementId))
    .where(inArray(purchaseReceipts.lineId, lineIds))
    .groupBy(purchaseReceipts.lineId);
  for (const r of rows) {
    map.set(r.lineId, { received: num(r.received), rejected: num(r.rejected), receipts: r.receipts });
  }
  return map;
}

/**
 * The order lines among `lineIds` that are on a live supplier invoice (a draft, approved or
 * superseded version), each with the quantity on approved invoices now in force (per the order
 * line's unit, which invoice lines keep). Such a line is fixed like a received one: its item, unit
 * and price are what the invoice was matched and costed against.
 */
async function invoicedLines(db: Executor, lineIds: string[]) {
  const map = new Map<string, { approvedQuantity: number }>();
  if (!lineIds.length) return map;
  const rows = await db
    .select({
      lineId: purchaseInvoiceLines.orderLineId,
      approved: sql<string>`coalesce(sum(${purchaseInvoiceLines.quantity}) filter (where ${purchaseInvoices.status} = 'approved'), 0)`,
    })
    .from(purchaseInvoiceLines)
    .innerJoin(purchaseInvoices, eq(purchaseInvoices.id, purchaseInvoiceLines.invoiceId))
    .where(
      and(
        inArray(purchaseInvoiceLines.orderLineId, lineIds),
        isNull(purchaseInvoiceLines.deletedAt),
        isNull(purchaseInvoices.deletedAt),
      ),
    )
    .groupBy(purchaseInvoiceLines.orderLineId);
  for (const r of rows) if (r.lineId) map.set(r.lineId, { approvedQuantity: roundQuantity(num(r.approved)) });
  return map;
}

async function userNames(db: Executor, ids: (string | null)[]) {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const rows = list.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, list))
    : [];
  const map = new Map(rows.map((r) => [r.id, r.name]));
  return (id: string | null) => (id ? (map.get(id) ?? null) : null);
}

// ─── Views ───────────────────────────────────────────────────────────────────

/** The line's effective expected date: its own, else the order's. */
const lineExpectedOn = (line: LineRow, order: OrderRow) => line.expectedOn ?? order.expectedOn;

/** A base quantity in the item's units and in the line's own unit (`inLineUnit`). */
export const lineAmount = (base: number, item: ItemRow, unit: UnitCode) => {
  const inUnit = convertQuantity(base, itemBaseUnit(item), unit, item);
  return { ...stockAmount(base, item), inLineUnit: inUnit === null ? null : roundQuantity(inUnit) };
};

/**
 * Lines with their progress and value, and the order's derived totals. Loads everything the list
 * and detail views share, for a page of orders at once.
 */
export async function loadOrders(db: Executor, orders: OrderRow[], today: string) {
  const lines = await liveLines(
    db,
    orders.map((o) => o.id),
  );
  const [totals, invoiced] = await Promise.all([
    lineTotals(
      db,
      lines.map((l) => l.id),
    ),
    invoicedLines(
      db,
      lines.map((l) => l.id),
    ),
  ]);
  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const supplierIds = [...new Set(orders.map((o) => o.supplierId))];
  const locationIds = [
    ...new Set(orders.flatMap((o) => (o.deliveryLocationId ? [o.deliveryLocationId] : []))),
  ];
  const [itemRows, supplierRows, locationRows] = await Promise.all([
    itemIds.length ? db.select().from(items).where(inArray(items.id, itemIds)) : [],
    supplierIds.length ? db.select().from(suppliers).where(inArray(suppliers.id, supplierIds)) : [],
    locationIds.length
      ? db
          .select({
            id: stockLocations.id,
            name: stockLocations.name,
            code: stockLocations.code,
            status: stockLocations.status,
          })
          .from(stockLocations)
          .where(inArray(stockLocations.id, locationIds))
      : [],
  ]);
  const itemMap = new Map(itemRows.map((r) => [r.id, r]));
  const supplierMap = new Map(supplierRows.map((r) => [r.id, r]));
  const locationMap = new Map(locationRows.map((r) => [r.id, r]));
  const linesByOrder = new Map<string, LineRow[]>();
  for (const line of lines) {
    const list = linesByOrder.get(line.purchaseOrderId) ?? [];
    list.push(line);
    linesByOrder.set(line.purchaseOrderId, list);
  }

  return orders.map((order) => {
    const open = order.status === "sent";
    const lineViews = (linesByOrder.get(order.id) ?? []).map((line) => {
      const item = itemMap.get(line.itemId)!;
      const t = totals.get(line.id) ?? { received: 0, rejected: 0, receipts: 0 };
      const left = outstanding(line.quantity, t.received);
      const ordered = lineAmount(line.quantity, item, line.unit);
      const expectedOn = lineExpectedOn(line, order);
      return {
        row: line,
        view: {
          ...strip(line),
          item: itemSummary(item),
          effectiveExpectedOn: expectedOn,
          /** The promised date (set when sent) differs from the current expected date. */
          promiseMoved: line.promisedOn !== null && line.promisedOn !== expectedOn,
          ordered,
          received: lineAmount(t.received, item, line.unit),
          rejected: lineAmount(t.rejected, item, line.unit),
          outstanding: lineAmount(left, item, line.unit),
          state: lineReceiptState(line.quantity, t.received),
          lineValue:
            line.unitPrice === null || ordered.inLineUnit === null
              ? null
              : purchaseOrderValue([{ quantity: ordered.inLineUnit, unitPrice: line.unitPrice }]).value,
          hasReceipts: t.receipts > 0,
          /** On a supplier invoice (draft or approved): it can't be removed, re-itemed or repriced. */
          invoiced: invoiced.has(line.id),
          /** On approved supplier invoices now in force, per the line's unit. */
          invoicedQuantity: invoiced.get(line.id)?.approvedQuantity ?? 0,
          overdue: open && left > 0 && expectedOn !== null && expectedOn < today,
        },
        received: t.received,
      };
    });
    const value = purchaseOrderValue(
      lineViews.map(({ view }) => ({
        quantity: view.ordered.inLineUnit ?? 0,
        unitPrice: view.ordered.inLineUnit === null ? null : view.unitPrice,
      })),
    );
    const state = purchaseOrderState({
      status: order.status,
      lines: lineViews.map(({ row, received }) => ({ quantity: row.quantity, received })),
    });
    const expected = lineViews
      .map(({ view }) => view.effectiveExpectedOn)
      .filter((d): d is string => d !== null)
      .sort();
    const supplier = supplierMap.get(order.supplierId)!;
    const location = order.deliveryLocationId ? (locationMap.get(order.deliveryLocationId) ?? null) : null;
    return {
      order,
      lines: lineViews.map((l) => l.view),
      summary: {
        ...strip(order),
        state,
        supplier: supplierSummary(supplier),
        deliveryLocation: location,
        /** The earliest expected date over the lines (the header's when no line overrides it). */
        nextExpectedOn: expected[0] ?? order.expectedOn,
        linesCount: lineViews.length,
        receivedLines: lineViews.filter(({ view }) => view.state === "full" || view.state === "over").length,
        outstandingLines: lineViews.filter(({ view }) => view.outstanding.base > 0).length,
        value: value.value,
        valueComplete: value.complete,
        overdue: lineViews.some(({ view }) => view.overdue),
      },
    };
  });
}

/** One order as the detail page shows it: lines, receipts grouped by delivery, names. */
export async function getOrder(db: Executor, workspaceId: string, id: string, todayOn?: string) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const order = await findOrder(db, workspaceId, id);
  const [loaded] = await loadOrders(db, [order], today);
  const { summary, lines } = loaded!;
  const [settings, emails] = [
    await getOrderSettings(db, workspaceId),
    await db
      .select()
      .from(purchaseOrderEmails)
      .where(and(eq(purchaseOrderEmails.purchaseOrderId, id), isNull(purchaseOrderEmails.deletedAt)))
      .orderBy(desc(purchaseOrderEmails.createdAt), desc(purchaseOrderEmails.id)),
  ];
  const [listed, receipts] = await Promise.all([
    lines.length
      ? db
          .select({ itemId: itemSuppliers.itemId })
          .from(itemSuppliers)
          .where(
            and(
              eq(itemSuppliers.supplierId, order.supplierId),
              inArray(
                itemSuppliers.itemId,
                lines.map((l) => l.itemId),
              ),
              isNull(itemSuppliers.deletedAt),
            ),
          )
      : [],
    db
      .select({
        receipt: purchaseReceipts,
        lotCode: stockLots.lotCode,
        reversalId: reversal.id,
      })
      .from(purchaseReceipts)
      .leftJoin(stockLots, eq(stockLots.id, purchaseReceipts.lotId))
      .leftJoin(reversal, eq(reversal.reversesMovementId, purchaseReceipts.stockMovementId))
      .where(eq(purchaseReceipts.purchaseOrderId, id))
      .orderBy(asc(purchaseReceipts.createdAt), asc(purchaseReceipts.id)),
  ]);
  const listedItems = new Set(listed.map((l) => l.itemId));
  const name = await userNames(db, [
    order.createdBy,
    order.sentBy,
    order.closedBy,
    order.cancelledBy,
    ...receipts.map((r) => r.receipt.actorId),
    ...receipts.map((r) => r.receipt.voidedBy),
    ...emails.map((e) => e.sentBy),
    order.sendApprovedBy,
  ]);
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const receiptItemIds = [...new Set(receipts.map((r) => r.receipt.itemId))];
  const itemById = new Map<string, ItemRow>(
    receiptItemIds.length
      ? (await db.select().from(items).where(inArray(items.id, receiptItemIds))).map((i) => [i.id, i])
      : [],
  );

  const deliveryReceipt = (
    receipt: (typeof receipts)[number]["receipt"],
    lineNo: number | null,
    item: ItemRow,
    unit: UnitCode,
    lotCode: string | null,
    reversalId: string | null,
  ) => ({
    id: receipt.id,
    lineId: receipt.lineId,
    lineNo,
    item: itemSummary(item),
    outcome: receipt.outcome,
    quantity: lineAmount(receipt.quantity, item, unit),
    unitPrice: receipt.unitPrice,
    lotId: receipt.lotId,
    lotCode,
    stockMovementId: receipt.stockMovementId,
    reason: receipt.reason,
    overDeliveryReason: receipt.overDeliveryReason,
    reversed: reversalId !== null,
    voided: receipt.voidedAt !== null,
    voidedAt: receipt.voidedAt,
    voidedByName: name(receipt.voidedBy),
    voidReason: receipt.voidReason,
  });
  const deliveries = new Map<
    string,
    {
      deliveryId: string;
      receivedOn: string;
      deliveryReference: string | null;
      notes: string | null;
      actorId: string | null;
      actorName: string | null;
      createdAt: Date;
      receipts: ReturnType<typeof deliveryReceipt>[];
    }
  >();
  for (const { receipt, lotCode, reversalId } of receipts) {
    const item = itemById.get(receipt.itemId)!;
    const line = lineById.get(receipt.lineId);
    const unit = line?.unit ?? item.unit;
    let delivery = deliveries.get(receipt.deliveryId);
    if (!delivery) {
      delivery = {
        deliveryId: receipt.deliveryId,
        receivedOn: receipt.receivedOn,
        deliveryReference: receipt.deliveryReference,
        notes: receipt.notes,
        actorId: receipt.actorId,
        actorName: name(receipt.actorId),
        createdAt: receipt.createdAt,
        receipts: [],
      };
      deliveries.set(receipt.deliveryId, delivery);
    }
    delivery.receipts.push(deliveryReceipt(receipt, line?.lineNo ?? null, item, unit, lotCode, reversalId));
  }

  const [supplierRow] = await db
    .select({ email: suppliers.email })
    .from(suppliers)
    .where(eq(suppliers.id, order.supplierId));
  return {
    ...summary,
    /** The supplier with the email the order goes to by default. */
    supplier: { ...summary.supplier, email: supplierRow?.email ?? null },
    createdByName: name(order.createdBy),
    sentByName: name(order.sentBy),
    closedByName: name(order.closedBy),
    cancelledByName: name(order.cancelledBy),
    /** Approval to send an order above the workspace's threshold. */
    sendApproval: {
      state:
        order.status === "draft"
          ? sendApprovalState({
              threshold: settings.sendApprovalThreshold,
              value: summary.value,
              createdBy: order.createdBy,
              approvedBy: order.sendApprovedBy,
              approvedValue: order.sendApprovedValue,
            })
          : order.sendApprovedBy
            ? ("approved" as const)
            : ("not_required" as const),
      threshold: settings.sendApprovalThreshold,
      approvedBy: order.sendApprovedBy,
      approvedByName: name(order.sendApprovedBy),
      approvedAt: order.sendApprovedAt,
      approvedValue: order.sendApprovedValue,
      note: order.sendApprovalNote,
    },
    overDeliveryTolerancePercent: settings.overDeliveryTolerancePercent,
    /** Emails of the order to the supplier, newest first (failed attempts too). */
    emails: emails.map((e) => ({
      id: e.id,
      toEmail: e.toEmail,
      subject: e.subject,
      status: e.status,
      error: e.error,
      sentBy: e.sentBy,
      sentByName: name(e.sentBy),
      createdAt: e.createdAt,
    })),
    lines: lines.map((l) => ({ ...l, supplierListed: listedItems.has(l.itemId) })),
    deliveries: [...deliveries.values()],
  };
}

// ─── Listing ─────────────────────────────────────────────────────────────────

/**
 * Orders, newest first, with their derived state, value and progress. The state filter is
 * computed in SQL the same way `purchaseOrderState` computes it, so paging stays exact.
 */
export async function listOrders(
  db: Database,
  workspaceId: string,
  query: PurchaseOrderListQuery,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const po = purchaseOrders;
  const received = db
    .select({
      lineId: purchaseReceipts.lineId,
      qty: sql<string>`sum(${purchaseReceipts.quantity})`.as("received_qty"),
    })
    .from(purchaseReceipts)
    .leftJoin(reversal, eq(reversal.reversesMovementId, purchaseReceipts.stockMovementId))
    .where(
      and(
        eq(purchaseReceipts.workspaceId, workspaceId),
        eq(purchaseReceipts.outcome, "accepted"),
        isNull(reversal.id),
      ),
    )
    .groupBy(purchaseReceipts.lineId)
    .as("received");
  const progress = db
    .select({
      orderId: sql<string>`${purchaseOrderLines.purchaseOrderId}`.as("progress_order_id"),
      lines: sql<number>`count(*)::int`.as("progress_lines"),
      full: sql<number>`(count(*) filter (where coalesce(${received.qty}, 0) >= ${purchaseOrderLines.quantity}))::int`.as(
        "progress_full",
      ),
      touched: sql<number>`(count(*) filter (where coalesce(${received.qty}, 0) > 0))::int`.as(
        "progress_touched",
      ),
    })
    .from(purchaseOrderLines)
    .leftJoin(received, eq(received.lineId, purchaseOrderLines.id))
    .where(and(eq(purchaseOrderLines.workspaceId, workspaceId), isNull(purchaseOrderLines.deletedAt)))
    .groupBy(purchaseOrderLines.purchaseOrderId)
    .as("progress");
  const state = sql<string>`case
    when ${po.status} <> 'sent' then ${po.status}
    when coalesce(${progress.lines}, 0) > 0 and ${progress.full} = ${progress.lines} then 'received'
    when coalesce(${progress.touched}, 0) > 0 then 'part_received'
    else 'sent' end`;
  // The earliest effective expected date over the lines (the header's when there are none), as
  // `nextExpectedOn` shows it.
  const expectedOn = sql`coalesce((select min(coalesce(${purchaseOrderLines.expectedOn}, ${po.expectedOn}))
    from ${purchaseOrderLines} where ${purchaseOrderLines.purchaseOrderId} = ${po.id}
    and ${purchaseOrderLines.deletedAt} is null), ${po.expectedOn})`;

  const where: (SQL | undefined)[] = [eq(po.workspaceId, workspaceId), isNull(po.deletedAt)];
  if (query.status === "open") where.push(sql`${state} in ('sent', 'part_received')`);
  else if (query.status !== "all") where.push(sql`${state} = ${query.status}`);
  if (query.supplierId) where.push(eq(po.supplierId, query.supplierId));
  if (query.itemId) {
    where.push(
      sql`exists (select 1 from ${purchaseOrderLines} where ${purchaseOrderLines.purchaseOrderId} = ${po.id}
        and ${purchaseOrderLines.itemId} = ${query.itemId} and ${purchaseOrderLines.deletedAt} is null)`,
    );
  }
  if (query.from) where.push(sql`${expectedOn} >= ${query.from}`);
  if (query.to) where.push(sql`${expectedOn} <= ${query.to}`);
  if (query.q) {
    where.push(
      or(ilike(po.reference, query.q), ilike(suppliers.name, query.q), ilike(po.supplierReference, query.q)),
    );
  }
  const base = () =>
    db
      .select({ order: po })
      .from(po)
      .innerJoin(suppliers, eq(suppliers.id, po.supplierId))
      .leftJoin(progress, eq(progress.orderId, po.id))
      .where(and(...where));
  const [rows, [total]] = await Promise.all([
    base().orderBy(desc(po.createdAt), desc(po.id)).limit(query.limit).offset(query.offset),
    db.select({ n: count() }).from(base().as("orders")),
  ]);
  const loaded = await loadOrders(
    db,
    rows.map((r) => r.order),
    today,
  );
  return {
    orders: loaded.map((l) => l.summary),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

// ─── Creating and editing ────────────────────────────────────────────────────

/**
 * The next reference for an order created on `date`: the highest sequence used that year plus
 * one, deleted orders included so a reference is never reused. Callers hold `lockWorkspaceLog`.
 */
async function nextReference(tx: Transaction, workspaceId: string, date: string) {
  const stem = purchaseOrderReference(date, 0).replace(/0+$/, "");
  const rows = await tx
    .select({ reference: purchaseOrders.reference })
    .from(purchaseOrders)
    .where(
      and(eq(purchaseOrders.workspaceId, workspaceId), sql`${purchaseOrders.reference} like ${`${stem}%`}`),
    );
  const max = rows.reduce((m, r) => Math.max(m, purchaseOrderReferenceSequence(r.reference) ?? 0), 0);
  return purchaseOrderReference(date, max + 1);
}

/**
 * An item already on a line, found even if it has since been deleted, so the order stays editable
 * and receivable (receiving then refuses it as archived).
 */
async function findLineItem(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(items)
    .where(and(eq(items.id, id), eq(items.workspaceId, workspaceId)));
  if (!row) throw notFound("Item");
  return row;
}

/** A line's or receipt's quantity in the base unit, bounded to what the columns hold. */
const lineBase = (quantity: number, unit: UnitCode, item: ItemRow) =>
  toBase(quantity, unit, item, { max: PURCHASE_MAX_BASE_QUANTITY });

/** An item that may go on an order: an active ingredient or packaging item. */
async function findPurchasableItem(tx: Executor, workspaceId: string, itemId: string) {
  const item = await findItem(tx, workspaceId, itemId);
  if (!(receivableItemTypes as readonly string[]).includes(item.type)) {
    throw new ApiError(
      409,
      "item_not_purchasable",
      `${item.name} is not an ingredient or packaging; only those are bought`,
    );
  }
  if (item.status !== "active") throw new ApiError(409, "item_archived", `${item.name} is archived`);
  return item;
}

/** The item's standard cost (per its own unit) as a price per `unit`; null when it has none. */
const defaultPrice = (item: ItemRow, unit: UnitCode) =>
  item.standardCost === null
    ? null
    : convertUnitPrice(item.standardCost, item.unit, unit, item, PRICE_DECIMALS);

/**
 * The price a line gets when none is given: the supplier's price list entry in force today (per
 * the line's unit), else the item's standard cost converted, else none.
 */
async function defaultLinePrice(
  tx: Executor,
  workspaceId: string,
  pricing: { supplierId: string; today: string },
  item: ItemRow,
  unit: UnitCode,
) {
  const listed = await listPriceFor(tx, workspaceId, pricing.supplierId, item, unit, pricing.today);
  return listed ? listed.price : defaultPrice(item, unit);
}

/**
 * A new line's values, checked: the item may be bought and the unit converts. `promisedOn` is set
 * when the line is added to an order already sent (its effective expected date then).
 */
async function newLineValues(
  tx: Executor,
  workspaceId: string,
  input: PurchaseOrderLineInput,
  pricing: { supplierId: string; today: string },
  sentOrder?: Pick<OrderRow, "expectedOn">,
) {
  const item = await findPurchasableItem(tx, workspaceId, input.itemId);
  return {
    itemId: item.id,
    quantity: lineBase(input.quantity, input.unit, item),
    promisedOn: sentOrder ? (input.expectedOn ?? sentOrder.expectedOn) : null,
    unit: input.unit,
    unitPrice:
      input.unitPrice !== undefined
        ? input.unitPrice
        : await defaultLinePrice(tx, workspaceId, pricing, item, input.unit),
    expectedOn: input.expectedOn ?? null,
    notes: input.notes ?? null,
  };
}

/**
 * The one way an order is created, inside a transaction holding the workspace lock: checks the
 * supplier, location and lines, generates the reference, inserts and records the changes.
 */
async function insertOrder(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  input: PurchaseOrderCreateInput,
  today: string,
) {
  const supplier = await findSupplier(tx, workspaceId, input.supplierId);
  assertOrderable(supplier);
  if (input.deliveryLocationId) await findActiveLocation(tx, workspaceId, input.deliveryLocationId);
  const lineValues = [];
  for (const line of input.lines)
    lineValues.push(await newLineValues(tx, workspaceId, line, { supplierId: supplier.id, today }));
  const reference = await nextReference(tx, workspaceId, today);
  const [order] = await tx
    .insert(purchaseOrders)
    .values({
      ...(input.id ? { id: input.id } : {}),
      workspaceId,
      reference,
      supplierId: supplier.id,
      status: "draft",
      expectedOn: input.expectedOn ?? null,
      deliveryLocationId: input.deliveryLocationId ?? null,
      supplierReference: input.supplierReference ?? null,
      notes: input.notes ?? null,
      createdBy: actorId,
    })
    .returning();
  const lines = lineValues.length
    ? await tx
        .insert(purchaseOrderLines)
        .values(lineValues.map((v, i) => ({ ...v, workspaceId, purchaseOrderId: order!.id, lineNo: i + 1 })))
        .returning()
    : [];
  await recordChanges(tx, workspaceId, actorId, [orderChange(order!), ...lines.map(lineChange)]);
  return order!;
}

export async function createOrder(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: PurchaseOrderCreateInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const notified: NotificationRow[] = [];
  const result = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const order = await insertOrder(tx, workspaceId, actorId, input, today);
    notified.push(...(await notifyIfApprovalNeeded(tx, workspaceId, actorId, order, today)));
    return getOrder(tx, workspaceId, order.id, today);
  });
  void deliverNotifications(db, notified);
  return result;
}

/** A draft above the approval threshold tells the managers who may approve it (once per state). */
async function notifyIfApprovalNeeded(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  order: OrderRow,
  today: string,
) {
  if (order.status !== "draft") return [];
  const { sendApprovalThreshold: threshold } = await getOrderSettings(tx, workspaceId);
  if (threshold === null) return [];
  const [loaded] = await loadOrders(tx, [order], today);
  const state = sendApprovalState({
    threshold,
    value: loaded!.summary.value,
    createdBy: order.createdBy,
    approvedBy: order.sendApprovedBy,
    approvedValue: order.sendApprovedValue,
  });
  return state === "needed" || state === "stale"
    ? notifyPurchaseOrderApprovalNeeded(tx, workspaceId, actorId, order, state)
    : [];
}

const orderClosed = (order: OrderRow) =>
  new ApiError(
    409,
    "order_closed",
    `${order.reference} is ${purchaseOrderStatusLabels[order.status].toLowerCase()}; it can't be changed`,
  );

/**
 * Edits an order. A draft: anything. A sent order: the expected date, delivery location, supplier
 * reference and notes; lines may be added, re-priced, re-dated and resized, but a line with
 * receipts can't be removed (or moved to another item) and can't go below what was accepted, and
 * the order must still be sendable afterwards (a line, and an expected date for every line). While
 * its supplier is suspended or rejected nothing more may be ordered: no new lines, no larger
 * quantities. The supplier can't change once sent. Closed and cancelled orders can't be edited.
 *
 * `lines` replaces the list: a line with `id` keeps (and edits) that line, and fields it leaves out
 * keep their values (the price too, unless the item or unit changes); a line without `id` is new.
 * A line's promised date is never changed by an edit; a line added to a sent order is promised
 * its effective expected date.
 */
export async function updateOrder(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: PurchaseOrderUpdateInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const notified: NotificationRow[] = [];
  const result = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findOrder(tx, workspaceId, id);
    if (current.status === "closed" || current.status === "cancelled") throw orderClosed(current);
    const sent = current.status !== "draft";
    const { lines: lineInput, ...header } = patch;
    if (header.supplierId !== undefined && header.supplierId !== current.supplierId) {
      if (sent) {
        throw new ApiError(409, "not_draft", `${current.reference} has been sent; its supplier can't change`);
      }
      assertOrderable(await findSupplier(tx, workspaceId, header.supplierId));
    }
    if (header.deliveryLocationId && header.deliveryLocationId !== current.deliveryLocationId) {
      await findActiveLocation(tx, workspaceId, header.deliveryLocationId);
    }
    // The header first: lines added to a sent order are promised its (new) expected date.
    const [row] = await tx
      .update(purchaseOrders)
      .set({
        ...header,
        // An approval to send was for this supplier.
        ...(header.supplierId !== undefined && header.supplierId !== current.supplierId
          ? { sendApprovedBy: null, sendApprovedAt: null, sendApprovedValue: null, sendApprovalNote: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(purchaseOrders.id, id))
      .returning();
    const changes: ChangeInput[] = [orderChange(row!)];
    if (lineInput) {
      const supplier = sent ? await findSupplier(tx, workspaceId, row!.supplierId) : null;
      changes.push(
        ...(await replaceLines(tx, workspaceId, row!, lineInput, {
          blockedSupplier: supplier && !canOrderFromSupplier(supplier.approvalStatus) ? supplier : null,
          today,
        })),
      );
    }
    if (sent) assertSendable(row!, await liveLines(tx, [id]), "The order has been sent, so it needs");
    await recordChanges(tx, workspaceId, actorId, changes);
    notified.push(...(await notifyIfApprovalNeeded(tx, workspaceId, actorId, row!, today)));
    return getOrder(tx, workspaceId, id, today);
  });
  void deliverNotifications(db, notified);
  return result;
}

/**
 * What sending needs, and what a sent order must keep: a line, and an expected date for every
 * line (its own or the order's). 400 otherwise.
 */
function assertSendable(order: OrderRow, lines: LineRow[], prefix = "The order needs") {
  if (!lines.length) throw badRequest(`${prefix} at least one line`);
  if (!order.expectedOn && lines.some((l) => !l.expectedOn)) {
    throw badRequest(`${prefix} an expected delivery date: on the order, or on every line`);
  }
}

const samePrice = (a: number | null, b: number | null) =>
  a === null || b === null ? a === b : roundQuantity(a, PRICE_DECIMALS) === roundQuantity(b, PRICE_DECIMALS);

async function replaceLines(
  tx: Transaction,
  workspaceId: string,
  order: OrderRow,
  input: PurchaseOrderLineUpdateInput[],
  options: { blockedSupplier: SupplierRow | null; today: string },
) {
  const sent = order.status !== "draft";
  const blocked = options.blockedSupplier;
  const refuseMore = (what: string) =>
    new ApiError(
      409,
      "supplier_not_approved",
      `${blocked!.name} is ${blocked!.approvalStatus}; ${what} can't be ordered from them (lowering quantities, dates and notes can still change)`,
    );
  const existing = await liveLines(tx, [order.id]);
  const byId = new Map(existing.map((l) => [l.id, l]));
  const [totals, invoiced] = await Promise.all([
    lineTotals(
      tx,
      existing.map((l) => l.id),
    ),
    invoicedLines(
      tx,
      existing.map((l) => l.id),
    ),
  ]);
  const lineInvoiced = (line: LineRow, what: string) =>
    new ApiError(
      409,
      "line_invoiced",
      `Line ${line.lineNo} is on a supplier invoice; ${what} (revise the invoice first if it is wrong)`,
      { lineId: line.id },
    );
  const kept = new Set<string>();
  for (const line of input) {
    if (!line.id) continue;
    if (!byId.has(line.id)) throw badRequest(`Line ${line.id} is not on ${order.reference}`);
    kept.add(line.id);
  }
  const removed = existing.filter((l) => !kept.has(l.id));
  for (const line of removed) {
    if ((totals.get(line.id)?.receipts ?? 0) > 0) {
      throw new ApiError(
        409,
        "line_has_receipts",
        `Line ${line.lineNo} has deliveries recorded against it; it can't be removed`,
      );
    }
    if (invoiced.has(line.id)) throw lineInvoiced(line, "it can't be removed");
  }
  const changes: ChangeInput[] = [];
  const now = new Date();
  if (removed.length) {
    await tx
      .update(purchaseOrderLines)
      .set({ deletedAt: now })
      .where(
        inArray(
          purchaseOrderLines.id,
          removed.map((l) => l.id),
        ),
      );
    for (const line of removed)
      changes.push({ entity: "purchase_order_line", entityId: line.id, action: "delete" });
  }
  for (const [index, line] of input.entries()) {
    const lineNo = index + 1;
    const prior = line.id ? byId.get(line.id) : undefined;
    if (!prior) {
      if (blocked) throw refuseMore("new lines");
      const values = await newLineValues(
        tx,
        workspaceId,
        line,
        { supplierId: order.supplierId, today: options.today },
        sent ? order : undefined,
      );
      const [row] = await tx
        .insert(purchaseOrderLines)
        .values({ ...values, workspaceId, purchaseOrderId: order.id, lineNo })
        .returning();
      changes.push(lineChange(row!));
      continue;
    }
    const t = totals.get(prior.id) ?? { received: 0, rejected: 0, receipts: 0 };
    const sameItem = line.itemId === prior.itemId;
    if (!sameItem && t.receipts > 0) {
      throw new ApiError(
        409,
        "line_has_receipts",
        `Line ${prior.lineNo} has deliveries recorded against it; its item can't change`,
      );
    }
    if (invoiced.has(prior.id)) {
      if (!sameItem) throw lineInvoiced(prior, "its item can't change");
      if (line.unit !== prior.unit) throw lineInvoiced(prior, "its unit can't change");
      if (line.unitPrice !== undefined && !samePrice(line.unitPrice, prior.unitPrice))
        throw lineInvoiced(prior, "its price can't change");
    }
    if (!sameItem && blocked) throw refuseMore("other items");
    // An item already on the line may since have been archived or deleted; the line stays editable.
    const item = sameItem
      ? await findLineItem(tx, workspaceId, line.itemId)
      : await findPurchasableItem(tx, workspaceId, line.itemId);
    const quantity = lineBase(line.quantity, line.unit, item);
    if (blocked && roundQuantity(quantity) > roundQuantity(prior.quantity))
      throw refuseMore("larger quantities");
    if (roundQuantity(quantity) < roundQuantity(t.received)) {
      const got = stockAmount(t.received, item);
      throw new ApiError(
        409,
        "below_received",
        `Line ${prior.lineNo}: ${got.display} ${got.displayUnit} of ${item.name} has been received; the quantity can't go below that`,
        { lineId: prior.id, received: got },
      );
    }
    const unitPrice =
      line.unitPrice !== undefined
        ? line.unitPrice
        : sameItem && line.unit === prior.unit
          ? prior.unitPrice
          : await defaultLinePrice(
              tx,
              workspaceId,
              { supplierId: order.supplierId, today: options.today },
              item,
              line.unit,
            );
    const [row] = await tx
      .update(purchaseOrderLines)
      .set({
        lineNo,
        itemId: item.id,
        quantity,
        unit: line.unit,
        unitPrice,
        expectedOn: line.expectedOn !== undefined ? line.expectedOn : prior.expectedOn,
        notes: line.notes !== undefined ? line.notes : prior.notes,
        updatedAt: now,
      })
      .where(eq(purchaseOrderLines.id, prior.id))
      .returning();
    changes.push(lineChange(row!));
  }
  return changes;
}

/** Deletes a draft (soft). Sent orders are cancelled or closed instead. */
export async function deleteOrder(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findOrder(tx, workspaceId, id);
    if (current.status !== "draft") {
      throw new ApiError(
        409,
        "not_draft",
        `${current.reference} is ${purchaseOrderStatusLabels[current.status].toLowerCase()}; only a draft can be deleted (cancel or close it instead)`,
      );
    }
    const now = new Date();
    const lines = await tx
      .update(purchaseOrderLines)
      .set({ deletedAt: now })
      .where(and(eq(purchaseOrderLines.purchaseOrderId, id), isNull(purchaseOrderLines.deletedAt)))
      .returning({ id: purchaseOrderLines.id });
    await tx.update(purchaseOrders).set({ deletedAt: now }).where(eq(purchaseOrders.id, id));
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "purchase_order", entityId: id, action: "delete" },
      ...lines.map((l): ChangeInput => ({ entity: "purchase_order_line", entityId: l.id, action: "delete" })),
    ]);
  });
}

// ─── Sending, closing, cancelling (a person) ─────────────────────────────────

/**
 * Draft → sent: a commitment to buy. Needs a line, an expected date on the order or on every line,
 * and a supplier that isn't suspended or rejected. `orderedOn` defaults to today. Each line is
 * promised its effective expected date (`promisedOn`), which supplier performance measures against.
 */
export async function sendOrder(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: PurchaseOrderSendInput,
  todayOn?: string,
  /** An API token's cap on the order's value (`api_tokens.max_order_value`); null for none, and for people. */
  maxOrderValue: number | null = null,
  /** For the supplier control check: active modules, and whether the sender may override (a person with Items manage). */
  options: { active?: readonly ModuleId[]; mayOverride?: boolean } = {},
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const orderedOn = input.orderedOn ?? today;
  notInFuture(orderedOn, "orderedOn", today);
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findOrder(tx, workspaceId, id);
    if (current.status !== "draft") {
      throw new ApiError(409, "not_draft", `${current.reference} has already been sent`);
    }
    const lines = await liveLines(tx, [id]);
    assertSendable(current, lines);
    assertOrderable(await findSupplier(tx, workspaceId, current.supplierId));
    if (maxOrderValue !== null) {
      // The value the order has now (the same sum the order page shows), checked under the lock so
      // a line edited meanwhile can't slip past. An order with an unpriced line can't be checked.
      const { value, valueComplete } = await getOrder(tx, workspaceId, id, today);
      if (!valueComplete || value > maxOrderValue) {
        throw new ApiError(
          403,
          "token_limit_exceeded",
          orderValueLimitRefusal(maxOrderValue, valueComplete ? value : null),
          { action: "purchasing.send", limit: maxOrderValue, value, valueComplete },
        );
      }
    }
    await assertApprovedToSend(tx, workspaceId, current, today);
    // Under `block` enforcement, the supplier's open control issues stop the send unless overridden.
    const controlsOverride = await checkSupplierControls(tx, workspaceId, current.supplierId, "order", {
      active: options.active ?? moduleIds,
      today,
      override: input.controlsOverride,
      overrideAllowed: options.mayOverride ?? false,
    });
    const promised = await tx
      .update(purchaseOrderLines)
      .set({ promisedOn: sql`coalesce(${purchaseOrderLines.expectedOn}, ${current.expectedOn})` })
      .where(and(eq(purchaseOrderLines.purchaseOrderId, id), isNull(purchaseOrderLines.deletedAt)))
      .returning();
    const [row] = await tx
      .update(purchaseOrders)
      .set({
        status: "sent",
        orderedOn,
        sentAt: new Date(),
        sentBy: actorId,
        sendControlsOverride: controlsOverride,
        ...(input.supplierReference !== undefined ? { supplierReference: input.supplierReference } : {}),
      })
      .where(eq(purchaseOrders.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [orderChange(row!), ...promised.map(lineChange)]);
    return getOrder(tx, workspaceId, id, today);
  });
}

/**
 * An order above the workspace's approval threshold may only be sent once a manager other than its
 * creator has approved it for at least its value (`409 approval_required`). Unpriced lines count
 * for nothing. With no threshold set nothing is checked.
 */
async function assertApprovedToSend(tx: Transaction, workspaceId: string, order: OrderRow, today: string) {
  const { sendApprovalThreshold: threshold } = await getOrderSettings(tx, workspaceId);
  if (threshold === null) return;
  const [loaded] = await loadOrders(tx, [order], today);
  const value = loaded!.summary.value;
  const state = sendApprovalState({
    threshold,
    value,
    createdBy: order.createdBy,
    approvedBy: order.sendApprovedBy,
    approvedValue: order.sendApprovedValue,
  });
  if (state === "needed" || state === "stale") {
    throw new ApiError(
      409,
      "approval_required",
      state === "needed"
        ? `${order.reference} is worth ${value}, above the ${threshold} approval threshold: a manager other than whoever raised it has to approve it before it is sent`
        : `${order.reference} is worth ${value} now, more than it was approved for: it needs approving again before it is sent`,
      { value, threshold, state },
    );
  }
}

/** Sent → closed: nothing more is expected (a short close counts against in-full). */
export async function closeOrder(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: PurchaseOrderCloseInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findOrder(tx, workspaceId, id);
    if (current.status !== "sent") {
      throw new ApiError(
        409,
        "order_not_open",
        current.status === "draft"
          ? `${current.reference} hasn't been sent; delete or cancel it instead`
          : `${current.reference} is already ${purchaseOrderStatusLabels[current.status].toLowerCase()}`,
      );
    }
    const [row] = await tx
      .update(purchaseOrders)
      .set({ status: "closed", closedAt: new Date(), closedBy: actorId, closeReason: input.reason })
      .where(eq(purchaseOrders.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [orderChange(row!)]);
    return getOrder(tx, workspaceId, id, today);
  });
}

/**
 * Draft or sent → cancelled, while nothing has been accepted against it (a reversed receipt
 * doesn't count). Once goods have arrived the order is closed instead.
 */
export async function cancelOrder(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: PurchaseOrderCancelInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findOrder(tx, workspaceId, id);
    if (current.status === "closed" || current.status === "cancelled") throw orderClosed(current);
    const lines = await liveLines(tx, [id]);
    const totals = await lineTotals(
      tx,
      lines.map((l) => l.id),
    );
    if ([...totals.values()].some((t) => t.received > 0)) {
      throw new ApiError(
        409,
        "has_receipts",
        `Goods have been received against ${current.reference}; close it instead of cancelling`,
      );
    }
    const [row] = await tx
      .update(purchaseOrders)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelledBy: actorId, cancelReason: input.reason })
      .where(eq(purchaseOrders.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [orderChange(row!)]);
    return getOrder(tx, workspaceId, id, today);
  });
}

// ─── Goods-in against an order ───────────────────────────────────────────────

/**
 * Records one delivery against a sent order, all or nothing, under one `deliveryId`. An accepted
 * line creates a lot (supplier = the order's) and its `receipt` movement, referenced
 * `PO-2026-001 / <delivery note>`, exactly as stock goods-in would (the supplier approval rule
 * included: a pending supplier's goods go into quarantine). A rejected line records what was
 * refused at the door; no stock moves. Over-delivery is allowed.
 */
export async function receiveOrder(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: PurchaseReceiveInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  notInFuture(input.receivedOn, "receivedOn", today);
  return executeLedgerCommand(db, workspaceId, actorId, "receiveOrder", input, { id, input }, async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const order = await findOrder(tx, workspaceId, id);
    if (order.status !== "sent") {
      throw new ApiError(
        409,
        "order_not_open",
        `${order.reference} is ${purchaseOrderStatusLabels[order.status].toLowerCase()}; deliveries are recorded against sent orders`,
      );
    }
    const lines = new Map((await liveLines(tx, [id])).map((l) => [l.id, l]));
    for (const line of input.lines) {
      if (!lines.has(line.lineId)) throw badRequest(`Line ${line.lineId} is not on ${order.reference}`);
    }
    // The approval rule, once per lot status the accepted lines use. A delivery made only of
    // refusals is recorded whatever the supplier's approval: nothing enters stock.
    const statuses = new Set(
      input.lines.flatMap((l) => (l.outcome === "accepted" ? [l.status ?? "available"] : [])),
    );
    for (const status of statuses) await assertSupplierCanDeliver(tx, workspaceId, order.supplierId, status);

    // Over-delivery: with a tolerance set, an accepted line past ordered + tolerance needs a reason.
    const { overDeliveryTolerancePercent: tolerance } = await getOrderSettings(tx, workspaceId);
    const running: Map<string, { received: number }> =
      tolerance === null ? new Map() : await lineTotals(tx, [...lines.keys()]);
    const accepted = new Map<string, number>();

    const deliveryId = newId();
    const reference = purchaseReceiptMovementReference(order.reference, input.deliveryReference);
    const now = new Date();
    const changes: ChangeInput[] = [];
    const created: { receipt: ReceiptRow; lotCode: string | null; item: ItemRow; unit: UnitCode }[] = [];
    for (const entry of input.lines) {
      const line = lines.get(entry.lineId)!;
      // Found even if deleted since; goods-in's item rule refuses it below if it is accepted.
      const item = await findLineItem(tx, workspaceId, line.itemId);
      const quantity = lineBase(entry.quantity, entry.unit, item);
      const common = {
        workspaceId,
        purchaseOrderId: order.id,
        lineId: line.id,
        itemId: item.id,
        deliveryId,
        quantity,
        receivedOn: input.receivedOn,
        deliveryReference: input.deliveryReference ?? null,
        notes: input.notes ?? null,
        actorId,
      };
      if (entry.outcome === "rejected") {
        const [receipt] = await tx
          .insert(purchaseReceipts)
          .values({ ...common, outcome: "rejected", reason: entry.reason })
          .returning();
        changes.push(receiptChange(receipt!));
        created.push({ receipt: receipt!, lotCode: null, item, unit: line.unit });
        continue;
      }
      // Stock goods-in's item rule: active ingredients and packaging only.
      assertItemReceivable(item);
      const before = roundQuantity((running.get(line.id)?.received ?? 0) + (accepted.get(line.id) ?? 0));
      accepted.set(line.id, roundQuantity((accepted.get(line.id) ?? 0) + quantity));
      const over = isOverDeliveryTolerance({
        ordered: line.quantity,
        received: before,
        receiving: quantity,
        tolerancePercent: tolerance,
      });
      if (over && !entry.overDeliveryReason) {
        throw new ApiError(
          409,
          "over_delivery_reason_required",
          `Line ${line.lineNo}: ${item.name} would go more than ${tolerance}% over what was ordered; say why it is accepted`,
          { lineId: line.id, tolerancePercent: tolerance },
        );
      }
      const location = await findActiveLocation(tx, workspaceId, entry.locationId);
      const lot = await createLot(tx, workspaceId, actorId, item, {
        lotCode: entry.lotCode ?? null,
        receivedOn: input.receivedOn,
        expiresOn: entry.expiresOn ?? null,
        expiryType: entry.expiryType ?? null,
        status: entry.status ?? "available",
        statusNote: "Received into quarantine",
        supplierId: order.supplierId,
        supplierLotCode: entry.supplierLotCode ?? null,
        now,
      });
      const [movement] = await insertMovements(tx, workspaceId, [
        {
          lotId: lot.id,
          itemId: item.id,
          locationId: location.id,
          quantity,
          type: "receipt",
          reference,
          actorId,
          occurredAt: now,
        },
      ]);
      const baseUnit = itemBaseUnit(item);
      const unitPrice =
        entry.unitPrice !== undefined && entry.unitPrice !== null
          ? convertUnitPrice(entry.unitPrice, entry.unit, baseUnit, item, BASE_PRICE_DECIMALS)
          : line.unitPrice !== null
            ? convertUnitPrice(line.unitPrice, line.unit, baseUnit, item, BASE_PRICE_DECIMALS)
            : null;
      const [receipt] = await tx
        .insert(purchaseReceipts)
        .values({
          ...common,
          outcome: "accepted",
          lotId: lot.id,
          stockMovementId: movement!.id,
          unitPrice,
          overDeliveryReason: over ? (entry.overDeliveryReason ?? null) : null,
        })
        .returning();
      changes.push(lotChange(lot), movementChange(movement!), receiptChange(receipt!));
      created.push({ receipt: receipt!, lotCode: lot.lotCode, item, unit: line.unit });
    }
    await recordChanges(tx, workspaceId, actorId, changes);
    return {
      deliveryId,
      receipts: created.map(({ receipt, lotCode, item, unit }) => ({
        id: receipt.id,
        lineId: receipt.lineId,
        item: itemSummary(item),
        outcome: receipt.outcome,
        quantity: lineAmount(receipt.quantity, item, unit),
        unitPrice: receipt.unitPrice,
        lotId: receipt.lotId,
        lotCode,
        stockMovementId: receipt.stockMovementId,
        reason: receipt.reason,
        overDeliveryReason: receipt.overDeliveryReason,
      })),
      order: await getOrder(tx, workspaceId, id, today),
    };
  });
}

// ─── Suggestions from the material shortfall ─────────────────────────────────

/**
 * What to order for production's shortfall between two dates (production's material requirements),
 * minus what is outstanding on sent orders of the item (whatever their expected date); drafts are
 * shown, not subtracted. Grouped by the item's preferred (else only) supplier. Computed on read.
 * The route checks that production is on and readable.
 */
export async function getSuggestions(
  db: Database,
  workspaceId: string,
  range: { from: string; to: string },
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const requirements = await getMaterialRequirements(db, workspaceId, range);
  const itemIds = requirements.requirements.map((r) => r.item.id);
  const [openLines, links, itemRows] = itemIds.length
    ? await Promise.all([
        db
          .select({ line: purchaseOrderLines, status: purchaseOrders.status })
          .from(purchaseOrderLines)
          .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
          .where(
            and(
              eq(purchaseOrders.workspaceId, workspaceId),
              isNull(purchaseOrders.deletedAt),
              isNull(purchaseOrderLines.deletedAt),
              inArray(purchaseOrders.status, ["draft", "sent"]),
              inArray(purchaseOrderLines.itemId, itemIds),
            ),
          ),
        db
          .select({ link: itemSuppliers, supplier: suppliers })
          .from(itemSuppliers)
          .innerJoin(suppliers, eq(suppliers.id, itemSuppliers.supplierId))
          .where(
            and(
              eq(itemSuppliers.workspaceId, workspaceId),
              inArray(itemSuppliers.itemId, itemIds),
              isNull(itemSuppliers.deletedAt),
              isNull(suppliers.deletedAt),
            ),
          )
          .orderBy(asc(suppliers.name)),
        db.select().from(items).where(inArray(items.id, itemIds)),
      ])
    : [[], [], []];
  const totals = await lineTotals(
    db,
    openLines.map((l) => l.line.id),
  );
  const onOrder = openLines.map(({ line, status }) => ({
    itemId: line.itemId,
    status: status as PurchaseOrderStatus,
    outstanding: outstanding(line.quantity, totals.get(line.id)?.received ?? 0),
  }));
  const linksByItem: Record<string, SuggestionSupplierLink[]> = {};
  const supplierById = new Map<string, SupplierRow>();
  for (const { link, supplier } of links) {
    supplierById.set(supplier.id, supplier);
    (linksByItem[link.itemId] ??= []).push({
      supplierId: supplier.id,
      preferred: link.preferred,
      status: supplier.approvalStatus,
    });
  }
  const itemById = new Map(itemRows.map((i) => [i.id, i]));
  // Only active ingredients and packaging can be bought: WIP and finished goods in the shortfall
  // are made in house, and archived items can't go on an order. They are listed apart.
  const reasonOf = (itemId: string) => {
    const item = itemById.get(itemId)!;
    return notPurchasableReason({ ...item, deleted: item.deletedAt !== null });
  };
  const notPurchasable = requirements.requirements.flatMap((r) => {
    const reason = reasonOf(r.item.id);
    if (!reason || r.shortfall.base <= 0) return [];
    return [{ item: itemSummary(itemById.get(r.item.id)!), shortfall: r.shortfall, reason }];
  });
  const result = purchaseSuggestions(
    requirements.requirements
      .filter((r) => reasonOf(r.item.id) === null)
      .map((r) => ({ itemId: r.item.id, shortfall: r.shortfall.base, source: r })),
    onOrder,
    linksByItem,
  );
  const supplierView = (id: string | null) => {
    const s = id ? supplierById.get(id) : undefined;
    return s ? supplierSummary(s) : null;
  };
  const view = (s: (typeof result.covered)[number]) => {
    const item = itemById.get(s.itemId)!;
    const neededBy =
      s.requirement.source.batches
        .map((b) => b.plannedOn)
        .sort()
        .at(0) ?? null;
    const toOrder = stockAmount(s.toOrder, item);
    return {
      item: itemSummary(item),
      shortfall: stockAmount(s.shortfall, item),
      onOrder: stockAmount(s.onOrder, item),
      onDraft: stockAmount(s.onDraft, item),
      toOrder,
      /** A line as `POST /purchasing/orders` takes it: the quantity to order in the item's unit. */
      quantity: toOrder.display,
      unit: item.unit,
      /** The item's standard cost, per `unit`; null when it has none. */
      unitPrice: item.standardCost,
      /** The earliest planned batch that needs it. */
      neededBy,
      /** The suggested expected date: `neededBy`, but never before today. */
      expectedOn: neededBy === null ? null : neededBy < today ? today : neededBy,
      /** Production couldn't convert some batch's quantity of this item: the shortfall leaves it out. */
      incomplete: s.requirement.source.incomplete,
      supplierId: s.supplierId,
      otherSuppliers: s.otherSupplierIds.flatMap((sid) => {
        const v = supplierView(sid);
        return v ? [v] : [];
      }),
      suppliers: (linksByItem[s.itemId] ?? []).map((l) => ({
        ...supplierView(l.supplierId)!,
        preferred: l.preferred,
      })),
    };
  };
  return {
    from: range.from,
    to: range.to,
    groups: result.groups.map((g) => ({
      supplier: supplierView(g.supplierId),
      suggestions: g.suggestions.map(view),
    })),
    covered: result.covered.map(view),
    notPurchasable,
  };
}

/**
 * Creates the chosen draft orders together, each exactly as `POST /orders` would, all or nothing.
 * A refusal names the order it is about (`details.index`, counting from 0).
 */
export async function createSuggestedOrders(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: PurchaseSuggestionsCreateInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const supplierIds = [...new Set(input.orders.map((o) => o.supplierId))];
    const names = new Map(
      (
        await tx
          .select({ id: suppliers.id, name: suppliers.name })
          .from(suppliers)
          .where(and(eq(suppliers.workspaceId, workspaceId), inArray(suppliers.id, supplierIds)))
      ).map((s) => [s.id, s.name]),
    );
    const orders: OrderRow[] = [];
    for (const [index, entry] of input.orders.entries()) {
      try {
        orders.push(await insertOrder(tx, workspaceId, actorId, entry, today));
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        throw new ApiError(
          err.status,
          err.code,
          `Order ${index + 1} (${names.get(entry.supplierId) ?? "unknown supplier"}): ${err.message}. Nothing was created.`,
          { index, ...(err.details !== undefined ? { cause: err.details } : {}) },
        );
      }
    }
    const loaded = await loadOrders(tx, orders, today);
    return { orders: loaded.map((l) => l.summary) };
  });
}

// ─── Supplier performance ────────────────────────────────────────────────────

/**
 * On time, in full, OTIF and rejected deliveries per supplier for a period (default the last 90
 * days), measured against each line's promised date (`promisedOn`, fixed when sent) on sent and
 * closed orders; cancelled orders' lines are never due, but their deliveries and refusals count.
 * Reversed accepted receipts are left out.
 * Suppliers with nothing due and no delivery in the period are not listed. Sorted by name.
 */
export async function getSupplierPerformance(
  db: Database,
  workspaceId: string,
  query: SupplierPerformanceQuery,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const { from, to } = supplierPerformanceRange(query, today);
  const promised = purchaseOrderLines.promisedOn;
  const lines = await db
    .select({
      lineId: purchaseOrderLines.id,
      quantity: purchaseOrderLines.quantity,
      promisedOn: promised,
      supplierId: purchaseOrders.supplierId,
      status: purchaseOrders.status,
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
    .where(
      and(
        eq(purchaseOrders.workspaceId, workspaceId),
        isNull(purchaseOrders.deletedAt),
        isNull(purchaseOrderLines.deletedAt),
        // Cancelled orders' lines are never due, but their deliveries (refusals) still count.
        inArray(purchaseOrders.status, ["sent", "closed", "cancelled"]),
        query.supplierId ? eq(purchaseOrders.supplierId, query.supplierId) : undefined,
        or(
          and(gte(promised, from), lte(promised, to)),
          sql`exists (select 1 from ${purchaseReceipts} where ${purchaseReceipts.lineId} = ${purchaseOrderLines.id}
            and ${purchaseReceipts.voidedAt} is null
            and ${purchaseReceipts.receivedOn} >= ${from} and ${purchaseReceipts.receivedOn} <= ${to})`,
        ),
      ),
    );
  const receipts = lines.length
    ? await db
        .select({
          lineId: purchaseReceipts.lineId,
          outcome: purchaseReceipts.outcome,
          quantity: purchaseReceipts.quantity,
          receivedOn: purchaseReceipts.receivedOn,
          deliveryId: purchaseReceipts.deliveryId,
        })
        .from(purchaseReceipts)
        .leftJoin(reversal, eq(reversal.reversesMovementId, purchaseReceipts.stockMovementId))
        .where(
          and(
            inArray(
              purchaseReceipts.lineId,
              lines.map((l) => l.lineId),
            ),
            // A voided refusal was recorded in error: it never happened.
            isNull(purchaseReceipts.voidedAt),
            // Reversed accepted receipts never arrived as far as performance is concerned.
            or(eq(purchaseReceipts.outcome, "rejected"), isNull(reversal.id)),
          ),
        )
    : [];
  const byLine = new Map<string, PerformanceLine["receipts"][number][]>();
  for (const r of receipts) {
    const list = byLine.get(r.lineId) ?? [];
    list.push({
      outcome: r.outcome,
      quantity: r.quantity,
      receivedOn: r.receivedOn,
      deliveryId: r.deliveryId,
    });
    byLine.set(r.lineId, list);
  }
  const rows = supplierPerformance(
    lines.map((l) => ({
      supplierId: l.supplierId,
      lineId: l.lineId,
      promisedOn: l.promisedOn,
      quantity: l.quantity,
      orderStatus: l.status,
      receipts: byLine.get(l.lineId) ?? [],
    })),
    { from, to, today },
  );
  const supplierRows = rows.length
    ? await db
        .select()
        .from(suppliers)
        .where(
          inArray(
            suppliers.id,
            rows.map((r) => r.supplierId),
          ),
        )
    : [];
  const supplierById = new Map(supplierRows.map((s) => [s.id, s]));
  return {
    from,
    to,
    /** Every supplier together (the certified metric `supplier_otif`). */
    totals: supplierPerformanceTotals(rows),
    suppliers: rows
      .map(({ supplierId: _id, ...r }) => ({ supplier: supplierSummary(supplierById.get(_id)!), ...r }))
      .sort(
        (a, b) =>
          a.supplier.name.localeCompare(b.supplier.name) || a.supplier.id.localeCompare(b.supplier.id),
      ),
  };
}
