import {
  currencyDigits,
  itemBaseUnit,
  newId,
  roundQuantity,
  serviceQuoteAmount,
  type InvoiceLine,
  type InvoiceParty,
} from "@knotworking/core";
import {
  customerDocumentClaims as claims,
  customerDocuments,
  despatchLines,
  despatchReturns,
  despatches,
  salesFulfilments,
  salesOrderLines,
  salesOrders,
  serviceQuotes,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ApiError, notFound } from "../errors";

export const invoiceConflict = (message: string) => new ApiError(409, "invoice_conflict", message);
type Claim = Pick<typeof claims.$inferInsert, "kind" | "sourceId" | "orderLineId" | "quantity">;
type Source = {
  customerId: string;
  customer: InvoiceParty;
  currency: string;
  reference: string;
  lines: InvoiceLine[];
  claims: Claim[];
};

export async function activeClaims(db: Executor, ws: string, kind: Claim["kind"], sourceIds: string[]) {
  if (!sourceIds.length) return new Set<string>();
  const rows = await db
    .select({ sourceId: claims.sourceId })
    .from(claims)
    .where(
      and(
        eq(claims.workspaceId, ws),
        eq(claims.kind, kind),
        inArray(claims.sourceId, sourceIds),
        isNull(claims.releasedAt),
      ),
    );
  return new Set(rows.map(({ sourceId }) => sourceId));
}

export async function reservedSalesLines(db: Executor, ws: string, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await db
    .select({ id: claims.orderLineId })
    .from(claims)
    .where(and(eq(claims.workspaceId, ws), inArray(claims.orderLineId, ids), isNull(claims.releasedAt)));
  return new Set(rows.map(({ id }) => id));
}

/** Keep the reservation as billing history even when its invoice line has been credited. */
export async function assertInvoiceAllowsDespatchCorrection(db: Executor, ws: string, lineIds: string[]) {
  if (!lineIds.length) return;
  const rows = await db
    .select({ sourceId: claims.sourceId, document: customerDocuments })
    .from(claims)
    .innerJoin(customerDocuments, eq(customerDocuments.id, claims.documentId))
    .where(
      and(
        eq(claims.workspaceId, ws),
        eq(claims.kind, "despatch_line"),
        inArray(claims.sourceId, lineIds),
        isNull(claims.releasedAt),
      ),
    );
  const issuedLineIds = rows.flatMap(({ sourceId, document }) => {
    if (document.status === "draft")
      throw invoiceConflict("Discard the invoice draft before correcting this dispatch or return.");
    return document.lines.filter((line) => line.sourceLineId === sourceId).map((line) => line.id);
  });
  if (!issuedLineIds.length) return;
  const credits = await db
    .select({ sourceId: claims.sourceId })
    .from(claims)
    .innerJoin(customerDocuments, eq(customerDocuments.id, claims.documentId))
    .where(
      and(
        eq(claims.workspaceId, ws),
        eq(claims.kind, "credit_line"),
        inArray(claims.sourceId, issuedLineIds),
        isNull(claims.releasedAt),
        eq(customerDocuments.status, "issued"),
      ),
    );
  if (credits.length !== issuedLineIds.length)
    throw invoiceConflict(
      "Issue a credit note for each affected invoice line before correcting this dispatch or return.",
    );
}

/** A shipment is shared by both draft entry points. Keep its sales link stable while reserved. */
export async function assertInvoiceFulfilmentUnclaimed(
  db: Executor,
  ws: string,
  despatchLineId: string,
  orderLineId: string,
  unlinking: boolean,
) {
  const [shipment, direct] = await Promise.all([
    activeClaims(db, ws, "despatch_line", [despatchLineId]),
    unlinking ? activeClaims(db, ws, "sales_line", [orderLineId]) : new Set<string>(),
  ]);
  if (shipment.size || direct.size)
    throw invoiceConflict(
      "This delivery is linked to an active invoice. Discard its draft or retain the link and issue a credit note.",
    );
}

