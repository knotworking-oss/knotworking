import { DEFAULT_TIME_ZONE, newId, todayInZone } from "@knotworking/core";
import { accountingPostingEvents, accountingPostings } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
const haulierContact = newId();

describe("preparing approved purchase invoices for accounting", () => {
  let ctx: TestCtx, ada: string, marcus: string, token: string;
  let supplier: string, connection: any, invoice: any;
  const send = (method: string, path: string, json?: unknown, cookie = ada) =>
    ctx.req(WS + path, { method, json, cookie });
  const ok = async (input: Res | Promise<Res>, status = 200) => {
    const response = await input;
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const fail = async (input: Res | Promise<Res>, status: number) =>
    (await ok(input, status)).error as { code: string; message: string; details?: any };
  const base = () => `/accounting/connections/${connection.id}/purchase-invoices`;
  const refresh = async () =>
    (connection = (await ok(send("GET", `/accounting/connections/${connection.id}`))).connection);
  const map = async (kind: string, localReference: string, externalReference: string, enabled = true) => {
    await ok(
      send("PUT", `/accounting/connections/${connection.id}/mappings`, {
        commandId: newId(),
        expectedRevision: connection.revision,
        kind,
        localReference,
        externalReference,
        enabled,
        reason: "Reviewed by finance",
      }),
    );
    await refresh();
  };
  /** An approved invoice of charges: carriage 1 × 10.005 and pallets 3 × 0.333, VAT 2.20. */
  const approvedInvoice = async (invoiceNumber: string, vat = 2.2, dueDate: string | null = today) => {
    const draft = await ok(
      send("POST", "/purchasing/invoices", {
        supplierId: supplier,
        invoiceNumber,
        invoiceDate: today,
        ...(dueDate ? { dueDate } : {}),
        vat,
        lines: [
          { kind: "charge", description: "Carriage", quantity: 1, unitPrice: 10.005 },
          { kind: "charge", description: "Pallets", quantity: 3, unitPrice: 0.333 },
        ],
      }),
      201,
    );
    return ok(send("POST", `/purchasing/invoices/${draft.id}/approve`, { reason: "Agreed charges" }));
  };
  const coding = (inv: any, overrides: Record<number, object> = {}) =>
    inv.lines.map((line: any, i: number) => ({
      invoiceLineId: line.id,
      accountKey: "carriage",
      taxKey: "standard",
      description: line.description ?? `Line ${i + 1}`,
      net: ["10.01", "1.00"][i],
      tax: ["2.00", "0.20"][i],
      ...overrides[i],
    }));
  const prepare = (inv: any, lines = coding(inv), extra: object = {}) =>
    send("POST", `${base()}/${inv.id}/prepare`, {
      commandId: newId(),
      expectedRevision: connection.revision,
      reason: "Month-end review",
      lines,
      ...extra,
    });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    token = (
      await ok(
        ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write" },
        }),
        201,
      )
    ).token;
    supplier = (await ok(send("POST", "/suppliers", { name: "Haulier" }), 201)).id;
    await ok(send("POST", `/suppliers/${supplier}/approval`, { status: "approved" }));
    connection = await ok(
      send("POST", "/accounting/connections", {
        commandId: newId(),
        provider: "xero",
        name: "Accounts",
        companyId: newId(),
      }),
      201,
    );
    await map("supplier", supplier, haulierContact);
    await map("account", "carriage", "5100");
    await map("account", "packaging", "5200");
    await map("tax", "standard", "INPUT2");
    invoice = await approvedInvoice("H-1");
  }, 120_000);
  afterAll(() => ctx?.handle.close());

  it("lists approved invoices and shows exact values, suggested nets and the VAT to allocate", async () => {
    const list = await ok(send("GET", base()));
    expect(list.invoices.map((i: any) => i.id)).toContain(invoice.id);
    const detail = await ok(send("GET", `${base()}/${invoice.id}`));
    expect(detail.invoice).toMatchObject({ currency: "GBP", vat: "2.20", version: 1 });
    expect(detail.lines.map((l: any) => [l.exactValue, l.suggestedNet])).toEqual([
      ["10.005", "10.01"],
      ["0.999", "1.00"],
    ]);
    expect(detail).toMatchObject({
      supplierReference: haulierContact,
      accountKeys: ["carriage", "packaging"],
      taxKeys: ["standard"],
      posting: null,
      blockers: [],
    });
  });

  it("refuses incomplete, inexact or unmapped coding without queueing anything", async () => {
    const lines = coding(invoice);
    expect((await fail(prepare(invoice, lines.slice(0, 1)), 400)).code).toBe("invoice_lines_mismatch");
    // 0.98 is 0.019 from 3 × 0.333; 10.00 is within a penny of 10.005 and allowed.
    const off = await fail(prepare(invoice, coding(invoice, { 1: { net: "0.98" } })), 400);
    expect(off).toMatchObject({ code: "line_net_mismatch", details: { lineNos: [2] } });
    expect((await fail(prepare(invoice, coding(invoice, { 1: { tax: "0.21" } })), 400)).code).toBe(
      "tax_mismatch",
    );
    expect((await fail(prepare(invoice, coding(invoice, { 0: { net: "10.0" } })), 400)).code).toBe(
      "amount_precision",
    );
    const unmapped = await fail(prepare(invoice, coding(invoice, { 1: { taxKey: "zero" } })), 409);
    expect(unmapped).toMatchObject({ code: "mapping_missing", details: { tax: ["zero"] } });
    expect(
      (await fail(prepare(invoice, lines, { expectedRevision: connection.revision - 1 }), 409)).code,
    ).toBe("accounting_conflict");
    const posted = await ctx.handle.db
      .select()
      .from(accountingPostings)
      .where(eq(accountingPostings.sourceId, invoice.id));
    expect(posted).toHaveLength(0);
  });

  it("queues one immutable snapshot with destination references, idempotently", async () => {
    const lines = coding(invoice, { 0: { net: "10.00", tax: "2.00" }, 1: { accountKey: "packaging" } });
    const commandId = newId();
    const body = { commandId, expectedRevision: connection.revision, reason: "Month-end review", lines };
    const first = await ok(send("POST", `${base()}/${invoice.id}/prepare`, body), 201);
    expect(first.state).toBe("queued");
    expect(first.payload).toMatchObject({
      provider: "xero",
      connectionId: connection.id,
      companyId: connection.companyId,
      sourceId: invoice.id,
      sourceRevision: 1,
      supplierReference: haulierContact,
      reference: "H-1",
      date: today,
      dueDate: today,
      currency: "GBP",
      net: "11.00",
      tax: "2.20",
      gross: "13.20",
    });
    expect(first.payload.lines.map((l: any) => [l.accountReference, l.taxReference, l.net, l.tax])).toEqual([
      ["5100", "INPUT2", "10.00", "2.00"],
      ["5200", "INPUT2", "1.00", "0.20"],
    ]);
    // The same command, and a new command with the same coding, return the same posting.
    expect((await ok(send("POST", `${base()}/${invoice.id}/prepare`, body), 201)).id).toBe(first.id);
    expect((await ok(prepare(invoice, lines), 201)).id).toBe(first.id);
    // Different coding of a prepared invoice conflicts rather than reposting.
    expect((await fail(prepare(invoice), 409)).code).toBe("accounting_conflict");
    // A later mapping change does not alter the prepared snapshot.
    await map("account", "carriage", "5999");
    const detail = await ok(send("GET", `${base()}/${invoice.id}`));
    expect(detail.posting.payload.lines[0].accountReference).toBe("5100");
    expect((await ok(send("GET", base()))).invoices.map((i: any) => i.id)).not.toContain(invoice.id);
    const all = await ok(send("GET", `${base()}?show=all`));
    expect(all.invoices.find((i: any) => i.id === invoice.id).postingState).toBe("queued");
    const [event] = await ctx.handle.db
      .select()
      .from(accountingPostingEvents)
      .where(eq(accountingPostingEvents.postingId, first.id));
    expect(event!.actor).toMatch(/^user:/);
    expect(event!.evidence).toContain("Month-end review");
  });

  it("blocks a Xero bill without a due date before it reaches the queue", async () => {
    const undated = await approvedInvoice("H-NO-DUE", 2.2, null);
    const detail = await ok(send("GET", `${base()}/${undated.id}`));
    expect(detail.blockers.join(" ")).toContain("due date");
    const refused = await fail(prepare(undated), 409);
    expect(refused).toMatchObject({ code: "provider_document_invalid" });
    expect(refused.message).toContain("due date");
    expect(
      await ctx.handle.db.select().from(accountingPostings).where(eq(accountingPostings.sourceId, undated.id)),
    ).toHaveLength(0);
  });

  it("refuses a corrected version once an earlier version was sent", async () => {
    const revision = await ok(send("POST", `/purchasing/invoices/${invoice.id}/revise`), 201);
    const approved = await ok(
      send("POST", `/purchasing/invoices/${revision.id}/approve`, { reason: "Corrected charges" }),
    );
    const detail = await ok(send("GET", `${base()}/${approved.id}`));
    expect(detail.blockers.join(" ")).toContain("Version 1 of this invoice was already sent");
    expect((await fail(prepare(approved, coding(approved)), 409)).code).toBe("invoice_already_posted");
    // The original is now superseded; its existing posting stays as it was.
    expect((await ok(send("GET", `${base()}/${invoice.id}`))).invoice.status).toBe("superseded");
  });

  it("refuses drafts, VAT the currency can't hold, and disabled connections", async () => {
    const draft = await ok(
      send("POST", "/purchasing/invoices", {
        supplierId: supplier,
        invoiceNumber: "H-DRAFT",
        invoiceDate: today,
        lines: [{ kind: "charge", description: "Carriage", quantity: 1, unitPrice: 5 }],
      }),
      201,
    );
    expect((await fail(prepare(draft, coding(draft).slice(0, 1)), 409)).code).toBe("invoice_not_approved");
    const oddVat = await approvedInvoice("H-ODD", 2.2051);
    expect((await ok(send("GET", `${base()}/${oddVat.id}`))).blockers.join(" ")).toContain("decimal places");
    expect((await fail(prepare(oddVat), 409)).code).toBe("vat_precision");
    const next = await approvedInvoice("H-2");
    await ok(
      send("PATCH", `/accounting/connections/${connection.id}`, {
        commandId: newId(),
        expectedRevision: connection.revision,
        name: connection.name,
        disabled: true,
        companyId: connection.companyId,
        reason: "Paused",
      }),
    );
    await refresh();
    expect((await fail(prepare(next), 409)).code).toBe("accounting_conflict");
  });

  it("is for signed-in administrators only", async () => {
    expect((await send("GET", base(), undefined, marcus)).status).toBe(403);
    for (const [method, path] of [
      ["GET", base()],
      ["POST", `${base()}/${invoice.id}/prepare`],
    ] as const)
      expect(
        (
          await ctx.req(WS + path, {
            method,
            headers: { authorization: `Bearer ${token}` },
            ...(method === "POST" ? { json: {} } : {}),
          })
        ).status,
      ).toBe(403);
  });
});
