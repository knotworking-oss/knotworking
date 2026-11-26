import { newId, type AccountingPosting } from "@knotworking/core";
import { accountingConnections, workspaces } from "@knotworking/db";
import { createTestDb } from "@knotworking/db/testing";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../errors";
import { createXeroAdapter, expectedLineTaxCents } from "./xero";
import { confirmAccountingPosting, dispatchAccountingPosting, enqueueAccountingPosting } from "../outbox";
function fixture(
  currency: "GBP" | "EUR" | "USD" = "GBP",
  hooks: {
    getAccessToken?: () => Promise<string>;
    onUnauthorized?: (token: string) => Promise<void>;
    onForbidden?: (token: string) => Promise<boolean>;
  } = {},
) {
  const connectionId = newId(),
    companyId = newId(),
    externalId = newId(),
    postingKey = newId();
  const document: AccountingPosting = {
    version: 1,
    provider: "xero",
    connectionId,
    companyId,
    kind: "purchase_invoice",
    sourceId: newId(),
    sourceRevision: 1,
    supplierReference: newId(),
    reference: "SUP-INV-123",
    date: "2026-11-15",
    dueDate: "2026-12-15",
    currency,
    lines: [
      {
        accountReference: "5000",
        taxReference: "INPUT2",
        description: "Ingredients",
        net: "10.00",
        tax: "2.00",
      },
    ],
    net: "10.00",
    tax: "2.00",
    gross: "12.00",
  };
  const state = {
    loseWriteReply: false,
    writeStatus: 200,
    organisationId: companyId,
    baseCurrency: currency,
    readOverride: {} as Record<string, unknown>,
    sent: null as Record<string, any> | null,
    organisation: {} as Record<string, unknown>,
    taxRates: [
      { TaxType: "INPUT2", Status: "ACTIVE", CanApplyToExpenses: true, EffectiveRate: 20 },
    ] as Record<string, unknown>[],
    /** Respond to the next request whose path contains this with the status, once. */
    refuse: null as { path: string; status: number } | null,
    /** Bills the source-link search returns. */
    search: [] as Record<string, unknown>[],
  };
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith("https://api.xero.com/api.xro/2.0/")).toBe(true);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeDefined();
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toMatch(/^Bearer test-token/);
    expect(headers.get("xero-tenant-id")).toBe(companyId);
    if (state.refuse && url.includes(state.refuse.path)) {
      const { status } = state.refuse;
      state.refuse = null;
      return new Response(null, { status });
    }
    if (url.endsWith("/Organisation"))
      return Response.json({
        Organisations: [
          {
            OrganisationID: state.organisationId,
            Name: "Test Xero",
            BaseCurrency: state.baseCurrency,
            ...state.organisation,
          },
        ],
      });
    if (url.includes("/Contacts/"))
      return Response.json({
        Contacts: [{ ContactID: document.supplierReference, ContactStatus: "ACTIVE" }],
      });
    if (url.endsWith("/Accounts"))
      return Response.json({ Accounts: [{ Code: "5000", Class: "EXPENSE", Status: "ACTIVE" }] });
    if (url.endsWith("/TaxRates")) return Response.json({ TaxRates: state.taxRates });
    if (url.includes("/Invoices?") && init?.method !== "PUT")
      return Response.json({ Invoices: state.search });
    if (init?.method === "PUT") {
      state.sent = JSON.parse(String(init.body)).Invoices[0];
      if (state.loseWriteReply) throw new Error("secret-token must never escape");
      return Response.json({ Invoices: [{ InvoiceID: externalId }] }, { status: state.writeStatus });
    }
    const searched = state.search.find((bill) => url.endsWith(`/Invoices/${bill.InvoiceID}`));
    if (searched)
      return Response.json({
        Invoices: [{ ...state.sent, ...searched, SubTotal: 10, TotalTax: 2, Total: 12, HasErrors: false }],
      });
    if (url.endsWith(`/Invoices/${externalId}`) && state.sent)
      return Response.json({
        Invoices: [
          {
            ...state.sent,
            InvoiceID: externalId,
            SubTotal: 10,
            TotalTax: 2,
            Total: 12,
            HasErrors: false,
            ...state.readOverride,
          },
        ],
      });
    throw new Error("Unexpected provider request");
  });
  const adapter = createXeroAdapter({
    connectionId,
    companyId,
    baseCurrency: currency,
    appUrl: "https://knotworking.example",
    workspaceSlug: "acme",
    getAccessToken: hooks.getAccessToken ?? (async () => "test-token"),
    onUnauthorized: hooks.onUnauthorized,
    onForbidden: hooks.onForbidden,
    fetch,
  });
  const writes = () => fetch.mock.calls.filter(([, init]) => init?.method === "PUT");
  return { connectionId, companyId, externalId, postingKey, document, state, fetch, adapter, writes };
}
describe("Xero purchase invoice HTTP adapter (fake transport)", () => {
  it("verifies the organisation, sends an authorised purchase bill and reads every financial line back", async () => {
    const f = fixture();
    const result = await f.adapter.post({
      postingKey: f.postingKey,
      attemptId: newId(),
      document: f.document,
    });
    expect(result).toMatchObject({
      outcome: "posted",
      receipt: {
        provider: "xero",
        connectionId: f.connectionId,
        companyId: f.companyId,
        postingKey: f.postingKey,
        externalId: f.externalId,
        gross: "12.00",
      },
    });
    expect(f.fetch).toHaveBeenCalledTimes(6);
    expect(f.state.sent).toMatchObject({
      Type: "ACCPAY",
      Status: "AUTHORISED",
      DueDate: "2026-12-15",
      InvoiceNumber: "SUP-INV-123",
      LineAmountTypes: "Exclusive",
      LineItems: [
        { Quantity: 1, UnitAmount: 10, LineAmount: 10, TaxAmount: 2, AccountCode: "5000", TaxType: "INPUT2" },
      ],
    });
    expect(f.state.sent!.Url).toContain(`accountingPosting=${f.postingKey}`);
    expect(new Headers(f.writes()[0]![1]!.headers).get("idempotency-key")).toBe(f.postingKey);
  });
  it.each(["EUR", "USD"] as const)("supports a verified %s base-currency organisation", async (currency) => {
    const f = fixture(currency);
    expect(f.adapter.capabilities.currencies).toEqual([currency]);
    expect(
      (await f.adapter.post({ postingKey: f.postingKey, attemptId: newId(), document: f.document })).outcome,
    ).toBe("posted");
  });
  it("preserves the largest supported two-decimal values at the numeric transport boundary", async () => {
    const f = fixture();
    f.document.lines[0]!.net = "999999999999.97";
    f.document.lines[0]!.tax = "0.02";
    // A rate Xero doesn't state isn't checked here: this is about the numeric boundary.
    f.state.taxRates = [{ TaxType: "INPUT2", Status: "ACTIVE", CanApplyToExpenses: true }];
    Object.assign(f.document, { net: "999999999999.97", tax: "0.02", gross: "999999999999.99" });
    f.state.readOverride = { SubTotal: 999999999999.97, TotalTax: 0.02, Total: 999999999999.99 };
    expect(
      (await f.adapter.post({ postingKey: f.postingKey, attemptId: newId(), document: f.document })).outcome,
    ).toBe("posted");
    expect(String(f.writes()[0]![1]!.body)).toContain('"UnitAmount":999999999999.97');
  });
  it("does not collapse duplicate financial lines during read-back", async () => {
    const f = fixture();
    f.document.lines.push({ ...f.document.lines[0]! });
    Object.assign(f.document, { net: "20.00", tax: "4.00", gross: "24.00" });
    f.state.readOverride = { SubTotal: 20, TotalTax: 4, Total: 24 };
    expect(
      (await f.adapter.post({ postingKey: f.postingKey, attemptId: newId(), document: f.document })).outcome,
    ).toBe("posted");
    f.state.readOverride.LineItems = [f.state.sent!.LineItems[0]];
    expect(
      await f.adapter.readBack({ postingKey: f.postingKey, document: f.document, externalId: f.externalId }),
    ).toBeNull();
  });
  it("uses the stable posting reference, rather than the attempt ID, on retries", async () => {
    const f = fixture();
    for (let i = 0; i < 2; i++)
      await f.adapter.post({ postingKey: f.postingKey, attemptId: newId(), document: f.document });
    expect(f.writes().map(([, init]) => new Headers(init!.headers).get("idempotency-key"))).toEqual([
      f.postingKey,
      f.postingKey,
    ]);
  });
  it.each(["dueDate", "currency", "supplierReference", "provider", "connectionId"] as const)(
    "refuses unsupported %s before making any request",
    async (field) => {
      const f = fixture();
      const invalid = { ...f.document };
      if (field === "dueDate") delete invalid.dueDate;
      else if (field === "currency") invalid.currency = "USD";
      else if (field === "supplierReference") invalid.supplierReference = "NOT-A-CONTACT-ID";
      else if (field === "provider") invalid.provider = "another_provider";
      else invalid.connectionId = newId();
      expect(
        (await f.adapter.post({ postingKey: f.postingKey, attemptId: newId(), document: invalid })).outcome,
      ).toBe("rejected");
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );
  it("explains each definitive pre-send refusal without contacting Xero", async () => {
    const cases: [Partial<AccountingPosting>, string][] = [
      [{ dueDate: undefined }, "due date"],
      [{ dueDate: "2026-11-14" }, "before the invoice date"],
      [{ supplierReference: "NOT-A-CONTACT-ID" }, "ContactID"],
      [{ currency: "USD" }, "uses GBP"],
      [{ connectionId: newId() }, "different accounting destination"],
      [{ reference: "SUP\u0007INV" }, "invoice number"],
    ];
    for (const [change, reason] of cases) {
      const f = fixture();
      const result = await f.adapter.post({
        postingKey: f.postingKey,
        attemptId: newId(),
        document: { ...f.document, ...change } as AccountingPosting,
      });
      expect(result).toMatchObject({ outcome: "rejected" });
      expect((result as { evidence: string }).evidence).toContain(reason);
      expect(f.fetch).not.toHaveBeenCalled();
    }
  });
  it("sends a supplier invoice number outside ASCII unchanged", async () => {
    const f = fixture();
    f.document.reference = "Nº 123/ÅB";
    f.state.readOverride = { InvoiceNumber: "Nº 123/ÅB" };
    expect(
      (await f.adapter.post({ postingKey: f.postingKey, attemptId: newId(), document: f.document })).outcome,
    ).toBe("posted");
    expect(f.state.sent!.InvoiceNumber).toBe("Nº 123/ÅB");
  });
  it.each(["tenant", "currency"])("refuses a mismatched organisation %s before a write", async (field) => {
    const f = fixture();
    if (field === "tenant") f.state.organisationId = newId();
    else f.state.baseCurrency = "USD";
    expect(
      (await f.adapter.post({ postingKey: f.postingKey, attemptId: newId(), document: f.document })).outcome,
    ).toBe("rejected");
    expect(f.writes()).toHaveLength(0);
  });
  it.each([
    { Total: 12.01 },
    { Contact: { ContactID: newId() } },
    { Url: "https://wrong.example" },
    { InvoiceNumber: "wrong" },
    { Status: "DRAFT" },
    { DueDate: "2026-12-14" },
    {
      LineItems: [
        { Description: "Ingredients", AccountCode: "6000", TaxType: "INPUT2", LineAmount: 10, TaxAmount: 2 },
      ],
    },
    {
      LineItems: [
        {
          Description: "Ingredients",
          AccountCode: "5000",
          TaxType: "INPUT2",
          LineAmount: 10.001,
          TaxAmount: 2,
        },
      ],
    },
  ])("leaves the result uncertain for mismatched read-back %#", async (override) => {
    const f = fixture();
    f.state.readOverride = override;
    expect(
      (await f.adapter.post({ postingKey: f.postingKey, attemptId: newId(), document: f.document })).outcome,
    ).toBe("unknown");
  });
  it("keeps transport errors and HTTP failures after invocation uncertain without exposing credentials", async () => {
    for (const failure of ["timeout", "http"] as const) {
      const f = fixture();
      if (failure === "timeout") f.state.loseWriteReply = true;
      else f.state.writeStatus = 503;
      const result = await f.adapter.post({
        postingKey: f.postingKey,
        attemptId: newId(),
        document: f.document,
      });
      expect(result.outcome).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain("secret-token");
      expect(f.writes()).toHaveLength(1);
    }
  });
  it("accepts Xero's historical date representation without changing the business date", async () => {
    const f = fixture();
    f.state.readOverride = {
      Date: `/Date(${Date.UTC(2026, 10, 15)}+0000)/`,
      DueDate: `/Date(${Date.UTC(2026, 11, 15)}+0000)/`,
    };
    expect(
      (await f.adapter.post({ postingKey: f.postingKey, attemptId: newId(), document: f.document })).outcome,
    ).toBe("posted");
  });
  it("does not resend a lost response through the durable queue, and reconciles by external ID", async () => {
    const f = fixture();
    const handle = await createTestDb();
    try {
      const ws = newId();
      await handle.db.insert(workspaces).values({ id: ws, slug: "xero-test", name: "Xero test" });
      await handle.db.insert(accountingConnections).values({
        id: f.connectionId,
        workspaceId: ws,
        name: "Xero test",
        provider: "xero",
        companyId: f.companyId,
      });
      const queued = await enqueueAccountingPosting(handle.db, ws, "test", f.document);
      f.state.loseWriteReply = true;
      const uncertain = await dispatchAccountingPosting(handle.db, ws, queued.id, "test", f.adapter);
      expect(uncertain!.state).toBe("unknown");
      expect(await dispatchAccountingPosting(handle.db, ws, queued.id, "test", f.adapter)).toBeNull();
      expect(f.writes()).toHaveLength(1);
      const receipt = await f.adapter.readBack({
        postingKey: queued.id,
        document: f.document,
        externalId: f.externalId,
      });
      expect(receipt).not.toBeNull();
      expect(
        (
          await confirmAccountingPosting(
            handle.db,
            ws,
            queued.id,
            uncertain!.attemptId!,
            "test",
            receipt,
            "Read Xero invoice by its external ID",
          )
        ).state,
      ).toBe("posted");
      expect(f.writes()).toHaveLength(1);
    } finally {
      await handle.close();
    }
  }, 30000);
  const post = (f: ReturnType<typeof fixture>) =>
    f.adapter.post({ postingKey: f.postingKey, attemptId: newId(), document: f.document });

  it.each([
    ["PeriodLockDate", "2026-11-15"],
    ["EndOfYearLockDate", "2026-12-31T00:00:00"],
    ["PeriodLockDate", `/Date(${Date.UTC(2026, 10, 30)}+0000)/`],
  ])("refuses a bill dated on or before Xero's %s (%s)", async (field, value) => {
    const f = fixture();
    f.state.organisation = { [field]: value };
    expect(await post(f)).toMatchObject({ outcome: "rejected", evidence: expect.stringContaining("locked") });
    expect(f.writes()).toHaveLength(0);
  });
  it("sends a bill dated after the lock date", async () => {
    const f = fixture();
    f.state.organisation = { PeriodLockDate: "2026-11-14", EndOfYearLockDate: "2026-03-31" };
    expect((await post(f)).outcome).toBe("posted");
  });

  it.each(["/Organisation", "/Contacts/", "/Accounts", "/TaxRates"])(
    "leaves a bill queued when Xero rate-limits %s before the write",
    async (path) => {
      const f = fixture();
      f.state.refuse = { path, status: 429 };
      expect(await post(f)).toMatchObject({ outcome: "deferred", evidence: expect.stringContaining("rate") });
      expect(f.writes()).toHaveLength(0);
    },
  );
  it("treats a 429 on the create call as no write, and sends it again with the same key", async () => {
    const f = fixture();
    f.state.refuse = { path: "/Invoices?summarizeErrors", status: 429 };
    expect((await post(f)).outcome).toBe("deferred");
    expect((await post(f)).outcome).toBe("posted");
    expect(f.writes().map(([, init]) => new Headers(init!.headers).get("idempotency-key"))).toEqual([
      f.postingKey,
      f.postingKey,
    ]);
  });
  it("shares organisation, chart, tax rate and contact lookups between bills in one pass", async () => {
    const f = fixture();
    expect((await post(f)).outcome).toBe("posted");
    expect(f.fetch).toHaveBeenCalledTimes(6);
    expect((await post(f)).outcome).toBe("posted");
    expect(f.fetch).toHaveBeenCalledTimes(8); // create and read-back only
  });

  it.each(["/Organisation", "/Invoices?summarizeErrors"])(
    "marks the token expired on a 401 from %s, refreshes once and carries on",
    async (path) => {
      let issued = 0;
      const onUnauthorized = vi.fn(async () => {});
      const f = fixture("GBP", { getAccessToken: async () => `test-token-${++issued}`, onUnauthorized });
      f.state.refuse = { path, status: 401 };
      expect((await post(f)).outcome).toBe("posted");
      expect(onUnauthorized).toHaveBeenCalledExactlyOnceWith("test-token-1");
      expect(issued).toBe(2);
      // A 401 on the create call is a refusal before processing: the retry uses the same key.
      for (const [, init] of f.writes())
        expect(new Headers(init!.headers).get("idempotency-key")).toBe(f.postingKey);
    },
  );
  it("refuses, without a write, when a refreshed token is still not accepted", async () => {
    const f = fixture("GBP", { onUnauthorized: async () => {} });
    let refusals = 0;
    f.fetch.mockImplementation(async () => {
      refusals++;
      return new Response(null, { status: 401 });
    });
    expect(await post(f)).toMatchObject({
      outcome: "rejected",
      evidence: expect.stringContaining("refresh"),
    });
    expect(refusals).toBe(2);
  });
  it("leaves the bill queued when refreshing needs a reconnect", async () => {
    const f = fixture("GBP", {
      getAccessToken: async () => {
        throw new ApiError(409, "xero_reconnect_required", "Reconnect Xero to continue.");
      },
    });
    expect(await post(f)).toMatchObject({
      outcome: "deferred",
      evidence: expect.stringContaining("Reconnect"),
    });
  });

  it.each(["/Organisation", "/Invoices?summarizeErrors"])(
    "on a 403 from %s, asks whether the organisation is still connected",
    async (path) => {
      for (const removed of [true, false]) {
        const onForbidden = vi.fn(async () => removed);
        const f = fixture("GBP", { onForbidden });
        f.state.refuse = { path, status: 403 };
        const result = await post(f);
        expect(onForbidden).toHaveBeenCalledOnce();
        if (removed)
          expect(result).toMatchObject({
            outcome: "deferred",
            evidence: expect.stringContaining("no longer connected"),
          });
        else
          expect(result).toMatchObject({
            outcome: "rejected",
            evidence: expect.stringContaining("permissions"),
          });
      }
    },
  );

  it.each([
    [{ EffectiveRate: 20 }, "2.01", "posted"],
    [{ EffectiveRate: 20 }, "1.99", "posted"],
    [{ EffectiveRate: 20 }, "2.50", "rejected"],
    [{ EffectiveRate: 5 }, "2.00", "rejected"],
    [{ EffectiveRate: 0 }, "2.00", "rejected"],
    [{ EffectiveRate: 0 }, "0.00", "posted"],
    [{ TaxType: "NONE" }, "0.01", "rejected"],
    [{}, "3.00", "posted"], // Xero gave no rate: its own validation still applies
  ])("checks line tax against the Xero rate %j: tax %s is %s", async (rate, tax, outcome) => {
    const f = fixture();
    const taxType = (rate as { TaxType?: string }).TaxType ?? "INPUT2";
    f.state.taxRates = [{ TaxType: taxType, Status: "ACTIVE", CanApplyToExpenses: true, ...rate }];
    f.document.lines[0]!.taxReference = taxType;
    f.document.lines[0]!.tax = tax;
    const gross = (10 + Number(tax)).toFixed(2);
    Object.assign(f.document, { tax, gross });
    f.state.readOverride = { TotalTax: Number(tax), Total: Number(gross) };
    const result = await post(f);
    expect(result.outcome).toBe(outcome);
    if (outcome === "rejected") {
      expect((result as { evidence: string }).evidence).toMatch(/tax/);
      expect(f.writes()).toHaveLength(0);
    }
  });
  it("computes the expected tax for each line amount type", () => {
    expect(expectedLineTaxCents("10.00", 20, "Exclusive")).toBe(200);
    expect(expectedLineTaxCents("12.00", 20, "Inclusive")).toBe(200);
    expect(expectedLineTaxCents("10.00", 20, "NoTax")).toBe(0);
  });

  it("does not reconcile when two Xero bills carry the same source link", async () => {
    const f = fixture();
    expect((await post(f)).outcome).toBe("posted");
    const twin = { ...f.state.sent, InvoiceNumber: f.document.reference, Url: f.state.sent!.Url };
    f.state.search = [
      { ...twin, InvoiceID: newId() },
      { ...twin, InvoiceID: newId() },
    ];
    expect(await f.adapter.findExisting({ postingKey: f.postingKey, document: f.document })).toBeNull();
    f.state.search = [f.state.search[0]!];
    expect(await f.adapter.findExisting({ postingKey: f.postingKey, document: f.document })).toMatchObject({
      externalId: String(f.state.search[0]!.InvoiceID).toLowerCase(),
    });
  });
});

function customerFixture() {
  const connectionId = newId(),
    companyId = newId(),
    contact = newId(),
    invoiceId = newId(),
    creditId = newId();
  const common = {
    version: 1 as const,
    provider: "xero",
    connectionId,
    companyId,
    sourceRevision: 2,
    date: "2026-11-15",
    currency: "GBP",
    customerReference: contact,
    lines: [
      {
        accountReference: "200",
        taxReference: "OUTPUT2",
        description: "Łódź tea",
        net: "50.00",
        tax: "10.00",
      },
    ],
    net: "50.00",
    tax: "10.00",
    gross: "60.00",
  };
  const invoice: AccountingPosting = {
    ...common,
    kind: "customer_invoice",
    sourceId: newId(),
    reference: "INV-000001",
    dueDate: "2026-12-15",
  };
  const credit = (allocate: boolean): AccountingPosting => ({
    ...common,
    kind: "customer_credit_note",
    sourceId: newId(),
    reference: "CN-000001",
    originalInvoice: { externalId: invoiceId, reference: "INV-000001", allocate },
  });
  const state = {
    amountDue: 60,
    salesRate: 20,
    allocationStatus: 200,
    sent: {} as Record<string, any>,
    allocations: [] as { Invoice: { InvoiceID: string }; Amount: number }[],
    keys: [] as string[],
  };
  const totals = { SubTotal: 50, TotalTax: 10, Total: 60, HasErrors: false, CurrencyCode: "GBP" };
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = String(input).replace("https://api.xero.com/api.xro/2.0", "");
    const headers = new Headers(init?.headers);
    if (url === "/Organisation")
      return Response.json({
        Organisations: [{ OrganisationID: companyId, Name: "Test", BaseCurrency: "GBP" }],
      });
    if (url.startsWith("/Contacts/"))
      return Response.json({ Contacts: [{ ContactID: contact, ContactStatus: "ACTIVE" }] });
    if (url === "/Accounts")
      return Response.json({
        Accounts: [
          { Code: "200", Class: "REVENUE", Status: "ACTIVE" },
          { Code: "5000", Class: "EXPENSE", Status: "ACTIVE" },
        ],
      });
    if (url === "/TaxRates")
      return Response.json({
        TaxRates: [
          { TaxType: "OUTPUT2", Status: "ACTIVE", CanApplyToRevenue: true, EffectiveRate: state.salesRate },
          { TaxType: "INPUT2", Status: "ACTIVE", CanApplyToRevenue: false, EffectiveRate: 20 },
        ],
      });
    if (init?.method === "PUT") {
      state.keys.push(headers.get("idempotency-key")!);
      const body = JSON.parse(String(init.body));
      if (url.includes("/Allocations")) {
        if (state.allocationStatus !== 200)
          return Response.json(
            { Type: "ValidationException", Elements: [{ ValidationErrors: [{ Message: "Refused" }] }] },
            { status: state.allocationStatus },
          );
        state.allocations.push(...body.Allocations);
        state.amountDue -= body.Allocations[0].Amount;
        return Response.json({ Allocations: body.Allocations });
      }
      if (url.startsWith("/Invoices")) {
        state.sent = body.Invoices[0];
        return Response.json({ Invoices: [{ InvoiceID: invoiceId }] });
      }
      state.sent = body.CreditNotes[0];
      return Response.json({ CreditNotes: [{ CreditNoteID: creditId }] });
    }
    if (url === `/Invoices/${invoiceId}`)
      return Response.json({
        Invoices: [
          {
            InvoiceNumber: "INV-000001",
            DueDate: "2026-12-15",
            ...state.sent,
            ...totals,
            InvoiceID: invoiceId,
            Type: "ACCREC",
            Status: "AUTHORISED",
            Contact: { ContactID: contact },
            Date: "2026-11-15",
            AmountDue: state.amountDue,
          },
        ],
      });
    if (url === `/CreditNotes/${creditId}`)
      return Response.json({
        CreditNotes: [{ ...state.sent, ...totals, CreditNoteID: creditId, Allocations: state.allocations }],
      });
    throw new Error(`Unexpected provider request ${url}`);
  });
  const adapter = createXeroAdapter({
    connectionId,
    companyId,
    baseCurrency: "GBP",
    appUrl: "https://knotworking.example",
    workspaceSlug: "acme",
    getAccessToken: async () => "test-token",
    fetch,
  });
  const writes = () => fetch.mock.calls.filter(([, init]) => init?.method === "PUT");
  return { invoice, credit, state, adapter, writes, invoiceId, creditId, contact };
}