/** Returns reduce the billable quantity until the invoice is issued. */
function returned(ws: string) {
  return sql<number>`(select coalesce(sum(${despatchReturns.quantity}), 0)::float8
    from ${despatchReturns} where ${despatchReturns.workspaceId} = ${ws}
    and ${despatchReturns.lineId} = ${despatchLines.id} and ${despatchReturns.voidedAt} is null)`;
}

export async function assertInvoiceSourcesCurrent(
  db: Executor,
  ws: string,
  documentId: string,
  lines: InvoiceLine[],
  currency: string,
) {
  const reservations = await db
    .select()
    .from(claims)
    .where(and(eq(claims.workspaceId, ws), eq(claims.documentId, documentId)));
  const shipmentIds = reservations.filter((row) => row.kind === "despatch_line").map((row) => row.sourceId);
  if (shipmentIds.length) {
    const rows = await db
      .select({
        id: despatchLines.id,
        quantity: despatchLines.quantity,
        returned: returned(ws),
        status: despatches.status,
      })
      .from(despatchLines)
      .innerJoin(despatches, eq(despatches.id, despatchLines.despatchId))
      .where(
        and(
          eq(despatchLines.workspaceId, ws),
          eq(despatches.workspaceId, ws),
          inArray(despatchLines.id, shipmentIds),
        ),
      );
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const claim of reservations.filter((row) => row.kind === "despatch_line")) {
      const row = byId.get(claim.sourceId);
      if (
        !row ||
        row.status !== "confirmed" ||
        roundQuantity(row.quantity - row.returned) !== Number(claim.quantity)
      )
        throw invoiceConflict("A dispatch changed after drafting. Discard the draft and prepare it again.");
    }
  }
  const salesClaims = reservations.filter((row) => row.orderLineId);
  if (salesClaims.length) {
    const rows = await db
      .select({ line: salesOrderLines, status: salesOrders.status, currency: salesOrders.currency })
      .from(salesOrderLines)
      .innerJoin(salesOrders, eq(salesOrders.id, salesOrderLines.orderId))
      .where(
        and(
          eq(salesOrderLines.workspaceId, ws),
          eq(salesOrders.workspaceId, ws),
          isNull(salesOrderLines.removedAt),
          inArray(
            salesOrderLines.id,
            salesClaims.map((row) => row.orderLineId!),
          ),
        ),
      );
    const byId = new Map(rows.map((row) => [row.line.id, row]));
    const bySource = new Map(lines.map((line) => [line.sourceLineId, line]));
    for (const claim of salesClaims) {
      const current = byId.get(claim.orderLineId!);
      const snapshot = bySource.get(claim.sourceId);
      const changed = !current || !snapshot || current.currency !== currency || !snapshot.priceLocked;
      if (
        changed ||
        (claim.kind === "sales_line"
          ? current.status !== "confirmed" ||
            current.line.quantity !== Number(snapshot.quantity) ||
            current.line.unitPrice !== Number(snapshot.unitPrice)
          : shipmentPrice(Number(claim.quantity), current.line, currency) !== snapshot.net ||
            decimal(shipmentUnitPrice(current.line)) !== snapshot.unitPrice)
      )
        throw invoiceConflict("A sales line changed after drafting. Discard the draft and prepare it again.");
    }
  }
}

function sourceLine(
  description: string,
  unit: string,
  quantity: number,
  unitPrice: number,
  currency: string,
  sourceLineId: string,
  net?: string,
): InvoiceLine {
  return {
    id: newId(),
    description: description.slice(0, 200),
    unit,
    quantity: decimal(quantity),
    unitPrice: decimal(unitPrice),
    taxRate: 0,
    net: net ?? (0).toFixed(currencyDigits(currency)),
    tax: (0).toFixed(currencyDigits(currency)),
    priceLocked: net !== undefined,
    pricePending: net === undefined,
    sourceLineId,
  };
}

const decimal = (n: number) => n.toFixed(8).replace(/\.?0+$/, "");
const scaled = (n: number, places: number) => BigInt(n.toFixed(places).replace(".", ""));

