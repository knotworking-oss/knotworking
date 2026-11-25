import {
  PRICE_DECIMALS,
  convertQuantity,
  convertUnitPrice,
  creditNoteTotals,
  defaultInvoiceTolerances,
  invoiceLineValue,
  itemBaseUnit,
  matchInvoiceLine,
  purchaseInvoiceStatusLabels,
  purchaseInvoiceTotals,
  roundQuantity,
  worstMatchStatus,
  type ApprovedInvoiceLineMatch,
  type InvoiceLineMatch,
  type InvoiceMatchStatus,
  type InvoiceTolerances,
  type InvoiceTolerancesUpdateInput,
  type PurchaseInvoiceApproveInput,
  type PurchaseInvoiceCreateInput,
  type PurchaseInvoiceLineInput,
  type PurchaseInvoiceListQuery,
  type PurchaseInvoiceUpdateInput,
  type UnitCode,
} from "@knotworking/core";
import {
  items,
  lockWorkspaceLog,
  purchaseCreditNoteLines,
  purchaseCreditNotes,
  purchaseInvoiceLines,
  purchaseInvoices,
  purchaseOrderLines,
  purchaseOrders,
  purchaseReceipts,
  purchasingSettings,
  recordChanges,
  stockMovements,
  suppliers,
  users,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ApiError, badRequest, notFound } from "../errors";
import { itemSummary, num } from "./ports/stock";

/**
 * Purchasing module: supplier invoices and the three-way match (order, delivery, invoice).
 *
 * - An invoice belongs to one supplier. Its `order` lines invoice purchase order lines of that
 *   supplier's sent or closed orders, with quantity and price per the order line's unit; `charge`
 *   lines are non-stock (carriage).
 * - The match is computed on read (`matchInvoiceLine` in core): each order line on the invoice
 *   against the order's price and against what was accepted (net of reversed receipts) and not yet
 *   invoiced on other approved invoices, with the workspace's tolerances. Approval freezes it
 *   (`approved_match` on each line, `approved_tolerances` on the invoice; see `loadInvoices`).
 * - Drafts are entered and edited by people and agents. Approval for payment is a person's
 *   (`manage`, tokens refused; the route checks that) and a `mismatch` needs a reason. Approved
 *   invoices are immutable; a correction is a new version (`reviseInvoice`), which supersedes the
 *   approved one when it is itself approved. Every version is kept.
 * - Costing reads the lines of approved invoices (`approvedInvoiceLines`); purchase receipts are
 *   append-only and never touched.
 *
 * Every write takes the workspace lock and records its changes.
 */

type InvoiceRow = typeof purchaseInvoices.$inferSelect;
type InvoiceLineRow = typeof purchaseInvoiceLines.$inferSelect;
type OrderLineRow = typeof purchaseOrderLines.$inferSelect;
type OrderRow = typeof purchaseOrders.$inferSelect;
type ItemRow = typeof items.$inferSelect;

const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
const ilike = (column: unknown, q: string) => sql`${column} ilike ${like(q)} escape '!'`;

const strip = <T extends { workspaceId: string; deletedAt: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
};

/** The stock movement that reverses a receipt's movement, if any. */
const reversal = alias(stockMovements, "reversal");

const invoiceChange = (row: InvoiceRow): ChangeInput => ({
  entity: "purchase_invoice",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});
const invoiceLineChange = (row: InvoiceLineRow): ChangeInput => ({
  entity: "purchase_invoice_line",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

// ─── Tolerances ──────────────────────────────────────────────────────────────

/** The workspace's match tolerances: `defaultInvoiceTolerances` until someone saves. */
export async function getInvoiceTolerances(db: Executor, workspaceId: string): Promise<InvoiceTolerances> {
  const [row] = await db
    .select()
    .from(purchasingSettings)
    .where(eq(purchasingSettings.workspaceId, workspaceId));
  if (!row) return { ...defaultInvoiceTolerances };
  return {
    pricePercent: row.priceTolerancePercent,
    priceAmount: row.priceToleranceAmount,
    quantityPercent: row.quantityTolerancePercent,
    quantityAmount: row.quantityToleranceAmount,
  };
}

export async function updateInvoiceTolerances(
  db: Database,
  workspaceId: string,
  actorId: string,
  patch: InvoiceTolerancesUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const next = { ...(await getInvoiceTolerances(tx, workspaceId)), ...patch };
    const values = {
      priceTolerancePercent: roundQuantity(next.pricePercent, 2),
      priceToleranceAmount: roundQuantity(next.priceAmount),
      quantityTolerancePercent: roundQuantity(next.quantityPercent, 2),
      quantityToleranceAmount: roundQuantity(next.quantityAmount),
      updatedBy: actorId,
    };
    const [row] = await tx
      .insert(purchasingSettings)
      .values({ workspaceId, ...values })
      .onConflictDoUpdate({
        target: purchasingSettings.workspaceId,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "purchasing_settings", entityId: workspaceId, action: "upsert", data: strip(row!) },
    ]);
    return getInvoiceTolerances(tx, workspaceId);
  });
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

