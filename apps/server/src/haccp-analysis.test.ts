import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sweepDueNotifications } from "./services/notification-sweep";
import { addHaccpAsset, makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
const DEPENDENCIES = ["assets", "items", "recipes", "stock", "demand", "production"] as const;

const step = (
  ref: string,
  name: string,
  q: [boolean | null, boolean | null, boolean | null, boolean | null],
) => ({
  ref,
  name,
  hazards: [
    {
      hazardType: "biological",
      description: `Pathogens at ${name}`,
      likelihood: 4,
      severity: 4,
      controlMeasure: q[0] ? "Heat" : null,
      q1: q[0],
      q2: q[1],
      q3: q[2],
      q4: q[3],
    },
  ],
});
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

describe("HACCP hazard analysis, four-eyes, corrections and sign-off", () => {
  let ctx: TestCtx;
  let ada: { cookie: string; userId: string };
  let marcus: { cookie: string; userId: string };
  let agentToken: string;
  let plan: string;
  const send = (cookie: string, method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
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

  describe("hazard analysis", () => {
    it("saves ordered steps with hazards and links a CCP to its step", async () => {
      const created = await ok(
        await send(ada.cookie, "POST", "/haccp/plans", {
          code: "HACCP-A",
          name: "Soups",
          draft: {
            steps: [
              step("receive", "Receiving", [true, false, true, false]),
              step("cook", "Cooking", [true, true, null, null]),
              step("pack", "Packing", [false, null, null, null]),
            ],
            ccps: [ccp("CCP1", { stepRef: "cook" })],
          },
        }),
        201,
      );
      plan = created.id;
      const draft = created.draftVersion;
      expect(draft.steps.map((s: { name: string }) => s.name)).toEqual(["Receiving", "Cooking", "Packing"]);
      expect(draft.steps.map((s: { hazards: { outcome: string }[] }) => s.hazards[0]!.outcome)).toEqual([
        "ccp",
        "ccp",
        "no_control",
      ]);
      expect(draft.steps[1].hazards[0].risk).toEqual({ score: 16, level: "high" });
      expect(draft.ccps[0].stepId).toBe(draft.steps[1].id);
      expect(draft.flow.map((n: { ccpCodes: string[] }) => n.ccpCodes)).toEqual([[], ["CCP1"], []]);
      // Receiving is a CCP by the tree but has none; Packing has no control measure at high risk.
      const notes = draft.analysisNotes.map((n: { text: string }) => n.text).join("\n");
      expect(notes).toContain("Receiving");
      expect(notes).toContain("Packing");
    });

    it("refuses a decision tree answer the path doesn't reach and a dangling step ref", async () => {
      const bad = step("a", "A", [true, true, true, null]);
      expect(
        await code(
          await send(ada.cookie, "PUT", `/haccp/plans/${plan}/draft`, { steps: [bad], ccps: [ccp("CCP1")] }),
          400,
        ),
      ).toBeTruthy();
      expect(
        await code(
          await send(ada.cookie, "PUT", `/haccp/plans/${plan}/draft`, {
            steps: [],
            ccps: [ccp("CCP1", { stepRef: "nope" })],
          }),
          400,
        ),
      ).toBeTruthy();
    });

    it("replaces the steps when the draft is saved again, and keeps them with the version", async () => {
      const saved = await ok(
        await send(ada.cookie, "PUT", `/haccp/plans/${plan}/draft`, {
          steps: [step("cook", "Cooking", [true, true, null, null])],
          ccps: [ccp("CCP1", { stepRef: "cook" })],
        }),
      );
      expect(saved.steps).toHaveLength(1);
      expect(saved.analysisNotes).toEqual([]);
    });
  });

  describe("four-eyes on approval", () => {
    it("refuses the last editor when another manager exists, and lets the other approve", async () => {
      expect(await code(await send(ada.cookie, "POST", `/haccp/plans/${plan}/draft/approve`, {}), 403)).toBe(
        "four_eyes",
      );
      const v1 = await ok(await send(marcus.cookie, "POST", `/haccp/plans/${plan}/draft/approve`, {}));
      expect(v1.status).toBe("approved");
      expect(v1.steps).toHaveLength(1);
      // The approved version keeps its steps when the next draft starts from it.
    });

    it("lets the only manager approve their own draft", async () => {
      await ok(
        await send(ada.cookie, "PUT", "/members/" + marcus.userId + "/module-access/haccp", {
          level: "write",
        }),
      );
      await ok(
        await send(ada.cookie, "PUT", `/haccp/plans/${plan}/draft`, {
          steps: [step("cook", "Cooking", [true, true, null, null])],
          ccps: [ccp("CCP1", { stepRef: "cook" })],
        }),
      );
      await ok(await send(ada.cookie, "POST", `/haccp/plans/${plan}/draft/approve`, {}));
      await ok(
        await send(ada.cookie, "PUT", `/members/${marcus.userId}/module-access/haccp`, { level: "manage" }),
      );
    });
  });

  describe("corrections of cleaning and calibration", () => {
    let area: string;
    let probe: string;
    it("corrects a cleaning record once, keeping the original and starting unverified", async () => {
      area = (
        await addHaccpAsset((m, p, j) => send(ada.cookie, m, p, j), {
          kind: "area",
          name: "Line 1",
          cleaningFrequency: { every: 1, unit: "day" },
        })
      ).id;
      const first = await ok(
        await send(ada.cookie, "POST", "/haccp/cleaning", { assetId: area, note: "wrong" }),
        201,
      );
      await ok(await send(marcus.cookie, "POST", `/haccp/cleaning/${first.id}/verify`, {}));
      const fixed = await ok(
        await send(marcus.cookie, "POST", `/haccp/cleaning/${first.id}/correct`, {
          reason: "Wrong note",
          note: "Deep clean",
        }),
        201,
      );
      expect(fixed).toMatchObject({
        correctsRecordId: first.id,
        correctionReason: "Wrong note",
        note: "Deep clean",
      });
      expect(fixed.verifiedAt).toBeNull();
      expect(
        await code(
          await send(ada.cookie, "POST", `/haccp/cleaning/${first.id}/correct`, { reason: "again" }),
          409,
        ),
      ).toBe("already_corrected");
      const list = await ok(await send(ada.cookie, "GET", `/haccp/cleaning?assetId=${area}`));
      expect(list.records.find((r: { id: string }) => r.id === first.id).correctedByRecordId).toBe(fixed.id);
      expect(
        await code(await viaToken("POST", `/haccp/cleaning/${fixed.id}/correct`, { reason: "x" }), 403),
      ).toBeTruthy();
    });

    const viaToken = (method: string, path: string, json?: unknown) =>
      ctx.req(`${WS}${path}`, {
        method,
        headers: { authorization: `Bearer ${agentToken}`, origin: "" },
        json,
      });

    it("corrects a calibration against the original tolerance; failed ones need manage", async () => {
      probe = (
        await addHaccpAsset((m, p, j) => send(ada.cookie, m, p, j), {
          kind: "equipment",
          name: "Probe",
          calibrationFrequency: { every: 1, unit: "month" },
          calibrationTolerance: 0.5,
          measurementUnit: "°C",
        })
      ).id;
      const failed = await ok(
        await send(ada.cookie, "POST", "/haccp/calibration", {
          assetId: probe,
          referenceReading: 0,
          actualReading: 2,
        }),
        201,
      );
      expect(failed.passed).toBe(false);
      // Marcus drops to write: can't write off a failure.
      await ok(
        await send(ada.cookie, "PUT", `/members/${marcus.userId}/module-access/haccp`, { level: "write" }),
      );
      expect(
        await code(
          await send(marcus.cookie, "POST", `/haccp/calibration/${failed.id}/correct`, {
            reason: "Misread",
            actualReading: 0.2,
          }),
          403,
        ),
      ).toBe("module_forbidden");
      await ok(
        await send(ada.cookie, "PUT", `/members/${marcus.userId}/module-access/haccp`, { level: "manage" }),
      );
      const fixed = await ok(
        await send(marcus.cookie, "POST", `/haccp/calibration/${failed.id}/correct`, {
          reason: "Misread",
          actualReading: 0.2,
        }),
        201,
      );
      expect(fixed).toMatchObject({ passed: true, correctsRecordId: failed.id, tolerance: 0.5 });
      expect(
        await code(
          await send(ada.cookie, "POST", `/haccp/calibration/${fixed.id}/correct`, {
            reason: "r",
            passed: true,
          }),
          400,
        ),
      ).toBeTruthy();
      // The failure's corrective action stays open for a manager.
      const actions = await ok(await send(ada.cookie, "GET", "/haccp/corrective-actions?status=open"));
      expect(
        actions.correctiveActions.some(
          (a: { calibration: { id: string } | null }) => a.calibration?.id === failed.id,
        ),
      ).toBe(true);
      // The corrected failure no longer makes the probe overdue.
      const due = await ok(await send(ada.cookie, "GET", "/haccp/due?include=all&kind=calibration"));
      expect(due.checks.find((c: { key: string }) => c.key === `calibration:${probe}`).state).toBe("ok");
    });
  });

  describe("sign-off of a day", () => {
    it("signs a day off once, refuses pending readings and tokens, and counts later additions", async () => {
      const current = await ok(await send(ada.cookie, "GET", `/haccp/plans/${plan}`));
      const ccpId = current.currentVersion.ccps[0].id;
      await ok(await send(ada.cookie, "POST", "/haccp/logs", { ccpId, value: 80 }), 201);
      const pending = await ok(
        await ctx.req(`${WS}/haccp/logs`, {
          method: "POST",
          headers: { authorization: `Bearer ${agentToken}`, origin: "" },
          json: { ccpId, value: 81 },
        }),
        201,
      );
      expect(
        await code(await send(marcus.cookie, "POST", "/haccp/signoffs", { planId: plan, day: today }), 409),
      ).toBe("readings_pending");
      await ok(
        await send(marcus.cookie, "POST", `/haccp/logs/${pending.id}/review`, { decision: "approve" }),
      );
      expect(
        await code(
          await ctx.req(`${WS}/haccp/signoffs`, {
            method: "POST",
            headers: { authorization: `Bearer ${agentToken}`, origin: "" },
            json: { planId: plan, day: today },
          }),
          403,
        ),
      ).toBeTruthy();
      const signed = await ok(
        await send(marcus.cookie, "POST", "/haccp/signoffs", { planId: plan, day: today, note: "Reviewed" }),
        201,
      );
      expect(signed).toMatchObject({
        checkCount: 2,
        deviationCount: 0,
        addedAfter: 0,
        signedByName: expect.any(String),
      });
      expect(
        await code(await send(marcus.cookie, "POST", "/haccp/signoffs", { planId: plan, day: today }), 409),
      ).toBe("already_signed_off");
      expect(
        await code(
          await send(marcus.cookie, "POST", "/haccp/signoffs", { planId: plan, day: "2999-01-01" }),
          400,
        ),
      ).toBeTruthy();
      await ok(await send(ada.cookie, "POST", "/haccp/logs", { ccpId, value: 82 }), 201);
      const list = await ok(await send(ada.cookie, "GET", `/haccp/signoffs?planId=${plan}`));
      expect(list.signoffs[0]).toMatchObject({ day: today, addedAfter: 1 });
    });
  });

  describe("CCP overdue digest", () => {
    it("makes one digest per manager per day for checks overdue by more than an interval", async () => {
      // Midday today, so "5 hours ago" is still today: before 05:00 it would fall on the previous
      // day, before the plan approved below took effect (a past effective date isn't allowed).
      vi.useFakeTimers({ now: new Date(`${todayInZone(DEFAULT_TIME_ZONE)}T12:00:00Z`), toFake: ["Date"] });
      try {
        // An hourly CCP checked 5 hours ago (it is overdue by 4 intervals).
        const hourly = await ok(
          await send(ada.cookie, "POST", "/haccp/plans", {
            code: "HACCP-H",
            name: "Hourly",
            draft: { ccps: [ccp("H1", { frequency: { every: 1, unit: "hour" } })] },
          }),
          201,
        );
        await ok(await send(marcus.cookie, "POST", `/haccp/plans/${hourly.id}/draft/approve`, {}));
        const id = (await ok(await send(ada.cookie, "GET", `/haccp/plans/${hourly.id}`))).currentVersion
          .ccps[0].id;
        await ok(
          await send(ada.cookie, "POST", "/haccp/logs", {
            ccpId: id,
            value: 80,
            checkedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
          }),
          201,
        );
        const run = () =>
          sweepDueNotifications(ctx.handle.db, {
            activeModules: ["assets", "items", "recipes", "stock", "demand", "production", "haccp"],
          });
        const first = await run();
        const digests = first.created.filter((n) => n.type === "ccp_checks_overdue");
        expect(digests.length).toBeGreaterThan(0);
        expect(digests.every((n) => n.userId !== undefined)).toBe(true);
        expect(digests.some((n) => n.userId === marcus.userId)).toBe(true);
        expect((await run()).created.filter((n) => n.type === "ccp_checks_overdue")).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