function shipmentUnitPrice(order: typeof salesOrderLines.$inferSelect) {
  return (order.unitPrice * order.quantity) / order.baseQuantity;
}

/** Shipment units are the order's physical base units. Calculate against the original agreed price. */
function shipmentPrice(quantity: number, order: typeof salesOrderLines.$inferSelect, currency: string) {
  const digits = currencyDigits(currency);
  const numerator = scaled(quantity, 4) * scaled(order.quantity, 4) * scaled(order.unitPrice, 8);
  const divisor = scaled(order.baseQuantity, 4) * 10n ** BigInt(12 - digits);
  const minor = (numerator + divisor / 2n) / divisor;
  const value = minor.toString().padStart(digits + 1, "0");
  return digits ? `${value.slice(0, -digits)}.${value.slice(-digits)}` : value;
}

async function shipments(db: Executor, ws: string, filter: { despatchId: string } | { orderId: string }) {
  const byOrder = "orderId" in filter;
  return db
    .select({
      despatch: despatches,
      line: despatchLines,
      fulfilment: salesFulfilments,
      orderLine: salesOrderLines,
      returned: returned(ws),
    })
    .from(despatchLines)
    .innerJoin(despatches, and(eq(despatches.id, despatchLines.despatchId), eq(despatches.workspaceId, ws)))
    .leftJoin(
      salesFulfilments,
      and(
        eq(salesFulfilments.despatchLineId, despatchLines.id),
        eq(salesFulfilments.workspaceId, ws),
        isNull(salesFulfilments.voidedAt),
      ),
    )
    .leftJoin(
      salesOrderLines,
      and(eq(salesOrderLines.id, salesFulfilments.orderLineId), eq(salesOrderLines.workspaceId, ws)),
    )
    .where(
      and(
        eq(despatchLines.workspaceId, ws),
        eq(despatches.status, "confirmed"),
        byOrder ? eq(salesFulfilments.orderId, filter.orderId) : eq(despatches.id, filter.despatchId),
      ),
    )
    .orderBy(asc(despatches.despatchedOn), asc(despatchLines.id));
}

async function billableShipments(
  db: Executor,
  ws: string,
  rows: Awaited<ReturnType<typeof shipments>>,
  currency: string,
) {
  const [billed, direct] = await Promise.all([
    activeClaims(
      db,
      ws,
      "despatch_line",
      rows.map((row) => row.line.id),
    ),
    activeClaims(
      db,
      ws,
      "sales_line",
      rows.flatMap((row) => (row.orderLine ? [row.orderLine.id] : [])),
    ),
  ]);
  const lines: InvoiceLine[] = [];
  const reservations: Claim[] = [];
  for (const row of rows) {
    const quantity = roundQuantity(row.line.quantity - row.returned);
    if (quantity <= 0 || billed.has(row.line.id) || (row.orderLine && direct.has(row.orderLine.id))) continue;
    const order = row.orderLine;
    const price = order ? shipmentUnitPrice(order) : 0;
    lines.push(
      sourceLine(
        row.line.itemName,
        itemBaseUnit({ unit: row.line.itemUnit }),
        quantity,
        price,
        currency,
        row.line.id,
        order ? shipmentPrice(quantity, order, currency) : undefined,
      ),
    );
    reservations.push({
      kind: "despatch_line",
      sourceId: row.line.id,
      orderLineId: row.orderLine?.id,
      quantity: decimal(quantity),
    });
  }
  return { lines, claims: reservations };
}