async function findInvoice(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(purchaseInvoices)
    .where(
      and(
        eq(purchaseInvoices.id, id),
        eq(purchaseInvoices.workspaceId, workspaceId),
        isNull(purchaseInvoices.deletedAt),
      ),
    );
  if (!row) throw notFound("Invoice");
  return row;
}

async function findSupplier(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, id), eq(suppliers.workspaceId, workspaceId), isNull(suppliers.deletedAt)));
  if (!row) throw notFound("Supplier");
  return row;
}

async function liveInvoiceLines(db: Executor, invoiceIds: string[]) {
  if (!invoiceIds.length) return [];
  return db
    .select()
    .from(purchaseInvoiceLines)
    .where(and(inArray(purchaseInvoiceLines.invoiceId, invoiceIds), isNull(purchaseInvoiceLines.deletedAt)))
    .orderBy(asc(purchaseInvoiceLines.lineNo), asc(purchaseInvoiceLines.id));
}

async function userNames(db: Executor, ids: (string | null)[]) {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const rows = list.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, list))
    : [];
  const map = new Map(rows.map((r) => [r.id, r.name]));
  return (id: string | null) => (id ? (map.get(id) ?? null) : null);
}

/**
 * Accepted quantity per order line (stock lines: base unit; non-stock lines: their own unit), net of
 * receipts whose movement was reversed and of voided receipts.
 */
async function receivedByOrderLine(db: Executor, orderLineIds: string[]) {
  const map = new Map<string, number>();
  if (!orderLineIds.length) return map;
  const rows = await db
    .select({
      lineId: purchaseReceipts.lineId,
      received: sql<string>`coalesce(sum(${purchaseReceipts.quantity}), 0)`,
    })
    .from(purchaseReceipts)
    .leftJoin(reversal, eq(reversal.reversesMovementId, purchaseReceipts.stockMovementId))
    .where(
      and(
        inArray(purchaseReceipts.lineId, orderLineIds),
        eq(purchaseReceipts.outcome, "accepted"),
        isNull(reversal.id),
        isNull(purchaseReceipts.voidedAt),
      ),
    )
    .groupBy(purchaseReceipts.lineId);
  for (const r of rows) map.set(r.lineId, num(r.received));
  return map;
}

/** Order lines (deleted ones too: a draft may name a line since removed) with their order. */
async function orderLinesWithOrders(db: Executor, workspaceId: string, ids: string[]) {
  if (!ids.length) return new Map<string, { line: OrderLineRow; order: OrderRow }>();
  const rows = await db
    .select({ line: purchaseOrderLines, order: purchaseOrders })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
    .where(and(eq(purchaseOrderLines.workspaceId, workspaceId), inArray(purchaseOrderLines.id, ids)));
  return new Map(rows.map((r) => [r.line.id, r]));
}

/** Base units in one `unit` of this item, by its conversion now; null when it doesn't convert. */
const basePerUnit = (unit: UnitCode, item: ItemRow) => {
  const base = itemBaseUnit(item);
  if (unit === base) return 1;
  const factor = convertQuantity(1, unit, base, item);
  return factor === null || !(factor > 0) ? null : factor;
};

/** A quantity in `from` as `to` for this item, or null when it can't convert. */
const inUnit = (quantity: number, from: UnitCode, to: UnitCode, item: ItemRow) =>
  from === to ? quantity : convertQuantity(quantity, from, to, item);

// ─── The match ───────────────────────────────────────────────────────────────

/**
 * Invoices with their lines matched. For each order line on them: the order's price, what was
 * received, and what other approved invoices already billed for it, which are:
 *
 * - for a draft: the approved invoices now in force, except the version it would replace;
 * - for an approved (or superseded) invoice: those approved before it and not yet replaced when it
 *   was approved (and a later invoice for the same order line never turns an earlier one into
 *   over-invoicing).
 *
 * A draft is matched live: the order's price, the item's unit conversion and the workspace's
 * tolerances as they are now. An approved or superseded invoice shows the match it was approved at
 * (each line's `approvedMatch`, the invoice's `approvedMatchStatus`): that is its status, never
 * re-graded. Its `now` is the same comparison today, still against the order price, conversion and
 * tolerances stored at approval, with what has been received (and reversed) since.
 */
