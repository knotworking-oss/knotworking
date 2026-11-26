import { addDays, DEFAULT_TIME_ZONE, newId, todayInZone, type ModuleId } from "@knotworking/core";
import {
  accountingXeroCredentials,
  accountingXeroFlows,
  salesOrderLines,
  workspaceMembers,
  workspaces,
} from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchQueuedPostings } from "./accounting/dispatcher";
import { createAccountingAdapterRegistry } from "./accounting/registry";
import { createXeroConnectionService, type XeroConnectionService } from "./accounting/xero-connection";
import { xeroCallbackPath } from "./accounting/xero-http";
import { prepareDespatch } from "./despatch-test-helpers";
import { APP_URL, TEST_SECRET, makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const ws = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
const tenantId = newId(),
  organisationId = newId(),
  remoteId = newId(),
  contactId = newId(),
  otherTenant = newId(),
  otherRemoteId = newId(),
  authEventId = newId();

type Invoice = {
  InvoiceNumber: string;
  Type: "ACCPAY" | "ACCREC";
  Url: string;
  LineItems: Array<{ LineAmount: number; TaxAmount: number }>;
};
type Allocation = { Invoice: { InvoiceID: string }; Amount: number; Date: string };
type Credit = {
  CreditNoteNumber: string;
  CreditNoteID: string;
  Reference: string;
  Date: string;
  Contact: { ContactID: string };
  Type: "ACCRECCREDIT";
  Status: string;
  CurrencyCode: string;
  LineItems: Invoice["LineItems"];
  SubTotal: number;
  TotalTax: number;
  Total: number;
  Allocations: Allocation[];
};
const totals = (lines: Invoice["LineItems"]) => {
  const SubTotal = lines.reduce((n, l) => n + l.LineAmount, 0);
  const TotalTax = lines.reduce((n, l) => n + l.TaxAmount, 0);
  return { SubTotal, TotalTax, Total: Math.round((SubTotal + TotalTax) * 100) / 100 };
};
function mockXero() {
  const bills = new Map<
    string,
    Invoice & { InvoiceID: string; SubTotal: number; TotalTax: number; Total: number; AmountDue: number }
  >();
  const credits = new Map<string, Credit>();
  const keys = new Set<string>();
  const state = {
    codeExchanges: 0,
    refreshes: 0,
    revoked: false,
    denyRefresh: false,
    loseReply: false,
    loseAllocationReply: false,
    salesTaxRate: 20,
    wrongOrganisation: false,
    currency: "GBP",
    rejectBill: false,
    archivedContact: false,
    postCalls: 0,
    deletes: 0,
    /** Connections to organisations this setup didn't choose, removed after confirmation. */
    released: [] as string[],
    /** The organisation was disconnected in Xero; the refresh token still works. */
    organisationRemoved: false,
    /** Accounting API calls refused with 429 before Xero allows more. */
    rateLimited: 0,
    /** Accounting API calls refused with 401 even though the token is current. */
    expireAccess: 0,
    apiCalls: 0,
  };
  let grantedAccess = "";
  let grantedRefresh = "";
  const tokens = (expires_in: number) => {
    grantedAccess = `fixture-access-${state.codeExchanges}-${state.refreshes}`;
    grantedRefresh = `fixture-refresh-${state.codeExchanges}-${state.refreshes}`;
    return Response.json({ access_token: grantedAccess, refresh_token: grantedRefresh, expires_in });
  };
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeDefined();
    if (url.host === "identity.xero.com") {
      expect(url.pathname).toBe("/connect/token");
      expect(headers.get("authorization")).toBe(
        `Basic ${Buffer.from("fixture-client:fixture-secret").toString("base64")}`,
      );
      const body = new URLSearchParams(String(init?.body));
      if (body.get("grant_type") === "authorization_code") {
        expect(body.get("code")).toBe("fictional-code");
        expect(body.get("redirect_uri")).toBe(`${APP_URL}/api${xeroCallbackPath}`);
        state.codeExchanges++;
        return tokens(20);
      }
      state.refreshes++;
      // Revoked consent also invalidates the refresh token.
      if (state.denyRefresh || state.revoked || body.get("refresh_token") !== grantedRefresh)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return tokens(1800);
    }
    const authorization = headers.get("authorization");
    if (state.revoked || authorization !== `Bearer ${grantedAccess}`)
      return Response.json({}, { status: 401 });
    if (url.pathname === "/connections") {
      const event = url.searchParams.get("authEventId");
      if (event) expect(event).toBe(authEventId);
      return Response.json(
        [
          {
            id: remoteId,
            tenantId,
            tenantType: "ORGANISATION",
            tenantName: "Test Manufacturing",
            authEventId,
          },
          {
            id: otherRemoteId,
            tenantId: otherTenant,
            tenantType: "ORGANISATION",
            tenantName: "Other Company",
            authEventId,
          },
        ].filter((entry) => !(state.organisationRemoved && entry.tenantId === tenantId)),
      );
    }
    if (url.pathname === `/connections/${remoteId}` && init?.method === "DELETE") {
      state.deletes++;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === `/connections/${otherRemoteId}` && init?.method === "DELETE") {
      state.released.push(otherRemoteId);
      return new Response(null, { status: 204 });
    }
    expect(url.host).toBe("api.xero.com");
    expect(headers.get("xero-tenant-id")).toBe(tenantId);
    state.apiCalls++;
    if (state.organisationRemoved)
      return Response.json({ Type: "AuthorizationUnsuccessful" }, { status: 403 });
    if (state.rateLimited > 0) {
      state.rateLimited--;
      return new Response(null, { status: 429, headers: { "retry-after": "30" } });
    }
    if (state.expireAccess > 0) {
      state.expireAccess--;
      return Response.json({}, { status: 401 });
    }
    switch (url.pathname.replace("/api.xro/2.0", "")) {
      case "/Organisation":
        return Response.json({
          Organisations: [
            {
              OrganisationID: state.wrongOrganisation ? newId() : organisationId,
              Name: "Fixture Manufacturing",
              BaseCurrency: state.currency,
            },
          ],
        });
      case `/Contacts/${contactId}`:
        return Response.json({
          Contacts: [{ ContactID: contactId, ContactStatus: state.archivedContact ? "ARCHIVED" : "ACTIVE" }],
        });
      case "/Accounts":
        return Response.json({
          Accounts: [
            { Code: "7500", Status: "ACTIVE", Class: "EXPENSE" },
            { Code: "200", Status: "ACTIVE", Class: "REVENUE" },
          ],
        });
      case "/TaxRates":
        return Response.json({
          TaxRates: [
            { TaxType: "INPUT2", Status: "ACTIVE", CanApplyToExpenses: true },
            {
              TaxType: "OUTPUT2",
              Status: "ACTIVE",
              CanApplyToRevenue: true,
              EffectiveRate: state.salesTaxRate,
            },
          ],
        });
      case "/Invoices":
        if (init?.method !== "PUT") {
          expect(url.searchParams.get("ContactIDs")).toBe(contactId);
          expect(url.searchParams.get("createdByMyApp")).toBe("true");
          // An unrelated bill with the same number and a different source URL isn't evidence.
          return Response.json({
            Invoices: [...bills.values()]
              .filter((bill) => url.searchParams.get("where")?.includes(`Type=="${bill.Type}"`))
              .flatMap((bill) => [
                { ...bill, InvoiceID: newId(), Url: "https://example.invalid" },
                { ...bill, Url: undefined },
              ]),
          });
        }
        state.postCalls++;
        if (state.rejectBill)
          return Response.json(
            {
              ErrorNumber: 10,
              Type: "ValidationException",
              Elements: [{ ValidationErrors: [{ Message: "Synthetic validation failure" }] }],
            },
            { status: 400 },
          );
        {
          const key = headers.get("idempotency-key")!;
          expect(keys.has(key)).toBe(false);
          keys.add(key);
          const invoice: Invoice = JSON.parse(String(init.body)).Invoices[0];
          const InvoiceID = newId();
          const value = totals(invoice.LineItems);
          bills.set(InvoiceID, { ...invoice, InvoiceID, ...value, AmountDue: value.Total });
          if (state.loseReply) throw new Error("Simulated response lost after commit");
          return Response.json({ Invoices: [{ InvoiceID, HasErrors: false }] });
        }
      case "/CreditNotes":
        if (init?.method === "PUT") {
          state.postCalls++;
          const key = headers.get("idempotency-key")!;
          expect(keys.has(key)).toBe(false);
          keys.add(key);
          const credit = JSON.parse(String(init.body)).CreditNotes[0];
          expect(credit).not.toHaveProperty("InvoiceNumber");
          expect(credit).not.toHaveProperty("Url");
          expect(credit).not.toHaveProperty("DueDate");
          expect(credit.Type).toBe("ACCRECCREDIT");
          const CreditNoteID = newId();
          credits.set(CreditNoteID, {
            ...credit,
            ...totals(credit.LineItems),
            CreditNoteID,
            Allocations: [],
          });
          if (state.loseReply) throw new Error("Simulated lost credit response");
          return Response.json({ CreditNotes: [{ CreditNoteID, HasErrors: false }] });
        }
        return Response.json({
          CreditNotes: [...credits.values()].filter((credit) =>
            url.searchParams.get("where")?.includes(`CreditNoteNumber=="${credit.CreditNoteNumber}"`),
          ),
        });
      default: {
        const [, , , resource, id, operation] = url.pathname.split("/");
        if (resource === "Invoices") {
          const bill = bills.get(id!);
          if (bill) return Response.json({ Invoices: [bill] });
        }
        if (resource === "CreditNotes") {
          const credit = credits.get(id!);
          if (credit && !operation) return Response.json({ CreditNotes: [credit] });
          if (credit && operation === "Allocations" && init?.method === "PUT") {
            const key = headers.get("idempotency-key")!;
            expect(keys.has(key)).toBe(false);
            expect(key).toBe(`${credit.Reference.split(" ")[1]}-allocation`);
            keys.add(key);
            const allocations: Allocation[] = JSON.parse(String(init.body)).Allocations;
            expect(allocations).toHaveLength(1);
            const allocation = allocations[0]!;
            const invoice = bills.get(allocation.Invoice.InvoiceID);
            expect(invoice?.Type).toBe("ACCREC");
            expect(allocation.Amount).toBeLessThanOrEqual(invoice!.AmountDue);
            invoice!.AmountDue -= allocation.Amount;
            credit.Allocations.push(allocation);
            credit.Status = "PAID";
            if (state.loseAllocationReply) throw new Error("Simulated lost allocation response");
            return Response.json({ Allocations: allocations });
          }
        }
        throw new Error(`Unexpected request to ${url.pathname}`);
      }
    }
  });
  return { state, fetch, keys, bills, credits };
}

