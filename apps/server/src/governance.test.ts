import { addDays } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = new Date().toISOString().slice(0, 10);
const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";

describe("governance module", () => {
  let ctx: TestCtx;
  let ada: { cookie: string; userId: string };
  let marcus: { cookie: string; userId: string };
  let token: string;
  let teamId: string;
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
  const fails = async (res: Response, status: number, code?: string): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    if (code) expect(body.error?.code).toBe(code);
    return body;
  };

  let objective: string;
  let review: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    const a = await signIn(ctx, "ada@knotworking.dev");
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: a.cookie })).json();
    const find = (email: string) => members.find((x: { email: string }) => x.email === email);
    ada = { cookie: a.cookie, userId: find("ada@knotworking.dev").userId };
    marcus = {
      userId: find("marcus@knotworking.dev").userId,
      cookie: (await signIn(ctx, "marcus@knotworking.dev")).cookie,
    };
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada.cookie,
          json: { name: "t", scope: "write" },
        })
      ).json()
    ).token;
    const boot = await (await ctx.req(`${WS}/bootstrap`, { cookie: ada.cookie })).json();
    teamId = boot.teams[0].id;
  });

  afterAll(() => ctx.handle.close());

  it("is opt-in, but any member can raise a confidential concern", async () => {
    expect((await as(marcus.cookie).get("/governance/overview")).status).toBe(403);
    // Marcus has no Governance access and can still raise a concern, named or anonymously.
    const named = await ok(
      await as(marcus.cookie).send("POST", "/concerns", {
        category: "food_safety",
        description: "Hand-wash station on line 2 has had no soap all week",
      }),
      201,
    );
    expect(named).toMatchObject({ reference: "CON-0001", anonymous: false });
    const anon = await ok(
      await as(marcus.cookie).send("POST", "/concerns", {
        category: "behaviour",
        description: "Supervisor told us to skip the metal detector check when busy",
        anonymous: true,
      }),
      201,
    );
    expect(anon.reference).toBe("CON-0002");
    // Never by token.
    expect(
      (await viaToken("POST", "/concerns", { category: "other", description: "Something to report here" }))
        .status,
    ).toBe(403);
    // The reporter sees only their named concern.
    const mine = await ok(await as(marcus.cookie).get("/concerns/mine"));
    expect(mine.concerns.map((c: { reference: string }) => c.reference)).toEqual(["CON-0001"]);
  });

  it("keeps concerns to managers, never tokens, and out of sync", async () => {
    await ctx.req(`${WS}/members/${marcus.userId}/module-access/governance`, {
      method: "PUT",
      cookie: ada.cookie,
      json: { level: "write" },
    });
    expect((await as(marcus.cookie).get("/governance/concerns")).status).toBe(403);
    expect((await viaToken("GET", "/governance/concerns")).status).toBe(403);
    const { concerns } = await ok(await as(ada.cookie).get("/governance/concerns"));
    expect(
      concerns.map((c: { reference: string; anonymous: boolean; raisedByName: string | null }) => [
        c.reference,
        c.anonymous,
        !!c.raisedByName,
      ]),
    ).toEqual([
      ["CON-0002", true, false],
      ["CON-0001", false, true],
    ]);
    const first = concerns.find((c: { reference: string }) => c.reference === "CON-0001");
    await fails(
      await as(ada.cookie).send("PATCH", `/governance/concerns/${first.id}`, { status: "closed" }),
      400,
    );
    await ok(
      await as(ada.cookie).send("PATCH", `/governance/concerns/${first.id}`, {
        status: "closed",
        investigation: "Supplier delivery missed; stock now held on site",
        outcome: "Soap restocked and a minimum stock level set",
      }),
    );
    const mine = await ok(await as(marcus.cookie).get("/concerns/mine"));
    expect(mine.concerns[0]).toMatchObject({
      status: "closed",
      outcome: "Soap restocked and a minimum stock level set",
    });
    expect(mine.concerns[0].investigation).toBeUndefined();
    const page = await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie: ada.cookie })).json();
    expect(page.changes.some((c: { entity: string }) => c.entity.includes("concern"))).toBe(false);
    expect(JSON.stringify(page.changes)).not.toContain("metal detector");
    // The overview counts them for managers only.
    expect((await ok(await as(ada.cookie).get("/governance/overview"))).openConcerns).toBe(1);
    expect((await ok(await as(marcus.cookie).get("/governance/overview"))).openConcerns).toBeNull();
  });

  it("tracks objectives with progress and the culture plan", async () => {
    const o = await ok(
      await viaToken("POST", "/governance/objectives", {
        title: "Reduce foreign-body complaints",
        category: "food_safety",
        measure: "Justified foreign-body complaints per million units",
        target: "< 2 per million",
        ownerUserId: marcus.userId,
        dueOn: addDays(today, 90),
      }),
      201,
    );
    objective = o.id;
    expect(o).toMatchObject({ ownerName: expect.any(String), dueStatus: "ok", latest: null });
    await fails(
      await as(ada.cookie).send("POST", "/governance/objectives", {
        title: "x",
        category: "quality",
        ownerUserId: "33333333-3333-4333-8333-333333333333",
      }),
      400,
    );
    const p = await ok(
      await as(marcus.cookie).send("POST", `/governance/objectives/${objective}/progress`, {
        on: today,
        rag: "at_risk",
        value: "3.1 per million",
        note: "Two complaints from the new sieve",
      }),
      201,
    );
    expect(p.latest).toMatchObject({ rag: "at_risk", value: "3.1 per million" });
    const overview = await ok(await as(ada.cookie).get("/governance/overview"));
    expect(overview.objectivesNeedingAttention.map((x: { id: string }) => x.id)).toEqual([objective]);

    const activity = await ok(
      await as(ada.cookie).send("POST", "/governance/culture", {
        title: "Food safety culture survey",
        kind: "survey",
        plannedOn: addDays(today, -3),
        objectiveId: objective,
      }),
      201,
    );
    expect(activity.state).toBe("overdue");
    const done = await ok(
      await as(ada.cookie).send("PATCH", `/governance/culture/${activity.id}`, {
        completedOn: today,
        participants: 84,
        result: "Engagement 71%, up from 64%",
      }),
    );
    expect(done.state).toBe("done");
  });

  it("keeps a requirement register with compliance reviews by a person", async () => {
    const r = await ok(
      await viaToken("POST", "/governance/requirements", {
        source: "customer",
        reference: "COP 4.2",
        title: "Glass and brittle plastic audit monthly",
        customerName: "Corner Shop Ltd",
        reviewDueOn: addDays(today, -1),
      }),
      201,
    );
    expect(r).toMatchObject({ compliance: "not_assessed", reviewStatus: "overdue" });
    const review = {
      reviewedOn: today,
      compliance: "partial",
      notes: "Two months missed",
      nextReviewOn: addDays(today, 180),
    };
    expect((await viaToken("POST", `/governance/requirements/${r.id}/review`, review)).status).toBe(403);
    const reviewed = await ok(
      await as(marcus.cookie).send("POST", `/governance/requirements/${r.id}/review`, review),
    );
    expect(reviewed).toMatchObject({ compliance: "partial", reviewStatus: "ok", lastReviewedOn: today });
  });

  it("assembles evidence for a management review, signs it and creates follow-up tasks", async () => {
    // Some evidence in Quality.
    await ok(
      await as(ada.cookie).send("POST", "/quality/complaints", {
        receivedOn: today,
        source: "consumer",
        category: "foreign_body",
        severity: "major",
        description: "Plastic in product",
      }),
      201,
    );
    const created = await ok(
      await viaToken("POST", "/governance/reviews", {
        title: "Management review Q4",
        periodFrom: addDays(today, -90),
        periodTo: today,
      }),
      201,
    );
    review = created.id;
    let r = await ok(await as(ada.cookie).get(`/governance/reviews/${review}`));
    expect(r.evidenceIsSnapshot).toBe(false);
    expect(r.evidence.complaints).toMatchObject({ available: true, received: 1 });
    expect(r.evidence.concerns).toMatchObject({ raisedInPeriod: 2, open: 1 });
    expect(r.evidence.culture.doneInPeriod).toBe(1);
    expect(r.evidence.objectives).toMatchObject({ open: 1, atRisk: 1 });
    expect(r.evidence.requirements.byCompliance.partial).toBe(1);
    expect(r.evidence.testing.available).toBe(true);
    expect(r.evidence.defence.available).toBe(true);
    expect(r.signBlockers).toEqual(["Record when the review was held", "Record who attended"]);

    // Marcus can't read Quality: his view says so rather than showing zero.
    const theirs = await ok(await as(marcus.cookie).get(`/governance/reviews/${review}`));
    expect(theirs.evidence.complaints).toMatchObject({ available: false });

    r = await ok(
      await as(marcus.cookie).send("PATCH", `/governance/reviews/${review}`, {
        heldOn: today,
        attendees: "Site director, QA manager, production manager",
        notes: { complaints: "Foreign-body trend driven by the new sieve" },
        decisions: [
          {
            id: D1,
            topic: "complaints",
            decision: "Replace the sieve mesh on line 2",
            ownerUserId: marcus.userId,
            dueOn: null,
          },
          {
            id: D2,
            topic: "resources",
            decision: "Budget for a second metal detector noted",
            ownerUserId: null,
            dueOn: null,
          },
        ],
      }),
    );
    expect(r.signBlockers).toEqual([
      "Choose the team the follow-up tasks go to",
      'Set a due date for "Replace the sieve mesh on line 2"',
    ]);
    await ok(
      await as(marcus.cookie).send("PATCH", `/governance/reviews/${review}`, {
        followUpTeamId: teamId,
        decisions: [
          {
            id: D1,
            topic: "complaints",
            decision: "Replace the sieve mesh on line 2",
            ownerUserId: marcus.userId,
            dueOn: addDays(today, 30),
          },
          {
            id: D2,
            topic: "resources",
            decision: "Budget for a second metal detector noted",
            ownerUserId: null,
            dueOn: null,
          },
        ],
      }),
    );
    // Signing is a person with manage.
    expect((await viaToken("POST", `/governance/reviews/${review}/sign`)).status).toBe(403);
    expect((await as(marcus.cookie).send("POST", `/governance/reviews/${review}/sign`)).status).toBe(403);
    const signed = await ok(await as(ada.cookie).send("POST", `/governance/reviews/${review}/sign`));
    expect(signed).toMatchObject({ status: "signed", evidenceIsSnapshot: true });
    expect(signed.signedByName).toBeTruthy();
    const [withTask, noOwner] = signed.decisions;
    expect(withTask.taskId).toEqual(expect.any(String));
    expect(noOwner.taskId).toBeNull();
    const task = await ok(await as(ada.cookie).get(`/tasks/${withTask.taskId}`));
    expect(task).toMatchObject({ assigneeId: marcus.userId, dueDate: addDays(today, 30) });
    expect(task.title).toContain("Replace the sieve mesh on line 2");

    // The snapshot holds what Ada could read; each reader still sees only the modules they can read now.
    const grant = (moduleId: string, level: string | null) =>
      ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
        method: "PUT",
        cookie: ada.cookie,
        json: { level },
      });
    await ok(await grant("testing", null));
    await ok(await grant("defence", "read"));
    let restricted = (await ok(await as(marcus.cookie).get(`/governance/reviews/${review}`))).evidence;
    for (const section of ["complaints", "nonconformances", "audits", "incidents", "testing"])
      expect(restricted[section], section).toEqual({ available: false, reason: expect.any(String) });
    expect(restricted.defence.available).toBe(true);
    // Governance's own evidence is still there.
    expect(restricted.objectives).toMatchObject({ open: 1, atRisk: 1 });
    // Revoking a source module hides its section again.
    await ok(await grant("defence", null));
    restricted = (await ok(await as(marcus.cookie).get(`/governance/reviews/${review}`))).evidence;
    expect(restricted.defence).toEqual({ available: false, reason: expect.any(String) });
    // The stored snapshot is unchanged for a reader who can see everything.
    const full = (await ok(await as(ada.cookie).get(`/governance/reviews/${review}`))).evidence;
    expect(full.complaints).toMatchObject({ available: true, received: 1 });
    expect(full.testing.available).toBe(true);
    expect(full.defence.available).toBe(true);

    // A signed review no longer changes, and its evidence is the snapshot.
    await fails(
      await as(ada.cookie).send("PATCH", `/governance/reviews/${review}`, { attendees: "x" }),
      409,
      "review_signed",
    );
    await ok(
      await as(ada.cookie).send("POST", "/quality/complaints", {
        receivedOn: today,
        source: "customer",
        category: "quality",
        severity: "minor",
        description: "Underweight pack",
      }),
      201,
    );
    expect(
      (await ok(await as(ada.cookie).get(`/governance/reviews/${review}`))).evidence.complaints.received,
    ).toBe(1);

    // The next review sees this one's actions.
    const next = await ok(
      await as(ada.cookie).send("POST", "/governance/reviews", {
        title: "Q1",
        periodFrom: today,
        periodTo: addDays(today, 90),
      }),
      201,
    );
    const n = await ok(await as(ada.cookie).get(`/governance/reviews/${next.id}`));
    expect(n.evidence.previousActions).toEqual([
      expect.objectContaining({ decision: "Replace the sieve mesh on line 2", state: "open" }),
      expect.objectContaining({ decision: "Budget for a second metal detector noted", state: "unknown" }),
    ]);
  });

  it("syncs objectives, culture, requirements and review metadata", async () => {
    const page = await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie: marcus.cookie })).json();
    const entities = new Set(page.changes.map((c: { entity: string }) => c.entity));
    for (const e of [
      "governance_objective",
      "governance_culture_activity",
      "governance_requirement",
      "governance_review",
    ])
      expect(entities.has(e), e).toBe(true);
    const reviewChange = page.changes.find((c: { entity: string }) => c.entity === "governance_review");
    expect(reviewChange.data.evidence).toBeUndefined();
    expect(reviewChange.data.notes).toBeUndefined();
  });
});