async function loadInvoices(db: Executor, workspaceId: string, invoices: InvoiceRow[]) {
  const liveTolerances = await getInvoiceTolerances(db, workspaceId);
  const lines = await liveInvoiceLines(
    db,
    invoices.map((i) => i.id),
  );
  const orderLineIds = [...new Set(lines.flatMap((l) => (l.orderLineId ? [l.orderLineId] : [])))];
  const [orderLines, received, others] = await Promise.all([
    orderLinesWithOrders(db, workspaceId, orderLineIds),
    receivedByOrderLine(db, orderLineIds),
    orderLineIds.length
      ? db
          .select({ line: purchaseInvoiceLines, invoice: purchaseInvoices })
          .from(purchaseInvoiceLines)
          .innerJoin(purchaseInvoices, eq(purchaseInvoices.id, purchaseInvoiceLines.invoiceId))
          .where(
            and(
              inArray(purchaseInvoiceLines.orderLineId, orderLineIds),
              isNull(purchaseInvoiceLines.deletedAt),
              isNull(purchaseInvoices.deletedAt),
              inArray(purchaseInvoices.status, ["approved", "superseded"]),
            ),
          )
      : [],
  ]);
  const itemIds = [
    ...new Set([...orderLines.values()].flatMap((o) => (o.line.itemId ? [o.line.itemId] : []))),
  ];
  const supplierIds = [...new Set(invoices.map((i) => i.supplierId))];
  const [itemRows, supplierRows] = await Promise.all([
    itemIds.length ? db.select().from(items).where(inArray(items.id, itemIds)) : [],
    supplierIds.length ? db.select().from(suppliers).where(inArray(suppliers.id, supplierIds)) : [],
  ]);
  const itemMap = new Map(itemRows.map((r) => [r.id, r]));
  const supplierMap = new Map(supplierRows.map((r) => [r.id, r]));
  const othersByOrderLine = new Map<string, typeof others>();
  for (const o of others) {
    const list = othersByOrderLine.get(o.line.orderLineId!) ?? [];
    list.push(o);
    othersByOrderLine.set(o.line.orderLineId!, list);
  }
  const linesByInvoice = new Map<string, InvoiceLineRow[]>();
  for (const line of lines) {
    const list = linesByInvoice.get(line.invoiceId) ?? [];
    list.push(line);
    linesByInvoice.set(line.invoiceId, list);
  }

  /** Whether `other` counts as already billed when matching `invoice`. */
  const countsAgainst = (invoice: InvoiceRow, other: InvoiceRow) => {
    if (other.id === invoice.id) return false;
    if (invoice.status === "draft") return other.status === "approved" && other.id !== invoice.supersedesId;
    const at = invoice.approvedAt!;
    return (
      other.approvedAt !== null &&
      other.approvedAt < at &&
      (other.supersededAt === null || other.supersededAt > at) &&
      other.id !== invoice.supersedesId
    );
  };

  return invoices.map((invoice) => {
    const frozen = invoice.status !== "draft";
    const tolerances = (frozen ? invoice.approvedTolerances : null) ?? liveTolerances;
    /** Per invoice line: what approval stores (drafts only). */
    const snapshots = new Map<string, ApprovedInvoiceLineMatch>();
    const lineViews = (linesByInvoice.get(invoice.id) ?? []).map((line) => {
      const value = invoiceLineValue(line.quantity, line.unitPrice);
      const base = {
        id: line.id,
        lineNo: line.lineNo,
        kind: line.kind,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        value,
      };
      const ordered = line.orderLineId ? orderLines.get(line.orderLineId) : undefined;
      // A non-stock order line is invoiced in its own unit: the invoice line has no stock unit.
      const nonStock = ordered?.line.kind === "non_stock";
      if (line.kind !== "order" || !ordered || (!line.unit && !nonStock)) {
        return {
          ...base,
          item: null,
          orderLine: null,
          received: null,
          invoicedElsewhere: null,
          match: null,
          now: null,
        };
      }
      const item = ordered.line.itemId ? itemMap.get(ordered.line.itemId)! : null;
      const unit = line.unit;
      const approved = frozen ? line.approvedMatch : null;
      // What the line is compared against: stored at approval, else as it is now. A non-stock
      // line's quantities are all in its own unit: nothing converts.
      const factor = approved ? approved.basePerUnit : nonStock ? 1 : basePerUnit(unit!, item!);
      const fromBase = (q: number) => (factor === null ? null : roundQuantity(q / factor));
      const liveOrderPrice =
        ordered.line.unitPrice === null
          ? null
          : nonStock || ordered.line.unit === unit
            ? ordered.line.unitPrice
            : convertUnitPrice(ordered.line.unitPrice, ordered.line.unit!, unit!, item!, PRICE_DECIMALS);
      const orderPrice = approved ? approved.orderUnitPrice : liveOrderPrice;
      const orderPriceNotConvertible =
        !approved && ordered.line.unitPrice !== null && liveOrderPrice === null;
      const receivedNow = fromBase(received.get(ordered.line.id) ?? 0);
      let elsewhereNow: number | null = 0;
      for (const o of othersByOrderLine.get(ordered.line.id) ?? []) {
        if (!countsAgainst(invoice, o.invoice)) continue;
        const q = nonStock ? o.line.quantity : inUnit(o.line.quantity, o.line.unit ?? unit!, unit!, item!);
        elsewhereNow = q === null || elsewhereNow === null ? null : elsewhereNow + q;
      }
      if (elsewhereNow !== null) elsewhereNow = roundQuantity(elsewhereNow);
      const matchNow: InvoiceLineMatch = matchInvoiceLine(
        {
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          orderUnitPrice: orderPrice,
          orderPriceNotConvertible,
          received: receivedNow,
          invoicedElsewhere: elsewhereNow,
          // An order line now for another item (the invoice line keeps the item it was entered for).
          convertible: line.itemId === ordered.line.itemId,
        },
        tolerances,
      );
      if (!frozen) {
        snapshots.set(line.id, {
          orderUnit: ordered.line.unit,
          orderUnitPrice: orderPrice,
          basePerUnit: factor,
          received: receivedNow,
          invoicedElsewhere: elsewhereNow,
          match: matchNow,
        });
      }
      return {
        ...base,
        item: item ? itemSummary(item) : null,
        orderLine: {
          id: ordered.line.id,
          lineNo: ordered.line.lineNo,
          kind: ordered.line.kind,
          /** Non-stock order lines: what was ordered, its unit and expense code. */
          description: ordered.line.description,
          unitLabel: ordered.line.unitLabel,
          nominalCode: ordered.line.nominalCode,
          purchaseOrderId: ordered.order.id,
          reference: ordered.order.reference,
          orderStatus: ordered.order.status,
          /** Ordered, in the invoice line's unit (null when it doesn't convert). */
          quantity: fromBase(ordered.line.quantity),
          /** The order's price per the invoice line's unit (at approval, once approved). */
          unitPrice: orderPrice,
          /** The line has since been taken off the order (drafts only can name one). */
          removed: ordered.line.deletedAt !== null,
        },
        /** Received, in the line's unit (at approval, once approved); null when it doesn't convert. */
        received: approved ? approved.received : receivedNow,
        invoicedElsewhere: approved ? approved.invoicedElsewhere : elsewhereNow,
        /** The match: at approval for an approved or superseded invoice, else live. */
        match: approved ? approved.match : matchNow,
        /**
         * Approved and superseded invoices: the same comparison today (against the order price,
         * conversion and tolerances stored at approval). Null on drafts, whose match is live.
         */
        now: approved ? { received: receivedNow, invoicedElsewhere: elsewhereNow, match: matchNow } : null,
      };
    });
    const totals = purchaseInvoiceTotals(lineViews, invoice.vat);
    const matched = lineViews.flatMap((l) => (l.match ? [l.match.status] : []));
    const matchedNow = lineViews.flatMap((l) => (l.match ? [(l.now?.match ?? l.match).status] : []));
    const orders = new Map<string, { id: string; reference: string }>();
    for (const l of lineViews) {
      if (l.orderLine)
        orders.set(l.orderLine.purchaseOrderId, {
          id: l.orderLine.purchaseOrderId,
          reference: l.orderLine.reference,
        });
    }
    const supplier = supplierMap.get(invoice.supplierId)!;
    return {
      invoice,
      lines: lineViews,
      snapshots,
      tolerances,
      summary: {
        ...strip(invoice),
        supplier: {
          id: supplier.id,
          name: supplier.name,
          code: supplier.code,
          approvalStatus: supplier.approvalStatus,
        },
        net: totals.net,
        gross: totals.gross,
        linesCount: lineViews.length,
        /**
         * The three-way match: the worst order line (`matched` when there are none). For an
         * approved or superseded invoice, the status it was approved at; for a draft, now.
         */
        matchStatus: (frozen && invoice.approvedMatchStatus
          ? invoice.approvedMatchStatus
          : worstMatchStatus(matched)) as InvoiceMatchStatus,
        /** The same comparison today (approved and superseded invoices; a draft's is `matchStatus`). */
        matchStatusNow: worstMatchStatus(matchedNow) as InvoiceMatchStatus,
        mismatchedLines: matched.filter((s) => s === "mismatch").length,
        orders: [...orders.values()],
      },
    };
  });
}

