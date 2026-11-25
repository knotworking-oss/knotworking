import {
  defaultCrmStages,
  hasModuleLevel,
  newId,
  serviceQuoteAmount,
  type CrmActivityCreateInput,
  type CrmActivityListQuery,
  type CrmActivityUpdateInput,
  type CrmHandoffInput,
  type CrmLeadConvertInput,
  type CrmLeadCreateInput,
  type CrmLeadListQuery,
  type CrmLeadUpdateInput,
  type CrmOpportunityCreateInput,
  type CrmOpportunityListQuery,
  type CrmOpportunityUpdateInput,
  type CrmOutcomeInput,
  type CrmStagesSaveInput,
  type ModuleId,
} from "@knotworking/core";
import {
  crmActivities,
  crmLeads,
  crmOpportunities,
  crmStages,
  customers,
  lockWorkspaceLog,
  projects,
  recordChanges,
  salesOrders,
  serviceQuotes,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { findCustomer, insertCustomer } from "./customers";
import { executeLedgerCommand } from "./ledger-command";
import {
  insertNotifications,
  memberAccess,
  type NotificationRow,
  type NotifiedCallback,
} from "./notifications";
import { decideServiceQuote } from "./client-services";
import { actOnSalesOrder } from "./sales";

/**
 * CRM: leads, opportunities on the workspace's pipeline stages, and follow-up activities, built on
 * the shared customer register. Quotes, orders and delivery projects stay in Sales and Client
 * services (soft dependencies): an opportunity links to their quote and hands off through their own
 * services, so their rules (signed decisions, revisions, expiry) still apply.
 */

type Lead = typeof crmLeads.$inferSelect;
type Opportunity = typeof crmOpportunities.$inferSelect;
type Activity = typeof crmActivities.$inferSelect;
type Stage = typeof crmStages.$inferSelect;

/** Which soft dependencies the caller can read: decides what links are resolved. */
export interface CrmLinks {
  sales: boolean;
  services: boolean;
  tasks: boolean;
}

const conflict = (message: string, code = "crm_conflict") => new ApiError(409, code, message);
const PAGE = 50;

function requireRevision(row: { revision: number }, expected: number, what: string) {
  if (row.revision !== expected) throw conflict(`This ${what} changed. Reload and review the latest version`);
}

// ─── Stages ─────────────────────────────────────────────────────────────────

const stageView = ({ workspaceId: _ws, ...stage }: Stage) => stage;

async function liveStages(db: Executor, workspaceId: string) {
  return db
    .select()
    .from(crmStages)
    .where(and(eq(crmStages.workspaceId, workspaceId), isNull(crmStages.archivedAt)))
    .orderBy(asc(crmStages.position), asc(crmStages.id));
}

/** A workspace with no stages at all starts with the defaults. Call holding the workspace log lock. */
async function seedStages(tx: Transaction, workspaceId: string, actorId: string | null) {
  const [any] = await tx
    .select({ id: crmStages.id })
    .from(crmStages)
    .where(eq(crmStages.workspaceId, workspaceId))
    .limit(1);
  if (any) return;
  const rows = await tx
    .insert(crmStages)
    .values(defaultCrmStages.map((stage, position) => ({ ...stage, position, workspaceId })))
    .returning();
  await recordChanges(
    tx,
    workspaceId,
    actorId,
    rows.map((row) => ({ entity: "crm_stage", entityId: row.id, action: "upsert", data: { id: row.id } })),
  );
}

export async function listCrmStages(db: Database, workspaceId: string, actorId: string) {
  let stages = await liveStages(db, workspaceId);
  if (stages.length === 0) {
    stages = await db.transaction(async (tx) => {
      await lockWorkspaceLog(tx, workspaceId);
      await seedStages(tx, workspaceId, actorId);
      return liveStages(tx, workspaceId);
    });
  }
  return { stages: stages.map(stageView) };
}

/** Replaces the ordered list of open stages. A stage left out is archived, unless it holds open work. */
export async function saveCrmStages(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: CrmStagesSaveInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await seedStages(tx, workspaceId, actorId);
    const current = await liveStages(tx, workspaceId);
    const byId = new Map(current.map((s) => [s.id, s]));
    for (const stage of input.stages)
      if (stage.id && !byId.has(stage.id)) throw badRequest("A stage in the list is not a current stage");
    const kept = new Set(input.stages.flatMap((s) => (s.id ? [s.id] : [])));
    const removed = current.filter((s) => !kept.has(s.id));
    if (removed.length) {
      const [inUse] = await tx
        .select({ n: count() })
        .from(crmOpportunities)
        .where(
          and(
            eq(crmOpportunities.workspaceId, workspaceId),
            eq(crmOpportunities.status, "open"),
            inArray(
              crmOpportunities.stageId,
              removed.map((s) => s.id),
            ),
          ),
        );
      if (inUse && inUse.n > 0)
        throw conflict("Move the open opportunities off a stage before removing it", "stage_in_use");
      // Archive first so a new stage may reuse a removed one's name.
      await tx
        .update(crmStages)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(
          inArray(
            crmStages.id,
            removed.map((s) => s.id),
          ),
        );
    }
    // Free the names before renaming, so swapping two names doesn't trip the unique index.
    for (const s of current.filter((s) => kept.has(s.id)))
      await tx
        .update(crmStages)
        .set({ name: `~${s.id}` })
        .where(eq(crmStages.id, s.id));
    const ids: string[] = [];
    for (const [position, stage] of input.stages.entries()) {
      if (stage.id) {
        await tx
          .update(crmStages)
          .set({ name: stage.name, probability: stage.probability, position, updatedAt: new Date() })
          .where(eq(crmStages.id, stage.id));
        ids.push(stage.id);
      } else {
        const [row] = await tx
          .insert(crmStages)
          .values({ workspaceId, name: stage.name, probability: stage.probability, position })
          .returning({ id: crmStages.id });
        ids.push(row!.id);
      }
    }
    await recordChanges(
      tx,
      workspaceId,
      actorId,
      [...ids, ...removed.map((s) => s.id)].map((id) => ({
        entity: "crm_stage",
        entityId: id,
        action: "upsert",
        data: { id },
      })),
    );
    return { stages: (await liveStages(tx, workspaceId)).map(stageView) };
  });
}

