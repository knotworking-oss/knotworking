import type { SyncAction, SyncChange, SyncEntityType } from "@knotworking/core";
import { and, asc, eq, gt, max, sql } from "drizzle-orm";
import type { Executor, Transaction } from "./client";
import { syncChanges } from "./schema";

export interface ChangeInput {
  entity: SyncEntityType;
  entityId: string;
  action: SyncAction;
  data?: Record<string, unknown> | null;
}

/**
 * Append changes to the workspace's sync log. MUST be called inside the same
 * transaction as the write it describes.
 *
 * The transaction-scoped advisory lock serialises writers per workspace, so
 * identity values are allocated and committed in the same order. Without it a
 * client could read cursor 11 before a slower transaction commits cursor 10,
 * and miss that change forever.
 */
export async function recordChanges(
  tx: Transaction,
  workspaceId: string,
  actorId: string | null,
  changes: ChangeInput[],
): Promise<bigint> {
  if (changes.length === 0) return 0n;
  await lockWorkspaceLog(tx, workspaceId);
  const rows = await tx
    .insert(syncChanges)
    .values(
      changes.map((c) => ({
        workspaceId,
        actorId,
        entity: c.entity,
        entityId: c.entityId,
        action: c.action,
        data: c.action === "delete" ? null : (toJson(c.data) ?? null),
      })),
    )
    .returning({ id: syncChanges.id });
  return rows.reduce((m, r) => (r.id > m ? r.id : m), 0n);
}

/**
 * Takes the workspace's sync-log lock (the one `recordChanges` takes) for the rest of the
 * transaction. Writers that check-then-write a per-workspace invariant can take it first, so
 * concurrent writers queue instead of racing; `recordChanges` re-entering it is harmless.
 */
export async function lockWorkspaceLog(tx: Transaction, workspaceId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`);
}

export async function getChangesAfter(
  db: Executor,
  workspaceId: string,
  after: bigint,
  limit: number,
): Promise<{ changes: SyncChange[]; cursor: string; hasMore: boolean }> {
  const rows = await db
    .select()
    .from(syncChanges)
    .where(and(eq(syncChanges.workspaceId, workspaceId), gt(syncChanges.id, after)))
    .orderBy(asc(syncChanges.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    changes: page.map((r) => ({
      id: r.id.toString(),
      entity: r.entity as SyncEntityType,
      entityId: r.entityId,
      action: r.action,
      data: r.data ?? null,
      actorId: r.actorId,
      createdAt: r.createdAt.toISOString(),
    })),
    cursor: (page.at(-1)?.id ?? after).toString(),
    hasMore: rows.length > limit,
  };
}

export async function getLatestCursor(db: Executor, workspaceId: string): Promise<string> {
  const [row] = await db
    .select({ value: max(syncChanges.id) })
    .from(syncChanges)
    .where(eq(syncChanges.workspaceId, workspaceId));
  return (row?.value ?? 0).toString();
}

/** Normalise Dates/bigints so the payload matches what clients receive over JSON. */
function toJson(data: Record<string, unknown> | null | undefined) {
  if (!data) return data;
  return JSON.parse(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as Record<
    string,
    unknown
  >;
}
