import {
  accountingPostingSchema,
  accountingReceiptSchema,
  type AccountingPosting,
  type AccountingReceipt,
} from "@knotworking/core";
import { z } from "zod";
import type { AccountingAdapter } from "../adapter";

const API = "https://api.xero.com/api.xro/2.0";
const baseCurrency = z.enum(["GBP", "EUR", "USD"]);
const bindingSchema = z.object({ connectionId: z.uuid(), companyId: z.uuid(), baseCurrency });
const money = z.number().finite().nonnegative();
const invoiceSchema = z.object({
  InvoiceID: z.uuid(),
  Type: z.literal("ACCPAY"),
  Status: z.enum(["AUTHORISED", "PAID"]),
  Contact: z.object({ ContactID: z.uuid() }),
  InvoiceNumber: z.string(),
  Url: z.string(),
  CurrencyCode: z.string(),
  Date: z.string().optional(),
  DateString: z.string().optional(),
  DueDate: z.string().optional(),
  DueDateString: z.string().optional(),
  SubTotal: money,
  TotalTax: money,
  Total: money,
  HasErrors: z.boolean().optional(),
  LineAmountTypes: z.literal("Exclusive"),
  LineItems: z.array(
    z.object({
      Description: z.string(),
      AccountCode: z.string(),
      TaxType: z.string(),
      LineAmount: money,
      TaxAmount: money,
    }),
  ),
});
function exactMoney(value: number): string {
  const canonical = value.toFixed(2);
  if (Number(canonical) !== value) throw new Error("Unsupported amount precision");
  return canonical;
}
function businessDate(value: string | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(value)) return value.slice(0, 10);
  const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  if (!match) return null;
  const instant = new Date(Number(match[1]));
  return Number.isFinite(instant.getTime()) ? instant.toISOString().slice(0, 10) : null;
}
const unavailable = (written: boolean) => ({
  outcome: written ? ("unknown" as const) : ("rejected" as const),
  evidence: written
    ? "Xero outcome needs reconciliation; no automatic resend"
    : "Xero preflight did not complete; no invoice write attempted",
});

/** HTTP adapter library, not OAuth or a scheduler. Instantiate only with a trusted,
 * authorised connection and server-side token provider. No request is made at construction.
 */
