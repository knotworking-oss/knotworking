import { hseContentSchema, newId } from "@knotworking/core";
import { teams } from "@knotworking/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const base = "/v1/workspaces/acme";

describe("general business operations with manufacturing modules disabled", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: string;
  let priya: string;
  let adaId: string;
  let marcusId: string;
  let teamId: string;
  let workspaceId: string;

  const body = async (response: Res, status = 200) => {
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(status);
    return result;
  };
  const get = (path: string, cookie: string) => ctx.req(`${base}${path}`, { cookie });
  const post = (path: string, cookie: string, json: unknown) =>
    ctx.req(`${base}${path}`, { method: "POST", cookie, json });

  beforeAll(async () => {
    ctx = await makeApp({
      seed: true,
      activeModules: [
        "tasks",
        "docs",
        "time",
        "customers",
        "people",
        "training",
        "hse",
        "hse_incidents",
        "purchase_requests",
        "client_services",
      ],
    });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    priya = (await signIn(ctx, "priya@knotworking.dev")).cookie;
    const boot = await body(await get("/bootstrap", ada));
    workspaceId = boot.workspace.id;
    teamId = boot.teams[0].id;
    adaId = boot.users.find((u: { email: string }) => u.email === "ada@knotworking.dev").id;
    marcusId = boot.users.find((u: { email: string }) => u.email === "marcus@knotworking.dev").id;
  }, 60_000);
  afterAll(() => ctx?.handle.close());

  it("creates the onboarding project and dated tasks exactly once", async () => {
    const input = {
      commandId: newId(),
      templateId: "employee_onboarding",
      name: "Sam onboarding",
      teamId,
      leadId: marcusId,
      startDate: "2027-01-05",
    };
    const created = await body(await post("/projects/from-template", ada, input), 201);
    expect(await body(await post("/projects/from-template", ada, input), 201)).toEqual(created);
    await body(await post("/projects/from-template", ada, { ...input, name: "Different project" }), 409);
    const projects = await body(await get("/projects", ada));
    expect(projects.projects.filter((p: { name: string }) => p.name === input.name)).toEqual([
      expect.objectContaining({
        id: created.id,
        leadId: marcusId,
        startDate: "2026-12-29",
        targetDate: "2027-01-12",
      }),
    ]);
    const plan = (await body(await get(`/tasks?projectId=${created.id}`, ada))).tasks;
    expect(plan.map((t: { dueDate: string }) => t.dueDate)).toEqual([
      "2026-12-29",
      "2027-01-02",
      "2027-01-04",
      "2027-01-05",
      "2027-01-08",
      "2027-01-12",
    ]);
    expect(
      plan.every(
        (t: { assigneeId: string; teamId: string }) => t.assigneeId === marcusId && t.teamId === teamId,
      ),
    ).toBe(true);
  });

  it("rolls back the project when the selected team cannot create tasks", async () => {
    const [team] = await ctx.handle.db
      .insert(teams)
      .values({ workspaceId, key: "NOSTATE", name: "Unconfigured team" })
      .returning();
    const name = "Incomplete onboarding";
    const result = await post("/projects/from-template", ada, {
      commandId: newId(),
      templateId: "employee_onboarding",
      name,
      teamId: team!.id,
      leadId: adaId,
      startDate: "2027-01-05",
    });
    expect(result.status).toBe(400);
    const projects = await body(await get("/projects", ada));
    expect(projects.projects.some((p: { name: string }) => p.name === name)).toBe(false);
  });

  it("routes a spending request to a separate approver, preserves the decision and notifies both people", async () => {
    const submit = {
      commandId: newId(),
      title: "Design software",
      reason: "Renew the team subscription",
      amount: "480.50",
      currency: "GBP",
      neededBy: "2027-03-01",
      approverId: adaId,
    };
    expect((await get("/purchasing/orders", ada)).status).toBe(404);
    expect((await get("/stock/levels", ada)).status).toBe(404);
    expect((await body(await get("/purchase-requests", marcus))).approverIds).toEqual([adaId]);
    await body(await post("/purchase-requests", marcus, { ...submit, approverId: marcusId }), 400);
    const result = await body(await post("/purchase-requests", marcus, submit), 201);
    expect(await body(await post("/purchase-requests", marcus, submit), 201)).toEqual(result);
    expect(result).toMatchObject({
      status: "pending",
      amount: 480.5,
      currency: "GBP",
      requesterId: marcusId,
    });
    const path = `/purchase-requests/${result.id}`;
    await body(await get(path, priya), 404);
    await body(await get("/purchase-requests?view=all", priya), 403);
    expect(
      (await body(await get("/purchase-requests?view=assigned", ada))).requests.map(
        (r: { id: string }) => r.id,
      ),
    ).toEqual([result.id]);
    expect(
      (await body(await get("/notifications", ada))).notifications.filter(
        (n: { type: string }) => n.type === "purchase_request_submitted",
      ),
    ).toHaveLength(1);

    const decision = { commandId: newId(), status: "approved", note: "Covered by the design budget" };
    await body(await post(`${path}/decision`, marcus, decision), 403);
    const approved = await body(await post(`${path}/decision`, ada, decision));
    expect(approved).toMatchObject({ status: "approved", decidedBy: adaId, decisionNote: decision.note });
    expect(await body(await post(`${path}/decision`, ada, decision))).toEqual(approved);
    await body(
      await post(`${path}/decision`, ada, { commandId: newId(), status: "rejected", note: "Already closed" }),
      409,
    );
    expect(await body(await get(path, marcus))).toEqual(approved);
    expect(
      (await body(await get("/notifications", marcus))).notifications.filter(
        (n: { type: string }) => n.type === "purchase_request_decided",
      ),
    ).toHaveLength(1);
    const replica = await body(await get("/sync?after=0&limit=1000", priya));
    expect(JSON.stringify(replica)).not.toContain(submit.reason);
  });

  it("takes an hourly quote through delivery to an exact billing draft without a stock ledger", async () => {
    const customer = await body(
      await post("/customers", ada, { code: "BRG", name: "Bridge Design", address: "10 High Street" }),
      201,
    );
    const quote = await body(
      await post("/client-services", ada, {
        commandId: newId(),
        customerId: customer.id,
        title: "Process review",
        scope: "Review the workflow and deliver a findings report",
        currency: "GBP",
        unitPrice: 100,
        quotedMinutes: 120,
        deliveryDate: "2027-04-15",
      }),
      201,
    );
    expect(quote).toMatchObject({ status: "draft", quoteTotal: "200.00", billingTotal: null });
    const path = `/client-services/${quote.id}`;
    await body(await get(path, marcus), 403);
    expect((await get(`${path}/billing-draft.csv`, ada)).status).toBe(409);
    const issue = await body(
      await post(`${path}/decision`, ada, {
        commandId: newId(),
        expectedRevision: quote.revision,
        action: "issue",
        reason: "Scope and estimate checked",
      }),
    );
    const acceptance = {
      commandId: newId(),
      expectedRevision: issue.revision,
      action: "accept",
      reason: "Customer approved quote by email",
      teamId,
      leadId: adaId,
    };
    for (const [module, level] of [
      ["customers", "read"],
      ["client_services", "manage"],
      ["tasks", "read"],
    ]) {
      await body(
        await ctx.req(`${base}/members/${marcusId}/module-access/${module}`, {
          method: "PUT",
          cookie: ada,
          json: { level },
        }),
      );
    }
    expect((await body(await post(`${path}/decision`, marcus, acceptance), 403)).error.code).toBe(
      "module_forbidden",
    );
    const accepted = await body(await post(`${path}/decision`, ada, acceptance));
    expect(await body(await post(`${path}/decision`, ada, acceptance))).toEqual(accepted);
    const task = await body(
      await post("/tasks", ada, { title: "Write review", teamId, projectId: accepted.projectId }),
      201,
    );
    const deleteProject = () =>
      ctx.req(`${base}/projects/${accepted.projectId}`, { method: "DELETE", cookie: priya });
    expect((await body(await deleteProject(), 409)).error.code).toBe("project_in_delivery");
    expect((await body(await get(`/tasks/${task.id}`, ada))).projectId).toBe(accepted.projectId);
    const delivery = {
      commandId: newId(),
      expectedRevision: accepted.revision,
      action: "deliver",
      reason: "Client accepted the report",
      approvedMinutes: 91,
    };
    await body(await post(`${path}/decision`, ada, delivery), 400);
    await body(await post(`/tasks/${task.id}/time-entries`, ada, { minutes: 100 }), 201);
    expect((await body(await get(path, ada))).loggedMinutes).toBe(100);
    const delivered = await body(await post(`${path}/decision`, ada, delivery));
    expect(delivered).toMatchObject({ status: "delivered", approvedMinutes: 91, billingTotal: "151.67" });
    const csv = await get(`${path}/billing-draft.csv`, ada);
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain("Hourly,91,100,GBP,151.67");
    const history = (await body(await get(path, ada))).history;
    expect(history.map((event: { action: string }) => event.action)).toEqual([
      "deliver",
      "accept",
      "issue",
      "created",
    ]);
    const sync = await body(await get("/sync?after=0&limit=1000", ada));
    const entityKinds = sync.changes.map((change: { entity: string }) => change.entity);
    expect(entityKinds).toContain("service_quote");
    expect(entityKinds).not.toContain("stock_movement");
    expect(JSON.stringify(sync)).not.toContain(quote.scope);
    expect((await deleteProject()).status).toBe(204);
    expect(await (await get(`${path}/billing-draft.csv`, ada)).text()).toContain("Hourly,91,100,GBP,151.67");
  });

  it("signs off a fixed-fee delivery without logging time", async () => {
    const customer = await body(
      await post("/customers", ada, { code: "COM", name: "Common Ground", address: "22 Park Road" }),
      201,
    );
    const draft = await body(
      await post("/client-services", ada, {
        commandId: newId(),
        customerId: customer.id,
        title: "Kickoff workshop",
        scope: "Plan the collaboration",
        currency: "GBP",
        unitPrice: 450,
        quotedMinutes: null,
        deliveryDate: null,
      }),
      201,
    );
    const path = `/client-services/${draft.id}/decision`;
    const act = (revision: number, payload: object) =>
      post(path, ada, {
        commandId: newId(),
        expectedRevision: revision,
        reason: "Milestone tracked in project notes",
        ...payload,
      });
    await body(await act(1, { action: "issue" }));
    await body(await act(2, { action: "accept", teamId, leadId: adaId }));
    expect(await body(await act(3, { action: "deliver", approvedMinutes: null }))).toMatchObject({
      status: "delivered",
      billingTotal: "450.00",
    });
  });

  it("keeps workplace risk registers available with factory safety and contractor permits switched off", async () => {
    const risk = await body(
      await post("/hse/registers", ada, {
        commandId: newId(),
        title: "Office ergonomics",
        kind: "risk_assessment",
        content: hseContentSchema.parse({ scope: "Workstations" }),
      }),
      201,
    );
    expect((await get(`/hse/registers/${risk.id}`, ada)).status).toBe(200);
    expect((await get("/hse/incidents", ada)).status).toBe(200);
    const permits = await body(await get("/hse/permits", ada), 404);
    expect(permits.error.code).toBe("module_inactive");
    expect((await get("/haccp/plans", ada)).status).toBe(404);
  });
});
