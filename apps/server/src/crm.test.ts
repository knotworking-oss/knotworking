import { addDaysToIsoDate, DEFAULT_TIME_ZONE, newId, todayInZone, type ModuleId } from "@knotworking/core";
import {
  crmActivities,
  crmLeads,
  crmOpportunities,
  crmStages,
  customers,
  salesOrders,
  syncChanges,
  workspaces,
} from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepDueNotifications } from "./services/notification-sweep";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const base = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

type Ids = Record<"workspace" | "team" | "ada" | "marcus" | "priya", string>;
type Session = { ctx: TestCtx; ada: string; marcus: string; priya: string; ids: Ids };

/** An opportunity as the handoff dialog sees it when opened. */
type Deal = {
  id: string;
  revision: number;
  salesQuoteId?: string | null;
  serviceQuoteId?: string | null;
  salesQuote?: { revision: number } | null;
  serviceQuote?: { revision: number } | null;
};
/** The opportunity revision and quote (with its revision) a handoff was reviewed against. */
const reviewed = (o: Deal) => ({
  expectedRevision: o.revision,
  quoteId: o.salesQuoteId ?? o.serviceQuoteId ?? newId(),
  quoteRevision: (o.salesQuote ?? o.serviceQuote)?.revision ?? 1,
});

async function open(activeModules?: readonly ModuleId[]): Promise<Session> {
  const ctx = await makeApp({ seed: true, activeModules });
  const ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  const marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
  const priya = (await signIn(ctx, "priya@knotworking.dev")).cookie;
  const boot = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();
  const user = (email: string) => boot.users.find((u: { email: string }) => u.email === email).id;
  return {
    ctx,
    ada,
    marcus,
    priya,
    ids: {
      workspace: boot.workspace.id,
      team: boot.teams[0].id,
      ada: user("ada@knotworking.dev"),
      marcus: user("marcus@knotworking.dev"),
      priya: user("priya@knotworking.dev"),
    },
  };
}

function client(s: Session) {
  const body = async (response: Res, status = 200) => {
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(status);
    return result;
  };
  const req = (method: string, path: string, json?: unknown, cookie = s.ada) =>
    s.ctx.req(`${base}${path}`, { method, cookie, json });
  const grant = async (userId: string, module: string, level: string) =>
    body(await req("PUT", `/members/${userId}/module-access/${module}`, { level }));
  return { body, req, grant };
}

