import {
  newId,
  purchaseOrderCancelSchema,
  purchaseOrderCloseSchema,
  purchaseOrderSendSchema,
  purchaseOrderReference,
  purchaseReceiptMovementReference,
  stockAmount,
  toBaseQuantity,
  type UnitCode,
} from "@knotworking/core";
import type { Hono } from "hono";
import type { mountFakeItems } from "./fake-items";
import type { mountFakeStock } from "./fake-stock";

/** In-memory stand-in for the Purchasing module's routes (apps/server/src/routes/purchasing.ts). */
export function mountFakePurchasing(
  app: Hono,
  ws: string,
  deps: { items: ReturnType<typeof mountFakeItems>; stock: ReturnType<typeof mountFakeStock> },
) {
  const err = (code: string, message: string, details?: unknown) => ({ error: { code, message, details } });
  const today = "2026-11-11";
  const now = "2026-11-11T09:00:00.000Z";
  const orders: Record<string, any>[] = [];
  const lines: Record<string, any>[] = [];
  const receipts: Record<string, any>[] = [];
  /** Tests set these: what `GET /purchasing/suggestions` and `…/supplier-performance` answer. */
  const state = {
    productionAvailable: true,
    /** Off: stock lines answer `404 module_inactive`, as when the stock module is switched off. */
    stockActive: true,
    suggestions: { groups: [] as unknown[], covered: [] as unknown[], notPurchasable: [] as unknown[] },
    performance: [] as unknown[],
    /** Supplier price list entries (`GET /purchasing/prices`), as the API returns them. */
    prices: [] as Record<string, any>[],
    /** Set to make the mail server fail (the order email then answers `emailed: false`). */
    mailError: null as string | null,
  };
  /** The order email log, newest first, like `order.emails`. */
  const emails: Record<string, any>[] = [];

  const itemOf = (id: string): any => deps.items.items.find((i) => i.id === id);
  const supplierOf = (id: string): any => deps.items.suppliers.find((s) => s.id === id);
  const supplierSummary = (id: string) => {
    const s = supplierOf(id);
    return { id: s.id, name: s.name, code: s.code, approvalStatus: s.approvalStatus };
  };
  const itemSummary = (i: any) => ({
    id: i.id,
    code: i.code,
    name: i.name,
    type: i.type,
    unit: i.unit,
    status: i.status,
  });
  /** A base quantity as a line amount: also in the line's own unit. */
  const amount = (base: number, item: any, unit: UnitCode) => ({
    ...stockAmount(base, item),
    inLineUnit: toDisplay(base, unit, item),
  });
  /** A line's quantity: stock lines as `amount`, non-stock lines as entered in their own unit. */
  const lineAmount = (q: number, line: Record<string, any>) =>
    line.kind === "non_stock"
      ? { base: q, baseUnit: null, display: q, displayUnit: line.unitLabel, inLineUnit: q }
      : amount(q, itemOf(line.itemId), line.unit);
  const toDisplay = (base: number, unit: UnitCode, item: any) => {
    const factor = toBaseQuantity(1, unit, item);
    return factor ? Math.round((base / factor) * 10000) / 10000 : null;
  };

  const linesOf = (orderId: string) =>
    lines.filter((l) => l.purchaseOrderId === orderId).sort((a, b) => a.lineNo - b.lineNo);
  const receivedOn = (lineId: string, outcome: string) =>
    receipts
      .filter((r) => r.lineId === lineId && r.outcome === outcome)
      .reduce((sum, r) => sum + r.quantity, 0);

  const lineView = (order: Record<string, any>, l: Record<string, any>) => {
    const item = l.itemId ? itemOf(l.itemId) : null;
    const received = receivedOn(l.id, "accepted");
    const rejected = receivedOn(l.id, "rejected");
    const outstanding = Math.max(l.quantity - received, 0);
    return {
      ...l,
      item: item ? itemSummary(item) : null,
      effectiveExpectedOn: l.expectedOn ?? order.expectedOn,
      promiseMoved: l.promisedOn != null && l.promisedOn !== (l.expectedOn ?? order.expectedOn),
      ordered: lineAmount(l.quantity, l),
      received: lineAmount(received, l),
      rejected: lineAmount(rejected, l),
      outstanding: lineAmount(outstanding, l),
      state:
        received === 0
          ? "none"
          : received < l.quantity
            ? "partial"
            : received === l.quantity
              ? "full"
              : "over",
      lineValue:
        l.unitPrice == null
          ? null
          : (l.kind === "non_stock" ? l.quantity : (toDisplay(l.quantity, l.unit, item) ?? 0)) * l.unitPrice,
      hasReceipts: receipts.some((r) => r.lineId === l.id),
      overdue: false,
      supplierListed: item ? item.supplierIds.includes(order.supplierId) : false,
    };
  };
  const summary = (order: Record<string, any>): Record<string, any> => {
    const views = linesOf(order.id).map((l) => lineView(order, l));
    const derived =
      order.status !== "sent"
        ? order.status
        : views.length && views.every((l) => l.state === "full" || l.state === "over")
          ? "received"
          : views.some((l) => l.state !== "none")
            ? "part_received"
            : "sent";
    const location = deps.stock.locations.find((l) => l.id === order.deliveryLocationId);
    return {
      ...order,
      state: derived,
      supplier: supplierSummary(order.supplierId),
      deliveryLocation: location
        ? { id: location.id, name: location.name, code: location.code, status: location.status }
        : null,
      nextExpectedOn:
        views
          .map((l) => l.effectiveExpectedOn)
          .filter(Boolean)
          .sort()[0] ?? order.expectedOn,
      linesCount: views.length,
      receivedLines: views.filter((l) => l.state === "full" || l.state === "over").length,
      outstandingLines: views.filter((l) => l.outstanding.base > 0).length,
      value: views.reduce((sum, l) => sum + (l.lineValue ?? 0), 0),
      valueComplete: views.every((l) => l.lineValue != null),
      overdue: false,
    };
  };
  const detail = (order: Record<string, any>) => {
    const deliveries = new Map<string, Record<string, any>>();
    for (const r of receipts.filter(
      (x) => lines.find((l) => l.id === x.lineId)?.purchaseOrderId === order.id,
    )) {
      const line = lines.find((l) => l.id === r.lineId)!;
      const item = line.itemId ? itemOf(line.itemId) : null;
      const delivery = deliveries.get(r.deliveryId) ?? {
        deliveryId: r.deliveryId,
        receivedOn: r.receivedOn,
        deliveryReference: r.deliveryReference,
        notes: null,
        actorId: null,
        actorName: "Ada Lovelace",
        createdAt: now,
        receipts: [],
      };
      delivery.receipts.push({
        ...r,
        lineNo: line.lineNo,
        kind: line.kind,
        item: item ? itemSummary(item) : null,
        quantity: lineAmount(r.quantity, line),
        reversed: false,
      });
      deliveries.set(r.deliveryId, delivery);
    }
    return {
      ...summary(order),
      createdByName: "Ada Lovelace",
      emails: order.emails ?? [],
      sentByName: order.sentAt ? "Ada Lovelace" : null,
      closedByName: null,
      cancelledByName: null,
      lines: linesOf(order.id).map((l) => lineView(order, l)),
      deliveries: [...deliveries.values()],
    };
  };

  /** Shared by create and edit: checks the supplier and each line, `null` when fine. */
  const checkSupplier = (supplierId: string) => {
    const s = supplierOf(supplierId);
    if (!s) return ["not_found", "Supplier not found", 404] as const;
    return null;
  };
  const checkLine = (l: Record<string, any>) => {
    if (l.kind === "non_stock") {
      if (!l.description) return ["invalid_input", "A non-stock line needs a description", 400] as const;
      if (l.itemId && !itemOf(l.itemId)) return ["not_found", "Item not found", 404] as const;
      return null;
    }
    if (!state.stockActive) return ["module_inactive", "The stock module is not enabled", 404] as const;
    const item = itemOf(l.itemId);
    if (!item) return ["not_found", "Item not found", 404] as const;
    if (item.type !== "ingredient" && item.type !== "packaging")
      return ["item_not_purchasable", `${item.name} is not an ingredient or packaging`, 409] as const;
    if (item.status !== "active") return ["item_archived", `${item.name} is archived`, 409] as const;
    if (toBaseQuantity(l.quantity, l.unit, item) === null)
      return ["unit_not_convertible", "Can't convert that unit", 400] as const;
    return null;
  };
  const newLine = (
    orderId: string,
    lineNo: number,
    input: Record<string, any>,
    keep?: Record<string, any>,
  ) => {
    if (input.kind === "non_stock")
      return {
        id: keep?.id ?? newId(),
        purchaseOrderId: orderId,
        lineNo,
        kind: "non_stock",
        itemId: input.itemId ?? null,
        description: input.description,
        quantity: input.quantity,
        unit: null,
        unitLabel: input.unit ?? null,
        nominalCode: input.nominalCode ?? null,
        unitPrice: input.unitPrice !== undefined ? input.unitPrice : keep ? keep.unitPrice : null,
        expectedOn: input.expectedOn !== undefined ? input.expectedOn : (keep?.expectedOn ?? null),
        promisedOn: keep ? keep.promisedOn : null,
        notes: input.notes !== undefined ? input.notes : (keep?.notes ?? null),
        createdAt: now,
        updatedAt: now,
      };
    const item = itemOf(input.itemId);
    const unit = input.unit as UnitCode;
    const defaultPrice =
      item.standardCost == null
        ? null
        : (item.standardCost * (toBaseQuantity(1, unit, item) ?? 1)) /
          (toBaseQuantity(1, item.unit, item) ?? 1);
    return {
      id: keep?.id ?? newId(),
      purchaseOrderId: orderId,
      lineNo,
      kind: "stock",
      itemId: input.itemId,
      description: null,
      quantity: toBaseQuantity(input.quantity, unit, item)!,
      unit,
      unitLabel: null,
      nominalCode: null,
      unitPrice: input.unitPrice !== undefined ? input.unitPrice : keep ? keep.unitPrice : defaultPrice,
      expectedOn: input.expectedOn !== undefined ? input.expectedOn : (keep?.expectedOn ?? null),
      promisedOn: keep ? keep.promisedOn : null,
      notes: input.notes !== undefined ? input.notes : (keep?.notes ?? null),
      createdAt: now,
      updatedAt: now,
    };
  };

  app.get(`${ws}/purchasing/orders`, (c) => {
    const q = c.req.query();
    const status = q.status ?? "all";
    const text = q.q?.toLowerCase();
    const found = orders
      .map(summary)
      .filter(
        (o) =>
          (status === "all" ||
            (status === "open" ? o.state === "sent" || o.state === "part_received" : o.state === status)) &&
          (!q.supplierId || o.supplierId === q.supplierId) &&
          (!q.itemId || linesOf(o.id).some((l) => l.itemId === q.itemId)) &&
          (!text || o.reference.toLowerCase().includes(text) || o.supplier.name.toLowerCase().includes(text)),
      )
      .reverse();
    return c.json({ orders: found, total: found.length, limit: Number(q.limit ?? 100), offset: 0 });
  });
  app.get(`${ws}/purchasing/orders/:id`, (c) => {
    const found = orders.find((o) => o.id === c.req.param("id"));
    return found ? c.json(detail(found)) : c.json(err("not_found", "Order not found"), 404);
  });

  app.post(`${ws}/purchasing/orders`, async (c) => {
    const body = await c.req.json();
    const bad = checkSupplier(body.supplierId);
    if (bad) return c.json(err(bad[0], bad[1]), bad[2]);
    if (supplierOf(body.supplierId).approvalStatus === "suspended")
      return c.json(err("supplier_not_approved", "That supplier is suspended"), 409);
    for (const l of body.lines ?? []) {
      const lineBad = checkLine(l);
      if (lineBad) return c.json(err(lineBad[0], lineBad[1]), lineBad[2]);
    }
    const id = newId();
    const order = {
      id,
      reference: purchaseOrderReference(today, orders.length + 1),
      supplierId: body.supplierId,
      status: "draft",
      orderedOn: null,
      expectedOn: body.expectedOn ?? null,
      deliveryLocationId: body.deliveryLocationId ?? null,
      supplierReference: body.supplierReference ?? null,
      notes: body.notes ?? null,
      sentAt: null,
      sentBy: null,
      closedAt: null,
      closeReason: null,
      cancelledAt: null,
      cancelReason: null,
      createdAt: now,
      updatedAt: now,
    };
    orders.push(order);
    (body.lines ?? []).forEach((l: Record<string, any>, i: number) => lines.push(newLine(id, i + 1, l)));
    return c.json(detail(order), 201);
  });

  app.patch(`${ws}/purchasing/orders/:id`, async (c) => {
    const order = orders.find((o) => o.id === c.req.param("id"));
    if (!order) return c.json(err("not_found", "Order not found"), 404);
    if (order.status === "closed" || order.status === "cancelled")
      return c.json(err("order_closed", "This order is closed"), 409);
    const body = await c.req.json();
    if (body.supplierId !== undefined && body.supplierId !== order.supplierId) {
      if (order.status !== "draft")
        return c.json(err("not_draft", "The supplier can't change once sent"), 409);
      const bad = checkSupplier(body.supplierId);
      if (bad) return c.json(err(bad[0], bad[1]), bad[2]);
    }
    if (body.lines) {
      const existing = linesOf(order.id);
      const next: Record<string, any>[] = [];
      for (const [i, input] of (body.lines as Record<string, any>[]).entries()) {
        const keep = input.id ? existing.find((l) => l.id === input.id) : undefined;
        if (input.id && !keep) return c.json(err("invalid_input", "A line id isn't on this order"), 400);
        const bad = checkLine(input);
        if (bad) return c.json(err(bad[0], bad[1]), bad[2]);
        const line = newLine(order.id, i + 1, input, keep);
        // A line added to a sent order is promised its effective date.
        if (!keep && order.status === "sent")
          line.promisedOn = line.expectedOn ?? body.expectedOn ?? order.expectedOn;
        if (keep && line.quantity < receivedOn(keep.id, "accepted"))
          return c.json(err("below_received", "Below what was already accepted"), 409);
        next.push(line);
      }
      const removed = existing.filter((l) => !next.some((n) => n.id === l.id));
      if (removed.some((l) => receipts.some((r) => r.lineId === l.id)))
        return c.json(err("line_has_receipts", "A line with receipts can't be removed"), 409);
      for (const l of existing) lines.splice(lines.indexOf(l), 1);
      lines.push(...next);
    }
    const { lines: _lines, ...header } = body;
    Object.assign(order, header);
    return c.json(detail(order));
  });

  app.post(`${ws}/purchasing/orders/:id/receipts`, async (c) => {
    const order = orders.find((o) => o.id === c.req.param("id"));
    if (!order) return c.json(err("not_found", "Order not found"), 404);
    if (order.status !== "sent") return c.json(err("order_not_open", "This order isn't open"), 409);
    const body = await c.req.json();
    const supplier = supplierOf(order.supplierId);
    const rows: Record<string, any>[] = [];
    for (const input of body.lines as Record<string, any>[]) {
      const line = lines.find((l) => l.id === input.lineId && l.purchaseOrderId === order.id);
      if (!line) return c.json(err("invalid_input", "A line isn't on this order"), 400);
      if (line.kind === "non_stock") {
        if (input.unit !== undefined || input.locationId !== undefined)
          return c.json(err("invalid_input", "A non-stock line has no unit or location"), 400);
        rows.push({ input, line, item: line.itemId ? itemOf(line.itemId) : null, quantity: input.quantity });
        continue;
      }
      if (!state.stockActive) return c.json(err("module_inactive", "The stock module is not enabled"), 404);
      const item = itemOf(line.itemId);
      const quantity = toBaseQuantity(input.quantity, input.unit ?? line.unit, item);
      if (quantity === null) return c.json(err("unit_not_convertible", "Can't convert that unit"), 400);
      if (input.outcome === "accepted") {
        if (!deps.stock.locations.some((l) => l.id === (input.locationId ?? order.deliveryLocationId)))
          return c.json(err("not_found", "Location not found"), 404);
        if (supplier.approvalStatus === "pending" && input.status !== "quarantine")
          return c.json(
            err("supplier_not_approved", `${supplier.name} is not approved yet; receive into quarantine`),
            409,
          );
      }
      rows.push({ input, line, item, quantity });
    }
    const deliveryId = newId();
    const reference = purchaseReceiptMovementReference(order.reference, body.deliveryReference ?? null);
    const created = rows.map(({ input, line, item, quantity }) => {
      let lot: Record<string, any> | null = null;
      let movementId: string | null = null;
      if (input.outcome === "accepted" && line.kind !== "non_stock") {
        lot = {
          id: newId(),
          itemId: item.id,
          lotCode: input.lotCode ?? `L261111-${String(deps.stock.lots.length + 1).padStart(3, "0")}`,
          supplierId: order.supplierId,
          supplierLotCode: input.supplierLotCode ?? null,
          receivedOn: body.receivedOn,
          expiresOn: input.expiresOn ?? null,
          expiryType: input.expiryType ?? null,
          status: input.status ?? "available",
          createdAt: now,
          updatedAt: now,
        };
        deps.stock.lots.push(lot);
        movementId = newId();
        deps.stock.movements.push({
          id: movementId,
          lotId: lot.id,
          itemId: item.id,
          locationId: input.locationId ?? order.deliveryLocationId,
          quantity,
          type: "receipt",
          reference,
          transferId: null,
          reversesMovementId: null,
          reason: null,
          actorId: null,
          occurredAt: now,
          createdAt: now,
        });
      }
      const row = {
        id: newId(),
        deliveryId,
        lineId: line.id,
        outcome: input.outcome,
        quantity,
        unitPrice: input.unitPrice ?? null,
        lotId: lot?.id ?? null,
        lotCode: lot?.lotCode ?? null,
        stockMovementId: movementId,
        reason: input.reason ?? null,
        receivedOn: body.receivedOn,
        deliveryReference: body.deliveryReference ?? null,
      };
      receipts.push(row);
      return {
        id: row.id,
        lineId: line.id,
        kind: line.kind,
        item: item ? itemSummary(item) : null,
        outcome: row.outcome,
        quantity: lineAmount(quantity, line),
        unitPrice: row.unitPrice,
        lotId: row.lotId,
        lotCode: row.lotCode,
        stockMovementId: movementId,
        reason: row.reason,
      };
    });
    return c.json({ deliveryId, receipts: created, order: detail(order) }, 201);
  });

  app.get(`${ws}/purchasing/suggestions`, (c) => {
    if (!state.productionAvailable)
      return c.json(err("production_unavailable", "Suggestions need the production module"), 409);
    return c.json({
      from: c.req.query("from") ?? today,
      to: c.req.query("to") ?? "2026-12-09",
      ...state.suggestions,
    });
  });

  app.get(`${ws}/purchasing/supplier-performance`, (c) =>
    c.json({
      from: c.req.query("from") ?? "2026-08-13",
      to: c.req.query("to") ?? today,
      suppliers: (state.performance as { supplier: { id: string } }[]).filter(
        (s) => !c.req.query("supplierId") || s.supplier.id === c.req.query("supplierId"),
      ),
    }),
  );

  app.get(`${ws}/purchasing/prices`, (c) => {
    const { supplierId, itemId, on } = c.req.query();
    const prices = state.prices.filter(
      (r) =>
        (!supplierId || r.supplier.id === supplierId) &&
        (!itemId || r.item.id === itemId) &&
        (!on || (r.effectiveFrom <= on && (r.effectiveTo === null || r.effectiveTo >= on))),
    );
    return c.json({ prices, total: prices.length, limit: 100, offset: 0 });
  });

  app.post(`${ws}/purchasing/orders/:id/email`, async (c) => {
    const order = orders.find((o) => o.id === c.req.param("id"));
    if (!order) return c.json(err("not_found", "Order not found"), 404);
    if (order.status !== "sent")
      return c.json(
        err("order_not_sent", `${order.reference} is not sent; only a sent order is emailed`),
        409,
      );
    const body = (await c.req.json()) as { to?: string; message?: string | null };
    const to = body.to ?? supplierOf(order.supplierId).email ?? "";
    if (!to)
      return c.json(
        err("no_supplier_email", "The supplier has no email address in the register; give one"),
        400,
      );
    const entry = {
      id: newId(),
      toEmail: to,
      subject: `Purchase order ${order.reference}`,
      status: state.mailError ? "failed" : "sent",
      error: state.mailError,
      createdAt: now,
    };
    emails.unshift(entry);
    order.emails = [...emails];
    return c.json({
      emailed: !state.mailError,
      ...(state.mailError ? { mailError: state.mailError } : {}),
      to,
      email: entry,
      order: detail(order),
    });
  });

  /** Marks an order as sent, as a person would in the app (a test helper; the send_purchase_order tool goes through the API route below). */
  const send = (id: string) => {
    const order = orders.find((o) => o.id === id)!;
    order.status = "sent";
    order.orderedOn = today;
    order.sentAt = now;
    for (const l of linesOf(id)) l.promisedOn = l.expectedOn ?? order.expectedOn;
  };

  /** The three toggleable transitions (the fake API gates them on the enabled token actions). */
  const transition = (
    path: string,
    schema: typeof purchaseOrderSendSchema | typeof purchaseOrderCloseSchema,
  ) =>
    app.post(`${ws}/purchasing/orders/:id/${path}`, async (c) => {
      const order = orders.find((o) => o.id === c.req.param("id"));
      if (!order) return c.json(err("not_found", "Order not found"), 404);
      const parsed = schema.safeParse(await c.req.json());
      if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
      const input = parsed.data as Record<string, any>;
      if (path === "send") {
        if (order.status !== "draft")
          return c.json(err("not_draft", `${order.reference} has already been sent`), 409);
        if (!linesOf(order.id).length)
          return c.json(err("not_sendable", `${order.reference} has no lines`), 409);
        if (supplierOf(order.supplierId).approvalStatus === "suspended")
          return c.json(err("supplier_not_approved", "That supplier is suspended"), 409);
        send(order.id);
        if (input.orderedOn) order.orderedOn = input.orderedOn;
        if (input.supplierReference !== undefined) order.supplierReference = input.supplierReference;
      } else if (path === "close") {
        if (order.status !== "sent")
          return c.json(err("order_not_open", `${order.reference} is not open`), 409);
        Object.assign(order, { status: "closed", closedAt: now, closeReason: input.reason });
      } else {
        if (order.status === "closed" || order.status === "cancelled")
          return c.json(err("order_closed", `${order.reference} is already ${order.status}`), 409);
        if (
          receipts.some((r) => r.outcome === "accepted" && linesOf(order.id).some((l) => l.id === r.lineId))
        )
          return c.json(err("has_receipts", "Goods have been received; close it instead"), 409);
        Object.assign(order, { status: "cancelled", cancelledAt: now, cancelReason: input.reason });
      }
      return c.json(detail(order));
    });
  transition("send", purchaseOrderSendSchema);
  transition("close", purchaseOrderCloseSchema);
  transition("cancel", purchaseOrderCancelSchema);

  return { orders, lines, receipts, state, send, supplierSummary, itemSummary, stockAmount };
}
