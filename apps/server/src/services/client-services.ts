import {
  newId,
  serviceQuoteAmount,
  toCsv,
  type ServiceQuoteCreateInput,
  type ServiceQuoteDecisionInput,
  type ServiceQuoteStatus,
  type ServiceQuoteUpdateInput,
} from "@knotworking/core";
import {
  projects,
  recordChanges,
  serviceQuoteEvents,
  serviceQuotes,
  tasks,
  timeEntries,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, desc, eq, isNull, lt, sum } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { assertNoCrmLinkOnCustomerChange } from "./crm-quote-link";
import { findCustomer } from "./customers";
import { executeLedgerCommand } from "./ledger-command";
import { createProject } from "./projects";

type Quote = typeof serviceQuotes.$inferSelect;
const conflict = (message: string) => new ApiError(409, "service_quote_conflict", message);

function quoteView({ workspaceId: _workspace, ...quote }: Quote) {
  return {
    ...quote,
    quoteTotal: serviceQuoteAmount(quote.unitPrice, quote.quotedMinutes, quote.currency),
    billingTotal:
      quote.status === "delivered"
        ? serviceQuoteAmount(quote.unitPrice, quote.approvedMinutes, quote.currency)
        : null,
  };
}

async function loadQuote(db: Executor, workspaceId: string, id: string) {
  const [quote] = await db
    .select()
    .from(serviceQuotes)
    .where(and(eq(serviceQuotes.workspaceId, workspaceId), eq(serviceQuotes.id, id)));
  if (!quote) throw notFound("Service quote");
  return quote;
}

function requireRevision(quote: Quote, revision: number) {
  if (quote.revision !== revision)
    throw conflict("This quote changed. Reload and review the latest revision");
}

async function recipient(db: Executor, workspaceId: string, customerId: string) {
  const { name, code, address, status } = await findCustomer(db, workspaceId, customerId);
  if (status !== "active") throw conflict("Choose an active customer");
  return { name, code, address };
}

async function record(tx: Transaction, quote: Quote, actorId: string, action: string, reason: string) {
  const view = quoteView(quote);
  await tx.insert(serviceQuoteEvents).values({
    workspaceId: quote.workspaceId,
    quoteId: quote.id,
    revision: quote.revision,
    actorId,
    action,
    reason,
    snapshot: view,
  });
  await recordChanges(tx, quote.workspaceId, actorId, [
    {
      entity: "service_quote",
      entityId: quote.id,
      action: "upsert",
      data: { id: quote.id, revision: quote.revision },
    },
  ]);
  return view;
}

export async function listServiceQuotes(
  db: Database,
  workspaceId: string,
  query: { before?: string; status?: ServiceQuoteStatus },
) {
  const limit = 50;
  const rows = await db
    .select()
    .from(serviceQuotes)
    .where(
      and(
        eq(serviceQuotes.workspaceId, workspaceId),
        query.status ? eq(serviceQuotes.status, query.status) : undefined,
        query.before ? lt(serviceQuotes.id, query.before) : undefined,
      ),
    )
    .orderBy(desc(serviceQuotes.id))
    .limit(limit + 1);
  const quotes = rows.slice(0, limit).map(quoteView);
  return { quotes, nextCursor: rows.length > limit ? quotes.at(-1)!.id : null };
}

async function loggedServiceMinutes(db: Executor, workspaceId: string, projectId: string) {
  const [row] = await db
    .select({ minutes: sum(timeEntries.minutes) })
    .from(timeEntries)
    .innerJoin(tasks, and(eq(tasks.id, timeEntries.taskId), eq(tasks.workspaceId, workspaceId)))
    .where(
      and(
        eq(timeEntries.workspaceId, workspaceId),
        eq(tasks.projectId, projectId),
        isNull(tasks.deletedAt),
        isNull(timeEntries.deletedAt),
      ),
    );
  return Number(row?.minutes ?? 0);
}

export async function getServiceQuote(db: Database, workspaceId: string, id: string) {
  const quote = await loadQuote(db, workspaceId, id);
  const history = await db
    .select({
      revision: serviceQuoteEvents.revision,
      action: serviceQuoteEvents.action,
      reason: serviceQuoteEvents.reason,
      actorId: serviceQuoteEvents.actorId,
      createdAt: serviceQuoteEvents.createdAt,
    })
    .from(serviceQuoteEvents)
    .where(and(eq(serviceQuoteEvents.workspaceId, workspaceId), eq(serviceQuoteEvents.quoteId, id)))
    .orderBy(desc(serviceQuoteEvents.revision))
    .limit(30);
  const loggedMinutes =
    quote.status === "accepted" && quote.projectId && quote.quotedMinutes !== null
      ? await loggedServiceMinutes(db, workspaceId, quote.projectId)
      : null;
  return { ...quoteView(quote), history, loggedMinutes };
}

