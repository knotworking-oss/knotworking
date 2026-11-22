import { afterEach, describe, expect, it } from "vitest";
import { READ_TOKEN } from "../testing/fake-api";
import { connect } from "../testing/harness";

type Session = Awaited<ReturnType<typeof connect>>;
const open: Session[] = [];
async function session(options: Parameters<typeof connect>[0] = {}) {
  const s = await connect(options);
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

const ccp = {
  code: "CCP3",
  process_step: "Metal detection",
  hazard_type: "physical",
  hazard: "Metal fragments",
  limit_type: "pass_fail",
  pass_criterion: "Test pieces rejected",
  monitoring_method: "Pass the three test pieces",
  frequency_every: 1,
  frequency_unit: "hour",
  during_production: true,
  responsible_role: "Line leader",
  corrective_action: "Hold product since the last good check",
  verification: "QA reviews the log daily",
};

describe("haccp tools", () => {
  it("offers ten tools, none for reviewing readings, cleaning, calibration, approval or closing", async () => {
    const { client } = await session();
    const { tools } = await client.listTools();
    const haccp = tools.filter((t) => /haccp|corrective|ccp/.test(t.name)).map((t) => t.name);
    expect(haccp.sort()).toEqual(
      [
        "get_haccp_plan",
        "draft_haccp_plan",
        "get_haccp_library",
        "save_haccp_library_entry",
        "start_haccp_plan_from_template",
        "list_haccp_records",
        "list_haccp_deviations",
        "list_haccp_record_attachments",
        "get_haccp_due",
        "propose_corrective_action",
        "record_ccp_readings",
      ].sort(),
    );
    expect(tools.map((t) => t.name).join(" ")).not.toMatch(
      /record_(cleaning|calibration)|approve|(review|reject)_(ccp|haccp|reading)|close_corrective|verify/,
    );
    for (const name of [
      "draft_haccp_plan",
      "save_haccp_library_entry",
      "start_haccp_plan_from_template",
      "propose_corrective_action",
      "record_ccp_readings",
    ]) {
      expect(tools.find((t) => t.name === name)!.description).toMatch(/signed by people in the app/);
    }
    const record = tools.find((t) => t.name === "record_ccp_readings")!;
    expect(record.description).toMatch(/await review by a person with manage access/);
    expect(record.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it("records readings by CCP code, pending review, and opens a corrective action for a deviation", async () => {
    const { call, fake } = await session();
    const batch = {
      id: "0196f000-0000-7000-8000-00000000b001",
      batchCode: "B261111-001",
      status: "in_progress",
    };
    fake.productionModule.batches.push(batch);
    const plan = (await call("get_haccp_plan", { plan: "HACCP-01" })).data.currentVersion;
    const res = await call("record_ccp_readings", {
      readings: [
        { ccp: "ccp1", value: 78, batch: batch.id, note: "Largest piece" },
        { ccp: plan.ccps[1].id, value: 7.5, checked_at: "2026-11-11T08:30:00Z" },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ recorded: 2, failed: 0, outOfLimits: 1 });
    expect(res.data.note).toMatch(/await review/);
    expect(res.data.readings[0]).toMatchObject({
      recorded: true,
      ccp: "CCP1",
      reading: "78 °C",
      withinLimits: true,
      batch: "B261111-001",
      reviewStatus: "pending",
      correctiveAction: null,
    });
    expect(res.data.readings[1]).toMatchObject({
      ccp: "CCP2",
      withinLimits: false,
      deviationReason: "above_max",
      reviewStatus: "pending",
      correctiveAction: expect.objectContaining({ status: "open" }),
    });
    const stored = fake.haccpModule.logs.find((l) => l.id === res.data.readings[1].id)!;
    expect(stored).toMatchObject({
      source: "api",
      reviewStatus: "pending",
      checkedAt: "2026-11-11T08:30:00Z",
    });
    expect(fake.haccpModule.actions.find((a) => a.logId === stored.id)).toMatchObject({ source: "api" });

    const pending = await call("list_haccp_records", { review: "pending" });
    expect(pending.data.logs.map((l: { id: string }) => l.id).sort()).toEqual(
      res.data.readings.map((r: { id: string }) => r.id).sort(),
    );
    expect(pending.data.logs[0]).toMatchObject({ reviewStatus: "pending", reviewedBy: null, source: "api" });
    expect((await call("list_haccp_records", { review: "approved" })).data.logs).toHaveLength(2);
    expect((await call("get_haccp_due")).data.counts.awaitingReview).toBe(2);
  });

  it("resolves every reading before recording any, and reports readings the API refuses", async () => {
    const { call, fake } = await session();
    const before = fake.haccpModule.logs.length;
    const unknown = await call("record_ccp_readings", {
      readings: [
        { ccp: "CCP1", value: 80 },
        { ccp: "CCP9", value: 1 },
      ],
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.data.error.code).toBe("not_found");
    expect(unknown.data.error.message).toMatch(/Nothing was recorded/);
    const both = await call("record_ccp_readings", { readings: [{ ccp: "CCP1", value: 80, passed: true }] });
    expect(both.data.error.code).toBe("invalid_input");
    expect(fake.haccpModule.logs).toHaveLength(before);

    const partly = await call("record_ccp_readings", {
      readings: [
        { ccp: "CCP1", passed: true },
        { ccp: "CCP2", value: 4 },
      ],
    });
    expect(partly.isError).toBe(false);
    expect(partly.data).toMatchObject({ recorded: 1, failed: 1 });
    expect(partly.data.readings[0]).toMatchObject({ recorded: false, error: { code: "invalid_input" } });
    expect(fake.haccpModule.logs).toHaveLength(before + 1);
  });

  it("refuses readings from a read-only token", async () => {
    const { call } = await session({ token: READ_TOKEN });
    const res = await call("record_ccp_readings", { readings: [{ ccp: "CCP1", value: 80 }] });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe("token_read_only");
  });

  it("lists plans, and reads one by code with its CCPs and critical limits", async () => {
    const { call } = await session();
    const list = await call("get_haccp_plan");
    expect(list.isError).toBe(false);
    expect(list.data.plans).toEqual([
      expect.objectContaining({ code: "HACCP-01", currentVersion: 1, ccps: 2, hasDraft: false }),
    ]);
    const plan = await call("get_haccp_plan", { plan: "haccp-01" });
    expect(plan.data.currentVersion.ccps).toEqual([
      expect.objectContaining({ code: "CCP1", criticalLimit: "≥ 75 °C", frequency: "Every batch" }),
      expect.objectContaining({ code: "CCP2", criticalLimit: "≤ 5 °C", frequency: "Every 2 hours" }),
    ]);
    const missing = await call("get_haccp_plan", { plan: "HACCP-99" });
    expect(missing.isError).toBe(true);
    expect(missing.data.error.code).toBe("not_found");
  });

  it("drafts a change to an existing plan without touching the approved version", async () => {
    const { call, fake } = await session();
    const current = (await call("get_haccp_plan", { plan: "HACCP-01" })).data.currentVersion;
    const keep = current.ccps.map((c: Record<string, any>) => ({
      code: c.code,
      process_step: c.processStep,
      hazard_type: c.hazardType,
      hazard: c.hazard,
      limit_type: c.limitType,
      limit_min: c.limitMin,
      limit_max: c.limitMax,
      limit_unit: c.limitUnit,
      monitoring_method: c.monitoringMethod,
      frequency_every: c.frequencyEvery,
      frequency_unit: c.frequencyUnit,
      during_production: c.duringProduction,
      responsible_role: c.responsibleRole,
      corrective_action: c.correctiveAction,
      verification: c.verification,
    }));
    const res = await call("draft_haccp_plan", {
      plan: "HACCP-01",
      change_note: "Add metal detection",
      ccps: [...keep, ccp],
    });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ created: false, draftVersion: { versionNumber: 2, status: "draft" } });
    expect(res.data.draftVersion.ccps.map((c: { code: string }) => c.code)).toEqual(["CCP1", "CCP2", "CCP3"]);
    const plan = fake.haccpModule.plans[0]!;
    expect(plan.versions.find((v) => v.status === "approved")!.ccps).toHaveLength(2);
  });

  it("saves the hazard analysis and keeps it when a later draft leaves steps out", async () => {
    const { call } = await session();
    const first = await call("draft_haccp_plan", {
      plan: "HACCP-01",
      steps: [
        {
          ref: "cook",
          name: "Cooking",
          hazards: [
            {
              hazard_type: "biological",
              description: "Survival of pathogens",
              likelihood: 4,
              severity: 5,
              control_measure: "Cook to 75 C",
              q1: true,
              q2: true,
            },
          ],
        },
      ],
      ccps: [{ ...ccp, code: "CCP1", step: "cook" }],
    });
    expect(first.isError).toBe(false);
    expect(first.data.draftVersion.steps[0]).toMatchObject({
      name: "Cooking",
      hazards: [{ risk: "high", outcome: "ccp" }],
    });
    const second = await call("draft_haccp_plan", {
      plan: "HACCP-01",
      change_note: "Reworded",
      ccps: [{ ...ccp, code: "CCP1" }],
    });
    expect(second.data.draftVersion.steps).toHaveLength(1);
    expect(second.data.draftVersion.ccps[0].stepId).toBe(second.data.draftVersion.steps[0].id);
  });

  it("creates a plan from a new code, and refuses invalid limits", async () => {
    const { call } = await session();
    const created = await call("draft_haccp_plan", {
      plan: "HACCP-02",
      name: "Bakery",
      scope_items: ["FLR-001"],
      ccps: [ccp],
    });
    expect(created.isError).toBe(false);
    expect(created.data).toMatchObject({ created: true, plan: { code: "HACCP-02" } });
    expect(created.data.draftVersion.scope.wholeSite).toBe(false);
    const noName = await call("draft_haccp_plan", { plan: "HACCP-03", ccps: [] });
    expect(noName.data.error.code).toBe("not_found");
    const bad = await call("draft_haccp_plan", {
      plan: "HACCP-01",
      ccps: [{ ...ccp, limit_type: "range", pass_criterion: null }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.data.error.code).toBe("invalid_input");
  });

  it("lists CCP records and deviations, cleaning and calibration", async () => {
    const { call } = await session();
    const all = await call("list_haccp_records");
    expect(all.data.logs).toHaveLength(2);
    const out = await call("list_haccp_records", { out_of_limits: true });
    expect(out.data.logs).toEqual([
      expect.objectContaining({ ccp: "CCP2", reading: "9 °C", withinLimits: false, criticalLimit: "≤ 5 °C" }),
    ]);
    const noPlan = await call("list_haccp_records", { ccp: "CCP2" });
    expect(noPlan.data.error.code).toBe("invalid_input");
    expect((await call("list_haccp_records", { kind: "cleaning" })).data.records[0]).toMatchObject({
      asset: "Line 1 (L1)",
    });
    expect((await call("list_haccp_records", { kind: "calibration" })).data.records[0]).toMatchObject({
      passed: true,
      nextDueOn: "2026-12-11",
    });
    const deviations = await call("list_haccp_deviations");
    expect(deviations.data.correctiveActions).toEqual([
      expect.objectContaining({
        status: "open",
        deviation: expect.objectContaining({ ccp: "CCP2", reading: "9 °C" }),
        missing: ["actionTaken", "rootCause", "preventiveAction"],
      }),
    ]);
  });

  it("says what is due", async () => {
    const { call } = await session();
    const due = await call("get_haccp_due");
    expect(due.data.checks.map((c: { label: string }) => c.label)).toEqual(["CCP2 Chilling", "Clean Line 1"]);
    expect(due.data.batchesInProgress).toEqual(["B261111-001"]);
    const all = await call("get_haccp_due", { include: "all", kind: "calibration" });
    expect(all.data.checks).toEqual([expect.objectContaining({ state: "ok", frequency: "Monthly" })]);
  });

  it("proposes and fills in corrective actions, but can't close them", async () => {
    const { call, fake } = await session();
    const open = (await call("list_haccp_deviations")).data.correctiveActions[0];
    const filled = await call("propose_corrective_action", {
      corrective_action: open.id,
      root_cause: "Chiller door left open",
      preventive_action: "Door alarm fitted",
    });
    expect(filled.data).toMatchObject({ status: "open", missing: ["actionTaken"] });
    const raised = await call("propose_corrective_action", { title: "Retrain night shift on chilling" });
    expect(raised.data).toMatchObject({ status: "open" });
    expect(fake.haccpModule.actions.find((a) => a.id === raised.data.id)).toMatchObject({ source: "api" });
    const goodLog = fake.haccpModule.logs.find((l) => l.withinLimits)!;
    const refused = await call("propose_corrective_action", { title: "x", deviation: goodLog.id });
    expect(refused.isError).toBe(true);
    expect((await call("propose_corrective_action", {})).data.error.code).toBe("invalid_input");
  });

  it("keeps the hazard library and starts a plan from a template", async () => {
    const { call } = await session();
    const hazard = {
      hazard_type: "biological",
      description: "Listeria survives",
      likelihood: 4,
      severity: 4,
      control_measure: "Cook to 75C",
      q1: true,
      q2: true,
    };
    const saved = await call("save_haccp_library_entry", { title: "Listeria", step_name: "Cooking", hazard });
    expect(saved.isError).toBe(false);
    expect(saved.data).toMatchObject({ title: "Listeria", risk: "high", outcome: "ccp" });
    const bad = await call("save_haccp_library_entry", { title: "Bad", hazard: { ...hazard, q1: false } });
    expect(bad.isError).toBe(true);
    const listed = await call("get_haccp_library", { q: "listeria" });
    expect(listed.data.hazards.map((h: { title: string }) => h.title)).toEqual(["Listeria"]);

    const templates = await call("get_haccp_library", { kind: "templates" });
    expect(templates.data.templates[0]).toMatchObject({ name: "Cook-chill", ccps: ["CCP1"] });
    const started = await call("start_haccp_plan_from_template", {
      plan: "HACCP-09",
      name: "From template",
      template: "cook-chill",
    });
    expect(started.isError).toBe(false);
    expect(started.data.draftVersion.steps.map((s: { name: string }) => s.name)).toEqual(["Cooking"]);
    expect(started.data.draftVersion.ccps.map((c: { code: string }) => c.code)).toEqual(["CCP1"]);
    const missing = await call("start_haccp_plan_from_template", {
      plan: "HACCP-10",
      name: "Nope",
      template: "No such template",
    });
    expect(missing.isError).toBe(true);
  });
});
