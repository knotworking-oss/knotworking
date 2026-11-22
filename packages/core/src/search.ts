import { z } from "zod";

/**
 * Workspace search (docs and tasks). The server matches with Postgres full-text search and
 * substring fallbacks; the pure helpers here (query terms, snippets with highlight ranges) are
 * shared so every client reads results the same way.
 */

/** Queries shorter than this are not searched by clients (the server accepts 1 character). */
export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_MAX_QUERY_LENGTH = 200;
export const SEARCH_MAX_TERMS = 8;

export const searchScopes = ["all", "documents", "tasks"] as const;
export type SearchScope = (typeof searchScopes)[number];

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(SEARCH_MAX_QUERY_LENGTH),
  scope: z.enum(searchScopes).default("all"),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/** `[start, end)` offsets into the string they belong to. */
export type SearchRange = [number, number];

export interface SearchHit {
  id: string;
  title: string;
  /** Where the title matches, for highlighting. Empty when only the body matched. */
  titleMatches: SearchRange[];
  /** A window of the body around the first match (or its start), whitespace collapsed. */
  snippet: string;
  /** Where the query matches inside `snippet`. */
  snippetMatches: SearchRange[];
  updatedAt: string;
}

export interface DocumentSearchHit extends SearchHit {
  icon: string | null;
  parentId: string | null;
  teamId: string | null;
  projectId: string | null;
}

export interface TaskSearchHit extends SearchHit {
  teamId: string;
  stateId: string;
  projectId: string | null;
}

export interface SearchResponse {
  query: string;
  documents: DocumentSearchHit[];
  tasks: TaskSearchHit[];
}

/**
 * The words of a query: runs of letters and digits, lowercased, de-duplicated, at most
 * `SEARCH_MAX_TERMS`. Everything else (operators, quotes, punctuation) is separator, so a query is
 * never interpreted as search syntax.
 */
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)].slice(0, SEARCH_MAX_TERMS);
}

/**
 * Where `terms` (prefix matches at word starts) and the whole `phrase` (substring) occur in
 * `text`, case-insensitively, as sorted, non-overlapping ranges.
 */
export function findMatches(text: string, phrase: string, terms: string[]): SearchRange[] {
  const lower = foldCase(text);
  const ranges: SearchRange[] = [];
  const p = foldCase(phrase.trim());
  if (p) for (const start of occurrences(lower, p)) ranges.push([start, start + p.length]);
  for (const term of terms) {
    for (const start of occurrences(lower, term)) {
      if (start === 0 || !isWordChar(lower[start - 1]!)) {
        let end = start + term.length;
        // Highlight the whole word a prefix matched.
        while (end < lower.length && isWordChar(lower[end]!)) end++;
        ranges.push([start, end]);
      }
    }
  }
  return mergeRanges(ranges);
}

export interface SnippetOptions {
  /** Max characters of body in the snippet (default 160). */
  length?: number;
  /** Characters of context kept before the first match (default 48). */
  lead?: number;
}

/**
 * A short excerpt of `text` around its first match of the query, with highlight ranges relative to
 * the returned string. Whitespace (including newlines between blocks) is collapsed to single
 * spaces. Without a match the snippet is the start of the text.
 */
export function makeSnippet(
  text: string,
  phrase: string,
  terms: string[],
  { length = 160, lead = 48 }: SnippetOptions = {},
): { snippet: string; matches: SearchRange[] } {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return { snippet: "", matches: [] };
  const all = findMatches(flat, phrase, terms);
  const first = all[0]?.[0] ?? 0;
  let start = Math.max(0, first - lead);
  // Start at a word boundary so the excerpt doesn't open mid-word.
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space !== -1 && space < first) start = space + 1;
  }
  let end = Math.min(flat.length, start + length);
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > Math.max(start, first) + 1) end = space;
  }
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  const matches: SearchRange[] = [];
  for (const [s, e] of all) {
    if (e <= start || s >= end) continue;
    matches.push([Math.max(s, start) - start + prefix.length, Math.min(e, end) - start + prefix.length]);
  }
  return { snippet: `${prefix}${flat.slice(start, end)}${suffix}`, matches };
}

/** Splits `text` into alternating plain and highlighted pieces, for rendering `<mark>`s. */
export function splitByRanges(text: string, ranges: SearchRange[]): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    const start = Math.max(s, at);
    if (e <= start || start >= text.length) continue;
    if (start > at) parts.push({ text: text.slice(at, start), match: false });
    parts.push({ text: text.slice(start, Math.min(e, text.length)), match: true });
    at = Math.min(e, text.length);
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}

const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch);

/** Lowercases without changing string length (a few characters expand), so offsets stay valid. */
function foldCase(text: string): string {
  const lower = text.toLowerCase();
  return lower.length === text.length ? lower : text;
}

function* occurrences(haystack: string, needle: string): Generator<number> {
  if (!needle) return;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) yield i;
}

function mergeRanges(ranges: SearchRange[]): SearchRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: SearchRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
