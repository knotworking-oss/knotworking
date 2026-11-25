import {
  crmActivityCreateSchema,
  crmActivityUpdateSchema,
  crmLeadConvertSchema,
  crmLeadCreateSchema,
  crmLeadUpdateSchema,
  crmOpportunityCreateSchema,
  crmOpportunityUpdateSchema,
  crmOutcomeSchema,
  defaultCrmStages,
  newId,
} from "@knotworking/core";
import type { Context, Hono } from "hono";
import type { z } from "zod";

type Lead = Record<string, unknown> & { id: string; revision: number; status: string; customerId: string | null };
type Opportunity = Record<string, unknown> & {
  id: string;
  revision: number;
  status: string;
  stageId: string;
  leadId: string | null;
  customerId: string | null;
};
type Activity = Record<string, unknown> & { id: string; completedAt: string | null };

/** In-memory CRM routes, enough for the tools to be exercised end to end. */
export function mountFakeCrm(app: Hono, ws: string) {
  const prefix = `${ws}/crm`;
  const stages = defaultCrmStages.map((stage, position) => ({ ...stage, position, id: newId() }));
  const leads: Lead[] = [];
  const opportunities: Opportunity[] = [];
  const activities: Activity[] = [];
  const notFound = (c: Context, what: string) =>
    c.json({ error: { code: "not_found", message: `${what} not found` } }, 404);
  const conflict = (c: Context, message: string) => c.json({ error: { code: "crm_conflict", message } }, 409);
  async function body<T extends z.ZodType>(c: Context, schema: T) {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success ? (parsed.data as z.infer<T>) : null;
  }
  const invalid = (c: Context) => c.json({ error: { code: "invalid_input", message: "Invalid input" } }, 400);
  const view = (o: Opportunity) => ({
    ...o,
    stage: stages.find((s) => s.id === o.stageId) ?? null,
    lead: leads.find((l) => l.id === o.leadId) ?? null,
    salesQuote: null,
    serviceQuote: null,
    handoff: null,
  });

  app.get(`${prefix}/stages`, (c) => c.json({ stages }));
  app.get(`${prefix}/pipeline`, (c) =>
    c.json({
      stages: stages.map((stage) => {
        const items = opportunities.filter((o) => o.status === "open" && o.stageId === stage.id).map(view);
        return { ...stage, count: items.length, totals: [], opportunities: items };
      }),
      unstaged: [],
      won: { count: opportunities.filter((o) => o.status === "won").length, recent: [] },
      lost: { count: opportunities.filter((o) => o.status === "lost").length, recent: [] },
      truncated: false,
    }),
  );

  app.get(`${prefix}/leads`, (c) => {
    const status = c.req.query("status");
    return c.json({ leads: leads.filter((l) => !status || l.status === status), nextCursor: null });
  });
  app.post(`${prefix}/leads`, async (c) => {
    const input = await body(c, crmLeadCreateSchema);
    if (!input) return invalid(c);
    const { commandId: _command, ...fields } = input;
    const lead: Lead = { ...fields, id: newId(), reference: "LD-0001", status: "new", revision: 1, customerId: null };
    leads.push(lead);
    return c.json(lead, 201);
  });
  app.get(`${prefix}/leads/:id`, (c) => {
    const lead = leads.find((l) => l.id === c.req.param("id"));
    if (!lead) return notFound(c, "Lead");
    return c.json({
      ...lead,
      customer: null,
      opportunities: opportunities.filter((o) => o.leadId === lead.id).map(view),
      activities: activities.filter((a) => a.leadId === lead.id),
    });
  });
  app.patch(`${prefix}/leads/:id`, async (c) => {
    const lead = leads.find((l) => l.id === c.req.param("id"));
    if (!lead) return notFound(c, "Lead");
    const input = await body(c, crmLeadUpdateSchema);
    if (!input) return invalid(c);
    const { expectedRevision, ...fields } = input;
    if (expectedRevision !== lead.revision) return conflict(c, "This lead changed");
    Object.assign(lead, fields, { revision: lead.revision + 1 });
    return c.json(lead);
  });
  app.post(`${prefix}/leads/:id/convert`, async (c) => {
    const lead = leads.find((l) => l.id === c.req.param("id"));
    if (!lead) return notFound(c, "Lead");
    const input = await body(c, crmLeadConvertSchema);
    if (!input) return invalid(c);
    if (lead.status !== "qualified") return conflict(c, "Qualify the lead before converting it");
    const customerId = input.customer.mode === "existing" ? input.customer.customerId : newId();
    Object.assign(lead, { status: "converted", customerId, revision: lead.revision + 1 });
    for (const o of opportunities) if (o.leadId === lead.id && !o.customerId) o.customerId = customerId;
    return c.json(lead);
  });

  app.get(`${prefix}/opportunities`, (c) => {
    const status = c.req.query("status") ?? "open";
    return c.json({
      opportunities: opportunities.filter((o) => status === "all" || o.status === status).map(view),
      nextCursor: null,
    });
  });
  app.post(`${prefix}/opportunities`, async (c) => {
    const input = await body(c, crmOpportunityCreateSchema);
    if (!input) return invalid(c);
    const { commandId: _command, ...fields } = input;
    const opportunity: Opportunity = {
      ...fields,
      id: newId(),
      reference: "OP-0001",
      status: "open",
      revision: 1,
      stageId: input.stageId ?? stages[0]!.id,
      closedReason: null,
    };
    opportunities.push(opportunity);
    return c.json(view(opportunity), 201);
  });
  app.get(`${prefix}/opportunities/:id`, (c) => {
    const o = opportunities.find((x) => x.id === c.req.param("id"));
    if (!o) return notFound(c, "Opportunity");
    return c.json({ ...view(o), activities: activities.filter((a) => a.opportunityId === o.id) });
  });
  app.patch(`${prefix}/opportunities/:id`, async (c) => {
    const o = opportunities.find((x) => x.id === c.req.param("id"));
    if (!o) return notFound(c, "Opportunity");
    const input = await body(c, crmOpportunityUpdateSchema);
    if (!input) return invalid(c);
    const { expectedRevision, ...fields } = input;
    if (expectedRevision !== o.revision) return conflict(c, "This opportunity changed");
    Object.assign(o, fields, { revision: o.revision + 1 });
    return c.json(view(o));
  });
  app.post(`${prefix}/opportunities/:id/outcome`, async (c) => {
    const o = opportunities.find((x) => x.id === c.req.param("id"));
    if (!o) return notFound(c, "Opportunity");
    const input = await body(c, crmOutcomeSchema);
    if (!input) return invalid(c);
    if (input.expectedRevision !== o.revision) return conflict(c, "This opportunity changed");
    if ((input.outcome === "reopen") !== (o.status !== "open")) return conflict(c, "Not in that state");
    Object.assign(o, {
      status: input.outcome === "reopen" ? "open" : input.outcome,
      closedReason: input.outcome === "reopen" ? null : input.reason,
      revision: o.revision + 1,
    });
    return c.json(view(o));
  });

  app.get(`${prefix}/activities`, (c) => {
    const status = c.req.query("status") ?? "open";
    const list = activities.filter(
      (a) => status === "all" || (status === "open" ? !a.completedAt : Boolean(a.completedAt)),
    );
    return c.json({ activities: list, total: list.length, limit: 100, offset: 0 });
  });
  app.post(`${prefix}/activities`, async (c) => {
    const input = await body(c, crmActivityCreateSchema);
    if (!input) return invalid(c);
    const { commandId: _command, done, ...fields } = input;
    const activity: Activity = {
      ...fields,
      id: newId(),
      ownerId: fields.ownerId ?? "self",
      completedAt: done ? "2026-11-25T10:00:00.000Z" : null,
    };
    activities.push(activity);
    return c.json(activity, 201);
  });
  app.patch(`${prefix}/activities/:id`, async (c) => {
    const activity = activities.find((a) => a.id === c.req.param("id"));
    if (!activity) return notFound(c, "Activity");
    const input = await body(c, crmActivityUpdateSchema);
    if (!input) return invalid(c);
    const { done, ...fields } = input;
    Object.assign(activity, fields);
    if (done !== undefined) activity.completedAt = done ? "2026-11-25T10:00:00.000Z" : null;
    return c.json(activity);
  });
}
