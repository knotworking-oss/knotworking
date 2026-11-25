import {
  accountingPostingSchema,
  accountingReceiptSchema,
  type AccountingPosting,
  type AccountingReceipt,
} from "@knotworking/core";
import { z } from "zod";
import type { InstalledAccountingAdapter } from "../registry";

import { ApiError } from "../../errors";
import { XeroHttpError, readXeroOrganisation, xeroAccountingRequest, xeroCurrency } from "../xero-http";

type PurchaseBill = Extract<AccountingPosting, { kind: "purchase_invoice" }>;

const bindingSchema = z.object({
  connectionId: z.uuid(),
  companyId: z.uuid(),
  organisationId: z.uuid(),
  baseCurrency: xeroCurrency,
});
const activeContact = z.object({
  Contacts: z
    .array(
      z.object({
        ContactID: z.uuid(),
        ContactStatus: z.string(),
      }),
    )
    .length(1),
});
const chart = z.object({
  Accounts: z.array(
    z.object({
      Code: z.string().optional(),
      Status: z.string(),
      Class: z.string().optional(),
    }),
  ),
});
const taxRates = z.object({
  TaxRates: z.array(
    z.object({
      TaxType: z.string(),
      Status: z.string(),
      CanApplyToAssets: z.boolean().optional(),
      CanApplyToEquity: z.boolean().optional(),
      CanApplyToExpenses: z.boolean().optional(),
      CanApplyToLiabilities: z.boolean().optional(),
      CanApplyToRevenue: z.boolean().optional(),
    }),
  ),
});
const taxByClass = {
  ASSET: "CanApplyToAssets",
  EQUITY: "CanApplyToEquity",
  EXPENSE: "CanApplyToExpenses",
  LIABILITY: "CanApplyToLiabilities",
  REVENUE: "CanApplyToRevenue",
} as const;
const reject = (evidence: string) => ({ outcome: "rejected" as const, evidence });
/** A definitive reason the adapter refuses a document before any write. */
class PreflightIssue extends Error {}

/**
 * Each Knotworking document kind maps to one Xero document. Customer invoices (`ACCREC`) and
 * credit notes (the `/CreditNotes` endpoint) are added here as the shared posting schema grows.
 */
const xeroDocuments = {
  purchase_invoice: { type: "ACCPAY", sourcePath: "purchasing/invoices", contact: "supplier" },
} as const satisfies Record<
  AccountingPosting["kind"],
  { type: string; sourcePath: string; contact: "supplier" | "customer" }
>;

/**
 * What a document needs before Xero can receive it, checked when an invoice is prepared for a
 * Xero connection and again before sending. The connected organisation's currency, lock dates,
 * contact, account codes and tax types are checked against Xero itself just before the write.
 */