describe("CRM pipeline with Sales and Client services", () => {
  let s: Session;
  let api: ReturnType<typeof client>;
  beforeAll(async () => {
    s = await open();
    api = client(s);
  }, 60_000);
  afterAll(() => s?.ctx.handle.close());

  it("starts with default stages that a manager can rename, reorder and extend", async () => {
    const { body, req } = api;
    const { stages } = await body(await req("GET", "/crm/stages"));
    expect(stages.map((stage: { name: string }) => stage.name)).toEqual([
      "Qualification",
      "Needs analysis",
      "Proposal",
      "Negotiation",
    ]);
    // A second read does not seed again.
    expect((await body(await req("GET", "/crm/stages"))).stages).toHaveLength(4);
    const saved = await body(
      await req("PUT", "/crm/stages", {
        stages: [
          { id: stages[0].id, name: "Discovery", probability: 10 },
          { id: stages[2].id, name: "Proposal", probability: 50 },
          { id: stages[1].id, name: "Needs analysis", probability: 30 },
          { id: stages[3].id, name: "Negotiation", probability: 80 },
          { name: "Contract review", probability: 90 },
        ],
      }),
    );
    expect(saved.stages.map((stage: { name: string }) => stage.name)).toEqual([
      "Discovery",
      "Proposal",
      "Needs analysis",
      "Negotiation",
      "Contract review",
    ]);
    await body(
      await req("PUT", "/crm/stages", {
        stages: [
          { name: "A", probability: 1 },
          { name: "a", probability: 2 },
        ],
      }),
      400,
    );
  });

  it("takes a lead through conversion, a service quote and a win to the delivery project", async () => {
    const { body, req, grant } = api;
    // Owners need CRM access.
    await body(
      await req("POST", "/crm/leads", { commandId: newId(), name: "Jo Rivers", ownerId: s.ids.marcus }),
      400,
    );
    const create = { commandId: newId(), name: "Jo Rivers", company: "Rivers Studio", source: "Referral" };
    const lead = await body(await req("POST", "/crm/leads", create), 201);
    expect(await body(await req("POST", "/crm/leads", create), 201)).toEqual(lead);
    expect(lead).toMatchObject({ status: "new", reference: expect.stringMatching(/^LD-/), revision: 1 });

    const opportunity = await body(
      await req("POST", "/crm/opportunities", {
        commandId: newId(),
        title: "Studio workflow review",
        leadId: lead.id,
        value: 1800,
        currency: "GBP",
        expectedCloseDate: "2027-02-01",
      }),
      201,
    );
    expect(opportunity).toMatchObject({
      status: "open",
      customerId: null,
      stage: { name: "Discovery" },
      lead: { id: lead.id, name: "Jo Rivers" },
    });

    const convert = (revision: number) => ({
      commandId: newId(),
      expectedRevision: revision,
      customer: { mode: "new", code: "RIV", name: "Rivers Studio", address: "4 Mill Lane" },
    });
    expect(
      (await body(await req("POST", `/crm/leads/${lead.id}/convert`, convert(1)), 409)).error.message,
    ).toMatch(/Qualify/);
    const qualified = await body(
      await req("PATCH", `/crm/leads/${lead.id}`, { expectedRevision: 1, status: "qualified" }),
    );
    const converted = await body(
      await req("POST", `/crm/leads/${lead.id}/convert`, convert(qualified.revision)),
    );
    expect(converted).toMatchObject({ status: "converted", customerId: expect.any(String) });
    const customer = await body(await req("GET", `/customers/${converted.customerId}`));
    expect(customer).toMatchObject({ code: "RIV", name: "Rivers Studio", status: "active" });
    await body(await req("PATCH", `/crm/leads/${lead.id}`, { expectedRevision: 3, notes: "x" }), 409);

    const withCustomer = await body(await req("GET", `/crm/opportunities/${opportunity.id}`));
    expect(withCustomer.customer).toMatchObject({ id: customer.id, name: "Rivers Studio" });

    const quote = await body(
      await req("POST", "/client-services", {
        commandId: newId(),
        customerId: customer.id,
        title: "Workflow review",
        scope: "Interview the team and recommend changes",
        currency: "GBP",
        unitPrice: 1800,
        quotedMinutes: null,
        deliveryDate: "2027-03-01",
      }),
      201,
    );
    const options = await body(await req("GET", `/crm/opportunities/${opportunity.id}/quote-options`));
    expect(options.services.map((q: { id: string }) => q.id)).toContain(quote.id);
    const proposal = (await body(await req("GET", "/crm/stages"))).stages.find(
      (stage: { name: string }) => stage.name === "Proposal",
    );
    const linked = await body(
      await req("PATCH", `/crm/opportunities/${opportunity.id}`, {
        expectedRevision: withCustomer.revision,
        serviceQuoteId: quote.id,
        stageId: proposal.id,
      }),
    );
    expect(linked).toMatchObject({
      stage: { name: "Proposal" },
      serviceQuote: { id: quote.id, status: "draft", quoteTotal: "1800.00" },
      handoff: null,
    });

    // A follow-up for a teammate notifies them.
    for (const module of ["customers", "crm"]) await grant(s.ids.priya, module, "write");
    const followUp = await body(
      await req("POST", "/crm/activities", {
        commandId: newId(),
        opportunityId: opportunity.id,
        kind: "call",
        subject: "Walk through the proposal",
        dueOn: today,
        ownerId: s.ids.priya,
      }),
      201,
    );
    expect(followUp).toMatchObject({ completedAt: null, opportunity: { id: opportunity.id } });
    const inbox = await body(await req("GET", "/notifications", undefined, s.priya));
    expect(inbox.notifications).toContainEqual(
      expect.objectContaining({
        type: "crm_follow_up_assigned",
        data: expect.objectContaining({ subjectId: opportunity.id, crmRecord: "opportunity" }),
      }),
    );
    const mine = await body(
      await req("GET", `/crm/activities?owner=mine&dueBy=${today}`, undefined, s.priya),
    );
    expect(mine.activities.map((a: { id: string }) => a.id)).toEqual([followUp.id]);
    const done = await body(await req("PATCH", `/crm/activities/${followUp.id}`, { done: true }, s.priya));
    expect(done.completedAt).not.toBeNull();

    // The dialog sends what it reviewed: the opportunity and quote revisions as opened.
    const handoffOf = (o: Deal, commandId = newId()) => ({
      commandId,
      kind: "service_project",
      reason: "Signed by email",
      teamId: s.ids.team,
      leadId: s.ids.ada,
      ...reviewed(o),
    });
    await body(await req("POST", `/crm/opportunities/${opportunity.id}/handoff`, handoffOf(linked)), 409);
    const won = await body(
      await req("POST", `/crm/opportunities/${opportunity.id}/outcome`, {
        commandId: newId(),
        expectedRevision: linked.revision,
        outcome: "won",
        reason: "Customer accepted the proposal",
      }),
    );
    expect(won).toMatchObject({ status: "won", closedReason: "Customer accepted the proposal" });
    // The service quote must be issued before the customer's acceptance is recorded.
    expect(
      (await body(await req("POST", `/crm/opportunities/${opportunity.id}/handoff`, handoffOf(won)), 409))
        .error.message,
    ).toMatch(/Issue/);
    await body(
      await req("POST", `/client-services/${quote.id}/decision`, {
        commandId: newId(),
        expectedRevision: quote.revision,
        action: "issue",
        reason: "Scope checked",
      }),
    );
    // Reviewed before the quote was issued: the person must look at the issued quote.
    expect(
      (await body(await req("POST", `/crm/opportunities/${opportunity.id}/handoff`, handoffOf(won)), 409))
        .error.message,
    ).toMatch(/quote changed/);
    const handoff = handoffOf(await body(await req("GET", `/crm/opportunities/${opportunity.id}`)));
    const handed = await body(await req("POST", `/crm/opportunities/${opportunity.id}/handoff`, handoff));
    expect(handed.handoff).toMatchObject({
      kind: "service_project",
      id: expect.any(String),
      status: "accepted",
    });
    expect(
      await body(await req("POST", `/crm/opportunities/${opportunity.id}/handoff`, handoff)),
    ).toMatchObject({
      handoff: { id: handed.handoff.id },
    });
    const accepted = await body(await req("GET", `/client-services/${quote.id}`));
    expect(accepted).toMatchObject({ status: "accepted", projectId: handed.handoff.id });
    expect(accepted.history[0].reason).toContain(opportunity.reference);
    await body(
      await req("POST", `/crm/opportunities/${opportunity.id}/outcome`, {
        commandId: newId(),
        expectedRevision: won.revision,
        outcome: "reopen",
        reason: "Mistake",
      }),
      409,
    );

    // Handing off is a person's decision.
    const token = (
      await body(
        await s.ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: s.ada,
          json: { name: "CRM agent", scope: "write" },
        }),
        201,
      )
    ).token;
    const byToken = await s.ctx.req(`${base}/crm/opportunities/${opportunity.id}/handoff`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "" },
      json: { ...handoff, commandId: newId() },
    });
    expect(byToken.status).toBe(403);
    expect((await byToken.json()).error.code).toBe("token_not_allowed");
    const leads = await s.ctx.req(`${base}/crm/leads`, {
      headers: { authorization: `Bearer ${token}`, origin: "" },
    });
    expect(leads.status).toBe(200);

    const sync = await body(await req("GET", "/sync?after=0&limit=1000"));
    const kinds = new Set(sync.changes.map((change: { entity: string }) => change.entity));
    for (const kind of ["crm_stage", "crm_lead", "crm_opportunity", "crm_activity"])
      expect(kinds).toContain(kind);
    // The replica carries ids and revisions only.
    expect(JSON.stringify(sync)).not.toContain("Walk through the proposal");
    expect(JSON.stringify(sync)).not.toContain("Customer accepted the proposal");
  });

  it("hands a won Sales quote off to a draft order and records a lost deal", async () => {
    const { body, req } = api;
    const customer = await body(
      await req("POST", "/customers", { code: "HARB", name: "Harbour Deli", address: "2 Quay Street" }),
      201,
    );
    const other = await body(
      await req("POST", "/customers", { code: "OTHR", name: "Other Shop", address: "9 Side Road" }),
      201,
    );
    const item = await body(
      await req("POST", "/items", { code: "CRM-SOUP", name: "Tomato soup", type: "finished", unit: "kg" }),
      201,
    );
    const salesQuote = await body(
      await req("POST", "/sales/orders", {
        commandId: newId(),
        kind: "quote",
        document: {
          customerId: customer.id,
          currency: "GBP",
          lines: [{ itemId: item.id, quantity: 20, unit: "kg", dueOn: today, unitPrice: 4 }],
        },
      }),
      201,
    );
    const make = (title: string, extra: object = {}) =>
      req("POST", "/crm/opportunities", {
        commandId: newId(),
        title,
        customerId: customer.id,
        value: 80,
        currency: "GBP",
        ...extra,
      });
    const deal = await body(await make("Weekly soup supply", { salesQuoteId: salesQuote.id }), 201);
    expect(deal.salesQuote).toMatchObject({ id: salesQuote.id, status: "draft" });
    // A quote backs one opportunity, of its own customer.
    expect((await body(await make("Duplicate", { salesQuoteId: salesQuote.id }), 409)).error.code).toBe(
      "quote_linked",
    );
    await body(
      await req("POST", "/crm/opportunities", {
        commandId: newId(),
        title: "Wrong customer",
        customerId: other.id,
        currency: "GBP",
        salesQuoteId: salesQuote.id,
      }),
      409,
    );

    const issued = await body(
      await req("POST", `/sales/orders/${salesQuote.id}/issue`, {
        commandId: newId(),
        expectedRevision: salesQuote.revision,
        reason: "Prices agreed",
      }),
    );
    expect(issued.status).toBe("issued");
    const won = await body(
      await req("POST", `/crm/opportunities/${deal.id}/outcome`, {
        commandId: newId(),
        expectedRevision: deal.revision,
        outcome: "won",
        reason: "Verbal yes from the buyer",
      }),
    );
    const handoff = {
      commandId: newId(),
      kind: "sales_order",
      reason: "Order the first month",
      ...reviewed(won),
    };
    const handed = await body(await req("POST", `/crm/opportunities/${deal.id}/handoff`, handoff));
    expect(handed.handoff).toMatchObject({
      kind: "sales_order",
      status: "draft",
      reference: expect.stringMatching(/^SO-/),
    });
    const order = await body(await req("GET", `/sales/orders/${handed.handoff.id}`));
    expect(order).toMatchObject({ kind: "order", sourceQuoteId: salesQuote.id, customerId: customer.id });
    // A retry returns the same order.
    expect((await body(await req("POST", `/crm/opportunities/${deal.id}/handoff`, handoff))).handoff.id).toBe(
      order.id,
    );
    expect(won.status).toBe("won");

    const lost = await body(await make("Christmas hampers"), 201);
    const lostOutcome = {
      commandId: newId(),
      expectedRevision: lost.revision,
      outcome: "lost",
      reason: "Went with a cheaper supplier",
    };
    const closed = await body(await req("POST", `/crm/opportunities/${lost.id}/outcome`, lostOutcome));
    expect(closed).toMatchObject({ status: "lost", closedReason: "Went with a cheaper supplier" });
    expect(await body(await req("POST", `/crm/opportunities/${lost.id}/outcome`, lostOutcome))).toMatchObject(
      {
        status: "lost",
      },
    );
    await body(
      await req("POST", `/crm/opportunities/${lost.id}/handoff`, { ...handoff, commandId: newId() }),
      409,
    );
    await body(
      await req("PATCH", `/crm/opportunities/${lost.id}`, {
        expectedRevision: closed.revision,
        stageId: lost.stageId,
      }),
      409,
    );

    const pipeline = await body(await req("GET", "/crm/pipeline"));
    expect(pipeline.won.recent.map((o: { id: string }) => o.id)).toContain(deal.id);
    expect(pipeline.lost.recent.map((o: { id: string }) => o.id)).toContain(lost.id);
    expect(
      pipeline.stages.flatMap((stage: { opportunities: { id: string }[] }) => stage.opportunities),
    ).not.toContainEqual(expect.objectContaining({ id: deal.id }));

    const reopened = await body(
      await req("POST", `/crm/opportunities/${lost.id}/outcome`, {
        commandId: newId(),
        expectedRevision: closed.revision,
        outcome: "reopen",
        reason: "Buyer came back",
      }),
    );
    expect(reopened).toMatchObject({ status: "open", closedAt: null, closedReason: null });
    const stage = (await body(await req("GET", "/crm/pipeline"))).stages.find(
      (st: { id: string }) => st.id === reopened.stageId,
    );
    expect(stage.opportunities.map((o: { id: string }) => o.id)).toContain(lost.id);
    expect(stage.totals).toContainEqual(expect.objectContaining({ currency: "GBP" }));
    // A stage holding open work can't be removed.
    const { stages } = await body(await req("GET", "/crm/stages"));
    expect(
      (
        await body(
          await req("PUT", "/crm/stages", {
            stages: stages
              .filter((st: { id: string }) => st.id !== reopened.stageId)
              .map((st: { id: string; name: string; probability: number }) => ({
                id: st.id,
                name: st.name,
                probability: st.probability,
              })),
          }),
          409,
        )
      ).error.code,
    ).toBe("stage_in_use");
  });

  it("is opt-in and closed without access to Customers", async () => {
    const { body, req, grant } = api;
    expect((await body(await req("GET", "/crm/leads", undefined, s.marcus), 403)).error.code).toBe(
      "module_forbidden",
    );
    await grant(s.ids.marcus, "crm", "write");
    // CRM depends on Customers: without it, CRM stays closed.
    await body(await req("GET", "/crm/leads", undefined, s.marcus), 403);
    await grant(s.ids.marcus, "customers", "read");
    await body(await req("GET", "/crm/leads", undefined, s.marcus));
    // Converting into a new customer writes to the register.
    const lead = await body(
      await req(
        "POST",
        "/crm/leads",
        { commandId: newId(), name: "Sam Hill", company: "Hill Farm" },
        s.marcus,
      ),
      201,
    );
    const qualified = await body(
      await req("PATCH", `/crm/leads/${lead.id}`, { expectedRevision: 1, status: "qualified" }, s.marcus),
    );
    const convert = {
      commandId: newId(),
      expectedRevision: qualified.revision,
      customer: { mode: "new", code: "HILL", name: "Hill Farm", address: "Hill Road" },
    };
    expect(
      (await body(await req("POST", `/crm/leads/${lead.id}/convert`, convert, s.marcus), 403)).error.code,
    ).toBe("module_forbidden");
    // Sales is unreadable to this member: quotes stay hidden and can't be linked.
    const opportunity = await body(
      await req(
        "POST",
        "/crm/opportunities",
        { commandId: newId(), title: "Farm shop", leadId: lead.id, currency: "GBP" },
        s.marcus,
      ),
      201,
    );
    expect(
      (
        await body(
          await req(
            "PATCH",
            `/crm/opportunities/${opportunity.id}`,
            { expectedRevision: opportunity.revision, salesQuoteId: newId() },
            s.marcus,
          ),
          403,
        )
      ).error.code,
    ).toBe("module_forbidden");
    expect(
      await body(await req("GET", `/crm/opportunities/${opportunity.id}/quote-options`, undefined, s.marcus)),
    ).toEqual({ sales: [], services: [], nextCursor: { sales: null, services: null } });
  });

  it("reminds owners of follow-ups as they fall due", async () => {
    const { body, req } = api;
    const lead = await body(await req("POST", "/crm/leads", { commandId: newId(), name: "Lee Park" }), 201);
    const activity = await body(
      await req("POST", "/crm/activities", {
        commandId: newId(),
        leadId: lead.id,
        kind: "email",
        subject: "Send the brochure",
        dueOn: today,
      }),
      201,
    );
    expect(activity.ownerId).toBe(s.ids.ada);
    const result = await sweepDueNotifications(s.ctx.handle.db, {
      activeModules: ["customers", "crm"],
      workspaceId: s.ids.workspace,
    });
    expect(result.created).toContainEqual(
      expect.objectContaining({
        type: "crm_follow_up_due",
        userId: s.ids.ada,
        data: expect.objectContaining({ subjectId: lead.id, crmRecord: "lead", dueState: "due" }),
      }),
    );
    const again = await sweepDueNotifications(s.ctx.handle.db, {
      activeModules: ["customers", "crm"],
      workspaceId: s.ids.workspace,
    });
    expect(again.created.filter((n) => n.type === "crm_follow_up_due")).toEqual([]);
  });
});

