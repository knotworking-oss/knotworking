import {
  accountingAmountSchema,
  currencyDigits,
  newId,
  salesTotal,
  type InvoiceDecisionInput,
  type InvoiceDraftInput,
  type InvoiceEditInput,
  type InvoiceLine,
  type InvoiceManualLine,
} from "@knotworking/core";
import {
  customerDocumentClaims as claims,
  customerDocumentEvents as events,
  customerDocuments as documents,
  workspaces,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, desc, eq, max } from "drizzle-orm";
import { badRequest, notFound } from "../errors";
import { findCustomer } from "./customers";
import {
  activeClaims,
  assertInvoiceSourcesCurrent,
  despatchInvoiceSource,
  invoiceConflict,
  salesInvoiceSource,
  serviceInvoiceSource,
} from "./invoice-sources";
import { executeLedgerCommand } from "./ledger-command";
import { workspaceToday } from "./time-zone";

type Document = typeof documents.$inferSelect;
type Claim = Pick<typeof claims.$inferInsert, "kind" | "sourceId" | "orderLineId" | "quantity">;
const scope = (ws: string, id: string) => and(eq(documents.workspaceId, ws), eq(documents.id, id));

export async function findCustomerDocument(db: Executor, ws: string, id: string) {
  const [doc] = await db.select().from(documents).where(scope(ws, id));
  if (!doc) throw notFound("Customer document");
  return doc;
}

export async function listCustomerDocuments(db: Executor, ws: string, offset: number) {
  const rows = await db
    .select({
      id: documents.id,
      number: documents.number,
      kind: documents.kind,
      status: documents.status,
      customer: documents.customer,
      currency: documents.currency,
      gross: documents.gross,
      date: documents.date,
    })
    .from(documents)
    .where(eq(documents.workspaceId, ws))
    .orderBy(desc(documents.createdAt), desc(documents.id))
    .limit(51)
    .offset(offset);
  return { documents: rows.slice(0, 50), nextOffset: rows.length > 50 ? offset + 50 : null };
}

export async function getCustomerDocument(db: Executor, ws: string, id: string) {
  const document = await findCustomerDocument(db, ws, id);
  const history = await db
    .select({
      revision: events.revision,
      action: events.action,
      reason: events.reason,
      actorId: events.actorId,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(and(eq(events.workspaceId, ws), eq(events.documentId, id)))
    .orderBy(asc(events.revision));
  const credits =
    document.kind === "invoice"
      ? await db
          .select({
            id: documents.id,
            number: documents.number,
            status: documents.status,
            gross: documents.gross,
          })
          .from(documents)
          .where(and(eq(documents.workspaceId, ws), eq(documents.creditOf, id)))
      : [];
  const creditedLineIds = await activeClaims(
    db,
    ws,
    "credit_line",
    document.lines.map((line) => line.id),
  );
  return { ...document, history, credits, creditedLineIds: [...creditedLineIds] };
}

async function record(
  tx: Transaction,
  document: Document,
  actorId: string,
  action: (typeof events.$inferInsert)["action"],
  reason: string,
) {
  await tx.insert(events).values({
    workspaceId: document.workspaceId,
    documentId: document.id,
    revision: document.revision,
    actorId,
    action,
    reason,
    snapshot: document,
  });
  return document;
}

function decimalUnits(value: string, digits: number) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(digits, "0"));
}

function money(minor: bigint, digits: number) {
  const value = minor.toString().padStart(digits + 1, "0");
  return digits ? `${value.slice(0, -digits)}.${value.slice(-digits)}` : value;
}

function calculateLine(line: InvoiceLine, digits: number): InvoiceLine {
  const scale = 10n ** BigInt(16 - digits);
  const net = line.priceLocked
    ? decimalUnits(line.net, digits)
    : (decimalUnits(line.quantity, 8) * decimalUnits(line.unitPrice, 8) + scale / 2n) / scale;
  const tax = (net * decimalUnits(line.taxRate.toFixed(4), 4) + 500_000n) / 1_000_000n;
  return { ...line, net: money(net, digits), tax: money(tax, digits) };
}