/** One invoice with its lines matched, the versions of it, and the names of who did what. */
export async function getInvoice(db: Executor, workspaceId: string, id: string) {
  const invoice = await findInvoice(db, workspaceId, id);
  const [loaded] = await loadInvoices(db, workspaceId, [invoice]);
  const versions = await db
    .select({
      id: purchaseInvoices.id,
      version: purchaseInvoices.version,
      status: purchaseInvoices.status,
      approvedAt: purchaseInvoices.approvedAt,
    })
    .from(purchaseInvoices)
    .where(
      and(
        eq(purchaseInvoices.workspaceId, workspaceId),
        eq(purchaseInvoices.supplierId, invoice.supplierId),
        sql`lower(${purchaseInvoices.invoiceNumber}) = lower(${invoice.invoiceNumber})`,
        isNull(purchaseInvoices.deletedAt),
      ),
    )
    .orderBy(asc(purchaseInvoices.version));
  const name = await userNames(db, [invoice.createdBy, invoice.approvedBy]);
  // Credit notes against this invoice (voided ones left out), and what the approved ones credit.
  const notes = await db
    .select()
    .from(purchaseCreditNotes)
    .where(
      and(
        eq(purchaseCreditNotes.invoiceId, id),
        isNull(purchaseCreditNotes.deletedAt),
        ne(purchaseCreditNotes.status, "voided"),
      ),
    )
    .orderBy(asc(purchaseCreditNotes.creditDate), asc(purchaseCreditNotes.id));
  const noteLines = notes.length
    ? await db
        .select()
        .from(purchaseCreditNoteLines)
        .where(
          and(
            inArray(
              purchaseCreditNoteLines.creditNoteId,
              notes.map((n) => n.id),
            ),
            isNull(purchaseCreditNoteLines.deletedAt),
          ),
        )
    : [];
  const creditNotes = notes.map((n) => {
    const totals = creditNoteTotals(
      noteLines.filter((l) => l.creditNoteId === n.id),
      n.vat,
    );
    return {
      id: n.id,
      creditNoteNumber: n.creditNoteNumber,
      creditDate: n.creditDate,
      status: n.status,
      net: totals.net,
      gross: totals.gross,
    };
  });
  const creditedNet = roundQuantity(
    creditNotes.filter((n) => n.status === "approved").reduce((sum, n) => sum + n.net, 0),
    4,
  );
  return {
    ...loaded!.summary,
    creditNotes,
    /** Net credited by approved credit notes, and what is left of the invoice's net. */
    creditedNet,
    netAfterCredits: roundQuantity(loaded!.summary.net - creditedNet, 4),
    /** The tolerances its match uses: those stored at approval, or the workspace's now (drafts). */
    tolerances: loaded!.tolerances,
    createdByName: name(invoice.createdBy),
    approvedByName: name(invoice.approvedBy),
    lines: loaded!.lines,
    versions,
  };
}

