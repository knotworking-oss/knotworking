import {
  generalChecklistTemplateCreateSchema,
  generalChecklistTemplateUpdateSchema,
  newId,
} from "@knotworking/core";
import type { Hono } from "hono";

type Item = { id: string; prompt: string; guidance?: string | null | undefined };
type Template = {
  id: string;
  name: string;
  kind: "general";
  line?: string | null | undefined;
  frequency?: { every: number; unit: string } | null | undefined;
  items: Item[];
  status: "active" | "archived";
};

export function mountFakeChecklists(app: Hono, ws: string) {
  const templates: Template[] = [];
  const prefix = `${ws}/checklists`;
  const find = (id: string) => templates.find((template) => template.id === id);
  const itemsWithIds = (
    items: { id?: string | undefined; prompt: string; guidance?: string | null | undefined }[],
  ) => items.map((item) => ({ ...item, id: item.id ?? newId() }));
  const notFound = { error: { code: "not_found", message: "Checklist not found" } };
  app.get(`${prefix}/templates`, (c) => {
    const status = c.req.query("status") ?? "active";
    return c.json({ templates: templates.filter((item) => status === "all" || item.status === status) });
  });
  app.get(`${prefix}/templates/:id`, (c) => {
    const template = find(c.req.param("id"));
    return template ? c.json(template) : c.json(notFound, 404);
  });
  app.post(`${prefix}/templates`, async (c) => {
    const parsed = generalChecklistTemplateCreateSchema.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json({ error: { code: "invalid_input", message: parsed.error.message } }, 400);
    const { items, ...input } = parsed.data;
    const template = {
      ...input,
      id: input.id ?? newId(),
      kind: "general",
      status: "active",
      items: itemsWithIds(items),
    } as const;
    templates.push(template);
    return c.json(template, 201);
  });
  app.patch(`${prefix}/templates/:id`, async (c) => {
    const template = find(c.req.param("id"));
    if (!template) return c.json(notFound, 404);
    const parsed = generalChecklistTemplateUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json({ error: { code: "invalid_input", message: parsed.error.message } }, 400);
    const { items, ...patch } = parsed.data;
    Object.assign(template, patch);
    if (items) template.items = itemsWithIds(items);
    return c.json(template);
  });
  app.get(`${prefix}/due`, (c) => c.json({ today: "2026-11-25", items: [] }));
  app.get(`${prefix}/checks`, (c) => c.json({ checks: [], total: 0, limit: 50, offset: 0 }));
  app.get(`${prefix}/checks/:id`, (c) => c.json(notFound, 404));
  app.get(`${prefix}/actions`, (c) => c.json({ actions: [], total: 0, limit: 50, offset: 0 }));
}