export function xeroDocumentIssues(
  document: Pick<PurchaseBill, "kind" | "date" | "reference" | "currency"> & {
    dueDate?: string | null;
    supplierReference: string | null;
  },
): string[] {
  const issues: string[] = [];
  if (!Object.hasOwn(xeroDocuments, document.kind)) issues.push("Xero can't receive this document type yet");
  if (!document.dueDate) issues.push("Xero needs the supplier's due date on the invoice");
  else if (document.dueDate < document.date) issues.push("The due date is before the invoice date");
  // Xero allows 255 characters; control characters would not survive its matching and search.
  if (document.reference.length > 255 || /\p{Cc}/u.test(document.reference))
    issues.push("The supplier invoice number can't be sent to Xero as written");
  if (document.supplierReference !== null && !z.uuid().safeParse(document.supplierReference).success)
    issues.push("Map the supplier to its Xero ContactID, a UUID from the contact's Xero record");
  if (!xeroCurrency.safeParse(document.currency).success)
    issues.push(`Xero bills need a two-decimal currency, not ${document.currency}`);
  return issues;
}
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
function businessDate(value: string | null | undefined): string | null {
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
  /** OAuth tenant ID; every ledger operation uses this header. */
  companyId: string;
  organisationId?: string;
  baseCurrency: string;
  /** The existing web app origin and workspace slug, for the source invoice link. */
  appUrl: string;
  workspaceSlug: string;
  getAccessToken: () => Promise<string>;
  onUnauthorized?: (token: string) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): InstalledAccountingAdapter & Required<Pick<InstalledAccountingAdapter, "readBack" | "findExisting">> {
  const binding = bindingSchema.parse({
    ...options,
    organisationId: options.organisationId ?? options.companyId,
  });
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
  const urlFor = (postingKey: string, document: PurchaseBill) =>
    `${appUrl.origin}/${workspaceSlug}/${xeroDocuments[document.kind].sourcePath}/${document.sourceId}?accountingPosting=${postingKey}`;
  function prepare(postingKey: string, input: unknown) {
    z.uuid().parse(postingKey);
    const document = accountingPostingSchema.parse(input);
    if (
      document.provider !== "xero" ||
      document.connectionId !== binding.connectionId ||
      document.companyId !== binding.companyId
    )
      throw new PreflightIssue("This posting was prepared for a different accounting destination");
    if (document.currency !== binding.baseCurrency)
      throw new PreflightIssue(
        `The bill is in ${document.currency} but the Xero organisation uses ${binding.baseCurrency}`,
      );
    const issue = xeroDocumentIssues(document)[0];
    if (issue) throw new PreflightIssue(issue);
    return document as PurchaseBill & { dueDate: string };
  }
  async function request(path: string, token: string, init: RequestInit = {}) {
    try {
      return await xeroAccountingRequest(transport, binding.companyId, token, path, init, timeout);
    } catch (error) {
      if (error instanceof XeroHttpError && error.status === 401) await options.onUnauthorized?.(token);
      throw error;
    }
  }
  async function verifyOrganisation(token: string) {
    const organisation = await readXeroOrganisation((path) => request(path, token));
    if (
      organisation.OrganisationID.toLowerCase() !== binding.organisationId.toLowerCase() ||
      organisation.BaseCurrency !== binding.baseCurrency
    )
      return null;
    return organisation;
  }
  async function mappingIssue(token: string, document: PurchaseBill) {
    const id = document.supplierReference.toLowerCase();
    const contact = activeContact.parse(await request(`/Contacts/${id}`, token)).Contacts[0]!;
    if (contact.ContactID.toLowerCase() !== id || contact.ContactStatus !== "ACTIVE")
      return "The reviewed supplier contact is not active in Xero";
    const accounts = chart.parse(await request("/Accounts", token)).Accounts;
    const rates = taxRates.parse(await request("/TaxRates", token)).TaxRates;
    for (const [index, line] of document.lines.entries()) {
      const account = accounts.find((a) => a.Code === line.accountReference && a.Status === "ACTIVE");
      if (!account) return `Line ${index + 1} needs an active Xero account code`;
      const tax = rates.find((rate) => rate.TaxType === line.taxReference && rate.Status === "ACTIVE");
      const applies = account.Class && taxByClass[account.Class as keyof typeof taxByClass];
      if (!tax || (applies && tax[applies] === false))
        return `Line ${index + 1} needs an active Xero tax type applicable to its account`;
      if (line.taxReference === "NONE" && line.tax !== "0.00")
        return `Line ${index + 1} has a tax amount against Xero's no-tax code`;
    }
    return null;
  }
  function invoiceResponse(token: string, externalId: string) {
    z.uuid().parse(externalId);
    return request(`/Invoices/${encodeURIComponent(externalId)}`, token);
  }
  function verifyInvoice(
    data: unknown,
    postingKey: string,
    document: PurchaseBill,
    externalId: string,
  ): AccountingReceipt {
    const {
      Invoices: [invoice],
    } = z.object({ Invoices: z.tuple([invoiceSchema]) }).parse(data);
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
      externalId: invoice.InvoiceID.toLowerCase(),
      currency: document.currency,
      net: document.net,
      tax: document.tax,
      gross: document.gross,
    });
  }
  async function findInvoice(token: string, postingKey: string, document: PurchaseBill) {
    // Purchase bill numbers are not unique. Look for the source URL under the original contact
    // and date, then verify the whole invoice by ID. Ambiguity and incomplete searches stay unknown.
    const candidates = z.object({
      Invoices: z.array(
        z.object({
          InvoiceID: z.uuid(),
          InvoiceNumber: z.string().optional(),
          Url: z.string().nullish(),
        }),
      ),
    });
    const date = document.date.split("-").map(Number).join(",");
    const query = new URLSearchParams({
      ContactIDs: document.supplierReference,
      where: `Type=="${xeroDocuments[document.kind].type}"&&Date==DateTime(${date})`,
      createdByMyApp: "true",
      pageSize: "100",
    });
    const source = urlFor(postingKey, document);
    const matches = new Set<string>();
    for (let page = 1; page <= 5; page++) {
      query.set("page", String(page));
      const { Invoices } = candidates.parse(await request(`/Invoices?${query}`, token));
      for (const invoice of Invoices) {
        if (invoice.InvoiceNumber === document.reference && (invoice.Url === source || !invoice.Url))
          matches.add(invoice.InvoiceID.toLowerCase());
      }
      if (matches.size > 5) return null;
      if (Invoices.length < 100) {
        let receipt: AccountingReceipt | null = null;
        for (const id of matches) {
          const data = await invoiceResponse(token, id);
          const {
            Invoices: [invoice],
          } = z
            .object({
              Invoices: z.tuple([z.object({ Url: z.string().nullish() })]),
            })
            .parse(data);
          if (invoice.Url !== source) continue;
          if (receipt) return null;
          receipt = verifyInvoice(data, postingKey, document, id);
        }
        return receipt;
      }
    }
    return null;
  }
  async function readBack(input: { postingKey: string; document: AccountingPosting; externalId?: string }) {
    try {
      const document = prepare(input.postingKey, input.document);
      const token = await options.getAccessToken();
      if (!(await verifyOrganisation(token))) return null;
      if (!input.externalId) return await findInvoice(token, input.postingKey, document);
      return verifyInvoice(
        await invoiceResponse(token, input.externalId),
        input.postingKey,
        document,
        input.externalId,
      );
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
    findExisting: readBack,
    async post(input) {
      let written = false;
      try {
        const document = prepare(input.postingKey, input.document);
        z.uuid().parse(input.attemptId);
        const token = await options.getAccessToken();
        const organisation = await verifyOrganisation(token);
        if (!organisation) return reject("The Xero organisation or base currency differs from this setup");
        const lockDates = [organisation.PeriodLockDate, organisation.EndOfYearLockDate].map(businessDate);
        if (lockDates.some((date) => date && document.date <= date))
          return reject("The invoice date falls in a locked Xero accounting period");
        const issue = await mappingIssue(token, document);
        if (issue) return reject(issue);
        const invoice = {
          Type: xeroDocuments[document.kind].type,
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
            Invoices: z
              .array(
                z.object({
                  InvoiceID: z.uuid().optional(),
                  HasErrors: z.boolean().optional(),
                  StatusAttributeString: z.string().optional(),
                  ValidationErrors: z.array(z.object({ Message: z.string() })).optional(),
                }),
              )
              .length(1),
          })
          .parse(
            await request("/Invoices?summarizeErrors=false", token, {
              method: "PUT",
              headers: { "Idempotency-Key": input.postingKey },
              body: JSON.stringify({ Invoices: [invoice] }),
            }),
          );
        const result = created.Invoices[0]!;
        const hasId = result.InvoiceID && result.InvoiceID !== "00000000-0000-0000-0000-000000000000";
        if (!hasId && result.StatusAttributeString === "ERROR" && result.ValidationErrors?.length)
          return reject("Xero rejected the bill during validation and did not create it");
        if (!hasId || result.HasErrors || result.StatusAttributeString === "ERROR") return unavailable(true);
        return {
          outcome: "posted" as const,
          receipt: verifyInvoice(
            await invoiceResponse(token, result.InvoiceID!),
            input.postingKey,
            document,
            result.InvoiceID!,
          ),
        };
      } catch (error) {
        if (!written && error instanceof PreflightIssue) return reject(error.message);
        if (!written && error instanceof ApiError && error.code === "xero_reconnect_required")
          return reject("Reconnect Xero before retrying this bill");
        if (!written && error instanceof XeroHttpError && error.status === 401)
          return reject(
            "Xero denied access during preflight. Check the connection and consent before retrying.",
          );
        if (error instanceof XeroHttpError && error.validationRejected)
          return reject("Xero rejected the bill during validation and did not create it");
        return unavailable(written);
      }
    },
  };
}
