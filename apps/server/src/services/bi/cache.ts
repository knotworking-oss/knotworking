import { syncChanges, type Executor } from "@knotworking/db";
import { eq, max } from "drizzle-orm";
import type { BiViewer } from "./access";
import type { BiQueryResult, BiWorkspace } from "./query";

/**
 * A short-lived cache of BI query results: a dashboard opened again, or by
 * several people with the same access, doesn't run its queries again.
 *
 * Results are exact, never stale: the key holds the workspace's latest sync-log position, and
 * every server write records a change there, so any change to the data makes a new
 * key. It also holds the viewer's access class (role and module levels, which decide the fields
 * they may use), the workspace's today, time zone and financial year (which resolve periods), and
 * the spec. Entries live `TTL_MS` at most and the cache holds `MAX_ENTRIES`, oldest dropped first.
 * Errors are never cached.
 */
const TTL_MS = 60_000;
const MAX_ENTRIES = 500;
/** Answers with more rows than this are computed every time rather than cached. */
const MAX_CACHED_ROWS = 1000;

const entries = new Map<string, { expires: number; value: BiQueryResult }>();
let hits = 0;
let misses = 0;

/** The workspace's latest sync-log position: changes whenever a write is recorded. */
async function syncPosition(db: Executor, workspaceId: string): Promise<string> {
  const [row] = await db
    .select({ id: max(syncChanges.id) })
    .from(syncChanges)
    .where(eq(syncChanges.workspaceId, workspaceId));
  return String(row?.id ?? 0);
}

/** Who sees what: viewers in the same class get the same answer to the same spec. */
const accessClass = (viewer: BiViewer) =>
  `${viewer.role}:${Object.entries(viewer.modules)
    .filter(([, level]) => level && level !== "none")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, level]) => `${id}=${level}`)
    .join(",")}`;

/** Runs `compute` unless an exact answer for this workspace state, access class and spec is cached. */
export async function cachedBiResult(
  db: Executor,
  workspace: BiWorkspace,
  viewer: BiViewer,
  spec: unknown,
  compute: () => Promise<BiQueryResult>,
): Promise<BiQueryResult> {
  const key = [
    workspace.id,
    await syncPosition(db, workspace.id),
    workspace.today,
    workspace.timeZone,
    workspace.financialYearStartMonth,
    workspace.currency,
    accessClass(viewer),
    JSON.stringify(spec),
  ].join("|");
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && hit.expires > now) {
    hits++;
    // Most recently used last, so the oldest is dropped first.
    entries.delete(key);
    entries.set(key, hit);
    return structuredClone(hit.value);
  }
  misses++;
  const value = await compute();
  // Large answers (tables of many rows) aren't kept: memory stays bounded at MAX_ENTRIES small ones.
  if (value.rows.length > MAX_CACHED_ROWS) return value;
  entries.set(key, { expires: now + TTL_MS, value: structuredClone(value) });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  return value;
}

/** Hit and miss counts since start (or the last reset), for measuring whether the cache helps. */
export const biCacheStats = () => ({ hits, misses, entries: entries.size });

/** Empties the cache (tests). */
export function resetBiCache() {
  entries.clear();
  hits = 0;
  misses = 0;
}