async function findStage(db: Executor, workspaceId: string, id: string) {
  const [stage] = await db
    .select()
    .from(crmStages)
    .where(and(eq(crmStages.workspaceId, workspaceId), eq(crmStages.id, id), isNull(crmStages.archivedAt)));
  if (!stage) throw badRequest("Choose a current pipeline stage");
  return stage;
}

// ─── Owners ─────────────────────────────────────────────────────────────────

/** An owner must be a member who can at least read CRM. */
async function assertOwner(
  db: Executor,
  workspaceId: string,
  active: readonly ModuleId[],
  ownerId: string | null | undefined,
) {
  if (!ownerId) return;
  const access = await memberAccess(db, workspaceId, active);
  if (!hasModuleLevel(access.get(ownerId)?.crm, "read"))
    throw badRequest("Choose an owner who is a member with access to CRM");
}

// ─── Leads ──────────────────────────────────────────────────────────────────

const leadView = ({ workspaceId: _ws, ...lead }: Lead) => lead;

async function loadLead(db: Executor, workspaceId: string, id: string) {
  const [lead] = await db
    .select()
    .from(crmLeads)
    .where(and(eq(crmLeads.workspaceId, workspaceId), eq(crmLeads.id, id)));
  if (!lead) throw notFound("Lead");
  return lead;
}

const leadChange = (lead: Lead) => ({
  entity: "crm_lead" as const,
  entityId: lead.id,
  action: "upsert" as const,
  data: { id: lead.id, revision: lead.revision },
});

export async function listCrmLeads(db: Database, workspaceId: string, query: CrmLeadListQuery) {
  const escaped = `%${(query.q ?? "").replace(/[!%_]/g, (v) => `!${v}`)}%`;
  const rows = await db
    .select()
    .from(crmLeads)
    .where(
      and(
        eq(crmLeads.workspaceId, workspaceId),
        query.status ? eq(crmLeads.status, query.status) : undefined,
        query.ownerId ? eq(crmLeads.ownerId, query.ownerId) : undefined,
        query.q
          ? or(
              sql`${crmLeads.name} ilike ${escaped} escape '!'`,
              sql`${crmLeads.company} ilike ${escaped} escape '!'`,
              sql`${crmLeads.reference} ilike ${escaped} escape '!'`,
            )
          : undefined,
        query.before ? lt(crmLeads.id, query.before) : undefined,
      ),
    )
    .orderBy(desc(crmLeads.id))
    .limit(PAGE + 1);
  const leads = rows.slice(0, PAGE).map(leadView);
  return { leads, nextCursor: rows.length > PAGE ? leads.at(-1)!.id : null };
}

export async function getCrmLead(db: Database, workspaceId: string, id: string, links: CrmLinks) {
  const lead = await loadLead(db, workspaceId, id);
  const [customer] = lead.customerId
    ? await db
        .select({ id: customers.id, code: customers.code, name: customers.name, status: customers.status })
        .from(customers)
        .where(and(eq(customers.workspaceId, workspaceId), eq(customers.id, lead.customerId)))
    : [];
  const opportunities = await db
    .select()
    .from(crmOpportunities)
    .where(and(eq(crmOpportunities.workspaceId, workspaceId), eq(crmOpportunities.leadId, id)))
    .orderBy(desc(crmOpportunities.id))
    .limit(100);
  return {
    ...leadView(lead),
    customer: customer ?? null,
    opportunities: await decorate(db, workspaceId, opportunities, links),
    activities: (await listCrmActivities(db, workspaceId, null, { ...allActivities, leadId: id })).activities,
  };
}

