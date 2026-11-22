import {
  addDays,
  newId,
  todayInZone,
  DEFAULT_TIME_ZONE,
  authenticityFactors,
  authenticityDraftSchema,
  type AuthenticityDraft,
} from "@knotworking/core";
import {
  authenticityAssessments,
  authenticityVersions,
  authenticityVerifications,
  testingSamples,
  workspaces,
  stockMovements,
  items,
} from "@knotworking/db";
import { eq, count } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { makeApp, signIn, type TestCtx, type Res } from "./test-utils";
const WS = "/v1/workspaces/acme",
  base = "/quality/authenticity",
  today = todayInZone(DEFAULT_TIME_ZONE);
describe("food authenticity assessments", () => {
  let ctx: TestCtx,
    cookie: string,
    marcus: string,
    owner: string,
    memberId: string,
    token: string,
    supplier: string,
    wsId: string;
  let seq = 0;
  const call = (method: string, path: string, json?: unknown, c = cookie) =>
    ctx.req(WS + path, { method, cookie: c, json });
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
  const item = async () =>
    (
      await ok(
        await call("POST", "/items", {
          code: `AUTH-${++seq}`,
          name: `Authenticity material ${seq}`,
          type: "ingredient",
          unit: "kg",
        }),
        201,
      )
    ).id as string;
  const body = (extra: Partial<AuthenticityDraft> = {}) =>
    authenticityDraftSchema.parse({
      ownerUserId: owner,
      scope: "Fraud opportunities for the material and supplier",
      origin: "United Kingdom; mill origin statement",
      supplyChain: "Grower → mill → site, sealed deliveries",
      factors: authenticityFactors.map((factor) => ({
        factor,
        level: "medium",
        rationale: "Commodity-specific evidence and existing supply controls reviewed",
      })),
      vulnerability: "medium",
      rationale:
        "Known economic substitution incentive; supplier traceability and verification reduce exposure",
      sources: [
        {
          title: "Industry fraud intelligence",
          reference: "INT-PRIVATE-2026",
          checkedOn: today,
          findings: "Commodity alerts reviewed; retain targeted authenticity checks",
        },
      ],
      evidence: [
        {
          kind: "provenance",
          title: "Origin statement",
          reference: "PROV-PRIVATE-2026",
          validUntil: addDays(today, 365),
        },
      ],
      controls: [
        {
          id: newId(),
          kind: "provenance",
          description: "Verify supplier chain-of-custody statement",
          ownerUserId: owner,
          dueOn: today,
          frequencyDays: 30,
          acceptanceCriteria: "Named origin and supplier route match the agreed specification",
        },
      ],
      reviewDueOn: addDays(today, 365),
      ...extra,
    });
  const create = async (draft = body(), itemId?: string) =>
    ok(
      await call("POST", base, {
        commandId: newId(),
        title: `Material authenticity ${++seq}`,
        itemId: itemId ?? (await item()),
        supplierId: supplier,
        draft,
      }),
      201,
    );
  const approve = (d: any, extra = {}) =>
    call("POST", `${base}/${d.id}/approve`, {
      commandId: newId(),
      expectedUpdatedAt: d.updatedAt,
      note: "Technical manager reviewed vulnerability, source evidence and the control plan",
      triggerIds: d.triggers.filter((t: any) => !t.resolvedByVersionId).map((t: any) => t.id),
      ...extra,
    });
  const verified = (d: any, outcome = "pass", extra = {}, c = cookie) =>
    call(
      "POST",
      `${base}/${d.id}/versions/${d.currentVersionId}/controls/${d.controls[0].id}/verify`,
      {
        commandId: newId(),
        verifiedOn: today,
        outcome,
        evidenceReference: "CONTROL-REPORT-2026",
        evidenceValidUntil: addDays(today, 90),
        note: "Compared the evidence against the recorded criteria",
        ...extra,
      },
      c,
    );
  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    owner = (await ok(await ctx.req("/v1/me", { cookie }))).user.id;
    memberId = (await ok(await ctx.req("/v1/me", { cookie: marcus }))).user.id;
    wsId = (await ok(await call("GET", "/bootstrap"))).workspace.id;
    supplier = (await ok(await call("POST", "/suppliers", { name: "Authenticity supplier" }), 201)).id;
    token = (
      await ok(
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie,
          json: { name: "Authenticity integration", scope: "write" },
        }),
        201,
      )
    ).token;
  }, 120000);
  afterAll(() => ctx.handle.close());
  it("allows incomplete drafts, blocks incomplete approval and makes retry-safe edits", async () => {
    let d = await create(authenticityDraftSchema.parse({}));
    expect(d.currentVersionId).toBeNull();
    expect(d.approvalBlockers.length).toBeGreaterThan(5);
    await fail(await approve(d), 409, "assessment_incomplete");
    const save = { commandId: newId(), expectedUpdatedAt: d.updatedAt, draft: body() };
    d = await ok(await call("PUT", `${base}/${d.id}/draft`, save));
    expect((await ok(await call("PUT", `${base}/${d.id}/draft`, save))).updatedAt).toBe(d.updatedAt);
    d = await ok(await approve(d));
    expect(d.currentVersionId).toBeTruthy();
    expect(d.controls[0].state).toBe("due");
    expect(d.verifications).toHaveLength(0);
    await fail(
      await call("PUT", `${base}/${d.id}/draft`, {
        commandId: newId(),
        expectedUpdatedAt: d.updatedAt,
        draft: body(),
      }),
      409,
      "no_draft",
    );
  });
  it("preserves signed content, people, subject snapshots and verification history when reviewed", async () => {
    let d = await ok(await approve(await create()));
    d = await ok(await verified(d), 201);
    const previous = d.versions[0];
    await ok(await call("PATCH", `/items/${d.itemId}`, { name: "Changed master description" }));
    const start = { commandId: newId(), expectedUpdatedAt: d.updatedAt };
    let review = await ok(await call("POST", `${base}/${d.id}/draft`, start), 201);
    expect((await ok(await call("POST", `${base}/${d.id}/draft`, start), 201)).versions).toHaveLength(2);
    expect(review.currentVersionId).toBe(previous.id);
    expect(review.controls[0].state).toBe("verified");
    const draft = review.versions.find((v: any) => v.status === "draft");
    review = await ok(
      await call("PUT", `${base}/${d.id}/draft`, {
        commandId: newId(),
        expectedUpdatedAt: review.updatedAt,
        draft: {
          ...draft.body,
          vulnerability: "high",
          rationale: "New intelligence increases substitution vulnerability",
        },
      }),
    );
    review = await ok(await approve(review));
    const old = review.versions.find((v: any) => v.id === previous.id);
    expect(old.body).toEqual(previous.body);
    expect(old.approvedBy).toBe(owner);
    expect(old.approvedAt).toBe(previous.approvedAt);
    expect(old.subject).toEqual(previous.subject);
    expect(old.status).toBe("superseded");
    expect(review.versions[0].subject.itemName).toBe("Changed master description");
    expect(review.controls[0].state).toBe("due");
    expect(review.verifications).toHaveLength(1);
  });
  it("guards stale edits and requires explicit review of every current trigger", async () => {
    let d = await ok(await approve(await create()));
    d = await ok(
      await call("POST", `${base}/${d.id}/draft`, { commandId: newId(), expectedUpdatedAt: d.updatedAt }),
      201,
    );
    const before = d;
    d = await ok(
      await call("POST", `${base}/${d.id}/triggers`, {
        commandId: newId(),
        kind: "price_alert",
        note: "Material price sharply below market",
        reference: "MARKET-ALERT-PRIVATE",
      }),
      201,
    );
    await fail(
      await call("PUT", `${base}/${d.id}/draft`, {
        commandId: newId(),
        expectedUpdatedAt: before.updatedAt,
        draft: body(),
      }),
      409,
      "assessment_changed",
    );
    await fail(await approve(before), 409, "assessment_changed");
    await fail(await approve(d, { triggerIds: [] }), 409, "triggers_changed");
    const resolved = await ok(await approve(d));
    expect(resolved.triggers[0].resolvedByVersionId).toBe(resolved.currentVersionId);
  });
  it("records failed controls once, flags review and retains the trigger after a later passing check", async () => {
    let d = await ok(await approve(await create()));
    const command = { commandId: newId() };
    d = await ok(
      await verified(d, "fail", { ...command, note: "Origin declaration does not match agreed route" }),
      201,
    );
    expect(d.failedControls).toBe(1);
    expect(d.openTriggers).toBe(1);
    expect(d.needsReview).toBe(true);
    expect(
      (
        await ok(
          await verified(d, "fail", { ...command, note: "Origin declaration does not match agreed route" }),
          201,
        )
      ).triggers,
    ).toHaveLength(1);
    d = await ok(await verified(d), 201);
    expect(d.controls[0].state).toBe("verified");
    expect(d.openTriggers).toBe(1);
    expect(d.needsReview).toBe(true);
    await fail(await verified(d, "pass", { verifiedOn: addDays(today, 1) }), 400, "invalid_input");
  });
  it("shows overdue and expired controls using business dates, with chronological evidence precedence", async () => {
    let d = await ok(
      await approve(
        await create(
          body({
            controls: [
              {
                id: newId(),
                kind: "testing",
                description: "Authenticity testing",
                ownerUserId: owner,
                dueOn: addDays(today, -2),
                frequencyDays: 3,
                acceptanceCriteria: "Species agrees with declared composition",
              },
            ],
          }),
        ),
      ),
    );
    expect(d.overdueControls).toBe(1);
    expect((await ok(await call("GET", `${base}?state=overdue_controls&q=${d.reference}`))).total).toBe(1);
    await ctx.handle.db
      .update(authenticityVersions)
      .set({ approvedAt: new Date(`${addDays(today, -10)}T00:00:00Z`) })
      .where(eq(authenticityVersions.id, d.currentVersionId));
    d = await ok(
      await verified(d, "pass", { verifiedOn: addDays(today, -5), evidenceValidUntil: addDays(today, -1) }),
      201,
    );
    expect(d.controls[0].state).toBe("expired");
    d = await ok(await verified(d, "fail", { verifiedOn: addDays(today, -1) }), 201);
    d = await ok(await verified(d, "pass", { verifiedOn: addDays(today, -3) }), 201);
    expect(d.controls[0].state).toBe("failed");
    expect(d.overdueControls).toBe(1);
    expect((await ok(await call("GET", `${base}?q=${d.reference}&state=overdue_controls`))).total).toBe(1);
  });
  it("keeps correction reasons and actor/time, without deleting evidence or changing stock", async () => {
    let d = await ok(await approve(await create()));
    d = await ok(await verified(d), 201);
    const v = d.verifications[0];
    const [before] = await ctx.handle.db.select({ n: count() }).from(stockMovements);
    const command = { commandId: newId(), reason: "Wrong report reference; original entry retained" };
    d = await ok(await call("POST", `${base}/${d.id}/verifications/${v.id}/void`, command));
    expect(d.verifications[0]).toMatchObject({ id: v.id, voidedBy: owner, voidReason: command.reason });
    expect(d.verifications[0].voidedAt).toBeTruthy();
    expect(d.controls[0].state).toBe("due");
    expect(d.openTriggers).toBe(1);
    expect(
      (await ok(await call("POST", `${base}/${d.id}/verifications/${v.id}/void`, command))).verifications[0]
        .voidedAt,
    ).toBe(d.verifications[0].voidedAt);
    const [after] = await ctx.handle.db.select({ n: count() }).from(stockMovements);
    expect(after?.n).toBe(before?.n);
  });
  it("restricts attestations to people, approval/corrections to managers and verification to its owner", async () => {
    for (const module of ["items", "stock"])
      await ok(await call("PUT", `/members/${memberId}/module-access/${module}`, { level: "read" }));
    await ok(await call("PUT", `/members/${memberId}/module-access/quality`, { level: "write" }));
    let d = await create();
    await fail(
      await call(
        "POST",
        `${base}/${d.id}/approve`,
        { commandId: newId(), expectedUpdatedAt: d.updatedAt, note: "Not a manager", triggerIds: [] },
        marcus,
      ),
      403,
      "module_forbidden",
    );
    d = await ok(await approve(d));
    await fail(await verified(d, "pass", {}, marcus), 403, "control_owner_required");
    for (const suffix of [
      "approve",
      `versions/${d.currentVersionId}/controls/${d.controls[0].id}/verify`,
      `verifications/${newId()}/void`,
      "archive",
    ]) {
      await fail(
        await ctx.req(`${WS}${base}/${d.id}/${suffix}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          json: {},
        }),
        403,
        "token_not_allowed",
      );
    }
    const b = body({ controls: [{ ...body().controls[0]!, ownerUserId: memberId }] });
    const owned = await ok(await approve(await create(b)));
    await ok(await verified(owned, "pass", {}, marcus), 201);
  });
  it("validates linked tests by workspace/item and leaves results behind Testing's own access checks", async () => {
    const material = await item();
    const [sample] = await ctx.handle.db
      .insert(testingSamples)
      .values({
        workspaceId: wsId,
        reference: `AUTH-SAMPLE-${++seq}`,
        subject: "lot",
        itemId: material,
        sampledOn: today,
        notes: "PRIVATE-LAB-DETAILS",
      })
      .returning();
    const linked = body({
      evidence: [
        {
          kind: "testing",
          title: "Authenticity report",
          reference: "External report reference",
          sampleId: sample!.id,
          note: "Assess with source records",
          validUntil: null,
        },
      ],
    });
    const d = await create(linked, material);
    expect(JSON.stringify(d)).not.toContain("PRIVATE-LAB-DETAILS");
    const other = await create();
    await fail(
      await call("PUT", `${base}/${other.id}/draft`, {
        commandId: newId(),
        expectedUpdatedAt: other.updatedAt,
        draft: linked,
      }),
      400,
      "invalid_input",
    );
    await fail(
      await call(
        "PUT",
        `${base}/${d.id}/draft`,
        { commandId: newId(), expectedUpdatedAt: d.updatedAt, draft: linked },
        marcus,
      ),
      403,
      "module_forbidden",
    );
    await fail(
      await call("GET", `/testing/samples/${sample!.id}`, undefined, marcus),
      403,
      "module_forbidden",
    );
  });
  it("rejects foreign subjects/owners/evidence and foreign assessment ids", async () => {
    const [foreign] = await ctx.handle.db
      .insert(workspaces)
      .values({ slug: "auth-private", name: "Private workspace" })
      .returning();
    const [row] = await ctx.handle.db
      .insert(authenticityAssessments)
      .values({
        workspaceId: foreign!.id,
        reference: "PRIVATE",
        title: "Private assessment",
        itemId: await item(),
      })
      .returning();
    await fail(await call("GET", `${base}/${row!.id}`), 404, "not_found");
    const b = body({ ownerUserId: newId() });
    await fail(
      await call("POST", base, {
        commandId: newId(),
        title: "Invalid owner",
        itemId: await item(),
        draft: b,
      }),
      400,
      "invalid_input",
    );
    await fail(
      await call("POST", base, {
        commandId: newId(),
        title: "Unknown supplier",
        itemId: await item(),
        supplierId: newId(),
        draft: body(),
      }),
      400,
      "invalid_input",
    );
    const other = await create();
    await fail(
      await call("PUT", `${base}/${other.id}/draft`, {
        commandId: newId(),
        expectedUpdatedAt: other.updatedAt,
        draft: body({
          evidence: [
            {
              kind: "testing",
              title: "Unknown test",
              reference: "No source",
              sampleId: newId(),
              validUntil: null,
              note: "",
            },
          ],
        }),
      }),
      400,
      "invalid_input",
    );
  });
  it("archives with retained history, permits a new active scope and prevents duplicate/concurrent approvals", async () => {
    const original = await create();
    const duplicate = {
      commandId: newId(),
      title: "Duplicate",
      itemId: original.itemId,
      supplierId: supplier,
      draft: body(),
    };
    await fail(await call("POST", base, duplicate), 409, "assessment_exists");
    const results = await Promise.all([approve(original), approve(original)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    let d = await ok(await call("GET", `${base}/${original.id}`));
    d = await ok(
      await call("POST", `${base}/${d.id}/archive`, {
        commandId: newId(),
        expectedUpdatedAt: d.updatedAt,
        reason: "Supplier route discontinued",
      }),
    );
    expect(d.status).toBe("archived");
    expect(d.versions[0].approvedBy).toBe(owner);
    await fail(
      await call("POST", `${base}/${d.id}/draft`, { commandId: newId(), expectedUpdatedAt: d.updatedAt }),
      409,
      "assessment_archived",
    );
    expect((await create(body(), d.itemId)).status).toBe("active");
    expect((await ok(await call("GET", `${base}?state=archived&q=${d.reference}`))).total).toBe(1);
  });
  it("calculates review/control status in the workspace business date", async () => {
    const d = await ok(await approve(await create()));
    const zone = ["Pacific/Pago_Pago", "Pacific/Kiritimati"].find((z) => todayInZone(z) !== today)!;
    const localToday = todayInZone(zone);
    try {
      await ok(await call("PATCH", "/settings", { timeZone: zone }));
      const local = await ok(await call("GET", `${base}/${d.id}`));
      expect(local.today).toBe(localToday);
      expect(local.controls[0].state).toBe(localToday < today ? "pending" : "overdue");
      const list = await ok(await call("GET", `${base}?q=${d.reference}`));
      expect(list.today).toBe(localToday);
      expect(list.assessments[0].overdueControls).toBe(localToday > today ? 1 : 0);
    } finally {
      await ok(await call("PATCH", "/settings", { timeZone: DEFAULT_TIME_ZONE }));
    }
  });
  it("pages/searches the register and keeps all narratives and evidence out of shared sync", async () => {
    const d = await create();
    const found = await ok(await call("GET", `${base}?state=all&q=${d.reference}&limit=1`));
    expect(found.total).toBe(1);
    expect(found.assessments[0].id).toBe(d.id);
    expect(
      (await ok(await call("GET", `${base}?itemId=${d.itemId}`))).assessments.some((a: any) => a.id === d.id),
    ).toBe(true);
    expect((await ok(await call("GET", `${base}?state=all&q=${d.reference}&offset=1`))).assessments).toEqual(
      [],
    );
    const sync = await ok(await call("GET", "/sync?after=0&limit=1000"));
    expect(sync.changes.some((c: any) => c.entity === "quality_authenticity")).toBe(true);
    expect(JSON.stringify(sync)).not.toContain("INT-PRIVATE");
    expect(JSON.stringify(sync)).not.toContain("PROV-PRIVATE");
    await ok(await call("PUT", `/members/${memberId}/module-access/quality`, { level: "none" }));
    await fail(await call("GET", base, undefined, marcus), 403, "module_forbidden");
    const restricted = await ok(await call("GET", "/sync?after=0&limit=1000", undefined, marcus));
    expect(restricted.changes.some((c: any) => c.entity === "quality_authenticity")).toBe(false);
  });
  it("refuses over-limit calculated registers without a truncated all-clear and supports a narrower search", async () => {
    const materials = Array.from({ length: 2001 }, (_, i) => ({
      id: newId(),
      workspaceId: wsId,
      code: `CAP-MATERIAL-${String(i).padStart(4, "0")}`,
      name: `Coverage boundary material ${i}`,
      type: "ingredient" as const,
      unit: "kg" as const,
    }));
    const scopes = materials.map((item, i) => ({
      id: newId(),
      workspaceId: wsId,
      reference: `CAP-AUTH-${i}`,
      title: `Cap boundary ${i}`,
      itemId: item.id,
      draftVersionId: newId(),
    }));
    await ctx.handle.db.insert(items).values(materials);
    await ctx.handle.db.insert(authenticityAssessments).values(scopes);
    await ctx.handle.db.insert(authenticityVersions).values(
      scopes.map((s, i) => ({
        id: s.draftVersionId,
        workspaceId: wsId,
        assessmentId: s.id,
        number: 1,
        status: "draft" as const,
        body: authenticityDraftSchema.parse({}),
        subject: {
          itemCode: materials[i]!.code,
          itemName: materials[i]!.name,
          supplierCode: null,
          supplierName: null,
        },
      })),
    );
    await fail(await call("GET", base), 413, "authenticity_register_limit");
    const narrowed = await ok(await call("GET", `${base}?q=CAP-MATERIAL-0001`));
    expect(narrowed.total).toBe(1);
    expect(narrowed.assessments[0].needsReview).toBe(true);
  }, 60000);
});
