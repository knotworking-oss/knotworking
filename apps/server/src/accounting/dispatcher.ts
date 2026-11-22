import {
  accountingConnections as connections,
  accountingPostings as postings,
  workspaces,
  type Database,
} from "@knotworking/db";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { dispatchAccountingPosting } from "./outbox";
import type { AccountingAdapterRegistry, AccountingBinding, InstalledAccountingAdapter } from "./registry";

export const DISPATCHER_ACTOR = "dispatcher";

export interface DispatchSummary {
  posted: number;
  failed: number;
  unknown: number;
  /** Queued postings left alone: no installed adapter, or the adapter refused the destination. */
  skipped: number;
}

/**
 * One pass of the dispatcher: sends queued postings, oldest first, for enabled connections whose
 * provider has an installed adapter. Each send goes through the outbox, which commits `unknown`
 * before calling the adapter, so concurrent passes (or several API processes) can't send twice.
 * Failures stay visible in the queue; nothing here resends an uncertain posting.
 */
export async function dispatchQueuedPostings(
  db: Database,
  registry: AccountingAdapterRegistry,
  options: { limit?: number } = {},
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { posted: 0, failed: 0, unknown: 0, skipped: 0 };
  if (!registry.providers.length) return summary;
  const rows = await db
    .select({
      id: postings.id,
      workspaceId: postings.workspaceId,
      workspaceSlug: workspaces.slug,
      currency: workspaces.currency,
      connectionId: postings.connectionId,
      provider: connections.provider,
      companyId: connections.companyId,
    })
    .from(postings)
    .innerJoin(
      connections,
      and(eq(connections.workspaceId, postings.workspaceId), eq(connections.id, postings.connectionId)),
    )
    .innerJoin(workspaces, eq(workspaces.id, postings.workspaceId))
    .where(
      and(
        eq(postings.state, "queued"),
        eq(connections.disabled, false),
        ne(connections.companyId, ""),
        inArray(connections.provider, [...registry.providers]),
      ),
    )
    .orderBy(asc(postings.createdAt), asc(postings.id))
    .limit(options.limit ?? 25);
  const adapters = new Map<string, InstalledAccountingAdapter | null>();
  for (const row of rows) {
    const binding: AccountingBinding = {
      workspaceId: row.workspaceId,
      workspaceSlug: row.workspaceSlug,
      currency: row.currency,
      connectionId: row.connectionId,
      provider: row.provider,
      companyId: row.companyId,
    };
    const key = `${row.workspaceId}:${row.connectionId}`;
    if (!adapters.has(key)) adapters.set(key, await registry.resolve(binding).catch(() => null));
    const adapter = adapters.get(key);
    if (!adapter) {
      summary.skipped++;
      continue;
    }
    try {
      const result = await dispatchAccountingPosting(db, row.workspaceId, row.id, DISPATCHER_ACTOR, adapter);
      if (!result) continue; // Claimed by another pass.
      if (result.state === "posted") summary.posted++;
      else if (result.state === "failed") summary.failed++;
      else summary.unknown++;
    } catch {
      // A destination or capability mismatch refuses before the claim; the posting stays queued.
      summary.skipped++;
    }
  }
  return summary;
}

/** Runs `dispatchQueuedPostings` on an interval in this process (see `ACCOUNTING_DISPATCH_INTERVAL_SECONDS`). */
export function startAccountingDispatcher(
  db: Database,
  registry: AccountingAdapterRegistry,
  options: { intervalMs: number },
  log: Pick<Console, "error" | "log"> = console,
) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const s = await dispatchQueuedPostings(db, registry);
      if (s.posted || s.failed || s.unknown)
        log.log(`[accounting] posted ${s.posted}, rejected ${s.failed}, uncertain ${s.unknown}`);
    } catch (err) {
      log.error("[accounting] dispatch failed", err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, options.intervalMs);
  const first = setTimeout(tick, 15_000);
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