export async function createCrmLead(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  input: CrmLeadCreateInput,
) {
  return executeLedgerCommand(db, workspaceId, actorId, "crm.lead.create", input, input, async (tx) => {
    await assertOwner(tx, workspaceId, active, input.ownerId);
    const { commandId: _command, ...fields } = input;
    const id = newId();
    const [lead] = await tx
      .insert(crmLeads)
      .values({
        ...fields,
        id,
        workspaceId,
        reference: `LD-${id.slice(-12).toUpperCase()}`,
        createdBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [leadChange(lead!)]);
    return leadView(lead!);
  });
}

export async function updateCrmLead(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  id: string,
  input: CrmLeadUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await loadLead(tx, workspaceId, id);
    requireRevision(current, input.expectedRevision, "lead");
    if (current.status === "converted") throw conflict("A converted lead can't be changed");
    if (input.ownerId !== undefined) await assertOwner(tx, workspaceId, active, input.ownerId);
    const { expectedRevision: _revision, statusReason, ...fields } = input;
    const status = input.status ?? current.status;
    const [lead] = await tx
      .update(crmLeads)
      .set({
        ...fields,
        // The reason belongs to a disqualification; requalifying clears it.
        statusReason: status === "disqualified" ? (statusReason ?? current.statusReason) : null,
        revision: current.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(crmLeads.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [leadChange(lead!)]);
    return leadView(lead!);
  });
}

/**
 * Turns a qualified lead into a customer of the register (a new one, or an existing one it belongs
 * to). Its opportunities without a customer get this one. Creating a customer needs Customers write
 * access (the route checks it).
 */
export async function convertCrmLead(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: CrmLeadConvertInput,
) {
  return executeLedgerCommand(
    db,
    workspaceId,
    actorId,
    "crm.lead.convert",
    input,
    { id, ...input },
    async (tx) => {
      const lead = await loadLead(tx, workspaceId, id);
      requireRevision(lead, input.expectedRevision, "lead");
      if (lead.status === "converted") throw conflict("This lead is already converted");
      if (lead.status !== "qualified") throw conflict("Qualify the lead before converting it");
      let customerId: string;
      if (input.customer.mode === "new") {
        const { mode: _mode, ...customer } = input.customer;
        customerId = (await insertCustomer(tx, workspaceId, actorId, { ...customer, status: "active" })).id;
      } else {
        const customer = await findCustomer(tx, workspaceId, input.customer.customerId);
        if (customer.status !== "active") throw conflict("Choose an active customer");
        customerId = customer.id;
      }
      const [saved] = await tx
        .update(crmLeads)
        .set({
          status: "converted",
          statusReason: null,
          customerId,
          convertedAt: new Date(),
          convertedBy: actorId,
          revision: lead.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(crmLeads.id, id))
        .returning();
      const moved = await tx
        .update(crmOpportunities)
        .set({ customerId, revision: sql`${crmOpportunities.revision} + 1`, updatedAt: new Date() })
        .where(
          and(
            eq(crmOpportunities.workspaceId, workspaceId),
            eq(crmOpportunities.leadId, id),
            isNull(crmOpportunities.customerId),
          ),
        )
        .returning();
      await recordChanges(tx, workspaceId, actorId, [leadChange(saved!), ...moved.map(opportunityChange)]);
      return leadView(saved!);
    },
  );
}

// ─── Opportunities ──────────────────────────────────────────────────────────

const opportunityChange = (row: Opportunity) => ({
  entity: "crm_opportunity" as const,
  entityId: row.id,
  action: "upsert" as const,
  data: { id: row.id, revision: row.revision },
});

async function loadOpportunity(db: Executor, workspaceId: string, id: string, lock = false) {
  const query = db
    .select()
    .from(crmOpportunities)
    .where(and(eq(crmOpportunities.workspaceId, workspaceId), eq(crmOpportunities.id, id)));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Opportunity");
  return row;
}

const everyLink: CrmLinks = { sales: true, services: true, tasks: true };

/** The order or delivery project the opportunity's quote was handed off to, whoever can see it. */
async function handoffOf(db: Executor, workspaceId: string, row: Opportunity) {
  const [view] = await decorate(db, workspaceId, [row], everyLink);
  return view!.handoff;
}

/** The live order converted from a Sales quote (one cancelled while still a draft doesn't count). */
const liveOrderOf = (quoteIds: string[]) =>
  and(
    inArray(salesOrders.sourceQuoteId, quoteIds),
    eq(salesOrders.kind, "order"),
    or(ne(salesOrders.status, "cancelled"), isNotNull(salesOrders.confirmedAt)),
  );

/**
 * Resolves the stage, customer, lead and (when the caller can read them) the linked quote and its
 * handoff: the order converted from the Sales quote, or the delivery project of the service quote.
 * Links to a module the caller can't read stay ids only.
 */
async function decorate(db: Executor, workspaceId: string, rows: Opportunity[], links: CrmLinks) {
  if (rows.length === 0) return [];
  const ids = <K extends keyof Opportunity>(key: K) => [
    ...new Set(rows.flatMap((r) => (r[key] ? [r[key] as string] : []))),
  ];
  const stageIds = ids("stageId");
  const customerIds = ids("customerId");
  const leadIds = ids("leadId");
  const salesIds = links.sales ? ids("salesQuoteId") : [];
  const serviceIds = links.services ? ids("serviceQuoteId") : [];
  const stages = await db
    .select({ id: crmStages.id, name: crmStages.name, probability: crmStages.probability })
    .from(crmStages)
    .where(inArray(crmStages.id, stageIds));
  const customerRows = customerIds.length
    ? await db
        .select({ id: customers.id, code: customers.code, name: customers.name })
        .from(customers)
        .where(and(eq(customers.workspaceId, workspaceId), inArray(customers.id, customerIds)))
    : [];
  const leadRows = leadIds.length
    ? await db
        .select({
          id: crmLeads.id,
          reference: crmLeads.reference,
          name: crmLeads.name,
          company: crmLeads.company,
          status: crmLeads.status,
        })
        .from(crmLeads)
        .where(and(eq(crmLeads.workspaceId, workspaceId), inArray(crmLeads.id, leadIds)))
    : [];
  const salesRows = salesIds.length
    ? await db
        .select({
          id: salesOrders.id,
          reference: salesOrders.reference,
          status: salesOrders.status,
          revision: salesOrders.revision,
          currency: salesOrders.currency,
          validUntil: salesOrders.validUntil,
        })
        .from(salesOrders)
        .where(and(eq(salesOrders.workspaceId, workspaceId), inArray(salesOrders.id, salesIds)))
    : [];
  const orderRows = salesIds.length
    ? await db
        .select({
          id: salesOrders.id,
          reference: salesOrders.reference,
          status: salesOrders.status,
          sourceQuoteId: salesOrders.sourceQuoteId,
        })
        .from(salesOrders)
        .where(and(eq(salesOrders.workspaceId, workspaceId), liveOrderOf(salesIds)))
    : [];
  const serviceRows = serviceIds.length
    ? await db
        .select()
        .from(serviceQuotes)
        .where(and(eq(serviceQuotes.workspaceId, workspaceId), inArray(serviceQuotes.id, serviceIds)))
    : [];
  const projectIds = serviceRows.flatMap((q) => (q.projectId ? [q.projectId] : []));
  const projectRows =
    links.tasks && projectIds.length
      ? await db
          .select({ id: projects.id, name: projects.name, deletedAt: projects.deletedAt })
          .from(projects)
          .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, projectIds)))
      : [];
  const by = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
  const stageMap = by(stages);
  const customerMap = by(customerRows);
  const leadMap = by(leadRows);
  const salesMap = by(salesRows);
  const serviceMap = by(serviceRows);
  const projectMap = by(projectRows);
  const orderByQuote = new Map(orderRows.map((o) => [o.sourceQuoteId!, o]));
  return rows.map(({ workspaceId: _ws, ...row }) => {
    const sales = row.salesQuoteId ? salesMap.get(row.salesQuoteId) : undefined;
    const order = row.salesQuoteId ? orderByQuote.get(row.salesQuoteId) : undefined;
    const service = row.serviceQuoteId ? serviceMap.get(row.serviceQuoteId) : undefined;
    const project = service?.projectId ? projectMap.get(service.projectId) : undefined;
    const handoff = order
      ? { kind: "sales_order" as const, id: order.id, reference: order.reference, status: order.status }
      : service?.projectId
        ? {
            kind: "service_project" as const,
            id: service.projectId,
            reference: project && !project.deletedAt ? project.name : null,
            status: service.status,
          }
        : null;
    return {
      ...row,
      stage: stageMap.get(row.stageId) ?? null,
      customer: (row.customerId && customerMap.get(row.customerId)) || null,
      lead: (row.leadId && leadMap.get(row.leadId)) || null,
      salesQuote: sales ?? null,
      serviceQuote: service
        ? {
            id: service.id,
            reference: service.reference,
            title: service.title,
            status: service.status,
            revision: service.revision,
            currency: service.currency,
            quoteTotal: serviceQuoteAmount(service.unitPrice, service.quotedMinutes, service.currency),
          }
        : null,
      handoff,
    };
  });
}
export type CrmOpportunityView = Awaited<ReturnType<typeof decorate>>[number];

