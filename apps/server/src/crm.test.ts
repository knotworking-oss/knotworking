import { DEFAULT_TIME_ZONE, newId, todayInZone, type ModuleId } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepDueNotifications } from "./services/notification-sweep";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const base = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

type Ids = Record<"workspace" | "team" | "ada" | "marcus" | "priya", string>;
type Session = { ctx: TestCtx; ada: string; marcus: string; priya: string; ids: Ids };

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

    const handoff = {
      commandId: newId(),
      kind: "service_project",
      reason: "Signed by email",
      teamId: s.ids.team,
      leadId: s.ids.ada,
    };
    await body(await req("POST", `/crm/opportunities/${opportunity.id}/handoff`, handoff), 409);
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
      (await body(await req("POST", `/crm/opportunities/${opportunity.id}/handoff`, handoff), 409)).error
        .message,
    ).toMatch(/Issue/);
    await body(
      await req("POST", `/client-services/${quote.id}/decision`, {
        commandId: newId(),
        expectedRevision: quote.revision,
        action: "issue",
        reason: "Scope checked",
      }),
    );
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
    const handoff = { commandId: newId(), kind: "sales_order", reason: "Order the first month" };
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
    ).toEqual({ sales: [], services: [] });
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
