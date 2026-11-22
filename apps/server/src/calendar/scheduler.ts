import { calendarConnections, workspaceMembers } from "@knotworking/db";
import { and, eq, isNull, ne } from "drizzle-orm";
import { syncConnection, type CalendarDeps } from "./sync";

/** Connections worth syncing: not disconnected, and the owner is still an active member. */
export function syncableConnections(db: CalendarDeps["db"]) {
  return db
    .selectDistinct({ id: calendarConnections.id })
    .from(calendarConnections)
    .innerJoin(
      workspaceMembers,
      and(eq(workspaceMembers.userId, calendarConnections.userId), isNull(workspaceMembers.deletedAt)),
    )
    .where(ne(calendarConnections.status, "disconnected"));
}

/**
 * Polls every connected calendar on an interval. Polling (with delta cursors)
 * works on a LAN server with no public URL, and is cheap at small-team scale.
 */
export function startCalendarScheduler(deps: CalendarDeps, intervalMs: number, log = console) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const c of await syncableConnections(deps.db)) {
        const r = await syncConnection(deps, c.id);
        if (r.error) log.warn(`[calendar] sync ${c.id} failed: ${r.error}`);
      }
    } catch (err) {
      log.error("[calendar] scheduler error", err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  setTimeout(tick, 5_000); // first run shortly after start
  return () => clearInterval(timer);
}