describe("CRM keeps a won deal's quote and handoff consistent", () => {
  let s: Session;
  let api: ReturnType<typeof client>;
  let customer: { id: string };
  let other: { id: string };
  let itemId: string;
  beforeAll(async () => {
    s = await open();
    api = client(s);
    const { body, req } = api;
    customer = await body(
      await req("POST", "/customers", { code: "KEEP", name: "Keep Foods", address: "1 Dock Road" }),
      201,
    );
    other = await body(
      await req("POST", "/customers", { code: "ELSE", name: "Else Foods", address: "2 Dock Road" }),
      201,
    );
    itemId = (
      await body(
        await req("POST", "/items", { code: "CRM-KEEP", name: "Pea soup", type: "finished", unit: "kg" }),
        201,
      )
    ).id;
  }, 60_000);
  afterAll(() => s?.ctx.handle.close());

  const document = (customerId: string) => ({
    customerId,
    currency: "GBP",
    lines: [{ itemId, quantity: 5, unit: "kg", dueOn: today, unitPrice: 3 }],
  });
  const salesQuote = async (issue = true, customerId = customer.id) => {
    const { body, req } = api;
    const quote = await body(
      await req("POST", "/sales/orders", {
        commandId: newId(),
        kind: "quote",
        document: document(customerId),
      }),
      201,
    );
    if (!issue) return quote;
    return body(
      await req("POST", `/sales/orders/${quote.id}/issue`, {
        commandId: newId(),
        expectedRevision: quote.revision,
        reason: "Prices agreed",
      }),
    );
  };
  const serviceQuote = async (issue = true) => {
    const { body, req } = api;
    const quote = await body(
      await req("POST", "/client-services", {
        commandId: newId(),
        customerId: customer.id,
        title: "Kitchen audit",
        scope: "Review the line",
        currency: "GBP",
        unitPrice: 500,
        quotedMinutes: null,
        deliveryDate: "2027-03-01",
      }),
      201,
    );
    if (!issue) return quote;
    return body(
      await req("POST", `/client-services/${quote.id}/decision`, {
        commandId: newId(),
        expectedRevision: quote.revision,
        action: "issue",
        reason: "Scope checked",
      }),
    );
  };
  const make = async (title: string, extra: object = {}, status = 201) =>
    api.body(
      await api.req("POST", "/crm/opportunities", {
        commandId: newId(),
        title,
        customerId: customer.id,
        currency: "GBP",
        ...extra,
      }),
      status,
    );
  const outcome = async (
    o: { id: string; revision: number },
    kind: "won" | "lost" | "reopen",
    status = 200,
  ) =>
    api.body(
      await api.req("POST", `/crm/opportunities/${o.id}/outcome`, {
        commandId: newId(),
        expectedRevision: o.revision,
        outcome: kind,
        reason: `Recorded ${kind}`,
      }),
      status,
    );
  const patch = async (o: { id: string; revision: number }, json: object, status = 200, cookie?: string) =>
    api.body(
      await api.req("PATCH", `/crm/opportunities/${o.id}`, { expectedRevision: o.revision, ...json }, cookie),
      status,
    );
  const handoff = async (o: Deal, json: object, status = 200, cookie?: string) =>
    api.body(
      await api.req(
        "POST",
        `/crm/opportunities/${o.id}/handoff`,
        {
          commandId: newId(),
          reason: "Signed",
          teamId: s.ids.team,
          leadId: s.ids.ada,
          ...reviewed(o),
          ...json,
        },
        cookie,
      ),
      status,
    );

  it("uses 12-character LD- and OP- references", async () => {
    const lead = await api.body(
      await api.req("POST", "/crm/leads", { commandId: newId(), name: "Ref Check" }),
      201,
    );
    expect(lead.reference).toMatch(/^LD-[0-9A-F]{12}$/);
    expect((await make("Ref check")).reference).toMatch(/^OP-[0-9A-F]{12}$/);
  });

  it("freezes the quote link once a deal is closed or handed off", async () => {
    const quote = await salesQuote();
    const deal = await make("Pea soup supply", { salesQuoteId: quote.id });
    const won = await outcome(deal, "won");
    // Closed but not yet handed off: the link can't move or drop.
    expect((await patch(won, { salesQuoteId: null }, 409)).error.message).toMatch(/Reopen/);
    const handed = await handoff(won, { kind: "sales_order" });
    expect(handed.handoff).toMatchObject({ kind: "sales_order" });
    // Unlinking after the handoff would have let the deal reopen and its quote back a second deal.
    await patch(handed, { salesQuoteId: null }, 409);
    await outcome(handed, "reopen", 409);
    expect((await make("Second deal", { salesQuoteId: quote.id }, 409)).error.code).toBe("quote_handed_off");

    // A lost deal keeps its link too, and can't gain one.
    const lostQuote = await salesQuote();
    const lost = await outcome(await make("Lost soup", { salesQuoteId: lostQuote.id }), "lost");
    await patch(lost, { salesQuoteId: null }, 409);
    const bare = await outcome(await make("Lost bare"), "lost");
    await patch(bare, { salesQuoteId: (await salesQuote()).id }, 409);
    // Notes and the owner still change on a closed deal.
    expect((await patch(bare, { notes: "Try again in spring" })).notes).toBe("Try again in spring");
  });

  it("refuses a quote another deal already handed off", async () => {
    const { body, req } = api;
    // Converted straight in Sales: the order belongs to the deal that won it, not a new one.
    const quote = await salesQuote();
    await body(
      await req("POST", `/sales/orders/${quote.id}/convert`, {
        commandId: newId(),
        expectedRevision: quote.revision,
        reason: "Ordered by phone",
      }),
    );
    expect((await make("Late deal", { salesQuoteId: quote.id }, 409)).error.code).toBe("quote_handed_off");
    const open = await make("Late deal");
    expect((await patch(open, { salesQuoteId: quote.id }, 409)).error.code).toBe("quote_handed_off");
    // Accepted straight in Client services: it already has its delivery project.
    const service = await serviceQuote();
    await body(
      await req("POST", `/client-services/${service.id}/decision`, {
        commandId: newId(),
        expectedRevision: service.revision,
        action: "accept",
        reason: "Signed",
        teamId: s.ids.team,
        leadId: s.ids.ada,
      }),
    );
    expect((await make("Late service", { serviceQuoteId: service.id }, 409)).error.code).toBe(
      "quote_handed_off",
    );
    // Neither is offered for linking.
    const options = await body(await req("GET", `/crm/opportunities/${open.id}/quote-options`));
    expect(options.sales.map((q: { id: string }) => q.id)).not.toContain(quote.id);
    expect(options.services.map((q: { id: string }) => q.id)).not.toContain(service.id);
  });

  it("links one quote at most, so a won deal is handed off once", async () => {
    const sales = await salesQuote();
    const service = await serviceQuote();
    await make("Both", { salesQuoteId: sales.id, serviceQuoteId: service.id }, 400);
    const deal = await make("One quote", { salesQuoteId: sales.id });
    // Adding the other kind is refused; swapping in one change is fine.
    expect((await patch(deal, { serviceQuoteId: service.id }, 400)).error.message).toMatch(/not both/);
    const swapped = await patch(deal, { salesQuoteId: null, serviceQuoteId: service.id });
    expect(swapped).toMatchObject({ salesQuoteId: null, serviceQuoteId: service.id });
    const won = await outcome(swapped, "won");
    const handed = await handoff(won, { kind: "service_project" });
    expect(handed.handoff).toMatchObject({ kind: "service_project", status: "accepted" });
    // A retry of the same handoff returns it; another kind is refused.
    expect((await handoff(won, { kind: "service_project" })).handoff.id).toBe(handed.handoff.id);
    expect((await handoff(won, { kind: "sales_order" }, 409)).error.code).toBe("already_handed_off");
    // The database holds the same rule.
    await expect(
      s.ctx.handle.db
        .update(crmOpportunities)
        .set({ salesQuoteId: sales.id })
        .where(eq(crmOpportunities.id, deal.id)),
    ).rejects.toThrow();
  });

  const ordersOf = (quoteId: string) =>
    s.ctx.handle.db
      .select({ id: salesOrders.id, status: salesOrders.status })
      .from(salesOrders)
      .where(eq(salesOrders.sourceQuoteId, quoteId));
  const handoffBody = (o: Deal) => ({
    commandId: newId(),
    kind: "sales_order",
    reason: "Signed",
    ...reviewed(o),
  });
  const postHandoff = async (id: string, json: object, status = 200) =>
    api.body(await api.req("POST", `/crm/opportunities/${id}/handoff`, json), status);

  it("refuses a handoff reviewed against another quote or an older revision", async () => {
    const quoteA = await salesQuote();
    const quoteB = await salesQuote();
    const won = await outcome(await make("Stale review", { salesQuoteId: quoteA.id }), "won");
    // One session opens the handoff for quote A...
    const stale = handoffBody(won);
    // ...while another reopens the deal, links quote B and wins it again.
    const relinked = await patch(await outcome(won, "reopen"), { salesQuoteId: quoteB.id });
    const rewon = await outcome(relinked, "won");
    expect((await postHandoff(won.id, stale, 409)).error.message).toMatch(/changed/);
    // The current revision, but the quote or quote revision reviewed is not the linked one.
    expect((await handoff(rewon, { kind: "sales_order", quoteId: quoteA.id }, 409)).error.message).toMatch(
      /linked quote changed/,
    );
    expect(
      (await handoff(rewon, { kind: "sales_order", quoteRevision: quoteB.revision - 1 }, 409)).error.message,
    ).toMatch(/quote changed/);
    expect(await ordersOf(quoteA.id)).toEqual([]);
    expect(await ordersOf(quoteB.id)).toEqual([]);
    // Reviewed as it now stands, it converts quote B.
    const handed = await handoff(rewon, { kind: "sales_order" });
    expect(await ordersOf(quoteB.id)).toEqual([{ id: handed.handoff.id, status: "draft" }]);
  });

  it("replays a handoff from its receipt, never against a relinked quote", async () => {
    const { body, req } = api;
    const quoteA = await salesQuote();
    const quoteB = await salesQuote();
    const won = await outcome(await make("Replayed handoff", { salesQuoteId: quoteA.id }), "won");
    const converting = handoffBody(won);
    const handed = await postHandoff(won.id, converting);
    // A second request after the handoff adopts it, and gets a receipt of its own.
    const adopting = handoffBody(won);
    expect((await postHandoff(won.id, adopting)).handoff.id).toBe(handed.handoff.id);
    // The draft order is cancelled; the deal is reopened, relinked to quote B and won again.
    const order = await body(await req("GET", `/sales/orders/${handed.handoff.id}`));
    await body(
      await req("POST", `/sales/orders/${order.id}/cancel`, {
        commandId: newId(),
        expectedRevision: order.revision,
        reason: "Customer changed the start date",
      }),
    );
    const current = await body(await req("GET", `/crm/opportunities/${won.id}`));
    expect(current.handoff).toBeNull();
    const rewon = await outcome(
      await patch(await outcome(current, "reopen"), { salesQuoteId: quoteB.id }),
      "won",
    );
    const changesOf = async () =>
      (
        await s.ctx.handle.db
          .select({ id: syncChanges.id })
          .from(syncChanges)
          .where(eq(syncChanges.entityId, won.id))
      ).length;
    const before = await changesOf();
    // Replaying either earlier request returns its receipt: no order for quote B, no conflict.
    for (const replay of [adopting, converting]) {
      const result = await postHandoff(won.id, replay);
      expect(result).toMatchObject({ id: won.id, salesQuoteId: quoteB.id, handoff: null });
    }
    expect(await ordersOf(quoteB.id)).toEqual([]);
    expect(await changesOf()).toBe(before);
    // A fresh review hands off quote B.
    expect((await handoff(rewon, { kind: "sales_order" })).handoff).toMatchObject({ kind: "sales_order" });
  });

  /** A link made before Sales and Client services guarded it: the quote moved customer anyway. */
  const moveQuote = (quoteId: string, customerId: string) =>
    s.ctx.handle.db.update(salesOrders).set({ customerId }).where(eq(salesOrders.id, quoteId));

  it("keeps a linked quote on the deal's customer in Sales and Client services", async () => {
    const { body, req } = api;
    const draft = await salesQuote(false);
    const deal = await make("Moving quote", { salesQuoteId: draft.id });
    const moved = await body(
      await req("PUT", `/sales/orders/${draft.id}`, {
        commandId: newId(),
        expectedRevision: draft.revision,
        document: document(other.id),
        reason: "Wrong customer",
      }),
      409,
    );
    expect(moved.error).toMatchObject({ code: "quote_linked_to_crm" });
    expect(moved.error.message).toContain(deal.reference);
    // Other edits still save; unlinked in CRM, the customer can change.
    const saved = await body(
      await req("PUT", `/sales/orders/${draft.id}`, {
        commandId: newId(),
        expectedRevision: draft.revision,
        document: { ...document(customer.id), customerReference: "PO-1" },
        reason: "Reference",
      }),
    );
    await patch(deal, { salesQuoteId: null });
    await body(
      await req("PUT", `/sales/orders/${draft.id}`, {
        commandId: newId(),
        expectedRevision: saved.revision,
        document: document(other.id),
        reason: "Wrong customer",
      }),
    );

    const service = await serviceQuote(false);
    const serviceDeal = await make("Moving service", { serviceQuoteId: service.id });
    const fields = {
      customerId: other.id,
      title: "Kitchen audit",
      scope: "Review the line",
      currency: "GBP",
      unitPrice: 500,
      quotedMinutes: null,
      deliveryDate: "2027-03-01",
    };
    const refused = await body(
      await req("PATCH", `/client-services/${service.id}`, {
        ...fields,
        commandId: newId(),
        expectedRevision: service.revision,
      }),
      409,
    );
    expect(refused.error.message).toContain(serviceDeal.reference);
  });

  it("rechecks the quote's customer at handoff", async () => {
    const quote = await salesQuote();
    const won = await outcome(await make("Moved quote", { salesQuoteId: quote.id }), "won");
    await moveQuote(quote.id, other.id);
    expect((await handoff(won, { kind: "sales_order" }, 409)).error.message).toMatch(/another customer/);
    expect(await ordersOf(quote.id)).toEqual([]);
  });

  it("doesn't take another customer's order as the deal's handoff, so it can be corrected", async () => {
    const { body, req } = api;
    const quote = await salesQuote();
    const lost = await outcome(await make("Moved and ordered", { salesQuoteId: quote.id }), "lost");
    const won = await outcome(
      await make("Won, moved and ordered", { salesQuoteId: (await salesQuote()).id }),
      "won",
    );
    for (const deal of [lost, won]) {
      await moveQuote(deal.salesQuoteId, other.id);
      await body(
        await req("POST", `/sales/orders/${deal.salesQuoteId}/convert`, {
          commandId: newId(),
          expectedRevision: deal.salesQuote.revision,
          reason: "Ordered by phone",
        }),
      );
      expect((await body(await req("GET", `/crm/opportunities/${deal.id}`))).handoff).toBeNull();
    }
    // The won deal isn't handed off by adopting it.
    expect((await handoff(won, { kind: "sales_order" }, 409)).error.message).toMatch(/another customer/);
    // The lost deal reopens and drops the quote.
    const reopened = await outcome(lost, "reopen");
    expect(await patch(reopened, { salesQuoteId: null })).toMatchObject({
      salesQuoteId: null,
      handoff: null,
    });
  });

  it("reopens a deal whose stage was removed onto the first live stage", async () => {
    const { body, req } = api;
    const { stages } = await body(await req("GET", "/crm/stages"));
    const last = stages.at(-1);
    const lost = await outcome(await make("Parked", { stageId: last.id }), "lost");
    await body(
      await req("PUT", "/crm/stages", {
        stages: stages
          .filter((st: { id: string }) => st.id !== last.id)
          .map(({ id, name, probability }: { id: string; name: string; probability: number }) => ({
            id,
            name,
            probability,
          })),
      }),
    );
    const reopened = await outcome(lost, "reopen");
    expect(reopened).toMatchObject({ status: "open", stageId: stages[0].id });
    const pipeline = await body(await req("GET", "/crm/pipeline"));
    expect(pipeline.unstaged).toEqual([]);
  });

  it("keeps links hidden from a member without the quote's module", async () => {
    const { grant } = api;
    for (const module of ["customers", "crm"]) await grant(s.ids.marcus, module, "write");
    const deal = await make("Hidden quote", { salesQuoteId: (await salesQuote()).id });
    // Marcus can't read Sales: the customer change explains why, and he can't drop the link.
    expect((await patch(deal, { customerId: other.id }, 409, s.marcus)).error.code).toBe("quote_hidden");
    expect((await patch(deal, { salesQuoteId: null }, 403, s.marcus)).error.code).toBe("module_forbidden");
    expect((await patch(deal, { notes: "Called" }, 200, s.marcus)).salesQuote).toBeNull();
  });

  it("refuses a handoff to a CRM writer without Sales manage", async () => {
    const { grant } = api;
    await grant(s.ids.marcus, "sales", "write");
    const won = await outcome(await make("Not his call", { salesQuoteId: (await salesQuote()).id }), "won");
    expect((await handoff(won, { kind: "sales_order" }, 403, s.marcus)).error.code).toBe("module_forbidden");
    expect((await api.body(await api.req("GET", `/crm/opportunities/${won.id}`))).handoff).toBeNull();
  });

  it("replays a conversion to a new customer without a second customer", async () => {
    const { body, req } = api;
    const lead = await body(
      await req("POST", "/crm/leads", { commandId: newId(), name: "Rae Lin", company: "Lin Bakery" }),
      201,
    );
    const qualified = await body(
      await req("PATCH", `/crm/leads/${lead.id}`, { expectedRevision: 1, status: "qualified" }),
    );
    const convert = {
      commandId: newId(),
      expectedRevision: qualified.revision,
      customer: { mode: "new", code: "LINB", name: "Lin Bakery", address: "5 Oven Row" },
    };
    const first = await body(await req("POST", `/crm/leads/${lead.id}/convert`, convert));
    expect(await body(await req("POST", `/crm/leads/${lead.id}/convert`, convert))).toEqual(first);
    const made = await s.ctx.handle.db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.code, "LINB"));
    expect(made).toEqual([{ id: first.customerId }]);
    // A new command for the same lead is refused: it is already converted.
    await body(await req("POST", `/crm/leads/${lead.id}/convert`, { ...convert, commandId: newId() }), 409);
  });

  it("refuses converting a lead to a customer its deals and quotes aren't for", async () => {
    const { body, req } = api;
    const lead = await body(
      await req("POST", "/crm/leads", { commandId: newId(), name: "Sam Hale", company: "Hale Cafe" }),
      201,
    );
    const qualified = await body(
      await req("PATCH", `/crm/leads/${lead.id}`, { expectedRevision: 1, status: "qualified" }),
    );
    // A deal of the lead already quoted for Keep Foods.
    const deal = await make("Hale supply", { leadId: lead.id, salesQuoteId: (await salesQuote()).id });
    const convert = (target: object) =>
      req("POST", `/crm/leads/${lead.id}/convert`, {
        commandId: newId(),
        expectedRevision: qualified.revision,
        customer: target,
      });
    for (const target of [
      { mode: "existing", customerId: other.id },
      { mode: "new", code: "HALE", name: "Hale Cafe", address: "8 Hill Road" },
    ]) {
      const refused = await body(await convert(target), 409);
      expect(refused.error).toMatchObject({ code: "lead_customer_conflict" });
      expect(refused.error.message).toContain(deal.reference);
    }
    expect(
      await s.ctx.handle.db.select({ id: customers.id }).from(customers).where(eq(customers.code, "HALE")),
    ).toEqual([]);
    // Onto the customer its deal is for, it converts.
    expect(await body(await convert({ mode: "existing", customerId: customer.id }))).toMatchObject({
      status: "converted",
      customerId: customer.id,
    });
  });

  it("offers an older eligible quote behind a page of taken ones, and pages the rest", async () => {
    const { body, req } = api;
    const db = s.ctx.handle.db;
    const picky = await body(
      await req("POST", "/customers", { code: "PICK", name: "Picky Foods", address: "3 Dock Road" }),
      201,
    );
    const eligible = await salesQuote(false, picky.id);
    const deal = await make("Picking", { customerId: picky.id });
    const { stages } = await body(await req("GET", "/crm/stages"));
    const quoteRow = () => ({
      id: newId(),
      workspaceId: s.ids.workspace,
      kind: "quote" as const,
      customerId: picky.id,
      currency: "GBP",
      recipient: eligible.recipient,
    });
    const insertQuotes = async (n: number) => {
      const rows = Array.from({ length: n }, quoteRow).map((row) => ({
        ...row,
        reference: `SQ-${row.id.slice(-12)}`,
      }));
      await db.insert(salesOrders).values(rows);
      return rows;
    };
    // 100 newer quotes, half converted to orders and half linked to other deals.
    const taken = await insertQuotes(100);
    await db.insert(salesOrders).values(
      taken.slice(0, 50).map((quote) => {
        const order = { ...quoteRow(), kind: "order" as const, sourceQuoteId: quote.id };
        return { ...order, reference: `SO-${order.id.slice(-12)}` };
      }),
    );
    await db.insert(crmOpportunities).values(
      taken.slice(50).map((quote) => {
        const id = newId();
        return {
          id,
          workspaceId: s.ids.workspace,
          reference: `OP-${id.slice(-12)}`,
          title: "Taken",
          customerId: picky.id,
          stageId: stages[0].id,
          currency: "GBP",
          salesQuoteId: quote.id,
        };
      }),
    );
    const options = async (query = "") =>
      body(await req("GET", `/crm/opportunities/${deal.id}/quote-options${query}`));
    const first = await options();
    expect(first.sales.map((q: { id: string }) => q.id)).toEqual([eligible.id]);
    expect(first.nextCursor).toEqual({ sales: null, services: null });
    // With more than a page eligible, the next page follows the cursor.
    const more = await insertQuotes(100);
    const page = await options();
    expect(page.sales).toHaveLength(100);
    expect(page.sales[0].id).toBe(more.at(-1)!.id);
    expect(page.nextCursor.sales).toBe(more[0]!.id);
    const next = await options(`?salesBefore=${page.nextCursor.sales}`);
    expect(next.sales.map((q: { id: string }) => q.id)).toEqual([eligible.id]);
    expect(next.nextCursor.sales).toBeNull();
  });

  it("treats ids from another workspace as missing", async () => {
    const { body, req } = api;
    const db = s.ctx.handle.db;
    const [ws] = await db
      .insert(workspaces)
      .values({ slug: `crm-foreign-${newId()}`, name: "Foreign" })
      .returning();
    const [foreignCustomer] = await db
      .insert(customers)
      .values({ workspaceId: ws!.id, code: "F", name: "Foreign", address: "Far away" })
      .returning();
    const [foreignLead] = await db
      .insert(crmLeads)
      .values({ workspaceId: ws!.id, reference: "LD-F", name: "Foreign lead", status: "qualified" })
      .returning();
    const [foreignStage] = await db
      .insert(crmStages)
      .values({ workspaceId: ws!.id, name: "Foreign", position: 0 })
      .returning();
    const [foreignQuote] = await db
      .insert(salesOrders)
      .values({
        workspaceId: ws!.id,
        reference: "F-Q",
        kind: "quote",
        customerId: foreignCustomer!.id,
        currency: "GBP",
        recipient: {
          code: "F",
          name: "Foreign",
          address: "Far away",
          deliveryAddress: "Far away",
          deliverySiteCode: null,
          deliverySiteName: null,
        },
      })
      .returning();
    const [foreignDeal] = await db
      .insert(crmOpportunities)
      .values({
        workspaceId: ws!.id,
        reference: "OP-F",
        title: "Foreign deal",
        customerId: foreignCustomer!.id,
        stageId: foreignStage!.id,
        currency: "GBP",
      })
      .returning();

    await make("Foreign customer", { customerId: foreignCustomer!.id }, 404);
    await make("Foreign lead", { customerId: null, leadId: foreignLead!.id }, 404);
    // A stage id is checked against this workspace's live stages.
    expect((await make("Foreign stage", { stageId: foreignStage!.id }, 400)).error.message).toMatch(
      /current pipeline stage/,
    );
    await make("Foreign quote", { salesQuoteId: foreignQuote!.id }, 404);
    const local = await make("Local deal");
    await patch(local, { salesQuoteId: foreignQuote!.id }, 404);
    await patch(local, { stageId: foreignStage!.id }, 400);
    await patch(local, { customerId: foreignCustomer!.id }, 404);
    await body(await req("GET", `/crm/opportunities/${foreignDeal!.id}`), 404);
    await body(await req("GET", `/crm/leads/${foreignLead!.id}`), 404);
    await body(
      await req("POST", `/crm/opportunities/${foreignDeal!.id}/outcome`, {
        commandId: newId(),
        expectedRevision: 1,
        outcome: "won",
        reason: "Not ours",
      }),
      404,
    );
    await handoff({ ...foreignDeal!, salesQuoteId: foreignQuote!.id }, { kind: "sales_order" }, 404);
    await body(
      await req("POST", "/crm/activities", {
        commandId: newId(),
        opportunityId: foreignDeal!.id,
        kind: "call",
        subject: "Not ours",
      }),
      404,
    );
    const lead = await body(await req("POST", "/crm/leads", { commandId: newId(), name: "Local lead" }), 201);
    const qualified = await body(
      await req("PATCH", `/crm/leads/${lead.id}`, { expectedRevision: 1, status: "qualified" }),
    );
    await body(
      await req("POST", `/crm/leads/${lead.id}/convert`, {
        commandId: newId(),
        expectedRevision: qualified.revision,
        customer: { mode: "existing", customerId: foreignCustomer!.id },
      }),
      404,
    );
    // Nothing in the foreign workspace changed.
    const [untouched] = await db
      .select()
      .from(crmOpportunities)
      .where(eq(crmOpportunities.id, foreignDeal!.id));
    expect(untouched).toMatchObject({ status: "open", revision: 1 });
  });
});

