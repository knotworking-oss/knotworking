import { AsyncLocalStorage } from "node:async_hooks";
import { effectiveTimeZone, todayInZone } from "@knotworking/core";
import { workspaces, type Executor } from "@knotworking/db";
import { eq } from "drizzle-orm";

/**
 * The workspace's time zone: every business date is decided in it ("today", due dates, report
 * periods, print ranges, shift dates). Stored instants stay UTC; only the step between an instant
 * and a calendar date uses the zone (`@knotworking/core` time-zone.ts).
 *
 * Workspace routes already have it as `c.var.workspace.timeZone` (and `todayIn(c)` in
 * middleware/workspace.ts); services without a request (the notification sweep, kiosks, services
 * that work out "today" deep inside) read it here.
 *
 * A stored zone that `timeZoneSchema` refuses (free text copied from the old attendance setting:
 * `GMT`, `utc`, `+01:00`, `Etc/GMT+5`) is replaced by `DEFAULT_TIME_ZONE` rather than thrown at.
 */

/**
 * Zones already looked up by the current request, by workspace id. The workspace middleware opens
 * the scope (`withTimeZoneScope`), so a request reads its workspace's zone once however many
 * services ask; the scope ends with the request, so a changed zone is seen by the next one.
 */
const requestZones = new AsyncLocalStorage<Map<string, string>>();

/** Runs `fn` with a per-request cache for `workspaceTimeZone`. */
export const withTimeZoneScope = <T>(fn: () => T, known?: { workspaceId: string; timeZone: string }): T => {
  const zones = new Map<string, string>();
  if (known) zones.set(known.workspaceId, known.timeZone);
  return requestZones.run(zones, fn);
};

/** The zone in effect for a stored value, and whether the stored value had to be replaced. */
export { effectiveTimeZone };

export async function workspaceTimeZone(db: Executor, workspaceId: string): Promise<string> {
  const cache = requestZones.getStore();
  const cached = cache?.get(workspaceId);
  if (cached) return cached;
  const [row] = await db
    .select({ timeZone: workspaces.timeZone })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const { timeZone } = effectiveTimeZone(row?.timeZone);
  cache?.set(workspaceId, timeZone);
  return timeZone;
}

/** Forgets what this request knows about a workspace's zone (after changing it). */
export const forgetWorkspaceTimeZone = (workspaceId: string) => requestZones.getStore()?.delete(workspaceId);

/** Today's date (`YYYY-MM-DD`) in the workspace's time zone. */
export async function workspaceToday(db: Executor, workspaceId: string, now: Date | number = Date.now()) {
  return todayInZone(await workspaceTimeZone(db, workspaceId), now);
}
