import type { SyncChange, SyncPage } from "./sync";

/**
 * Client sync store
 * -----------------
 * A normalised, in-memory replica of a workspace, kept current from the sync
 * log, with optimistic mutations layered on top. Runtime-neutral (no DOM, no
 * Node, no timers) so web, desktop and mobile share it; each client supplies the
 * transport (`pull`) and decides when to pull (server push, polling, focus…).
 *
 *   confirmed tables ──(+ pending mutations, in order)──▶ view
 *        ▲
 *        └── /sync pages (idempotent upserts / tombstone deletes)
 *
 * Tables are keyed by sync entity type (`"task"`, `"task_label"`, …) and hold
 * the rows exactly as the sync log carries them. The store is generic over
 * entity types: a type it has never seen simply gets a new table, so new
 * entities need no store changes.
 */

export type SyncRow = { readonly id: string } & Readonly<Record<string, unknown>>;
export type SyncTable = ReadonlyMap<string, SyncRow>;
/** Entity type → rows by id. Immutable: every change returns new maps for touched tables only. */
export type SyncTables = Readonly<Record<string, SyncTable | undefined>>;

const EMPTY: SyncTable = new Map();

// ── Cursors ──

/**
 * Cursors are decimal strings (bigints on the server). Compares them
 * numerically without BigInt: longer is larger, equal lengths compare lexically.
 */
export function compareCursors(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, "");
  const y = b.replace(/^0+(?=\d)/, "");
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

export const maxCursor = (a: string, b: string) => (compareCursors(a, b) >= 0 ? a : b);

// ── Tables (pure helpers, also used by optimistic mutations) ──

export const getTable = (tables: SyncTables, entity: string): SyncTable => tables[entity] ?? EMPTY;

export const getRow = <T extends SyncRow = SyncRow>(tables: SyncTables, entity: string, id: string) =>
  getTable(tables, entity).get(id) as T | undefined;

/** Builds tables from row lists, e.g. a bootstrap snapshot. */
export function tablesFromRows(rows: Readonly<Record<string, Iterable<SyncRow> | undefined>>): SyncTables {
  const tables: Record<string, SyncTable> = {};
  for (const [entity, list] of Object.entries(rows)) {
    if (list) tables[entity] = new Map(Array.from(list, (r) => [r.id, r]));
  }
  return tables;
}

/** Applies `edit` to a copy of one table. */
export function editTable(tables: SyncTables, entity: string, edit: (rows: Map<string, SyncRow>) => void) {
  const rows = new Map(getTable(tables, entity));
  edit(rows);
  return { ...tables, [entity]: rows } as SyncTables;
}

export const upsertRow = (tables: SyncTables, entity: string, row: SyncRow) =>
  editTable(tables, entity, (rows) => rows.set(row.id, row));

/** Merges `patch` into an existing row; a no-op if the row is gone (e.g. deleted remotely). */
export function patchRow(tables: SyncTables, entity: string, id: string, patch: Record<string, unknown>) {
  const row = getRow(tables, entity, id);
  return row ? upsertRow(tables, entity, { ...row, ...patch, id }) : tables;
}

export function deleteRow(tables: SyncTables, entity: string, id: string) {
  return getTable(tables, entity).has(id) ? editTable(tables, entity, (rows) => rows.delete(id)) : tables;
}

export function deleteWhere(tables: SyncTables, entity: string, match: (row: SyncRow) => boolean) {
  const table = getTable(tables, entity);
  if (![...table.values()].some(match)) return tables;
  return editTable(tables, entity, (rows) => {
    for (const [id, row] of rows) if (match(row)) rows.delete(id);
  });
}

/**
 * Applies sync changes in order. Idempotent: an upsert replaces the row with
 * the full entity, a delete removes it, so replaying a change is harmless.
 * Upserts of soft-deleted rows (`deletedAt` set) count as deletes.
 */
export function applyChanges(tables: SyncTables, changes: readonly SyncChange[]): SyncTables {
  if (changes.length === 0) return tables;
  const copies = new Map<string, Map<string, SyncRow>>();
  const table = (entity: string) => {
    let rows = copies.get(entity);
    if (!rows) copies.set(entity, (rows = new Map(getTable(tables, entity))));
    return rows;
  };
  for (const c of changes) {
    const data = c.data as Record<string, unknown> | null;
    if (c.action === "delete" || (data && data.deletedAt != null)) table(c.entity).delete(c.entityId);
    else if (data) table(c.entity).set(c.entityId, { ...data, id: c.entityId });
  }
  return { ...tables, ...Object.fromEntries(copies) };
}

// ── Store ──

/** Fetches one page of `/sync?after=<cursor>`. */
export type PullPage = (after: string) => Promise<SyncPage>;

/** An optimistic edit: a pure function from the tables to the tables with the edit applied. */
export type Overlay = (tables: SyncTables) => SyncTables;

interface Pending {
  id: number;
  overlay: Overlay;
  /** Set once the server accepted the write: the store sequence number at that moment. */
  ackedAt: number | null;
}

export interface MutationOptions<T> {
  /** Applied right away and kept until the server's own change has been pulled. */
  apply: Overlay;
  /** Sends the write. Rejecting rolls the overlay back. */
  send: () => Promise<T>;
  /**
   * Replaces the overlay once the server accepted the write, e.g. to show the
   * created row as the server returned it until the sync log catches up.
   */
  confirmed?: (result: T) => Overlay;
}