describe("CRM follow-up reminders", () => {
  it("reaches new follow-ups past thousands already reminded or owned by someone without CRM", async () => {
    const s = await open();
    try {
      const { body, req } = client(s);
      const db = s.ctx.handle.db;
      const lead = await body(await req("POST", "/crm/leads", { commandId: newId(), name: "Busy" }), 201);
      const due = (ownerId: string, dueOn: string, n: number) =>
        db.insert(crmActivities).values(
          Array.from({ length: n }, (_, i) => ({
            workspaceId: s.ids.workspace,
            leadId: lead.id,
            kind: "task" as const,
            subject: `Follow-up ${i}`,
            dueOn,
            ownerId,
          })),
        );
      const sweep = async () =>
        (
          await sweepDueNotifications(db, {
            activeModules: ["customers", "crm"],
            workspaceId: s.ids.workspace,
          })
        ).created.filter((n) => n.type === "crm_follow_up_due");
      const fresh = async (subject: string) =>
        body(
          await req("POST", "/crm/activities", {
            commandId: newId(),
            leadId: lead.id,
            kind: "call",
            subject,
            dueOn: today,
          }),
          201,
        );
      // Older follow-ups of a member who can't read CRM come first by due date.
      await due(s.ids.marcus, addDaysToIsoDate(today, -1), 2000);
      const first = await fresh("Call back today");
      expect((await sweep()).map((n) => n.data)).toEqual([
        expect.objectContaining({ title: "Call back today (Busy)" }),
      ]);
      // 2,000 older ones are reminded once; a new one still gets its reminder on the next sweep.
      await due(s.ids.ada, addDaysToIsoDate(today, -2), 2000);
      expect(await sweep()).toHaveLength(2000);
      await fresh("Another call today");
      expect((await sweep()).map((n) => n.data)).toEqual([
        expect.objectContaining({ title: "Another call today (Busy)" }),
      ]);
      expect(first.ownerId).toBe(s.ids.ada);
    } finally {
      await s.ctx.handle.close();
    }
  }, 120_000);
});

