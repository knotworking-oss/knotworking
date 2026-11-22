import { newId, todayInZone, DEFAULT_TIME_ZONE, validSscc } from "@knotworking/core";
import { despatches, despatchReturns, stockLots, workspaces, customerDeliverySites } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";
import { prepareDespatch } from "./despatch-test-helpers";
const today = todayInZone(DEFAULT_TIME_ZONE),
  WS = "/v1/workspaces/acme";
describe("distribution operations and physical customer returns", () => {
  let ctx: TestCtx,
    cookie: string,
    token: string,
    owner: string,
    store: string,
    otherStore: string,
    product: string,
    customer: string;
  let seq = 0;
  const call = (method: string, path: string, json?: unknown) => ctx.req(WS + path, { method, cookie, json });
  const ok = async (r: Res, status = 200) => {
    const b = await r.json();
    expect(r.status, JSON.stringify(b)).toBe(status);
    return b;
  };
  const bad = async (r: Res, status: number, code?: string) => {
    const b = await r.json();
    expect(r.status, JSON.stringify(b)).toBe(status);
    if (code) expect(b.error.code).toBe(code);
    return b;
  };
  const stock = async (quantity = 10) =>
    ok(
      await call("POST", "/stock/receipts", {
        itemId: product,
        locationId: store,
        quantity,
        unit: "kg",
        receivedOn: today,
        lotCode: `DIST-${++seq}`,
        reason: "Opening balance",
      }),
      201,
    );
  const draft = async (lot: string, quantity = 2, extra = {}) =>
    ok(
      await call("POST", "/despatch", {
        customerId: customer,
        despatchedOn: today,
        lines: [{ lotId: lot, locationId: store, quantity, unit: "kg" }],
        ...extra,
      }),
      201,
    );
  const allocate = (d: any) =>
    call("POST", `/despatch/${d.id}/allocate`, {
      commandId: newId(),
      expectedUpdatedAt: d.updatedAt,
      note: "Stock checked and allocated",
    });
  const pack = (d: any, extra = {}) =>
    call("POST", `/despatch/${d.id}/pack`, {
      commandId: newId(),
      expectedUpdatedAt: d.updatedAt,
      note: "Packing checked",
      packages: [
        {
          reference: "Pallet 1",
          contents: d.lines.map((l: any) => ({
            lineId: l.id,
            quantity: l.amount.display,
            unit: l.amount.displayUnit,
          })),
        },
      ],
      ...extra,
    });
  const load = (d: any, extra = {}) =>
    call("POST", `/despatch/${d.id}/load-check`, {
      commandId: newId(),
      expectedUpdatedAt: d.updatedAt,
      vehicle: "AB12 CDE",
      carrier: "Test carrier",
      clean: "pass",
      secure: "pass",
      segregation: "pass",
      temperatureMode: "ambient",
      temperatureBasis: "Ambient stable product specification checked",
      note: "Load checked",
      ...extra,
    });
  const confirm = (d: any, commandId = newId()) =>
    call("POST", `/despatch/${d.id}/confirm`, { commandId, expectedUpdatedAt: d.updatedAt });
  const ship = async (d: any) => {
    const p = await prepareDespatch(call, d.id, d.updatedAt);
    if (p.error) await ok(p.error);
    return ok(await confirm({ ...d, updatedAt: p.stamp }));
  };
  const receive = (d: any, extra = {}) =>
    call("POST", `/despatch/${d.id}/returns`, {
      commandId: newId(),
      lineId: d.lines[0].id,
      quantity: 0.5,
      unit: "kg",
      locationId: store,
      receivedOn: today,
      reason: "Customer return",
      condition: "Sealed packaging; awaiting QA assessment",
      ...extra,
    });
  const balance = async (lot: string) => (await ok(await call("GET", `/stock/lots/${lot}`))).onHand.base;
  const sscc = (serial: number) => {
    const body = String(serial).padStart(17, "0");
    const sum = [...body].reverse().reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
    return body + String((10 - (sum % 10)) % 10);
  };
  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    owner = (await ok(await ctx.req("/v1/me", { cookie }))).user.id;
    token = (
      await ok(
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie,
          json: { name: "Distribution test", scope: "write" },
        }),
        201,
      )
    ).token;
    store = (await ok(await call("POST", "/stock/locations", { name: "Distribution store" }), 201)).id;
    otherStore = (
      await ok(await call("POST", "/stock/locations", { name: "Second distribution store" }), 201)
    ).id;
    product = (
      await ok(
        await call("POST", "/items", {
          code: "DIST-P",
          name: "Distribution product",
          type: "finished",
          unit: "kg",
        }),
        201,
      )
    ).id;
    customer = (
      await ok(
        await call("POST", "/customers", {
          code: "DIST-C",
          name: "Distribution customer",
          address: "Main account address",
          email: "account@example.test",
        }),
        201,
      )
    ).id;
  }, 60000);
  afterAll(() => ctx.handle.close());
  it("manages distinct delivery sites and preserves the actual site contact/address at confirmation", async () => {
    const site = await ok(
      await call("POST", `/customers/${customer}/sites`, {
        code: "DEPOT",
        name: "Regional depot",
        address: "Depot address",
        email: "depot@example.test",
      }),
      201,
    );
    await bad(
      await call("POST", `/customers/${customer}/sites`, {
        code: "depot",
        name: "Duplicate",
        address: "Other",
      }),
      409,
      "site_code_taken",
    );
    expect((await ok(await call("GET", `/customers/${customer}/sites`))).sites).toHaveLength(1);
    const lot = await stock();
    const d = await ship(
      await draft(lot.id, 2, { deliverySiteId: site.id, deliveryAddress: "Wrong override" }),
    );
    expect(d.deliveryAddress).toBe("Depot address");
    expect(d.email).toBe("depot@example.test");
    expect(d.customerAddress).toBe("Main account address");
    await ok(
      await call("PUT", `/customers/${customer}/sites/${site.id}`, {
        code: "DEPOT",
        name: "Moved depot",
        address: "Moved address",
        email: "moved@example.test",
        status: "archived",
      }),
    );
    const historical = await ok(await call("GET", `/despatch/${d.id}`));
    expect(historical.deliveryAddress).toBe("Depot address");
    expect(historical.email).toBe("depot@example.test");
    await bad(await draftResponse(lot.id, site.id), 409, "site_archived");
  });
  async function draftResponse(lotId: string, siteId: string) {
    return call("POST", "/despatch", {
      customerId: customer,
      deliverySiteId: siteId,
      despatchedOn: today,
      lines: [{ lotId, locationId: store, quantity: 1, unit: "kg" }],
    });
  }
  it("requires operational sign-offs and allocates stock without posting movements", async () => {
    const lot = await stock();
    const d = await draft(lot.id, 7);
    await bad(await confirm(d), 409, "fulfilment_incomplete");
    expect(await balance(lot.id)).toBe(10000);
    const allocated = await ok(await allocate(d));
    expect(allocated.allocatedAt).toBeTruthy();
    await bad(
      await call("POST", `/despatch/${d.id}/unallocate`, {
        commandId: newId(),
        expectedUpdatedAt: d.updatedAt,
        note: "Stale review cannot release a newer allocation",
      }),
      409,
      "draft_changed",
    );
    expect(await balance(lot.id)).toBe(10000);
    await bad(
      await call("PUT", `/despatch/${d.id}`, {
        customerId: customer,
        despatchedOn: today,
        lines: [{ lotId: lot.id, locationId: store, quantity: 1, unit: "kg" }],
      }),
      409,
      "despatch_allocated",
    );
    const competing = await draft(lot.id, 4);
    expect((await allocate(competing)).status).toBe(409);
    await bad(
      await call("POST", "/stock/adjustments", {
        lotId: lot.id,
        locationId: store,
        quantity: -4,
        unit: "kg",
        reason: "Cannot spend allocated stock",
      }),
      409,
      "stock_allocated",
    );
    await bad(
      await call("POST", "/stock/transfers", {
        lotId: lot.id,
        fromLocationId: store,
        toLocationId: otherStore,
        quantity: 4,
        unit: "kg",
      }),
      409,
      "stock_allocated",
    );
    const released = await ok(
      await call("POST", `/despatch/${d.id}/unallocate`, {
        commandId: newId(),
        expectedUpdatedAt: allocated.updatedAt,
        note: "Order changed",
      }),
    );
    expect(released.allocatedAt).toBeNull();
    await ok(await allocate(competing));
  });
  it("validates exact packing totals, GS1 checksums and SSCC uniqueness across corrected packs", async () => {
    expect(validSscc(sscc(101))).toBe(true);
    expect(validSscc("123")).toBe(false);
    const lot = await stock();
    let d = await ok(await allocate(await draft(lot.id)));
    await bad(
      await pack(d, {
        packages: [
          {
            reference: "Pallet",
            sscc: "123",
            contents: [{ lineId: d.lines[0].id, quantity: 2, unit: "kg" }],
          },
        ],
      }),
      400,
    );
    await bad(
      await pack(d, {
        packages: [{ reference: "Pallet", contents: [{ lineId: d.lines[0].id, quantity: 1, unit: "kg" }] }],
      }),
      400,
      "invalid_input",
    );
    d = await ok(
      await pack(d, {
        packages: [
          {
            reference: "A",
            sscc: sscc(101),
            contents: [{ lineId: d.lines[0].id, quantity: 500, unit: "g" }],
          },
          {
            reference: "B",
            sscc: sscc(102),
            contents: [{ lineId: d.lines[0].id, quantity: 1.5, unit: "kg" }],
          },
        ],
      }),
    );
    expect(d.packedAt).toBeTruthy();
    expect(await balance(lot.id)).toBe(10000);
    let ops = await ok(await call("GET", `/despatch/${d.id}/operations`));
    expect(ops.packages).toHaveLength(2);
    d = await ok(
      await call("POST", `/despatch/${d.id}/unallocate`, {
        commandId: newId(),
        expectedUpdatedAt: d.updatedAt,
        note: "Correct pallet split",
      }),
    );
    d = await ok(await allocate(d));
    await bad(
      await pack(d, {
        packages: [
          {
            reference: "New pallet",
            sscc: sscc(101),
            contents: [{ lineId: d.lines[0].id, quantity: 2, unit: "kg" }],
          },
        ],
      }),
      409,
      "sscc_used",
    );
    ops = await ok(await call("GET", `/despatch/${d.id}/operations`));
    expect(ops.packages.every((p: any) => p.supersededAt)).toBe(true);
  });
  it("retains failed load checks and blocks confirmation until a valid temperature and all checks pass", async () => {
    const lot = await stock();
    let d = await ok(await pack(await ok(await allocate(await draft(lot.id)))));
    await bad(await load(d, { temperatureMode: "controlled" }), 400);
    const failed = await ok(
      await load(d, {
        temperatureMode: "controlled",
        temperatureC: 12,
        minC: 0,
        maxC: 5,
        temperatureBasis: "Chilled specification 0–5 C",
        clean: "fail",
      }),
    );
    await bad(await confirm(failed), 409, "fulfilment_incomplete");
    expect(await balance(lot.id)).toBe(10000);
    d = await ok(
      await load(failed, {
        temperatureMode: "controlled",
        temperatureC: 3,
        minC: 0,
        maxC: 5,
        temperatureBasis: "Chilled specification 0–5 C",
      }),
    );
    await ctx.handle.db
      .update(despatches)
      .set({ loadCheckedAt: new Date(Date.now() - 86400000) })
      .where(eq(despatches.id, d.id));
    d = await ok(await call("GET", `/despatch/${d.id}`));
    await bad(await confirm(d), 409, "load_check_expired");
    d = await ok(
      await load(d, {
        temperatureMode: "controlled",
        temperatureC: 3,
        minC: 0,
        maxC: 5,
        temperatureBasis: "Fresh release against chilled specification",
      }),
    );
    const sent = await ok(await confirm(d));
    expect(sent.status).toBe("confirmed");
    const ops = await ok(await call("GET", `/despatch/${d.id}/operations`));
    expect(ops.events.filter((e: any) => e.kind === "load_check").map((e: any) => e.data.passed)).toEqual([
      false,
      true,
      true,
    ]);
  });
  it("requires reallocation when customer/site facts change after packing", async () => {
    const site = await ok(
      await call("POST", `/customers/${customer}/sites`, {
        code: "CHANGE",
        name: "Change test",
        address: "Before",
      }),
      201,
    );
    const lot = await stock();
    let d = await draft(lot.id, 2, { deliverySiteId: site.id });
    const p = await prepareDespatch(call, d.id, d.updatedAt);
    if (p.error) await ok(p.error);
    d = await ok(await call("GET", `/despatch/${d.id}`));
    await ok(
      await call("PUT", `/customers/${customer}/sites/${site.id}`, {
        code: "CHANGE",
        name: "Change test",
        address: "After",
      }),
    );
    await bad(await confirm(d), 409, "recipient_changed");
    expect(await balance(lot.id)).toBe(10000);
  });
  it("records cumulative delivery proof with explicit corrections and no stock posting", async () => {
    const lot = await stock();
    const d = await ship(await draft(lot.id));
    const proof = {
      commandId: newId(),
      deliveredAt: new Date(Date.now() - 1000).toISOString(),
      receivedBy: "Depot receiver",
      evidenceReference: "Signed POD-123",
      note: "Partial receipt confirmed",
      lines: [{ lineId: d.lines[0].id, deliveredQuantity: 1000, refusedQuantity: 500, unit: "g" }],
    };
    const first = await ok(await call("POST", `/despatch/${d.id}/proof`, proof));
    expect(first.proofs).toHaveLength(1);
    expect(first.proofs[0].data.lines[0]).toMatchObject({
      deliveredQuantity: 1,
      refusedQuantity: 0.5,
      unit: "kg",
    });
    expect(await balance(lot.id)).toBe(8000);
    await bad(
      await call("POST", `/despatch/${d.id}/proof`, { ...proof, commandId: newId() }),
      409,
      "proof_changed",
    );
    const corrected = await ok(
      await call("POST", `/despatch/${d.id}/proof`, {
        ...proof,
        commandId: newId(),
        supersedesId: first.proofs[0].id,
        correctionReason: "Receiver clarified full receipt",
        lines: [{ lineId: d.lines[0].id, deliveredQuantity: 2, refusedQuantity: 0, unit: "kg" }],
      }),
    );
    expect(corrected.proofs).toHaveLength(2);
    await bad(
      await call("POST", `/despatch/${d.id}/void`, {
        commandId: newId(),
        reason: "Cannot erase physically delivered shipment",
      }),
      409,
      "despatch_has_evidence",
    );
  });
  it("receives physical returns into isolated quarantine with unit conversion, capped quantities and durable retries", async () => {
    const lot = await stock();
    const d = await ship(await draft(lot.id));
    const command = { commandId: newId(), quantity: 250, unit: "g" };
    const received = await ok(await receive(d, command), 201);
    const r = received.returns[0];
    expect(r.quantity).toBe(0.25);
    expect(r.unit).toBe("kg");
    expect(await balance(lot.id)).toBe(8000);
    expect(await balance(r.lotId)).toBe(250);
    const returned = await ok(await call("GET", `/stock/lots/${r.lotId}`));
    expect(returned.status).toBe("quarantine");
    expect(returned.item.id).toBe(product);
    expect((await ok(await receive(d, command), 201)).returns).toHaveLength(1);
    await bad(await receive(d, { quantity: 2 }), 409, "return_quantity_exceeded");
    const trace = await ok(await call("GET", `/production/lots/${r.lotId}/trace`));
    expect(trace.massBalance.returned.base).toBe(250);
    expect(trace.massBalance.onHand.base).toBe(250);
    const [dbReturn] = await ctx.handle.db.select().from(despatchReturns).where(eq(despatchReturns.id, r.id));
    await bad(
      await call("POST", `/stock/movements/${dbReturn!.movementId}/reverse`, {
        reason: "Use dedicated receipt correction",
      }),
      409,
      "return_movement",
    );
    await bad(
      await call("POST", `/despatch/${d.id}/void`, {
        commandId: newId(),
        reason: "Physical return is separate",
      }),
      409,
      "despatch_has_evidence",
    );
    const impact = await ok(await call("GET", `/despatch/lots/${lot.id}/impact`));
    expect(impact.lots.map((l: any) => l.id)).toContain(r.lotId);
    expect(impact.returnLinks[0].lotId).toBe(r.lotId);
  });
  it("prevents concurrent excess returns and corrects a receipt with an appended opposite movement", async () => {
    const lot = await stock();
    const d = await ship(await draft(lot.id));
    const results = await Promise.all([receive(d, { quantity: 1.5 }), receive(d, { quantity: 1.5 })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const received = await ok(await call("GET", `/despatch/${d.id}/operations`));
    const r = received.returns[0];
    const command = { commandId: newId(), reason: "Wrong customer return entry; goods were never received" };
    const corrected = await ok(await call("POST", `/despatch/${d.id}/returns/${r.id}/void`, command));
    expect(corrected.returns[0].voidedAt).toBeTruthy();
    expect(await balance(r.lotId)).toBe(0);
    expect(await balance(lot.id)).toBe(8000);
    expect(
      (await ok(await call("POST", `/despatch/${d.id}/returns/${r.id}/void`, command))).returns[0].voidedAt,
    ).toBe(corrected.returns[0].voidedAt);
    const impact = await ok(await call("GET", `/despatch/lots/${lot.id}/impact`));
    expect(impact.returnLinks).toHaveLength(0);
  });
  it("keeps return links and holds through an ingredient-to-customer recall exercise with split deliveries and a corrected entry", async () => {
    const raw = (
      await ok(
        await call("POST", "/items", {
          code: "DIST-RAW",
          name: "Recall ingredient",
          type: "ingredient",
          unit: "kg",
        }),
        201,
      )
    ).id;
    const ingredient = (
      await ok(
        await call("POST", "/stock/receipts", {
          itemId: raw,
          locationId: store,
          quantity: 10,
          unit: "kg",
          receivedOn: today,
          lotCode: "DIST-ROOT",
        }),
        201,
      )
    ).id;
    const recipe = await ok(
      await call("POST", "/recipes", {
        code: "DIST-RECIPE",
        name: "Recall product recipe",
        outputItemId: product,
        draft: { yieldQuantity: 5, yieldUnit: "kg", lines: [{ itemId: raw, quantity: 2, unit: "kg" }] },
      }),
      201,
    );
    await ok(await call("POST", `/recipes/${recipe.id}/draft/approve`, {}));
    const outputs = [];
    for (let i = 0; i < 2; i++) {
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
          lines: [{ lotId: ingredient, locationId: store, quantity: 2, unit: "kg" }],
        }),
        201,
      );
      if (i === 0) {
        // A corrected production entry: a mis-keyed extra consumption, reversed by a person.
        const wrongUse = await ok(
          await call("POST", `/production/batches/${b.id}/consumption`, {
            lines: [{ lotId: ingredient, locationId: store, quantity: 1, unit: "kg" }],
          }),
          201,
        );
        const mistake = wrongUse.records.filter((r: any) => r.kind === "consumption").at(-1);
        await ok(
          await call("POST", `/production/batches/${b.id}/records/${mistake.id}/reverse`, {
            reason: "Keyed twice; only 2 kg used",
          }),
          201,
        );
      }
      const out = await ok(
        await call("POST", `/production/batches/${b.id}/output`, {
          quantity: 5,
          unit: "kg",
          lotCode: `DIST-EX-${i}`,
          locationId: store,
        }),
        201,
      );
      const id = out.records.filter((r: any) => r.kind === "output").at(-1).lotId;
      await ok(await call("POST", `/production/batches/${b.id}/complete`, {}));
      await ok(await call("POST", `/stock/lots/${id}/status`, { status: "available", note: "QA release" }));
      outputs.push(id);
    }
    const first = await ship(await draft(outputs[0], 2));
    await ship(await draft(outputs[1], 2));
    const wrong = await ship(await draft(outputs[1], 1));
    await ok(
      await call("POST", `/despatch/${wrong.id}/void`, {
        commandId: newId(),
        reason: "Duplicate paper entry; no physical shipment",
      }),
    );
    const c = await ok(
      await call("POST", "/quality/incidents", {
        commandId: newId(),
        title: "Section 3.1 recall exercise",
        kind: "recall",
        severity: "critical",
        ownerUserId: owner,
        assessment: "Ingredient contamination investigation",
      }),
      201,
    );
    await ok(
      await call("POST", `/quality/incidents/${c.id}/contain`, {
        commandId: newId(),
        lotId: ingredient,
        note: "Hold ingredient and both product batches",
      }),
    );
    const received = await ok(await receive(first, { quantity: 1, incidentId: c.id }), 201);
    const returned = received.returns[0];
    await bad(
      await call("POST", `/stock/lots/${returned.lotId}/status`, {
        status: "available",
        note: "Cannot bypass active recall",
      }),
      409,
      "incident_hold",
    );
    const refresh = await ok(
      await call("POST", `/quality/incidents/${c.id}/contain`, {
        commandId: newId(),
        lotId: ingredient,
        note: "Refresh scope after physical recovery",
      }),
    );
    const snapshot = refresh.snapshots.at(-1).report;
    expect(snapshot.coverage.status).toBe("complete");
    expect(snapshot.batches).toHaveLength(2);
    expect(snapshot.deliveries.total).toBe(2);
    expect(snapshot.returnLinks).toHaveLength(1);
    expect(snapshot.lots.map((l: any) => l.id)).toContain(returned.lotId);
    expect(refresh.physicalReturns[0].quantity).toBe(1);
    expect(refresh.holds.some((h: any) => h.lotId === returned.lotId && !h.releasedAt)).toBe(true);
    expect(await balance(ingredient)).toBe(6000);
    expect(await balance(outputs[0])).toBe(3000);
    expect(await balance(returned.lotId)).toBe(1000);
  });
  it("rejects foreign sites and return identities and reserves every physical sign-off for people", async () => {
    const [foreign] = await ctx.handle.db
      .insert(workspaces)
      .values({ name: "Foreign", slug: "distribution-other" })
      .returning();
    const [site] = await ctx.handle.db
      .insert(customerDeliverySites)
      .values({
        workspaceId: foreign!.id,
        customerId: customer,
        code: "PRIVATE",
        name: "Private site",
        address: "Private address",
      })
      .returning();
    await bad(await draftResponse((await stock()).id, site!.id), 404, "not_found");
    const d = await draft((await stock()).id);
    for (const action of [
      "allocate",
      "unallocate",
      "pack",
      "load-check",
      "proof",
      "returns",
      `returns/${newId()}/void`,
    ]) {
      const r = await ctx.req(`${WS}/despatch/${d.id}/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        json: {},
      });
      await bad(r, 403, "token_not_allowed");
    }
    await bad(
      await call("POST", `/despatch/${d.id}/returns/${newId()}/void`, {
        commandId: newId(),
        reason: "Foreign receipt",
      }),
      404,
      "not_found",
    );
  });
});