export async function despatchInvoiceSource(
  db: Executor,
  ws: string,
  id: string,
  currency: string,
): Promise<Source> {
  const [despatch] = await db
    .select()
    .from(despatches)
    .where(and(eq(despatches.workspaceId, ws), eq(despatches.id, id)));
  if (!despatch) throw notFound("Dispatch");
  if (despatch.status !== "confirmed")
    throw invoiceConflict("Confirm the dispatch before drafting an invoice");
  const deliveries = await shipments(db, ws, { despatchId: id });
  const standalone = deliveries.filter((row) => !row.fulfilment);
  const billable = await billableShipments(db, ws, standalone, currency);
  if (!billable.lines.length && deliveries.some((row) => row.fulfilment))
    throw invoiceConflict("Draft an invoice for linked deliveries from the sales order.");
  return {
    customerId: despatch.customerId,
    customer: { name: despatch.customerName, address: despatch.customerAddress },
    currency,
    reference: despatch.reference,
    ...billable,
  };
}

export async function salesInvoiceSource(
  db: Executor,
  ws: string,
  id: string,
  useDespatch: boolean,
): Promise<Source> {
  const [order] = await db
    .select()
    .from(salesOrders)
    .where(and(eq(salesOrders.workspaceId, ws), eq(salesOrders.id, id)));
  if (order?.kind !== "order") throw notFound("Sales order");
  if (!order.confirmedAt || (!useDespatch && order.status !== "confirmed"))
    throw invoiceConflict("Confirm the sales order before drafting an invoice");
  const identity = {
    customerId: order.customerId,
    customer: { name: order.recipient.name, address: order.recipient.address },
    currency: order.currency,
    reference: order.reference,
  };
  if (useDespatch)
    return {
      ...identity,
      ...(await billableShipments(db, ws, await shipments(db, ws, { orderId: id }), order.currency)),
    };

  const lines = await db
    .select()
    .from(salesOrderLines)
    .where(
      and(
        eq(salesOrderLines.workspaceId, ws),
        eq(salesOrderLines.orderId, id),
        isNull(salesOrderLines.removedAt),
      ),
    )
    .orderBy(asc(salesOrderLines.position));
  // Even with Dispatch disabled, an order that has had deliveries cannot switch billing basis.
  const [linked] = await db
    .select({ id: salesFulfilments.id })
    .from(salesFulfilments)
    .where(and(eq(salesFulfilments.workspaceId, ws), eq(salesFulfilments.orderId, id)))
    .limit(1);
  if (linked) throw invoiceConflict("Enable Dispatch to bill this order's deliveries");
  const billed = await activeClaims(
    db,
    ws,
    "sales_line",
    lines.map((line) => line.id),
  );
  const pending = lines.filter((line) => !billed.has(line.id));
  return {
    ...identity,
    lines: pending.map((line) =>
      sourceLine(
        line.itemName,
        line.unit,
        line.quantity,
        line.unitPrice,
        order.currency,
        line.id,
        shipmentPrice(line.baseQuantity, line, order.currency),
      ),
    ),
    claims: pending.map((line) => ({ kind: "sales_line", sourceId: line.id, orderLineId: line.id })),
  };
}

export async function serviceInvoiceSource(db: Executor, ws: string, id: string): Promise<Source> {
  const [quote] = await db
    .select()
    .from(serviceQuotes)
    .where(and(eq(serviceQuotes.workspaceId, ws), eq(serviceQuotes.id, id)));
  if (!quote) throw notFound("Service quote");
  if (quote.status !== "delivered")
    throw invoiceConflict("Record client sign-off before drafting an invoice");
  if ((await activeClaims(db, ws, "service", [id])).size)
    throw invoiceConflict("This service quote already has an active invoice");
  const description =
    quote.approvedMinutes === null
      ? quote.title
      : `${quote.title} (${quote.approvedMinutes} approved minutes)`;
  return {
    customerId: quote.customerId,
    customer: { name: quote.recipient.name, address: quote.recipient.address },
    currency: quote.currency,
    reference: quote.reference,
    lines: [
      sourceLine(
        description,
        quote.approvedMinutes === null ? "fixed fee" : "hour",
        quote.approvedMinutes === null ? 1 : quote.approvedMinutes / 60,
        quote.unitPrice,
        quote.currency,
        id,
        serviceQuoteAmount(quote.unitPrice, quote.approvedMinutes, quote.currency),
      ),
    ],
    claims: [{ kind: "service", sourceId: id }],
  };
}
