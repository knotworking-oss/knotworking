import { csvImportSchema, newId, parseItemsCsv, parseSuppliersCsv } from "@knotworking/core";
import type { Hono } from "hono";

/** In-memory stand-in for the Items module's routes (apps/server/src/routes/items.ts). */
export function mountFakeItems(app: Hono, ws: string) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const now = "2026-01-05T09:00:00.000Z";
  const supplier = (fields: Record<string, unknown>) => ({
    id: newId(),
    name: "",
    code: null,
    contactName: null,
    email: null,
    phone: null,
    address: null,
    notes: null,
    certification: null,
    certificateExpiresOn: null,
    approvalStatus: "pending",
    approvalChangedAt: null,
    approvalChangedBy: null,
    approvalNote: null,
    reviewDueOn: null,
    createdAt: now,
    updatedAt: now,
    ...fields,
  });
  const suppliers: Record<string, any>[] = [
    supplier({ name: "Shipton Mill", code: "SHIP", approvalStatus: "approved", reviewDueOn: "2027-03-01" }),
    supplier({ name: "Dairy Co" }),
  ];
  const item = (fields: Record<string, unknown>) => ({
    id: newId(),
    code: "",
    name: "",
    type: "ingredient",
    status: "active",
    description: null,
    unit: "kg",
    densityGPerMl: null,
    unitWeightG: null,
    allergens: [],
    mayContain: [],
    storage: "ambient",
    shelfLifeDays: null,
    standardCost: null,
    createdAt: now,
    updatedAt: now,
    supplierIds: [] as string[],
    ...fields,
  });
  const items: Record<string, any>[] = [
    item({
      code: "FLR-001",
      name: "Strong white flour",
      allergens: ["cereals_gluten"],
      supplierIds: [suppliers[0]!.id],
    }),
    item({ code: "MLK-001", name: "Whole milk", unit: "l", allergens: ["milk"], storage: "chilled" }),
    item({ code: "BOX-12", name: "Cake box", type: "packaging", unit: "each" }),
    item({ code: "OLD-1", name: "Discontinued glaze", status: "archived" }),
  ];
  const view = ({ supplierIds, ...i }: Record<string, any>) => ({
    ...i,
    suppliers: (supplierIds as string[]).map((id) => {
      const s = suppliers.find((x) => x.id === id)!;
      return {
        supplierId: id,
        name: s.name,
        approvalStatus: s.approvalStatus,
        supplierCode: null,
        preferred: false,
      };
    }),
  });
  const linkIds = (body: { suppliers?: { supplierId: string }[] }) =>
    body.suppliers?.map((s) => s.supplierId);

  app.get(`${ws}/items`, (c) => {
    const q = c.req.query();
    const text = q.q?.toLowerCase();
    const status = q.status ?? "active";
    const found = items.filter(
      (i) =>
        (status === "all" || i.status === status) &&
        (!q.type || i.type === q.type) &&
        (!text || i.name.toLowerCase().includes(text) || i.code.toLowerCase().includes(text)) &&
        (!q.allergen || i.allergens.includes(q.allergen) || i.mayContain.includes(q.allergen)) &&
        (!q.supplierId || i.supplierIds.includes(q.supplierId)),
    );
    const limit = Number(q.limit ?? 50);
    const offset = Number(q.offset ?? 0);
    return c.json({
      items: found.slice(offset, offset + limit).map(view),
      total: found.length,
      limit,
      offset,
    });
  });
  app.get(`${ws}/items/:id`, (c) => {
    const found = items.find((i) => i.id === c.req.param("id"));
    return found ? c.json(view(found)) : c.json(err("not_found", "Item not found"), 404);
  });
  app.post(`${ws}/items`, async (c) => {
    const body = await c.req.json();
    if (items.some((i) => i.code.toLowerCase() === String(body.code).toLowerCase()))
      return c.json(err("code_taken", `Another item already uses the code "${body.code}"`), 409);
    const { suppliers: _links, ...fields } = body;
    const created = item({ ...fields, supplierIds: linkIds(body) ?? [] });
    items.push(created);
    return c.json(view(created), 201);
  });
  app.patch(`${ws}/items/:id`, async (c) => {
    const found = items.find((i) => i.id === c.req.param("id"));
    if (!found) return c.json(err("not_found", "Item not found"), 404);
    const body = await c.req.json();
    const { suppliers: _links, ...fields } = body;
    Object.assign(found, fields, linkIds(body) ? { supplierIds: linkIds(body) } : {});
    return c.json(view(found));
  });

  /** The import routes' result shape, with the fake's simpler matching (by code; by name for suppliers). */
  const importResult = (
    parsed: { rowCount: number; ignoredColumns: string[]; errors: any[] },
    changes: { row: number; action: string; key: string; name: string; fields: string[] }[],
    unchanged: number,
    dryRun: boolean,
  ) => ({
    dryRun,
    fileName: null,
    rowCount: parsed.rowCount,
    ignoredColumns: parsed.ignoredColumns,
    errors: parsed.errors,
    created: changes.filter((x) => x.action === "create").length,
    updated: changes.filter((x) => x.action === "update").length,
    unchanged,
    changes,
    changesTruncated: false,
  });
  const invalid = (errors: any[]) => ({
    error: {
      code: "invalid_rows",
      message: `${new Set(errors.map((e) => e.row)).size} rows have problems; nothing was saved. ${errors
        .map((e) => `Row ${e.row}: ${e.message}`)
        .join("; ")}`,
      details: { errors },
    },
  });

  app.post(`${ws}/items/import`, async (c) => {
    const body = csvImportSchema.parse(await c.req.json());
    const parsed = parseItemsCsv(body.csv);
    if (parsed.errors.length) {
      return body.dryRun ? c.json(importResult(parsed, [], 0, true)) : c.json(invalid(parsed.errors), 400);
    }
    const changes: { row: number; action: string; key: string; name: string; fields: string[] }[] = [];
    let unchanged = 0;
    for (const { row, code, ...fields } of parsed.entries) {
      const found = items.find((i) => i.code.toLowerCase() === code.toLowerCase());
      const given = Object.entries(fields).filter(([, v]) => v !== undefined);
      if (!found) {
        changes.push({ row, action: "create", key: code, name: String(fields.name), fields: [] });
        if (!body.dryRun) items.push(item({ code, ...Object.fromEntries(given) }));
        continue;
      }
      const changed = given.filter(([k, v]) => JSON.stringify(found[k]) !== JSON.stringify(v));
      if (!changed.length) unchanged++;
      else {
        changes.push({ row, action: "update", key: code, name: found.name, fields: changed.map(([k]) => k) });
        if (!body.dryRun) Object.assign(found, Object.fromEntries(changed));
      }
    }
    return c.json(importResult(parsed, changes, unchanged, !!body.dryRun), body.dryRun ? 200 : 201);
  });

  app.post(`${ws}/suppliers/import`, async (c) => {
    const body = csvImportSchema.parse(await c.req.json());
    const parsed = parseSuppliersCsv(body.csv);
    if (parsed.errors.length) {
      return body.dryRun ? c.json(importResult(parsed, [], 0, true)) : c.json(invalid(parsed.errors), 400);
    }
    const changes: { row: number; action: string; key: string; name: string; fields: string[] }[] = [];
    let unchanged = 0;
    for (const { row, ...fields } of parsed.entries) {
      const found = suppliers.find(
        (s) =>
          (fields.code && s.code?.toLowerCase() === fields.code.toLowerCase()) ||
          (!fields.code && s.name.toLowerCase() === fields.name?.toLowerCase()),
      );
      const given = Object.entries(fields).filter(([, v]) => v !== undefined);
      const key = fields.code ?? fields.name ?? "";
      if (!found) {
        changes.push({ row, action: "create", key, name: String(fields.name), fields: [] });
        if (!body.dryRun) suppliers.push(supplier(Object.fromEntries(given)));
        continue;
      }
      const changed = given.filter(([k, v]) => JSON.stringify(found[k]) !== JSON.stringify(v));
      if (!changed.length) unchanged++;
      else {
        changes.push({ row, action: "update", key, name: found.name, fields: changed.map(([k]) => k) });
        if (!body.dryRun) Object.assign(found, Object.fromEntries(changed));
      }
    }
    return c.json(importResult(parsed, changes, unchanged, !!body.dryRun), body.dryRun ? 200 : 201);
  });

  app.get(`${ws}/suppliers`, (c) => {
    const q = c.req.query();
    const text = q.q?.toLowerCase();
    return c.json({
      suppliers: suppliers
        .filter(
          (s) =>
            (!q.status || s.approvalStatus === q.status) &&
            (!text || s.name.toLowerCase().includes(text) || s.code?.toLowerCase().includes(text)),
        )
        .map((s) => ({ ...s, itemCount: items.filter((i) => i.supplierIds.includes(s.id)).length })),
    });
  });
  app.get(`${ws}/suppliers/compliance`, (c) =>
    c.json({
      today: "2026-01-05",
      suppliers: suppliers.map((s) => ({
        supplierId: s.id,
        name: s.name,
        code: s.code,
        category: s.category ?? "goods",
        approvalStatus: s.approvalStatus,
        riskLevel: null,
        actionCount: 1,
        issues: [
          { kind: "no_assessment", severity: "action", message: "No risk assessment of this supplier" },
        ],
      })),
    }),
  );
  app.get(`${ws}/suppliers/:id`, (c) => {
    const found = suppliers.find((s) => s.id === c.req.param("id"));
    return found ? c.json(found) : c.json(err("not_found", "Supplier not found"), 404);
  });
  app.post(`${ws}/suppliers`, async (c) => {
    const created = supplier(await c.req.json());
    suppliers.push(created);
    return c.json(created, 201);
  });
  app.patch(`${ws}/suppliers/:id`, async (c) => {
    const found = suppliers.find((s) => s.id === c.req.param("id"));
    if (!found) return c.json(err("not_found", "Supplier not found"), 404);
    Object.assign(found, await c.req.json());
    return c.json(found);
  });

  const questionnaires: Record<string, any>[] = [];
  app.get(`${ws}/suppliers/:id/controls`, (c) =>
    c.json({
      supplierId: c.req.param("id"),
      category: "goods",
      serviceType: null,
      riskLevel: null,
      issues: [{ kind: "no_assessment", severity: "action", message: "No risk assessment of this supplier" }],
      actionCount: 1,
      assessments: [],
      history: [],
      questionnaires: questionnaires.filter((q) => q.supplierId === c.req.param("id")),
      today: "2026-01-05",
    }),
  );
  app.post(`${ws}/suppliers/:id/questionnaires`, async (c) => {
    const body = await c.req.json();
    const q = {
      id: newId(),
      supplierId: c.req.param("id"),
      status: body.receivedOn ? "received" : "sent",
      receivedOn: null,
      validUntil: null,
      ...body,
    };
    questionnaires.push(q);
    return c.json(q, 201);
  });
  app.post(`${ws}/suppliers/:id/questionnaires/:qid/receive`, async (c) => {
    const q = questionnaires.find((x) => x.id === c.req.param("qid"));
    if (!q) return c.json({ error: { code: "not_found", message: "Questionnaire not found" } }, 404);
    Object.assign(q, { status: "received", receivedOn: (await c.req.json()).receivedOn });
    return c.json(q);
  });
  return { items, suppliers };
}
