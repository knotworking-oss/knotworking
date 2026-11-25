import {
  currencyDigits,
  type AccountingInvoicePrepareInput,
  type AccountingPosting,
} from "@knotworking/core";
import {
  accountingMappings as mappings,
  accountingPostings as postings,
  items,
  purchaseInvoiceLines,
  purchaseInvoices,
  purchaseOrderLines,
  suppliers,
  workspaces,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { ApiError, notFound } from "../errors";
import { assertAccountingConnection, findAccountingConnection } from "../services/accounting";
import { executeLedgerCommand } from "../services/ledger-command";
import { enqueueAccountingPostingTx } from "./outbox";
import { providerDocumentIssues } from "./provider-rules";

/**
 * The approved-invoice producer: turns an approved purchase invoice plus a finance reviewer's line
 * coding into the immutable snapshot the outbox posts. Purchasing records one header VAT amount
 * and unrounded line values (quantity × an 8-place price), so the reviewer supplies each line's
 * account/tax keys and printed net/tax. This code verifies them; it never spreads VAT across
 * guessed rates, rounds a total to fit, or picks an account.
 */

const conflict = (code: string, message: string, details?: unknown) =>
  new ApiError(409, code, message, details);

// Exact decimals. Quantities have 4 places and unit prices 8 (see the purchasing schema), so their
// product is exact at 12. Amounts stored with 4 places (VAT) convert exactly too.
const QUANTITY_SCALE = 4;
const PRICE_SCALE = 8;
const VALUE_SCALE = QUANTITY_SCALE + PRICE_SCALE;
const VAT_SCALE = 4;
const units = (value: number, scale: number) => BigInt(value.toFixed(scale).replace(".", ""));
const pow10 = (n: number) => 10n ** BigInt(n);
const minor = (amount: string) => BigInt(amount.replace(".", ""));
function format(value: bigint, digits: number) {
  const negative = value < 0n;
  const text = (negative ? -value : value).toString().padStart(digits + 1, "0");
  const body = digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text;
  return negative ? `-${body}` : body;
}
/** A line's exact value at `VALUE_SCALE`. */
const exactValue = (line: { quantity: number; unitPrice: number }) =>
  units(line.quantity, QUANTITY_SCALE) * units(line.unitPrice, PRICE_SCALE);
/** Half-up rounding to the currency, for a suggestion only: the reviewer confirms the printed net. */
function suggestedNet(exact: bigint, digits: number) {
  const step = pow10(VALUE_SCALE - digits);
  return format((exact + step / 2n) / step, digits);
}
/** Header VAT in currency minor units, or null when it has more places than the currency allows. */
function vatMinor(vat: number, digits: number) {
  const value = units(vat, VAT_SCALE);
  if (digits >= VAT_SCALE) return value * pow10(digits - VAT_SCALE);
  const step = pow10(VAT_SCALE - digits);
  return value % step === 0n ? value / step : null;
}

async function workspaceCurrency(db: Executor, ws: string) {
  const [row] = await db
    .select({ currency: workspaces.currency })
    .from(workspaces)
    .where(eq(workspaces.id, ws));
  return row?.currency ?? "GBP";
}

async function findApprovedSource(db: Executor, ws: string, invoiceId: string) {
  const [row] = await db
    .select({ invoice: purchaseInvoices, supplier: suppliers })
    .from(purchaseInvoices)
    .innerJoin(suppliers, eq(suppliers.id, purchaseInvoices.supplierId))
    .where(
      and(
        eq(purchaseInvoices.workspaceId, ws),
        eq(purchaseInvoices.id, invoiceId),
        isNull(purchaseInvoices.deletedAt),
      ),
    );
  if (!row) throw notFound("Invoice");
  const lines = await db
    .select({
      line: purchaseInvoiceLines,
      itemName: items.name,
      // A non-stock order line's description and the expense or nominal code it was ordered against.
      orderDescription: purchaseOrderLines.description,
      nominalCode: purchaseOrderLines.nominalCode,
    })
    .from(purchaseInvoiceLines)
    .leftJoin(items, eq(items.id, purchaseInvoiceLines.itemId))
    .leftJoin(purchaseOrderLines, eq(purchaseOrderLines.id, purchaseInvoiceLines.orderLineId))
    .where(and(eq(purchaseInvoiceLines.invoiceId, invoiceId), isNull(purchaseInvoiceLines.deletedAt)))
    .orderBy(asc(purchaseInvoiceLines.lineNo), asc(purchaseInvoiceLines.id));
  return { ...row, lines };
}

/** Postings on this connection for any other version of the same supplier invoice number. */
async function otherVersionPostings(
  db: Executor,
  ws: string,
  connectionId: string,
  invoice: { id: string; supplierId: string; invoiceNumber: string },
) {
  return db
    .select({ id: postings.id, state: postings.state, version: purchaseInvoices.version })
    .from(postings)
    .innerJoin(purchaseInvoices, eq(purchaseInvoices.id, postings.sourceId))
    .where(
      and(
        eq(postings.workspaceId, ws),
        eq(postings.connectionId, connectionId),
        eq(postings.kind, "purchase_invoice"),
        eq(purchaseInvoices.workspaceId, ws),
        eq(purchaseInvoices.supplierId, invoice.supplierId),
        sql`lower(${purchaseInvoices.invoiceNumber}) = lower(${invoice.invoiceNumber})`,
        ne(purchaseInvoices.id, invoice.id),
      ),
    );
}

async function enabledMappings(db: Executor, ws: string, connectionId: string) {
  const rows = await db
    .select({
      kind: mappings.kind,
      localReference: mappings.localReference,
      externalReference: mappings.externalReference,
    })
    .from(mappings)
    .where(
      and(eq(mappings.workspaceId, ws), eq(mappings.connectionId, connectionId), eq(mappings.enabled, true)),
    );
  const byKind = (kind: string) =>
    new Map(rows.filter((r) => r.kind === kind).map((r) => [r.localReference, r.externalReference]));
  return { supplier: byKind("supplier"), account: byKind("account"), tax: byKind("tax") };
}

function postingView(row: typeof postings.$inferSelect | undefined) {
  return row
    ? {
        id: row.id,
        state: row.state,
        attempts: row.attempts,
        externalId: row.externalId,
        payload: row.payload,
      }
    : null;
}

/** Approved invoices for a connection, newest first; `open` hides ones already prepared. */
export async function listPreparableInvoices(
  db: Database,
  ws: string,
  connectionId: string,
  query: { offset: number; show: "open" | "all" },
) {
  await findAccountingConnection(db, ws, connectionId);
  const rows = await db
    .select({
      id: purchaseInvoices.id,
      invoiceNumber: purchaseInvoices.invoiceNumber,
      version: purchaseInvoices.version,
      invoiceDate: purchaseInvoices.invoiceDate,
      dueDate: purchaseInvoices.dueDate,
      supplierName: suppliers.name,
      postingId: postings.id,
      postingState: postings.state,
    })
    .from(purchaseInvoices)
    .innerJoin(suppliers, eq(suppliers.id, purchaseInvoices.supplierId))
    .leftJoin(
      postings,
      and(
        eq(postings.workspaceId, ws),
        eq(postings.connectionId, connectionId),
        eq(postings.kind, "purchase_invoice"),
        eq(postings.sourceId, purchaseInvoices.id),
      ),
    )
    .where(
      and(
        eq(purchaseInvoices.workspaceId, ws),
        eq(purchaseInvoices.status, "approved"),
        isNull(purchaseInvoices.deletedAt),
        query.show === "open" ? isNull(postings.id) : undefined,
      ),
    )
    .orderBy(desc(purchaseInvoices.invoiceDate), desc(purchaseInvoices.id))
    .limit(51)
    .offset(query.offset);
  return { invoices: rows.slice(0, 50), hasMore: rows.length > 50 };
}

/**
 * What a reviewer needs to code one invoice: its lines with exact and suggested nets, the header
 * VAT to allocate, enabled mappings, an existing posting, and anything that blocks preparing it.
 */
export async function getPreparableInvoice(
  db: Database,
  ws: string,
  connectionId: string,
  invoiceId: string,
) {
  const connection = await findAccountingConnection(db, ws, connectionId);
  const source = await findApprovedSource(db, ws, invoiceId);
  const currency = await workspaceCurrency(db, ws);
  const digits = currencyDigits(currency);
  const mapped = await enabledMappings(db, ws, connectionId);
  const [existing] = await db
    .select()
    .from(postings)
    .where(
      and(
        eq(postings.workspaceId, ws),
        eq(postings.connectionId, connectionId),
        eq(postings.kind, "purchase_invoice"),
        eq(postings.sourceId, invoiceId),
      ),
    );
  const others = await otherVersionPostings(db, ws, connectionId, source.invoice);
  const vat = vatMinor(source.invoice.vat, digits);
  const lines = source.lines.map(({ line, itemName, orderDescription, nominalCode }) => {
    const exact = exactValue(line);
    return {
      id: line.id,
      lineNo: line.lineNo,
      kind: line.kind,
      description: line.description ?? orderDescription ?? itemName ?? `Line ${line.lineNo}`,
      /** The expense or nominal code text a non-stock order line carries, for the reviewer. */
      nominalCode,
      /** That code, when it is the local key of an enabled account mapping: a suggestion only. */
      suggestedAccountKey: nominalCode && mapped.account.has(nominalCode) ? nominalCode : null,
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitPrice,
      exactValue: format(exact, VALUE_SCALE).replace(/0+$/, "").replace(/\.$/, ""),
      suggestedNet: suggestedNet(exact, digits),
    };
  });
  const blockers: string[] = [];
  if (source.invoice.status !== "approved")
    blockers.push(
      source.invoice.status === "draft"
        ? "This invoice is a draft. Only approved invoices can be prepared."
        : "This version has been superseded. Prepare the latest approved version.",
    );
  if (!connection.companyId) blockers.push("Set the accounting company on this connection first.");
  if (connection.disabled) blockers.push("This connection is disabled.");
  if (!mapped.supplier.has(source.invoice.supplierId))
    blockers.push(`Map supplier ${source.supplier.name} on this connection first.`);
  if (!mapped.account.size) blockers.push("Add at least one account mapping first.");
  if (!mapped.tax.size) blockers.push("Add at least one tax mapping first.");
  if (vat === null) blockers.push(`The invoice VAT has more decimal places than ${currency} allows.`);
  if (lines.some((l) => l.suggestedNet.startsWith("-")))
    blockers.push("Invoices with negative lines can't be posted yet.");
  blockers.push(
    ...providerDocumentIssues(connection.provider, {
      kind: "purchase_invoice",
      date: source.invoice.invoiceDate,
      dueDate: source.invoice.dueDate,
      reference: source.invoice.invoiceNumber,
      currency,
      supplierReference: mapped.supplier.get(source.invoice.supplierId) ?? null,
    }).map((issue) => `${issue}.`),
  );
  if (others.length)
    blockers.push(
      `Version ${others[0]!.version} of this invoice was already sent to accounting. Record the correction in the accounting system; Knotworking can't post credit notes or adjustments yet.`,
    );
  return {
    connection: { id: connection.id, revision: connection.revision, name: connection.name },
    invoice: {
      id: source.invoice.id,
      invoiceNumber: source.invoice.invoiceNumber,
      version: source.invoice.version,
      status: source.invoice.status,
      invoiceDate: source.invoice.invoiceDate,
      dueDate: source.invoice.dueDate,
      supplier: { id: source.supplier.id, name: source.supplier.name },
      currency,
      vat: vat === null ? null : format(vat, digits),
    },
    lines,
    supplierReference: mapped.supplier.get(source.invoice.supplierId) ?? null,
    accountKeys: [...mapped.account.keys()].sort(),
    taxKeys: [...mapped.tax.keys()].sort(),
    posting: postingView(existing),
    blockers: existing ? [] : blockers,
  };
}

/**
 * Prepares (enqueues) one approved invoice for a connection. A person's administrative act: the
 * route refuses tokens. Checks, all inside the posting transaction:
 *  - the connection revision the reviewer saw, its company and enabled state;
 *  - the invoice is approved, and no other version is already posted on this connection;
 *  - every live line is coded exactly once, each net within one minor unit of quantity × price;
 *  - line tax adds up exactly to the header VAT;
 *  - the supplier and every account/tax key resolve to enabled reviewed mappings.
 * Repeating the same command returns its receipt; an identical snapshot returns the existing
 * posting; a changed one conflicts in the outbox.
 */
export async function prepareInvoicePosting(
  db: Database,
  ws: string,
  actorId: string,
  connectionId: string,
  invoiceId: string,
  input: AccountingInvoicePrepareInput,
) {
  return executeLedgerCommand(
    db,
    ws,
    actorId,
    "accounting.invoice.prepare",
    input,
    { connectionId, invoiceId, ...input },
    async (tx) => {
      const connection = await findAccountingConnection(tx, ws, connectionId);
      if (connection.revision !== input.expectedRevision)
        throw conflict(
          "accounting_conflict",
          "This connection's setup changed. Reload and review its latest mappings.",
        );
      await assertAccountingConnection(tx, ws, {
        connectionId,
        provider: connection.provider,
        companyId: connection.companyId,
      });
      const source = await findApprovedSource(tx, ws, invoiceId);
      const { invoice, supplier } = source;
      if (invoice.status !== "approved")
        throw conflict(
          "invoice_not_approved",
          invoice.status === "draft"
            ? "Only approved invoices can be prepared for accounting"
            : "This version has been superseded. Prepare the latest approved version.",
        );
      const others = await otherVersionPostings(tx, ws, connectionId, invoice);
      if (others.length)
        throw conflict(
          "invoice_already_posted",
          `Version ${others[0]!.version} of invoice ${invoice.invoiceNumber} was already sent to this accounting connection. Record the correction in the accounting system; Knotworking can't post credit notes or adjustments yet.`,
          { postingId: others[0]!.id },
        );

      const currency = await workspaceCurrency(tx, ws);
      const digits = currencyDigits(currency);
      const precision = (amount: string) => (amount.split(".")[1]?.length ?? 0) === digits;
      const coded = new Map(input.lines.map((l) => [l.invoiceLineId, l]));
      const live = new Set(source.lines.map(({ line }) => line.id));
      const unknown = input.lines.filter((l) => !live.has(l.invoiceLineId));
      const missing = source.lines.filter(({ line }) => !coded.has(line.id));
      if (unknown.length || missing.length)
        throw new ApiError(400, "invoice_lines_mismatch", "Code every line of this invoice exactly once", {
          unknown: unknown.map((l) => l.invoiceLineId),
          missing: missing.map(({ line }) => line.id),
        });

      const step = pow10(VALUE_SCALE - digits);
      const lines: AccountingPosting["lines"] = [];
      const offLines: number[] = [];
      for (const { line } of source.lines) {
        const code = coded.get(line.id)!;
        if (!precision(code.net) || !precision(code.tax))
          throw new ApiError(
            400,
            "amount_precision",
            `Amounts in ${currency} must have exactly ${digits} decimal places`,
          );
        const exact = exactValue(line);
        if (exact < 0n) throw conflict("negative_line", "Invoices with negative lines can't be posted yet");
        const difference = minor(code.net) * step - exact;
        if ((difference < 0n ? -difference : difference) >= step) offLines.push(line.lineNo);
        lines.push({
          accountReference: code.accountKey,
          taxReference: code.taxKey,
          description: code.description,
          net: code.net,
          tax: code.tax,
        });
      }
      if (offLines.length)
        throw new ApiError(
          400,
          "line_net_mismatch",
          `The net on line ${offLines.join(", ")} differs from quantity × price by a minor unit or more`,
          { lineNos: offLines },
        );
      const vat = vatMinor(invoice.vat, digits);
      if (vat === null)
        throw conflict("vat_precision", `The invoice VAT has more decimal places than ${currency} allows`);
      const tax = lines.reduce((sum, l) => sum + minor(l.tax), 0n);
      if (tax !== vat)
        throw new ApiError(
          400,
          "tax_mismatch",
          `Line tax adds up to ${format(tax, digits)} but the invoice VAT is ${format(vat, digits)}`,
        );

      const mapped = await enabledMappings(tx, ws, connectionId);
      const supplierReference = mapped.supplier.get(invoice.supplierId);
      const unmapped = {
        supplier: supplierReference ? [] : [supplier.name],
        account: [...new Set(lines.map((l) => l.accountReference))].filter((k) => !mapped.account.has(k)),
        tax: [...new Set(lines.map((l) => l.taxReference))].filter((k) => !mapped.tax.has(k)),
      };
      if (unmapped.supplier.length || unmapped.account.length || unmapped.tax.length)
        throw conflict(
          "mapping_missing",
          "Review the supplier, account and tax mappings this invoice uses before preparing it",
          unmapped,
        );
      // The snapshot carries the destination's references as reviewed now; a later mapping change
      // does not alter an already prepared posting.
      for (const line of lines) {
        line.accountReference = mapped.account.get(line.accountReference)!;
        line.taxReference = mapped.tax.get(line.taxReference)!;
      }
      const net = lines.reduce((sum, l) => sum + minor(l.net), 0n);
      if (net + tax === 0n)
        throw new ApiError(400, "zero_invoice", "A posting must have a positive gross amount");
      const posting: AccountingPosting = {
        version: 1,
        provider: connection.provider,
        connectionId,
        companyId: connection.companyId,
        kind: "purchase_invoice",
        sourceId: invoice.id,
        sourceRevision: invoice.version,
        supplierReference: supplierReference!,
        reference: invoice.invoiceNumber,
        date: invoice.invoiceDate,
        ...(invoice.dueDate ? { dueDate: invoice.dueDate } : {}),
        currency,
        lines,
        net: format(net, digits),
        tax: format(tax, digits),
        gross: format(net + tax, digits),
      };
      const issues = providerDocumentIssues(connection.provider, posting);
      if (issues.length) throw conflict("provider_document_invalid", `${issues.join(". ")}.`, { issues });
      const row = await enqueueAccountingPostingTx(
        tx,
        ws,
        `user:${actorId}`,
        posting,
        `Prepared from approved invoice ${invoice.invoiceNumber} v${invoice.version}: ${input.reason}`.slice(
          0,
          4000,
        ),
      );
      return postingView(row)!;
    },
  );
}