export function createXeroAdapter(options: {
  connectionId: string;
  /** OAuth tenant ID; verified against Organisations before each operation. */
  companyId: string;
  baseCurrency: "GBP" | "EUR" | "USD";
  /** The existing web app origin and workspace slug, for the source invoice link. */
  appUrl: string;
  workspaceSlug: string;
  getAccessToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): AccountingAdapter & {
  readBack(input: {
    postingKey: string;
    document: AccountingPosting;
    externalId: string;
  }): Promise<AccountingReceipt | null>;
} {
  const binding = bindingSchema.parse(options);
  const appUrl = new URL(options.appUrl);
  if (
    !["http:", "https:"].includes(appUrl.protocol) ||
    appUrl.username ||
    appUrl.password ||
    appUrl.search ||
    appUrl.hash ||
    appUrl.pathname !== "/"
  )
    throw new Error("Use the trusted application origin");
  const workspaceSlug = z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .parse(options.workspaceSlug);
  const timeout = z
    .number()
    .int()
    .min(100)
    .max(60000)
    .parse(options.timeoutMs ?? 10000);
  const transport = options.fetch ?? globalThis.fetch;
  const urlFor = (postingKey: string, document: AccountingPosting) =>
    `${appUrl.origin}/${workspaceSlug}/purchasing/invoices/${document.sourceId}?accountingPosting=${postingKey}`;
  function prepare(postingKey: string, input: unknown) {
    z.uuid().parse(postingKey);
    const document = accountingPostingSchema.parse(input);
    if (
      document.provider !== "xero" ||
      document.connectionId !== binding.connectionId ||
      document.companyId !== binding.companyId ||
      document.currency !== binding.baseCurrency ||
      !document.dueDate ||
      !z.uuid().safeParse(document.supplierReference).success
    )
      throw new Error("Unsupported Xero purchase invoice or destination");
    return document;
  }
  async function request(path: string, token: string, init: RequestInit = {}) {
    const response = await transport(API + path, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "xero-tenant-id": binding.companyId,
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error("Xero request did not succeed");
    return response.json() as Promise<unknown>;
  }
  async function verifyOrganisation(token: string) {
    const data = z
      .object({
        Organisations: z.array(z.object({ OrganisationID: z.uuid(), BaseCurrency: z.string() })).length(1),
      })
      .parse(await request("/Organisations", token));
    const organisation = data.Organisations[0]!;
    if (
      organisation.OrganisationID.toLowerCase() !== binding.companyId.toLowerCase() ||
      organisation.BaseCurrency !== binding.baseCurrency
    )
      throw new Error("Xero organisation or base currency differs from configuration");
  }
  async function readInvoice(
    token: string,
    postingKey: string,
    document: AccountingPosting,
    externalId: string,
  ): Promise<AccountingReceipt> {
    z.uuid().parse(externalId);
    const data = z
      .object({ Invoices: z.array(invoiceSchema).length(1) })
      .parse(await request(`/Invoices/${encodeURIComponent(externalId)}`, token));
    const invoice = data.Invoices[0]!;
    if (
      invoice.HasErrors ||
      invoice.InvoiceID.toLowerCase() !== externalId.toLowerCase() ||
      invoice.Contact.ContactID.toLowerCase() !== document.supplierReference.toLowerCase() ||
      invoice.InvoiceNumber !== document.reference ||
      invoice.Url !== urlFor(postingKey, document) ||
      invoice.CurrencyCode !== document.currency ||
      businessDate(invoice.DateString ?? invoice.Date) !== document.date ||
      businessDate(invoice.DueDateString ?? invoice.DueDate) !== document.dueDate
    )
      throw new Error("Xero invoice identity differs from the prepared document");
    if (
      exactMoney(invoice.SubTotal) !== document.net ||
      exactMoney(invoice.TotalTax) !== document.tax ||
      exactMoney(invoice.Total) !== document.gross
    )
      throw new Error("Xero invoice totals differ from the prepared document");
    // Compare a multiset, retaining duplicates while allowing provider ordering changes.
    const expected = document.lines
      .map((line) =>
        JSON.stringify([line.description, line.accountReference, line.taxReference, line.net, line.tax]),
      )
      .sort();
    const actual = invoice.LineItems.map((line) =>
      JSON.stringify([
        line.Description,
        line.AccountCode,
        line.TaxType,
        exactMoney(line.LineAmount),
        exactMoney(line.TaxAmount),
      ]),
    ).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      throw new Error("Xero invoice lines differ from the prepared document");
    return accountingReceiptSchema.parse({
      provider: "xero",
      connectionId: binding.connectionId,
      companyId: binding.companyId,
      postingKey,
      externalId,
      currency: document.currency,
      net: document.net,
      tax: document.tax,
      gross: document.gross,
    });
  }
  // Keep configuration-only fields out of the strict shared receipt schema.
  async function readBack(input: { postingKey: string; document: AccountingPosting; externalId: string }) {
    try {
      const document = prepare(input.postingKey, input.document);
      const token = await options.getAccessToken();
      await verifyOrganisation(token);
      return await readInvoice(token, input.postingKey, document, input.externalId);
    } catch {
      return null;
    }
  }
  return {
    provider: "xero",
    connectionId: binding.connectionId,
    companyId: binding.companyId,
    capabilities: { postingKinds: ["purchase_invoice"], currencies: [binding.baseCurrency] },
    readBack,
    async post(input) {
      let written = false;
      try {
        const document = prepare(input.postingKey, input.document);
        z.uuid().parse(input.attemptId);
        const token = await options.getAccessToken();
        await verifyOrganisation(token);
        const invoice = {
          Type: "ACCPAY",
          Status: "AUTHORISED",
          Contact: { ContactID: document.supplierReference },
          InvoiceNumber: document.reference,
          Date: document.date,
          DueDate: document.dueDate,
          Url: urlFor(input.postingKey, document),
          CurrencyCode: document.currency,
          LineAmountTypes: "Exclusive",
          LineItems: document.lines.map((line) => ({
            Description: line.description,
            Quantity: 1,
            UnitAmount: Number(line.net),
            LineAmount: Number(line.net),
            TaxAmount: Number(line.tax),
            AccountCode: line.accountReference,
            TaxType: line.taxReference,
          })),
        };
        // Mark uncertainty before invoking the transport, including timeout/HTTP errors.
        written = true;
        const created = z
          .object({
            Invoices: z.array(z.object({ InvoiceID: z.uuid(), HasErrors: z.boolean().optional() })).length(1),
          })
          .parse(
            await request("/Invoices?summarizeErrors=false", token, {
              method: "PUT",
              headers: { "Idempotency-Key": input.postingKey },
              body: JSON.stringify({ Invoices: [invoice] }),
            }),
          );
        if (created.Invoices[0]!.HasErrors) return unavailable(true);
        return {
          outcome: "posted" as const,
          receipt: await readInvoice(token, input.postingKey, document, created.Invoices[0]!.InvoiceID),
        };
      } catch {
        return unavailable(written);
      }
    },
  };
}
