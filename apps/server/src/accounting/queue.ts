import type { AccountingPostingState } from "@knotworking/core";
import {
  accountingPostingEvents as events,
  accountingPostings as postings,
  users,
  type Database,
} from "@knotworking/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ApiError, notFound } from "../errors";
import { findAccountingConnection } from "../services/accounting";
import {
  confirmAccountingPosting,
  dispatchAccountingPosting,
  recordAccountingAllocation,
  retryAccountingPosting,
} from "./outbox";
import type { AccountingAdapterRegistry, AccountingBinding } from "./registry";

/**
 * The finance review of one connection's outbox: what is queued, uncertain, rejected or posted, its
 * private history, and the few actions a person may take. There is deliberately no "mark as not
 * posted" for an uncertain posting: only positive read-back from the ledger settles it.
 */

const states = ["queued", "unknown", "failed", "posted"] as const satisfies readonly AccountingPostingState[];

async function binding(
  db: Database,
  ws: { id: string; slug: string; currency: string },
  connectionId: string,
) {
  const connection = await findAccountingConnection(db, ws.id, connectionId);
  const value: AccountingBinding = {
    workspaceId: ws.id,
    workspaceSlug: ws.slug,
    currency: ws.currency,
    connectionId,
    provider: connection.provider,
    companyId: connection.companyId,
  };
  return { connection, value };
}

async function findPosting(db: Database, ws: string, connectionId: string, id: string) {
  const [row] = await db
    .select()
    .from(postings)
    .where(and(eq(postings.workspaceId, ws), eq(postings.connectionId, connectionId), eq(postings.id, id)));
  if (!row) throw notFound("Accounting posting");
  return row;
}