// ─── Listing ─────────────────────────────────────────────────────────────────

/** Invoices, latest invoice date first, each with its totals and match status now. */
export async function listInvoices(db: Executor, workspaceId: string, query: PurchaseInvoiceListQuery) {
  const pi = purchaseInvoices;
  const where: (SQL | undefined)[] = [eq(pi.workspaceId, workspaceId), isNull(pi.deletedAt)];
  if (query.status === "current") where.push(inArray(pi.status, ["draft", "approved"]));
  else if (query.status !== "all") where.push(eq(pi.status, query.status));
  if (query.supplierId) where.push(eq(pi.supplierId, query.supplierId));
  if (query.purchaseOrderId) {
    where.push(
      sql`exists (select 1 from ${purchaseInvoiceLines} where ${purchaseInvoiceLines.invoiceId} = ${pi.id}
        and ${purchaseInvoiceLines.purchaseOrderId} = ${query.purchaseOrderId} and ${purchaseInvoiceLines.deletedAt} is null)`,
    );
  }
  if (query.from) where.push(gte(pi.invoiceDate, query.from));
  if (query.to) where.push(lte(pi.invoiceDate, query.to));
  if (query.q) where.push(or(ilike(pi.invoiceNumber, query.q), ilike(suppliers.name, query.q)));
  const [rows, [total]] = await Promise.all([
    db
      .select({ invoice: pi })
      .from(pi)
      .innerJoin(suppliers, eq(suppliers.id, pi.supplierId))
      .where(and(...where))
      .orderBy(desc(pi.invoiceDate), desc(pi.createdAt), desc(pi.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(pi)
      .innerJoin(suppliers, eq(suppliers.id, pi.supplierId))
      .where(and(...where)),
  ]);
  const loaded = await loadInvoices(
    db,
    workspaceId,
    rows.map((r) => r.invoice),
  );
  return {
    invoices: loaded.map((l) => l.summary),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

// ─── Entering drafts (people and agents) ─────────────────────────────────────

const immutable = (invoice: InvoiceRow) =>
  new ApiError(
    409,
    "invoice_not_draft",
    `Invoice ${invoice.invoiceNumber} is ${purchaseInvoiceStatusLabels[invoice.status].toLowerCase()}; it can't be changed. Revise it to correct it`,
  );

/** 409 when the supplier already has a live invoice with this number (versions aside). */
async function assertNumberFree(
  tx: Executor,
  workspaceId: string,
  supplierId: string,
  invoiceNumber: string,
  exceptId?: string,
) {
  const [taken] = await tx
    .select({ id: purchaseInvoices.id })
    .from(purchaseInvoices)
    .where(
      and(
        eq(purchaseInvoices.workspaceId, workspaceId),
        eq(purchaseInvoices.supplierId, supplierId),
        sql`lower(${purchaseInvoices.invoiceNumber}) = lower(${invoiceNumber})`,
        isNull(purchaseInvoices.deletedAt),
        exceptId ? ne(purchaseInvoices.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (taken) {
    throw new ApiError(
      409,
      "duplicate_invoice_number",
      `This supplier already has an invoice numbered ${invoiceNumber}`,
      { invoiceId: taken.id },
    );
  }
}

/**
 * Lines checked and ready to insert: an order line must be on a sent or closed order of the
 * invoice's supplier. Its quantity and price are per the order line's unit, which the line keeps.
 */
async function lineValues(
  tx: Executor,
  workspaceId: string,
  supplierId: string,
  input: readonly PurchaseInvoiceLineInput[],
) {
  const ids = input.flatMap((l) => (l.kind === "order" ? [l.orderLineId] : []));
  const orderLines = await orderLinesWithOrders(tx, workspaceId, ids);
  return input.map((line, index) => {
    const common = { lineNo: index + 1, quantity: roundQuantity(line.quantity), unitPrice: line.unitPrice };
    if (line.kind === "charge") {
      return {
        ...common,
        kind: "charge" as const,
        orderLineId: null,
        purchaseOrderId: null,
        itemId: null,
        unit: null,
        description: line.description,
      };
    }
    const found = orderLines.get(line.orderLineId);
    if (!found || found.line.deletedAt || found.order.deletedAt) throw notFound("Purchase order line");
    const { line: orderLine, order } = found;
    if (order.supplierId !== supplierId) {
      throw new ApiError(
        409,
        "wrong_supplier",
        `Line ${index + 1}: ${order.reference} is with another supplier`,
        { index, purchaseOrderId: order.id },
      );
    }
    if (order.status !== "sent" && order.status !== "closed") {
      throw new ApiError(
        409,
        "order_not_invoiceable",
        `Line ${index + 1}: ${order.reference} is ${order.status}; only sent and closed orders are invoiced`,
        { index, purchaseOrderId: order.id },
      );
    }
    return {
      ...common,
      kind: "order" as const,
      orderLineId: orderLine.id,
      purchaseOrderId: order.id,
      itemId: orderLine.itemId,
      // Null for a non-stock order line: invoiced in its own unit.
      unit: orderLine.unit,
      // A non-stock line says what it is (the accounting export shows it).
      description: line.description ?? (orderLine.kind === "non_stock" ? orderLine.description : null),
    };
  });
}

async function insertLines(
  tx: Transaction,
  workspaceId: string,
  invoiceId: string,
  values: Awaited<ReturnType<typeof lineValues>>,
) {
  if (!values.length) return [];
  return tx
    .insert(purchaseInvoiceLines)
    .values(values.map((v) => ({ ...v, workspaceId, invoiceId })))
    .returning();
}

/** A draft invoice, entered by a person or drafted by an agent. */
export async function createInvoice(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: PurchaseInvoiceCreateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const supplier = await findSupplier(tx, workspaceId, input.supplierId);
    await assertNumberFree(tx, workspaceId, supplier.id, input.invoiceNumber);
    const values = await lineValues(tx, workspaceId, supplier.id, input.lines);
    const [invoice] = await tx
      .insert(purchaseInvoices)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        supplierId: supplier.id,
        invoiceNumber: input.invoiceNumber,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate ?? null,
        vat: input.vat,
        notes: input.notes ?? null,
        createdBy: actorId,
      })
      .returning();
    const lines = await insertLines(tx, workspaceId, invoice!.id, values);
    await recordChanges(tx, workspaceId, actorId, [invoiceChange(invoice!), ...lines.map(invoiceLineChange)]);
    return assertNotNegative(await getInvoice(tx, workspaceId, invoice!.id));
  });
}

/**
 * An invoice can't total less than nothing: discounts (charges at a negative price) come off what
 * is billed, and money coming back from a supplier is a credit note. Rolls the write back (400).
 */
function assertNotNegative<T extends { net: number }>(invoice: T): T {
  if (invoice.net < 0) {
    throw badRequest(
      "The invoice totals less than nothing; discounts can't exceed the lines they come off (a credit from the supplier is a credit note)",
    );
  }
  return invoice;
}

/**
 * Edits a draft. `lines` replaces every line. A revision keeps the supplier and number of the
 * invoice it corrects. Approved and superseded invoices can't change (`409 invoice_not_draft`).
 */
export async function updateInvoice(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: PurchaseInvoiceUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findInvoice(tx, workspaceId, id);
    if (current.status !== "draft") throw immutable(current);
    const { lines: lineInput, ...header } = patch;
    const supplierId = header.supplierId ?? current.supplierId;
    const invoiceNumber = header.invoiceNumber ?? current.invoiceNumber;
    const renamed =
      supplierId !== current.supplierId ||
      invoiceNumber.toLowerCase() !== current.invoiceNumber.toLowerCase();
    if (renamed && current.supersedesId) {
      throw new ApiError(
        409,
        "revision_locked",
        "A revision keeps the supplier and invoice number of the invoice it corrects",
      );
    }
    if (supplierId !== current.supplierId) await findSupplier(tx, workspaceId, supplierId);
    if (renamed) await assertNumberFree(tx, workspaceId, supplierId, invoiceNumber, id);
    const invoiceDate = header.invoiceDate ?? current.invoiceDate;
    const dueDate = header.dueDate !== undefined ? header.dueDate : current.dueDate;
    if (dueDate && dueDate < invoiceDate) throw badRequest("The due date is before the invoice date");
    const changes: ChangeInput[] = [];
    // Lines are re-checked when the supplier changes, so none points at another supplier's order.
    const existing = await liveInvoiceLines(tx, [id]);
    const replacement =
      lineInput ??
      (supplierId !== current.supplierId
        ? existing.map((l): PurchaseInvoiceLineInput =>
            l.kind === "order"
              ? {
                  kind: "order",
                  orderLineId: l.orderLineId!,
                  quantity: l.quantity,
                  unitPrice: l.unitPrice,
                  description: l.description,
                }
              : {
                  kind: "charge",
                  description: l.description ?? "",
                  quantity: l.quantity,
                  unitPrice: l.unitPrice,
                },
          )
        : undefined);
    const [row] = await tx
      .update(purchaseInvoices)
      .set({ ...header, updatedAt: new Date() })
      .where(eq(purchaseInvoices.id, id))
      .returning();
    changes.push(invoiceChange(row!));
    if (replacement) {
      const values = await lineValues(tx, workspaceId, supplierId, replacement);
      if (existing.length) {
        await tx
          .update(purchaseInvoiceLines)
          .set({ deletedAt: new Date() })
          .where(
            inArray(
              purchaseInvoiceLines.id,
              existing.map((l) => l.id),
            ),
          );
        for (const l of existing)
          changes.push({ entity: "purchase_invoice_line", entityId: l.id, action: "delete" });
      }
      changes.push(...(await insertLines(tx, workspaceId, id, values)).map(invoiceLineChange));
    }
    await recordChanges(tx, workspaceId, actorId, changes);
    return assertNotNegative(await getInvoice(tx, workspaceId, id));
  });
}

/** Deletes a draft (soft). An approved invoice is kept; correct it with a new version. */
export async function deleteInvoice(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findInvoice(tx, workspaceId, id);
    if (current.status !== "draft") throw immutable(current);
    const now = new Date();
    const lines = await tx
      .update(purchaseInvoiceLines)
      .set({ deletedAt: now })
      .where(and(eq(purchaseInvoiceLines.invoiceId, id), isNull(purchaseInvoiceLines.deletedAt)))
      .returning({ id: purchaseInvoiceLines.id });
    await tx.update(purchaseInvoices).set({ deletedAt: now }).where(eq(purchaseInvoices.id, id));
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "purchase_invoice", entityId: id, action: "delete" },
      ...lines.map((l): ChangeInput => ({
        entity: "purchase_invoice_line",
        entityId: l.id,
        action: "delete",
      })),
    ]);
  });
}

