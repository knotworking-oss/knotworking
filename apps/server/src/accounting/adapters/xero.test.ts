import { newId, type AccountingPosting } from "@knotworking/core";
import { accountingConnections, workspaces } from "@knotworking/db";
import { createTestDb } from "@knotworking/db/testing";
import { describe, expect, it, vi } from "vitest";
import { createXeroAdapter } from "./xero";
import { confirmAccountingPosting, dispatchAccountingPosting, enqueueAccountingPosting } from "../outbox";
function fixture(currency: "GBP" | "EUR" | "USD" = "GBP") {
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
  };
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith("https://api.xero.com/api.xro/2.0/")).toBe(true);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeDefined();
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("xero-tenant-id")).toBe(companyId);
    if (url.endsWith("/Organisation"))
      return Response.json({
        Organisations: [
          { OrganisationID: state.organisationId, Name: "Test Xero", BaseCurrency: state.baseCurrency },
        ],
      });
    if (url.includes("/Contacts/"))
      return Response.json({
        Contacts: [{ ContactID: document.supplierReference, ContactStatus: "ACTIVE" }],
      });
    if (url.endsWith("/Accounts"))
      return Response.json({ Accounts: [{ Code: "5000", Class: "EXPENSE", Status: "ACTIVE" }] });
    if (url.endsWith("/TaxRates"))
      return Response.json({ TaxRates: [{ TaxType: "INPUT2", Status: "ACTIVE", CanApplyToExpenses: true }] });
    if (init?.method === "PUT") {
      state.sent = JSON.parse(String(init.body)).Invoices[0];
      if (state.loseWriteReply) throw new Error("secret-token must never escape");
      return Response.json({ Invoices: [{ InvoiceID: externalId }] }, { status: state.writeStatus });
    }
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
    getAccessToken: async () => "test-token",
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
      else f.state.writeStatus = 429;
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
});
