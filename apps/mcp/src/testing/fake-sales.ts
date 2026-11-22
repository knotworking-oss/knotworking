import {
  newId,
  salesCreateSchema,
  salesListSchema,
  salesPageSchema,
  salesSaveSchema,
  salesCommitmentsSchema,
} from "@knotworking/core";
import type { Hono } from "hono";
/** Transport/schema stand-in only; real API tests cover ownership, locks, prices and despatches. */
export function mountFakeSales(app: Hono, ws: string) {
  const orders: Record<string, any>[] = [];
  const err = (code: string) => ({ error: { code, message: code } });
  app.get(`${ws}/sales/orders`, (c) => {
    const p = salesListSchema.safeParse(c.req.query());
    if (!p.success) return c.json(err("invalid_input"), 400);
    const q = p.data;
    const rows = orders.filter(
      (r) =>
        (!q.kind || r.kind === q.kind) &&
        (!q.status || r.status === q.status) &&
        (!q.customerId || r.customerId === q.customerId),
    );
    return c.json({
      orders: rows.slice(q.offset, q.offset + q.limit),
      total: rows.length,
      limit: q.limit,
      offset: q.offset,
    });
  });
  app.post(`${ws}/sales/orders`, async (c) => {
    const p = salesCreateSchema.safeParse(await c.req.json());
    if (!p.success) return c.json(err("invalid_input"), 400);
    const row = { id: newId(), revision: 1, status: "draft", kind: p.data.kind, ...p.data.document };
    orders.push(row);
    return c.json(row, 201);
  });
  app.get(`${ws}/sales/orders/:id`, (c) => {
    const row = orders.find((r) => r.id === c.req.param("id"));
    return row ? c.json(row) : c.json(err("not_found"), 404);
  });
  app.put(`${ws}/sales/orders/:id`, async (c) => {
    const row = orders.find((r) => r.id === c.req.param("id"));
    if (!row) return c.json(err("not_found"), 404);
    const p = salesSaveSchema.safeParse(await c.req.json());
    if (!p.success) return c.json(err("invalid_input"), 400);
    if (p.data.expectedRevision !== row.revision || row.status !== "draft")
      return c.json(err("sales_conflict"), 409);
    Object.assign(row, p.data.document, { revision: row.revision + 1 });
    return c.json(row);
  });
  app.get(`${ws}/sales/orders/:id/history`, (c) => {
    const q = salesPageSchema.parse(c.req.query());
    if (!orders.some((r) => r.id === c.req.param("id"))) return c.json(err("not_found"), 404);
    return c.json({ events: [], total: 0, ...q });
  });
  app.get(`${ws}/sales/prices`, (c) =>
    c.json({ prices: [], total: 0, ...salesPageSchema.parse(c.req.query()) }),
  );
  app.get(`${ws}/sales/commitments`, (c) => {
    const p = salesCommitmentsSchema.safeParse(c.req.query());
    if (!p.success) return c.json(err("invalid_input"), 400);
    return c.json({
      basis: "confirmed_sales_orders_only",
      forecastIncluded: false,
      lines: [],
      total: 0,
      ...p.data,
    });
  });
  return { orders };
}
