import {
  accountingConnections as connections,
  accountingPostings as postings,
  workspaces,
  type Database,
} from "@knotworking/db";
import { and, arrayContains, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { dispatchAccountingPosting } from "./outbox";
import type { AccountingAdapterRegistry, AccountingBinding, InstalledAccountingAdapter } from "./registry";

export const DISPATCHER_ACTOR = "dispatcher";

export interface DispatchSummary {
  posted: number;
  failed: number;
  unknown: number;
  /** Queued postings left alone: no installed adapter, or the adapter refused the destination. */
  skipped: number;
  /**
   * Sent nothing and returned to the queue (a provider rate limit, or a setup waiting to be
   * reconnected). The rest of that destination's postings wait for the next pass.
   */
  deferred: number;
}

/**
 * One pass of the dispatcher: sends queued postings for enabled connections whose provider has an
 * installed adapter, oldest first within each connection and taking connections in turn. Each send goes through the outbox, which commits `unknown`
 * before calling the adapter, so concurrent passes (or several API processes) can't send twice.
 * Failures stay visible in the queue; nothing here resends an uncertain posting.
 */
export async function dispatchQueuedPostings(
  db: Database,
  registry: AccountingAdapterRegistry,
  options: { limit?: number; log?: Pick<Console, "error"> } = {},
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { posted: 0, failed: 0, unknown: 0, skipped: 0, deferred: 0 };
  const log = options.log ?? console;
  if (!registry.providers.length) return summary;
  // Round-robin across connections: every connection's oldest queued posting comes before any
  // connection's second. A destination that defers or can't start (a lapsed grant, a rate limit,
  // a misconfigured adapter) leaves its postings queued with their old timestamps; ordering purely
  // by age would put the same stuck postings at the head of every pass and starve every other
  // connection and workspace.
  const ranked = db
    .select({
      id: postings.id,
      workspaceId: postings.workspaceId,
      workspaceSlug: workspaces.slug,
      currency: workspaces.currency,
      connectionId: postings.connectionId,
      provider: connections.provider,
      companyId: connections.companyId,
      createdAt: postings.createdAt,
      turn: sql<number>`row_number() over (partition by ${postings.workspaceId}, ${postings.connectionId} order by ${postings.createdAt}, ${postings.id})`.as(
        "turn",
      ),
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
        isNull(workspaces.deletedAt),
        or(isNull(workspaces.enabledModules), arrayContains(workspaces.enabledModules, ["accounting"])),
        inArray(connections.provider, [...registry.providers]),
      ),
    )
    .as("ranked");
  const rows = await db
    .select()
    .from(ranked)
    .orderBy(asc(ranked.turn), asc(ranked.createdAt), asc(ranked.id))
    .limit(options.limit ?? 25);
  const adapters = new Map<string, InstalledAccountingAdapter | null>();
  /** Destinations (provider + company) that deferred a posting in this pass. */
  const held = new Set<string>();
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
    const destination = `${row.provider}:${row.companyId.toLowerCase()}`;
    if (!adapters.has(key))
      adapters.set(
        key,
        await registry.resolve(binding).catch((error: unknown) => {
          // A misconfiguration (such as an APP_URL with a path) must not look like a quiet queue.
          log.error(
            `[accounting] can't send postings for connection ${row.connectionId}:`,
            error instanceof Error ? error.message : "adapter failed to start",
          );
          return null;
        }),
      );
    const adapter = adapters.get(key);
    if (!adapter || held.has(destination)) {
      summary.skipped++;
      continue;
    }
    try {
      const result = await dispatchAccountingPosting(db, row.workspaceId, row.id, DISPATCHER_ACTOR, adapter);
      if (!result) continue; // Claimed by another pass.
      if (result.state === "posted") summary.posted++;
      else if (result.state === "failed") summary.failed++;
      else if (result.state === "queued") {
        summary.deferred++;
        held.add(destination);
      } else summary.unknown++;
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
      const s = await dispatchQueuedPostings(db, registry, { log });
      if (s.posted || s.failed || s.unknown || s.deferred)
        log.log(
          `[accounting] posted ${s.posted}, rejected ${s.failed}, uncertain ${s.unknown}, deferred ${s.deferred}`,
        );
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