/**
 * A correction of an approved invoice: a new draft version with its supplier, number, header and
 * lines, to edit and approve. The approved version stays in force (and in costing) until then.
 * One draft revision at a time (`409 revision_exists`).
 */
export async function reviseInvoice(db: Database, workspaceId: string, actorId: string, id: string) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findInvoice(tx, workspaceId, id);
    if (current.status !== "approved") {
      throw new ApiError(
        409,
        "invoice_not_approved",
        current.status === "draft"
          ? `Invoice ${current.invoiceNumber} is a draft; edit it instead`
          : `Invoice ${current.invoiceNumber} version ${current.version} has been superseded; revise the latest version`,
      );
    }
    const [pending] = await tx
      .select({ id: purchaseInvoices.id })
      .from(purchaseInvoices)
      .where(
        and(
          eq(purchaseInvoices.supersedesId, id),
          eq(purchaseInvoices.status, "draft"),
          isNull(purchaseInvoices.deletedAt),
        ),
      )
      .limit(1);
    if (pending) {
      throw new ApiError(409, "revision_exists", "A revision of this invoice is already being drafted", {
        invoiceId: pending.id,
      });
    }
    const [{ max } = { max: current.version }] = await tx
      .select({ max: sql<number>`max(${purchaseInvoices.version})::int` })
      .from(purchaseInvoices)
      .where(
        and(
          eq(purchaseInvoices.workspaceId, workspaceId),
          eq(purchaseInvoices.supplierId, current.supplierId),
          sql`lower(${purchaseInvoices.invoiceNumber}) = lower(${current.invoiceNumber})`,
          isNull(purchaseInvoices.deletedAt),
        ),
      );
    const [invoice] = await tx
      .insert(purchaseInvoices)
      .values({
        workspaceId,
        supplierId: current.supplierId,
        invoiceNumber: current.invoiceNumber,
        version: (max ?? current.version) + 1,
        supersedesId: current.id,
        invoiceDate: current.invoiceDate,
        dueDate: current.dueDate,
        vat: current.vat,
        notes: current.notes,
        createdBy: actorId,
      })
      .returning();
    const old = await liveInvoiceLines(tx, [id]);
    const lines = old.length
      ? await tx
          .insert(purchaseInvoiceLines)
          .values(
            old.map((l) => ({
              workspaceId,
              invoiceId: invoice!.id,
              lineNo: l.lineNo,
              kind: l.kind,
              orderLineId: l.orderLineId,
              purchaseOrderId: l.purchaseOrderId,
              itemId: l.itemId,
              quantity: l.quantity,
              unit: l.unit,
              unitPrice: l.unitPrice,
              description: l.description,
            })),
          )
          .returning()
      : [];
    await recordChanges(tx, workspaceId, actorId, [invoiceChange(invoice!), ...lines.map(invoiceLineChange)]);
    return getInvoice(tx, workspaceId, invoice!.id);
  });
}

