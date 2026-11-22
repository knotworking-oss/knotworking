import { addDaysToIsoDate, addMonthsToIsoDate, DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepDueNotifications } from "./services/notification-sweep";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
const DEPENDENCIES = ["items", "recipes", "stock", "demand", "production"] as const;
const MODULES = [...DEPENDENCIES, "haccp"] as const;

const hazard = (extra: object = {}) => ({
  hazardType: "biological",
  description: "Survival of pathogens",
  likelihood: 4,
  severity: 4,
  controlMeasure: "Cook to 75C",
  q1: true,
  q2: true,
  ...extra,
});
const step = (ref: string, name: string) => ({ ref, name, hazards: [hazard()] });
const ccp = (code: string, extra: object = {}) => ({
  code,
  processStep: "Cooking",
  hazardType: "biological",
  hazard: "Survival of pathogens",
  limitType: "range",
  limitMin: 75,
  limitUnit: "°C",
  monitoringMethod: "Probe",
  frequency: { every: 1, unit: "day" },
  responsibleRole: "Cook",
  correctiveAction: "Keep cooking",
  verification: "Daily review",
  ...extra,
});

describe("HACCP hazard library, plan templates, hazard review and bulk sign-off", () => {
  let ctx: TestCtx;
  let ada: { cookie: string; userId: string };
  let marcus: { cookie: string; userId: string };
  let agentToken: string;
  const send = (cookie: string, method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const asAgent = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, {
      method,
      headers: { authorization: `Bearer ${agentToken}`, origin: "" },
      json,
    });
  const ok = async (res: Awaited<ReturnType<TestCtx["req"]>>, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const code = async (res: Awaited<ReturnType<TestCtx["req"]>>, status: number) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body.error.code as string;
  };
  /** A plan with a hazard analysis, approved by the other manager (four-eyes). */
  const approvedPlan = async (codeName: string, approve: object = {}, steps = [step("cook", "Cooking")]) => {
    const created = await ok(
      await send(ada.cookie, "POST", "/haccp/plans", {
        code: codeName,
        name: `Plan ${codeName}`,
        draft: { steps, ccps: [ccp("CCP1", steps.length ? { stepRef: steps[0]!.ref } : {})] },
      }),
      201,
    );
    await ok(await send(marcus.cookie, "POST", `/haccp/plans/${created.id}/draft/approve`, approve));
    return created.id as string;
  };
  const sweep = () =>
    sweepDueNotifications(ctx.handle.db, {
      activeModules: [...MODULES],
    });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    const login = await signIn(ctx, "ada@knotworking.dev");
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: login.cookie })).json();
    const who = async (name: string) => {
      const m = members.find((x: { email: string }) => x.email === `${name}@knotworking.dev`);
      return { userId: m.userId as string, cookie: (await signIn(ctx, m.email)).cookie };
    };
    ada = await who("ada");
    marcus = await who("marcus");
    agentToken = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada.cookie,
          json: { name: "agent", scope: "write" },
        })
      ).json()
    ).token as string;
    for (const id of DEPENDENCIES) {
      await ok(
        await send(ada.cookie, "PUT", `/members/${marcus.userId}/module-access/${id}`, { level: "write" }),
      );
    }
    await ok(
      await send(ada.cookie, "PUT", `/members/${marcus.userId}/module-access/haccp`, { level: "manage" }),
    );
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("hazard library", () => {
    let entryId: string;
    it("keeps reusable hazards, with their risk and where the decision tree leads", async () => {
      const entry = await ok(
        await send(ada.cookie, "POST", "/haccp/library", {
          title: "Listeria in ready-to-eat food",
          stepName: "Cooking",
          ...hazard({ description: "Listeria monocytogenes survives" }),
        }),
        201,
      );
      entryId = entry.id;
      expect(entry).toMatchObject({
        risk: { score: 16, level: "high" },
        outcome: "ccp",
        stepName: "Cooking",
      });
      await ok(
        await send(ada.cookie, "POST", "/haccp/library", {
          title: "Metal fragments",
          ...hazard({
            hazardType: "physical",
            description: "Metal from the mixer",
            likelihood: 2,
            severity: 5,
            controlMeasure: "Metal detector",
          }),
        }),
        201,
      );
      const all = await ok(await send(ada.cookie, "GET", "/haccp/library"));
      expect(all.entries.map((e: { title: string }) => e.title)).toEqual([
        "Listeria in ready-to-eat food",
        "Metal fragments",
      ]);
      const physical = await ok(await send(ada.cookie, "GET", "/haccp/library?hazardType=physical"));
      expect(physical.total).toBe(1);
      const found = await ok(await send(ada.cookie, "GET", "/haccp/library?q=cooking"));
      expect(found.entries.map((e: { id: string }) => e.id)).toEqual([entryId]);
    });

    it("refuses an entry whose decision tree answers or control measure don't hold together", async () => {
      expect(
        await code(
          await send(ada.cookie, "POST", "/haccp/library", {
            title: "Bad",
            ...hazard({ q1: false, q2: true }),
          }),
          400,
        ),
      ).toBeTruthy();
      expect(
        await code(
          await send(ada.cookie, "POST", "/haccp/library", {
            title: "No control",
            ...hazard({ controlMeasure: null }),
          }),
          400,
        ),
      ).toBeTruthy();
    });

    it("replaces and deletes an entry, and lets an API token keep the library", async () => {
      const updated = await ok(
        await send(ada.cookie, "PUT", `/haccp/library/${entryId}`, {
          title: "Listeria (updated)",
          ...hazard({ severity: 5 }),
        }),
      );
      expect(updated).toMatchObject({ title: "Listeria (updated)", risk: { score: 20 }, stepName: null });
      const fromAgent = await ok(
        await asAgent("POST", "/haccp/library", { title: "Agent's", ...hazard({ hazardType: "chemical" }) }),
        201,
      );
      expect((await asAgent("DELETE", `/haccp/library/${fromAgent.id}`)).status).toBe(204);
      expect(await code(await send(ada.cookie, "GET", `/haccp/library/${fromAgent.id}`), 404)).toBe(
        "not_found",
      );
    });
  });

  describe("plan templates", () => {
    let templateId: string;
    it("saves a template, starts a plan from it and keeps the plan independent of it", async () => {
      const template = await ok(
        await send(ada.cookie, "POST", "/haccp/templates", {
          name: "Cooked chilled",
          description: "Cook-chill lines",
          steps: [step("cook", "Cooking")],
          ccps: [ccp("CCP1", { stepRef: "cook" })],
        }),
        201,
      );
      templateId = template.id;
      expect(template).toMatchObject({ stepCount: 1, hazardCount: 1, ccpCount: 1, name: "Cooked chilled" });

      const plan = await ok(
        await send(ada.cookie, "POST", "/haccp/plans", {
          code: "HACCP-T1",
          name: "From template",
          templateId,
        }),
        201,
      );
      const draft = plan.draftVersion;
      expect(draft.steps.map((s: { name: string }) => s.name)).toEqual(["Cooking"]);
      expect(draft.ccps.map((c: { code: string }) => c.code)).toEqual(["CCP1"]);
      expect(draft.ccps[0].stepId).toBe(draft.steps[0].id);
      expect(draft.changeNote).toContain("Cooked chilled");
      expect(draft.scope.wholeSite).toBe(true);

      // Editing the template afterwards leaves the plan's own copy alone.
      await ok(
        await send(ada.cookie, "PUT", `/haccp/templates/${templateId}`, {
          name: "Cooked chilled v2",
          steps: [],
          ccps: [],
        }),
      );
      const again = await ok(await send(ada.cookie, "GET", `/haccp/plans/${plan.id}`));
      expect(again.draftVersion.steps).toHaveLength(1);
      expect((await ok(await send(ada.cookie, "GET", `/haccp/templates/${templateId}`))).stepCount).toBe(0);
    });

    it("copies a plan into a template (its draft, else the version in force)", async () => {
      const planId = await approvedPlan("HACCP-T2");
      const template = await ok(
        await send(ada.cookie, "POST", "/haccp/templates", { name: "From plan", fromPlanId: planId }),
        201,
      );
      expect(template).toMatchObject({ stepCount: 1, ccpCount: 1 });
      expect(template.ccps[0].stepRef).toBe(template.steps[0].ref);
      // And the copy starts a valid plan.
      const started = await ok(
        await send(ada.cookie, "POST", "/haccp/plans", {
          code: "HACCP-T3",
          name: "Copy",
          templateId: template.id,
        }),
        201,
      );
      expect(started.draftVersion.ccps[0].limitMin).toBe(75);
      expect(
        await code(
          await send(ada.cookie, "POST", "/haccp/templates", {
            name: "Both",
            fromPlanId: planId,
            steps: [step("a", "A")],
          }),
          400,
        ),
      ).toBeTruthy();
    });

    it("refuses a draft and a template together, an unknown template, and a deleted one", async () => {
      expect(
        await code(
          await send(ada.cookie, "POST", "/haccp/plans", {
            code: "HACCP-T4",
            name: "Both",
            templateId,
            draft: { ccps: [] },
          }),
          400,
        ),
      ).toBeTruthy();
      expect(
        await code(
          await send(ada.cookie, "POST", "/haccp/plans", {
            code: "HACCP-T4",
            name: "Nope",
            templateId: "00000000-0000-4000-8000-000000000000",
          }),
          404,
        ),
      ).toBe("not_found");
      expect((await send(ada.cookie, "DELETE", `/haccp/templates/${templateId}`)).status).toBe(204);
      expect(
        await code(
          await send(ada.cookie, "POST", "/haccp/plans", { code: "HACCP-T4", name: "Gone", templateId }),
          404,
        ),
      ).toBe("not_found");
      // Nothing was left half-created: the code is still free.
      await ok(await send(ada.cookie, "POST", "/haccp/plans", { code: "HACCP-T4", name: "Free" }), 201);
    });
  });

  describe("hazard analysis review", () => {
    it("starts the hazard review cycle when a version with a hazard analysis is approved", async () => {
      const planId = await approvedPlan("HACCP-R1");
      const plan = await ok(await send(ada.cookie, "GET", `/haccp/plans/${planId}`));
      expect(plan).toMatchObject({
        hazardReviewedOn: today,
        hazardReviewDueOn: addMonthsToIsoDate(today, 12),
        hazardReviewState: "ok",
        hazardReviewedByName: expect.any(String),
        hazardReviewIntervalEffective: 12,
      });
      // The plan's own review date belongs to the version and is separate.
      expect(plan.currentVersion.reviewDueOn).toBe(addMonthsToIsoDate(today, 12));
    });

    it("leaves a plan with no hazard analysis without a hazard review date", async () => {
      const planId = await approvedPlan("HACCP-R2", {}, []);
      const plan = await ok(await send(ada.cookie, "GET", `/haccp/plans/${planId}`));
      expect(plan.hazardReviewDueOn).toBeNull();
      expect(plan.hazardReviewState).toBeNull();
      expect(
        await code(await send(marcus.cookie, "POST", `/haccp/plans/${planId}/hazard-review`, {}), 409),
      ).toBe("no_hazard_analysis");
      expect(
        await code(
          await send(ada.cookie, "POST", `/haccp/plans/${planId}/draft/approve`, {
            hazardReviewDueOn: addDaysToIsoDate(today, 90),
          }),
          409,
        ),
      ).toBeTruthy();
    });

    it("uses its own interval, and a review moves the date on; tokens and writers can't review", async () => {
      const planId = await approvedPlan("HACCP-R3", { hazardReviewDueOn: addDaysToIsoDate(today, 20) });
      let plan = await ok(await send(ada.cookie, "GET", `/haccp/plans/${planId}`));
      expect(plan.hazardReviewDueOn).toBe(addDaysToIsoDate(today, 20));
      expect(plan.hazardReviewState).toBe("soon");

      plan = await ok(
        await send(ada.cookie, "PATCH", `/haccp/plans/${planId}`, { hazardReviewIntervalMonths: 6 }),
      );
      expect(plan).toMatchObject({ hazardReviewIntervalMonths: 6, hazardReviewIntervalEffective: 6 });
      // The plan's review interval is unchanged.
      expect(plan.reviewIntervalMonths).toBe(12);

      expect((await asAgent("POST", `/haccp/plans/${planId}/hazard-review`, {})).status).toBe(403);
      expect(
        await code(
          await send(ada.cookie, "POST", `/haccp/plans/${planId}/hazard-review`, { nextDueOn: today }),
          400,
        ),
      ).toBeTruthy();
      const reviewed = await ok(
        await send(marcus.cookie, "POST", `/haccp/plans/${planId}/hazard-review`, { note: "No change" }),
      );
      expect(reviewed).toMatchObject({
        hazardReviewedOn: today,
        hazardReviewDueOn: addMonthsToIsoDate(today, 6),
        hazardReviewNote: "No change",
        hazardReviewState: "ok",
      });
      // Clearing the hazard interval falls back to the plan's.
      plan = await ok(
        await send(ada.cookie, "PATCH", `/haccp/plans/${planId}`, { hazardReviewIntervalMonths: null }),
      );
      expect(plan.hazardReviewIntervalEffective).toBe(12);
    });

    it("notifies the managers once when the hazard review falls due, and stops once it is done", async () => {
      const planId = await approvedPlan("HACCP-R4", {
        effectiveOn: addDaysToIsoDate(today, -30),
        hazardReviewDueOn: addDaysToIsoDate(today, -2),
      });
      const first = await sweep();
      const due = first.created.filter((n) => n.type === "hazard_review_due");
      expect(due.length).toBeGreaterThan(0);
      expect(due.some((n) => n.userId === marcus.userId)).toBe(true);
      expect(due.every((n) => (n.data as { subjectId: string }).subjectId === planId)).toBe(true);
      expect(due[0]!.data).toMatchObject({ dueState: "overdue", dueOn: addDaysToIsoDate(today, -2) });
      expect((await sweep()).created.filter((n) => n.type === "hazard_review_due")).toHaveLength(0);

      await ok(await send(marcus.cookie, "POST", `/haccp/plans/${planId}/hazard-review`, {}));
      expect((await sweep()).created.filter((n) => n.type === "hazard_review_due")).toHaveLength(0);
    });
  });

  describe("sign-off of a day for several plans or the whole site", () => {
    let a: string;
    let b: string;
    let c: string;
    const signoffsOf = async (planId: string) =>
      (await ok(await send(ada.cookie, "GET", `/haccp/signoffs?planId=${planId}`))).signoffs as unknown[];
    const logFor = async (planId: string, via: "person" | "agent") => {
      const plan = await ok(await send(ada.cookie, "GET", `/haccp/plans/${planId}`));
      const ccpId = plan.currentVersion.ccps[0].id;
      const res =
        via === "agent"
          ? await asAgent("POST", "/haccp/logs", { ccpId, value: 80 })
          : await send(ada.cookie, "POST", "/haccp/logs", { ccpId, value: 80 });
      return ok(res, 201);
    };

    beforeAll(async () => {
      a = await approvedPlan("HACCP-S1");
      b = await approvedPlan("HACCP-S2");
      c = await approvedPlan("HACCP-S3");
      await logFor(a, "person");
    });

    it("refuses tokens, writers and a request that names neither or both", async () => {
      expect((await asAgent("POST", "/haccp/signoffs/bulk", { planIds: [a], day: today })).status).toBe(403);
      expect(
        await code(await send(ada.cookie, "POST", "/haccp/signoffs/bulk", { day: today }), 400),
      ).toBeTruthy();
      expect(
        await code(
          await send(ada.cookie, "POST", "/haccp/signoffs/bulk", {
            planIds: [a],
            wholeSite: true,
            day: today,
          }),
          400,
        ),
      ).toBeTruthy();
      expect(
        await code(
          await send(ada.cookie, "POST", "/haccp/signoffs/bulk", { planIds: [a], day: "2999-01-01" }),
          400,
        ),
      ).toBeTruthy();
    });

    it("is all or nothing: an unknown plan or a plan with readings awaiting review signs none off", async () => {
      expect(
        await code(
          await send(ada.cookie, "POST", "/haccp/signoffs/bulk", {
            planIds: [a, "00000000-0000-4000-8000-000000000000"],
            day: today,
          }),
          404,
        ),
      ).toBe("not_found");
      await logFor(b, "agent");
      const res = await send(ada.cookie, "POST", "/haccp/signoffs/bulk", { planIds: [a, b], day: today });
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(body.error.code).toBe("readings_pending");
      expect(body.error.details.planIds).toEqual([b]);
      expect(body.error.message).toContain("HACCP-S2");
      expect(await signoffsOf(a)).toHaveLength(0);
      expect(await signoffsOf(b)).toHaveLength(0);
    });

    it("signs several plans off in one step once the readings are reviewed, once per plan and day", async () => {
      const queue = await ok(
        await send(ada.cookie, "GET", "/haccp/logs?review=pending&includeCorrected=false"),
      );
      await ok(
        await send(marcus.cookie, "POST", "/haccp/logs/review", {
          ids: queue.logs.map((l: { id: string }) => l.id),
          decision: "approve",
        }),
      );
      const done = await ok(
        await send(marcus.cookie, "POST", "/haccp/signoffs/bulk", {
          planIds: [a, b],
          day: today,
          note: "Reviewed together",
        }),
        201,
      );
      expect(done.signedOff).toBe(2);
      expect(done.signoffs.map((s: { plan: { code: string } }) => s.plan.code)).toEqual([
        "HACCP-S1",
        "HACCP-S2",
      ]);
      expect(done.signoffs[0]).toMatchObject({
        checkCount: 1,
        note: "Reviewed together",
        signedBy: marcus.userId,
      });
      const second = await send(ada.cookie, "POST", "/haccp/signoffs/bulk", { planIds: [a, c], day: today });
      const body = await second.json();
      expect(second.status).toBe(409);
      expect(body.error.code).toBe("already_signed_off");
      expect(body.error.details.planIds).toEqual([a]);
      // Nothing was signed off for C by the refused request.
      expect(await signoffsOf(c)).toHaveLength(0);
    });

    it("signs the whole site off, leaving plans already signed as they are", async () => {
      const done = await ok(
        await send(ada.cookie, "POST", "/haccp/signoffs/bulk", { wholeSite: true, day: today }),
        201,
      );
      const signedCodes = done.signoffs.map((s: { plan: { code: string } }) => s.plan.code);
      expect(signedCodes).toContain("HACCP-S3");
      expect(signedCodes).not.toContain("HACCP-S1");
      expect(done.skipped.map((p: { code: string }) => p.code)).toEqual(
        expect.arrayContaining(["HACCP-S1", "HACCP-S2"]),
      );
      expect(await signoffsOf(c)).toHaveLength(1);
      // Everything is signed now.
      expect(
        await code(
          await send(ada.cookie, "POST", "/haccp/signoffs/bulk", { wholeSite: true, day: today }),
          409,
        ),
      ).toBe("already_signed_off");
    });

    it("signs the whole site off for a day no plan was in force", async () => {
      expect(
        await code(
          await send(ada.cookie, "POST", "/haccp/signoffs/bulk", {
            wholeSite: true,
            day: addDaysToIsoDate(today, -2000),
          }),
          409,
        ),
      ).toBe("no_plans_in_force");
    });
  });
});
