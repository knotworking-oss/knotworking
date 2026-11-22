import { moduleIds, newId } from "@knotworking/core";
import {
  accountingConnections,
  accountingConfigurationEvents,
  memberModuleAccess,
  syncChanges,
  users,
  workspaceMembers,
  workspaces,
} from "@knotworking/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx, type Res } from "./test-utils";
import {
  enqueueAccountingPosting,
  claimAccountingPosting,
  confirmAccountingPosting,
} from "./accounting/outbox";
const root = "/v1/workspaces/acme/accounting";
describe("optional accounting setup", () => {
  let ctx: TestCtx, owner: string, member: string, ownerId: string, ws: string, token: string;
  const request = (method: string, path: string, json?: unknown, cookie = owner) =>
    ctx.req(root + path, { method, json, cookie });
  const ok = async (input: Res | Promise<Res>, status = 200) => {
    const response = await input;
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const create = (extra: object = {}) =>
    request("POST", "/connections", {
      commandId: newId(),
      provider: "xero",
      name: "Accounts",
      companyId: newId(),
      ...extra,
    });
  const update = (row: any, extra: object = {}) =>
    request("PATCH", `/connections/${row.id}`, {
      commandId: newId(),
      expectedRevision: row.revision,
      name: row.name,
      disabled: row.disabled,
      companyId: row.companyId,
      reason: "Reviewed setup",
      ...extra,
    });
  const map = (row: any, extra: object = {}) =>
    request("PUT", `/connections/${row.id}/mappings`, {
      commandId: newId(),
      expectedRevision: row.revision,
      kind: "account",
      localReference: "ingredients",
      externalReference: "5000",
      enabled: true,
      reason: "Reviewed by finance",
      ...extra,
    });
  const detail = (id: string) => ok(request("GET", `/connections/${id}`));
  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    owner = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    member = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    ownerId = (await ok(ctx.req("/v1/me", { cookie: owner }))).user.id;
    const [workspace] = await ctx.handle.db.select().from(workspaces).where(eq(workspaces.slug, "acme"));
    ws = workspace!.id;
    token = (
      await ok(
        ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: owner,
          json: { name: "Accounting boundary", scope: "write" },
        }),
        201,
      )
    ).token;
  }, 30000);
  afterAll(async () => {
    await ctx?.handle.close();
  });
  it("saves an optional setup without credentials/company, deduplicates commands and fixes the company once set", async () => {
    const command = { commandId: newId(), name: "Future accounts", provider: "community_ledger" };
    const row = await ok(request("POST", "/connections", command), 201);
    expect(row.companyId).toBe("");
    expect((await ok(request("POST", "/connections", command), 201)).id).toBe(row.id);
    expect((await ok(request("GET", `/connections/${row.id}/history`))).events).toHaveLength(1);
    const saved = await ok(update(row, { companyId: "company-1" }));
    expect(saved.companyId).toBe("company-1");
    await ok(update(saved, { companyId: "company-2" }), 409);
    await ok(create({ provider: "community_ledger", companyId: "company-1" }), 409);
    await ok(create({ accessToken: "do-not-store" }), 400);
  });
  it("refuses personal tokens and non-admins even with module-manage access", async () => {
    await ok(request("GET", "/connections", undefined, member), 403);
    const [m] = await ctx.handle.db.select().from(users).where(eq(users.email, "marcus@knotworking.dev"));
    await ctx.handle.db
      .insert(memberModuleAccess)
      .values({ workspaceId: ws, userId: m!.id, moduleId: "accounting", level: "manage" });
    await ok(request("GET", "/connections", undefined, member), 403);
    for (const method of ["GET", "POST"])
      await ok(
        ctx.req(root + "/connections", {
          method,
          headers: { authorization: `Bearer ${token}` },
          ...(method === "POST" ? { json: { commandId: newId(), name: "Denied", provider: "xero" } } : {}),
        }),
        403,
      );
  });
  it("rejects stale edits, provider changes and missing reasons", async () => {
    const row = await ok(create(), 201);
    const saved = await ok(update(row, { name: "Reviewed" }));
    await ok(update(row), 409);
    await ok(update(saved, { provider: "another_provider" }), 400);
    await ok(update(saved, { reason: "" }), 400);
    expect((await detail(row.id)).connection.name).toBe("Reviewed");
  });
  it("retains mapping corrections and revocations with stale-write protection", async () => {
    const row = await ok(create(), 201);
    await ok(map(row));
    await ok(map(row), 409);
    await ok(
      map((await detail(row.id)).connection, {
        externalReference: "6000",
        enabled: false,
        reason: "Mapping withdrawn",
      }),
    );
    expect((await detail(row.id)).mappings[0]).toMatchObject({ externalReference: "6000", enabled: false });
    const history = await ok(request("GET", `/connections/${row.id}/history`));
    expect(history.events.map((e: any) => e.action)).toEqual([
      "created",
      "mapping_reviewed",
      "mapping_reviewed",
    ]);
    expect(history.events[2].snapshot.before.externalReference).toBe("5000");
    expect(history.events[2].actorId).toBe(ownerId);
  });
  it("uses local records and scopes connections/mutations to the workspace", async () => {
    const row = await ok(create(), 201);
    await ok(
      ctx.req("/v1/workspaces/acme/suppliers", {
        method: "POST",
        cookie: owner,
        json: { code: "FIN-SUP", name: "Finance Supplier" },
      }),
      201,
    );
    const source = (await ok(request("GET", "/references?kind=supplier"))).references[0];
    expect(source).toBeDefined();
    await ok(map(row, { kind: "supplier", localReference: source.id }));
    const latest = (await detail(row.id)).connection;
    expect((await detail(row.id)).mappings[0].localLabel).toContain(source.name);
    await ok(map(latest, { kind: "customer", localReference: newId() }), 404);
    await ok(map(latest, { kind: "supplier", localReference: "invented" }), 400);
    const other = newId();
    await ctx.handle.db.insert(workspaces).values({ id: other, slug: "other-accounting", name: "Other" });
    await ctx.handle.db
      .insert(accountingConnections)
      .values({ id: row.id, workspaceId: other, name: "Untouched", provider: "other", companyId: "other" });
    await ctx.handle.db
      .insert(workspaceMembers)
      .values({ workspaceId: other, userId: ownerId, role: "owner" });
    await ok(
      ctx.req(`/v1/workspaces/other-accounting/accounting/connections/${row.id}/mappings`, {
        method: "PUT",
        cookie: owner,
        json: {
          commandId: newId(),
          expectedRevision: 1,
          kind: "supplier",
          localReference: source.id,
          externalReference: "bad",
          reason: "Cross tenant",
          enabled: true,
        },
      }),
      404,
    );
    await ok(update(latest, { name: "Changed here" }));
    const [unchanged] = await ctx.handle.db
      .select()
      .from(accountingConnections)
      .where(and(eq(accountingConnections.workspaceId, other), eq(accountingConnections.id, row.id)));
    expect(unchanged!.name).toBe("Untouched");
  });
  it("blocks disabled destinations while allowing reconciliation of earlier uncertain work", async () => {
    const row = await ok(create(), 201);
    const doc = {
      version: 1,
      provider: row.provider,
      connectionId: row.id,
      companyId: row.companyId,
      kind: "purchase_invoice",
      sourceId: newId(),
      sourceRevision: 1,
      supplierReference: "SUP1",
      reference: "INV1",
      date: "2026-11-15",
      currency: "GBP",
      lines: [
        { accountReference: "5000", taxReference: "T1", description: "Goods", net: "10.00", tax: "2.00" },
      ],
      net: "10.00",
      tax: "2.00",
      gross: "12.00",
    };
    const job = await enqueueAccountingPosting(ctx.handle.db, ws, ownerId, doc);
    let saved = await ok(update(row, { disabled: true }));
    await expect(claimAccountingPosting(ctx.handle.db, ws, job.id, ownerId)).rejects.toMatchObject({
      code: "accounting_conflict",
    });
    await expect(
      enqueueAccountingPosting(ctx.handle.db, ws, ownerId, { ...doc, sourceId: newId() }),
    ).rejects.toMatchObject({ code: "accounting_conflict" });
    saved = await ok(update(saved, { disabled: false }));
    const attempt = await claimAccountingPosting(ctx.handle.db, ws, job.id, ownerId);
    await ok(update(saved, { disabled: true }));
    const receipt = {
      provider: row.provider,
      connectionId: row.id,
      companyId: row.companyId,
      postingKey: job.id,
      externalId: "READ-BACK",
      currency: "GBP",
      net: "10.00",
      tax: "2.00",
      gross: "12.00",
    };
    expect(
      (
        await confirmAccountingPosting(
          ctx.handle.db,
          ws,
          job.id,
          attempt!.attemptId!,
          ownerId,
          receipt,
          "Authoritative read-back",
        )
      ).state,
    ).toBe("posted");
  });
  it("stores setup privately, with retained evidence and no shared sync records", async () => {
    const events = await ctx.handle.db
      .select()
      .from(accountingConfigurationEvents)
      .where(eq(accountingConfigurationEvents.workspaceId, ws));
    expect(events.length).toBeGreaterThan(0);
    const ids = new Set(events.map((e) => e.connectionId));
    const changes = await ctx.handle.db.select().from(syncChanges).where(eq(syncChanges.workspaceId, ws));
    expect(changes.some((c) => ids.has(c.entityId))).toBe(false);
  });
});
describe("accounting module switches", () => {
  let ctx: TestCtx;
  afterAll(async () => {
    await ctx?.handle.close();
  });
  it("hides inactive accounting and refuses references from inactive source modules", async () => {
    ctx = await makeApp({ seed: true, activeModules: moduleIds.filter((id) => id !== "accounting") });
    let cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    expect((await ctx.req(root + "/connections", { cookie })).status).toBe(404);
    await ctx.handle.close();
    ctx = await makeApp({ seed: true, activeModules: ["accounting"] });
    cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    expect((await ctx.req(root + "/connections", { cookie })).status).toBe(200);
    expect((await ctx.req(root + "/references?kind=supplier", { cookie })).status).toBe(404);
  }, 30000);
});
