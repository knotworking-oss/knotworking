import {
  hseReportSchema,
  newId,
  hseListSchema,
  hseCreateSchema,
  hseSaveSchema,
  hsePageSchema,
  hsePermitListSchema,
  hsePermitCreateSchema,
  hsePermitSaveSchema,
} from "@knotworking/core";
import type { Hono } from "hono";
/** Transport/schema fake only. Real API tests cover safety, workspace isolation and privacy. */
export function mountFakeHse(app: Hono, ws: string) {
  const records: Record<string, any>[] = [],
    permits: Record<string, any>[] = [];
  const err = (code: string) => ({ error: { code, message: code } });
  app.get(`${ws}/hse/registers`, (c) => {
    const q = hseListSchema.parse(c.req.query());
    const rows = records.filter((r) => (!q.kind || r.kind === q.kind) && r.status === q.status);
    return c.json({
      records: rows.slice(q.offset, q.offset + q.limit),
      total: rows.length,
      limit: q.limit,
      offset: q.offset,
    });
  });
  app.post(`${ws}/hse/registers`, async (c) => {
    const p = hseCreateSchema.safeParse(await c.req.json());
    if (!p.success) return c.json(err("invalid_input"), 400);
    const r = {
      id: newId(),
      revision: 1,
      status: "active",
      title: p.data.title,
      kind: p.data.kind,
      draft: { content: p.data.content, number: 1 },
      approved: null,
    };
    records.push(r);
    return c.json(r, 201);
  });
  app.get(`${ws}/hse/registers/:id`, (c) => {
    const r = records.find((r) => r.id === c.req.param("id"));
    return r ? c.json(r) : c.json(err("not_found"), 404);
  });
  app.put(`${ws}/hse/registers/:id/draft`, async (c) => {
    const r = records.find((r) => r.id === c.req.param("id"));
    if (!r) return c.json(err("not_found"), 404);
    const p = hseSaveSchema.safeParse(await c.req.json());
    if (!p.success) return c.json(err("invalid_input"), 400);
    if (r.revision !== p.data.expectedRevision) return c.json(err("hse_conflict"), 409);
    r.draft.content = p.data.content;
    r.revision++;
    return c.json(r);
  });
  for (const section of ["history", "entries"])
    app.get(`${ws}/hse/registers/:id/${section}`, (c) =>
      c.json({
        [section === "history" ? "versions" : "entries"]: [],
        total: 0,
        ...hsePageSchema.parse(c.req.query()),
      }),
    );
  app.get(`${ws}/hse/permits`, (c) => {
    const q = hsePermitListSchema.parse(c.req.query());
    const rows = permits.filter((r) => !q.status || r.status === q.status);
    return c.json({
      permits: rows.slice(q.offset, q.offset + q.limit),
      total: rows.length,
      limit: q.limit,
      offset: q.offset,
    });
  });
  app.post(`${ws}/hse/permits`, async (c) => {
    const p = hsePermitCreateSchema.safeParse(await c.req.json());
    if (!p.success) return c.json(err("invalid_input"), 400);
    const r = { id: newId(), revision: 1, status: "draft", title: p.data.title, body: p.data.body };
    permits.push(r);
    return c.json(r, 201);
  });
  app.get(`${ws}/hse/permits/:id`, (c) => {
    const r = permits.find((r) => r.id === c.req.param("id"));
    return r ? c.json(r) : c.json(err("not_found"), 404);
  });
  app.put(`${ws}/hse/permits/:id`, async (c) => {
    const r = permits.find((r) => r.id === c.req.param("id"));
    if (!r) return c.json(err("not_found"), 404);
    const p = hsePermitSaveSchema.safeParse(await c.req.json());
    if (!p.success) return c.json(err("invalid_input"), 400);
    if (r.revision !== p.data.expectedRevision) return c.json(err("hse_conflict"), 409);
    r.body = p.data.body;
    r.revision++;
    return c.json(r);
  });
  app.get(`${ws}/hse/permits/:id/history`, (c) =>
    c.json({ events: [], total: 0, ...hsePageSchema.parse(c.req.query()) }),
  );
  const reports: Record<string, unknown>[] = [];
  app.post(`${ws}/hse/reports`, async (c) => {
    const p = hseReportSchema.safeParse(await c.req.json());
    if (!p.success) return c.json(err("invalid_input"), 400);
    const id = newId();
    reports.push({ ...p.data, id });
    return c.json({ id, reference: `HSE-${id.slice(-12)}` }, 201);
  });
  return { records, permits, reports };
}
