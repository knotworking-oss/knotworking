import { prepareDespatch } from "./despatch-test-helpers";
import { addDays, newId, todayInZone, DEFAULT_TIME_ZONE } from "@knotworking/core";
import { customers, workspaces } from "@knotworking/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
describe("customer-linked despatch", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: string;
  let marcusId: string;
  let token: string;
  let customer: string;
  let location: string;
  let product: string;
  let sequence = 0;
  const draftStamps = new Map<string, string>();
  const call = (method: string, path: string, json?: unknown, cookie = ada) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const ok = async (res: Res, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const fail = async (res: Res, status: number, code: string) => {
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
  };
  const grant = (module: string, level: string) =>
    call("PUT", `/members/${marcusId}/module-access/${module}`, { level });
  const stock = async (quantity = 10, extra: object = {}) =>
    ok(
      await call("POST", "/stock/receipts", {
        itemId: product,
        locationId: location,
        quantity,
        unit: "kg",
        receivedOn: today,
        lotCode: `DP-${++sequence}`,
        reason: "Opening balance",
        expiresOn: addDays(today, 10),
        expiryType: "best_before",
        ...extra,
      }),
      201,
    );
  const line = (lotId: string, quantity = 2, extra: object = {}) => ({
    lotId,
    locationId: location,
    quantity,
    unit: "kg",
    ...extra,
  });
  const draft = async (lines: object[], extra: object = {}) => {
    const d = await ok(
      await call("POST", "/despatch", {
        customerId: customer,
        despatchedOn: today,
        externalReference: "ORDER-42",
        lines,
        ...extra,
      }),
      201,
    );
    draftStamps.set(d.id, d.updatedAt);
    return d;
  };
  const confirm = async (id: string, commandId = newId()) => {
    const prepared = await prepareDespatch(call, id, draftStamps.get(id));
    if (prepared.error) return prepared.error;
    draftStamps.set(id, prepared.stamp);
    return call("POST", `/despatch/${id}/confirm`, { commandId, expectedUpdatedAt: prepared.stamp });
  };
  const balance = async (lotId: string) => (await ok(await call("GET", `/stock/lots/${lotId}`))).onHand.base;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    marcusId = (await ok(await ctx.req("/v1/me", { cookie: marcus }))).user.id;
    token = (
      await ok(
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "Despatch integration", scope: "write" },
        }),
        201,
      )
    ).token;
    customer = (
      await ok(
        await call("POST", "/customers", {
          code: "SHOP",
          name: "Original shop",
          address: "1 High Street",
          contactName: "Original contact",
          email: "original@example.test",
        }),
        201,
      )
    ).id;
    location = (await ok(await call("POST", "/stock/locations", { name: "Finished store", code: "FS" }), 201))
      .id;
    product = (
      await ok(
        await call("POST", "/items", {
          code: "DP-PROD",
          name: "Despatch product",
          type: "finished",
          unit: "kg",
        }),
        201,
      )
    ).id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("opts in separately, needs readable dependencies, and reserves confirmation for managers", async () => {
    await fail(await call("GET", "/customers", undefined, marcus), 403, "module_forbidden");
    await ok(await grant("despatch", "write"));
    await fail(await call("GET", "/despatch", undefined, marcus), 403, "module_forbidden");
    for (const m of ["customers", "items", "stock"]) await ok(await grant(m, "read"));
    await ok(await call("GET", "/despatch", undefined, marcus));
    const lot = await stock();
    const d = await ok(
      await call(
        "POST",
        "/despatch",
        { customerId: customer, despatchedOn: today, lines: [line(lot.id)] },
        marcus,
      ),
      201,
    );
    await fail(
      await call(
        "POST",
        `/despatch/${d.id}/confirm`,
        { commandId: newId(), expectedUpdatedAt: d.updatedAt },
        marcus,
      ),
      403,
      "module_forbidden",
    );
    await ok(await grant("despatch", "read"));
    expect(
      (
        await call(
          "PUT",
          `/despatch/${d.id}`,
          { customerId: customer, despatchedOn: today, lines: [line(lot.id)] },
          marcus,
        )
      ).status,
    ).toBe(403);
  });

  it("keeps customer codes unique ignoring case; partial edits do not reactivate archived accounts", async () => {
    await fail(
      await call("POST", "/customers", { code: "shop", name: "Duplicate", address: "Elsewhere" }),
      409,
      "code_taken",
    );
    const c = await ok(
      await call("POST", "/customers", {
        code: "OLD",
        name: "Old",
        address: "Old address",
        status: "archived",
      }),
      201,
    );
    expect(await ok(await call("PATCH", `/customers/${c.id}`, { name: "Renamed" }))).toMatchObject({
      status: "archived",
    });
    expect((await ok(await call("GET", "/customers?q=old&status=all"))).customers).toHaveLength(1);
    await fail(
      await call("POST", "/despatch", {
        customerId: c.id,
        despatchedOn: today,
        lines: [line((await stock()).id)],
      }),
      409,
      "customer_archived",
    );
  });

  it("drafts withdraw nothing; confirmation and void are idempotent and preserve recipient snapshots", async () => {
    const lot = await stock(10);
    const d = await draft([line(lot.id)]);
    expect(await balance(lot.id)).toBe(10000);
    const commandId = newId();
    const sent = await ok(await confirm(d.id, commandId));
    expect(sent).toMatchObject({
      status: "confirmed",
      customerName: "Original shop",
      deliveryAddress: "1 High Street",
    });
    expect(sent.lines[0]).toMatchObject({
      quantity: 2000,
      itemUnit: "kg",
      amount: { display: 2, displayUnit: "kg" },
    });
    expect(await ok(await confirm(d.id, commandId))).toEqual(sent);
    expect(await balance(lot.id)).toBe(8000);
    await fail(await confirm(d.id), 409, "despatch_immutable");
    await fail(
      await call("PUT", `/despatch/${d.id}`, {
        customerId: customer,
        despatchedOn: today,
        lines: [line(lot.id, 5)],
      }),
      409,
      "despatch_immutable",
    );
    await fail(
      await call("POST", `/stock/movements/${sent.lines[0].movementId}/reverse`, { reason: "Bypass" }),
      409,
      "despatch_movement",
    );

    await ok(
      await call("PATCH", `/customers/${customer}`, {
        name: "New business name",
        address: "99 New Road",
        email: "new@example.test",
      }),
    );
    const recipients = await ok(await call("GET", `/despatch/lots/${lot.id}/recipients`));
    expect(recipients).toMatchObject({ scope: "direct_lot_only", total: 1 });
    expect(recipients.recipients[0]).toMatchObject({
      customerName: "Original shop",
      customerAddress: "1 High Street",
      email: "original@example.test",
    });
    const trace = await ok(await call("GET", `/production/lots/${lot.id}/trace`));
    expect(trace.massBalance.despatched.base).toBe(2000);
    expect(JSON.stringify(trace)).not.toContain("original@example.test");
    expect(JSON.stringify(trace)).not.toContain("customerAddress");
    const recall = await ok(
      await call("GET", `/quality/recall-tests/prefill?lotId=${lot.id}&direction=both`),
    );
    expect(recall.quantityExpected).toBe(10);
    expect(recall.quantityTraced).toBe(10);
    const voidCommand = { commandId: newId(), reason: "Duplicate paper entry; goods did not leave" };
    const voided = await ok(await call("POST", `/despatch/${d.id}/void`, voidCommand));
    expect(voided.status).toBe("voided");
    expect(voided.lines[0].reversalMovementId).toBeTruthy();
    expect(await ok(await call("POST", `/despatch/${d.id}/void`, voidCommand))).toEqual(voided);
    expect(await balance(lot.id)).toBe(10000);
    expect((await ok(await call("GET", `/despatch/lots/${lot.id}/recipients`))).total).toBe(0);
    expect(
      (await ok(await call("GET", `/production/lots/${lot.id}/trace`))).massBalance.despatched.base,
    ).toBe(0);
  });

  it("refuses duplicate lines, zero/rounded-away quantities and command reuse across records", async () => {
    const lot = await stock();
    for (const lines of [[line(lot.id), line(lot.id)], [line(lot.id, 0)], [line(lot.id, 0.000000001)]]) {
      expect(
        (await call("POST", "/despatch", { customerId: customer, despatchedOn: today, lines })).status,
      ).toBe(400);
    }
    const a = await draft([line(lot.id, 1)]);
    const b = await draft([line(lot.id, 1)]);
    const command = newId();
    await ok(await confirm(a.id, command));
    await fail(await confirm(b.id, command), 409, "command_conflict");
    expect(await balance(lot.id)).toBe(9000);
  });

  it("refuses confirmation from a stale delivery view until the manager reviews the changed draft", async () => {
    const lot = await stock();
    const d = await draft([line(lot.id, 1)]);
    const changed = await ok(
      await call("PUT", `/despatch/${d.id}`, {
        customerId: customer,
        despatchedOn: today,
        lines: [line(lot.id, 2)],
      }),
    );
    expect(changed.updatedAt).not.toBe(d.updatedAt);
    await fail(await confirm(d.id), 409, "draft_changed");
    expect(await balance(lot.id)).toBe(10000);
    draftStamps.set(d.id, changed.updatedAt);
    await ok(await confirm(d.id));
    expect(await balance(lot.id)).toBe(8000);
  });

  it("records split deliveries to different customers and pages recipients without mixing units", async () => {
    const lot = await stock();
    const second = await ok(
      await call("POST", "/customers", { code: "SHOP2", name: "Second shop", address: "2 Market Road" }),
      201,
    );
    const a = await draft([line(lot.id, 0.25)]);
    const b = await draft([line(lot.id, 750, { unit: "g" })], { customerId: second.id });
    await ok(await confirm(a.id));
    await ok(await confirm(b.id));
    expect(await balance(lot.id)).toBe(9000);
    const first = await ok(await call("GET", `/despatch/lots/${lot.id}/recipients?limit=1`));
    const next = await ok(await call("GET", `/despatch/lots/${lot.id}/recipients?limit=1&offset=1`));
    expect(first.total).toBe(2);
    expect(first.recipients).toHaveLength(1);
    expect(next.recipients[0].despatchId).not.toBe(first.recipients[0].despatchId);
    expect(first.recipients[0].amount.display + next.recipients[0].amount.display).toBe(1);
  });

  it("revalidates QA status, expiry, customer archive and date at confirmation", async () => {
    const lot = await stock();
    const d = await draft([line(lot.id)]);
    await ok(
      await call("POST", `/stock/lots/${lot.id}/status`, { status: "quarantine", note: "Investigation" }),
    );
    await fail(await confirm(d.id), 409, "lot_not_released");
    expect(await balance(lot.id)).toBe(10000);
    const expired = await stock(5, {
      receivedOn: addDays(today, -2),
      expiresOn: addDays(today, -1),
      expiryType: "use_by",
    });
    await fail(await confirm((await draft([line(expired.id)])).id), 409, "lot_expired");
    const future = await draft([line((await stock()).id)], { despatchedOn: addDays(today, 1) });
    await fail(await confirm(future.id), 400, "invalid_input");
    const c = await ok(
      await call("POST", "/customers", { code: "ARCH", name: "Archive later", address: "Address" }),
      201,
    );
    const archived = await draft([line((await stock()).id)], { customerId: c.id });
    await ok(await call("PATCH", `/customers/${c.id}`, { status: "archived" }));
    await fail(await confirm(archived.id), 409, "customer_archived");
  });

  it("rolls back every line on insufficient stock and prevents two despatches spending the same stock", async () => {
    const a = await stock();
    const b = await stock(1);
    const d = await draft([line(a.id, 2), line(b.id, 2)]);
    await fail(await confirm(d.id), 409, "insufficient_stock");
    expect(await balance(a.id)).toBe(10000);
    expect(await balance(b.id)).toBe(1000);
    const d1 = await draft([line(a.id, 7)]);
    const d2 = await draft([line(a.id, 7)]);
    const results = await Promise.all([confirm(d1.id), confirm(d2.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await balance(a.id)).toBe(3000);
  });

  it("respects production reservations even for callers who cannot read production", async () => {
    const lot = await stock();
    const output = await ok(
      await call("POST", "/items", { code: "DP-OUT", name: "Output", type: "finished", unit: "each" }),
      201,
    );
    const recipe = await ok(
      await call("POST", "/recipes", {
        code: "DP-R",
        name: "Reserved product",
        outputItemId: output.id,
        draft: { yieldQuantity: 1, yieldUnit: "each", lines: [{ itemId: product, quantity: 8, unit: "kg" }] },
      }),
      201,
    );
    await ok(await call("POST", `/recipes/${recipe.id}/draft/approve`, {}));
    const batch = await ok(
      await call("POST", "/production/batches", { recipeId: recipe.id, plannedOn: today, batches: 1 }),
      201,
    );
    await ok(await grant("despatch", "manage"));
    const d = await draft([line(lot.id, 3)]);
    await ok(
      await call("POST", `/production/batches/${batch.id}/reservations`, {
        lines: [{ lotId: lot.id, quantity: 8, unit: "kg", locationId: location }],
      }),
      201,
    );
    await fail(
      await call(
        "POST",
        `/despatch/${d.id}/confirm`,
        { commandId: newId(), expectedUpdatedAt: d.updatedAt },
        marcus,
      ),
      409,
      "stock_reserved",
    );
    expect(await balance(lot.id)).toBe(10000);
    // 0.3 g on hand minus a 0.1 g hold must leave exactly 0.2 g free.
    const fractional = await stock(0.0003);
    const secondBatch = await ok(
      await call("POST", "/production/batches", { recipeId: recipe.id, plannedOn: today, batches: 1 }),
      201,
    );
    await ok(
      await call("POST", `/production/batches/${secondBatch.id}/reservations`, {
        lines: [{ lotId: fractional.id, quantity: 0.0001, unit: "kg", locationId: location }],
      }),
      201,
    );
    const small = await draft([line(fractional.id, 0.0002)]);
    await ok(await confirm(small.id));
    expect(await balance(fractional.id)).toBe(0.1);
  });

  it("rejects foreign workspace IDs and never copies contacts to sync or production traces", async () => {
    const [other] = await ctx.handle.db
      .insert(workspaces)
      .values({ name: "Other", slug: "other" })
      .returning();
    const [foreign] = await ctx.handle.db
      .insert(customers)
      .values({ workspaceId: other!.id, code: "OTHER", name: "Private", address: "Private" })
      .returning();
    await fail(await call("GET", `/customers/${foreign!.id}`), 404, "not_found");
    await fail(
      await call("POST", "/despatch", {
        customerId: foreign!.id,
        despatchedOn: today,
        lines: [line((await stock()).id)],
      }),
      404,
      "not_found",
    );
    const sync = await ok(await call("GET", "/sync?after=0&limit=1000"));
    const c = sync.changes.filter(
      (r: { entity: string }) => r.entity === "customer" || r.entity === "despatch",
    );
    expect(c.length).toBeGreaterThan(0);
    for (const change of c) {
      expect(change.data.email).toBeUndefined();
      expect(change.data.phone).toBeUndefined();
      expect(change.data.customerAddress).toBeUndefined();
      expect(change.data.address).toBeUndefined();
    }
    expect(JSON.stringify(sync)).not.toContain("original@example.test");
    await ok(await grant("customers", "none"));
    await fail(await call("GET", "/despatch", undefined, marcus), 403, "module_forbidden");
    const filtered = await ok(await call("GET", "/sync?after=0&limit=1000", undefined, marcus));
    expect(
      filtered.changes.some((c: { entity: string }) => ["customer", "despatch"].includes(c.entity)),
    ).toBe(false);
  });

  it("allows integration drafts but refuses token confirmation and void even for the owner", async () => {
    const d = await draft([line((await stock()).id)]);
    for (const action of ["confirm", "void"]) {
      const res = await ctx.req(`${WS}/despatch/${d.id}/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        json: { commandId: newId(), reason: "No" },
      });
      await fail(res, 403, "token_not_allowed");
    }
  });
});