// ─── Approval (a person) ─────────────────────────────────────────────────────

/**
 * Approves a draft for payment: a person's act with `manage` (the route refuses tokens). It needs a
 * line, its supplier still current (not deleted), every order line's order still sent or closed
 * (`409 order_not_invoiceable`), and a reason when the match is a `mismatch` or there are only
 * charges (nothing to match). Freezes the match: the invoice keeps its status and the tolerances,
 * each order line what it was matched against (`approvedMatch`). A revision supersedes the version
 * it corrects. Approved invoices are immutable.
 */
export async function approveInvoice(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: PurchaseInvoiceApproveInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findInvoice(tx, workspaceId, id);
    if (current.status !== "draft") {
      throw new ApiError(
        409,
        "invoice_not_draft",
        `Invoice ${current.invoiceNumber} is already ${purchaseInvoiceStatusLabels[current.status].toLowerCase()}`,
      );
    }
    const [loaded] = await loadInvoices(tx, workspaceId, [current]);
    const { summary, lines } = loaded!;
    if (!lines.length) throw badRequest("An invoice needs at least one line to be approved");
    const removed = lines.find((l) => l.orderLine?.removed);
    if (removed) {
      throw new ApiError(
        409,
        "order_line_removed",
        `Line ${removed.lineNo}: the order line has been taken off ${removed.orderLine!.reference}`,
      );
    }
    // The order may have been cancelled (or otherwise left sent and closed) since the line was entered.
    const closedOrder = lines.find(
      (l) => l.orderLine && l.orderLine.orderStatus !== "sent" && l.orderLine.orderStatus !== "closed",
    );
    if (closedOrder) {
      const ol = closedOrder.orderLine!;
      throw new ApiError(
        409,
        "order_not_invoiceable",
        `Line ${closedOrder.lineNo}: ${ol.reference} is ${ol.orderStatus}; only sent and closed orders are invoiced`,
        { lineNo: closedOrder.lineNo, purchaseOrderId: ol.purchaseOrderId },
      );
    }
    // The supplier may have been deleted since the draft was entered.
    await findSupplier(tx, workspaceId, current.supplierId);
    const reason = input.reason ?? null;
    if (summary.matchStatus === "mismatch" && !reason) {
      throw new ApiError(
        409,
        "reason_required",
        "The invoice doesn't match its orders and deliveries; say why it should be paid anyway",
        { matchStatus: summary.matchStatus, mismatchedLines: summary.mismatchedLines },
      );
    }
    // Charges alone have nothing to be matched against, so paying them needs a reason too.
    if (!lines.some((l) => l.kind === "order") && !reason) {
      throw new ApiError(
        409,
        "reason_required",
        "The invoice has no order lines to match; say why it should be paid",
        { matchStatus: summary.matchStatus, mismatchedLines: 0 },
      );
    }
    const now = new Date();
    const [row] = await tx
      .update(purchaseInvoices)
      .set({
        status: "approved",
        approvedAt: now,
        approvedBy: actorId,
        approvedMatchStatus: summary.matchStatus,
        approvedTolerances: loaded!.tolerances,
        approvalReason: reason,
        updatedAt: now,
      })
      .where(eq(purchaseInvoices.id, id))
      .returning();
    const changes: ChangeInput[] = [invoiceChange(row!)];
    // Each order line keeps what it was matched against, so the invoice never re-grades.
    for (const [lineId, approvedMatch] of loaded!.snapshots) {
      const [lineRow] = await tx
        .update(purchaseInvoiceLines)
        .set({ approvedMatch, updatedAt: now })
        .where(eq(purchaseInvoiceLines.id, lineId))
        .returning();
      changes.push(invoiceLineChange(lineRow!));
    }
    if (current.supersedesId) {
      const [prior] = await tx
        .update(purchaseInvoices)
        .set({ status: "superseded", supersededAt: now, supersededById: id, updatedAt: now })
        .where(and(eq(purchaseInvoices.id, current.supersedesId), eq(purchaseInvoices.status, "approved")))
        .returning();
      if (prior) changes.push(invoiceChange(prior));
    }
    await recordChanges(tx, workspaceId, actorId, changes);
    return getInvoice(tx, workspaceId, id);
  });
}

