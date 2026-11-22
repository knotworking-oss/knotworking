import { prepareDespatch } from "./despatch-test-helpers";
import { newId, todayInZone, DEFAULT_TIME_ZONE } from "@knotworking/core";
import { qualityIncidentSnapshots, workspaces, qualityIncidents, syncChanges } from "@knotworking/db";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx, type Res } from "./test-utils";
const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
describe("live incident containment and evidence", () => {
  let ctx: TestCtx,
    cookie: string,
    member: string,
    owner: string,
    memberId: string,
    token: string,
    lot: string,
    store: string,
    customer: string,
    shipped: any,
    caseId: string,
    otherCase: string;
  let n = 0;
  const call = (method: string, path: string, json?: unknown, c = cookie) =>
    ctx.req(WS + path, { method, cookie: c, json });
  const ok = async (r: Res, status = 200) => {
    const b = await r.json();
    expect(r.status, JSON.stringify(b)).toBe(status);
    return b;
  };
  const create = async () =>
    ok(
      await call("POST", "/quality/incidents", {
        commandId: newId(),
        title: `Recall ${++n}`,
        kind: "recall",
        severity: "critical",
        ownerUserId: owner,
        assessment: "Possible undeclared allergen; assess all distribution",
      }),
      201,
    );
  const scope = (id = caseId, root = lot, extra = {}) =>
    call("POST", `/quality/incidents/${id}/contain`, {
      commandId: newId(),
      lotId: root,
      note: "Contain recorded affected stock",
      ...extra,
    });
  const event = (kind: string, extra = {}) =>
    call("POST", `/quality/incidents/${caseId}/events`, {
      commandId: newId(),
      kind,
      note: "Evidence recorded",
      ...extra,
    });
  const release = (id = caseId, root = lot) =>
    call("POST", `/quality/incidents/${id}/release`, {
      commandId: newId(),
      lotId: root,
      note: "Reviewed disposition; retain QA quarantine",
    });
  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    member = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    owner = (await ok(await ctx.req("/v1/me", { cookie }))).user.id;
    memberId = (await ok(await ctx.req("/v1/me", { cookie: member }))).user.id;
    token = (
      await ok(
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie,
          json: { name: "Case reader", scope: "write" },
        }),
        201,
      )
    ).token;
    store = (await ok(await call("POST", "/stock/locations", { name: "Incident store" }), 201)).id;
    const item = (
      await ok(
        await call("POST", "/items", {
          code: "INC-FG",
          name: "Incident finished goods",
          type: "finished",
          unit: "kg",
        }),
        201,
      )
    ).id;
    lot = (
      await ok(
        await call("POST", "/stock/receipts", {
          itemId: item,
          locationId: store,
          quantity: 10,
          unit: "kg",
          receivedOn: today,
          lotCode: "INC-LOT",
          reason: "Opening",
        }),
        201,
      )
    ).id;
    customer = (
      await ok(
        await call("POST", "/customers", {
          code: "INC-C",
          name: "Original recipient",
          address: "Original address",
          email: "old@example.test",
        }),
        201,
      )
    ).id;
    const draft = await ok(
      await call("POST", "/despatch", {
        customerId: customer,
        despatchedOn: today,
        lines: [{ lotId: lot, locationId: store, quantity: 3, unit: "kg" }],
      }),
      201,
    );
    const prepared = await prepareDespatch(call, draft.id, draft.updatedAt);
    if (prepared.error) await ok(prepared.error);
    shipped = await ok(
      await call("POST", `/despatch/${draft.id}/confirm`, {
        commandId: newId(),
        expectedUpdatedAt: prepared.stamp,
      }),
    );
    caseId = (await create()).id;
    otherCase = (await create()).id;
  }, 60000);
  afterAll(() => ctx.handle.close());
  it("requires distribution and production access in addition to Quality; all attestations refuse tokens", async () => {
    for (const m of ["quality", "items", "stock"])
      await ok(await call("PUT", `/members/${memberId}/module-access/${m}`, { level: "manage" }));
    expect((await call("GET", "/quality/incidents", undefined, member)).status).toBe(403);
    for (const m of ["despatch", "customers", "recipes", "demand"])
      await ok(await call("PUT", `/members/${memberId}/module-access/${m}`, { level: "read" }));
    expect((await call("GET", `/quality/incidents/${caseId}`, undefined, member)).status).toBe(403);
    await ok(await call("PUT", `/members/${memberId}/module-access/production`, { level: "read" }));
    await ok(await call("GET", `/quality/incidents/${caseId}`, undefined, member));
    for (const action of ["contain", "events", "release", "close"]) {
      const r = await ctx.req(`${WS}/quality/incidents/${caseId}/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        json: {},
      });
      expect(r.status).toBe(403);
      expect((await r.json()).error.code).toBe("token_not_allowed");
    }
  });
  it("atomically snapshots historical recipients, holds stock and safely replays containment", async () => {
    const command = { commandId: newId(), lotId: lot, note: "All recorded affected stock" };
    const first = await ok(await call("POST", `/quality/incidents/${caseId}/contain`, command));
    expect(first.holds).toHaveLength(1);
    expect(first.snapshots[0].report.deliveries.lines[0].email).toBe("old@example.test");
    await ok(
      await call("PATCH", `/customers/${customer}`, {
        address: "Changed address",
        email: "changed@example.test",
      }),
    );
    const replay = await ok(await call("POST", `/quality/incidents/${caseId}/contain`, command));
    expect(replay.snapshots).toHaveLength(1);
    expect((await ok(await call("GET", `/stock/lots/${lot}`))).status).toBe("quarantine");
    expect(
      (await call("POST", `/stock/lots/${lot}/status`, { status: "available", note: "Bypass" })).status,
    ).toBe(409);
    const [ws] = await ctx.handle.db.select().from(workspaces).where(eq(workspaces.slug, "acme"));
    const logs = await ctx.handle.db
      .select()
      .from(syncChanges)
      .where(and(eq(syncChanges.workspaceId, ws!.id), eq(syncChanges.entity, "quality_incident")));
    expect(JSON.stringify(logs.map((l) => l.data))).not.toContain("old@example.test");
    expect(JSON.stringify(logs.map((l) => l.data))).not.toContain("Original address");
  });
  it("preserves snapshots after corrected deliveries and cannot release another case's hold", async () => {
    await ok(await scope(otherCase));
    await ok(await release());
    expect(
      (
        await call("POST", `/stock/lots/${lot}/status`, {
          status: "available",
          note: "Still another incident",
        })
      ).status,
    ).toBe(409);
    await ok(
      await call("POST", `/despatch/${shipped.id}/void`, {
        commandId: newId(),
        reason: "Wrong delivery record",
      }),
    );
    const c = await ok(await call("GET", `/quality/incidents/${caseId}`));
    expect(c.snapshots[0].report.deliveries.lines).toHaveLength(1);
    await ok(await release(otherCase));
    expect((await ok(await call("GET", `/stock/lots/${lot}`))).status).toBe("quarantine");
    await ok(await scope());
  });
  it("validates contact deadlines, recovery bounds and append-only corrections", async () => {
    expect(
      (
        await event("contact", {
          party: "regulator",
          contact: "Local authority",
          contactStatus: "planned",
          dueAt: new Date().toISOString(),
        })
      ).status,
    ).toBe(400);
    const contact = await ok(
      await event("contact", {
        party: "regulator",
        contact: "Local authority",
        contactStatus: "planned",
        dueAt: new Date().toISOString(),
        requirementSource: "Site incident procedure; checked current applicability",
      }),
      201,
    );
    const contactId = contact.events.at(-1).id;
    const r = await ok(
      await event("recovery", {
        deliveryLineId: shipped.lines[0].id,
        disposition: "destroyed_offsite",
        quantity: 2,
      }),
      201,
    );
    expect(
      (
        await event("recovery", {
          deliveryLineId: shipped.lines[0].id,
          disposition: "recovered_offsite",
          quantity: 2,
        })
      ).status,
    ).toBe(400);
    const previous = r.events.at(-1).id;
    await ok(await event("correction", { correctsEventId: previous, note: "Quantity was one kg" }), 201);
    await ok(
      await event("recovery", {
        deliveryLineId: shipped.lines[0].id,
        disposition: "destroyed_offsite",
        quantity: 1,
      }),
      201,
    );
    expect((await event("correction", { correctsEventId: previous })).status).toBe(400);
    await ok(
      await event("correction", {
        correctsEventId: contactId,
        note: "Contact completed; replacement follows",
      }),
      201,
    );
    await ok(
      await event("contact", {
        party: "regulator",
        contact: "Local authority",
        contactStatus: "completed",
        note: "Discussed incident and agreed action",
      }),
      201,
    );
  });
  it("requires signed closure evidence, released holds and verified CAPA or rationale", async () => {
    const closure = {
      commandId: newId(),
      note: "Manager closure",
      coverageReview: "Reviewed distribution and all applicable contacts",
      reconciliation: "1 kg destroyed offsite; balance held pending separate QA disposition",
      noCapaReason: "Linked existing preventive controls reviewed; documented rationale",
    };
    expect((await call("POST", `/quality/incidents/${caseId}/close`, closure)).status).toBe(409);
    await ok(await event("decision", { note: "Withdraw all affected product; contacts reviewed" }), 201);
    await ok(await event("effectiveness", { note: "All recorded recipients confirmed segregation" }), 201);
    await ok(await release());
    const closed = await ok(await call("POST", `/quality/incidents/${caseId}/close`, closure));
    expect(closed.closedBy).toBe(owner);
    expect(closed.status).toBe("closed");
    expect((await event("decision")).status).toBe(409);
    const replay = await ok(await call("POST", `/quality/incidents/${caseId}/close`, closure));
    expect(replay.closedAt).toBe(closed.closedAt);
  });
  it("rejects foreign cases and owner identities", async () => {
    const foreign = newId();
    await ctx.handle.db.insert(workspaces).values({ id: foreign, slug: "incident-other", name: "Other" });
    const [c] = await ctx.handle.db
      .insert(qualityIncidents)
      .values({
        workspaceId: foreign,
        reference: "OTHER",
        title: "Private",
        kind: "incident",
        severity: "minor",
        ownerUserId: owner,
        assessment: "Private",
      })
      .returning();
    expect((await call("GET", `/quality/incidents/${c!.id}`)).status).toBe(404);
    expect(
      (
        await call("POST", "/quality/incidents", {
          commandId: newId(),
          title: "Invalid",
          kind: "incident",
          severity: "minor",
          ownerUserId: newId(),
          assessment: "Test",
        })
      ).status,
    ).toBe(400);
    const records = await ctx.handle.db.select().from(qualityIncidentSnapshots);
    expect(records.every((s) => s.workspaceId !== foreign)).toBe(true);
  });
  it("acknowledges incomplete genealogy and inherits holds on late output", async () => {
    const raw = (
      await ok(
        await call("POST", "/items", { code: "INC-RAW", name: "Raw", type: "ingredient", unit: "kg" }),
        201,
      )
    ).id;
    const product = (
      await ok(
        await call("POST", "/items", {
          code: "INC-NEW",
          name: "Late output",
          type: "finished",
          unit: "each",
        }),
        201,
      )
    ).id;
    const root = (
      await ok(
        await call("POST", "/stock/receipts", {
          itemId: raw,
          locationId: store,
          quantity: 4,
          unit: "kg",
          receivedOn: today,
          lotCode: "INC-RAW-LOT",
        }),
        201,
      )
    ).id;
    const recipe = await ok(
      await call("POST", "/recipes", {
        code: "INC-RECIPE",
        name: "Incident recipe",
        outputItemId: product,
        draft: { yieldQuantity: 4, yieldUnit: "each", lines: [{ itemId: raw, quantity: 2, unit: "kg" }] },
      }),
      201,
    );
    await ok(await call("POST", `/recipes/${recipe.id}/draft/approve`, {}));
    const b = await ok(
      await call("POST", "/production/batches", {
        recipeId: recipe.id,
        plannedOn: today,
        batches: 1,
        outputLocationId: store,
      }),
      201,
    );
    await ok(await call("POST", `/production/batches/${b.id}/start`, {}));
    await ok(
      await call("POST", `/production/batches/${b.id}/consumption`, {
        lines: [{ lotId: root, locationId: store, quantity: 2, unit: "kg" }],
      }),
      201,
    );
    const incident = (await create()).id;
    expect((await scope(incident, root)).status).toBe(409);
    const contained = await ok(await scope(incident, root, { acknowledgePartial: true }));
    expect(contained.snapshots[0].report.coverage.status).toBe("partial");
    const output = await ok(
      await call("POST", `/production/batches/${b.id}/output`, {
        quantity: 4,
        unit: "each",
        locationId: store,
        lotCode: "INC-LATE",
      }),
      201,
    );
    const late = output.records.filter((r: any) => r.kind === "output").at(-1).lotId;
    expect(
      (
        await call("POST", `/stock/lots/${late}/status`, {
          status: "available",
          note: "Cannot release late output",
        })
      ).status,
    ).toBe(409);
    const detail = await ok(await call("GET", `/quality/incidents/${incident}`));
    expect(detail.holds.map((h: any) => h.lotId)).toContain(late);
  });
});
