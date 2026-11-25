import {
  defaultInvoiceTolerances,
  invoiceLineValue,
  matchInvoiceLine,
  newId,
  purchaseInvoiceCreateSchema,
  purchaseInvoiceTotals,
  purchaseInvoiceUpdateSchema,
  toBaseQuantity,
  worstMatchStatus,
  type InvoiceMatchStatus,
} from "@knotworking/core";
import type { Hono } from "hono";
import type { mountFakePurchasing } from "./fake-purchasing";

/**
 * In-memory stand-in for the supplier invoice routes (apps/server/src/routes/purchase-invoices.ts):
 * drafts, edits and revisions, matched with the core three-way match and default tolerances.
 * `approve` is a test helper (a person approves in the app; there is no tool).
 */
export function mountFakePurchaseInvoices(
  app: Hono,
  ws: string,
  purchasing: ReturnType<typeof mountFakePurchasing>,
) {
  const err = (code: string, message: string, details?: unknown) => ({
    error: { code, message, ...(details ? { details } : {}) },
  });
  const now = "2026-11-11T09:00:00.000Z";
  const invoices: Record<string, any>[] = [];
  const invoiceLines: Record<string, any>[] = [];

  const linesOf = (id: string) =>
    invoiceLines.filter((l) => l.invoiceId === id).sort((a, b) => a.lineNo - b.lineNo);
  const orderLineOf = (id: string) => purchasing.lines.find((l) => l.id === id);
  const orderOf = (id: string) => purchasing.orders.find((o) => o.id === id);

  const detail = (invoice: Record<string, any>) => {
    const lines = linesOf(invoice.id).map((l): Record<string, any> => {
      const base: Record<string, any> = { ...l, value: invoiceLineValue(l.quantity, l.unitPrice) };
      if (l.kind !== "order")
        return {
          ...base,
          item: null,
          orderLine: null,
          received: null,
          invoicedElsewhere: null,
          match: null,
          now: null,
        };
      const ol = orderLineOf(l.orderLineId)!;
      const order = orderOf(ol.purchaseOrderId)!;
      const item = purchasing.itemSummary(
        // The items module's row (unit conversions need it).
        { id: ol.itemId, code: "", name: "", type: "", unit: ol.unit, status: "active" },
      );
      const factor = ol.kind === "non_stock" ? 1 : (toBaseQuantity(1, ol.unit, { unit: ol.unit }) ?? 1);
      const receivedBase = purchasing.receipts
        .filter((r) => r.lineId === ol.id && r.outcome === "accepted")
        .reduce((s, r) => s + r.quantity, 0);
      const elsewhere = invoiceLines
        .filter(
          (x) =>
            x.orderLineId === ol.id &&
            x.invoiceId !== invoice.id &&
            invoices.find((i) => i.id === x.invoiceId)?.status === "approved",
        )
        .reduce((s, x) => s + x.quantity, 0);
      const received = receivedBase / factor;
      return {
        ...base,
        item,
        orderLine: {
          id: ol.id,
          lineNo: ol.lineNo,
          purchaseOrderId: order.id,
          reference: order.reference,
          orderStatus: order.status,
          kind: ol.kind ?? "stock",
          description: ol.description ?? null,
          unitLabel: ol.unitLabel ?? null,
          nominalCode: ol.nominalCode ?? null,
          quantity: ol.quantity / factor,
          unitPrice: ol.unitPrice,
          removed: false,
        },
        received,
        invoicedElsewhere: elsewhere,
        now: null,
        match: matchInvoiceLine({
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          orderUnitPrice: ol.unitPrice,
          received,
          invoicedElsewhere: elsewhere,
        }),
      };
    });
    const totals = purchaseInvoiceTotals(lines as { quantity: number; unitPrice: number }[], invoice.vat);
    const statuses = lines.flatMap((l) => (l.match ? [l.match.status as InvoiceMatchStatus] : []));
    return {
      ...invoice,
      supplier: purchasing.supplierSummary(invoice.supplierId),
      net: totals.net,
      gross: totals.gross,
      linesCount: lines.length,
      matchStatus: worstMatchStatus(statuses),
      matchStatusNow: worstMatchStatus(statuses),
      mismatchedLines: statuses.filter((s) => s === "mismatch").length,
      orders: [
        ...new Map(
          lines.flatMap((l) =>
            l.orderLine
              ? [
                  [
                    l.orderLine.purchaseOrderId,
                    { id: l.orderLine.purchaseOrderId, reference: l.orderLine.reference },
                  ],
                ]
              : [],
          ),
        ).values(),
      ],
      tolerances: defaultInvoiceTolerances,
      createdByName: "Ada",
      approvedByName: invoice.approvedAt ? "Ada" : null,
      lines,
      versions: invoices
        .filter((i) => i.supplierId === invoice.supplierId && i.invoiceNumber === invoice.invoiceNumber)
        .map((i) => ({ id: i.id, version: i.version, status: i.status, approvedAt: i.approvedAt })),
    };
  };

  const setLines = (invoice: Record<string, any>, input: Record<string, any>[]) => {
    for (const [i, l] of input.entries()) {
      if (l.kind !== "order") continue;
      const ol = orderLineOf(l.orderLineId);
      if (!ol) return [err("not_found", "Purchase order line not found"), 404] as const;
      const order = orderOf(ol.purchaseOrderId)!;
      if (order.supplierId !== invoice.supplierId)
        return [
          err("wrong_supplier", `Line ${i + 1}: ${order.reference} is with another supplier`),
          409,
        ] as const;
      if (order.status !== "sent" && order.status !== "closed")
        return [
          err("order_not_invoiceable", `Line ${i + 1}: ${order.reference} is ${order.status}`),
          409,
        ] as const;
    }
    for (const l of linesOf(invoice.id)) invoiceLines.splice(invoiceLines.indexOf(l), 1);
    input.forEach((l, i) => {
      const ol = l.kind === "order" ? orderLineOf(l.orderLineId) : undefined;
      invoiceLines.push({
        id: newId(),
        invoiceId: invoice.id,
        lineNo: i + 1,
        kind: l.kind,
        orderLineId: ol?.id ?? null,
        purchaseOrderId: ol?.purchaseOrderId ?? null,
        itemId: ol?.itemId ?? null,
        quantity: l.quantity,
        unit: ol?.unit ?? null,
        unitPrice: l.unitPrice,
        description: l.description ?? null,
      });
    });
    return null;
  };

  app.get(`${ws}/purchasing/invoices`, (c) => {
    const q = c.req.query();
    const status = q.status ?? "current";
    const text = q.q?.toLowerCase();
    const found = invoices
      .filter(
        (i) =>
          (status === "all" || (status === "current" ? i.status !== "superseded" : i.status === status)) &&
          (!q.supplierId || i.supplierId === q.supplierId) &&
          (!text || i.invoiceNumber.toLowerCase().includes(text)) &&
          (!q.purchaseOrderId || linesOf(i.id).some((l) => l.purchaseOrderId === q.purchaseOrderId)),
      )
      .map(detail)
      .reverse();
    return c.json({ invoices: found, total: found.length, limit: Number(q.limit ?? 100), offset: 0 });
  });
  app.get(`${ws}/purchasing/invoices/:id`, (c) => {
    const found = invoices.find((i) => i.id === c.req.param("id"));
    return found ? c.json(detail(found)) : c.json(err("not_found", "Invoice not found"), 404);
  });
  app.post(`${ws}/purchasing/invoices`, async (c) => {
    const parsed = purchaseInvoiceCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const body = parsed.data;
    if (
      invoices.some(
        (i) =>
          i.supplierId === body.supplierId &&
          i.invoiceNumber.toLowerCase() === body.invoiceNumber.toLowerCase(),
      )
    )
      return c.json(err("duplicate_invoice_number", "This supplier already has that invoice number"), 409);
    const invoice: Record<string, any> = {
      id: newId(),
      supplierId: body.supplierId,
      invoiceNumber: body.invoiceNumber,
      version: 1,
      supersedesId: null,
      status: "draft",
      invoiceDate: body.invoiceDate,
      dueDate: body.dueDate ?? null,
      vat: body.vat,
      notes: body.notes ?? null,
      approvedAt: null,
      approvedMatchStatus: null,
      approvalReason: null,
      supersededAt: null,
      supersededById: null,
      createdAt: now,
      updatedAt: now,
    };
    const bad = setLines(invoice, body.lines);
    if (bad) return c.json(bad[0], bad[1]);
    invoices.push(invoice);
    return c.json(detail(invoice), 201);
  });
  app.patch(`${ws}/purchasing/invoices/:id`, async (c) => {
    const invoice = invoices.find((i) => i.id === c.req.param("id"));
    if (!invoice) return c.json(err("not_found", "Invoice not found"), 404);
    if (invoice.status !== "draft")
      return c.json(err("invoice_not_draft", "Approved invoices can't change"), 409);
    const parsed = purchaseInvoiceUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const { lines, ...header } = parsed.data;
    if (lines) {
      const bad = setLines(invoice, lines);
      if (bad) return c.json(bad[0], bad[1]);
    }
    Object.assign(invoice, header);
    return c.json(detail(invoice));
  });
  app.delete(`${ws}/purchasing/invoices/:id`, (c) => {
    const index = invoices.findIndex((i) => i.id === c.req.param("id"));
    if (index < 0) return c.json(err("not_found", "Invoice not found"), 404);
    if (invoices[index]!.status !== "draft")
      return c.json(err("invoice_not_draft", "Only drafts are deleted"), 409);
    const [gone] = invoices.splice(index, 1);
    for (let i = invoiceLines.length - 1; i >= 0; i--)
      if (invoiceLines[i]!.invoiceId === gone!.id) invoiceLines.splice(i, 1);
    return c.body(null, 204);
  });
  app.post(`${ws}/purchasing/invoices/:id/revise`, (c) => {
    const prior = invoices.find((i) => i.id === c.req.param("id"));
    if (!prior) return c.json(err("not_found", "Invoice not found"), 404);
    if (prior.status !== "approved")
      return c.json(err("invoice_not_approved", "Only approved invoices are revised"), 409);
    const pending = invoices.find((i) => i.supersedesId === prior.id && i.status === "draft");
    if (pending)
      return c.json(
        err("revision_exists", "A revision of this invoice is already being drafted", {
          invoiceId: pending.id,
        }),
        409,
      );
    const invoice = {
      ...prior,
      id: newId(),
      version: prior.version + 1,
      supersedesId: prior.id,
      status: "draft",
      approvedAt: null,
      approvedMatchStatus: null,
      approvalReason: null,
    };
    invoices.push(invoice);
    for (const l of linesOf(prior.id)) invoiceLines.push({ ...l, id: newId(), invoiceId: invoice.id });
    return c.json(detail(invoice), 201);
  });

  app.delete(`${ws}/purchasing/invoices/:id`, (c) => {
    const invoice = invoices.find((i) => i.id === c.req.param("id"));
    if (!invoice) return c.json(err("not_found", "Invoice not found"), 404);
    if (invoice.status !== "draft")
      return c.json(err("invoice_not_draft", "Approved invoices can't change"), 409);
    for (const l of linesOf(invoice.id)) invoiceLines.splice(invoiceLines.indexOf(l), 1);
    invoices.splice(invoices.indexOf(invoice), 1);
    return c.body(null, 204);
  });

  /** Approves an invoice as a person would in the app (a test helper). */
  const approve = (id: string) => {
    const invoice = invoices.find((i) => i.id === id)!;
    Object.assign(invoice, {
      status: "approved",
      approvedAt: now,
      approvedMatchStatus: detail(invoice).matchStatus,
    });
  };

  return { invoices, invoiceLines, approve };
}
