import { SEARCH_MIN_QUERY_LENGTH, type SearchResponse } from "@knotworking/core";
import { searchWorkspace } from "@knotworking/api-client";
import { useEffect, useState } from "react";
import { browserApi } from "./auth-client";

/** Pause after the last keystroke before asking the server (the menu stays instant meanwhile). */
export const SEARCH_DEBOUNCE_MS = 200;
/** Hits per kind the menu asks for. */
export const MENU_SEARCH_LIMIT = 8;

/** A hit worth listing under "Content matches": a document or task whose body (not just title) matched. */
export type ContentHit =
  | { kind: "document"; hit: SearchResponse["documents"][number] }
  | { kind: "task"; hit: SearchResponse["tasks"][number] };

/** The trimmed query, or null when it is too short to search the server for. */
export function searchableQuery(raw: string): string | null {
  const q = raw.trim().replace(/\s+/g, " ");
  return q.length >= SEARCH_MIN_QUERY_LENGTH ? q : null;
}

/**
 * Hits for the menu's "Content matches" group: those with a match inside the body. Title-only hits are
 * left out because the menu already lists every doc and task by title (filtered locally, instantly).
 * Documents come first, each kind in the server's rank order.
 */
export function contentHits(response: SearchResponse | null): ContentHit[] {
  if (!response) return [];
  return [
    ...response.documents
      .filter((hit) => hit.snippetMatches.length > 0)
      .map((hit): ContentHit => ({ kind: "document", hit })),
    ...response.tasks
      .filter((hit) => hit.snippetMatches.length > 0)
      .map((hit): ContentHit => ({ kind: "task", hit })),
  ];
}

export type SearchFn = (slug: string, query: string, signal: AbortSignal) => Promise<SearchResponse>;

const searchViaApi: SearchFn = (slug, query, signal) =>
  searchWorkspace(browserApi(), slug, query, { limit: MENU_SEARCH_LIMIT, signal });

interface Settled {
  query: string;
  response: SearchResponse | null;
  failed: boolean;
}

/**
 * Debounced server search for the command menu. Each change of `query` cancels the previous request
 * and timer; a response that arrives for an outdated query is dropped. While the next response is
 * pending the previous hits stay (no flicker between keystrokes). A failed request just yields no
 * hits: the menu's local results are unaffected.
 */
export function useContentSearch({
  slug,
  query,
  enabled = true,
  search = searchViaApi,
  delayMs = SEARCH_DEBOUNCE_MS,
}: {
  slug: string;
  query: string;
  /** Searches only while true (the menu is open). */
  enabled?: boolean;
  search?: SearchFn;
  delayMs?: number;
}) {
  const q = enabled ? searchableQuery(query) : null;
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (!q) {
      setSettled((s) => (s === null ? s : null));
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      search(slug, q, controller.signal)
        .then((response) => {
          if (!controller.signal.aborted) setSettled({ query: q, response, failed: false });
        })
        .catch(() => {
          if (!controller.signal.aborted) setSettled({ query: q, response: null, failed: true });
        });
    }, delayMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, slug, search, delayMs]);

  return {
    hits: q ? contentHits(settled?.response ?? null) : [],
    /** True from the first keystroke of a searchable query until its response (or failure) arrives. */
    pending: q !== null && settled?.query !== q,
    failed: q !== null && settled?.query === q && settled.failed,
  };
}
