import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/**
 * Manual ordering (board columns, sidebar trees, backlog) uses fractional index
 * strings. Moving an item rewrites only that item's `sortOrder` — no renumbering
 * of siblings — which keeps sync payloads tiny and makes concurrent reorders from
 * different devices merge cleanly.
 */
export function sortKeyBetween(before: string | null | undefined, after: string | null | undefined): string {
  return generateKeyBetween(before ?? null, after ?? null);
}

export function sortKeysBetween(
  before: string | null | undefined,
  after: string | null | undefined,
  count: number,
): string[] {
  return generateNKeysBetween(before ?? null, after ?? null, count);
}

/** Plain byte-order comparison — fractional keys must NOT use locale collation. */
export const compareSortKeys = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** True if `key` is a well-formed fractional index (as produced by `sortKeyBetween`). */
export function isValidSortKey(key: string): boolean {
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/**
 * Key for an item dropped between two neighbours in a list the client is showing.
 * Unlike `sortKeyBetween` it never throws: neighbours can be out of order or share a
 * key (two devices moved items into the same gap), and then the bound that conflicts
 * is dropped. The item still lands next to `before`, just not strictly before `after`.
 */
export function sortKeyForMove(before: string | null | undefined, after: string | null | undefined): string {
  const ordered = before == null || after == null || compareSortKeys(before, after) < 0;
  const attempts: [string | null, string | null][] = [
    ...(ordered ? [[before ?? null, after ?? null] as [string | null, string | null]] : []),
    [before ?? null, null],
    [null, after ?? null],
  ];
  for (const [a, b] of attempts) {
    try {
      return generateKeyBetween(a, b);
    } catch {
      // try the next, looser placement
    }
  }
  return generateKeyBetween(null, null);
}
