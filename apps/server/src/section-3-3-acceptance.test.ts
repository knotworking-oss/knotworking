import { addDays, DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

/**
 * Section 3.3 acceptance exercise (docs/phase-3.md), end to end through the API:
 *
 * - an assessment review retains its preceding version (food defence here; food authenticity has
 *   the same guarantee in its own suite);
 * - overdue controls are visible;
 * - a management review assembles evidence from complaints, CAPA (non-conformances), audits,
 *   testing and culture activities, and its signing assigns the follow-up work as tasks.
 */
describe("Section 3.3 acceptance exercise", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let teamId: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const ok = async (res: Response, status = 200): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };

  const threat = {
    id: "11111111-1111-4111-8111-111111111111",
    area: "Goods-in yard",
    threat: "Tampering with an unattended delivery",
    source: "intruder",
    likelihood: 3,
    impact: 4,
    existingControls: "Yard gate locked out of hours",
    mitigation: null,
    controlIds: [] as string[],
  };
  let gate: string;
  let assessment: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    const boot = await (await ctx.req(`${WS}/bootstrap`, { cookie: ada })).json();
    teamId = boot.teams[0].id;
  });

  afterAll(() => ctx.handle.close());

  it("keeps the preceding version when a threat assessment is reviewed", async () => {
    gate = (
      await ok(
        await as(ada).send("POST", "/defence/controls", {
          name: "Yard gate locked out of hours",
          kind: "perimeter",
          frequencyDays: 1,
        }),
        201,
      )
    ).id;
    const created = await ok(
      await as(ada).send("POST", "/defence/assessments", {
        title: "Site threat assessment",
        draft: { threats: [{ ...threat, controlIds: [gate] }], reviewDueOn: addDays(today, 365) },
      }),
      201,
    );
    assessment = created.id;
    const stamp = async () => {
      const { draft } = await ok(await as(ada).get(`/defence/assessments/${assessment}`));
      return { draftId: draft.id, revision: draft.revision };
    };
    await ok(await as(ada).send("POST", `/defence/assessments/${assessment}/draft/approve`, await stamp()));
    await ok(
      await as(ada).send("POST", `/defence/assessments/${assessment}/review`, {
        trigger: "incident",
        reason: "Gate found unlocked overnight",
      }),
      201,
    );
    await ok(
      await as(ada).send("PUT", `/defence/assessments/${assessment}/draft`, {
        threats: [
          { ...threat, likelihood: 4, mitigation: "Gate alarm to the security company", controlIds: [gate] },
        ],
        reviewDueOn: addDays(today, 180),
      }),
    );
    const after = await ok(
      await as(ada).send("POST", `/defence/assessments/${assessment}/draft/approve`, await stamp()),
    );
    expect(
      after.history.map((v: { versionNumber: number; status: string }) => [v.versionNumber, v.status]),
    ).toEqual([
      [2, "approved"],
      [1, "superseded"],
    ]);
    // Version 1 is kept exactly as it was approved.
    expect(after.history[1].threats[0]).toMatchObject({ likelihood: 3, mitigation: null });
    expect(after.history[1].approvedByName).toBeTruthy();
  });

  it("shows overdue security controls", async () => {
    // Last checked three days ago on a daily frequency.
    await ok(
      await as(ada).send("POST", `/defence/controls/${gate}/checks`, {
        checkedOn: addDays(today, -3),
        outcome: "pass",
      }),
      201,
    );
    const { controls } = await ok(await as(ada).get("/defence/controls"));
    expect(controls.find((c: { id: string }) => c.id === gate)).toMatchObject({ dueStatus: "overdue" });
    const overview = await ok(await as(ada).get("/defence/overview"));
    expect(overview.counts.overdueControls).toBe(1);
    expect(overview.controlsDue.map((c: { id: string }) => c.id)).toContain(gate);
  });

  it("assembles a management review from complaints, CAPA, audits, testing and culture, and assigns follow-up", async () => {
    // A complaint, and a process non-conformance (CAPA) for its likely cause.
    await ok(
      await as(ada).send("POST", "/quality/complaints", {
        receivedOn: today,
        source: "consumer",
        category: "foreign_body",
        severity: "major",
        description: "Plastic fragment in loaf",
      }),
      201,
    );
    await ok(
      await as(ada).send("POST", "/quality/nonconformances", {
        raisedOn: today,
        source: "process",
        severity: "major",
        title: "Sieve mesh damaged",
        description: "Line 2 sieve torn; likely source of plastic",
        ownerUserId: marcus.userId,
      }),
      201,
    );
    // An audit completed in the period with a finding (another non-conformance).
    const audit = await ok(
      await as(ada).send("POST", "/quality/audits", { title: "Foreign body controls", plannedOn: today }),
      201,
    );
    await ok(
      await as(ada).send("POST", `/quality/audits/${audit.id}/complete`, {
        completedOn: today,
        summary: "Sieve checks not recorded on nights",
        findings: [
          { title: "Night sieve checks missing", description: "No records for 3 nights", severity: "minor" },
        ],
      }),
    );
    // Testing: a failed sample with its investigation open.
    const item = (
      await ok(
        await as(ada).send("POST", "/items", {
          code: "X33-LOAF",
          name: "Exercise loaf",
          type: "finished",
          unit: "each",
        }),
        201,
      )
    ).id;
    const store = (await ok(await as(ada).send("POST", "/stock/locations", { name: "X33 store" }), 201)).id;
    const lot = (
      await ok(
        await as(ada).send("POST", "/stock/receipts", {
          itemId: item,
          quantity: 10,
          unit: "each",
          locationId: store,
          receivedOn: today,
          reason: "Exercise stock",
        }),
        201,
      )
    ).id;
    const sample = await ok(
      await as(ada).send("POST", "/testing/samples", {
        subject: "lot",
        lotId: lot,
        sampledOn: today,
        analytes: [{ category: "microbiological", name: "Listeria", limitText: "Absent in 25 g" }],
      }),
      201,
    );
    await ok(
      await as(ada).send("POST", `/testing/samples/${sample.id}/results`, {
        reportedOn: today,
        results: [{ resultId: sample.results[0].id, outcome: "fail" }],
      }),
    );
    // Culture: an activity done in the period.
    const activity = await ok(
      await as(ada).send("POST", "/governance/culture", {
        title: "Foreign-body toolbox talk",
        kind: "training",
        plannedOn: today,
      }),
      201,
    );
    await ok(
      await as(ada).send("PATCH", `/governance/culture/${activity.id}`, {
        completedOn: today,
        participants: 42,
        result: "All shifts briefed",
      }),
    );

    const review = await ok(
      await as(ada).send("POST", "/governance/reviews", {
        title: "Exercise management review",
        periodFrom: addDays(today, -30),
        periodTo: today,
      }),
      201,
    );
    const draft = await ok(await as(ada).get(`/governance/reviews/${review.id}`));
    const e = draft.evidence;
    expect(e.complaints).toMatchObject({ available: true, received: 1 });
    // CAPA: the major complaint opened its own non-conformance, plus the process one and the audit finding.
    expect(e.nonconformances).toMatchObject({ available: true, raised: 3, open: 3 });
    expect(e.audits).toMatchObject({ available: true, completed: 1, findings: 1 });
    expect(e.testing).toMatchObject({ available: true, sampled: 1, failed: 1, openInvestigations: 1 });
    expect(e.culture).toMatchObject({ doneInPeriod: 1 });
    expect(e.culture.done.map((a: { id: string }) => a.id)).toEqual([activity.id]);
    // The overdue security control reaches the review too.
    expect(e.defence).toMatchObject({ available: true, overdueControls: 1 });

    // Decisions with owners become follow-up tasks when the review is signed.
    await ok(
      await as(ada).send("PATCH", `/governance/reviews/${review.id}`, {
        heldOn: today,
        attendees: "Site director, QA manager, production manager",
        followUpTeamId: teamId,
        notes: { complaints: "Foreign-body trend traced to the line 2 sieve" },
        decisions: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            topic: "complaints",
            decision: "Replace line 2 sieve and add night checks to the round",
            ownerUserId: marcus.userId,
            dueOn: addDays(today, 14),
          },
        ],
      }),
    );
    const signed = await ok(await as(ada).send("POST", `/governance/reviews/${review.id}/sign`));
    expect(signed).toMatchObject({ status: "signed", evidenceIsSnapshot: true });
    const task = await ok(await as(ada).get(`/tasks/${signed.decisions[0].taskId}`));
    expect(task).toMatchObject({ assigneeId: marcus.userId, dueDate: addDays(today, 14) });
    expect(task.title).toContain("Replace line 2 sieve");
    // The snapshot keeps what was reviewed.
    expect(signed.evidence.complaints.received).toBe(1);
    expect(signed.evidence.testing.failed).toBe(1);
  });
});
