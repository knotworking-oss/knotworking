import { getLatestCursor, type Executor } from "@knotworking/db";

type Listener = (cursor: string) => void;

interface Watch {
  listeners: Set<Listener>;
  cursor: string | null;
  timer: ReturnType<typeof setInterval>;
  checking: Promise<void> | null;
  again: boolean;
}

/**
 * Tells connected clients when a workspace's sync log advances, so they can
 * pull `/sync` right away (server push for `GET /v1/workspaces/:slug/events`).
 *
 * It watches the log itself rather than hooking every write: one cheap
 * `max(id)` query per workspace that has listeners, on a short interval, plus
 * an immediate check whenever this process handles a write (`nudge`). That
 * catches every writer (other API instances, the calendar scheduler, scripts)
 * on any Postgres driver, with no changes to `recordChanges`. It only ever
 * reports cursors, never entity data.
 */
export class SyncHub {
  private watches = new Map<string, Watch>();

  constructor(
    private readonly db: Executor,
    private readonly intervalMs = 2000,
  ) {}

  /** Calls `listener` with the new cursor whenever the workspace's log advances. */
  subscribe(workspaceId: string, listener: Listener): () => void {
    let watch = this.watches.get(workspaceId);
    if (!watch) {
      const timer = setInterval(() => void this.check(workspaceId), this.intervalMs);
      timer.unref?.();
      watch = { listeners: new Set(), cursor: null, timer, checking: null, again: false };
      this.watches.set(workspaceId, watch);
      void this.check(workspaceId);
    }
    watch.listeners.add(listener);
    return () => {
      const w = this.watches.get(workspaceId);
      if (!w) return;
      w.listeners.delete(listener);
      if (w.listeners.size === 0) {
        clearInterval(w.timer);
        this.watches.delete(workspaceId);
      }
    };
  }

  /** A write just committed in this process: check now instead of on the next tick. */
  nudge(workspaceId: string) {
    if (this.watches.has(workspaceId)) void this.check(workspaceId);
  }

  /** Current listener count (tests, metrics). */
  listenerCount(workspaceId: string) {
    return this.watches.get(workspaceId)?.listeners.size ?? 0;
  }

  close() {
    for (const w of this.watches.values()) clearInterval(w.timer);
    this.watches.clear();
  }

  /** Single-flight per workspace; a check requested mid-query runs once more after it. */
  private check(workspaceId: string): Promise<void> {
    const watch = this.watches.get(workspaceId);
    if (!watch) return Promise.resolve();
    if (watch.checking) {
      watch.again = true;
      return watch.checking;
    }
    watch.checking = (async () => {
      try {
        do {
          watch.again = false;
          const cursor = await getLatestCursor(this.db, workspaceId);
          const first = watch.cursor === null;
          if (cursor === watch.cursor) continue;
          watch.cursor = cursor;
          if (!first) for (const l of [...watch.listeners]) l(cursor);
        } while (watch.again);
      } catch (err) {
        console.error("sync hub: cursor check failed", err);
      } finally {
        watch.checking = null;
      }
    })();
    return watch.checking;
  }
}