/** A quote may back an opportunity of the same customer, and only one. */
async function assertQuote(
  tx: Executor,
  workspaceId: string,
  kind: "sales" | "service",
  quoteId: string,
  customerId: string | null,
  opportunityId: string,
) {
  if (!customerId) throw conflict("Convert the lead or choose a customer before linking a quote");
  const [quote] =
    kind === "sales"
      ? await tx
          .select({ customerId: salesOrders.customerId, status: salesOrders.status, kind: salesOrders.kind })
          .from(salesOrders)
          .where(and(eq(salesOrders.workspaceId, workspaceId), eq(salesOrders.id, quoteId)))
      : await tx
          .select({
            customerId: serviceQuotes.customerId,
            status: serviceQuotes.status,
            projectId: serviceQuotes.projectId,
          })
          .from(serviceQuotes)
          .where(and(eq(serviceQuotes.workspaceId, workspaceId), eq(serviceQuotes.id, quoteId)));
  if (!quote || ("kind" in quote && quote.kind !== "quote")) throw notFound("Quote");
  if (quote.customerId !== customerId) throw conflict("The quote is for another customer");
  if (quote.status === "cancelled") throw conflict("The quote is cancelled");
  // A quote already turned into an order or a delivery project belongs to the deal that won it.
  const handedOff =
    "projectId" in quote
      ? quote.projectId !== null
      : (
          await tx
            .select({ id: salesOrders.id })
            .from(salesOrders)
            .where(and(eq(salesOrders.workspaceId, workspaceId), liveOrderOf([quoteId])))
            .limit(1)
        ).length > 0;
  if (handedOff) throw conflict("This quote was already handed off to delivery", "quote_handed_off");
  const column = kind === "sales" ? crmOpportunities.salesQuoteId : crmOpportunities.serviceQuoteId;
  const [taken] = await tx
    .select({ id: crmOpportunities.id })
    .from(crmOpportunities)
    .where(
      and(
        eq(crmOpportunities.workspaceId, workspaceId),
        eq(column, quoteId),
        ne(crmOpportunities.id, opportunityId),
      ),
    );
  if (taken) throw conflict("Another opportunity already has this quote", "quote_linked");
}

function opportunityFilters(workspaceId: string, query: Partial<CrmOpportunityListQuery>) {
  const filters: (SQL | undefined)[] = [
    eq(crmOpportunities.workspaceId, workspaceId),
    query.status && query.status !== "all" ? eq(crmOpportunities.status, query.status) : undefined,
    query.stageId ? eq(crmOpportunities.stageId, query.stageId) : undefined,
    query.ownerId ? eq(crmOpportunities.ownerId, query.ownerId) : undefined,
    query.customerId ? eq(crmOpportunities.customerId, query.customerId) : undefined,
    query.leadId ? eq(crmOpportunities.leadId, query.leadId) : undefined,
  ];
  return and(...filters);
}

export async function listCrmOpportunities(
  db: Database,
  workspaceId: string,
  query: CrmOpportunityListQuery,
  links: CrmLinks,
) {
  const rows = await db
    .select()
    .from(crmOpportunities)
    .where(
      and(
        opportunityFilters(workspaceId, query),
        query.before ? lt(crmOpportunities.id, query.before) : undefined,
      ),
    )
    .orderBy(desc(crmOpportunities.id))
    .limit(PAGE + 1);
  const page = rows.slice(0, PAGE);
  return {
    opportunities: await decorate(db, workspaceId, page, links),
    nextCursor: rows.length > PAGE ? page.at(-1)!.id : null,
  };
}

