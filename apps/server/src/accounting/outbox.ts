import { createHash } from "node:crypto";
import { accountingPostingSchema, accountingReceiptSchema, newId } from "@knotworking/core";
import {
  accountingPostings as postings,
  accountingPostingEvents as events,
  lockWorkspaceLog,
  type Database,
  type Transaction,
} from "@knotworking/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError, notFound } from "../errors";
import { assertAccountingConnection } from "../services/accounting";
import { getActiveWorkspaceModules } from "../services/workspace-modules";
import type { AccountingAdapter } from "./adapter";

const conflict = (message: string) => new ApiError(409, "accounting_conflict", message);
const evidenceSchema = z.string().trim().min(1).max(4000);
const actorSchema = z.string().trim().min(1).max(200);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function find(tx: Transaction, ws: string, id: string) {
  const [row] = await tx
    .select()
    .from(postings)
    .where(and(eq(postings.workspaceId, ws), eq(postings.id, id)));
  if (!row) throw notFound("Accounting posting");
  return row;
}
async function event(
  tx: Transaction,
  ws: string,
  id: string,
  attemptId: string | null,
  actor: string,
  action: string,
  evidence: string,
  supersededPayload?: typeof postings.$inferSelect.payload,
) {
  await tx.insert(events).values({
    workspaceId: ws,
    postingId: id,
    attemptId,
    actor: actorSchema.parse(actor),
    action,
    evidence: evidenceSchema.parse(evidence),
    supersededPayload,
  });
}

/** Internal boundary only. The authorised producer (`accounting/purchase-invoices.ts`) reads an
 * approved source and verifies company/supplier/account/tax mappings before submitting this snapshot.
 * Never accept this document directly from a browser or an unauthenticated connector.
 */
export async function enqueueAccountingPosting(db: Database, ws: string, actor: string, input: unknown) {
  return db.transaction((tx) => enqueueAccountingPostingTx(tx, ws, actor, input));
}

/** As `enqueueAccountingPosting`, inside the caller's transaction (the approved-invoice producer). */
export async function enqueueAccountingPostingTx(
  tx: Transaction,
  ws: string,
  actor: string,
  input: unknown,
  evidence = "Immutable purchase invoice snapshot prepared",
) {
  const payload = accountingPostingSchema.parse(input);
  const payloadHash = createHash("sha256").update(canonical(payload)).digest("hex");
  await lockWorkspaceLog(tx, ws);
  await assertAccountingConnection(tx, ws, payload);
  const [destination] = await tx
    .select({ provider: postings.provider, companyId: postings.companyId })
    .from(postings)
    .where(and(eq(postings.workspaceId, ws), eq(postings.connectionId, payload.connectionId)))
    .limit(1);
  if (
    destination &&
    (destination.provider !== payload.provider || destination.companyId !== payload.companyId)
  )
    throw conflict("An accounting connection cannot be rebound to another provider or company");
  const [previous] = await tx
    .select()
    .from(postings)
    .where(
      and(
        eq(postings.workspaceId, ws),
        eq(postings.connectionId, payload.connectionId),
        eq(postings.kind, payload.kind),
        eq(postings.sourceId, payload.sourceId),
      ),
    );
  if (previous) {
    // A definitive rejection performed no write, so a customer document can be re-coded and sent
    // again under the same posting key. Supplier bills get a new invoice version instead. The
    // replaced snapshot stays in the history; a fresh Idempotency-Key stops the destination
    // replaying its cached rejection.
    if (previous.state === "failed" && payload.kind !== "purchase_invoice") {
      const changed = previous.payloadHash !== payloadHash;
      const [updated] = await tx
        .update(postings)
        .set({
          state: "queued",
          payload,
          payloadHash,
          idempotencyKey: newId(),
          attemptId: null,
          updatedAt: new Date(),
        })
        .where(eq(postings.id, previous.id))
        .returning();
      await event(
        tx,
        ws,
        previous.id,
        previous.attemptId,
        actor,
        "reprepared",
        evidence,
        changed ? previous.payload : undefined,
      );
      return updated!;
    }
    if (previous.payloadHash !== payloadHash)
      throw conflict(
        "This source already has a different posting. Reconcile it; do not repost an edited invoice.",
      );
    return previous;
  }
  const [row] = await tx
    .insert(postings)
    .values({
      workspaceId: ws,
      companyId: payload.companyId,
      provider: payload.provider,
      connectionId: payload.connectionId,
      sourceId: payload.sourceId,
      kind: payload.kind,
      payload,
      payloadHash,
    })
    .returning();
  if (!row) throw new Error("Accounting posting insert returned no row");
  await event(tx, ws, row.id, null, actor, "queued", evidence);
  return row;
}

