import { addDays } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = new Date().toISOString().slice(0, 10);
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

describe("food defence module", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  const ok = async (res: Response, status = 200): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  /** The approval stamp of the draft as a reviewer currently sees it. */
  const stamp = async (id: string) => {
    const { draft } = (await (await as(ada).get(`/defence/assessments/${id}`)).json()) as any;
    return { draftId: draft.id, revision: draft.revision };
  };
  const fails = async (res: Response, status: number, code?: string): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    if (code) expect(body.error?.code).toBe(code);
    return body;
  };

  let gate: string;
  let seals: string;
  let assessment: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "t", scope: "write" },
        })
      ).json()
    ).token;
  });

  afterAll(() => ctx.handle.close());

  it("is opt-in", async () => {
    expect((await as(marcus.cookie).get("/defence/overview")).status).toBe(403);
    await ctx.req(`${WS}/members/${marcus.userId}/module-access/defence`, {
      method: "PUT",
      cookie: ada,
      json: { level: "write" },
    });
    await ok(await as(marcus.cookie).get("/defence/overview"));
  });

  it("sets up controls; a control never checked is due now", async () => {
    gate = (
      await ok(
        await viaToken("POST", "/defence/controls", {
          name: "Goods-in gate locked out of hours",
          kind: "perimeter",
          area: "Yard",
          frequencyDays: 1,
        }),
        201,
      )
    ).id;
    seals = (
      await ok(
        await as(ada).send("POST", "/defence/controls", {
          name: "Bulk tanker seals verified",
          kind: "tamper_evidence",
          frequencyDays: 7,
        }),
        201,
      )
    ).id;
    const { controls } = await ok(await as(ada).get("/defence/controls"));
    expect(controls.map((c: { dueStatus: string }) => c.dueStatus)).toEqual(["never", "never"]);
  });

  it("drafts an assessment and refuses approval until it is complete", async () => {
    const high = {
      id: T1,
      area: "Bulk sugar silo",
      threat: "Deliberate contamination through the unlocked fill point",
      source: "intruder",
      likelihood: 3,
      impact: 5,
      existingControls: "Fill point in fenced yard",
      mitigation: null,
      controlIds: [gate],
    };
    const created = await ok(
      await viaToken("POST", "/defence/assessments", {
        title: "Site threat assessment (TACCP)",
        scope: "Whole site",
        draft: { threats: [high] },
      }),
      201,
    );
    assessment = created.id;
    expect(created.draft.versionNumber).toBe(1);
    expect(created.draft.threats[0]).toMatchObject({ score: 15, rating: "high" });
    expect(created.approvalBlockers).toEqual([
      "Set the next review date",
      expect.stringContaining("rates high and needs a mitigation"),
    ]);
    await fails(
      await as(ada).send("PUT", `/defence/assessments/${assessment}/draft`, {
        threats: [{ ...high, controlIds: ["33333333-3333-4333-8333-333333333333"] }],
      }),
      400,
    );
    await ok(
      await viaToken("PUT", `/defence/assessments/${assessment}/draft`, {
        threats: [{ ...high, mitigation: "Lockable cap; key held by shift manager" }],
        reviewDueOn: addDays(today, 365),
      }),
    );
    const reviewed = await stamp(assessment);
    // Approval is a person with manage: not a token, not a writer.
    expect(
      (await viaToken("POST", `/defence/assessments/${assessment}/draft/approve`, reviewed)).status,
    ).toBe(403);
    expect(
      (await as(marcus.cookie).send("POST", `/defence/assessments/${assessment}/draft/approve`, reviewed))
        .status,
    ).toBe(403);
    // It names the draft that was reviewed.
    await fails(await as(ada).send("POST", `/defence/assessments/${assessment}/draft/approve`), 400);
    const approved = await ok(
      await as(ada).send("POST", `/defence/assessments/${assessment}/draft/approve`, reviewed),
    );
    expect(approved.approved).toMatchObject({ versionNumber: 1, status: "approved" });
    expect(approved.approved.approvedByName).toBeTruthy();
    expect(approved.draft).toBeNull();
    expect(approved.reviewStatus).toBe("ok");
    await fails(
      await as(ada).send("PUT", `/defence/assessments/${assessment}/draft`, { summary: "x" }),
      409,
      "no_draft",
    );
  });

  it("a review keeps the version before it", async () => {
    const started = await ok(
      await as(marcus.cookie).send("POST", `/defence/assessments/${assessment}/review`, {
        trigger: "exercise",
        reason: "Drill found the silo key unattended",
      }),
      201,
    );
    expect(started.draft).toMatchObject({ versionNumber: 2, reviewTrigger: "exercise" });
    expect(started.approved.versionNumber).toBe(1);
    await fails(
      await as(ada).send("POST", `/defence/assessments/${assessment}/review`, { trigger: "scheduled" }),
      409,
      "draft_exists",
    );
    const v1 = started.approved.threats[0];
    const edited = await ok(
      await as(marcus.cookie).send("PUT", `/defence/assessments/${assessment}/draft`, {
        threats: [
          { ...v1, likelihood: 2 },
          {
            id: T2,
            area: "Packaging store",
            threat: "Tampering with packaging by a visitor",
            source: "visitor",
            likelihood: 2,
            impact: 3,
            existingControls: "Visitors escorted",
            mitigation: null,
            controlIds: [],
          },
        ],
        reviewDueOn: addDays(today, 365),
      }),
    );
    expect(edited.draftChanges.map((c: { change: string }) => c.change)).toEqual(["rerated", "added"]);
    const after = await ok(
      await as(ada).send("POST", `/defence/assessments/${assessment}/draft/approve`, await stamp(assessment)),
    );
    expect(
      after.history.map((v: { versionNumber: number; status: string }) => [v.versionNumber, v.status]),
    ).toEqual([
      [2, "approved"],
      [1, "superseded"],
    ]);
    // The superseded version is kept exactly as approved.
    expect(after.history[1].threats).toHaveLength(1);
    expect(after.history[1].threats[0].likelihood).toBe(3);
  });

  it("refuses to approve a draft that changed after the manager reviewed it", async () => {
    const high = {
      id: T1,
      area: "Raw milk intake",
      threat: "Contaminant added at the unattended intake point",
      source: "employee",
      likelihood: 4,
      impact: 5,
      existingControls: null,
      mitigation: "Intake locked; CCTV on the hose point",
      controlIds: [gate],
    };
    const created = await ok(
      await as(ada).send("POST", "/defence/assessments", {
        title: "Intake threat assessment",
        draft: { threats: [high], reviewDueOn: addDays(today, 180) },
      }),
      201,
    );
    // Ada opens the complete high-risk draft…
    const seen = await stamp(created.id);
    expect(seen.revision).toEqual(expect.any(String));
    // …a writer swaps in a low-risk version without the mitigation…
    await ok(
      await as(marcus.cookie).send("PUT", `/defence/assessments/${created.id}/draft`, {
        threats: [{ ...high, likelihood: 1, impact: 2, mitigation: null }],
      }),
    );
    // …and Ada's Approve, made against what she saw, is refused rather than signed.
    await fails(
      await as(ada).send("POST", `/defence/assessments/${created.id}/draft/approve`, seen),
      409,
      "draft_changed",
    );
    await fails(
      await as(ada).send("POST", `/defence/assessments/${created.id}/draft/approve`, {
        ...(await stamp(created.id)),
        draftId: "33333333-3333-4333-8333-333333333333",
      }),
      409,
      "draft_changed",
    );
    const still = await ok(await as(ada).get(`/defence/assessments/${created.id}`));
    expect(still.approved).toBeNull();
    // After reloading she approves what is actually there.
    const approved = await ok(
      await as(ada).send("POST", `/defence/assessments/${created.id}/draft/approve`, await stamp(created.id)),
    );
    expect(approved.approved.threats[0]).toMatchObject({ likelihood: 1, impact: 2, mitigation: null });
    expect(approved.approved.revision).toBeNull();
    // Keep the later overview counts to the main assessment.
    await ok(await as(ada).send("PATCH", `/defence/assessments/${created.id}`, { status: "archived" }));
  });

  it("records checks by a person; failures stay open until resolved; overdue controls show", async () => {
    const check = { checkedOn: today, outcome: "pass" };
    expect((await viaToken("POST", `/defence/controls/${gate}/checks`, check)).status).toBe(403);
    await ok(await as(marcus.cookie).send("POST", `/defence/controls/${gate}/checks`, check), 201);
    await fails(
      await as(marcus.cookie).send("POST", `/defence/controls/${seals}/checks`, {
        checkedOn: today,
        outcome: "fail",
      }),
      400,
    );
    const failed = await ok(
      await as(marcus.cookie).send("POST", `/defence/controls/${seals}/checks`, {
        checkedOn: addDays(today, -10),
        outcome: "fail",
        notes: "Seal number didn't match the delivery note",
        actionTaken: "Load quarantined",
      }),
      201,
    );
    let overview = await ok(await as(ada).get("/defence/overview"));
    expect(overview.counts).toMatchObject({
      controls: 2,
      overdueControls: 1,
      openFailures: 1,
      assessments: 1,
    });
    expect(
      overview.controlsDue.map((c: { name: string; dueStatus: string }) => [c.name, c.dueStatus]),
    ).toEqual([["Bulk tanker seals verified", "overdue"]]);
    expect(overview.exerciseOverdue).toBe(true);
    // Ada has Attendance access, so visitors on site are listed; Marcus doesn't.
    expect(overview.visitors).toEqual({ onSite: [] });
    expect((await ok(await as(marcus.cookie).get("/defence/overview"))).visitors).toBeNull();

    expect((await viaToken("POST", `/defence/checks/${failed.id}/resolve`, { resolution: "x" })).status).toBe(
      403,
    );
    await ok(
      await as(ada).send("POST", `/defence/checks/${failed.id}/resolve`, {
        resolution: "Supplier investigated; seal register corrected",
      }),
    );
    await fails(
      await as(ada).send("POST", `/defence/checks/${failed.id}/resolve`, { resolution: "again" }),
      409,
      "already_resolved",
    );
    const { checks } = await ok(await as(ada).get("/defence/checks?outcome=open"));
    expect(checks).toEqual([]);
    overview = await ok(await as(ada).get("/defence/overview"));
    expect(overview.counts.openFailures).toBe(0);
  });

  it("records exercises against an assessment", async () => {
    const ex = {
      title: "Silo tamper drill",
      scenario: "Simulated tampering at the fill point",
      heldOn: today,
      assessmentId: assessment,
      outcome: "partly_effective",
      findings: "Key unattended",
    };
    expect((await viaToken("POST", "/defence/exercises", ex)).status).toBe(403);
    await ok(await as(ada).send("POST", "/defence/exercises", ex), 201);
    const overview = await ok(await as(ada).get("/defence/overview"));
    expect(overview.exerciseOverdue).toBe(false);
    expect(overview.lastExercise.title).toBe("Silo tamper drill");
    const detail = await ok(await as(ada).get(`/defence/assessments/${assessment}`));
    expect(detail.exercises.map((e: { title: string }) => e.title)).toEqual(["Silo tamper drill"]);
  });

  it("syncs metadata only", async () => {
    const page = await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie: marcus.cookie })).json();
    const versions = page.changes.filter(
      (c: { entity: string }) => c.entity === "defence_assessment_version",
    );
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) expect(v.data.threats).toBeUndefined();
    const checks = page.changes.filter((c: { entity: string }) => c.entity === "defence_check");
    for (const c of checks) expect(c.data.notes).toBeUndefined();
  });
});
