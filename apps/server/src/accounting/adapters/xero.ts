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

type Credit = Extract<AccountingPosting, { kind: "customer_credit_note" }>;

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
      /** The percentage Xero applies, compound components included. */
      EffectiveRate: z.number().finite().nonnegative().optional(),
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
const defer = (evidence: string) => ({ outcome: "deferred" as const, evidence });
/** A definitive reason the adapter refuses a document before any write. */
class PreflightIssue extends Error {}
/** How long a lookup of the organisation, chart, tax rates or a contact is reused. */
const lookupTtlMs = 60_000;
/** The difference allowed between a line's tax and its Xero rate applied to its amount. */
const taxToleranceCents = 1;

/** Xero refuses these before processing the request, so a refused write did not happen. */
function refusedBeforeProcessing(error: unknown): error is XeroHttpError {
  return error instanceof XeroHttpError && [401, 403, 429].includes(error.status);
}
const isReconnect = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.code === "xero_reconnect_required";

/** The tax Xero expects on one line: amounts are tax-exclusive, tax-inclusive or untaxed. */
export function expectedLineTaxCents(
  amount: string,
  effectiveRate: number,
  lineAmountTypes: "Exclusive" | "Inclusive" | "NoTax",
): number {
  const cents = Math.round(Number(amount) * 100);
  if (lineAmountTypes === "NoTax") return 0;
  if (lineAmountTypes === "Inclusive") return (cents * effectiveRate) / (100 + effectiveRate);
  return (cents * effectiveRate) / 100;
}

const xeroDocuments = {
  purchase_invoice: {
    type: "ACCPAY",
    sourcePath: "purchasing/invoices",
    collection: "Invoices",
    id: "InvoiceID",
    number: "InvoiceNumber",
  },
  customer_invoice: {
    type: "ACCREC",
    sourcePath: "invoicing",
    collection: "Invoices",
    id: "InvoiceID",
    number: "InvoiceNumber",
  },
  customer_credit_note: {
    type: "ACCRECCREDIT",
    sourcePath: "invoicing",
    collection: "CreditNotes",
    id: "CreditNoteID",
    number: "CreditNoteNumber",
  },
} as const satisfies Record<
  AccountingPosting["kind"],
  {
    type: string;
    sourcePath: string;
    collection: string;
    id: string;
    number: string;
  }
>;
const contactOf = (document: AccountingPosting) =>
  document.kind === "purchase_invoice" ? document.supplierReference : document.customerReference;
const creditReference = (postingKey: string, document: Credit) =>
  `KW ${postingKey} / ${document.originalInvoice.reference}`;

