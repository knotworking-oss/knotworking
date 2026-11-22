import {
  addDays,
  DEFAULT_TIME_ZONE,
  hseContentSchema,
  hsePermitBodySchema,
  moduleIds,
  newId,
  todayInZone,
} from "@knotworking/core";
import { hseRecords, hseVersions, hsePermits, workspaces, siteAssets } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { makeApp, signIn, type TestCtx, type Res } from "./test-utils";
const WS = "/v1/workspaces/acme",
  today = todayInZone(DEFAULT_TIME_ZONE);
describe("HSE controlled records, safe permits and restricted investigations", () => {
  let ctx: TestCtx,
    ada: string,
    marcus: string,
    actor: string,
    member: string,
    token: string,
    provider: string,
    asset: string;
  const call = (method: string, path: string, json?: unknown, cookie = ada) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
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
  const content = (extra: object = {}) =>
    hseContentSchema.parse({
      scope: "Mixing operations",
      basis: "Site HSE assessment procedure RA-1",
      controls: "Guarding, training and isolation",
      response: "Stop work and inform the site lead",
      ownerUserId: actor,
      reviewDueOn: addDays(today, 60),
      firstCheckDueOn: addDays(today, -1),
      frequencyDays: 7,
      evidenceReference: "Site procedure / approved evidence",
      hazards: [
        {
          hazard: "Moving machinery",
          peopleAtRisk: "Operatives and contractors",
          likelihood: 3,
          severity: 4,
          controls: "Lock off and verify zero energy",
          residualLikelihood: 1,
          residualSeverity: 4,
          rationale: "Verified isolation before access",
        },
      ],
      ...extra,
    });
  const create = async (kind = "risk_assessment", extra: object = {}) =>
    ok(
      await call("POST", "/hse/registers", {
        commandId: newId(),
        title: `${kind} ${newId()}`,
        kind,
        content: content(extra),
      }),
      201,
    );
  const get = async (id: string) => ok(await call("GET", `/hse/registers/${id}`));
  const action = async (row: any, operation: string) =>
    ok(
      await call("POST", `/hse/registers/${row.id}/${operation}`, {
        commandId: newId(),
        expectedRevision: row.revision,
        reason: `Reviewed ${operation}`,
      }),
    );
  const approved = async (kind = "risk_assessment", extra: object = {}) => {
    const r = await create(kind, extra);
    await action(r, "approve");
    return get(r.id);
  };
  const permit = async () => {
    const risk = await approved();
    const contractor = await approved("contractor", {
      supplierId: provider,
      competenceExpiresOn: addDays(today, 30),
    });
    const body = hsePermitBodySchema.parse({
      contractorRecordId: contractor.id,
      assessmentIds: [risk.id],
      assetId: asset,
      startsOn: today,
      endsOn: addDays(today, 1),
      workScope: "Replace mixer guard",
      precautions: "Lock off, verify zero energy and barrier the area",
      isolationRequired: true,
      isolationPoints: "Mixer isolator and pneumatic supply",
      inductionChecked: true,
      ppeChecked: true,
      emergencyReady: true,
    });
    return ok(await call("POST", "/hse/permits", { commandId: newId(), title: "Mixer work", body }), 201);
  };
  /** Signs a permit decision; issue/resume name the evidence versions shown on the permit now. */
  const permitAction = async (p: any, op: string, extra: object = {}) => {
    let reviewedEvidence: unknown;
    if (op === "issue" || op === "resume") {
      const shown = (await (await call("GET", `/hse/permits/${p.id}`)).json()) as any;
      reviewedEvidence = shown.currentEvidence
        ? {
            contractorVersionId: shown.currentEvidence.contractorVersionId ?? newId(),
            assessmentVersionIds: shown.currentEvidence.assessments.map((a: any) => a.versionId ?? newId()),
          }
        : undefined;
    }
    return call("POST", `/hse/permits/${p.id}/${op}`, {
      commandId: newId(),
      expectedRevision: p.revision,
      reason: `Signed ${op}`,
      ...(reviewedEvidence ? { reviewedEvidence } : {}),
      ...extra,
    });
  };
  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    actor = (await ok(await ctx.req("/v1/me", { cookie: ada }))).user.id;
    member = (await ok(await ctx.req("/v1/me", { cookie: marcus }))).user.id;
    token = (
      await ok(
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "HSE assistant", scope: "write" },
        }),
        201,
      )
    ).token;
    provider = (
      await ok(
        await call("POST", "/suppliers", {
          name: "Safe engineering services",
          code: "HSE-CONTRACTOR",
          category: "service",
          serviceType: "Engineering",
        }),
        201,
      )
    ).id;
    await ok(
      await call("POST", `/suppliers/${provider}/approval`, {
        status: "approved",
        note: "Competence and insurance checked",
      }),
    );
    const area = (
      await ok(await call("POST", "/haccp/assets", { name: "HSE mixing room", kind: "area" }), 201)
    ).id;
    asset = (
      await ok(await call("POST", "/site/maintenance/assets", { name: "HSE mixer", areaId: area }), 201)
    ).id;
  }, 60_000);
  afterAll(() => ctx.handle.close());
  it("requires opt-in access, leaves restricted incidents separately granted, and enforces read-only", async () => {
    await fail(await call("GET", "/hse/registers", undefined, marcus), 403);
    for (const m of moduleIds.filter((m) => m !== "hse_incidents"))
      await ok(await call("PUT", `/members/${member}/module-access/${m}`, { level: "read" }));
    await ok(await call("GET", "/hse/registers", undefined, marcus));
    await fail(
      await call(
        "POST",
        "/hse/registers",
        { commandId: newId(), title: "Read cannot write", kind: "risk_assessment", content: content() },
        marcus,
      ),
      403,
    );
    await fail(await call("GET", "/hse/incidents", undefined, marcus), 403);
  });
  it("retains approved evidence during review, rejects incomplete and stale approvals and serializes retries", async () => {
    const draft = await create();
    const cmd = newId();
    const input = { commandId: cmd, expectedRevision: draft.revision, reason: "Signed risk assessment" };
    const signed = await ok(await call("POST", `/hse/registers/${draft.id}/approve`, input));
    expect((await ok(await call("POST", `/hse/registers/${draft.id}/approve`, input))).revision).toBe(
      signed.revision,
    );
    await action(signed, "review");
    const reviewing = await get(draft.id);
    expect(reviewing.approved.content.controls).toContain("Guarding");
    expect(reviewing.draft.number).toBe(2);
    const request = {
      commandId: newId(),
      expectedRevision: reviewing.revision,
      content: content({ controls: "Additional guard verification" }),
      reason: "Change of equipment",
    };
    const attempts = await Promise.all([
      call("PUT", `/hse/registers/${draft.id}/draft`, request),
      call("PUT", `/hse/registers/${draft.id}/draft`, { ...request, commandId: newId() }),
    ]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 409]);
    const saved = await get(draft.id);
    await action(saved, "approve");
    const history = await ok(await call("GET", `/hse/registers/${draft.id}/history?limit=1&offset=1`));
    expect(history.total).toBe(2);
    expect(history.versions[0]).toMatchObject({
      status: "superseded",
      content: { controls: "Guarding, training and isolation" },
    });
    const incomplete = await create("coshh", { subject: "Detergent" });
    await fail(
      await call("POST", `/hse/registers/${incomplete.id}/approve`, {
        commandId: newId(),
        expectedRevision: 1,
        reason: "Not enough evidence",
      }),
      409,
      "hse_incomplete",
    );
  });
  it("keeps failures open until explicitly resolved and restores them when a pass is corrected", async () => {
    let r = await approved("inspection");
    expect(r.attention.state).toBe("overdue");
    const check = {
      commandId: newId(),
      expectedRevision: r.revision,
      performedOn: today,
      outcome: "fail",
      findings: "Guard interlock failed",
      actions: "Equipment isolated",
      evidenceReference: "Inspection report 1",
    };
    const failed = await ok(await call("POST", `/hse/registers/${r.id}/entries`, check), 201);
    r = await get(r.id);
    await ok(
      await call("POST", `/hse/registers/${r.id}/entries`, {
        ...check,
        commandId: newId(),
        expectedRevision: r.revision,
        outcome: "pass",
        findings: "Unrelated later pass",
      }),
      201,
    );
    r = await get(r.id);
    expect(r.attention.openFailures).toBe(1);
    const resolution = await ok(
      await call("POST", `/hse/registers/${r.id}/entries`, {
        ...check,
        commandId: newId(),
        expectedRevision: r.revision,
        outcome: "pass",
        findings: "Repaired and retested",
        resolvesEntryId: failed.id,
      }),
      201,
    );
    r = await get(r.id);
    expect(r.attention.openFailures).toBe(0);
    await ok(
      await call("POST", `/hse/registers/${r.id}/entries/${resolution.id}/void`, {
        commandId: newId(),
        expectedRevision: r.revision,
        reason: "Incorrect test instrument",
      }),
    );
    r = await get(r.id);
    expect(r.attention.openFailures).toBe(1);
    expect(
      (await ok(await call("GET", `/hse/registers/${r.id}/entries`))).entries.find(
        (e: any) => e.id === resolution.id,
      ).voidReason,
    ).toBe("Incorrect test instrument");
  });
  it("records resource and waste amounts in approved units, protects dates and never mutates stock", async () => {
    const utility = await approved("utility", { unit: "kWh", subject: "Electricity meter E-1" });
    await fail(
      await call("POST", `/hse/registers/${utility.id}/entries`, {
        commandId: newId(),
        expectedRevision: utility.revision,
        performedOn: today,
        outcome: "recorded",
        findings: "Period use",
        evidenceReference: "Meter record",
        quantity: 15,
      }),
      400,
    );
    const usage = await ok(
      await call("POST", `/hse/registers/${utility.id}/entries`, {
        commandId: newId(),
        expectedRevision: utility.revision,
        performedOn: today,
        periodFrom: addDays(today, -7),
        outcome: "recorded",
        findings: "Weekly electricity use",
        evidenceReference: "Meter log",
        quantity: 15.12345,
      }),
      201,
    );
    expect(usage).toMatchObject({ quantity: 15.1235, unit: "kWh" });
    const waste = await approved("waste", {
      unit: "kg",
      supplierId: provider,
      wasteCode: "20 01 08",
      authorisationReference: "Carrier approval checked against current register",
    });
    await ok(
      await call("POST", `/hse/registers/${waste.id}/entries`, {
        commandId: newId(),
        expectedRevision: waste.revision,
        performedOn: today,
        outcome: "recorded",
        findings: "Food waste collection",
        evidenceReference: "Transfer note WT-100",
        quantity: 50,
      }),
      201,
    );
    const r = await approved();
    await fail(
      await call("POST", `/hse/registers/${r.id}/entries`, {
        commandId: newId(),
        expectedRevision: r.revision,
        performedOn: addDays(today, 1),
        outcome: "pass",
        findings: "Future test",
        evidenceReference: "Invalid",
      }),
      400,
    );
  });
  it("issues, suspends and closes permits, blocking site clearance until signed return", async () => {
    const draft = await permit();
    const issued = await ok(await permitAction(draft, "issue"));
    expect(issued.evidenceSnapshot.contractor.content.supplierId).toBe(provider);
    await fail(await permitAction(draft, "issue"), 409);
    const suspended = await ok(await permitAction(issued, "suspend"));
    const task = (
      await ok(
        await call("POST", "/site/maintenance/tasks", {
          assetId: asset,
          title: "HSE isolation clearance check",
          frequency: { every: 1, unit: "month" },
          clearanceRequired: true,
        }),
        201,
      )
    ).id;
    const maintenance = await ok(
      await call("POST", "/site/maintenance/records", { taskId: task, workDone: "Guard replaced" }),
      201,
    );
    await fail(
      await call("POST", `/site/maintenance/records/${maintenance.id}/clearance`, {
        note: "Cannot bypass isolation",
      }),
      409,
      "asset_isolated",
    );
    await fail(await permitAction(suspended, "close"), 400);
    const close = {
      workComplete: true,
      toolsRemoved: true,
      protectionsRestored: true,
      isolationsRemovedSafely: true,
      safeToReturn: true,
    };
    const closed = await ok(await permitAction(suspended, "close", close));
    expect(closed.status).toBe("closed");
    await ok(
      await call("POST", `/site/maintenance/records/${maintenance.id}/clearance`, {
        note: "HSE return signed; separate hygiene checks complete",
      }),
    );
    const history = await ok(await call("GET", `/hse/permits/${draft.id}/history?limit=1&offset=1`));
    expect(history.total).toBe(4);
    expect(history.events[0].snapshot.status).toBe("suspended");
    const closure = await ok(await call("GET", `/hse/permits/${draft.id}/history?limit=1`));
    expect(closure.events[0].snapshot.decision).toMatchObject(close);
  });
  it("binds permit sign-off to the evidence versions the manager reviewed", async () => {
    const p = await permit();
    const shown = await ok(await call("GET", `/hse/permits/${p.id}`));
    const reviewedEvidence = {
      contractorVersionId: shown.currentEvidence.contractorVersionId,
      assessmentVersionIds: shown.currentEvidence.assessments.map((a: any) => a.versionId),
    };
    expect(shown.currentEvidence.assessments[0]).toMatchObject({ number: 1, title: expect.any(String) });
    // The contractor's provider is named in the evidence a manager reviews.
    const contractor = await get(p.body.contractorRecordId);
    expect(Object.values(contractor.references.suppliers)).toEqual([
      expect.stringContaining("Safe engineering services"),
    ]);
    // Signing must name what was reviewed.
    await fail(
      await call("POST", `/hse/permits/${p.id}/issue`, {
        commandId: newId(),
        expectedRevision: p.revision,
        reason: "Issue",
      }),
      400,
    );
    // The risk assessment gets a new approved version (different controls) after the review.
    const riskId = p.body.assessmentIds[0];
    await action(await get(riskId), "review");
    const reviewing = await get(riskId);
    await ok(
      await call("PUT", `/hse/registers/${riskId}/draft`, {
        commandId: newId(),
        expectedRevision: reviewing.revision,
        content: content({ controls: "Different controls nobody reviewed for this permit" }),
        reason: "Changed method",
      }),
    );
    await action(await get(riskId), "approve");
    // The permit itself is unchanged, but the original sign-off is refused.
    await fail(
      await call("POST", `/hse/permits/${p.id}/issue`, {
        commandId: newId(),
        expectedRevision: p.revision,
        reason: "Issue against v1",
        reviewedEvidence,
      }),
      409,
      "evidence_changed",
    );
    // Reviewing the current evidence (v2) allows it.
    const again = await ok(await call("GET", `/hse/permits/${p.id}`));
    expect(again.currentEvidence.assessments[0].number).toBe(2);
    const issued = await ok(await permitAction(p, "issue"));
    expect(issued.status).toBe("issued");
  });

  it("refuses stale assessments, suspended contractors and foreign permit links", async () => {
    const p = await permit();
    await ctx.handle.db
      .update(hseVersions)
      .set({ content: content({ reviewDueOn: addDays(today, -1) }) })
      .where(eq(hseVersions.recordId, p.body.assessmentIds[0]));
    await fail(await permitAction(p, "issue"), 409);
    const another = await permit();
    await ok(
      await call("POST", `/suppliers/${provider}/approval`, {
        status: "suspended",
        note: "Competence evidence under review",
      }),
    );
    await fail(await permitAction(another, "issue"), 409);
    await ok(
      await call("POST", `/suppliers/${provider}/approval`, {
        status: "approved",
        note: "Reinstated after review",
      }),
    );
    await fail(
      await call("POST", "/hse/permits", {
        commandId: newId(),
        title: "Missing asset",
        body: { ...another.body, assetId: newId() },
      }),
      404,
    );
  });
  it("requires the existing worker training sign-off and validity through the permit's end", async () => {
    const course = await ok(
      await call("POST", "/training/courses", {
        code: `HSE-${newId()}`,
        title: "Isolation competence",
        kind: "external",
        requiresSignOff: true,
        validityMonths: 12,
      }),
      201,
    );
    const person = await ok(
      await call("POST", "/people/staff", { firstName: "Contractor", lastName: "Worker", status: "active" }),
      201,
    );
    const risk = await approved();
    const contractor = await approved("contractor", {
      supplierId: provider,
      competenceExpiresOn: addDays(today, 20),
      courseIds: [course.id],
    });
    const draft = await ok(
      await call("POST", "/hse/permits", {
        commandId: newId(),
        title: "Competence controlled work",
        body: hsePermitBodySchema.parse({
          contractorRecordId: contractor.id,
          assessmentIds: [risk.id],
          assetId: asset,
          staffId: person.id,
          startsOn: today,
          endsOn: addDays(today, 1),
          workScope: "Isolation",
          precautions: "Verify zero energy",
          isolationRequired: true,
          isolationPoints: "Main isolator",
          inductionChecked: true,
          ppeChecked: true,
          emergencyReady: true,
        }),
      }),
      201,
    );
    await fail(await permitAction(draft, "issue"), 409, "competence_required");
    const training = await ok(
      await call("POST", "/training/records", {
        courseId: course.id,
        staffIds: [person.id],
        completedOn: today,
        outcome: "competent",
        trainerName: "Qualified trainer",
      }),
      201,
    );
    await fail(await permitAction(draft, "issue"), 409, "competence_required");
    await ok(await call("POST", "/training/records/sign-off", { recordIds: [training.records[0].id] }));
    const issued = await ok(await permitAction(draft, "issue"));
    expect(issued.evidenceSnapshot.competence.courses[0].code).toBe(course.code);
    expect(issued.evidenceSnapshot.competence.courses[0].recordId).toBe(training.records[0].id);
    const suspended = await ok(await permitAction(issued, "suspend"));
    await ok(
      await call("POST", `/training/records/${training.records[0].id}/void`, { reason: "Evidence revoked" }),
    );
    await fail(await permitAction(suspended, "resume"), 409, "competence_required");
    await ok(
      await permitAction(suspended, "close", {
        workComplete: true,
        toolsRemoved: true,
        protectionsRestored: true,
        isolationsRemovedSafely: true,
        safeToReturn: true,
      }),
    );
  });
  it("retains archive decisions, blocks failed risk checks and validates task references", async () => {
    const r = await approved();
    await action(r, "archive");
    const history = await ok(await call("GET", `/hse/registers/${r.id}/history`));
    expect(history.versions[0]).toMatchObject({
      status: "archived",
      reason: "Reviewed archive",
      approvedBy: actor,
    });
    const p = await permit();
    const risk = await get(p.body.assessmentIds[0]);
    await ok(
      await call("POST", `/hse/registers/${risk.id}/entries`, {
        commandId: newId(),
        expectedRevision: risk.revision,
        performedOn: today,
        outcome: "fail",
        findings: "Unsafe access",
        actions: "Isolate",
        evidenceReference: "Risk check",
      }),
      201,
    );
    await fail(await permitAction(p, "issue"), 409);
    await fail(
      await call("POST", "/hse/registers", {
        commandId: newId(),
        title: "Invalid task reference",
        kind: "risk_assessment",
        content: content({ actionTaskIds: [newId()] }),
      }),
      400,
    );
  });
  it("keeps accident health details and all incident metadata out of sync/search/bootstrap and tokens", async () => {
    const body = {
      kind: "accident",
      occurredOn: today,
      place: "Mixing hall",
      summary: "Private injury report",
      healthDetails: "Restricted health narrative",
      immediateActions: "First aid and safe containment",
      ownerUserId: actor,
    };
    let incident = await ok(await call("POST", "/hse/incidents", { commandId: newId(), body }), 201);
    await fail(await call("GET", `/hse/incidents/${incident.id}`, undefined, marcus), 403);
    await fail(
      await call("POST", `/hse/incidents/${incident.id}/close`, {
        commandId: newId(),
        expectedRevision: incident.revision,
        reason: "Incomplete",
      }),
      409,
    );
    const full = {
      ...incident.body,
      investigation: "Witness evidence reviewed",
      rootCause: "Unsafe access identified",
      correctiveActions: "Guard and competence action completed",
      effectiveness: "Independent recheck passed",
      reportingDecision: "not_required",
      reportingBasis: "Site lead assessed the applicable reporting criteria and recorded why not reportable",
    };
    incident = await ok(
      await call("PUT", `/hse/incidents/${incident.id}`, {
        commandId: newId(),
        expectedRevision: incident.revision,
        reason: "Investigation completed",
        body: full,
      }),
    );
    await ok(
      await call("POST", `/hse/incidents/${incident.id}/close`, {
        commandId: newId(),
        expectedRevision: incident.revision,
        reason: "Reviewed closure",
      }),
    );
    const history = await ok(await call("GET", `/hse/incidents/${incident.id}/history`));
    expect(history.total).toBe(3);
    expect(history.events[2].snapshot.body.healthDetails).toContain("Restricted");
    for (const path of ["/sync?after=0&limit=500", "/bootstrap", "/search?q=Private%20injury"]) {
      const response = await ok(await call("GET", path));
      expect(JSON.stringify(response)).not.toContain(incident.id);
      expect(JSON.stringify(response)).not.toContain("Restricted health narrative");
    }
    const headers = { authorization: `Bearer ${token}`, origin: "" };
    await fail(await ctx.req(`${WS}/hse/incidents/${incident.id}`, { headers }), 403, "token_not_allowed");
  });
  it("lets agents prepare ordinary drafts, never sign checks/permits or access restricted incidents", async () => {
    const via = (method: string, path: string, json?: unknown) =>
      ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
    const r = await ok(
      await via("POST", "/hse/registers", {
        commandId: newId(),
        title: "Agent preparation",
        kind: "risk_assessment",
        content: content(),
      }),
      201,
    );
    for (const suffix of ["approve", "archive", "entries"])
      await fail(await via("POST", `/hse/registers/${r.id}/${suffix}`, {}), 403, "token_not_allowed");
    await fail(await via("POST", "/hse/incidents", {}), 403, "token_not_allowed");
    const sync = await ok(await call("GET", "/sync?after=0&limit=500"));
    for (const c of sync.changes.filter((c: any) => c.entity.startsWith("hse_")))
      expect(Object.keys(c.data).every((k) => ["id", "revision"].includes(k))).toBe(true);
  });
  it("hides disabled HSE routes and enforces workspace isolation", async () => {
    const off = await makeApp({
      seed: true,
      activeModules: moduleIds.filter((m) => !["hse", "hse_incidents"].includes(m)),
    });
    const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
    await fail(await off.req(`${WS}/hse/registers`, { cookie }), 404, "module_inactive");
    // An expired permit left behind when HSE is switched off still holds the asset.
    const [offWorkspace] = await off.handle.db.select().from(workspaces).where(eq(workspaces.slug, "acme"));
    const offArea = await ok(
      await off.req(`${WS}/haccp/assets`, {
        method: "POST",
        cookie,
        json: { name: "Isolated mixer area", kind: "area" },
      }),
      201,
    );
    const [offAsset] = await off.handle.db
      .insert(siteAssets)
      .values({ workspaceId: offWorkspace!.id, name: "Isolated mixer", areaId: offArea.id })
      .returning();
    await off.handle.db.insert(hsePermits).values({
      workspaceId: offWorkspace!.id,
      title: "Expired isolation",
      assetId: offAsset!.id,
      isolationRequired: true,
      status: "issued",
      body: hsePermitBodySchema.parse({
        contractorRecordId: newId(),
        assessmentIds: [newId()],
        inductionChecked: true,
        ppeChecked: true,
        emergencyReady: true,
        assetId: offAsset!.id,
        startsOn: addDays(today, -3),
        endsOn: addDays(today, -1),
        workScope: "Repair",
        precautions: "Lock off",
        isolationRequired: true,
        isolationPoints: "Main isolator",
      }),
    });
    const offCall = (path: string, json: unknown) =>
      off.req(`${WS}${path}`, { method: "POST", cookie, json });
    const task = await ok(
      await offCall("/site/maintenance/tasks", {
        assetId: offAsset!.id,
        title: "Hygiene checks",
        frequency: { every: 1, unit: "month" },
        clearanceRequired: true,
      }),
      201,
    );
    const record = await ok(
      await offCall("/site/maintenance/records", { taskId: task.id, workDone: "Guard repaired" }),
      201,
    );
    await fail(
      await offCall(`/site/maintenance/records/${record.id}/clearance`, {
        note: "Expired HSE module cannot remove the safety hold",
      }),
      409,
      "asset_isolated",
    );
    await off.handle.close();
    const [w] = await ctx.handle.db
      .insert(workspaces)
      .values({ slug: `hse-foreign-${newId()}`, name: "Other site" })
      .returning();
    const [r] = await ctx.handle.db
      .insert(hseRecords)
      .values({ workspaceId: w!.id, title: "Foreign risk", kind: "risk_assessment" })
      .returning();
    await fail(await call("GET", `/hse/registers/${r!.id}`), 404);
    await fail(
      await call("POST", "/hse/registers", {
        commandId: newId(),
        title: "Foreign owner",
        kind: "risk_assessment",
        content: content({ ownerUserId: newId() }),
      }),
      400,
    );
  }, 60_000);
});