/** The board: open opportunities by stage with counts and totals per currency, and recent outcomes. */
export async function crmPipeline(
  db: Database,
  workspaceId: string,
  actorId: string,
  query: { ownerId?: string },
  links: CrmLinks,
) {
  const { stages } = await listCrmStages(db, workspaceId, actorId);
  const base = opportunityFilters(workspaceId, { ownerId: query.ownerId });
  const open = await db
    .select()
    .from(crmOpportunities)
    .where(and(base, eq(crmOpportunities.status, "open")))
    .orderBy(asc(crmOpportunities.expectedCloseDate), desc(crmOpportunities.id))
    .limit(500);
  const decorated = await decorate(db, workspaceId, open, links);
  const closed = async (status: "won" | "lost") => {
    const [total] = await db
      .select({ n: count() })
      .from(crmOpportunities)
      .where(and(base, eq(crmOpportunities.status, status)));
    const recent = await db
      .select()
      .from(crmOpportunities)
      .where(and(base, eq(crmOpportunities.status, status)))
      .orderBy(desc(crmOpportunities.closedAt))
      .limit(10);
    return { count: total?.n ?? 0, recent: await decorate(db, workspaceId, recent, links) };
  };
  return {
    stages: stages.map((stage) => {
      const items = decorated.filter((o) => o.stageId === stage.id);
      const totals = new Map<string, number>();
      for (const o of items)
        if (o.value !== null) totals.set(o.currency, (totals.get(o.currency) ?? 0) + o.value);
      return {
        ...stage,
        count: items.length,
        totals: [...totals].map(([currency, value]) => ({
          currency,
          value: value.toFixed(2),
          weighted: ((value * stage.probability) / 100).toFixed(2),
        })),
        opportunities: items,
      };
    }),
    // Open work on a stage that was archived since: reopening moves a deal to a live stage, but a
    // stage may still be archived under a concurrent move, so stay complete.
    unstaged: decorated.filter((o) => !stages.some((s) => s.id === o.stageId)),
    won: await closed("won"),
    lost: await closed("lost"),
    truncated: open.length === 500,
  };
}

export async function getCrmOpportunity(db: Database, workspaceId: string, id: string, links: CrmLinks) {
  const [view] = await decorate(db, workspaceId, [await loadOpportunity(db, workspaceId, id)], links);
  return {
    ...view!,
    activities: (await listCrmActivities(db, workspaceId, null, { ...allActivities, opportunityId: id }))
      .activities,
  };
}

export async function createCrmOpportunity(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  input: CrmOpportunityCreateInput,
  links: CrmLinks,
) {
  const row = await executeLedgerCommand(
    db,
    workspaceId,
    actorId,
    "crm.opportunity.create",
    input,
    input,
    async (tx) => {
      await assertOwner(tx, workspaceId, active, input.ownerId);
      let customerId = input.customerId;
      if (input.leadId) {
        const lead = await loadLead(tx, workspaceId, input.leadId);
        if (lead.status === "disqualified") throw conflict("The lead is disqualified");
        if (lead.customerId) {
          if (customerId && customerId !== lead.customerId)
            throw conflict("The lead was converted to another customer");
          customerId = lead.customerId;
        }
      }
      // A customer taken from a converted lead is already in the register; a chosen one must be active.
      if (input.customerId && customerId === input.customerId) {
        const customer = await findCustomer(tx, workspaceId, input.customerId);
        if (customer.status !== "active") throw conflict("Choose an active customer");
      }
      await seedStages(tx, workspaceId, actorId);
      const stageId = input.stageId
        ? (await findStage(tx, workspaceId, input.stageId)).id
        : (await liveStages(tx, workspaceId))[0]!.id;
      const id = newId();
      if (input.salesQuoteId) await assertQuote(tx, workspaceId, "sales", input.salesQuoteId, customerId, id);
      if (input.serviceQuoteId)
        await assertQuote(tx, workspaceId, "service", input.serviceQuoteId, customerId, id);
      const { commandId: _command, ...fields } = input;
      const [row] = await tx
        .insert(crmOpportunities)
        .values({
          ...fields,
          id,
          workspaceId,
          customerId,
          stageId,
          reference: `OP-${id.slice(-12).toUpperCase()}`,
          createdBy: actorId,
        })
        .returning();
      await recordChanges(tx, workspaceId, actorId, [opportunityChange(row!)]);
      return { id: row!.id };
    },
  );
  return getCrmOpportunity(db, workspaceId, row.id, links);
}

