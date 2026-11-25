import type { AccountingCustomerPrepareInput, AccountingPosting } from "@knotworking/core";
import {
  accountingPostings as postings,
  customerDocuments as documents,
  workspaces,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { ApiError, badRequest } from "../errors";
import {
  assertAccountingConnection,
  enabledAccountingMappings,
  findAccountingConnection,
} from "../services/accounting";
import { findCustomerDocument } from "../services/invoicing";
import { executeLedgerCommand } from "../services/ledger-command";
import { enqueueAccountingPostingTx } from "./outbox";
import { providerDocumentIssues } from "./provider-rules";

type Document = typeof documents.$inferSelect;
const postingKind = (document: Document) =>
  document.kind === "invoice" ? "customer_invoice" : "customer_credit_note";
const conflict = (message: string) => new ApiError(409, "accounting_conflict", message);

async function destinationCurrency(db: Executor, ws: string) {
  const [row] = await db
    .select({ currency: workspaces.currency })
    .from(workspaces)
    .where(eq(workspaces.id, ws));
  return row?.currency;
}

async function findPosting(
  db: Executor,
  ws: string,
  connectionId: string,
  sourceId: string,
  kind: AccountingPosting["kind"],
) {
  const [row] = await db
    .select()
    .from(postings)
    .where(
      and(
        eq(postings.workspaceId, ws),
        eq(postings.connectionId, connectionId),
        eq(postings.sourceId, sourceId),
        eq(postings.kind, kind),
      ),
    );
  return row;
}

const postingView = (row: typeof postings.$inferSelect | undefined) =>
  row ? { id: row.id, state: row.state, externalId: row.externalId } : null;

async function originalContext(
  db: Executor,
  ws: string,
  connectionId: string,
  sourceId: string,
  companyId: string,
) {
  const source = await findCustomerDocument(db, ws, sourceId);
  const posting = await findPosting(db, ws, connectionId, sourceId, "customer_invoice");
  return {
    source,
    posting:
      posting?.state === "posted" &&
      posting.companyId === companyId &&
      posting.externalId &&
      posting.payload.kind === "customer_invoice"
        ? { externalId: posting.externalId, payload: posting.payload }
        : null,
  };
}

export async function listPreparableCustomerDocuments(
  db: Executor,
  ws: string,
  connectionId: string,
  offset: number,
) {
  const connection = await findAccountingConnection(db, ws, connectionId);
  const rows = await db
    .select({
      id: documents.id,
      number: documents.number,
      date: documents.date,
      kind: documents.kind,
      customer: documents.customer,
      currency: documents.currency,
      gross: documents.gross,
      postingId: postings.id,
      postingState: postings.state,
    })
    .from(documents)
    .leftJoin(
      postings,
      and(
        eq(postings.workspaceId, ws),
        eq(postings.connectionId, connectionId),
        eq(postings.sourceId, documents.id),
        sql`${postings.kind} in ('customer_invoice', 'customer_credit_note')`,
      ),
    )
    .where(and(eq(documents.workspaceId, ws), eq(documents.status, "issued")))
    .orderBy(desc(documents.issuedAt), desc(documents.id))
    .limit(51)
    .offset(offset);
  return { documents: rows.slice(0, 50), hasMore: rows.length > 50, disabled: connection.disabled };
}

export async function getPreparableCustomerDocument(
  db: Executor,
  ws: string,
  connectionId: string,
  id: string,
) {
  const [connection, document, maps, currency] = await Promise.all([
    findAccountingConnection(db, ws, connectionId),
    findCustomerDocument(db, ws, id),
    enabledAccountingMappings(db, ws, connectionId),
    destinationCurrency(db, ws),
  ]);
  const [existing, original] = await Promise.all([
    findPosting(db, ws, connectionId, id, postingKind(document)),
    document.creditOf ? originalContext(db, ws, connectionId, document.creditOf, connection.companyId) : null,
  ]);
  const blockers = [];
  if (document.status !== "issued")
    blockers.push("Approve and issue this document before preparing it for Xero.");
  if (connection.provider !== "xero" || !connection.companyId || connection.disabled)
    blockers.push("Enable a configured Xero connection before preparing this document.");
  if (currency !== document.currency)
    blockers.push(`This Xero connection uses ${currency}, while the document is in ${document.currency}.`);
  if (!original && !maps.customer.has(document.customerId))
    blockers.push("Review this customer's Xero contact mapping.");
  if (!original && (!maps.account.size || !maps.tax.size))
    blockers.push("Review revenue account and tax mappings.");
  if (original && !original.posting)
    blockers.push("Send and verify the original invoice on this connection first.");
  return {
    document: {
      id: document.id,
      number: document.number,
      kind: document.kind,
      currency: document.currency,
      date: document.date,
      customer: document.customer.name,
      net: document.net,
      tax: document.tax,
      gross: document.gross,
      lines: document.lines,
    },
    connectionRevision: connection.revision,
    blockers,
    mappings: {
      customer:
        original?.posting?.payload.customerReference ?? maps.customer.get(document.customerId) ?? null,
      accounts: Array.from(maps.account, ([key, value]) => ({ key, value })),
      taxes: Array.from(maps.tax, ([key, value]) => ({ key, value })),
    },
    original: original
      ? {
          number: original.source.number,
          externalId: original.posting?.externalId ?? null,
          coding: document.lines.map((line) => {
            const index = original.source.lines.findIndex((candidate) => candidate.id === line.sourceLineId);
            return original.posting?.payload.lines[index] ?? null;
          }),
        }
      : null,
    posting: postingView(existing),
  };
}

export async function prepareCustomerPosting(
  db: Database,
  ws: string,
  actorId: string,
  connectionId: string,
  id: string,
  input: AccountingCustomerPrepareInput,
) {
  return executeLedgerCommand(
    db,
    ws,
    actorId,
    "accounting.customer.prepare",
    input,
    { connectionId, id, ...input },
    async (tx) => {
      const connection = await findAccountingConnection(tx, ws, connectionId);
      if (connection.revision !== input.expectedRevision)
        throw conflict("The Xero connection setup changed. Reload its mappings.");
      if (connection.provider !== "xero") throw conflict("Customer documents require a Xero connection");
      await assertAccountingConnection(tx, ws, { ...connection, connectionId });
      const document = await findCustomerDocument(tx, ws, id);
      if (document.status !== "issued" || !document.number)
        throw conflict("Only issued customer documents can be prepared");
      if (document.currency !== (await destinationCurrency(tx, ws)))
        throw conflict("The issued document currency must match the Xero connection base currency");
      const common = {
        version: 1 as const,
        provider: connection.provider,
        connectionId,
        companyId: connection.companyId,
        sourceId: document.id,
        sourceRevision: document.revision,
        reference: document.number,
        date: document.date,
        currency: document.currency,
        net: document.net,
        tax: document.tax,
        gross: document.gross,
      };
      let posting: AccountingPosting;
      if (document.kind === "credit") {
        if (input.lines.length)
          throw badRequest("Credits use the original invoice's reviewed revenue and tax coding");
        const { source, posting: original } = await originalContext(
          tx,
          ws,
          connectionId,
          document.creditOf!,
          connection.companyId,
        );
        if (!original || !source.number)
          throw conflict("Send and verify the original invoice on this connection first");
        const lines = document.lines.map((line) => {
          const index = source.lines.findIndex((candidate) => candidate.id === line.sourceLineId);
          const coding = original.payload.lines[index];
          if (!coding) throw conflict("This credit line does not match the original posting");
          return { ...coding, description: line.description, net: line.net, tax: line.tax };
        });
        posting = {
          ...common,
          kind: "customer_credit_note",
          customerReference: original.payload.customerReference,
          lines,
          originalInvoice: {
            externalId: original.externalId,
            reference: source.number,
            allocate: input.allocate,
          },
        };
      } else {
        if (input.allocate) throw badRequest("Allocation applies only to credit notes");
        const maps = await enabledAccountingMappings(tx, ws, connectionId);
        const customerReference = maps.customer.get(document.customerId);
        if (!customerReference) throw conflict("Review the customer's Xero contact mapping first");
        const coding = new Map(input.lines.map((line) => [line.id, line]));
        if (coding.size !== document.lines.length) throw badRequest("Code every invoice line once");
        const lines = document.lines.map((line) => {
          const code = coding.get(line.id);
          if (!code) throw badRequest("Code every invoice line once");
          const accountReference = maps.account.get(code.accountKey);
          const taxReference = maps.tax.get(code.taxKey);
          if (!accountReference || !taxReference)
            throw conflict("Review the revenue account and tax mappings before preparing this invoice");
          return {
            accountReference,
            taxReference,
            description: line.description,
            net: line.net,
            tax: line.tax,
          };
        });
        posting = {
          ...common,
          kind: "customer_invoice",
          customerReference,
          dueDate: document.dueDate!,
          lines,
        };
      }
      const issues = providerDocumentIssues(connection.provider, posting);
      if (issues.length) throw conflict(issues.join(". "));
      const row = await enqueueAccountingPostingTx(
        tx,
        ws,
        `user:${actorId}`,
        posting,
        `Prepared from issued customer document ${document.number}: ${input.reason}`,
      );
      return postingView(row)!;
    },
  );
}
