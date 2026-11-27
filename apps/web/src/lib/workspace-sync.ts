import {
  compareCursors,
  SyncStore,
  type SyncChange,
  type SyncPage,
  type SyncTables,
} from "@knotworking/core";
import type { Bootstrap } from "./api";
import { ApiError, browserApi, unwrap } from "./auth-client";
import { projectBootstrap, refetchOn, seedTables } from "./sync-model";
import { connectSyncPush, type PushStatus } from "./sync-push";

/**
 * One workspace's live data in the browser: a `SyncStore` seeded from the
 * server-rendered bootstrap, caught up through `/sync` and kept current by
 * server push (`/events`). Exposes a `Bootstrap`-shaped snapshot so components
 * read it the same way they read the server's.
 */
export class WorkspaceSync {
  readonly store: SyncStore;
  /** The latest full snapshot: source of the collections that aren't synced row by row (users, workspace). */
  private base: Bootstrap;
  private cache: { tables: SyncTables; base: Bootstrap; value: Bootstrap } | null = null;
  private listeners = new Set<() => void>();
  private changeListeners = new Set<(changes: readonly SyncChange[]) => void>();
  private refetching: Promise<void> | null = null;
  private refetchRequested = false;
  status: PushStatus = "connecting";

  constructor(
    private readonly slug: string,
    boot: Bootstrap,
    private readonly onLostAccess: () => void,
  ) {
    this.base = boot;
    this.store = new SyncStore({
      tables: seedTables(boot),
      cursor: boot.cursor,
      pull: (after) => this.fetchPage(after),
      onChanges: (changes) => {
        for (const listener of this.changeListeners) listener(changes);
        // Module access also shapes server-rendered pages (navigation, guards), and an API access toggle
        // is in no snapshot at all (only Settings → API access shows it): both re-render those pages.
        const rerender = changes.some(
          (c) =>
            c.entity === "module_access" || c.entity === "workspace_modules" || c.entity === "token_action",
        );
        const cutoff = this.base.closedWindow?.cutoff;
        // An older task can return to the working set with its next edit. Fetch
        // unchanged label links and time entries that had been left out of the seed.
        const promoted =
          cutoff &&
          changes.some(
            (c) =>
              c.entity === "task" &&
              c.action === "upsert" &&
              typeof c.data?.createdAt === "string" &&
              c.data.createdAt < cutoff &&
              typeof c.data.updatedAt === "string" &&
              c.data.updatedAt >= cutoff &&
              !this.base.tasks.some((task) => task.id === c.entityId),
          );
        if (promoted || changes.some((c) => refetchOn.has(c.entity)))
          void this.refetch().then(() => rerender && this.onLostAccess());
        else if (rerender) this.onLostAccess();
      },
    });
    this.store.subscribe(() => this.emit());
  }

  getSnapshot = (): Bootstrap => {
    const tables = this.store.getSnapshot();
    if (this.cache?.tables !== tables || this.cache.base !== this.base) {
      this.cache = { tables, base: this.base, value: projectBootstrap(tables, this.base, this.store.cursor) };
    }
    return this.cache.value;
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  onChanges(listener: (changes: readonly SyncChange[]) => void) {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * A server-rendered snapshot arrived (navigation, `router.refresh()`). Adopt
   * it unless we're already further along the log; pending edits stay on top.
   */
  adopt(boot: Bootstrap) {
    if (boot === this.base) return;
    if (compareCursors(boot.cursor, this.store.cursor) < 0) return;
    this.base = boot;
    this.store.reset(seedTables(boot), boot.cursor);
  }

  /** Pulls `/sync` if `cursor` (from a nudge) is ahead of ours, or unconditionally without one. */
  pull = (cursor?: string) => {
    if (cursor && compareCursors(cursor, this.store.cursor) <= 0) return;
    this.store.pull().catch((err) => this.failed(err));
  };

  /** Connects server push. Returns a cleanup function. */
  connect() {
    return connectSyncPush({
      url: `/api/v1/workspaces/${encodeURIComponent(this.slug)}/events`,
      onPull: this.pull,
      onStatus: (status) => {
        this.status = status;
      },
    });
  }

  /** Reloads the full snapshot (e.g. members changed). A fresh snapshot always replaces ours. */
  refetch(): Promise<void> {
    this.refetchRequested = true;
    this.refetching ??= (async () => {
      try {
        do {
          this.refetchRequested = false;
          const boot = await unwrap(
            browserApi().v1.workspaces[":slug"].bootstrap.$get({
              param: { slug: this.slug },
              query: { taskWindow: "recent" },
            }),
          );
          this.base = boot;
          this.store.reset(seedTables(boot), boot.cursor);
          await this.store.pull();
        } while (this.refetchRequested);
      } catch (err) {
        this.failed(err);
      } finally {
        this.refetching = null;
      }
    })();
    return this.refetching;
  }

  private async fetchPage(after: string): Promise<SyncPage> {
    const page = await unwrap(
      browserApi().v1.workspaces[":slug"].sync.$get({ param: { slug: this.slug }, query: { after } }),
    );
    return page as unknown as SyncPage;
  }

  private failed(err: unknown) {
    // Signed out or removed from the workspace: let the server-rendered page redirect.
    if (err instanceof ApiError && [401, 404].includes(err.status)) this.onLostAccess();
    // Anything else (offline, API restarting) is retried by the next nudge or poll.
  }

  private emit() {
    for (const listener of [...this.listeners]) listener();
  }
}