describe("CRM degrades without its optional modules", () => {
  it("keeps the customer register working with CRM switched off", async () => {
    const s = await open(["tasks", "docs", "customers"]);
    try {
      const { body, req } = client(s);
      const created = await body(
        await req("POST", "/customers", { code: "PLAIN", name: "Plain Customer", address: "1 Road" }),
        201,
      );
      await body(await req("PATCH", `/customers/${created.id}`, { contactName: "Pat" }));
      const list = await body(await req("GET", "/customers?q=Plain"));
      expect(list.customers.map((c: { id: string }) => c.id)).toEqual([created.id]);
      expect((await body(await req("GET", "/crm/leads"), 404)).error.code).toBe("module_inactive");
      const modules = await body(await req("GET", "/modules"));
      expect(JSON.stringify(modules)).not.toContain('"crm"');
    } finally {
      await s.ctx.handle.close();
    }
  }, 60_000);

  it("runs a pipeline without Sales or Client services and refuses quote links", async () => {
    const s = await open(["tasks", "docs", "customers", "crm"]);
    try {
      const { body, req } = client(s);
      const customer = await body(
        await req("POST", "/customers", { code: "SOLO", name: "Solo Ltd", address: "3 Lane" }),
        201,
      );
      const opportunity = await body(
        await req("POST", "/crm/opportunities", {
          commandId: newId(),
          title: "Annual retainer",
          customerId: customer.id,
          currency: "GBP",
        }),
        201,
      );
      expect(opportunity).toMatchObject({ salesQuote: null, serviceQuote: null, handoff: null });
      expect(
        (
          await body(
            await req("PATCH", `/crm/opportunities/${opportunity.id}`, {
              expectedRevision: opportunity.revision,
              serviceQuoteId: newId(),
            }),
            404,
          )
        ).error.code,
      ).toBe("module_inactive");
      const won = await body(
        await req("POST", `/crm/opportunities/${opportunity.id}/outcome`, {
          commandId: newId(),
          expectedRevision: opportunity.revision,
          outcome: "won",
          reason: "Signed",
        }),
      );
      expect(won.status).toBe("won");
      expect(
        (
          await body(
            await req("POST", `/crm/opportunities/${opportunity.id}/handoff`, {
              commandId: newId(),
              kind: "sales_order",
              reason: "Order",
              ...reviewed(won),
            }),
            404,
          )
        ).error.code,
      ).toBe("module_inactive");
    } finally {
      await s.ctx.handle.close();
    }
  }, 60_000);
});