export async function createServiceQuote(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: ServiceQuoteCreateInput,
) {
  return executeLedgerCommand(
    db,
    workspaceId,
    actorId,
    "client_services.create",
    input,
    input,
    async (tx) => {
      const { commandId: _command, ...fields } = input;
      const id = newId();
      const [quote] = await tx
        .insert(serviceQuotes)
        .values({
          ...fields,
          workspaceId,
          id,
          reference: `SV-${id.slice(-12)}`,
          recipient: await recipient(tx, workspaceId, input.customerId),
        })
        .returning();
      return record(tx, quote!, actorId, "created", "Draft created");
    },
  );
}

export async function updateServiceQuote(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: ServiceQuoteUpdateInput,
) {
  return executeLedgerCommand(
    db,
    workspaceId,
    actorId,
    "client_services.edit",
    input,
    { id, ...input },
    async (tx) => {
      const current = await loadQuote(tx, workspaceId, id);
      requireRevision(current, input.expectedRevision);
      if (current.status !== "draft") throw conflict("Only a draft quote can be edited");
      if (input.customerId !== current.customerId)
        await assertNoCrmLinkOnCustomerChange(tx, workspaceId, "service", id);
      const { commandId: _command, expectedRevision: _revision, ...fields } = input;
      const [quote] = await tx
        .update(serviceQuotes)
        .set({
          ...fields,
          revision: current.revision + 1,
          updatedAt: new Date(),
          recipient: await recipient(tx, workspaceId, input.customerId),
        })
        .where(eq(serviceQuotes.id, id))
        .returning();
      return record(tx, quote!, actorId, "edited", "Draft updated");
    },
  );
}

export async function decideServiceQuote(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: ServiceQuoteDecisionInput,
) {
  return executeLedgerCommand(
    db,
    workspaceId,
    actorId,
    `client_services.${input.action}`,
    input,
    { id, ...input },
    async (tx) => {
      const quote = await loadQuote(tx, workspaceId, id);
      requireRevision(quote, input.expectedRevision);
      let changes: Partial<Quote>;
      switch (input.action) {
        case "issue": {
          if (quote.status !== "draft") throw conflict("Only a draft quote can be issued");
          const currentRecipient = await recipient(tx, workspaceId, quote.customerId);
          if (
            currentRecipient.name !== quote.recipient.name ||
            currentRecipient.code !== quote.recipient.code ||
            currentRecipient.address !== quote.recipient.address
          )
            throw conflict("The customer details changed. Save and review the draft again");
          changes = { status: "issued" };
          break;
        }
        case "accept": {
          if (quote.status !== "issued") throw conflict("Issue the quote before recording acceptance");
          await recipient(tx, workspaceId, quote.customerId);
          const project = await createProject(tx, workspaceId, actorId, {
            name: quote.title,
            description: `Delivery for ${quote.reference}`,
            teamIds: [input.teamId],
            leadId: input.leadId,
            targetDate: quote.deliveryDate,
          });
          changes = { status: "accepted", projectId: project.id };
          break;
        }
        case "deliver": {
          if (quote.status !== "accepted" || !quote.projectId)
            throw conflict("Accept the quote and create its project before recording delivery");
          const [project] = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.id, quote.projectId),
                eq(projects.workspaceId, workspaceId),
                isNull(projects.deletedAt),
              ),
            );
          if (!project) throw conflict("The delivery project is archived");
          if (quote.quotedMinutes === null) {
            if (input.approvedMinutes !== null) throw badRequest("A fixed fee has no billable time quantity");
          } else {
            if (input.approvedMinutes === null || input.approvedMinutes > quote.quotedMinutes) {
              throw badRequest("Approve a number of minutes within the quoted time");
            }
            const logged = await loggedServiceMinutes(tx, workspaceId, project.id);
            if (input.approvedMinutes > logged)
              throw badRequest("Approved time cannot exceed finished time logged on the delivery project");
          }
          changes = { status: "delivered", approvedMinutes: input.approvedMinutes, deliveredAt: new Date() };
          break;
        }
        case "cancel":
          if (quote.status === "delivered" || quote.status === "cancelled")
            throw conflict("This quote is already closed");
          changes = { status: "cancelled" };
          break;
      }
      const [saved] = await tx
        .update(serviceQuotes)
        .set({ ...changes, revision: quote.revision + 1, updatedAt: new Date() })
        .where(eq(serviceQuotes.id, id))
        .returning();
      return record(tx, saved!, actorId, input.action, input.reason);
    },
  );
}

export async function serviceBillingDraft(db: Database, workspaceId: string, id: string) {
  const quote = quoteView(await loadQuote(db, workspaceId, id));
  if (quote.status !== "delivered") throw conflict("Record delivery before exporting a billing draft");
  return {
    filename: `${quote.reference}-billing-draft.csv`,
    csv: toCsv([
      [
        "Document",
        "Quote",
        "Revision",
        "Customer code",
        "Customer",
        "Billing address",
        "Service",
        "Basis",
        "Approved minutes",
        "Rate",
        "Currency",
        "Total before tax",
      ],
      [
        "Billing draft",
        quote.reference,
        quote.revision,
        quote.recipient.code,
        quote.recipient.name,
        quote.recipient.address,
        quote.title,
        quote.quotedMinutes === null ? "Fixed fee" : "Hourly",
        quote.approvedMinutes,
        quote.unitPrice,
        quote.currency,
        quote.billingTotal,
      ],
    ]),
  };
}