// ─── Costing ─────────────────────────────────────────────────────────────────

/**
 * What costing reads: the order lines' lines on approved invoices (superseded versions left out),
 * with what each was matched against at approval, oldest approval first. Costing reads these in
 * chunks of ids and prices each receipt with `invoicePricePerBase` (core).
 */
export async function approvedInvoiceLines(
  db: Executor,
  workspaceId: string,
  orderLineIds: readonly string[],
) {
  if (!orderLineIds.length) return [];
  return db
    .select({
      orderLineId: purchaseInvoiceLines.orderLineId,
      quantity: purchaseInvoiceLines.quantity,
      unitPrice: purchaseInvoiceLines.unitPrice,
      approvedMatch: purchaseInvoiceLines.approvedMatch,
      invoiceId: purchaseInvoices.id,
      invoiceNumber: purchaseInvoices.invoiceNumber,
      version: purchaseInvoices.version,
    })
    .from(purchaseInvoiceLines)
    .innerJoin(purchaseInvoices, eq(purchaseInvoices.id, purchaseInvoiceLines.invoiceId))
    .where(
      and(
        eq(purchaseInvoiceLines.workspaceId, workspaceId),
        inArray(purchaseInvoiceLines.orderLineId, [...orderLineIds]),
        eq(purchaseInvoiceLines.kind, "order"),
        isNull(purchaseInvoiceLines.deletedAt),
        eq(purchaseInvoices.status, "approved"),
        isNull(purchaseInvoices.deletedAt),
      ),
    )
    .orderBy(asc(purchaseInvoices.approvedAt), asc(purchaseInvoiceLines.id));
}
