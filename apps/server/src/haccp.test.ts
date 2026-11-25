import { addDays, DEFAULT_TIME_ZONE, parseActiveModules, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
const DEPENDENCIES = ["items", "recipes", "stock", "demand", "production"] as const;

const cooking = {
  code: "CCP1",
  processStep: "Cooking",
  hazardType: "biological",
  hazard: "Survival of vegetative pathogens",
  limitType: "range",
  limitMin: 75,
  limitUnit: "°C",
  monitoringMethod: "Probe the core of the largest piece",
  frequency: { every: 1, unit: "batch" },
  responsibleRole: "Cook",
  correctiveAction: "Continue cooking until the core reaches 75 °C",
  verification: "Supervisor reviews the log daily",
};
const chilling = {
  ...cooking,
  code: "CCP2",
  processStep: "Blast chilling",
  hazard: "Growth of spore formers",
  limitMin: null,
  limitMax: 5,
  frequency: { every: 2, unit: "hour" },
  duringProduction: true,
  correctiveAction: "Move to a working chiller; assess product",
};
const metal = {
  ...cooking,
  code: "CCP3",
  processStep: "Metal detection",
  hazardType: "physical",
  hazard: "Metal fragments",
  limitType: "pass_fail",
  limitMin: null,
  limitUnit: null,
  passCriterion: "Test pieces rejected; no metal detected",
  frequency: { every: 1, unit: "day" },
};

describe("haccp module", () => {
  let ctx: TestCtx;
  let ada: string;
  let adaId: string;
  let marcus: { cookie: string; userId: string };
  let agentToken: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (token: string, method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  const grant = (moduleId: string, level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
  const ok = async (res: Awaited<ReturnType<TestCtx["req"]>>, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const error = async (res: Awaited<ReturnType<TestCtx["req"]>>, status: number) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body.error.code as string;
  };

  // Fixtures.
  let soup: string; // finished item the plan covers
  let bread: string; // finished item no plan covers
  let soupBatch: string; // in progress
  let breadBatch: string; // in progress, out of scope
  let plannedBatch: string;
  let reviewBatch: string; // in progress, for readings that are reviewed
  let soupLot: string;
  let plan: string;
  let ccps: Record<string, string>; // code → CCP id of the current version

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    adaId = (await (await ctx.req("/v1/me", { cookie: ada })).json()).user.id;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    agentToken = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write" },
        })
      ).json()
    ).token as string;

    const item = async (body: object) => (await ok(await as(ada).send("POST", "/items", body), 201)).id;
    const veg = await item({ code: "VEG", name: "Vegetables", type: "ingredient", unit: "kg" });
    soup = await item({ code: "SOUP", name: "Soup", type: "finished", unit: "l" });
    bread = await item({ code: "BRD", name: "Bread", type: "finished", unit: "each" });
    const recipe = async (code: string, outputItemId: string, yieldUnit: string) => {
      const r = await ok(
        await as(ada).send("POST", "/recipes", {
          code,
          name: code,
          outputItemId,
          draft: { yieldQuantity: 10, yieldUnit, lines: [{ itemId: veg, quantity: 5, unit: "kg" }] },
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/recipes/${r.id}/draft/approve`));
      return r.id as string;
    };
    const soupRecipe = await recipe("R-SOUP", soup, "l");
    const breadRecipe = await recipe("R-BRD", bread, "each");
    const batch = async (recipeId: string, start: boolean) => {
      const b = await ok(
        await as(ada).send("POST", "/production/batches", { recipeId, plannedOn: today, batches: 1 }),
        201,
      );
      if (start) await ok(await as(ada).send("POST", `/production/batches/${b.id}/start`));
      return b.id as string;
    };
    soupBatch = await batch(soupRecipe, true);
    breadBatch = await batch(breadRecipe, true);
    plannedBatch = await batch(soupRecipe, false);
    reviewBatch = await batch(soupRecipe, true);
    const store = (await ok(await as(ada).send("POST", "/stock/locations", { name: "Chiller" }), 201)).id;
    soupLot = (
      await ok(
        await as(ada).send("POST", "/stock/receipts", {
          itemId: veg,
          quantity: 10,
          unit: "kg",
          locationId: store,
          receivedOn: today,
        }),
        201,
      )
    ).id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("access", () => {
    it("is opt-in; items and production only enhance it", async () => {
      expect((await as(marcus.cookie).get("/haccp/plans")).status).toBe(403);
      await grant("haccp", "write");
      expect((await as(marcus.cookie).get("/haccp/plans")).status).toBe(200);
      for (const id of DEPENDENCIES) await grant(id, "read");
      expect((await as(marcus.cookie).get("/haccp/plans")).status).toBe(200);
    });

    it("is switched off with the module, and can be on without production", async () => {
      const off = await makeApp({ seed: true, activeModules: ["tasks", "docs", ...DEPENDENCIES] });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const res = await off.req(`${WS}/haccp/due`, { cookie });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("module_inactive");
      await off.handle.close();
      expect(parseActiveModules("haccp")).toEqual(["haccp"]);
    }, 60_000);
  });

  describe("the plan under document control", () => {
    it("lets an agent create and draft a plan, but not approve it", async () => {
      const created = await ok(
        await viaToken(agentToken, "POST", "/haccp/plans", {
          code: "HACCP-01",
          name: "Soups",
          draft: { scope: { itemIds: [soup] }, scopeNote: "Hot fill soups", ccps: [cooking] },
        }),
        201,
      );
      plan = created.id;
      expect(created.currentVersion).toBeNull();
      expect(created.draftVersion).toMatchObject({ versionNumber: 1, status: "draft" });
      expect(created.draftVersion.ccps[0]).toMatchObject({
        code: "CCP1",
        limitText: "≥ 75 °C",
        frequencyText: "Every batch",
      });
      expect(created.draftVersion.scope.items.map((i: { code: string }) => i.code)).toEqual(["SOUP"]);
      expect(
        await error(await viaToken(agentToken, "POST", `/haccp/plans/${plan}/draft/approve`, {}), 403),
      ).toBe("token_not_allowed");
      // Write access is not enough to approve.
      expect(
        await error(await as(marcus.cookie).send("POST", `/haccp/plans/${plan}/draft/approve`, {}), 403),
      ).toBe("module_forbidden");
    });

    it("checks codes, scope and limits", async () => {
      expect(
        await error(await as(ada).send("POST", "/haccp/plans", { code: "haccp-01", name: "Duplicate" }), 409),
      ).toBe("code_taken");
      const draft = (body: object) => as(ada).send("PUT", `/haccp/plans/${plan}/draft`, body);
      expect(
        await error(
          await draft({ scope: { itemIds: ["00000000-0000-7000-8000-000000000000"] }, ccps: [] }),
          400,
        ),
      ).toBe("invalid_input");
      expect(await error(await draft({ ccps: [{ ...cooking, limitMin: null }] }), 400)).toBe("invalid_input");
      expect(await error(await draft({ ccps: [cooking, { ...chilling, code: "ccp1" }] }), 400)).toBe(
        "invalid_input",
      );
    });

    it("refuses to approve a plan with no CCPs", async () => {
      const empty = await ok(
        await as(ada).send("POST", "/haccp/plans", { code: "HACCP-99", name: "Empty", draft: { ccps: [] } }),
        201,
      );
      expect(await error(await as(ada).send("POST", `/haccp/plans/${empty.id}/draft/approve`, {}), 400)).toBe(
        "invalid_input",
      );
      // Never approved: it can still be deleted.
      expect((await as(ada).send("DELETE", `/haccp/plans/${empty.id}`)).status).toBe(204);
    });

    it("approves version 1 with an effective date and a review date, recording who and when", async () => {
      await ok(
        await as(marcus.cookie).send("PUT", `/haccp/plans/${plan}/draft`, {
          scope: { itemIds: [soup] },
          ccps: [cooking, chilling, metal],
          changeNote: "First issue",
        }),
      );
      const v1 = await ok(await as(ada).send("POST", `/haccp/plans/${plan}/draft/approve`, {}));
      expect(v1).toMatchObject({
        status: "approved",
        versionNumber: 1,
        approvedBy: adaId,
        effectiveOn: today,
      });
      expect(v1.reviewDueOn > today).toBe(true);
      expect(v1.ccps.map((c: { code: string }) => c.code)).toEqual(["CCP1", "CCP2", "CCP3"]);
      ccps = Object.fromEntries(v1.ccps.map((c: { code: string; id: string }) => [c.code, c.id]));
      const got = await ok(await as(marcus.cookie).get(`/haccp/plans/${plan}`));
      expect(got.currentVersion.id).toBe(v1.id);
      expect(got.draftVersion).toBeNull();
      // An approved plan can be archived, not deleted.
      expect(await error(await as(ada).send("DELETE", `/haccp/plans/${plan}`), 409)).toBe("plan_approved");
    });

    it("archives and restores a plan only as a signed-in person with manage", async () => {
      // A write token can edit the header, but not take the plan out of force.
      expect(
        await error(await viaToken(agentToken, "PATCH", `/haccp/plans/${plan}`, { status: "archived" }), 400),
      ).toBe("invalid_input");
      expect(
        await error(
          await viaToken(agentToken, "PATCH", `/haccp/plans/${plan}`, { name: "Soups", status: "archived" }),
          400,
        ),
      ).toBe("invalid_input");
      expect(
        await error(
          await viaToken(agentToken, "POST", `/haccp/plans/${plan}/status`, { status: "archived" }),
          403,
        ),
      ).toBe("token_not_allowed");
      expect(
        await error(
          await as(marcus.cookie).send("POST", `/haccp/plans/${plan}/status`, { status: "archived" }),
          403,
        ),
      ).toBe("module_forbidden");
      expect((await ok(await as(ada).get(`/haccp/plans/${plan}`))).status).toBe("active");
      expect(
        (await ok(await viaToken(agentToken, "PATCH", `/haccp/plans/${plan}`, { description: "Hot fill" })))
          .description,
      ).toBe("Hot fill");

      const archived = await ok(
        await as(ada).send("POST", `/haccp/plans/${plan}/status`, { status: "archived" }),
      );
      expect(archived.status).toBe("archived");
      expect(
        await error(await as(ada).send("POST", "/haccp/logs", { ccpId: ccps.CCP2, value: 3 }), 409),
      ).toBe("plan_archived");
      const restored = await ok(
        await as(ada).send("POST", `/haccp/plans/${plan}/status`, { status: "active" }),
      );
      expect(restored.status).toBe("active");
    });
  });

  describe("CCP monitoring", () => {
    const record = (cookie: string, body: object) => as(cookie).send("POST", "/haccp/logs", body);

    it("records a reading within its limits, pinned to the approved version", async () => {
      const log = await ok(
        await record(marcus.cookie, { ccpId: ccps.CCP1, value: 82.5, batchId: soupBatch }),
        201,
      );
      expect(log).toMatchObject({
        ccpCode: "CCP1",
        withinLimits: true,
        deviationReason: null,
        source: "manual",
        recordedBy: marcus.userId,
        readingText: "82.5 °C",
        batch: { id: soupBatch },
        correctiveActions: [],
      });
    });

    it("flags an out-of-limit reading and opens a corrective action with it", async () => {
      const log = await ok(
        await record(marcus.cookie, {
          ccpId: ccps.CCP1,
          value: 68,
          batchId: soupBatch,
          correctiveAction: { actionTaken: "Returned to the kettle" },
        }),
        201,
      );
      expect(log).toMatchObject({ withinLimits: false, deviationReason: "below_min" });
      expect(log.correctiveActions).toEqual([expect.objectContaining({ status: "open" })]);
      const action = await ok(await as(ada).get(`/haccp/corrective-actions/${log.correctiveActions[0].id}`));
      expect(action).toMatchObject({
        logId: log.id,
        batchId: soupBatch,
        actionTaken: "Returned to the kettle",
        missing: ["rootCause", "preventiveAction"],
      });
      expect(action.title).toContain("CCP1 Cooking: 68 °C");
      const failed = await ok(await record(marcus.cookie, { ccpId: ccps.CCP3, passed: false }), 201);
      expect(failed).toMatchObject({ withinLimits: false, deviationReason: "failed", readingText: "Fail" });
    });

    it("refuses readings of the wrong kind, from the future, or against batches it doesn't cover", async () => {
      expect(await error(await record(ada, { ccpId: ccps.CCP1, passed: true }), 400)).toBe("invalid_input");
      expect(await error(await record(ada, { ccpId: ccps.CCP3, value: 1 }), 400)).toBe("invalid_input");
      const future = new Date(Date.now() + 3_600_000).toISOString();
      expect(await error(await record(ada, { ccpId: ccps.CCP1, value: 80, checkedAt: future }), 400)).toBe(
        "invalid_input",
      );
      expect(
        await error(await record(ada, { ccpId: ccps.CCP1, value: 80, batchId: plannedBatch }), 409),
      ).toBe("batch_not_running");
      expect(await error(await record(ada, { ccpId: ccps.CCP1, value: 80, batchId: breadBatch }), 400)).toBe(
        "invalid_input",
      );
    });

    it("approves a person's reading as they enter it: their entry is the attestation", async () => {
      const log = await ok(await record(marcus.cookie, { ccpId: ccps.CCP2, value: 3 }), 201);
      expect(log).toMatchObject({
        source: "manual",
        reviewStatus: "approved",
        reviewedBy: marcus.userId,
        reviewedByName: expect.any(String),
        reviewNote: null,
      });
      expect(log.reviewedAt).toBeTruthy();
    });

    it("takes readings from any write token, marked as API and pending review", async () => {
      const log = await ok(
        await viaToken(agentToken, "POST", "/haccp/logs", { ccpId: ccps.CCP2, value: 3.5 }),
        201,
      );
      expect(log).toMatchObject({
        source: "api",
        withinLimits: true,
        recordedBy: adaId,
        reviewStatus: "pending",
        reviewedBy: null,
        reviewedAt: null,
      });
    });

    it("has no route that changes or deletes a log", async () => {
      const { logs } = await ok(await as(ada).get("/haccp/logs?limit=1"));
      expect((await as(ada).send("PATCH", `/haccp/logs/${logs[0].id}`, { value: 1 })).status).toBe(404);
      expect((await as(ada).send("DELETE", `/haccp/logs/${logs[0].id}`)).status).toBe(404);
    });

    it("corrects a reading with a new row; out-of-limit readings need manage", async () => {
      const within = await ok(await record(marcus.cookie, { ccpId: ccps.CCP2, value: 4 }), 201);
      const outside = await ok(await record(marcus.cookie, { ccpId: ccps.CCP2, value: 9 }), 201);
      const correct = (cookie: string, id: string, body: object) =>
        as(cookie).send("POST", `/haccp/logs/${id}/correct`, body);
      expect(
        await error(
          await viaToken(agentToken, "POST", `/haccp/logs/${within.id}/correct`, { value: 4.2, reason: "x" }),
          403,
        ),
      ).toBe("token_not_allowed");
      expect(await error(await correct(marcus.cookie, outside.id, { value: 4, reason: "Typo" }), 403)).toBe(
        "module_forbidden",
      );
      const fixed = await ok(await correct(marcus.cookie, within.id, { value: 4.2, reason: "Misread" }), 201);
      expect(fixed).toMatchObject({
        correctsLogId: within.id,
        correctionReason: "Misread",
        checkedAt: within.checkedAt,
      });
      expect(await error(await correct(ada, within.id, { value: 4.3, reason: "Again" }), 409)).toBe(
        "already_corrected",
      );
      // A correction that is still out of limits reuses the deviation's corrective action.
      const stillOut = await ok(await correct(ada, outside.id, { value: 8, reason: "Probe re-read" }), 201);
      expect(stillOut).toMatchObject({ withinLimits: false, correctiveActions: [] });

      const original = await ok(await as(ada).get(`/haccp/logs/${within.id}`));
      expect(original.correctedByLogId).toBe(fixed.id);
      const current = await ok(
        await as(ada).get(`/haccp/logs?planId=${plan}&ccpCode=ccp2&includeCorrected=false`),
      );
      const ids = current.logs.map((l: { id: string }) => l.id);
      expect(ids).toContain(fixed.id);
      expect(ids).not.toContain(within.id);
    });

    it("notifies managers when a correction takes a reading out of limits", async () => {
      const within = await ok(await record(marcus.cookie, { ccpId: ccps.CCP2, value: 4 }), 201);
      const corrected = await ok(
        await as(marcus.cookie).send("POST", `/haccp/logs/${within.id}/correct`, {
          value: 9,
          reason: "Misread",
        }),
        201,
      );
      expect(corrected.withinLimits).toBe(false);
      expect(corrected.correctiveActions).toHaveLength(1);
      const { notifications } = await ok(await ctx.req(`${WS}/notifications?limit=100`, { cookie: ada }));
      expect(
        notifications.find(
          (n: { type: string; data: { subjectId: string } }) =>
            n.type === "reading_out_of_limit" && n.data.subjectId === corrected.id,
        ),
      ).toMatchObject({ module: "haccp", data: { title: corrected.correctiveActions[0].title } });
    });

    it("keeps one corrective action through a chain of corrections that stay out of limits", async () => {
      const correct = (id: string, value: number) =>
        as(ada).send("POST", `/haccp/logs/${id}/correct`, { value, reason: "Re-read the probe" });
      const a = await ok(await record(ada, { ccpId: ccps.CCP2, value: 9 }), 201);
      expect(a.correctiveActions).toHaveLength(1);
      const b = await ok(await correct(a.id, 8), 201);
      const c = await ok(await correct(b.id, 7), 201);
      expect([b.withinLimits, c.withinLimits]).toEqual([false, false]);
      expect(b.correctiveActions).toEqual([]);
      expect(c.correctiveActions).toEqual([]);
      const actions = [];
      for (const log of [a, b, c]) {
        actions.push(
          ...(await ok(await as(ada).get(`/haccp/corrective-actions?logId=${log.id}`))).correctiveActions,
        );
      }
      expect(actions.map((x: { id: string }) => x.id)).toEqual([a.correctiveActions[0].id]);
    });

    it("opens a new corrective action when the earlier one is closed and the reading is still out of limits", async () => {
      const a = await ok(await record(ada, { ccpId: ccps.CCP2, value: 9 }), 201);
      const first = a.correctiveActions[0].id;
      await ok(
        await as(ada).send("PATCH", `/haccp/corrective-actions/${first}`, {
          actionTaken: "Product held and re-cooked",
          rootCause: "Probe out of calibration",
          preventiveAction: "Weekly thermostat check added to PPM",
        }),
      );
      await ok(
        await as(ada).send("POST", `/haccp/corrective-actions/${first}/close`, { note: "Dealt with" }),
      );
      const b = await ok(
        await as(ada).send("POST", `/haccp/logs/${a.id}/correct`, { value: 8, reason: "Re-read the probe" }),
        201,
      );
      expect(b.withinLimits).toBe(false);
      expect(b.correctiveActions).toHaveLength(1);
      expect(b.correctiveActions[0]).toMatchObject({ status: "open" });
      expect(b.correctiveActions[0].id).not.toBe(first);
      // The new open action is reused by a further correction.
      const c = await ok(
        await as(ada).send("POST", `/haccp/logs/${b.id}/correct`, { value: 7, reason: "Again" }),
        201,
      );
      expect(c.correctiveActions).toEqual([]);
    });

    it("pins checks to the current version: CCPs of a superseded version are refused", async () => {
      await ok(
        await as(ada).send("PUT", `/haccp/plans/${plan}/draft`, {
          scope: { itemIds: [soup] },
          ccps: [
            { ...cooking, limitMin: 72, limitUnit: "°C", processStep: "Cooking (2 min hold)" },
            chilling,
            metal,
          ],
          changeNote: "72 °C for 2 minutes",
        }),
      );
      const v2 = await ok(
        await as(ada).send("POST", `/haccp/plans/${plan}/draft/approve`, {
          effectiveOn: today,
          note: "Validated",
        }),
      );
      expect(v2).toMatchObject({ versionNumber: 2, approvalNote: "Validated" });
      const got = await ok(await as(ada).get(`/haccp/plans/${plan}`));
      expect(got.versions.map((v: { status: string }) => v.status)).toEqual(["approved", "superseded"]);
      expect(await error(await record(ada, { ccpId: ccps.CCP1, value: 80 }), 409)).toBe("ccp_not_current");
      ccps = Object.fromEntries(v2.ccps.map((c: { code: string; id: string }) => [c.code, c.id]));
      const log = await ok(await record(ada, { ccpId: ccps.CCP1, value: 73, batchId: soupBatch }), 201);
      expect(log.withinLimits).toBe(true);
    });
  });

  describe("deviations and corrective actions", () => {
    let actionId: string;

    it("lists open deviations with their corrective actions", async () => {
      const { deviations } = await ok(await as(ada).get(`/haccp/deviations?batchId=${soupBatch}`));
      expect(deviations).toHaveLength(1);
      expect(deviations[0]).toMatchObject({ open: true, readingText: "68 °C", batch: { id: soupBatch } });
      actionId = deviations[0].correctiveActions[0].id;
    });

    it("lets an agent propose and fill in corrective actions, marked as API", async () => {
      const proposed = await ok(
        await viaToken(agentToken, "POST", "/haccp/corrective-actions", {
          title: "Recheck chiller door seals",
          lotId: soupLot,
        }),
        201,
      );
      expect(proposed).toMatchObject({ source: "api", status: "open", lot: { id: soupLot } });
      const filled = await ok(
        await viaToken(agentToken, "PATCH", `/haccp/corrective-actions/${actionId}`, {
          rootCause: "Kettle thermostat drifted",
        }),
      );
      expect(filled).toMatchObject({
        rootCause: "Kettle thermostat drifted",
        updatedBy: adaId,
        missing: ["preventiveAction"],
      });
      const withinLog = (await ok(await as(ada).get("/haccp/logs?outOfLimits=false&limit=1"))).logs[0];
      expect(
        await error(
          await as(ada).send("POST", "/haccp/corrective-actions", {
            title: "Nothing wrong",
            logId: withinLog.id,
          }),
          400,
        ),
      ).toBe("invalid_input");
    });

    it("is closed by a person with manage once complete, and then never changes", async () => {
      const close = (cookie: string) =>
        as(cookie).send("POST", `/haccp/corrective-actions/${actionId}/close`, {});
      expect(
        await error(
          await viaToken(agentToken, "POST", `/haccp/corrective-actions/${actionId}/close`, {}),
          403,
        ),
      ).toBe("token_not_allowed");
      expect(await error(await close(marcus.cookie), 403)).toBe("module_forbidden");
      const incomplete = await close(ada);
      expect(incomplete.status).toBe(409);
      expect((await incomplete.json()).error).toMatchObject({
        code: "corrective_action_incomplete",
        details: { missing: ["preventiveAction"] },
      });
      await ok(
        await as(marcus.cookie).send("PATCH", `/haccp/corrective-actions/${actionId}`, {
          preventiveAction: "Weekly thermostat check added to PPM",
        }),
      );
      const closed = await ok(
        await as(ada).send("POST", `/haccp/corrective-actions/${actionId}/close`, {
          note: "Product re-cooked",
        }),
      );
      expect(closed).toMatchObject({ status: "closed", closedBy: adaId, closureNote: "Product re-cooked" });
      expect(
        await error(
          await as(ada).send("PATCH", `/haccp/corrective-actions/${actionId}`, { title: "x" }),
          409,
        ),
      ).toBe("corrective_action_closed");
      const open = await ok(await as(ada).get(`/haccp/deviations?batchId=${soupBatch}`));
      expect(open.deviations).toHaveLength(0);
      const closedList = await ok(await as(ada).get(`/haccp/deviations?batchId=${soupBatch}&status=closed`));
      expect(closedList.deviations).toHaveLength(1);
    });
  });

  describe("cleaning and calibration", () => {
    let line: string;
    let probe: string;

    it("keeps a minimal register of areas and equipment", async () => {
      line = (
        await ok(
          await as(marcus.cookie).send("POST", "/haccp/assets", {
            kind: "area",
            code: "L1",
            name: "Line 1",
            cleaningFrequency: { every: 1, unit: "day" },
          }),
          201,
        )
      ).id;
      const created = await ok(
        await as(marcus.cookie).send("POST", "/haccp/assets", {
          kind: "equipment",
          code: "PRB-01",
          name: "Probe thermometer 1",
          calibrationFrequency: { every: 1, unit: "month" },
          calibrationTolerance: 0.5,
          measurementUnit: "°C",
        }),
        201,
      );
      probe = created.id;
      expect(created).toMatchObject({ calibrationFrequencyText: "Monthly", cleaningFrequency: null });
      expect(
        await error(
          await as(ada).send("POST", "/haccp/assets", { kind: "area", name: "x", code: "l1" }),
          409,
        ),
      ).toBe("code_taken");
      expect(
        await error(
          await as(ada).send("PATCH", `/haccp/assets/${line}`, {
            calibrationFrequency: { every: 1, unit: "month" },
          }),
          400,
        ),
      ).toBe("invalid_input");
    });

    it("shows what's due, and clears it when done", async () => {
      const due = await ok(await as(marcus.cookie).get("/haccp/due"));
      const keys = due.checks.map((c: { key: string }) => c.key);
      expect(keys).toContain(`cleaning:${line}`);
      expect(keys).toContain(`calibration:${probe}`);
      // CCP1 has been checked on the soup batch; CCP3 (daily) was checked today; CCP2 every 2 hours too.
      expect(keys).not.toContain(`ccp:${ccps.CCP1}:${soupBatch}`);
      expect(keys.some((k: string) => k.includes(breadBatch))).toBe(false);
      const all = await ok(await as(marcus.cookie).get("/haccp/due?include=all&kind=ccp"));
      const perBatch = all.checks.find((c: { key: string }) => c.key === `ccp:${ccps.CCP1}:${soupBatch}`);
      expect(perBatch).toMatchObject({ state: "ok", batch: { id: soupBatch } });
      expect(all.checks.find((c: { key: string }) => c.key === `ccp:${ccps.CCP2}`).state).not.toBe("idle");
      expect(all.batchesInProgress.find((b: { id: string }) => b.id === soupBatch).planIds).toEqual([plan]);
      expect(all.batchesInProgress.find((b: { id: string }) => b.id === breadBatch).planIds).toEqual([]);
    });

    it("records cleaning as a person, verified by someone else", async () => {
      expect(await error(await viaToken(agentToken, "POST", "/haccp/cleaning", { assetId: line }), 403)).toBe(
        "token_not_allowed",
      );
      const cleaned = await ok(
        await as(marcus.cookie).send("POST", "/haccp/cleaning", { assetId: line }),
        201,
      );
      expect(cleaned).toMatchObject({ doneBy: marcus.userId, verifiedAt: null, asset: { id: line } });
      const verify = (cookie: string) => as(cookie).send("POST", `/haccp/cleaning/${cleaned.id}/verify`, {});
      expect(await error(await verify(marcus.cookie), 403)).toBe("four_eyes");
      expect(await ok(await verify(ada))).toMatchObject({ verifiedBy: adaId });
      expect(await error(await verify(ada), 409)).toBe("already_verified");
      const keys = (await ok(await as(ada).get("/haccp/due"))).checks.map((c: { key: string }) => c.key);
      expect(keys).not.toContain(`cleaning:${line}`);
    });

    it("passes a calibration within tolerance and sets the next due date", async () => {
      const passed = await ok(
        await as(marcus.cookie).send("POST", "/haccp/calibration", {
          assetId: probe,
          referenceReading: 100,
          actualReading: 100.4,
          method: "Boiling water",
        }),
        201,
      );
      expect(passed).toMatchObject({ passed: true, tolerance: 0.5, unit: "°C", correctiveActions: [] });
      expect(passed.nextDueOn > today).toBe(true);
      expect(
        await error(
          await as(ada).send("POST", "/haccp/calibration", {
            assetId: probe,
            referenceReading: 0,
            actualReading: 0,
            passed: true,
          }),
          400,
        ),
      ).toBe("invalid_input");
      expect(
        await error(
          await as(ada).send("POST", "/haccp/calibration", {
            assetId: line,
            referenceReading: 0,
            actualReading: 0,
          }),
          400,
        ),
      ).toBe("invalid_input");
    });

    it("opens a corrective action when a calibration fails, and keeps the equipment due", async () => {
      const failed = await ok(
        await as(marcus.cookie).send("POST", "/haccp/calibration", {
          assetId: probe,
          referenceReading: 0,
          actualReading: 0.8,
        }),
        201,
      );
      expect(failed.passed).toBe(false);
      expect(failed.correctiveActions).toEqual([expect.objectContaining({ status: "open" })]);
      const action = await ok(
        await as(ada).get(`/haccp/corrective-actions/${failed.correctiveActions[0].id}`),
      );
      expect(action.calibration).toMatchObject({ asset: { code: "PRB-01" }, actualReading: 0.8 });
      const due = await ok(await as(ada).get("/haccp/due?kind=calibration"));
      expect(due.checks.find((c: { key: string }) => c.key === `calibration:${probe}`)).toMatchObject({
        state: "overdue",
        lastPassed: false,
      });
      const { records } = await ok(await as(ada).get(`/haccp/calibration?assetId=${probe}`));
      expect(records).toHaveLength(2);
    });
  });

  describe("on the production batch", () => {
    it("summarises the checks recorded against a batch and what is missing", async () => {
      const record = await ok(await as(marcus.cookie).get(`/haccp/batches/${soupBatch}`));
      expect(record.batch).toMatchObject({ id: soupBatch });
      expect(record.logs.length).toBeGreaterThanOrEqual(3);
      expect(record.ccps.map((c: { ccp: { code: string } }) => c.ccp.code)).toEqual(["CCP1", "CCP2", "CCP3"]);
      // Followed by code across versions: 82.5 and 68 °C under version 1, 73 °C under version 2.
      expect(record.ccps[0]).toMatchObject({ checks: 3, deviations: 1 });
      expect(record.missingChecks).toBe(0);
      expect(record.openDeviations).toBe(0);
      const other = await ok(await as(marcus.cookie).get(`/haccp/batches/${breadBatch}`));
      expect(other).toMatchObject({ logs: [], ccps: [], missingChecks: 0 });
    });

    it("keeps haccp entities out of the sync log for members without access", async () => {
      const changes = async (cookie: string) =>
        (await ok(await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie }))).changes.map(
          (c: { entity: string }) => c.entity,
        );
      expect(await changes(ada)).toContain("haccp_ccp_log");
      await grant("haccp", null);
      expect((await changes(marcus.cookie)).some((e: string) => e.startsWith("haccp_"))).toBe(false);
      await grant("haccp", "write");
    });
  });

  describe("review of readings recorded through the API", () => {
    const fromToken = (body: object) => viaToken(agentToken, "POST", "/haccp/logs", body);
    const record = (cookie: string, body: object) => as(cookie).send("POST", "/haccp/logs", body);
    const review = (cookie: string, id: string, body: object) =>
      as(cookie).send("POST", `/haccp/logs/${id}/review`, body);
    const reviewMany = (cookie: string, body: object) => as(cookie).send("POST", "/haccp/logs/review", body);
    const dueKeys = async () =>
      (await ok(await as(ada).get("/haccp/due?kind=ccp"))).checks.map((c: { key: string }) => c.key);
    let pending: string;

    it("opens the corrective action of an out-of-limit token reading at once, without waiting for review", async () => {
      const log = await ok(await fromToken({ ccpId: ccps.CCP2, value: 9.5 }), 201);
      expect(log).toMatchObject({ source: "api", reviewStatus: "pending", withinLimits: false });
      expect(log.correctiveActions).toEqual([expect.objectContaining({ status: "open" })]);
      const action = await ok(await as(ada).get(`/haccp/corrective-actions/${log.correctiveActions[0].id}`));
      expect(action).toMatchObject({ logId: log.id, source: "api", status: "open" });
      const { deviations } = await ok(await as(ada).get("/haccp/deviations"));
      expect(deviations.map((d: { id: string }) => d.id)).toContain(log.id);
      pending = log.id;
    });

    it("lets only a signed-in person with manage review", async () => {
      expect(
        await error(
          await viaToken(agentToken, "POST", `/haccp/logs/${pending}/review`, { decision: "approve" }),
          403,
        ),
      ).toBe("token_not_allowed");
      expect(
        await error(
          await viaToken(agentToken, "POST", "/haccp/logs/review", { ids: [pending], decision: "approve" }),
          403,
        ),
      ).toBe("token_not_allowed");
      // Write access records readings; it doesn't review them.
      expect(await error(await review(marcus.cookie, pending, { decision: "approve" }), 403)).toBe(
        "module_forbidden",
      );
      expect(await error(await reviewMany(marcus.cookie, { ids: [pending], decision: "approve" }), 403)).toBe(
        "module_forbidden",
      );
      expect((await ok(await as(ada).get(`/haccp/logs/${pending}`))).reviewStatus).toBe("pending");
    });

    it("needs a note to reject", async () => {
      expect(await error(await review(ada, pending, { decision: "reject" }), 400)).toBe("invalid_input");
      expect(await error(await reviewMany(ada, { ids: [pending], decision: "reject", note: " " }), 400)).toBe(
        "invalid_input",
      );
    });

    it("approves a pending reading once, recording who and when, and writes the sync log", async () => {
      const latest = async () => {
        let cursor = "0";
        for (;;) {
          const page = await ok(await ctx.req(`${WS}/sync?after=${cursor}&limit=1000`, { cookie: ada }));
          cursor = page.cursor;
          if (!page.hasMore) return cursor;
        }
      };
      const cursor = await latest();
      const approved = await ok(
        await review(ada, pending, { decision: "approve", note: "Probe re-checked" }),
      );
      expect(approved).toMatchObject({
        reviewStatus: "approved",
        reviewedBy: adaId,
        reviewNote: "Probe re-checked",
        // The deviation is still real: its corrective action stays open until a manager closes it.
        correctiveActions: [expect.objectContaining({ status: "open" })],
      });
      expect(approved.reviewedAt).toBeTruthy();
      const { changes } = await ok(await ctx.req(`${WS}/sync?after=${cursor}`, { cookie: ada }));
      expect(changes).toEqual([
        expect.objectContaining({
          entity: "haccp_ccp_log",
          entityId: pending,
          action: "upsert",
          data: expect.objectContaining({ reviewStatus: "approved", reviewedBy: adaId }),
        }),
      ]);
      expect(
        await error(await review(ada, pending, { decision: "reject", note: "Changed my mind" }), 409),
      ).toBe("already_reviewed");
      // A person's own reading was approved as it was entered: there is nothing to review.
      const own = await ok(await record(ada, { ccpId: ccps.CCP2, value: 2 }), 201);
      expect(await error(await review(ada, own.id, { decision: "approve" }), 409)).toBe("already_reviewed");
    });

    it("counts a pending reading as done, and makes the check due again when it is rejected", async () => {
      const key = `ccp:${ccps.CCP1}:${reviewBatch}`;
      expect(await dueKeys()).toContain(key);
      const log = await ok(await fromToken({ ccpId: ccps.CCP1, value: 70, batchId: reviewBatch }), 201);
      expect(log).toMatchObject({ reviewStatus: "pending", withinLimits: false });
      expect(await dueKeys()).not.toContain(key);
      const due = await ok(await as(ada).get("/haccp/due"));
      expect(due.counts.awaitingReview).toBeGreaterThanOrEqual(1);
      let batchRecord = await ok(await as(ada).get(`/haccp/batches/${reviewBatch}`));
      expect(batchRecord).toMatchObject({ awaitingReview: 1, missingChecks: 0 });
      expect(batchRecord.ccps[0]).toMatchObject({ checks: 1, awaitingReview: 1 });

      const rejected = await ok(
        await review(ada, log.id, { decision: "reject", note: "Probe was not in the core" }),
      );
      expect(rejected).toMatchObject({
        reviewStatus: "rejected",
        reviewedBy: adaId,
        reviewNote: "Probe was not in the core",
        // Rejecting the reading doesn't close its corrective action: a person deals with it.
        correctiveActions: [expect.objectContaining({ status: "open" })],
      });
      expect(await dueKeys()).toContain(key);
      batchRecord = await ok(await as(ada).get(`/haccp/batches/${reviewBatch}`));
      expect(batchRecord).toMatchObject({ awaitingReview: 0, missingChecks: 1, openDeviations: 1 });
      expect(batchRecord.ccps[0]).toMatchObject({ checks: 0, deviations: 1 });
      const { logs } = await ok(await as(ada).get("/haccp/logs?review=rejected"));
      expect(logs.map((l: { id: string }) => l.id)).toEqual([log.id]);
    });

    it("reviews in bulk, all or nothing", async () => {
      const a = (await ok(await fromToken({ ccpId: ccps.CCP2, value: 1 }), 201)).id;
      const b = (await ok(await fromToken({ ccpId: ccps.CCP3, passed: true }), 201)).id;
      const listed = await ok(await as(ada).get("/haccp/logs?review=pending"));
      const ids: string[] = listed.logs.map((l: { id: string }) => l.id);
      expect(ids).toEqual(expect.arrayContaining([a, b]));
      expect(listed.logs.every((l: { reviewStatus: string }) => l.reviewStatus === "pending")).toBe(true);

      // One of them was already reviewed: nothing changes.
      const refused = await reviewMany(ada, { ids: [a, b, pending], decision: "approve" });
      expect(refused.status).toBe(409);
      expect((await refused.json()).error).toMatchObject({
        code: "already_reviewed",
        details: { ids: [pending] },
      });
      expect(
        await error(
          await reviewMany(ada, { ids: [a, "00000000-0000-7000-8000-000000000000"], decision: "approve" }),
          404,
        ),
      ).toBe("not_found");
      for (const id of [a, b]) {
        expect((await ok(await as(ada).get(`/haccp/logs/${id}`))).reviewStatus).toBe("pending");
      }

      const done = await ok(await reviewMany(ada, { ids, decision: "approve" }));
      expect(done.reviewed).toBe(ids.length);
      expect(done.logs.every((l: { reviewStatus: string }) => l.reviewStatus === "approved")).toBe(true);
      expect((await ok(await as(ada).get("/haccp/logs?review=pending"))).total).toBe(0);
      expect((await ok(await as(ada).get("/haccp/due"))).counts.awaitingReview).toBe(0);
    });

    it("lets a person correct a pending reading; the correction is approved and replaces it in the queue", async () => {
      const log = await ok(await fromToken({ ccpId: ccps.CCP2, value: 4.5 }), 201);
      expect((await ok(await as(ada).get("/haccp/due"))).counts.awaitingReview).toBe(1);
      const fixed = await ok(
        await as(marcus.cookie).send("POST", `/haccp/logs/${log.id}/correct`, {
          value: 4.1,
          reason: "Sensor offset",
        }),
        201,
      );
      expect(fixed).toMatchObject({
        source: "manual",
        reviewStatus: "approved",
        reviewedBy: marcus.userId,
        correctsLogId: log.id,
      });
      expect((await ok(await as(ada).get("/haccp/due"))).counts.awaitingReview).toBe(0);
      expect(await error(await review(ada, log.id, { decision: "approve" }), 409)).toBe("already_corrected");
      const queue = await ok(await as(ada).get("/haccp/logs?review=pending&includeCorrected=false"));
      expect(queue.total).toBe(0);
    });
  });

  describe("a version approved for a later date", () => {
    const later = addDays(todayInZone(DEFAULT_TIME_ZONE), 10);
    let breadPlan: string;
    let v1: { id: string; ccps: { id: string; code: string }[] };
    let v2: { id: string; ccps: { id: string; code: string }[] };

    it("keeps the previous version in force, and monitored against, until its effective date", async () => {
      breadPlan = (
        await ok(
          await as(ada).send("POST", "/haccp/plans", {
            code: "HACCP-BRD",
            name: "Bread",
            draft: { scope: { itemIds: [bread] }, ccps: [cooking] },
          }),
          201,
        )
      ).id;
      v1 = await ok(await as(ada).send("POST", `/haccp/plans/${breadPlan}/draft/approve`, {}));
      await ok(
        await as(ada).send("PUT", `/haccp/plans/${breadPlan}/draft`, {
          scope: { itemIds: [bread] },
          ccps: [{ ...cooking, limitMin: 72 }, metal],
        }),
      );
      v2 = await ok(
        await as(ada).send("POST", `/haccp/plans/${breadPlan}/draft/approve`, { effectiveOn: later }),
      );
      expect(v2).toMatchObject({
        status: "approved",
        state: "scheduled",
        effectiveOn: later,
        inForceUntil: null,
      });

      // Readings go against version 1 until the new version takes effect.
      const reading = await ok(
        await as(ada).send("POST", "/haccp/logs", { ccpId: v1.ccps[0]!.id, value: 80, batchId: breadBatch }),
        201,
      );
      expect(reading.planVersionId).toBe(v1.id);
      expect(
        await error(
          await as(ada).send("POST", "/haccp/logs", {
            ccpId: v2.ccps[0]!.id,
            value: 80,
            batchId: breadBatch,
          }),
          409,
        ),
      ).toBe("ccp_not_current");
    });

    it("shows the version in force until the date, and the scheduled one from it", async () => {
      const got = await ok(await as(ada).get(`/haccp/plans/${breadPlan}`));
      expect(got.currentVersion).toMatchObject({ id: v1.id, state: "in_force", inForceUntil: later });
      expect(got.upcomingVersion).toMatchObject({ id: v2.id, state: "scheduled", effectiveOn: later });
      expect(got.versions.map((v: { status: string; state: string }) => [v.status, v.state])).toEqual([
        ["approved", "scheduled"],
        ["superseded", "in_force"],
      ]);
      const listed = (await ok(await as(ada).get("/haccp/plans?q=HACCP-BRD"))).plans[0];
      expect(listed.currentVersion).toMatchObject({ versionNumber: 1, inForceUntil: later, ccpCount: 1 });
      expect(listed.upcomingVersion).toMatchObject({ versionNumber: 2, effectiveOn: later, ccpCount: 2 });
    });

    it("schedules and shows the CCPs of the version in force on the batch", async () => {
      const all = await ok(await as(ada).get("/haccp/due?include=all&kind=ccp"));
      const keys = all.checks.map((c: { key: string }) => c.key);
      expect(keys).toContain(`ccp:${v1.ccps[0]!.id}:${breadBatch}`);
      expect(keys.some((k: string) => v2.ccps.some((c) => k.startsWith(`ccp:${c.id}`)))).toBe(false);
      const record = await ok(await as(ada).get(`/haccp/batches/${breadBatch}`));
      expect(record.ccps.map((c: { ccp: { id: string } }) => c.ccp.id)).toEqual([v1.ccps[0]!.id]);
      expect(record.ccps[0]).toMatchObject({ checks: 1, plan: { id: breadPlan } });
    });
  });
});