/** Checked at preparation and again before sending. Xero validates the live ledger separately. */
export function xeroDocumentIssues(
  document: Pick<AccountingPosting, "kind" | "date" | "reference" | "currency"> & {
    dueDate?: string | null;
    supplierReference?: string | null;
    customerReference?: string | null;
    originalInvoice?: Credit["originalInvoice"];
  },
): string[] {
  const issues: string[] = [];
  const supplier = document.kind === "purchase_invoice";
  if (!Object.hasOwn(xeroDocuments, document.kind)) issues.push("Xero can't receive this document type yet");
  if (document.kind !== "customer_credit_note") {
    if (!document.dueDate)
      issues.push(
        supplier
          ? "Xero needs the supplier's due date on the invoice"
          : "Xero needs a due date on the invoice",
      );
    else if (document.dueDate < document.date) issues.push("The due date is before the invoice date");
  } else if (!z.uuid().safeParse(document.originalInvoice?.externalId).success) {
    issues.push("Verify the original Xero invoice before preparing its credit note");
  }
  if (document.reference.length > 255 || /\p{Cc}/u.test(document.reference))
    issues.push(
      supplier
        ? "The supplier invoice number can't be sent to Xero as written"
        : "The document number can't be sent to Xero as written",
    );
  const contact = supplier ? document.supplierReference : document.customerReference;
  if (contact != null && !z.uuid().safeParse(contact).success)
    issues.push(
      `Map the ${supplier ? "supplier" : "customer"} to its Xero ContactID, a UUID from the contact's Xero record`,
    );
  if (!xeroCurrency.safeParse(document.currency).success)
    issues.push(
      `Xero ${supplier ? "bills" : "documents"} need a two-decimal currency, not ${document.currency}`,
    );
  return issues;
}
const money = z.number().finite().nonnegative();
const documentSchema = z.object({
  Type: z.enum(["ACCPAY", "ACCREC", "ACCRECCREDIT"]),
  Status: z.enum(["AUTHORISED", "PAID"]),
  Contact: z.object({ ContactID: z.uuid() }),
  CurrencyCode: z.string(),
  Date: z.string().optional(),
  DateString: z.string().optional(),
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
const invoiceFields = z.object({
  InvoiceID: z.uuid(),
  InvoiceNumber: z.string(),
  Url: z.string(),
  DueDate: z.string().optional(),
  DueDateString: z.string().optional(),
});
const allocationSchema = z.object({
  Invoice: z.object({ InvoiceID: z.uuid() }),
  Amount: money,
  IsDeleted: z.boolean().optional(),
});
const creditFields = z.object({
  CreditNoteID: z.uuid(),
  CreditNoteNumber: z.string(),
  Reference: z.string(),
  Allocations: z.array(allocationSchema).nullish(),
});
function single<T extends z.ZodType>(data: unknown, collection: string, schema: T): z.infer<T> {
  return z.object({ [collection]: z.tuple([schema]) }).parse(data)[collection]![0]!;
}
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
/** Bills are sent with tax-exclusive line amounts. */
const lineAmountTypes = "Exclusive" as const;
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
  /** Xero refused this access token (401): mark it expired so the next one is refreshed. */
  onUnauthorized?: (token: string) => Promise<void>;
  /**
   * Xero refused this tenant (403). Resolves true when the organisation is no longer connected
   * to this app in Xero, after marking the setup as needing to be reconnected.
   */
  onForbidden?: (token: string) => Promise<boolean>;
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
    throw new Error(
      "APP_URL must be the application origin alone (scheme, host and port, no path): " +
        "Xero bills link back to it and recovery searches for that exact link",
    );
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
    return document;
  }
  /**
   * One operation's access to Xero. A 401 marks the token expired and retries once with a
   * refreshed one; refusing to refresh (invalid_grant) surfaces as reconnect-required. A 403 asks
   * whether the organisation is still connected to this app.
   */
  function session() {
    let token: Promise<string> | null = null;
    return async function request(path: string, init: RequestInit = {}): Promise<unknown> {
      for (let attempt = 0; ; attempt++) {
        token ??= options.getAccessToken();
        const current = await token;
        try {
          return await xeroAccountingRequest(transport, binding.companyId, current, path, init, timeout);
        } catch (error) {
          if (
            error instanceof XeroHttpError &&
            error.status === 401 &&
            attempt === 0 &&
            options.onUnauthorized
          ) {
            await options.onUnauthorized(current);
            token = null;
            continue;
          }
          if (error instanceof XeroHttpError && error.status === 403 && (await forbidden(current)))
            throw new ApiError(
              409,
              "xero_reconnect_required",
              "This Xero organisation is no longer connected to Knotworking. Reconnect Xero to continue.",
            );
          throw error;
        }
      }
    };
  }
  type Request = ReturnType<typeof session>;
  async function forbidden(token: string) {
    try {
      return (await options.onForbidden?.(token)) ?? false;
    } catch {
      return false;
    }
  }
  // Lookups are shared by the bills of one dispatch pass (Xero allows 60 calls a minute per
  // organisation), and expire quickly so a long-lived adapter still sees changes in Xero.
  const lookups = new Map<string, { at: number; value: Promise<unknown> }>();
  function lookup<T>(path: string, request: Request, parse: (data: unknown) => T): Promise<T> {
    const hit = lookups.get(path);
    if (hit && Date.now() - hit.at < lookupTtlMs) return hit.value as Promise<T>;
    const value = request(path).then(parse);
    lookups.set(path, { at: Date.now(), value });
    value.catch(() => lookups.get(path)?.value === value && lookups.delete(path));
    return value;
  }
  async function verifyOrganisation(request: Request) {
    const organisation = await lookup("/Organisation", request, (data) =>
      readXeroOrganisation(async () => data),
    );
    if (
      organisation.OrganisationID.toLowerCase() !== binding.organisationId.toLowerCase() ||
      organisation.BaseCurrency !== binding.baseCurrency
    )
      return null;
    return organisation;
  }
  async function mappingIssue(request: Request, document: AccountingPosting) {
    const id = contactOf(document).toLowerCase();
    const contact = (await lookup(`/Contacts/${id}`, request, (data) => activeContact.parse(data)))
      .Contacts[0]!;
    if (contact.ContactID.toLowerCase() !== id || contact.ContactStatus !== "ACTIVE")
      return `The reviewed ${document.kind === "purchase_invoice" ? "supplier" : "customer"} contact is not active in Xero`;
    const accounts = (await lookup("/Accounts", request, (data) => chart.parse(data))).Accounts;
    const rates = (await lookup("/TaxRates", request, (data) => taxRates.parse(data))).TaxRates;
    for (const [index, line] of document.lines.entries()) {
      const account = accounts.find((a) => a.Code === line.accountReference && a.Status === "ACTIVE");
      if (!account) return `Line ${index + 1} needs an active Xero account code`;
      if (document.kind !== "purchase_invoice" && account.Class !== "REVENUE")
        return `Line ${index + 1} needs a Xero revenue account`;
      const tax = rates.find((rate) => rate.TaxType === line.taxReference && rate.Status === "ACTIVE");
      const applies = account.Class && taxByClass[account.Class as keyof typeof taxByClass];
      if (!tax || (applies && tax[applies] === false))
        return `Line ${index + 1} needs an active Xero tax type applicable to its account`;
      const rate = tax.EffectiveRate ?? (tax.TaxType === "NONE" ? 0 : undefined);
      if (document.kind !== "purchase_invoice" && rate === undefined)
        return `Line ${index + 1} needs a Xero tax type with a known effective rate`;
      const issue = taxIssue(index, line, rate);
      if (issue) return issue;
    }
    return null;
  }
  function taxIssue(index: number, line: AccountingPosting["lines"][number], rate: number | undefined) {
    if (rate === undefined) return null; // Xero did not say; its own validation still applies.
    if (rate === 0)
      return line.tax === "0.00" ? null : `Line ${index + 1} has a tax amount against a 0% Xero tax rate`;
    const expected = expectedLineTaxCents(line.net, rate, lineAmountTypes);
    if (Math.abs(Math.round(Number(line.tax) * 100) - expected) > taxToleranceCents + 1e-9)
      return `Line ${index + 1} tax ${line.tax} is not ${rate}% of its net amount ${line.net} in Xero`;
    return null;
  }
  function documentResponse(request: Request, document: AccountingPosting, externalId: string) {
    z.uuid().parse(externalId);
    return request(`/${xeroDocuments[document.kind].collection}/${encodeURIComponent(externalId)}`);
  }
  function verifyDocument(
    data: unknown,
    postingKey: string,
    document: AccountingPosting,
    externalId: string,
    checkAllocation = true,
  ): AccountingReceipt {
    const type = xeroDocuments[document.kind];
    const invoice = single(data, type.collection, documentSchema);
    let id: string;
    if (document.kind === "customer_credit_note") {
      const credit = single(data, type.collection, creditFields);
      id = credit.CreditNoteID;
      if (
        credit.CreditNoteNumber !== document.reference ||
        credit.Reference !== creditReference(postingKey, document)
      )
        throw new Error("Xero credit note identity differs from the prepared document");
      if (checkAllocation && document.originalInvoice.allocate && !verifiedAllocation(credit, document))
        throw new Error("The expected credit allocation was not verified");
    } else {
      const header = single(data, type.collection, invoiceFields);
      id = header.InvoiceID;
      if (
        header.InvoiceNumber !== document.reference ||
        header.Url !== urlFor(postingKey, document) ||
        businessDate(header.DueDateString ?? header.DueDate) !== document.dueDate
      )
        throw new Error("Xero invoice identity differs from the prepared document");
    }
    if (
      invoice.HasErrors ||
      invoice.Type !== type.type ||
      id.toLowerCase() !== externalId.toLowerCase() ||
      invoice.Contact.ContactID.toLowerCase() !== contactOf(document).toLowerCase() ||
      invoice.CurrencyCode !== document.currency ||
      businessDate(invoice.DateString ?? invoice.Date) !== document.date
    )
      throw new Error("Xero document identity differs from the prepared document");
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
      externalId: id.toLowerCase(),
      currency: document.currency,
      net: document.net,
      tax: document.tax,
      gross: document.gross,
    });
  }
  async function findInvoice(request: Request, postingKey: string, document: AccountingPosting) {
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
      ContactIDs: contactOf(document),
      where: `Type=="${xeroDocuments[document.kind].type}"&&Date==DateTime(${date})`,
      createdByMyApp: "true",
      pageSize: "100",
    });
    const source = urlFor(postingKey, document);
    const matches = new Set<string>();
    for (let page = 1; page <= 5; page++) {
      query.set("page", String(page));
      const { Invoices } = candidates.parse(await request(`/Invoices?${query}`));
      for (const invoice of Invoices) {
        if (invoice.InvoiceNumber === document.reference && (invoice.Url === source || !invoice.Url))
          matches.add(invoice.InvoiceID.toLowerCase());
      }
      if (matches.size > 5) return null;
      if (Invoices.length < 100) {
        let receipt: AccountingReceipt | null = null;
        for (const id of matches) {
          const data = await documentResponse(request, document, id);
          const {
            Invoices: [invoice],
          } = z
            .object({
              Invoices: z.tuple([z.object({ Url: z.string().nullish() })]),
            })
            .parse(data);
          if (invoice.Url !== source) continue;
          if (receipt) return null;
          receipt = verifyDocument(data, postingKey, document, id);
        }
        return receipt;
      }
    }
    return null;
  }
  async function findCredit(request: Request, postingKey: string, document: Credit) {
    // Credit notes have no Url field. Use the unique credit number to find candidates and
    // verify our Reference (including the posting key), amounts and allocation by ID.
    const reference = document.reference;
    if (!/^[A-Z0-9-]+$/.test(reference)) return null;
    const query = new URLSearchParams({
      where: `Type=="ACCRECCREDIT"&&CreditNoteNumber=="${reference}"`,
      page: "1",
      pageSize: "100",
    });
    const { CreditNotes } = z
      .object({
        CreditNotes: z.array(z.object({ CreditNoteID: z.uuid(), CreditNoteNumber: z.string() })),
      })
      .parse(await request(`/CreditNotes?${query}`));
    if (CreditNotes.length >= 100) return null;
    const matches = CreditNotes.filter((note) => note.CreditNoteNumber === reference);
    if (matches.length !== 1) return null;
    const id = matches[0]!.CreditNoteID;
    return verifyDocument(await documentResponse(request, document, id), postingKey, document, id);
  }

  async function originalInvoice(request: Request, document: Credit) {
    const source = document.originalInvoice;
    const invoice = single(
      await request(`/Invoices/${z.uuid().parse(source.externalId)}`),
      "Invoices",
      z.object({
        InvoiceID: z.uuid(),
        InvoiceNumber: z.string(),
        Type: z.literal("ACCREC"),
        Status: z.enum(["AUTHORISED", "PAID"]),
        Contact: z.object({ ContactID: z.uuid() }),
        CurrencyCode: z.string(),
        AmountDue: money.optional(),
      }),
    );
    if (
      invoice.InvoiceID.toLowerCase() !== source.externalId.toLowerCase() ||
      invoice.InvoiceNumber !== source.reference ||
      invoice.CurrencyCode !== document.currency ||
      invoice.Contact.ContactID.toLowerCase() !== contactOf(document).toLowerCase()
    )
      throw new PreflightIssue("The original Xero invoice does not match the reviewed invoice");
    return invoice;
  }

  function verifiedAllocation(credit: z.infer<typeof creditFields>, document: Credit) {
    const active = credit.Allocations?.filter((item) => !item.IsDeleted) ?? [];
    return (
      active.length > 0 &&
      active.every(
        (item) => item.Invoice.InvoiceID.toLowerCase() === document.originalInvoice.externalId.toLowerCase(),
      ) &&
      active.reduce((sum, item) => sum + Math.round(item.Amount * 100), 0) ===
        Math.round(Number(document.gross) * 100)
    );
  }

  async function allocateCredit(
    request: Request,
    document: Credit,
    postingKey: string,
    data: unknown,
    creditId: string,
  ) {
    const credit = single(data, "CreditNotes", creditFields);
    if (verifiedAllocation(credit, document)) return data;
    if (credit.Allocations?.some((item) => !item.IsDeleted))
      throw new Error("This credit already has allocations");
    await request(`/CreditNotes/${creditId}/Allocations?summarizeErrors=false`, {
      method: "PUT",
      headers: { "Idempotency-Key": `${postingKey}-allocation` },
      body: JSON.stringify({
        Allocations: [
          {
            Invoice: { InvoiceID: document.originalInvoice.externalId },
            Amount: Number(document.gross),
            Date: document.date,
          },
        ],
      }),
    });
    return documentResponse(request, document, creditId);
  }

  async function readBack(input: { postingKey: string; document: AccountingPosting; externalId?: string }) {
    try {
      const document = prepare(input.postingKey, input.document);
      const request = session();
      if (!(await verifyOrganisation(request))) return null;
      if (document.kind === "customer_credit_note") await originalInvoice(request, document);
      if (!input.externalId)
        return document.kind === "customer_credit_note"
          ? await findCredit(request, input.postingKey, document)
          : await findInvoice(request, input.postingKey, document);
      return verifyDocument(
        await documentResponse(request, document, input.externalId),
        input.postingKey,
        document,
        input.externalId,
      );
    } catch {
      return null;
    }
  }
  return {
    async customerCoding() {
      const request = session();
      if (!(await verifyOrganisation(request))) return null;
      const { Accounts } = await lookup("/Accounts", request, (data) => chart.parse(data));
      const { TaxRates } = await lookup("/TaxRates", request, (data) => taxRates.parse(data));
      return {
        revenueAccounts: new Set(
          Accounts.flatMap((account) =>
            account.Status === "ACTIVE" && account.Class === "REVENUE" && account.Code ? [account.Code] : [],
          ),
        ),
        taxRates: new Map(
          TaxRates.flatMap((tax) => {
            const rate = tax.EffectiveRate ?? (tax.TaxType === "NONE" ? 0 : undefined);
            return tax.Status === "ACTIVE" && tax.CanApplyToRevenue !== false && rate !== undefined
              ? [[tax.TaxType, rate] as const]
              : [];
          }),
        ),
      };
    },
    provider: "xero",
    connectionId: binding.connectionId,
    companyId: binding.companyId,
    capabilities: {
      postingKinds: ["purchase_invoice", "customer_invoice", "customer_credit_note"],
      currencies: [binding.baseCurrency],
    },
    readBack,
    findExisting: readBack,
    async post(input) {
      let written = false;
      let accepted = false;
      try {
        const document = prepare(input.postingKey, input.document);
        z.uuid().parse(input.attemptId);
        const request = session();
        const organisation = await verifyOrganisation(request);
        if (!organisation) return reject("The Xero organisation or base currency differs from this setup");
        const lockDates = [organisation.PeriodLockDate, organisation.EndOfYearLockDate].map(businessDate);
        if (lockDates.some((date) => date && document.date <= date))
          return reject("The invoice date falls in a locked Xero accounting period");
        const issue = await mappingIssue(request, document);
        if (issue) return reject(issue);
        const type = xeroDocuments[document.kind];
        const credit = document.kind === "customer_credit_note";
        if (credit) {
          const original = await originalInvoice(request, document);
          if (
            document.originalInvoice.allocate &&
            (original.AmountDue === undefined || original.AmountDue < Number(document.gross))
          )
            return reject(
              "The original Xero invoice does not have enough outstanding balance for this allocation",
            );
        }
        const invoice = {
          Type: type.type,
          Status: "AUTHORISED",
          Contact: { ContactID: contactOf(document) },
          [type.number]: document.reference,
          Date: document.date,
          ...(credit
            ? { Reference: creditReference(input.postingKey, document) }
            : {
                DueDate: document.dueDate,
                Url: urlFor(input.postingKey, document),
              }),
          CurrencyCode: document.currency,
          LineAmountTypes: lineAmountTypes,
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
        let response: unknown;
        try {
          // Mark uncertainty before invoking the transport, including timeout/HTTP errors.
          written = true;
          // A 401 is retried once, after a refresh, under the same Idempotency-Key.
          response = await request(`/${type.collection}?summarizeErrors=false`, {
            method: "PUT",
            headers: { "Idempotency-Key": input.idempotencyKey ?? input.postingKey },
            body: JSON.stringify({ [type.collection]: [invoice] }),
          });
        } catch (error) {
          // Authentication, authorisation and rate limiting refuse a request before Xero
          // processes it, and needing to reconnect means the request was never sent again.
          if (refusedBeforeProcessing(error) || isReconnect(error)) written = false;
          throw error;
        }
        const result = single(
          response,
          type.collection,
          z.object({
            [type.id]: z.uuid().optional(),
            HasErrors: z.boolean().optional(),
            StatusAttributeString: z.string().optional(),
            ValidationErrors: z.array(z.object({ Message: z.string() })).optional(),
          }),
        );
        const id = result[type.id] as string | undefined;
        const hasId = id && id !== "00000000-0000-0000-0000-000000000000";
        if (
          !hasId &&
          result.StatusAttributeString === "ERROR" &&
          Array.isArray(result.ValidationErrors) &&
          result.ValidationErrors.length
        )
          return reject("Xero rejected the document during validation and did not create it");
        if (!id || !hasId || result.HasErrors || result.StatusAttributeString === "ERROR")
          return unavailable(true);
        accepted = true;
        let data = await documentResponse(request, document, id);
        if (credit && document.originalInvoice.allocate) {
          verifyDocument(data, input.postingKey, document, id, false);
          data = await allocateCredit(request, document, input.postingKey, data, id);
        }
        return { outcome: "posted" as const, receipt: verifyDocument(data, input.postingKey, document, id) };
      } catch (error) {
        if (!written && error instanceof PreflightIssue) return reject(error.message);
        if (!written && isReconnect(error))
          return defer(`${error.message} The document stays queued and is sent once Xero is reconnected.`);
        if (!written && error instanceof XeroHttpError && error.status === 429)
          return defer("Xero's rate limit was reached before the document was sent; it stays queued");
        if (!written && error instanceof XeroHttpError && error.status === 401)
          return reject(
            "Xero denied access, even after refreshing it. Check the connection and consent before retrying.",
          );
        if (!written && error instanceof XeroHttpError && error.status === 403)
          return reject(
            "Xero refused access to this organisation. Check the connected user's Xero permissions before retrying.",
          );
        if (!accepted && error instanceof XeroHttpError && error.validationRejected)
          return reject("Xero rejected the document during validation and did not create it");
        return unavailable(written);
      }
    },
  };
}
