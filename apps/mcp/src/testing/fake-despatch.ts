import {
  customerCreateSchema,
  customerListQuerySchema,
  customerUpdateSchema,
  despatchDraftSchema,
  despatchImpactQuerySchema,
  despatchListQuerySchema,
  despatchRecipientQuerySchema,
  newId,
} from "@knotworking/core";
import type { Hono } from "hono";

/** API-shape stand-in for MCP tests. Stock, locks and eligibility are tested against the real API. */
export function mountFakeDespatch(app: Hono, ws: string) {
  const customers: Record<string, any>[] = [];
  const despatches: Record<string, any>[] = [];
  const err = (code: string) => ({ error: { code, message: code } });
  app.get(`${ws}/customers`, (c) => {
    const q = customerListQuerySchema.safeParse(c.req.query());
    if (!q.success) return c.json(err("invalid_input"), 400);
    const rows = customers.filter(
      (r) =>
        (q.data.status === "all" || r.status === q.data.status) &&
        (!q.data.q || `${r.code} ${r.name}`.toLowerCase().includes(q.data.q.toLowerCase())),
    );
    return c.json({
      customers: rows.slice(q.data.offset, q.data.offset + q.data.limit),
      total: rows.length,
      limit: q.data.limit,
      offset: q.data.offset,
    });
  });
  app.post(`${ws}/customers`, async (c) => {
    const parsed = customerCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input"), 400);
    if (customers.some((r) => r.code.toLowerCase() === parsed.data.code.toLowerCase()))
      return c.json(err("code_taken"), 409);
    const row = { id: newId(), ...parsed.data };
    customers.push(row);
    return c.json(row, 201);
  });
  app.patch(`${ws}/customers/:id`, async (c) => {
    const row = customers.find((r) => r.id === c.req.param("id"));
    if (!row) return c.json(err("not_found"), 404);
    const parsed = customerUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input"), 400);
    Object.assign(row, parsed.data);
    return c.json(row);
  });
  app.get(`${ws}/customers/:id/sites`, (c) =>
    customers.some((r) => r.id === c.req.param("id")) ? c.json({ sites: [] }) : c.json(err("not_found"), 404),
  );
  app.get(`${ws}/despatch/:id/operations`, (c) =>
    despatches.some((r) => r.id === c.req.param("id"))
      ? c.json({ packages: [], events: [], proofs: [], returns: [] })
      : c.json(err("not_found"), 404),
  );
  app.get(`${ws}/despatch`, (c) => {
    const q = despatchListQuerySchema.safeParse(c.req.query());
    if (!q.success) return c.json(err("invalid_input"), 400);
    const rows = despatches.filter(
      (r) =>
        (q.data.status === "all" || r.status === q.data.status) &&
        (!q.data.customerId || r.customerId === q.data.customerId) &&
        (!q.data.from || r.despatchedOn >= q.data.from) &&
        (!q.data.to || r.despatchedOn <= q.data.to),
    );
    return c.json({
      despatches: rows.slice(q.data.offset, q.data.offset + q.data.limit),
      total: rows.length,
      offset: q.data.offset,
      limit: q.data.limit,
    });
  });
  app.get(`${ws}/despatch/lots/:lotId/impact`, (c) => {
    const q = despatchImpactQuerySchema.safeParse(c.req.query());
    if (!q.success) return c.json(err("invalid_input"), 400);
    return c.json({
      rootLotId: c.req.param("lotId"),
      generatedAt: "2026-11-14T12:00:00.000Z",
      scope: "forward_production_and_despatch",
      coverage: {
        status: q.data.depth === 1 ? "partial" : "complete",
        reasons: q.data.depth === 1 ? ["depth_limit"] : [],
        depth: q.data.depth,
        limits: { lots: 2000, batches: 2000, links: 10000 },
      },
      lots: [],
      batches: [],
      summary: { lots: 1, batches: 0, despatches: 0, customers: 0, deliveryLines: 0 },
      deliveries: { lines: [], total: 0, limit: q.data.limit, offset: q.data.offset },
    });
  });
  app.get(`${ws}/despatch/lots/:lotId/recipients`, (c) => {
    const q = despatchRecipientQuerySchema.safeParse(c.req.query());
    if (!q.success) return c.json(err("invalid_input"), 400);
    return c.json({
      lotId: c.req.param("lotId"),
      scope: "direct_lot_only",
      recipients: [],
      total: 0,
      ...q.data,
    });
  });
  app.get(`${ws}/despatch/:id`, (c) => {
    const row = despatches.find((r) => r.id === c.req.param("id"));
    return row ? c.json(row) : c.json(err("not_found"), 404);
  });
  app.post(`${ws}/despatch`, async (c) => {
    const parsed = despatchDraftSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input"), 400);
    const customer = customers.find((r) => r.id === parsed.data.customerId);
    if (!customer) return c.json(err("not_found"), 404);
    const row = {
      id: newId(),
      status: "draft",
      reference: `DN-${despatches.length + 1}`,
      customerName: customer.name,
      ...parsed.data,
    };
    despatches.push(row);
    return c.json(row, 201);
  });
  app.put(`${ws}/despatch/:id`, async (c) => {
    const row = despatches.find((r) => r.id === c.req.param("id"));
    if (!row) return c.json(err("not_found"), 404);
    const parsed = despatchDraftSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input"), 400);
    Object.assign(row, parsed.data);
    return c.json(row);
  });
  return { customers, despatches };
}