/** Commit uncertainty BEFORE calling the adapter. A crash after an external write must never requeue it. */
export async function claimAccountingPosting(
  db: Database,
  ws: string,
  id: string,
  actor: string,
  adapter?: AccountingAdapter,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    const row = await find(tx, ws, id);
    await assertAccountingConnection(tx, ws, row);
    if (adapter) {
      if (
        adapter.provider !== row.provider ||
        adapter.connectionId !== row.connectionId ||
        adapter.companyId !== row.companyId
      )
        throw conflict("Adapter is bound to a different accounting destination");
      if (
        !adapter.capabilities.postingKinds.includes(row.payload.kind) ||
        !adapter.capabilities.currencies.includes(row.payload.currency)
      )
        throw conflict("Adapter does not support this document kind or currency");
    }
    if (row.state !== "queued") return null;
    // Settings changes commit under the same workspace lock. A posting scanned or resolved
    // before Accounting was switched off is still queued if the switch committed first.
    if (!(await getActiveWorkspaceModules(tx, ws, ["accounting"])).includes("accounting")) return null;
    const attemptId = newId();
    const [claimed] = await tx
      .update(postings)
      .set({ state: "unknown", attemptId, attempts: row.attempts + 1, updatedAt: new Date() })
      .where(eq(postings.id, row.id))
      .returning();
    await event(
      tx,
      ws,
      id,
      attemptId,
      actor,
      "dispatch_started",
      "Outcome unknown until reconciled with the destination ledger",
    );
    return claimed!;
  });
}

export async function confirmAccountingPosting(
  db: Database,
  ws: string,
  id: string,
  attemptId: string,
  actor: string,
  input: unknown,
  evidence: string,
) {
  const receipt = accountingReceiptSchema.parse(input);
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    const row = await find(tx, ws, id);
    if (row.attemptId !== attemptId) throw conflict("Stale accounting attempt");
    if (
      receipt.provider !== row.provider ||
      receipt.connectionId !== row.connectionId ||
      receipt.companyId !== row.companyId ||
      receipt.postingKey !== row.id ||
      (["currency", "net", "tax", "gross"] as const).some((k) => receipt[k] !== row.payload[k])
    )
      throw conflict(
        "Ledger read-back does not match the provider, connection, company, posting reference and exact totals",
      );
    if (row.state === "posted") {
      if (canonical(receipt) !== canonical(row.receipt))
        throw conflict("Posting already reconciled to another external transaction");
      return row;
    }
    if (row.state !== "unknown") throw conflict("Only an uncertain posting can be reconciled");
    const [duplicate] = await tx
      .select({ id: postings.id })
      .from(postings)
      .where(
        and(
          eq(postings.workspaceId, ws),
          eq(postings.connectionId, receipt.connectionId),
          eq(postings.externalId, receipt.externalId),
        ),
      );
    if (duplicate) throw conflict("External transaction already belongs to another posting");
    const [updated] = await tx
      .update(postings)
      .set({ state: "posted", externalId: receipt.externalId, receipt, updatedAt: new Date() })
      .where(eq(postings.id, id))
      .returning();
    await event(tx, ws, id, attemptId, actor, "reconciled", evidence);
    return updated!;
  });
}

export async function recordAccountingOutcome(
  db: Database,
  ws: string,
  id: string,
  attemptId: string,
  actor: string,
  outcome: "rejected" | "unknown" | "deferred",
  evidence: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    const row = await find(tx, ws, id);
    if (row.attemptId !== attemptId || row.state !== "unknown")
      throw conflict("Stale or already resolved accounting attempt");
    const [updated] = await tx
      .update(postings)
      .set({
        state: outcome === "rejected" ? "failed" : outcome === "deferred" ? "queued" : "unknown",
        updatedAt: new Date(),
      })
      .where(eq(postings.id, id))
      .returning();
    await event(tx, ws, id, attemptId, actor, outcome, evidence);
    return updated!;
  });
}

/** Retry only a definitive no-write rejection. Unknown outcomes need ledger read-back;
 * a timeout, missing search result or expired lease is NOT proof that the destination did not post.
 */
export async function retryAccountingPosting(
  db: Database,
  ws: string,
  id: string,
  attemptId: string,
  actor: string,
  reason: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    const row = await find(tx, ws, id);
    if (row.state !== "failed" || row.attemptId !== attemptId)
      throw conflict("Only the current definitively rejected attempt may be retried");
    const [updated] = await tx
      .update(postings)
      .set({ state: "queued", updatedAt: new Date() })
      .where(eq(postings.id, id))
      .returning();
    await event(tx, ws, id, attemptId, actor, "retry_requested", reason);
    return updated!;
  });
}

export async function accountingPostingHistory(db: Database, ws: string, id: string) {
  return db.transaction(async (tx) => {
    const posting = await find(tx, ws, id);
    const history = await tx
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, ws), eq(events.postingId, id)))
      .orderBy(asc(events.createdAt), asc(events.id));
    return { posting, history };
  });
}

export async function dispatchAccountingPosting(
  db: Database,
  ws: string,
  id: string,
  actor: string,
  adapter: AccountingAdapter,
) {
  const row = await claimAccountingPosting(db, ws, id, actor, adapter);
  if (!row) return null;
  // Adapter and validation failures leave the committed unknown state intact.
  // Do not store exception strings: SDK errors can include credentials and company data.
  let result: Awaited<ReturnType<AccountingAdapter["post"]>>;
  try {
    result = await adapter.post({
      postingKey: row.id,
      ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
      attemptId: row.attemptId!,
      document: row.payload,
    });
  } catch {
    return recordAccountingOutcome(
      db,
      ws,
      id,
      row.attemptId!,
      actor,
      "unknown",
      "Adapter failed; reconcile in the destination ledger before further action",
    );
  }
  if (result.outcome === "posted")
    return confirmAccountingPosting(
      db,
      ws,
      id,
      row.attemptId!,
      actor,
      result.receipt,
      "Adapter supplied ledger read-back",
    );
  return recordAccountingOutcome(db, ws, id, row.attemptId!, actor, result.outcome, result.evidence);
}
