import { addDays, DEFAULT_TIME_ZONE, moduleIds, newId, todayInZone } from "@knotworking/core";
import { hseIncidentInjuries } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hseIncidentOverview } from "./services/hse-incident-follow-up";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

/**
 * Restricted incident follow-up: owned corrective actions, people hurt restricted to managers,
 * low-barrier reports and the overview, layered on the `hse_incidents` module.
 */
describe("restricted HSE incident follow-up", () => {
  let ctx: TestCtx, ada: string, marcus: string, adaId: string, marcusId: string, token: string;
  const call = (method: string, path: string, json?: unknown, cookie = ada) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  const ok = async (r: Res, status = 200) => {
    const b = await r.json();
    expect(r.status, JSON.stringify(b)).toBe(status);
    return b;
  };
  const fail = async (r: Res, status: number, code?: string) => {
    const b = await r.json();
    expect(r.status, JSON.stringify(b)).toBe(status);
    if (code) expect(b.error.code).toBe(code);
    return b;
  };
  const grant = (module: string, level: string | null) =>
    call("PUT", `/members/${marcusId}/module-access/${module}`, { level });
  const injury = {
    personName: "Sam Lee",
    personType: "agency",
    nature: "Deep laceration, left index finger",
    bodyPart: "Hand",
    treatment: "hospital",
    daysAbsent: 3,
  };
  let incident: any;
  const reload = async () => (incident = await ok(await call("GET", `/hse/incidents/${incident.id}`)));

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    adaId = (await ok(await ctx.req("/v1/me", { cookie: ada }))).user.id;
    marcusId = (await ok(await ctx.req("/v1/me", { cookie: marcus }))).user.id;
    token = (
      await ok(
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "HSE agent", scope: "write" },
        }),
        201,
      )
    ).token;
    // Marcus investigates (write on restricted incidents), but isn't an incident manager.
    for (const m of moduleIds.filter((m) => m !== "hse_incidents" && m !== "hse"))
      await ok(await grant(m, "read"));
    await ok(await grant("hse", "write"));
    await ok(await grant("hse_incidents", "write"));
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("lets anyone with HSE write access, or an agent, report an incident with nobody hurt", async () => {
    const report = {
      commandId: newId(),
      kind: "near_miss",
      occurredOn: today,
      place: "Goods-in",
      summary: "Pallet slipped from the forks; nobody nearby",
    };
    const reported = await ok(await viaToken("POST", "/hse/reports", report), 201);
    expect(reported).toEqual({ id: expect.any(String), reference: expect.stringMatching(/^HSE-/) });
    // A retry with the same command returns the same report.
    expect((await ok(await viaToken("POST", "/hse/reports", report), 201)).id).toBe(reported.id);
    await fail(
      await viaToken("POST", "/hse/reports", { ...report, commandId: newId(), kind: "accident" }),
      400,
    );
    await fail(
      await viaToken("POST", "/hse/reports", {
        ...report,
        commandId: newId(),
        occurredOn: addDays(today, 1),
      }),
      400,
    );
    // It lands as a restricted incident for the investigators, still not reachable by tokens.
    const seen = await ok(await call("GET", `/hse/incidents/${reported.id}`));
    expect(seen).toMatchObject({
      status: "open",
      body: { kind: "near_miss", outcome: "none" },
      injuryCount: 0,
    });
    await fail(await viaToken("GET", `/hse/incidents/${reported.id}`), 403);
  });

  it("restricts the people hurt and health details to signed-in incident managers, in reads and history", async () => {
    incident = await ok(
      await call(
        "POST",
        "/hse/incidents",
        {
          commandId: newId(),
          body: {
            kind: "accident",
            occurredOn: today,
            place: "Line 2 slicer",
            summary: "Cut while clearing a jam with the guard open",
            healthDetails: "Restricted health narrative",
            immediateActions: "First aid; slicer isolated",
            ownerUserId: marcusId,
          },
        },
        marcus,
      ),
      201,
    );
    // Marcus wrote the narrative, but as a non-manager doesn't get it back.
    expect(incident.body.healthDetails).not.toContain("narrative");
    await reload();
    // A harm recorded after the report, with its outcome, in one step (managers only).
    const save = (cookie: string, extra: object = {}) =>
      call(
        "PUT",
        `/hse/incidents/${incident.id}/injuries`,
        {
          commandId: newId(),
          expectedRevision: incident.revision,
          injuries: [injury],
          outcome: "lost_time",
          reason: "Hospital confirmed the injury",
          ...extra,
        },
        cookie,
      );
    await fail(await save(marcus), 403);
    await fail(await save(ada, { outcome: "none" }), 400);
    incident = await ok(await save(ada));
    expect(incident).toMatchObject({
      injuryCount: 1,
      canSeeRestricted: true,
      body: { outcome: "lost_time" },
    });
    expect(incident.injuries[0]).toMatchObject({ personName: "Sam Lee", daysAbsent: 3 });
    // Marcus sees that one person was hurt, never who or how, nor the narrative.
    const theirs = await ok(await call("GET", `/hse/incidents/${incident.id}`, undefined, marcus));
    expect(theirs).toMatchObject({ injuryCount: 1, injuries: null, canSeeRestricted: false });
    expect(JSON.stringify(theirs)).not.toContain("Sam Lee");
    expect(JSON.stringify(theirs)).not.toContain("narrative");
    const history = await ok(await call("GET", `/hse/incidents/${incident.id}/history`, undefined, marcus));
    expect(JSON.stringify(history)).not.toContain("narrative");
    expect(JSON.stringify(history)).not.toContain("Sam Lee");
    // The manager's reason may name people: non-managers see a neutral one.
    expect(JSON.stringify(history)).not.toContain("Hospital confirmed");
    const managers = await ok(await call("GET", `/hse/incidents/${incident.id}/history`));
    expect(JSON.stringify(managers)).toContain("Hospital confirmed");
    expect(history.events.map((e: { action: string }) => e.action)).toContain("people_hurt_updated");
    // Saving the investigation as Marcus keeps the narrative he can't see.
    const saved = await ok(
      await call(
        "PUT",
        `/hse/incidents/${incident.id}`,
        {
          commandId: newId(),
          expectedRevision: incident.revision,
          reason: "Investigation notes",
          body: { ...theirs.body, investigation: "Witness statements taken" },
        },
        marcus,
      ),
    );
    expect(saved.body.investigation).toBe("Witness statements taken");
    // Marcus can't turn it into a near miss while people are recorded as hurt.
    const refused = await fail(
      await call(
        "PUT",
        `/hse/incidents/${incident.id}`,
        {
          commandId: newId(),
          expectedRevision: saved.revision,
          reason: "Reclassify",
          body: { ...saved.body, kind: "near_miss" },
        },
        marcus,
      ),
      409,
    );
    expect(JSON.stringify(refused)).not.toContain("Sam Lee");
    await reload();
    expect(incident.body.healthDetails).toBe("Restricted health narrative");
    expect(incident.body.outcome).toBe("lost_time");
    // Replaced people are kept, not deleted.
    incident = await ok(
      await call("PUT", `/hse/incidents/${incident.id}/injuries`, {
        commandId: newId(),
        expectedRevision: incident.revision,
        injuries: [{ ...injury, daysAbsent: 9 }],
        outcome: "lost_time",
        reason: "Absence extended",
      }),
    );
    const rows = await ctx.handle.db
      .select()
      .from(hseIncidentInjuries)
      .where(eq(hseIncidentInjuries.incidentId, incident.id));
    expect(rows.map((r) => [r.daysAbsent, r.deletedAt === null]).sort()).toEqual([
      [3, false],
      [9, true],
    ]);
  });

  it("tracks owned actions that advance the incident's revision and block closure while open", async () => {
    const add = (owner: string, dueOn: string, cookie = marcus) =>
      call(
        "POST",
        `/hse/incidents/${incident.id}/actions`,
        {
          commandId: newId(),
          expectedRevision: incident.revision,
          description: `Action for ${owner}`,
          ownerUserId: owner,
          dueOn,
        },
        cookie,
      );
    const { members } = await ok(await call("GET", "/members"));
    const priya = members.find((m: { email: string }) => m.email === "priya@knotworking.dev");
    expect(priya.role).toBe("member");
    await fail(await add(priya.userId, today), 400);
    const before = incident.revision;
    incident = await ok(await add(marcusId, addDays(today, -1)), 201);
    expect(incident.revision).toBe(before + 1);
    incident = await ok(await add(adaId, addDays(today, 14)), 201);
    const [overdue, later] = incident.actions;
    expect(overdue).toMatchObject({ state: "overdue", ownerName: expect.any(String) });
    // A stale revision is refused; owners must be able to see restricted incidents.
    await fail(
      await call("POST", `/hse/incidents/${incident.id}/actions`, {
        commandId: newId(),
        expectedRevision: before,
        description: "Stale",
        ownerUserId: marcusId,
        dueOn: today,
      }),
      409,
    );
    const overview = await ok(await call("GET", "/hse/incidents/overview"));
    expect(overview.counts.overdueActions).toBe(1);
    expect(overview.daysSinceLostTime).toBe(0);
    // Marcus may complete his own, not Ada's, and can't cancel.
    const complete = (actionId: string, status: string, cookie: string) =>
      call(
        "POST",
        `/hse/incidents/${incident.id}/actions/${actionId}/complete`,
        { commandId: newId(), expectedRevision: incident.revision, status, note: "Done and checked" },
        cookie,
      );
    await fail(await complete(later.id, "done", marcus), 403, "not_action_owner");
    await fail(await complete(overdue.id, "cancelled", marcus), 403, "not_manager");
    incident = await ok(await complete(overdue.id, "done", marcus));
    // Closure (with everything else complete) is refused while an action is open…
    incident = await ok(
      await call("PUT", `/hse/incidents/${incident.id}`, {
        commandId: newId(),
        expectedRevision: incident.revision,
        reason: "Investigation complete",
        body: {
          ...incident.body,
          rootCause: "Guard interlock bypassed",
          correctiveActions: "Interlock replaced; retraining",
          effectiveness: "Rechecked a week later",
          reportingDecision: "required",
          reportingBasis: "Over seven days incapacitation under RIDDOR",
          reportingDueOn: addDays(today, 10),
          reportReference: "RIDDOR-4821",
        },
      }),
    );
    const close = (revision: number) =>
      call("POST", `/hse/incidents/${incident.id}/close`, {
        commandId: newId(),
        expectedRevision: revision,
        reason: "Closed",
      });
    const reviewed = incident.revision;
    expect((await fail(await close(reviewed), 409)).error.message).toContain("1 open corrective action");
    // …and a closure signed before an action changed is refused too.
    incident = await ok(await complete(later.id, "done", ada));
    await fail(await close(reviewed), 409);
    await ok(await close(incident.revision));
  });

  it("refuses tokens on every restricted read", async () => {
    for (const path of ["/hse/incidents", "/hse/incidents/overview", `/hse/incidents/${incident.id}/history`])
      await fail(await viaToken("GET", path), 403);
  });

  it("keeps the overview available on leap day", async () => {
    const overview = await hseIncidentOverview(
      ctx.handle.db,
      (await ctx.handle.db.query.workspaces.findFirst())!.id,
      "2024-02-29",
    );
    expect(overview.today).toBe("2024-02-29");
    expect(overview.counts).toEqual(expect.objectContaining({ open: expect.any(Number) }));
  });
});