export interface SyncStoreOptions {
  tables: SyncTables;
  cursor: string;
  pull: PullPage;
  /** Called with each page of changes after it was applied. */
  onChanges?: (changes: readonly SyncChange[]) => void;
  /** Safety valve against a server that keeps saying `hasMore` without advancing. */
  maxPagesPerPull?: number;
}

/**
 * The store. Server state (`confirmed`) only ever comes from the sync log or a
 * snapshot; pending mutations are overlays recomputed on top of it, so incoming
 * changes rebase them for free and a rollback can never clobber newer data.
 *
 * Reconciliation: a successful write is not dropped when its HTTP response
 * arrives (that would flicker back until the next pull) but when a pull that
 * *started after* the response completes. The server commits before it
 * responds and cursors become visible in commit order, so that pull contains
 * the write's own change.
 */
export class SyncStore {
  private confirmed: SyncTables;
  private cursorValue: string;
  private pending: Pending[] = [];
  private view: SyncTables | null = null;
  private listeners = new Set<() => void>();
  private nextId = 1;
  /** Increments on every ack, so pulls know which acks they cover. */
  private seq = 0;
  /** Increments on reset, so an in-flight pull restarts from the new cursor. */
  private epoch = 0;
  private running: Promise<void> | null = null;
  private queued: Promise<void> | null = null;

  constructor(private readonly options: SyncStoreOptions) {
    this.confirmed = options.tables;
    this.cursorValue = options.cursor;
  }

  /** Last change applied from the sync log. */
  get cursor() {
    return this.cursorValue;
  }

  /** Mutations that are in flight or waiting for their change to be pulled. */
  get pendingCount() {
    return this.pending.length;
  }

  /** Server state plus pending mutations. Stable until something changes. */
  getSnapshot = (): SyncTables => {
    this.view ??= this.pending.reduce((tables, m) => {
      try {
        return m.overlay(tables);
      } catch {
        return tables; // an overlay that no longer applies is skipped, not fatal
      }
    }, this.confirmed);
    return this.view;
  };

  /** Server state only. */
  getConfirmed = () => this.confirmed;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /**
   * Replaces server state with a snapshot (bootstrap) taken at `cursor`.
   * Pending mutations stay on top. Any in-flight pull restarts from `cursor`.
   */
  reset(tables: SyncTables, cursor: string) {
    this.confirmed = tables;
    this.cursorValue = cursor;
    this.epoch++;
    this.changed();
  }

  /** Applies changes pushed by other means (or tests). Changes at or before the cursor are skipped. */
  receive(page: Pick<SyncPage, "changes" | "cursor">) {
    const fresh = page.changes.filter((c) => compareCursors(c.id, this.cursorValue) > 0);
    this.confirmed = applyChanges(this.confirmed, fresh);
    this.cursorValue = maxCursor(this.cursorValue, page.cursor);
    if (fresh.length) {
      this.changed();
      this.options.onChanges?.(fresh);
    }
  }

  /**
   * Catches up with the sync log, following `hasMore`. Single-flight: calling it
   * during a pull schedules exactly one more, and the returned promise settles
   * once a pull that started after the call has finished.
   */
  pull(): Promise<void> {
    if (!this.running) {
      this.running = this.run().finally(() => (this.running = null));
      return this.running;
    }
    this.queued ??= this.running
      .catch(() => {})
      .then(() => {
        this.queued = null;
        return this.pull();
      });
    return this.queued;
  }

  /**
   * Applies an optimistic edit, sends it, and rolls it back if sending fails
   * (the error is rethrown). On success it triggers a pull to confirm it.
   */
  async mutate<T>({ apply, send, confirmed }: MutationOptions<T>): Promise<T> {
    const entry: Pending = { id: this.nextId++, overlay: apply, ackedAt: null };
    this.pending.push(entry);
    this.changed();
    let result: T;
    try {
      result = await send();
    } catch (err) {
      this.pending = this.pending.filter((m) => m !== entry);
      this.changed();
      throw err;
    }
    if (confirmed) {
      entry.overlay = confirmed(result);
      this.changed();
    }
    entry.ackedAt = ++this.seq;
    this.pull().catch(() => {}); // the overlay stays until a later pull succeeds
    return result;
  }

  private async run() {
    const startSeq = this.seq;
    let epoch = this.epoch;
    const limit = this.options.maxPagesPerPull ?? 1000;
    for (let pages = 0; ; pages++) {
      if (pages >= limit) throw new Error("Sync did not converge");
      const after = this.cursorValue;
      const page = await this.options.pull(after);
      if (epoch !== this.epoch) {
        epoch = this.epoch; // a snapshot replaced our state mid-pull: start over from its cursor
        continue;
      }
      this.receive(page);
      if (!page.hasMore) break;
      if (compareCursors(page.cursor, after) <= 0) throw new Error("Sync cursor did not advance");
    }
    const before = this.pending.length;
    this.pending = this.pending.filter((m) => m.ackedAt === null || m.ackedAt > startSeq);
    if (this.pending.length !== before) this.changed();
  }

  private changed() {
    this.view = null;
    for (const listener of [...this.listeners]) listener();
  }
}

// ── Reconnect policy ──

/**
 * Exponential backoff with jitter for reconnects and retries: attempt 0 waits
 * about `base`, doubling up to `max`, randomised to 50–100% so clients that lost
 * the same server don't reconnect in lockstep.
 */
export function backoffDelay(
  attempt: number,
  {
    base = 1000,
    max = 30_000,
    random = Math.random,
  }: { base?: number; max?: number; random?: () => number } = {},
) {
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.round(ceiling * (0.5 + random() / 2));
}