export async function updateCrmOpportunity(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  id: string,
  input: CrmOpportunityUpdateInput,
  links: CrmLinks,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await loadOpportunity(tx, workspaceId, id);
    requireRevision(current, input.expectedRevision, "opportunity");
    const { expectedRevision: _revision, ...fields } = input;
    if (current.status !== "open" && (fields.stageId !== undefined || fields.customerId !== undefined))
      throw conflict("Reopen the opportunity before moving it or changing its customer");
    const relinks = {
      sales: fields.salesQuoteId !== undefined && fields.salesQuoteId !== current.salesQuoteId,
      services: fields.serviceQuoteId !== undefined && fields.serviceQuoteId !== current.serviceQuoteId,
    };
    if (relinks.sales || relinks.services) {
      // The quote is the deal's handoff record: it stays fixed once the deal is closed or handed off.
      if (current.status !== "open") throw conflict("Reopen the opportunity before changing its quote");
      if (await handoffOf(tx, workspaceId, current))
        throw conflict("This opportunity was handed off. Correct it in Sales or Client services");
    }
    if (fields.stageId) await findStage(tx, workspaceId, fields.stageId);
    if (fields.ownerId !== undefined) await assertOwner(tx, workspaceId, active, fields.ownerId);
    const customerId = fields.customerId === undefined ? current.customerId : fields.customerId;
    if (fields.customerId !== undefined) {
      if (!customerId && !current.leadId) throw badRequest("Choose a customer or keep the lead");
      if (customerId && customerId !== current.customerId) {
        const customer = await findCustomer(tx, workspaceId, customerId);
        if (customer.status !== "active") throw conflict("Choose an active customer");
        if (current.leadId) {
          const lead = await loadLead(tx, workspaceId, current.leadId);
          if (lead.customerId && lead.customerId !== customerId)
            throw conflict("The lead was converted to another customer");
        }
      }
    }
    const salesQuoteId = fields.salesQuoteId === undefined ? current.salesQuoteId : fields.salesQuoteId;
    const serviceQuoteId =
      fields.serviceQuoteId === undefined ? current.serviceQuoteId : fields.serviceQuoteId;
    if (salesQuoteId && serviceQuoteId)
      throw badRequest("Link a Sales quote or a Client services quote, not both. Unlink the other first");
    // A link the caller can't see (its module is off or closed to them) can't be checked against a
    // new customer here: say so instead of naming a quote they can't open.
    if (customerId !== current.customerId) {
      const hidden =
        (salesQuoteId && !relinks.sales && !links.sales) ||
        (serviceQuoteId && !relinks.services && !links.services);
      if (hidden)
        throw conflict(
          "This opportunity is linked to a quote in a module you can't open. Ask someone with access to unlink it before changing the customer",
          "quote_hidden",
        );
    }
    // A changed customer must still match the linked quotes; a changed link must match the customer.
    if (salesQuoteId && (relinks.sales || fields.customerId !== undefined))
      await assertQuote(tx, workspaceId, "sales", salesQuoteId, customerId, id);
    if (serviceQuoteId && (relinks.services || fields.customerId !== undefined))
      await assertQuote(tx, workspaceId, "service", serviceQuoteId, customerId, id);
    const [row] = await tx
      .update(crmOpportunities)
      .set({ ...fields, revision: current.revision + 1, updatedAt: new Date() })
      .where(eq(crmOpportunities.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [opportunityChange(row!)]);
  });
  return getCrmOpportunity(db, workspaceId, id, links);
}

