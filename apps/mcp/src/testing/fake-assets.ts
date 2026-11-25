import { assetCreateSchema, assetUpdateSchema, newId } from "@knotworking/core";
import type { Context, Hono } from "hono";
import type { ZodType } from "zod";

/**
 * In-memory stand-in for the asset register's routes (apps/server/src/routes/assets.ts) that the
 * MCP tools use. Request bodies are checked with the real schemas from `@knotworking/core`.
 *
 * Seeded with two areas (Packing hall, Dispatch: the site fake's areas) and a delivery van.
 */
export function mountFakeAssets(app: Hono, ws: string) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const now = "2026-11-11T09:00:00.000Z";
  const blank = {
    parentAreaId: null as string | null,
    location: null as string | null,
    manufacturer: null as string | null,
    model: null as string | null,
    serialNumber: null as string | null,
    purchasedOn: null as string | null,
    purchaseCost: null as number | null,
    warrantyExpiresOn: null as string | null,
    custodianId: null as string | null,
    notes: null as string | null,
    status: "active",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const assets: Record<string, any>[] = [
    { ...blank, id: newId(), kind: "area", code: null, name: "Packing hall" },
    { ...blank, id: newId(), kind: "area", code: "DSP", name: "Dispatch" },
    { ...blank, id: newId(), kind: "vehicle", code: "VAN-1", name: "Delivery van", purchaseCost: 28500 },
  ];
  const view = (a: Record<string, any>) => {
    const area = assets.find((x) => x.id === a.parentAreaId);
    return {
      ...a,
      parentArea: area ? { id: area.id, code: area.code, name: area.name, status: area.status } : null,
      custodianName: null,
    };
  };
  const parse = async <T>(c: Context, schema: ZodType<T>) => {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success
      ? { data: parsed.data as T & { id?: string } }
      : { response: c.json(err("invalid_input", parsed.error.message), 400) };
  };
  const codeTaken = (code: string | null | undefined, except?: string) =>
    !!code && assets.some((a) => a.id !== except && a.code?.toLowerCase() === code.toLowerCase());

  app.get(`${ws}/assets`, (c) => {
    const q = c.req.query();
    const text = q.q?.toLowerCase();
    const rows = assets.filter(
      (a) =>
        (!q.kind || a.kind === q.kind) &&
        (!q.areaId || a.parentAreaId === q.areaId) &&
        ((q.status ?? "active") === "all" || a.status === (q.status ?? "active")) &&
        (!text || [a.name, a.code, a.serialNumber].some((v) => v?.toLowerCase().includes(text))),
    );
    const limit = Number(q.limit ?? 100);
    const offset = Number(q.offset ?? 0);
    return c.json({
      assets: rows.slice(offset, offset + limit).map(view),
      total: rows.length,
      limit,
      offset,
    });
  });
  app.get(`${ws}/assets/:id`, (c) => {
    const row = assets.find((a) => a.id === c.req.param("id"));
    if (!row) return c.json(err("not_found", "Asset not found"), 404);
    return c.json({ ...view(row), assetsInside: assets.filter((a) => a.parentAreaId === row.id).length });
  });
  app.post(`${ws}/assets`, async (c) => {
    const { data, response } = await parse(c, assetCreateSchema);
    if (response) return response;
    if (codeTaken(data!.code))
      return c.json(err("code_taken", `Another asset uses the code "${data!.code}"`), 409);
    const row = { ...blank, ...data!, id: data!.id ?? newId() };
    assets.push(row);
    return c.json(view(row), 201);
  });
  app.patch(`${ws}/assets/:id`, async (c) => {
    const { data, response } = await parse(c, assetUpdateSchema);
    if (response) return response;
    const row = assets.find((a) => a.id === c.req.param("id"));
    if (!row) return c.json(err("not_found", "Asset not found"), 404);
    if (codeTaken(data!.code, row.id))
      return c.json(err("code_taken", `Another asset uses the code "${data!.code}"`), 409);
    const { expectedRevision: _r, ...patch } = data!;
    Object.assign(row, patch, { revision: row.revision + 1 });
    return c.json(view(row));
  });
  for (const [action, status] of [
    ["archive", "archived"],
    ["restore", "active"],
  ] as const) {
    app.post(`${ws}/assets/:id/${action}`, (c) => {
      const row = assets.find((a) => a.id === c.req.param("id"));
      if (!row) return c.json(err("not_found", "Asset not found"), 404);
      row.status = status;
      return c.json(view(row));
    });
  }

  return { assets };
}
