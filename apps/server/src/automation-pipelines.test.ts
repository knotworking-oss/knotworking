import {
  addDaysToIsoDate,
  newId,
  notificationPath,
  startOfDayInZone,
  todayInZone,
  type ModuleId,
} from "@knotworking/core";
import { automationPipelineRuns, notifications } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tickAutomationPipelines } from "./services/automation-pipelines";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

describe("cross-module automation pipelines", () => {
  const modules = [
    "automation",
    "items",
    "stock",
    "quality",
    "governance",
    "bi",
  ] as const satisfies readonly ModuleId[];
  let ctx: TestCtx;
  let owner: string;
  let recipient: { cookie: string; id: string };
  let other: string;
  let today: string;
  let now: Date;
  let locationId: string;
  let itemId: string;
  let standardId: string;
  let auditReference: string;
  let reportId: string;
  let pipelineId: string;
  const req = (path: string, method = "GET", json?: unknown, cookie = owner) =>
    ctx.req(`/v1/workspaces/acme${path}`, { method, json, cookie });
  async function body(response: Res, status = 200) {
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(status);
    return result;
  }
  const grant = (module: ModuleId, level: "read" | "none" | "manage") =>
    req(`/members/${recipient.id}/module-access/${module}`, "PUT", { level });
  const run = async (id: string, commandId = newId()) =>
    body(await req(`/automation/pipelines/${id}/run`, "POST", { commandId }), 202);
  const tick = () => tickAutomationPipelines(ctx.handle.db, modules, now);

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, activeModules: modules });
    owner = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const login = async (email: string) => {
      const { cookie } = await signIn(ctx, email);
      const { user } = await body(await ctx.req("/v1/me", { cookie }));
      return { cookie, id: user.id as string };
    };
    recipient = await login("marcus@knotworking.dev");
    other = (await login("priya@knotworking.dev")).cookie;
    const { workspace } = await body(await req("/bootstrap"));
    today = todayInZone(workspace.timeZone);
    now = new Date(startOfDayInZone(today, workspace.timeZone).getTime() + 14 * 3_600_000);
    const item = await body(
      await req("/items", "POST", { name: "Brief flour", code: "BRIEF", type: "ingredient", unit: "kg" }),
      201,
    );
    itemId = item.id;
    const location = await body(
      await req("/stock/locations", "POST", { name: "Brief warehouse", code: "BRWH" }),
      201,
    );
    locationId = location.id;
    await body(
      await req("/stock/receipts", "POST", {
        itemId: item.id,
        locationId,
        quantity: 18,
        unit: "kg",
        receivedOn: today,
        reason: "Opening balance",
      }),
      201,
    );
    const audit = await body(
      await req("/quality/audits", "POST", {
        title: "Internal warehouse audit",
        plannedOn: addDaysToIsoDate(today, -1),
      }),
      201,
    );
    auditReference = audit.reference;
    const standard = await body(
      await req("/governance/standards", "POST", { name: "Operations standard", code: "OPS", issue: "1" }),
      201,
    );
    standardId = standard.id;
  }, 90_000);

  afterAll(async () => ctx?.handle.close());

  it("runs a Stock, Quality and Governance brief once per local day with Tasks disabled", async () => {
    expect((await req("/automation")).status).toBe(404);
    const steps = [
      { id: newId(), title: "Stock position", kind: "stock.position", locationId, limit: 30 },
      { id: newId(), title: "Audit requirements", kind: "quality.audit_requirements" },
      { id: newId(), title: "Standard gaps", kind: "governance.standard_gaps", standardId },
      { id: newId(), title: "Notify team", kind: "automation.notify", recipients: [recipient.id] },
    ];
    const pipeline = await body(
      await req("/automation/pipelines", "POST", {
        name: "Morning Operations Brief",
        enabled: true,
        schedule: { frequency: "daily", time: "00:00" },
        steps,
      }),
      201,
    );
    pipelineId = pipeline.id;
    await Promise.all([tick(), tick()]);
    await tick();
    const runs = await ctx.handle.db
      .select()
      .from(automationPipelineRuns)
      .where(eq(automationPipelineRuns.pipelineId, pipeline.id));
    expect(runs).toHaveLength(1);
    reportId = runs[0]!.id;
    const report = await body(await req(`/automation/runs/${reportId}`));
    expect(report).toMatchObject({
      asAt: today,
      status: "completed",
      steps: [
        { output: { metrics: { items: 1 }, rows: [["Brief flour", "kg", 18, 18, 0, null]] } },
        {
          output: {
            metrics: { overdue_audits: 1 },
            rows: [[auditReference, "Internal warehouse audit", addDaysToIsoDate(today, -1), "Overdue"]],
          },
        },
        { output: { metrics: { open_gaps: 0 }, rows: [["Operations standard", 0, 0, 0]] } },
        { output: { status: "completed" } },
      ],
    });
    const [notice] = await ctx.handle.db
      .select()
      .from(notifications)
      .where(eq(notifications.type, "automation_report_ready"));
    expect(notice?.userId).toBe(recipient.id);
    expect(notificationPath(notice!)).toBe(`/automation/runs/${reportId}`);
  });

  it("rechecks report access and redacts source data when grants change", async () => {
    expect((await req(`/automation/runs/${reportId}`, "GET", undefined, other)).status).toBe(404);
    const path = `/automation/runs/${reportId}`;
    const restricted = await body(await req(path, "GET", undefined, recipient.cookie));
    expect(restricted.steps[0].output).toMatchObject({ status: "unavailable" });
    expect(restricted.steps[0].output.rows).toBeUndefined();
    expect((await grant("items", "read")).status).toBe(200);
    expect((await grant("stock", "read")).status).toBe(200);
    const allowed = await body(await req(path, "GET", undefined, recipient.cookie));
    expect(allowed.steps[0].output.rows[0]).toContain("Brief flour");
    expect((await grant("stock", "none")).status).toBe(200);
    expect(
      (await body(await req(path, "GET", undefined, recipient.cookie))).steps[0].output.rows,
    ).toBeUndefined();
    expect(
      (await req(`/automation/pipelines/${pipelineId}/run`, "POST", { commandId: newId() }, recipient.cookie))
        .status,
    ).toBe(403);
  });

  it("runs BI data and saves a dashboard snapshot and draft without duplicating retried runs", async () => {
    const query = { dataset: "stock_lots", measures: ["lot_count"] };
    const dashboard = await body(
      await req("/bi/dashboards", "POST", {
        title: "Morning template",
        spec: {
          sections: [{ id: "overview", widgets: [{ id: "lots", type: "kpi", title: "Lots", query }] }],
        },
      }),
      201,
    );
    const pipeline = await body(
      await req("/automation/pipelines", "POST", {
        name: "Data and dashboards",
        enabled: false,
        schedule: null,
        steps: [
          { id: newId(), title: "Lots", kind: "bi.query", query },
          { id: newId(), title: "Frozen board", kind: "bi.snapshot", dashboardId: dashboard.id },
          { id: newId(), title: "Prepared dashboard", kind: "bi.dashboard_draft", dashboardId: dashboard.id },
        ],
      }),
      201,
    );
    const commandId = newId();
    const first = await run(pipeline.id, commandId);
    const retry = await run(pipeline.id, commandId);
    expect(retry.id).toBe(first.id);
    await tick();
    await tick();
    const report = await body(await req(`/automation/runs/${first.id}`));
    expect(report.status, JSON.stringify(report.steps)).toBe("completed");
    expect(report.steps[0].output.rows).toEqual([[1]]);
    const snapshot = report.steps[1].output.artifact;
    expect(snapshot.kind).toBe("snapshot");
    expect((await req(`/bi/snapshots/${snapshot.id}`)).status).toBe(200);
    const draft = report.steps[2].output.artifact;
    expect(draft.kind).toBe("dashboard");
    expect(await body(await req(`/bi/dashboards/${draft.id}`))).toMatchObject({
      status: "draft",
      title: "Prepared dashboard",
    });
  });

  it("records a missing source as unavailable and preserves results from other sections", async () => {
    const pipeline = await body(
      await req("/automation/pipelines", "POST", {
        name: "Partial report",
        enabled: false,
        schedule: null,
        steps: [
          { id: newId(), title: "Removed standard", kind: "governance.standard_gaps", standardId: newId() },
          { id: newId(), title: "Audits", kind: "quality.audit_requirements" },
        ],
      }),
      201,
    );
    const { id } = await run(pipeline.id);
    await tick();
    expect(await body(await req(`/automation/runs/${id}`))).toMatchObject({
      status: "partial",
      steps: [{ output: { status: "unavailable" } }, { output: { status: "completed" } }],
    });
  });
  it("creates one follow-up from a source metric and skips a false condition", async () => {
    const withTasks = [...modules, "tasks"] as const;
    const taskApp = await makeApp({ seed: false, activeModules: withTasks, handle: ctx.handle });
    const call = (path: string, method = "GET", json?: unknown) =>
      taskApp.req(`/v1/workspaces/acme${path}`, { method, json, cookie: owner });
    const { teams } = await body(await call("/bootstrap"));
    const source = newId();
    const followUp = (title: string, value: number) => ({
      id: newId(),
      title,
      kind: "tasks.follow_up",
      teamId: teams[0].id,
      assigneeId: recipient.id,
      condition: { stepId: source, metric: "overdue_audits", operator: "gt", value },
    });
    const pipeline = await body(
      await call("/automation/pipelines", "POST", {
        name: "Audit follow-up",
        enabled: false,
        schedule: null,
        steps: [
          { id: source, title: "Audit requirements", kind: "quality.audit_requirements" },
          followUp("Check overdue audits", 0),
          followUp("Escalate overdue audits", 10),
        ],
      }),
      201,
    );
    const { id } = await body(
      await call(`/automation/pipelines/${pipeline.id}/run`, "POST", { commandId: newId() }),
      202,
    );
    const process = () => tickAutomationPipelines(ctx.handle.db, withTasks, now);
    await Promise.all([process(), process()]);
    const report = await body(await call(`/automation/runs/${id}`));
    expect(report).toMatchObject({
      status: "completed",
      steps: [
        { output: { status: "completed" } },
        { output: { status: "completed", artifact: { kind: "task" } } },
        { output: { status: "skipped" } },
      ],
    });
    const task = await body(await call(`/tasks/${report.steps[1].output.artifact.id}`));
    expect(task).toMatchObject({ title: "Check overdue audits", assigneeId: recipient.id });
  });
  it("runs from a committed module event and records the trigger", async () => {
    const pipeline = await body(
      await req("/automation/pipelines", "POST", {
        name: "Audit planned report",
        enabled: true,
        schedule: null,
        eventTriggers: ["quality.audit_planned"],
        steps: [{ id: newId(), kind: "quality.audit_requirements", title: "Audit requirements" }],
      }),
      201,
    );
    const audit = await body(
      await req("/quality/audits", "POST", {
        title: "New event audit",
        plannedOn: addDaysToIsoDate(today, 2),
      }),
      201,
    );
    await tick();
    await tick();
    const records = await ctx.handle.db
      .select()
      .from(automationPipelineRuns)
      .where(eq(automationPipelineRuns.pipelineId, pipeline.id));
    expect(records).toHaveLength(1);
    expect(records[0]?.key).toBe(`event:quality.audit_planned:${audit.id}`);
    const report = await body(await req(`/automation/runs/${records[0]!.id}`));
    expect(report).toMatchObject({ trigger: "Audit planned", status: "completed" });
  });
  it("queues the audit-planned event for a recurring audit programme", async () => {
    const pipeline = await body(
      await req("/automation/pipelines", "POST", {
        name: "Programme report",
        enabled: true,
        schedule: null,
        eventTriggers: ["quality.audit_planned"],
        steps: [{ id: newId(), kind: "quality.audit_requirements", title: "Audit requirements" }],
      }),
      201,
    );
    await body(
      await req("/quality/audit-programmes", "POST", {
        title: "Annual programme",
        nextPlannedOn: today,
        intervalMonths: 12,
      }),
      201,
    );
    await tick();
    const records = await ctx.handle.db
      .select()
      .from(automationPipelineRuns)
      .where(eq(automationPipelineRuns.pipelineId, pipeline.id));
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("completed");
  });

  it("queues a Stock receipt trigger once across receipt retries", async () => {
    const pipeline = await body(
      await req("/automation/pipelines", "POST", {
        name: "New stock report",
        enabled: true,
        schedule: null,
        eventTriggers: ["stock.received"],
        steps: [{ id: newId(), kind: "stock.position", title: "Stock position", locationId, limit: 30 }],
      }),
      201,
    );
    const receipt = {
      commandId: newId(),
      itemId,
      locationId,
      quantity: 2,
      unit: "kg",
      receivedOn: today,
      reason: "Opening balance",
    };
    const first = await body(await req("/stock/receipts", "POST", receipt), 201);
    const retry = await body(await req("/stock/receipts", "POST", receipt), 201);
    expect(retry.id).toBe(first.id);
    await tick();
    const records = await ctx.handle.db
      .select()
      .from(automationPipelineRuns)
      .where(eq(automationPipelineRuns.pipelineId, pipeline.id));
    expect(records).toHaveLength(1);
    expect((await body(await req(`/automation/runs/${records[0]!.id}`))).trigger).toBe(
      "Stock receipt recorded",
    );
  });

  it("rechecks the initiating manager’s source grants before executing a queued report", async () => {
    expect((await grant("automation", "manage")).status).toBe(200);
    expect((await grant("quality", "read")).status).toBe(200);
    const pipeline = await body(
      await req(
        "/automation/pipelines",
        "POST",
        {
          name: "Manager’s report",
          enabled: false,
          schedule: null,
          steps: [{ id: newId(), kind: "quality.audit_requirements", title: "Audit requirements" }],
        },
        recipient.cookie,
      ),
      201,
    );
    const { id } = await body(
      await req(`/automation/pipelines/${pipeline.id}/run`, "POST", { commandId: newId() }, recipient.cookie),
      202,
    );
    expect((await grant("quality", "none")).status).toBe(200);
    await tick();
    const report = await body(await req(`/automation/runs/${id}`));
    expect(report).toMatchObject({ status: "failed", steps: [{ output: { status: "unavailable" } }] });
    expect(report.steps[0].output.rows).toBeUndefined();
  });
});