const summary = (row: typeof postings.$inferSelect) => ({
  id: row.id,
  state: row.state,
  attempts: row.attempts,
  attemptId: row.attemptId,
  externalId: row.externalId,
  allocation: row.allocation,
  sourceId: row.sourceId,
  kind: row.payload.kind,
  reference: row.payload.reference,
  date: row.payload.date,
  currency: row.payload.currency,
  gross: row.payload.gross,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export async function listAccountingQueue(
  db: Database,
  ws: { id: string; slug: string; currency: string },
  connectionId: string,
  registry: AccountingAdapterRegistry,
  query: { state: AccountingPostingState; offset: number },
) {
  const { connection, value } = await binding(db, ws, connectionId);
  const counted = await db
    .select({ state: postings.state, count: sql<number>`count(*)::int` })
    .from(postings)
    .where(and(eq(postings.workspaceId, ws.id), eq(postings.connectionId, connectionId)))
    .groupBy(postings.state);
  const counts = Object.fromEntries(states.map((s) => [s, 0])) as Record<AccountingPostingState, number>;
  for (const row of counted) counts[row.state] = row.count;
  const rows = await db
    .select()
    .from(postings)
    .where(
      and(
        eq(postings.workspaceId, ws.id),
        eq(postings.connectionId, connectionId),
        eq(postings.state, query.state),
      ),
    )
    .orderBy(query.state === "queued" ? asc(postings.createdAt) : desc(postings.updatedAt), asc(postings.id))
    .limit(51)
    .offset(query.offset);
  const adapter = await registry.resolve(value).catch(() => null);
  return {
    postings: rows.slice(0, 50).map(summary),
    hasMore: rows.length > 50,
    counts,
    adapterInstalled: !connection.disabled && !!adapter,
    canReadBack: !!adapter?.readBack,
    canFindExisting: !!adapter?.findExisting,
    canAllocate: !!adapter?.allocate,
  };
}

/** One posting with its private history; `user:<id>` actors are shown by name. */
export async function getAccountingQueueItem(db: Database, ws: string, connectionId: string, id: string) {
  const row = await findPosting(db, ws, connectionId, id);
  const history = await db
    .select()
    .from(events)
    .where(and(eq(events.workspaceId, ws), eq(events.postingId, id)))
    .orderBy(asc(events.createdAt), asc(events.id));
  const ids = [
    ...new Set(history.flatMap((h) => (h.actor.startsWith("user:") ? [h.actor.slice(5)] : []))),
  ].filter((v) => /^[0-9a-f-]{36}$/i.test(v));
  const names = new Map(
    ids.length
      ? (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map(
          (u) => [u.id, u.name],
        )
      : [],
  );
  return {
    posting: { ...summary(row), payload: row.payload, receipt: row.receipt },
    history: history.map((h) => ({
      id: h.id,
      action: h.action,
      evidence: h.evidence,
      supersededPayload: h.supersededPayload,
      attemptId: h.attemptId,
      createdAt: h.createdAt,
      actor: h.actor.startsWith("user:")
        ? (names.get(h.actor.slice(5)) ?? "Former member")
        : h.actor === "dispatcher"
          ? "Automatic dispatch"
          : h.actor,
    })),
  };
}

const notInstalled = () =>
  new ApiError(
    409,
    "adapter_not_installed",
    "No accounting adapter is installed for this connection on this server",
  );

/** Sends one queued posting now, as a person (the dispatcher does the same on its schedule). */
export async function sendAccountingPostingNow(
  db: Database,
  ws: { id: string; slug: string; currency: string },
  connectionId: string,
  id: string,
  actorId: string,
  registry: AccountingAdapterRegistry,
) {
  const { connection, value } = await binding(db, ws, connectionId);
  const row = await findPosting(db, ws.id, connectionId, id);
  if (row.state !== "queued")
    throw new ApiError(409, "posting_not_queued", "Only a queued posting can be sent");
  if (connection.disabled)
    throw new ApiError(409, "accounting_conflict", "Accounting connection is disabled");
  const adapter = await registry.resolve(value);
  if (!adapter) throw notInstalled();
  // External IO happens outside any transaction; the outbox commits `unknown` before calling out.
  await dispatchAccountingPosting(db, ws.id, id, `user:${actorId}`, adapter);
  return getAccountingQueueItem(db, ws.id, connectionId, id);
}

/** Requeues a definitively rejected posting with the same snapshot and posting key. */
export async function retryAccountingQueueItem(
  db: Database,
  ws: string,
  connectionId: string,
  id: string,
  actorId: string,
  input: { attemptId: string; reason: string },
) {
  await findPosting(db, ws, connectionId, id);
  await retryAccountingPosting(db, ws, id, input.attemptId, `user:${actorId}`, input.reason);
  return getAccountingQueueItem(db, ws, connectionId, id);
}

/**
 * Reconciles an uncertain posting from a transaction the reviewer found in the accounting system:
 * the adapter reads it back and must match the destination, posting reference and exact totals.
 * Nothing found is not proof of no write, so the posting then stays uncertain.
 */
export async function readBackAccountingQueueItem(
  db: Database,
  ws: { id: string; slug: string; currency: string },
  connectionId: string,
  id: string,
  actorId: string,
  registry: AccountingAdapterRegistry,
  input: { attemptId: string; externalId?: string; reason: string },
) {
  const { value } = await binding(db, ws, connectionId);
  const row = await findPosting(db, ws.id, connectionId, id);
  if (row.state !== "unknown" || row.attemptId !== input.attemptId)
    throw new ApiError(409, "accounting_conflict", "Only the current uncertain attempt can be reconciled");
  const adapter = await registry.resolve(value);
  if (!adapter) throw notInstalled();
  const externalId = input.externalId;
  const prepared = { postingKey: row.id, document: row.payload };
  const request = externalId
    ? adapter.readBack?.({ ...prepared, externalId })
    : adapter.findExisting?.(prepared);
  if (!request)
    throw new ApiError(
      409,
      "read_back_unsupported",
      externalId
        ? "This accounting adapter can't read transactions back"
        : "Enter the transaction ID to read it back",
    );
  const receipt = await request.catch(() => null);
  if (!receipt)
    throw new ApiError(
      409,
      "read_back_not_verified",
      "That transaction couldn't be read back or doesn't match this posting. It stays uncertain; nothing was resent.",
    );
  await confirmAccountingPosting(
    db,
    ws.id,
    id,
    input.attemptId,
    `user:${actorId}`,
    receipt,
    `Read back transaction ${receipt.externalId}: ${input.reason}`.slice(0, 4000),
  );
  return getAccountingQueueItem(db, ws.id, connectionId, id);
}

/**
 * Settles a posted credit's pending allocation. `allocate` reads the credit back and allocates it
 * only if the allocation is not already there; `record` states how finance settled it in the ledger
 * (for example, the invoice was paid first, so the credit stays on account or was refunded).
 */
export async function allocateAccountingQueueItem(
  db: Database,
  ws: { id: string; slug: string; currency: string },
  connectionId: string,
  id: string,
  actorId: string,
  registry: AccountingAdapterRegistry,
  input: { action: "allocate" | "record"; reason: string },
) {
  const { connection, value } = await binding(db, ws, connectionId);
  const row = await findPosting(db, ws.id, connectionId, id);
  if (row.state !== "posted" || row.allocation !== "pending" || !row.externalId)
    throw new ApiError(
      409,
      "accounting_conflict",
      "Only a posted credit with a pending allocation can be settled",
    );
  const actor = `user:${actorId}`;
  if (input.action === "record") {
    await recordAccountingAllocation(db, ws.id, id, actor, "recorded", input.reason);
    return getAccountingQueueItem(db, ws.id, connectionId, id);
  }
  if (connection.disabled)
    throw new ApiError(409, "accounting_conflict", "Accounting connection is disabled");
  const adapter = await registry.resolve(value);
  if (!adapter) throw notInstalled();
  if (!adapter.allocate)
    throw new ApiError(409, "allocation_unsupported", "This accounting adapter can't allocate credits");
  const result = await adapter.allocate({
    postingKey: row.id,
    document: row.payload,
    externalId: row.externalId,
  });
  if (!result.allocated) throw new ApiError(409, "allocation_not_verified", result.evidence);
  await recordAccountingAllocation(
    db,
    ws.id,
    id,
    actor,
    "allocated",
    `${result.evidence}: ${input.reason}`.slice(0, 4000),
  );
  return getAccountingQueueItem(db, ws.id, connectionId, id);
}