function total(lineInputs: InvoiceLine[], currency: string, recalculate = true) {
  const digits = currencyDigits(currency);
  const lines = recalculate ? lineInputs.map((line) => calculateLine(line, digits)) : lineInputs;
  const net = salesTotal(
    lines.map((line) => line.net),
    digits,
  );
  const tax = salesTotal(
    lines.map((line) => line.tax),
    digits,
  );
  const gross = salesTotal([net, tax], digits);
  if (![net, tax, gross].every((value) => accountingAmountSchema.safeParse(value).success))
    throw badRequest("Document values exceed the supported amount");
  return { lines, net, tax, gross };
}

function manualLines(lines: InvoiceManualLine[]): InvoiceLine[] {
  return lines.map((line) => ({
    ...line,
    id: newId(),
    net: "",
    tax: "",
    priceLocked: false,
    sourceLineId: null,
  }));
}

function assertDates(date: string, dueDate: string) {
  if (dueDate < date) throw badRequest("Choose a due date on or after the invoice date");
}

export async function draftCustomerDocument(
  db: Database,
  ws: string,
  actorId: string,
  input: InvoiceDraftInput,
  useDespatch: boolean,
) {
  return executeLedgerCommand(db, ws, actorId, "invoicing.draft", input, input, async (tx) => {
    let fields: typeof documents.$inferInsert;
    let reservations: Claim[] = [];
    if (input.kind === "credit") {
      const original = await findCustomerDocument(tx, ws, input.sourceId);
      if (original.kind !== "invoice" || original.status !== "issued")
        throw invoiceConflict("Credit notes must reference an issued invoice");
      if (input.date < original.date) throw badRequest("A credit note cannot predate its invoice");
      const selected = new Set(input.lineIds);
      const selectedLines = original.lines.filter((line) => selected.has(line.id));
      if (selectedLines.length !== input.lineIds.length)
        throw badRequest("Choose each original invoice line once");
      if ((await activeClaims(tx, ws, "credit_line", input.lineIds)).size)
        throw invoiceConflict("One or more selected lines are already on an active credit note");
      const priced = total(
        selectedLines.map((line) => ({
          ...line,
          id: newId(),
          priceLocked: true,
          sourceLineId: line.id,
        })),
        original.currency,
        false,
      );
      if (Number(priced.gross) <= 0) throw badRequest("Select lines with a positive total");
      fields = {
        workspaceId: ws,
        customerId: original.customerId,
        customer: original.customer,
        issuer: original.issuer,
        kind: "credit",
        date: input.date,
        currency: original.currency,
        source: "credit",
        sourceId: original.id,
        sourceReference: original.number,
        creditOf: original.id,
        creditReason: input.reason,
        ...priced,
      };
      reservations = input.lineIds.map((sourceId) => ({ sourceId, kind: "credit_line" }));
    } else {
      assertDates(input.date, input.dueDate);
      const [workspace] = await tx
        .select({ name: workspaces.name, currency: workspaces.currency })
        .from(workspaces)
        .where(eq(workspaces.id, ws));
      if (!workspace) throw notFound("Workspace");
      const common = {
        workspaceId: ws,
        issuer: { name: workspace.name, address: input.issuerAddress ?? "" },
        kind: "invoice" as const,
        date: input.date,
        dueDate: input.dueDate,
        source: input.kind,
      };
      if (input.kind === "manual") {
        const customer = await findCustomer(tx, ws, input.customerId);
        if (customer.status !== "active") throw invoiceConflict("Choose an active customer");
        fields = {
          ...common,
          customerId: customer.id,
          customer: { name: customer.name, address: customer.address },
          currency: input.currency,
          ...total(manualLines(input.lines), input.currency),
        };
      } else {
        const source =
          input.kind === "sales"
            ? await salesInvoiceSource(tx, ws, input.sourceId, useDespatch)
            : input.kind === "despatch"
              ? await despatchInvoiceSource(tx, ws, input.sourceId, workspace.currency)
              : await serviceInvoiceSource(tx, ws, input.sourceId);
        if (!source.lines.length) throw invoiceConflict("There are no unbilled quantities on this source");
        if (source.lines.length > 500) throw badRequest("A document supports up to 500 lines");
        fields = {
          ...common,
          customerId: source.customerId,
          customer: source.customer,
          currency: source.currency,
          sourceId: input.sourceId,
          sourceReference: source.reference,
          ...total(source.lines, source.currency),
        };
        reservations = source.claims;
      }
    }
    const [document] = await tx.insert(documents).values(fields).returning();
    if (reservations.length) {
      const inserted = await tx
        .insert(claims)
        .values(
          reservations.map((reservation) => ({
            ...reservation,
            workspaceId: ws,
            documentId: document!.id,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: claims.id });
      if (inserted.length !== reservations.length)
        throw invoiceConflict("Some quantities have already been reserved by another invoice");
    }
    return record(tx, document!, actorId, "drafted", input.kind === "credit" ? input.reason : "");
  });
}

function reviewed(document: Document, expectedRevision: number) {
  if (document.revision !== expectedRevision)
    throw invoiceConflict("The draft changed. Reload and review it.");
  if (document.status !== "draft") throw invoiceConflict("Only draft documents can be changed");
}

export async function editCustomerDocument(
  db: Database,
  ws: string,
  actorId: string,
  id: string,
  input: InvoiceEditInput,
) {
  return executeLedgerCommand(db, ws, actorId, "invoicing.edit", input, { id, ...input }, async (tx) => {
    const document = await findCustomerDocument(tx, ws, id);
    reviewed(document, input.expectedRevision);
    if (document.kind !== "invoice")
      throw invoiceConflict("Discard a credit draft and choose the original lines again");
    assertDates(input.date, input.dueDate);
    let lines = document.lines;
    if (input.lines) {
      if (document.source !== "manual" || input.pricing)
        throw badRequest("Source quantities cannot be edited");
      lines = manualLines(input.lines);
    }
    if (input.pricing) {
      const prices = new Map(input.pricing.map((price) => [price.id, price]));
      if (
        prices.size !== input.pricing.length ||
        input.pricing.some(({ id }) => !lines.some((line) => line.id === id))
      )
        throw badRequest("Price each draft line at most once");
      lines = lines.map((line) => {
        const price = prices.get(line.id);
        if (!price) return line;
        if (line.priceLocked && Number(line.unitPrice) !== Number(price.unitPrice))
          throw badRequest("The unit price is fixed by its source record");
        return {
          ...line,
          pricePending: false,
          taxPending: false,
          taxRate: price.taxRate,
          unitPrice: line.priceLocked ? line.unitPrice : price.unitPrice,
        };
      });
    }
    const [saved] = await tx
      .update(documents)
      .set({
        date: input.date,
        dueDate: input.dueDate,
        issuer: { ...document.issuer, address: input.issuerAddress ?? document.issuer.address },
        ...total(lines, document.currency),
        revision: document.revision + 1,
      })
      .where(scope(ws, id))
      .returning();
    return record(tx, saved!, actorId, "edited", "");
  });
}

export async function decideCustomerDocument(
  db: Database,
  ws: string,
  actorId: string,
  id: string,
  input: InvoiceDecisionInput,
) {
  return executeLedgerCommand(db, ws, actorId, "invoicing.decision", input, { id, ...input }, async (tx) => {
    const document = await findCustomerDocument(tx, ws, id);
    reviewed(document, input.expectedRevision);
    let changes: Partial<Document> = { status: "discarded" };
    const now = new Date();
    if (input.action === "issue") {
      if (document.lines.some((line) => line.pricePending))
        throw badRequest("Review the price for each dispatch line");
      if (document.lines.some((line) => line.taxPending))
        throw badRequest("Choose the tax rate for each line drafted from a source, even if it is 0%");
      if (document.date > (await workspaceToday(tx, ws)))
        throw badRequest("The issue date cannot be in the future");
      if (Number(document.gross) <= 0)
        throw badRequest("The document needs a positive total before approval");
      await assertInvoiceSourcesCurrent(tx, ws, id, document.lines, document.currency);
      const [counter] = await tx
        .select({ serial: max(documents.serial) })
        .from(documents)
        .where(and(eq(documents.workspaceId, ws), eq(documents.kind, document.kind)));
      const serial = (counter?.serial ?? 0) + 1;
      const number = `${document.kind === "invoice" ? "INV" : "CN"}-${String(serial).padStart(6, "0")}`;
      changes = { status: "issued", serial, number, issuedAt: now };
    } else {
      await tx
        .update(claims)
        .set({ releasedAt: now })
        .where(and(eq(claims.workspaceId, ws), eq(claims.documentId, id)));
    }
    const [saved] = await tx
      .update(documents)
      .set({ ...changes, revision: document.revision + 1 })
      .where(scope(ws, id))
      .returning();
    return record(tx, saved!, actorId, input.action === "issue" ? "issued" : "discarded", input.reason);
  });
}
