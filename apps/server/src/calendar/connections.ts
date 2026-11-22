import { calendarScopes, type CalendarProvider } from "@knotworking/core";
import {
  accounts,
  calendarConnections,
  calendarEvents,
  meetings,
  recordChanges,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { ApiError, notFound } from "../errors";

const hasCalendarScope = (provider: CalendarProvider, scope: string | null) =>
  (scope ?? "").split(/[ ,]+/).some((s) => s.toLowerCase() === calendarScopes[provider].toLowerCase());

/**
 * Creates a calendar connection for every linked Google/Microsoft account that
 * granted calendar access. Never revives a connection the member disconnected —
 * that only happens through `activateConnection` (an explicit "Connect").
 */
export async function ensureConnections(db: Executor, userId: string) {
  const linked = await db
    .select({ id: accounts.id, providerId: accounts.providerId, scope: accounts.scope })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), inArray(accounts.providerId, ["google", "microsoft"])));
  for (const account of linked) {
    const provider = account.providerId as CalendarProvider;
    if (!hasCalendarScope(provider, account.scope)) continue;
    await db
      .insert(calendarConnections)
      .values({ userId, accountId: account.id, provider })
      .onConflictDoUpdate({
        target: [calendarConnections.userId, calendarConnections.provider],
        set: { accountId: account.id },
      });
  }
}

/** Called after the member returns from the provider's consent screen. */
export async function activateConnection(db: Database, userId: string, provider: CalendarProvider) {
  await ensureConnections(db, userId);
  const [conn] = await db
    .update(calendarConnections)
    .set({ status: "active", lastError: null, syncCursor: null, cursorStartedAt: null })
    .where(and(eq(calendarConnections.userId, userId), eq(calendarConnections.provider, provider)))
    .returning({ id: calendarConnections.id });
  if (!conn) throw new ApiError(409, "not_linked", "Calendar access wasn't granted — try connecting again");
  return conn;
}

export async function listConnections(db: Database, userId: string) {
  await ensureConnections(db, userId);
  return db
    .select({
      id: calendarConnections.id,
      provider: calendarConnections.provider,
      status: calendarConnections.status,
      lastSyncedAt: calendarConnections.lastSyncedAt,
      lastError: calendarConnections.lastError,
      createdAt: calendarConnections.createdAt,
    })
    .from(calendarConnections)
    .where(and(eq(calendarConnections.userId, userId), ne(calendarConnections.status, "disconnected")));
}

export async function getOwnConnection(db: Database, userId: string, id: string) {
  const [conn] = await db
    .select()
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.id, id),
        eq(calendarConnections.userId, userId),
        ne(calendarConnections.status, "disconnected"),
      ),
    );
  if (!conn) throw notFound("Calendar connection");
  return conn;
}

/** Meetings mirrored through this connection stay in Knotworking but are no longer linked. */
async function unlinkMeetings(tx: Executor, connectionId: string) {
  const rows = await tx
    .update(meetings)
    .set({ connectionId: null, syncState: "local", syncError: null })
    .where(eq(meetings.connectionId, connectionId))
    .returning();
  for (const m of rows) {
    await recordChanges(tx as never, m.workspaceId, null, [
      { entity: "meeting", entityId: m.id, action: "upsert", data: m },
    ]);
  }
}

/**
 * Stops syncing and removes the private event mirror. The row stays as a
 * `disconnected` tombstone so the still-linked account isn't picked up again.
 */
export async function disconnect(db: Database, userId: string, id: string) {
  const conn = await getOwnConnection(db, userId, id);
  await db.transaction(async (tx) => {
    await unlinkMeetings(tx, conn.id);
    await tx.delete(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
    await tx
      .update(calendarConnections)
      .set({ status: "disconnected", syncCursor: null, cursorStartedAt: null, lastError: null })
      .where(eq(calendarConnections.id, conn.id));
  });
}

/** Before Better Auth deletes a linked account: detach meetings (recorded in the sync log). */
export async function detachAccount(db: Database, accountId: string) {
  await db.transaction(async (tx) => {
    const conns = await tx
      .select({ id: calendarConnections.id })
      .from(calendarConnections)
      .where(eq(calendarConnections.accountId, accountId));
    for (const c of conns) await unlinkMeetings(tx, c.id);
  });
}