describe("Xero customer invoice and credit note HTTP adapter (fake transport)", () => {
  it("sends an authorised ACCREC with the issued number, source URL and exact tax, then reads it back", async () => {
    const f = customerFixture();
    const postingKey = newId(),
      idempotencyKey = newId();
    const result = await f.adapter.post({
      postingKey,
      idempotencyKey,
      attemptId: newId(),
      document: f.invoice,
    });
    expect(result).toMatchObject({
      outcome: "posted",
      receipt: { externalId: f.invoiceId, postingKey, net: "50.00", tax: "10.00", gross: "60.00" },
    });
    expect(result).not.toHaveProperty("allocation");
    expect(f.state.sent).toMatchObject({
      Type: "ACCREC",
      Status: "AUTHORISED",
      InvoiceNumber: "INV-000001",
      DueDate: "2026-12-15",
      Url: `https://knotworking.example/acme/invoicing/${f.invoice.sourceId}?accountingPosting=${postingKey}`,
      Contact: { ContactID: f.contact },
      LineAmountTypes: "Exclusive",
      LineItems: [
        { Description: "Łódź tea", AccountCode: "200", TaxType: "OUTPUT2", LineAmount: 50, TaxAmount: 10 },
      ],
    });
    // A re-prepared posting sends under its new idempotency key, not the posting key.
    expect(f.state.keys).toEqual([idempotencyKey]);
  });

  it("refuses an expense account or a tax rate that differs from the line before any write", async () => {
    const f = customerFixture();
    const expense = {
      ...f.invoice,
      lines: [{ ...f.invoice.lines[0]!, accountReference: "5000" }],
    };
    expect(await f.adapter.post({ postingKey: newId(), attemptId: newId(), document: expense })).toEqual({
      outcome: "rejected",
      evidence: "Line 1 needs a Xero revenue account",
    });
    // Lookups are shared for a minute within one adapter, so use a fresh one.
    const g = customerFixture();
    g.state.salesRate = 5;
    expect(
      await g.adapter.post({ postingKey: newId(), attemptId: newId(), document: g.invoice }),
    ).toMatchObject({
      outcome: "rejected",
      evidence: expect.stringContaining("is not 5%"),
    });
    expect(g.writes()).toHaveLength(0);
    expect(f.writes()).toHaveLength(0);
  });

  it("reports revenue accounts and revenue tax rates for checks at preparation", async () => {
    const coding = await customerFixture().adapter.customerCoding!();
    expect([...coding!.revenueAccounts]).toEqual(["200"]);
    expect([...coding!.taxRates]).toEqual([["OUTPUT2", 20]]);
  });

  it("sends an ACCRECCREDIT on account with the posting key in its Reference and no invoice-only fields", async () => {
    const f = customerFixture();
    const postingKey = newId();
    const result = await f.adapter.post({ postingKey, attemptId: newId(), document: f.credit(false) });
    expect(result).toMatchObject({ outcome: "posted", receipt: { externalId: f.creditId, gross: "60.00" } });
    expect(result).not.toHaveProperty("allocation");
    expect(f.state.sent).toMatchObject({
      Type: "ACCRECCREDIT",
      CreditNoteNumber: "CN-000001",
      Reference: `KW ${postingKey} / INV-000001`,
    });
    expect(f.state.sent).not.toHaveProperty("Url");
    expect(f.state.sent).not.toHaveProperty("DueDate");
    expect(f.writes()).toHaveLength(1);
  });

  it("refuses an allocated credit, without a write, when the invoice lacks the outstanding balance", async () => {
    const f = customerFixture();
    f.state.amountDue = 59.99;
    expect(
      await f.adapter.post({ postingKey: newId(), attemptId: newId(), document: f.credit(true) }),
    ).toMatchObject({ outcome: "rejected", evidence: expect.stringContaining("outstanding balance") });
    expect(f.writes()).toHaveLength(0);
  });

  it("posts a verified credit when its allocation fails, then allocates it under a new key", async () => {
    const f = customerFixture();
    const postingKey = newId();
    const document = f.credit(true);
    f.state.allocationStatus = 400;
    const result = await f.adapter.post({ postingKey, attemptId: newId(), document });
    expect(result).toMatchObject({
      outcome: "posted",
      receipt: { externalId: f.creditId },
      allocation: { allocated: false, evidence: expect.stringContaining("did not confirm the allocation") },
    });
    expect(f.state.keys).toEqual([postingKey, `${postingKey}-allocation`]);
    // Read-back confirms the credit itself; the allocation is settled separately.
    expect(await f.adapter.readBack!({ postingKey, document, externalId: f.creditId })).toMatchObject({
      externalId: f.creditId,
    });
    f.state.allocationStatus = 200;
    expect(await f.adapter.allocate!({ postingKey, document, externalId: f.creditId })).toEqual({
      allocated: true,
      evidence: "Allocated the credit and read the allocation back from Xero",
    });
    expect(f.state.keys[2]).toMatch(new RegExp(`^${postingKey}-allocation-[0-9a-f-]{36}$`));
    expect(f.state.allocations).toEqual([
      { Invoice: { InvoiceID: f.invoiceId }, Amount: 60, Date: "2026-11-15" },
    ]);
    // Asking again reads the allocation back and writes nothing.
    expect(await f.adapter.allocate!({ postingKey, document, externalId: f.creditId })).toMatchObject({
      allocated: true,
    });
    expect(f.writes()).toHaveLength(3);
  });

  it("leaves the allocation pending when the invoice was paid after the credit posted", async () => {
    const f = customerFixture();
    const postingKey = newId();
    const document = f.credit(true);
    f.state.allocationStatus = 429;
    expect(await f.adapter.post({ postingKey, attemptId: newId(), document })).toMatchObject({
      outcome: "posted",
      allocation: { allocated: false },
    });
    f.state.allocationStatus = 200;
    f.state.amountDue = 0;
    expect(await f.adapter.allocate!({ postingKey, document, externalId: f.creditId })).toMatchObject({
      allocated: false,
      evidence: expect.stringContaining("no longer has enough outstanding balance"),
    });
    expect(f.writes()).toHaveLength(2);
  });
});