/** Records a won or lost outcome with its reason, or reopens a closed opportunity that wasn't handed off. */
export async function decideCrmOutcome(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: CrmOutcomeInput,
  links: CrmLinks,
) {
  await executeLedgerCommand(
    db,
    workspaceId,
    actorId,
    `crm.opportunity.${input.outcome}`,
    input,
    { id, ...input },
    async (tx) => {
      const current = await loadOpportunity(tx, workspaceId, id, true);
      requireRevision(current, input.expectedRevision, "opportunity");
      let stageId = current.stageId;
      if (input.outcome === "reopen") {
        if (current.status === "open") throw conflict("This opportunity is already open");
        if (await handoffOf(tx, workspaceId, current))
          throw conflict("This opportunity was handed off. Correct it in Sales or Client services");
        // Its stage may have been removed while the deal was closed: reopen on the first live one.
        const stages = await liveStages(tx, workspaceId);
        if (!stages.some((stage) => stage.id === stageId)) {
          if (!stages[0]) throw conflict("Add a pipeline stage before reopening");
          stageId = stages[0].id;
        }
      } else if (current.status !== "open") throw conflict("This opportunity is already closed");
      const outcome = input.outcome === "reopen" ? null : input.outcome;
      const closing = outcome !== null;
      const [row] = await tx
        .update(crmOpportunities)
        .set({
          status: outcome ?? "open",
          stageId,
          closedAt: closing ? new Date() : null,
          closedBy: closing ? actorId : null,
          closedReason: closing ? input.reason : null,
          revision: current.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(crmOpportunities.id, id))
        .returning();
      await recordChanges(tx, workspaceId, actorId, [opportunityChange(row!)]);
      return { id };
    },
  );
  return getCrmOpportunity(db, workspaceId, id, links);
}

/**
 * Hands a won opportunity to delivery through the linked quote's own workflow: Sales converts its
 * issued quote into a draft order, Client services records the customer's acceptance and creates
 * the delivery project. Already handed off the same way: returns the opportunity as it is (any other
 * handoff is refused, so a won deal is fulfilled once). The quote must still be for the opportunity's
 * customer, and the deal still won when the order or project is created. The route checks the
 * caller's Sales or Client services (and Tasks) access; this is a signed decision, never a token's.
 */
export async function handOffCrmOpportunity(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: CrmHandoffInput,
  links: CrmLinks,
) {
  await db.transaction(async (tx) => {
    // Serialised with reopen and relinking (both hold the workspace log lock), and the row is locked,
    // so the deal is still won when the order or project is created in this same transaction.
    await lockWorkspaceLog(tx, workspaceId);
    const opportunity = await loadOpportunity(tx, workspaceId, id, true);
    if (opportunity.status !== "won") throw conflict("Record the opportunity as won before handing it off");
    const existing = await handoffOf(tx, workspaceId, opportunity);
    // A retry of the same handoff returns it as it is; a won deal is never fulfilled a second way.
    if (existing && existing.kind !== input.kind)
      throw conflict("This opportunity was already handed off", "already_handed_off");
    if (opportunity.salesQuoteId && opportunity.serviceQuoteId)
      throw conflict("Unlink one of the two quotes before handing off");
    // The services open their own (nested) transactions; here they run inside this one.
    const inner = tx as unknown as Database;
    const reason = `${opportunity.reference} won: ${input.reason}`;
    const sameCustomer = (customerId: string) => {
      if (customerId !== opportunity.customerId)
        throw conflict(
          "The linked quote is now for another customer. Reopen the opportunity to link the right one",
        );
    };
    if (input.kind === "sales_order") {
      if (!opportunity.salesQuoteId) throw conflict("Link a Sales quote before handing off to an order");
      if (!existing) {
        const [quote] = await tx
          .select({
            revision: salesOrders.revision,
            customerId: salesOrders.customerId,
            kind: salesOrders.kind,
          })
          .from(salesOrders)
          .where(and(eq(salesOrders.workspaceId, workspaceId), eq(salesOrders.id, opportunity.salesQuoteId)));
        if (!quote || quote.kind !== "quote") throw notFound("Quote");
        sameCustomer(quote.customerId);
        await actOnSalesOrder(
          inner,
          workspaceId,
          actorId,
          opportunity.salesQuoteId,
          { commandId: input.commandId, expectedRevision: quote.revision, reason },
          "convert",
        );
      }
    } else {
      if (!opportunity.serviceQuoteId)
        throw conflict("Link a Client services quote before handing off to a delivery project");
      if (!existing) {
        const [quote] = await tx
          .select({
            status: serviceQuotes.status,
            revision: serviceQuotes.revision,
            customerId: serviceQuotes.customerId,
          })
          .from(serviceQuotes)
          .where(
            and(eq(serviceQuotes.workspaceId, workspaceId), eq(serviceQuotes.id, opportunity.serviceQuoteId)),
          );
        if (!quote) throw notFound("Quote");
        sameCustomer(quote.customerId);
        if (quote.status !== "issued") throw conflict("Issue the service quote before handing off");
        await decideServiceQuote(inner, workspaceId, actorId, opportunity.serviceQuoteId, {
          action: "accept",
          commandId: input.commandId,
          expectedRevision: quote.revision,
          reason,
          teamId: input.teamId,
          leadId: input.leadId,
        });
      }
    }
    // Open clients refresh the opportunity; its own fields don't change.
    await recordChanges(tx, workspaceId, actorId, [opportunityChange(opportunity)]);
  });
  return getCrmOpportunity(db, workspaceId, id, links);
}

/** Quotes of the opportunity's customer it could link to, from the modules the caller can read. */
export async function crmQuoteOptions(db: Database, workspaceId: string, id: string, links: CrmLinks) {
  const opportunity = await loadOpportunity(db, workspaceId, id);
  if (!opportunity.customerId) return { sales: [], services: [] };
  const linked = await db
    .select({ sales: crmOpportunities.salesQuoteId, service: crmOpportunities.serviceQuoteId })
    .from(crmOpportunities)
    .where(
      and(
        eq(crmOpportunities.workspaceId, workspaceId),
        ne(crmOpportunities.id, id),
        or(isNotNull(crmOpportunities.salesQuoteId), isNotNull(crmOpportunities.serviceQuoteId)),
      ),
    );
  const taken = new Set(linked.flatMap((l) => [l.sales, l.service].filter((v) => v !== null)));
  const sales = links.sales
    ? await db
        .select({
          id: salesOrders.id,
          reference: salesOrders.reference,
          status: salesOrders.status,
          currency: salesOrders.currency,
          validUntil: salesOrders.validUntil,
        })
        .from(salesOrders)
        .where(
          and(
            eq(salesOrders.workspaceId, workspaceId),
            eq(salesOrders.customerId, opportunity.customerId),
            eq(salesOrders.kind, "quote"),
            ne(salesOrders.status, "cancelled"),
          ),
        )
        .orderBy(desc(salesOrders.createdAt))
        .limit(100)
    : [];
  const services = links.services
    ? (
        await db
          .select()
          .from(serviceQuotes)
          .where(
            and(
              eq(serviceQuotes.workspaceId, workspaceId),
              eq(serviceQuotes.customerId, opportunity.customerId),
              ne(serviceQuotes.status, "cancelled"),
              isNull(serviceQuotes.projectId),
            ),
          )
          .orderBy(desc(serviceQuotes.id))
          .limit(100)
      ).map((q) => ({
        id: q.id,
        reference: q.reference,
        title: q.title,
        status: q.status,
        currency: q.currency,
        quoteTotal: serviceQuoteAmount(q.unitPrice, q.quotedMinutes, q.currency),
      }))
    : [];
  // A quote already turned into an order belongs to the deal that won it.
  const ordered = sales.length
    ? await db
        .select({ quoteId: salesOrders.sourceQuoteId })
        .from(salesOrders)
        .where(and(eq(salesOrders.workspaceId, workspaceId), liveOrderOf(sales.map((q) => q.id))))
    : [];
  for (const order of ordered) if (order.quoteId) taken.add(order.quoteId);
  return {
    sales: sales.filter((q) => !taken.has(q.id)),
    services: services.filter((q) => !taken.has(q.id)),
  };
}

// ─── Activities and follow-ups ──────────────────────────────────────────────

const allActivities: CrmActivityListQuery = { owner: "all", status: "all", limit: 100, offset: 0 };

async function decorateActivities(db: Executor, workspaceId: string, rows: Activity[]) {
  const leadIds = [...new Set(rows.flatMap((r) => (r.leadId ? [r.leadId] : [])))];
  const opportunityIds = [...new Set(rows.flatMap((r) => (r.opportunityId ? [r.opportunityId] : [])))];
  const leads = leadIds.length
    ? await db
        .select({
          id: crmLeads.id,
          reference: crmLeads.reference,
          name: crmLeads.name,
          company: crmLeads.company,
        })
        .from(crmLeads)
        .where(and(eq(crmLeads.workspaceId, workspaceId), inArray(crmLeads.id, leadIds)))
    : [];
  const opportunities = opportunityIds.length
    ? await db
        .select({
          id: crmOpportunities.id,
          reference: crmOpportunities.reference,
          title: crmOpportunities.title,
        })
        .from(crmOpportunities)
        .where(
          and(eq(crmOpportunities.workspaceId, workspaceId), inArray(crmOpportunities.id, opportunityIds)),
        )
    : [];
  const leadMap = new Map(leads.map((l) => [l.id, l]));
  const opportunityMap = new Map(opportunities.map((o) => [o.id, o]));
  return rows.map(({ workspaceId: _ws, ...row }) => ({
    ...row,
    lead: (row.leadId && leadMap.get(row.leadId)) || null,
    opportunity: (row.opportunityId && opportunityMap.get(row.opportunityId)) || null,
  }));
}

/** Open follow-ups first by due date (undated last); done ones newest first. */
export async function listCrmActivities(
  db: Executor,
  workspaceId: string,
  viewerId: string | null,
  query: CrmActivityListQuery,
) {
  const where = and(
    eq(crmActivities.workspaceId, workspaceId),
    query.leadId ? eq(crmActivities.leadId, query.leadId) : undefined,
    query.opportunityId ? eq(crmActivities.opportunityId, query.opportunityId) : undefined,
    query.owner === "mine" && viewerId ? eq(crmActivities.ownerId, viewerId) : undefined,
    query.status === "open"
      ? isNull(crmActivities.completedAt)
      : query.status === "done"
        ? isNotNull(crmActivities.completedAt)
        : undefined,
    query.dueBy ? lte(crmActivities.dueOn, query.dueBy) : undefined,
  );
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(crmActivities)
      .where(where)
      .orderBy(
        sql`${crmActivities.completedAt} is not null`,
        sql`${crmActivities.completedAt} desc nulls last`,
        sql`${crmActivities.dueOn} asc nulls last`,
        desc(crmActivities.id),
      )
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(crmActivities).where(where),
  ]);
  return {
    activities: await decorateActivities(db, workspaceId, rows),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

async function activitySubject(
  tx: Executor,
  workspaceId: string,
  row: { leadId: string | null; opportunityId: string | null },
) {
  if (row.leadId) {
    const lead = await loadLead(tx, workspaceId, row.leadId);
    return { crmRecord: "lead" as const, subjectId: lead.id, label: lead.company || lead.name };
  }
  const opportunity = await loadOpportunity(tx, workspaceId, row.opportunityId!);
  return { crmRecord: "opportunity" as const, subjectId: opportunity.id, label: opportunity.title };
}

const activityChange = (row: Activity) => ({
  entity: "crm_activity" as const,
  entityId: row.id,
  action: "upsert" as const,
  data: { id: row.id },
});

async function notifyOwner(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  row: Activity,
): Promise<NotificationRow[]> {
  if (!row.ownerId || row.ownerId === actorId || row.completedAt) return [];
  const subject = await activitySubject(tx, workspaceId, row);
  return insertNotifications(tx, workspaceId, actorId, [
    {
      userId: row.ownerId,
      type: "crm_follow_up_assigned",
      module: "crm",
      data: {
        title: `${row.subject} (${subject.label})`,
        subjectId: subject.subjectId,
        crmRecord: subject.crmRecord,
        dueOn: row.dueOn,
        dueState: "due",
      },
    },
  ]);
}

export async function createCrmActivity(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  input: CrmActivityCreateInput,
  onNotified: NotifiedCallback,
) {
  let notified: NotificationRow[] = [];
  const activity = await executeLedgerCommand(
    db,
    workspaceId,
    actorId,
    "crm.activity.create",
    input,
    input,
    async (tx) => {
      await activitySubject(tx, workspaceId, input);
      const ownerId = input.ownerId === undefined ? actorId : input.ownerId;
      await assertOwner(tx, workspaceId, active, ownerId);
      const { commandId: _command, done, ...fields } = input;
      const [row] = await tx
        .insert(crmActivities)
        .values({
          ...fields,
          ownerId,
          workspaceId,
          createdBy: actorId,
          ...(done ? { completedAt: new Date(), completedBy: actorId } : {}),
        })
        .returning();
      await recordChanges(tx, workspaceId, actorId, [activityChange(row!)]);
      notified = await notifyOwner(tx, workspaceId, actorId, row!);
      return (await decorateActivities(tx, workspaceId, [row!]))[0]!;
    },
  );
  if (notified.length) onNotified(notified);
  return activity;
}

export async function updateCrmActivity(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  id: string,
  input: CrmActivityUpdateInput,
  onNotified: NotifiedCallback,
) {
  let notified: NotificationRow[] = [];
  const activity = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [current] = await tx
      .select()
      .from(crmActivities)
      .where(and(eq(crmActivities.workspaceId, workspaceId), eq(crmActivities.id, id)));
    if (!current) throw notFound("Activity");
    if (input.ownerId !== undefined) await assertOwner(tx, workspaceId, active, input.ownerId);
    const { done, ...fields } = input;
    const [row] = await tx
      .update(crmActivities)
      .set({
        ...fields,
        ...(done === true && !current.completedAt ? { completedAt: new Date(), completedBy: actorId } : {}),
        ...(done === false ? { completedAt: null, completedBy: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(crmActivities.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [activityChange(row!)]);
    if (input.ownerId !== undefined && input.ownerId !== current.ownerId)
      notified = await notifyOwner(tx, workspaceId, actorId, row!);
    return (await decorateActivities(tx, workspaceId, [row!]))[0]!;
  });
  if (notified.length) onNotified(notified);
  return activity;
}

/** Open, owned follow-ups due between `from` and `to` (inclusive), for the notification sweep. */
export async function crmFollowUpsDue(db: Executor, workspaceId: string, from: string, to: string) {
  const rows = await db
    .select()
    .from(crmActivities)
    .where(
      and(
        eq(crmActivities.workspaceId, workspaceId),
        isNull(crmActivities.completedAt),
        isNotNull(crmActivities.ownerId),
        gte(crmActivities.dueOn, from),
        lte(crmActivities.dueOn, to),
      ),
    )
    .orderBy(asc(crmActivities.dueOn))
    .limit(2000);
  return decorateActivities(db, workspaceId, rows);
}