describe("connected Xero accounting against a fake HTTP provider", () => {
  const xero = mockXero();
  let ctx: TestCtx, service: XeroConnectionService, owner: string, otherSession: string, member: string;
  let workspaceId: string, connectionId: string, supplierId: string, itemId: string, locationId: string;
  const send = (method: string, path: string, json?: unknown, cookie = owner) =>
    ctx.req(ws + path, { method, json, cookie });
  const ok = async (res: Promise<Res>, status = 200) => {
    const response = await res;
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const connection = () => `/accounting/connections/${connectionId}`;
  const oauth = () => `${connection()}/xero`;
  const getConnection = async () => (await ok(send("GET", connection()))).connection;
  const provider = () => createAccountingAdapterRegistry({ xero: service.adapter });
  const start = async () => {
    const { authorizationUrl } = await ok(send("POST", `${oauth()}/start`));
    const url = new URL(authorizationUrl);
    expect(url.origin).toBe("https://login.xero.com");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "offline_access",
      "accounting.invoices",
      "accounting.settings.read",
      "accounting.contacts.read",
    ]);
    return `${xeroCallbackPath}?state=${url.searchParams.get("state")}&code=fictional-code`;
  };
  const callback = async (url: string) => {
    const response = await ctx.req(url, { cookie: owner });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${APP_URL}/acme/settings/accounting?connection=${connectionId}`,
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toContain("no-store");
  };
  const select = async () => {
    const { pending } = await ok(send("GET", oauth()));
    const review = await ok(send("POST", `${oauth()}/review`, { flowId: pending.id, tenantId }));
    return {
      flowId: pending.id,
      tenantId,
      organisationId: review.organisationId,
      baseCurrency: review.baseCurrency,
      expectedRevision: (await getConnection()).revision,
      commandId: newId(),
    };
  };
  const connect = async () => {
    await callback(await start());
    await ok(send("POST", `${oauth()}/confirm`, await select()));
  };
  const setModules = (enabledModules: ModuleId[] | null) =>
    ctx.handle.db.update(workspaces).set({ enabledModules }).where(eq(workspaces.id, workspaceId));
  async function disable(disabled: boolean) {
    const { name, companyId, revision } = await getConnection();
    await ok(
      send("PATCH", connection(), {
        name,
        companyId,
        disabled,
        expectedRevision: revision,
        commandId: newId(),
        reason: "Review dispatch controls",
      }),
    );
  }

  beforeAll(async () => {
    ctx = await makeApp({
      seed: true,
      xero: (db) =>
        (service = createXeroConnectionService(db, {
          clientId: "fixture-client",
          clientSecret: "fixture-secret",
          fetch: xero.fetch,
          appUrl: APP_URL,
          secret: TEST_SECRET,
        })),
    });
    const signedIn = await signIn(ctx, "ada@knotworking.dev");
    owner = signedIn.cookie;
    otherSession = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    member = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const [workspace] = await ctx.handle.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, "acme"));
    workspaceId = workspace!.id;
    const otherWorkspace = newId();
    await ctx.handle.db
      .insert(workspaces)
      .values({ id: otherWorkspace, name: "Other workspace", slug: "other-xero" });
    await ctx.handle.db
      .insert(workspaceMembers)
      .values({ workspaceId: otherWorkspace, userId: signedIn.body.user.id, role: "owner" });
    connectionId = (
      await ok(
        send("POST", "/accounting/connections", {
          commandId: newId(),
          name: "Fixture business",
          provider: "xero",
        }),
        201,
      )
    ).id;
    supplierId = (await ok(send("POST", "/suppliers", { name: "Fixture supplier" }), 201)).id;
    await ok(send("POST", `/suppliers/${supplierId}/approval`, { status: "approved" }));
    itemId = (
      await ok(
        send("POST", "/items", {
          code: "XERO-1",
          name: "Fixture stock",
          type: "ingredient",
          unit: "kg",
          standardCost: 10,
        }),
        201,
      )
    ).id;
    locationId = (await ok(send("POST", "/stock/locations", { name: "Fixture warehouse" }), 201)).id;
  }, 120_000);
  afterAll(() => ctx?.handle.close());

  it("binds one-time OAuth state to the initiating session and workspace and requires explicit confirmation", async () => {
    await ok(send("POST", `${oauth()}/start`, undefined, member), 403);
    const { token } = await ok(
      ctx.req("/v1/me/api-tokens", {
        method: "POST",
        json: { name: "Agent", scope: "write" },
        cookie: owner,
      }),
      201,
    );
    await ok(
      ctx.req(ws + `${oauth()}/start`, { method: "POST", headers: { authorization: `Bearer ${token}` } }),
      403,
    );
    const url = await start();
    const [stored] = await ctx.handle.db.select().from(accountingXeroFlows);
    expect(stored?.stateHash).not.toBe(new URL(url, APP_URL).searchParams.get("state"));
    await ok(ctx.req(url, { cookie: otherSession }), 409);
    await ok(ctx.req(url), 401);
    await setModules(["items", "purchasing"]);
    await ok(ctx.req(url, { cookie: owner }), 404);
    await setModules(null);
    expect(xero.state.codeExchanges).toBe(0);
    await callback(url);
    await ok(ctx.req(url, { cookie: owner }), 409);
    const { pending, status } = await ok(send("GET", oauth()));
    expect(status).toBe("disconnected");
    expect(pending.tenants.map((t: { id: string }) => t.id)).toEqual([tenantId, otherTenant]);
    expect((await ok(send("GET", oauth(), undefined, otherSession))).pending).toBeNull();
    await ok(ctx.req(`/v1/workspaces/other-xero${oauth()}`, { cookie: owner }), 404);
    expect(await ctx.handle.db.select().from(accountingXeroCredentials)).toEqual([]);
    const review = await select();
    await ok(send("POST", `${oauth()}/confirm`, { ...review, baseCurrency: "USD" }), 409);
    await ok(send("POST", `${oauth()}/confirm`, review, otherSession), 409);
    await ok(send("POST", `${oauth()}/confirm`, review));
    await ok(send("POST", `${oauth()}/confirm`, review));
    expect((await getConnection()).companyId).toBe(tenantId);
    const [grant] = await ctx.handle.db.select().from(accountingXeroCredentials);
    expect(grant?.ciphertext).toMatch(/^v1\./);
    expect(JSON.stringify(grant)).not.toMatch(/fixture-access|fixture-refresh/);
    expect(await ctx.handle.db.select().from(accountingXeroFlows)).toEqual([]);
    // The other organisation authorised in the same sign-in is removed from Xero.
    expect(xero.state.released).toEqual([otherRemoteId]);
  });

  it("rotates once under concurrent verification and handles revoked consent without rebinding", async () => {
    const before = xero.state.refreshes;
    await Promise.all([1, 2].map(() => ok(send("POST", `${oauth()}/verify`))));
    expect(xero.state.refreshes - before).toBe(1);
    xero.state.revoked = true;
    expect((await ok(send("POST", `${oauth()}/verify`), 409)).error.code).toBe("xero_reconnect_required");
    expect((await ok(send("GET", oauth()))).status).toBe("reconnect_required");
    xero.state.revoked = false;
    await callback(await start());
    const { pending } = await ok(send("GET", oauth()));
    expect(pending.tenants.map((t: { id: string }) => t.id)).toEqual([tenantId]);
    await ok(send("POST", `${oauth()}/review`, { flowId: pending.id, tenantId: otherTenant }), 409);
    await ok(send("POST", `${oauth()}/confirm`, await select()));
    xero.state.denyRefresh = true;
    expect((await ok(send("POST", `${oauth()}/verify`), 409)).error.code).toBe("xero_reconnect_required");
    xero.state.denyRefresh = false;
    await connect();
  });

  async function enqueue(reference: string, stock: boolean) {
    const orderLine = stock
      ? { itemId, quantity: 2, unit: "kg", unitPrice: 10 }
      : {
          kind: "non_stock",
          description: "Equipment service",
          quantity: 2,
          unitPrice: 10,
          nominalCode: "expense",
        };
    const order = await ok(
      send("POST", "/purchasing/orders", {
        supplierId,
        expectedOn: today,
        ...(stock ? { deliveryLocationId: locationId } : {}),
        lines: [orderLine],
      }),
      201,
    );
    await ok(send("POST", `/purchasing/orders/${order.id}/send`, {}));
    const orderLineId = order.lines[0].id;
    const received = await ok(
      send("POST", `/purchasing/orders/${order.id}/receipts`, {
        receivedOn: today,
        lines: [{ lineId: orderLineId, outcome: "accepted", quantity: 2 }],
      }),
      201,
    );
    expect(received.order.state).toBe("received");
    if (stock) expect(received.receipts[0].stockMovementId).toBeTruthy();
    else expect(received.receipts[0].stockMovementId).toBeNull();
    const invoice = await ok(
      send("POST", "/purchasing/invoices", {
        supplierId,
        invoiceNumber: reference,
        invoiceDate: today,
        dueDate: today,
        vat: 4,
        lines: [{ kind: "order", orderLineId, quantity: 2, unitPrice: 10 }],
      }),
      201,
    );
    expect(invoice).toMatchObject({ matchStatus: "matched", gross: 24 });
    await ok(
      send("POST", `/purchasing/invoices/${invoice.id}/approve`, { reason: "Matched to the receipt" }),
    );
    const entry = await ok(
      send("POST", `${connection()}/purchase-invoices/${invoice.id}/prepare`, {
        expectedRevision: (await getConnection()).revision,
        commandId: newId(),
        reason: "Reviewed for Xero",
        lines: [
          {
            invoiceLineId: invoice.lines[0].id,
            accountKey: "expense",
            taxKey: "input",
            description: stock ? "Fixture stock" : "Equipment service",
            net: "20.00",
            tax: "4.00",
          },
        ],
      }),
      201,
    );
    return { invoiceId: invoice.id, path: `${connection()}/postings/${entry.id}`, id: entry.id };
  }

  it("posts a matched stock bill and a matched service bill with Stock disabled", async () => {
    for (const [kind, localReference, externalReference] of [
      ["supplier", supplierId, contactId],
      ["account", "expense", "7500"],
      ["tax", "input", "INPUT2"],
    ]) {
      await ok(
        send("PUT", `${connection()}/mappings`, {
          commandId: newId(),
          expectedRevision: (await getConnection()).revision,
          kind,
          localReference,
          externalReference,
          reason: "Reviewed against the fake organisation",
        }),
      );
    }
    const purchase = await enqueue("STOCK-1", true);
    const origin = xero.state.postCalls;
    await Promise.all([1, 2].map(() => dispatchQueuedPostings(ctx.handle.db, provider())));
    expect(xero.state.postCalls - origin).toBe(1);
    const stock = await ok(send("GET", purchase.path));
    expect(stock.posting).toMatchObject({
      state: "posted",
      attempts: 1,
      receipt: { net: "20.00", tax: "4.00", gross: "24.00", companyId: tenantId },
    });
    expect(xero.bills.get(stock.posting.externalId)).toMatchObject({
      Url: `${APP_URL}/acme/purchasing/invoices/${purchase.invoiceId}?accountingPosting=${purchase.id}`,
      LineItems: [{ AccountCode: "7500", TaxType: "INPUT2", TaxAmount: 4 }],
      Contact: { ContactID: contactId },
    });
    await setModules(["items", "purchasing", "accounting"]);
    const nonStock = await enqueue("SERVICE-1", false);
    const result = await ok(send("POST", `${nonStock.path}/send`));
    expect(result.posting).toMatchObject({
      state: "posted",
      receipt: { gross: "24.00", postingKey: nonStock.id },
    });
    expect(xero.bills.get(result.posting.externalId)?.Url).toContain(nonStock.invoiceId);
  });

  it("recovers a lost create response by finding and verifying the original Xero bill", async () => {
    const prepared = await enqueue("SERVICE-LOST", false);
    xero.state.loseReply = true;
    const originalCount = xero.bills.size;
    const sent = await ok(send("POST", `${prepared.path}/send`));
    xero.state.loseReply = false;
    expect(sent.posting).toMatchObject({ state: "unknown", externalId: null });
    await dispatchQueuedPostings(ctx.handle.db, provider());
    expect(xero.bills.size).toBe(originalCount + 1);
    const recovered = await ok(
      send("POST", `${prepared.path}/read-back`, {
        attemptId: sent.posting.attemptId,
        reason: "Verified the original bill after the interrupted response",
      }),
    );
    expect(recovered.posting).toMatchObject({
      state: "posted",
      attempts: 1,
      receipt: { postingKey: prepared.id, gross: "24.00" },
    });
    expect(xero.keys.has(prepared.id)).toBe(true);
    expect(xero.bills.size).toBe(originalCount + 1);
  });

  it("holds disabled postings and refuses a wrong organisation, inactive mappings and definitive Xero rejections", async () => {
    const prepared = await enqueue("SERVICE-NOWRITE", false);
    const writes = xero.state.postCalls;
    await disable(true);
    await ok(send("POST", `${prepared.path}/send`), 409);
    expect((await dispatchQueuedPostings(ctx.handle.db, provider())).posted).toBe(0);
    expect((await ok(send("GET", prepared.path))).posting.state).toBe("queued");
    expect(xero.state.postCalls).toBe(writes);
    await disable(false);
    async function rejectedThenRequeue() {
      const sent = await ok(send("POST", `${prepared.path}/send`));
      expect(sent.posting.state).toBe("failed");
      await ok(
        send("POST", `${prepared.path}/retry`, {
          attemptId: sent.posting.attemptId,
          reason: "Preflight corrected",
        }),
      );
    }
    xero.state.wrongOrganisation = true;
    await rejectedThenRequeue();
    xero.state.wrongOrganisation = false;
    xero.state.archivedContact = true;
    await rejectedThenRequeue();
    xero.state.archivedContact = false;
    expect(xero.state.postCalls).toBe(writes);
    const count = xero.bills.size;
    xero.state.rejectBill = true;
    const sent = await ok(send("POST", `${prepared.path}/send`));
    xero.state.rejectBill = false;
    expect(sent.posting.state).toBe("failed");
    expect(xero.state.postCalls).toBe(writes + 1);
    expect(xero.bills.size).toBe(count);
    expect(sent.history.at(-1).evidence).not.toContain("Synthetic validation failure");
  });

  it("disconnects only the verified Xero connection and can reconnect the same destination", async () => {
    const input = { expectedRevision: (await getConnection()).revision, commandId: newId() };
    expect(await ok(send("POST", `${oauth()}/disconnect`, input))).toEqual({ remoteRemoved: true });
    expect(await ok(send("POST", `${oauth()}/disconnect`, input))).toEqual({ remoteRemoved: true });
    expect(xero.state.deletes).toBe(1);
    expect((await ok(send("GET", oauth()))).status).toBe("disconnected");
    const [grant] = await ctx.handle.db.select().from(accountingXeroCredentials);
    expect(grant).toMatchObject({ ciphertext: null, remoteConnectionId: null, tenantId, organisationId });
    expect((await getConnection()).companyId).toBe(tenantId);
    // A disconnected setup installs no adapter: queued bills wait and nothing reaches Xero.
    const held = await enqueue("SERVICE-HELD", false);
    const writes = xero.state.postCalls;
    expect((await dispatchQueuedPostings(ctx.handle.db, provider())).skipped).toBeGreaterThan(0);
    expect((await ok(send("POST", `${held.path}/send`), 409)).error.code).toBe("adapter_not_installed");
    expect((await ok(send("GET", held.path))).posting.state).toBe("queued");
    expect(xero.state.postCalls).toBe(writes);
    await connect();
    expect((await ok(send("GET", oauth()))).status).toBe("connected");
    await dispatchQueuedPostings(ctx.handle.db, provider());
    expect((await ok(send("GET", held.path))).posting).toMatchObject({ state: "posted", attempts: 1 });
    expect(xero.state.postCalls).toBe(writes + 1);
  });

  it("refreshes once when Xero refuses a current access token, without reconnecting", async () => {
    const prepared = await enqueue("SERVICE-401", false);
    const refreshes = xero.state.refreshes;
    xero.state.expireAccess = 1;
    expect(await dispatchQueuedPostings(ctx.handle.db, provider())).toMatchObject({ posted: 1 });
    expect(xero.state.expireAccess).toBe(0);
    expect(xero.state.refreshes - refreshes).toBe(1);
    expect((await ok(send("GET", prepared.path))).posting).toMatchObject({ state: "posted", attempts: 1 });
    expect((await ok(send("GET", oauth()))).status).toBe("connected");
  });

  it("keeps bills queued and holds the organisation for the pass when Xero rate-limits", async () => {
    const first = await enqueue("SERVICE-429-A", false);
    const second = await enqueue("SERVICE-429-B", false);
    const writes = xero.state.postCalls;
    xero.state.rateLimited = 1;
    const calls = xero.state.apiCalls;
    expect(await dispatchQueuedPostings(ctx.handle.db, provider())).toMatchObject({
      posted: 0,
      deferred: 1,
      skipped: 1,
    });
    // The second bill makes no request once the first one met the limit.
    expect(xero.state.apiCalls - calls).toBe(1);
    expect(xero.state.postCalls).toBe(writes);
    const held = await ok(send("GET", first.path));
    expect(held.posting.state).toBe("queued");
    expect(held.history.at(-1)).toMatchObject({ action: "deferred" });
    expect((await ok(send("GET", second.path))).posting.state).toBe("queued");
    expect(await dispatchQueuedPostings(ctx.handle.db, provider())).toMatchObject({ posted: 2 });
    expect(xero.state.postCalls).toBe(writes + 2);
  });

  it("asks for a reconnect when the organisation was disconnected in Xero, and sweeps expired sign-ins", async () => {
    const prepared = await enqueue("SERVICE-403", false);
    const writes = xero.state.postCalls;
    xero.state.organisationRemoved = true;
    expect(await dispatchQueuedPostings(ctx.handle.db, provider())).toMatchObject({ deferred: 1 });
    const detail = await ok(send("GET", prepared.path));
    expect(detail.posting.state).toBe("queued");
    expect(detail.history.at(-1).evidence).toContain("no longer connected");
    expect((await ok(send("GET", oauth()))).status).toBe("reconnect_required");
    expect(xero.state.postCalls).toBe(writes);
    xero.state.organisationRemoved = false;
    // An abandoned sign-in attempt is deleted, with its unconfirmed credentials, once it expires.
    await start();
    await ctx.handle.db.update(accountingXeroFlows).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await service.sweepExpiredAttempts()).toBe(1);
    expect(await ctx.handle.db.select().from(accountingXeroFlows)).toEqual([]);
    await connect();
    expect(await dispatchQueuedPostings(ctx.handle.db, provider())).toMatchObject({ posted: 1 });
    expect((await ok(send("GET", prepared.path))).posting).toMatchObject({ state: "posted", attempts: 2 });
  });

  async function billingCustomer(code: string) {
    return ok(
      send("POST", "/customers", { code, name: `Customer ${code}`, address: "10 Fixture Road" }),
      201,
    );
  }

  async function mapCustomer(customerId: string) {
    for (const [kind, localReference, externalReference] of [
      ["customer", customerId, contactId],
      ["account", "revenue", "200"],
      ["tax", "output", "OUTPUT2"],
    ]) {
      await ok(
        send("PUT", `${connection()}/mappings`, {
          commandId: newId(),
          expectedRevision: (await getConnection()).revision,
          kind,
          localReference,
          externalReference,
          reason: "Reviewed against the fake organisation",
        }),
      );
    }
  }

  const terms = () => ({
    commandId: newId(),
    date: today,
    dueDate: addDays(today, 30),
    issuerAddress: "2 Fixture Street",
  });
  const draft = (kind: "sales" | "despatch" | "service", sourceId: string) =>
    send("POST", "/invoicing", { ...terms(), kind, sourceId });
  const decision = (
    doc: { id: string; revision: number },
    action: "issue" | "discard" = "issue",
    cookie = owner,
  ) =>
    send(
      "POST",
      `/invoicing/${doc.id}/decision`,
      {
        action,
        commandId: newId(),
        expectedRevision: doc.revision,
        reason: "Checked against approved source",
      },
      cookie,
    );

  async function price(
    doc: { id: string; revision: number; lines: { id: string; unitPrice: string }[] },
    manual?: string,
  ) {
    return ok(
      send("PATCH", `/invoicing/${doc.id}`, {
        ...terms(),
        expectedRevision: doc.revision,
        pricing: doc.lines.map((line) => ({ id: line.id, unitPrice: manual ?? line.unitPrice, taxRate: 20 })),
      }),
    );
  }

  async function prepareCustomer(
    doc: { id: string; kind: string; lines: { id: string }[] },
    allocate = false,
  ) {
    const path = `${connection()}/customer-documents/${doc.id}/prepare`;
    const input = {
      commandId: newId(),
      expectedRevision: (await getConnection()).revision,
      reason: "Finance verified the coding",
      lines:
        doc.kind === "credit"
          ? []
          : doc.lines.map((line) => ({ id: line.id, accountKey: "revenue", taxKey: "output" })),
      allocate,
    };
    const one = await ok(send("POST", path, input), 201);
    expect(await ok(send("POST", path, input), 201)).toEqual(one);
    expect(await ok(send("POST", path, { ...input, commandId: newId() }), 201)).toEqual(one);
    return { ...one, path: `${connection()}/postings/${one.id}` };
  }

  it("reserves partial shipments once across sales and despatch, then posts and allocates a linked credit", async () => {
    await setModules(["customers", "items", "stock", "despatch", "sales", "invoicing", "accounting"]);
    const customer = await billingCustomer("SHIP-BILL");
    const finishedItem = await ok(
      send("POST", "/items", {
        code: "SHIP-FIXTURE",
        name: "Fixture tea",
        type: "finished",
        unit: "kg",
      }),
      201,
    );
    const lot = await ok(
      send("POST", "/stock/receipts", {
        itemId: finishedItem.id,
        locationId,
        lotCode: "SHIP-LOT",
        quantity: 10,
        unit: "kg",
        receivedOn: today,
        reason: "Fixture stock",
        expiresOn: addDays(today, 20),
        expiryType: "best_before",
      }),
      201,
    );
    const order = await ok(
      send("POST", "/sales/orders", {
        commandId: newId(),
        kind: "order",
        document: {
          customerId: customer.id,
          currency: "GBP",
          lines: [{ itemId: finishedItem.id, quantity: 10, unit: "kg", unitPrice: 12.5, dueOn: today }],
        },
      }),
      201,
    );
    let confirmed = await ok(
      send("POST", `/sales/orders/${order.id}/confirm`, {
        commandId: newId(),
        expectedRevision: order.revision,
        reason: "Reviewed",
      }),
    );
    await ok(draft("sales", order.id), 409);
    async function ship(quantity: number) {
      const delivery = await ok(
        send("POST", "/despatch", {
          customerId: customer.id,
          despatchedOn: today,
          lines: [{ lotId: lot.id, locationId, quantity, unit: "kg" }],
        }),
        201,
      );
      const ready = await prepareDespatch(send, delivery.id);
      expect(ready.error).toBeUndefined();
      await ok(
        send("POST", `/despatch/${delivery.id}/confirm`, {
          commandId: newId(),
          expectedUpdatedAt: ready.stamp,
        }),
      );
      confirmed = await ok(
        send("POST", `/sales/orders/${order.id}/fulfilments`, {
          commandId: newId(),
          expectedRevision: confirmed.revision,
          orderLineId: order.lines[0].id,
          despatchLineId: delivery.lines[0].id,
          reason: "Matched the physical shipment",
        }),
      );
      return delivery;
    }

    const first = await ship(4);
    const candidates = await Promise.all([draft("sales", order.id), draft("sales", order.id)]);
    expect(candidates.map((response) => response.status).sort()).toEqual([201, 409]);
    const originalDraft = await candidates.find((response) => response.status === 201)!.json();
    expect(originalDraft).toMatchObject({
      sourceId: order.id,
      net: "50.00",
      lines: [{ sourceLineId: first.lines[0].id, quantity: "4000", unit: "g" }],
    });
    const voidFirst = () =>
      send("POST", `/despatch/${first.id}/void`, { commandId: newId(), reason: "Recording correction" });
    expect((await ok(voidFirst(), 409)).error.message).toContain("Discard the invoice draft");
    const amended = await ok(
      send("POST", `/sales/orders/${order.id}/amend`, {
        commandId: newId(),
        expectedRevision: confirmed.revision,
        document: {
          customerId: customer.id,
          currency: "GBP",
          lines: [
            {
              id: order.lines[0].id,
              itemId: finishedItem.id,
              quantity: 11,
              unit: "kg",
              unitPrice: 13,
              dueOn: today,
            },
          ],
        },
        reason: "Correct order terms",
      }),
      409,
    );
    expect(amended.error.message).toContain("A reserved sales line");
    const priced = await price(originalDraft);
    await ctx.handle.db
      .update(salesOrderLines)
      .set({ unitPrice: 13 })
      .where(eq(salesOrderLines.id, order.lines[0].id));
    expect((await ok(decision(priced), 409)).error.message).toContain("A sales line changed after drafting");
    await ctx.handle.db
      .update(salesOrderLines)
      .set({ unitPrice: 12.5 })
      .where(eq(salesOrderLines.id, order.lines[0].id));
    await ok(draft("despatch", first.id), 409);
    const invoice = await ok(decision(priced));
    expect(invoice).toMatchObject({ status: "issued", net: "50.00", tax: "10.00", gross: "60.00" });
    expect((await ok(voidFirst(), 409)).error.message).toContain("Issue a credit note");
    await ok(draft("despatch", first.id), 409);
    await ok(draft("sales", order.id), 409);
    const second = await ship(6);
    expect((await ok(draft("despatch", second.id), 409)).error.message).toContain("from the sales order");
    const secondDraft = await ok(draft("sales", order.id), 201);
    expect(secondDraft).toMatchObject({
      currency: "GBP",
      net: "75.00",
      lines: [{ sourceLineId: second.lines[0].id, quantity: "6000", priceLocked: true }],
    });
    await ok(decision(secondDraft, "discard"));
    expect(await ok(draft("sales", order.id), 201)).toMatchObject({ net: "75.00" });

    await mapCustomer(customer.id);
    const posting = await prepareCustomer(invoice);
    xero.state.salesTaxRate = 5;
    const rejected = await ok(send("POST", `${posting.path}/send`));
    expect(rejected.posting.state).toBe("failed");
    expect(rejected.history.at(-1).evidence).toContain("is not 5%");
    xero.state.salesTaxRate = 20;
    await ok(
      send("POST", `${posting.path}/retry`, {
        attemptId: rejected.posting.attemptId,
        reason: "Corrected the Xero tax rate",
      }),
    );
    xero.state.rateLimited = 1;
    expect((await ok(send("POST", `${posting.path}/send`))).posting.state).toBe("queued");
    const posted = (await ok(send("POST", `${posting.path}/send`))).posting;
    expect(posted).toMatchObject({
      state: "posted",
      receipt: { net: "50.00", tax: "10.00", gross: "60.00" },
    });
    expect(xero.bills.get(posted.externalId)).toMatchObject({
      InvoiceNumber: invoice.number,
      Type: "ACCREC",
      Contact: { ContactID: contactId },
      Url: `${APP_URL}/acme/invoicing/${invoice.id}?accountingPosting=${posting.id}`,
      LineItems: [{ AccountCode: "200", TaxType: "OUTPUT2", TaxAmount: 10 }],
    });

    const correction = {
      kind: "credit",
      sourceId: invoice.id,
      commandId: newId(),
      date: today,
      reason: "Customer returned the shipment",
      lineIds: [invoice.lines[0].id],
    };
    const creditDraft = await ok(send("POST", "/invoicing", correction), 201);
    expect((await ok(voidFirst(), 409)).error.message).toContain("Issue a credit note");
    const credit = await ok(decision(creditDraft));
    expect(await ok(voidFirst())).toMatchObject({ status: "voided" });
    await ok(send("POST", "/invoicing", { ...correction, commandId: newId() }), 409);
    await ok(
      send("PATCH", `/invoicing/${invoice.id}`, { ...terms(), expectedRevision: invoice.revision }),
      409,
    );
    expect(await ok(send("GET", `/invoicing/${invoice.id}`))).toMatchObject({
      credits: [{ id: credit.id, number: credit.number, gross: "60.00", status: "issued" }],
    });
    expect(credit).toMatchObject({
      creditOf: invoice.id,
      sourceReference: invoice.number,
      creditReason: correction.reason,
    });
    const creditPosting = await prepareCustomer(credit, true);
    xero.state.loseAllocationReply = true;
    const unknown = (await ok(send("POST", `${creditPosting.path}/send`))).posting;
    xero.state.loseAllocationReply = false;
    expect(unknown).toMatchObject({ state: "unknown", externalId: null });
    const [remoteCredit] = [...xero.credits.values()];
    expect(remoteCredit).toMatchObject({
      CreditNoteNumber: credit.number,
      Contact: { ContactID: contactId },
      Reference: `KW ${creditPosting.id} / ${invoice.number}`,
      SubTotal: 50,
      TotalTax: 10,
      Total: 60,
      Allocations: [{ Invoice: { InvoiceID: posted.externalId }, Amount: 60, Date: today }],
    });
    expect(xero.bills.get(posted.externalId)?.AmountDue).toBe(0);
    expect(xero.keys.has(`${creditPosting.id}-allocation`)).toBe(true);
    const remoteCount = xero.state.postCalls;
    await dispatchQueuedPostings(ctx.handle.db, provider());
    const recovered = await ok(
      send("POST", `${creditPosting.path}/read-back`, {
        attemptId: unknown.attemptId,
        reason: "Verified the allocated credit after the response was lost",
      }),
    );
    expect(recovered.posting).toMatchObject({
      state: "posted",
      externalId: remoteCredit!.CreditNoteID,
      receipt: { net: "50.00", tax: "10.00", gross: "60.00" },
    });
    expect(xero.state.postCalls).toBe(remoteCount);
    expect(xero.credits.size).toBe(1);
  }, 30_000);

  it("bills signed-off hours without Stock, preserves the CSV and recovers a lost ACCREC response", async () => {
    await setModules(["tasks", "time", "customers", "client_services", "invoicing", "accounting"]);
    const boot = await ok(send("GET", "/bootstrap"));
    const {
      user: { id: leadId },
    } = await ok(ctx.req("/v1/me", { cookie: owner }));
    const teamId = boot.teams[0].id;
    const customer = await billingCustomer("SERV-BILL");
    const quote = await ok(
      send("POST", "/client-services", {
        commandId: newId(),
        customerId: customer.id,
        title: "Fictional commissioning",
        scope: "Prepare a fictional process report",
        currency: "GBP",
        unitPrice: 100,
        quotedMinutes: 120,
        deliveryDate: today,
      }),
      201,
    );
    await ok(draft("service", quote.id), 409);
    const decide = (revision: number, action: string, more = {}) =>
      ok(
        send("POST", `/client-services/${quote.id}/decision`, {
          commandId: newId(),
          expectedRevision: revision,
          action,
          reason: "Fixture sign-off",
          ...more,
        }),
      );
    const issued = await decide(quote.revision, "issue");
    const accepted = await decide(issued.revision, "accept", { teamId, leadId });
    const task = await ok(
      send("POST", "/tasks", { title: "Prepare the report", teamId, projectId: accepted.projectId }),
      201,
    );
    await ok(send("POST", `/tasks/${task.id}/time-entries`, { minutes: 100 }), 201);
    await decide(accepted.revision, "deliver", { approvedMinutes: 91 });
    const csv = await send("GET", `/client-services/${quote.id}/billing-draft.csv`);
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain("Hourly,91,100,GBP,151.67");
    const fromQuote = await ok(draft("service", quote.id), 201);
    expect(fromQuote).toMatchObject({ sourceId: quote.id, net: "151.67" });
    await ok(draft("service", quote.id), 409);
    const invoice = await ok(decision(await price(fromQuote)));
    await mapCustomer(customer.id);
    const posting = await prepareCustomer(invoice);
    xero.state.loseReply = true;
    const unknown = (await ok(send("POST", `${posting.path}/send`))).posting;
    xero.state.loseReply = false;
    expect(unknown).toMatchObject({ state: "unknown", attempts: 1 });
    const remote = [...xero.bills.values()].find((entry) => entry.Url.includes(invoice.id))!;
    const count = xero.state.postCalls;
    const recovered = await ok(
      send("POST", `${posting.path}/read-back`, {
        attemptId: unknown.attemptId,
        reason: "Matched the signed-off job to the Xero invoice",
      }),
    );
    expect(recovered.posting).toMatchObject({
      state: "posted",
      externalId: remote.InvoiceID,
      receipt: { net: "151.67", tax: "30.33", gross: "182.00" },
    });
    expect(remote.Url).toBe(`${APP_URL}/acme/invoicing/${invoice.id}?accountingPosting=${posting.id}`);
    expect(xero.state.postCalls).toBe(count);

    const credit = await ok(
      decision(
        await ok(
          send("POST", "/invoicing", {
            kind: "credit",
            sourceId: invoice.id,
            commandId: newId(),
            date: today,
            reason: "Withdraw the fictional service charge",
            lineIds: [invoice.lines[0].id],
          }),
          201,
        ),
      ),
    );
    const creditPosting = await prepareCustomer(credit);
    xero.state.loseReply = true;
    const interrupted = (await ok(send("POST", `${creditPosting.path}/send`))).posting;
    xero.state.loseReply = false;
    expect(interrupted).toMatchObject({ state: "unknown", attempts: 1 });
    const verified = (
      await ok(
        send("POST", `${creditPosting.path}/read-back`, {
          attemptId: interrupted.attemptId,
          reason: "Read the existing on-account credit back",
        }),
      )
    ).posting;
    expect(verified).toMatchObject({
      state: "posted",
      attempts: 1,
      receipt: {
        net: "151.67",
        tax: "30.33",
        gross: "182.00",
      },
    });
    expect(xero.credits.get(verified.externalId)?.Allocations).toEqual([]);
    expect(xero.state.postCalls).toBe(count + 1);
  }, 30_000);

  it("checks revenue coding at prepare and re-prepares a customer posting Xero rejected", async () => {
    await setModules(["customers", "invoicing", "accounting"]);
    const customer = await billingCustomer("RECODE-BILL");
    await mapCustomer(customer.id);
    await ok(
      send("PUT", `${connection()}/mappings`, {
        commandId: newId(),
        expectedRevision: (await getConnection()).revision,
        kind: "account",
        localReference: "purchases",
        externalReference: "7500",
        reason: "Supplier bill coding shares the account mappings",
      }),
    );
    const invoice = await ok(
      decision(
        await ok(
          send("POST", "/invoicing", {
            ...terms(),
            kind: "manual",
            customerId: customer.id,
            currency: "GBP",
            lines: [
              { description: "Fixture survey", unit: "", quantity: "1", unitPrice: "100", taxRate: 20 },
            ],
          }),
          201,
        ),
      ),
    );
    const path = `${connection()}/customer-documents/${invoice.id}/prepare`;
    const coded = async (accountKey: string) =>
      send("POST", path, {
        commandId: newId(),
        expectedRevision: (await getConnection()).revision,
        reason: "Finance verified the coding",
        lines: [{ id: invoice.lines[0].id, accountKey, taxKey: "output" }],
        allocate: false,
      });
    expect((await ok(coded("purchases"), 409)).error.message).toContain("active Xero revenue account");
    xero.state.salesTaxRate = 5;
    expect((await ok(coded("revenue"), 409)).error.message).toContain("effective rate of 20%");
    xero.state.salesTaxRate = 20;
    const posting = await prepareCustomer(invoice);
    const posted = (await ok(send("POST", `${posting.path}/send`))).posting;
    expect(posted.state).toBe("posted");

    const credit = await ok(
      decision(
        await ok(
          send("POST", "/invoicing", {
            kind: "credit",
            sourceId: invoice.id,
            commandId: newId(),
            date: today,
            reason: "Survey cancelled",
            lineIds: [invoice.lines[0].id],
          }),
          201,
        ),
      ),
    );
    const allocated = await prepareCustomer(credit, true);
    // The customer paid in Xero before the credit was sent: allocation is no longer possible.
    xero.bills.get(posted.externalId)!.AmountDue = 0;
    const rejected = await ok(send("POST", `${allocated.path}/send`));
    expect(rejected.posting.state).toBe("failed");
    expect(rejected.history.at(-1).evidence).toContain("outstanding balance");
    expect((await ok(send("GET", `${connection()}/customer-documents/${credit.id}`))).posting).toMatchObject({
      id: allocated.id,
      state: "failed",
    });
    const onAccount = await prepareCustomer(credit, false);
    expect(onAccount).toMatchObject({ id: allocated.id, state: "queued" });
    const requeued = await ok(send("GET", onAccount.path));
    expect(requeued.history.map((event: { action: string }) => event.action)).toEqual([
      "queued",
      "dispatch_started",
      "rejected",
      "reprepared",
    ]);
    expect(requeued.history.at(-1).supersededPayload.originalInvoice.allocate).toBe(true);
    expect(requeued.posting.payload.originalInvoice.allocate).toBe(false);
    const sent = (await ok(send("POST", `${onAccount.path}/send`))).posting;
    expect(sent).toMatchObject({ state: "posted", receipt: { gross: "120.00" } });
    expect(xero.credits.get(sent.externalId)?.Allocations).toEqual([]);
  });

  it("drafts, approves and downloads a local invoice with Xero disabled", async () => {
    await disable(true);
    await setModules(["customers", "invoicing"]);
    const customer = await billingCustomer("LOCAL-BILL");
    const request = {
      ...terms(),
      kind: "manual",
      customerId: customer.id,
      currency: "GBP",
      lines: [
        { description: "Local consultation", unit: "hours", quantity: "2.5", unitPrice: "40", taxRate: 20 },
      ],
    };
    const apiCalls = xero.state.apiCalls;
    const document = await ok(send("POST", "/invoicing", request), 201);
    expect((await ok(send("POST", "/invoicing", request), 201)).id).toBe(document.id);
    await ok(send("GET", `/invoicing/${document.id}/pdf`), 400);
    await ok(decision(document, "issue", member), 403);
    const invoice = await ok(decision(document));
    expect(invoice).toMatchObject({
      status: "issued",
      number: expect.stringMatching(/^INV-\d{6}$/),
      net: "100.00",
      tax: "20.00",
      gross: "120.00",
    });
    const pdf = await send("GET", `/invoicing/${invoice.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain(`${invoice.number}.pdf`);
    expect(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 8)
        .toString(),
    ).toMatch(/^%PDF-/);
    expect(xero.state.apiCalls).toBe(apiCalls);
  });
});
