import {
  authenticityCreateSchema,
  authenticityListQuerySchema,
  authenticitySaveSchema,
  authenticityTriggerSchema,
  authenticityVersionCommandSchema,
  newId,
} from "@knotworking/core";
import type { Hono } from "hono";
/** API-shape fixture only; sign-offs, audit immutability and tenancy are tested against the real API. */
export function mountFakeAuthenticity(app: Hono, ws: string) {
  const rows: Record<string, any>[] = [];
  const err = (code: string) => ({ error: { code, message: code } });
  const stamp = (r: any) => {
    r.updatedAt = new Date(Math.max(Date.now(), Date.parse(r.updatedAt) + 1)).toISOString();
  };
  app.get(`${ws}/quality/authenticity`, (c) => {
    const q = authenticityListQuerySchema.safeParse(c.req.query());
    if (!q.success) return c.json(err("invalid_input"), 400);
    const found = rows.filter(
      (r) =>
        (!q.data.itemId || r.itemId === q.data.itemId) &&
        (!q.data.supplierId || r.supplierId === q.data.supplierId) &&
        (!q.data.q || `${r.reference} ${r.title}`.toLowerCase().includes(q.data.q.toLowerCase())),
    );
    return c.json({
      assessments: found.slice(q.data.offset, q.data.offset + q.data.limit),
      total: found.length,
      limit: q.data.limit,
      offset: q.data.offset,
      today: "2026-11-15",
    });
  });
  app.post(`${ws}/quality/authenticity`, async (c) => {
    const q = authenticityCreateSchema.safeParse(await c.req.json());
    if (!q.success) return c.json(err("invalid_input"), 400);
    const row = {
      id: newId(),
      reference: `AUTH-${rows.length + 1}`,
      title: q.data.title,
      itemId: q.data.itemId,
      supplierId: q.data.supplierId,
      status: "active",
      updatedAt: new Date().toISOString(),
      draftVersionId: newId(),
      currentVersionId: null,
      versions: [] as any[],
      triggers: [] as any[],
      verifications: [],
    };
    row.versions.push({ id: row.draftVersionId, number: 1, status: "draft", body: q.data.draft });
    rows.push(row);
    return c.json(row, 201);
  });
  app.get(`${ws}/quality/authenticity/:id`, (c) => {
    const row = rows.find((r) => r.id === c.req.param("id"));
    return row ? c.json(row) : c.json(err("not_found"), 404);
  });
  app.put(`${ws}/quality/authenticity/:id/draft`, async (c) => {
    const row = rows.find((r) => r.id === c.req.param("id"));
    if (!row) return c.json(err("not_found"), 404);
    const q = authenticitySaveSchema.safeParse(await c.req.json());
    if (!q.success) return c.json(err("invalid_input"), 400);
    if (q.data.expectedUpdatedAt !== row.updatedAt) return c.json(err("assessment_changed"), 409);
    if (!row.draftVersionId) return c.json(err("no_draft"), 409);
    row.versions.find((v: any) => v.id === row.draftVersionId).body = q.data.draft;
    stamp(row);
    return c.json(row);
  });
  app.post(`${ws}/quality/authenticity/:id/draft`, async (c) => {
    const row = rows.find((r) => r.id === c.req.param("id"));
    if (!row) return c.json(err("not_found"), 404);
    const q = authenticityVersionCommandSchema.safeParse(await c.req.json());
    if (!q.success) return c.json(err("invalid_input"), 400);
    if (q.data.expectedUpdatedAt !== row.updatedAt) return c.json(err("assessment_changed"), 409);
    if (row.draftVersionId) return c.json(err("draft_exists"), 409);
    return c.json(err("fixture_no_signed_review"), 409);
  });
  app.post(`${ws}/quality/authenticity/:id/triggers`, async (c) => {
    const row = rows.find((r) => r.id === c.req.param("id"));
    if (!row) return c.json(err("not_found"), 404);
    const q = authenticityTriggerSchema.safeParse(await c.req.json());
    if (!q.success) return c.json(err("invalid_input"), 400);
    row.triggers.push({ id: newId(), ...q.data, resolvedByVersionId: null });
    stamp(row);
    return c.json(row, 201);
  });
  return { rows };
}
