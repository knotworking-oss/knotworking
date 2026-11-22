import type { SearchResponse } from "@knotworking/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentHits, searchableQuery, useContentSearch, type SearchFn } from "./content-search";

const doc = (id: string, over: Partial<SearchResponse["documents"][number]> = {}) => ({
  id,
  title: `Doc ${id}`,
  icon: null,
  parentId: null,
  teamId: null,
  projectId: null,
  titleMatches: [],
  snippet: "…the sandbox request…",
  snippetMatches: [[5, 12]] as [number, number][],
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});
const task = (id: string, over: Partial<SearchResponse["tasks"][number]> = {}) => ({
  id,
  title: `Task ${id}`,
  teamId: "t",
  stateId: "s",
  projectId: null,
  titleMatches: [],
  snippet: "open the sandbox",
  snippetMatches: [[9, 16]] as [number, number][],
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});
const response = (
  q: string,
  documents = [doc("d1")],
  tasks: SearchResponse["tasks"] = [],
): SearchResponse => ({
  query: q,
  documents,
  tasks,
});

describe("searchableQuery", () => {
  it("trims, collapses whitespace and rejects queries that are too short", () => {
    expect(searchableQuery("  sand   box ")).toBe("sand box");
    expect(searchableQuery("")).toBeNull();
    expect(searchableQuery("   ")).toBeNull();
    expect(searchableQuery("a")).toBeNull();
    expect(searchableQuery(" a ")).toBeNull();
    expect(searchableQuery("ab")).toBe("ab");
    expect(searchableQuery("C+")).toBe("C+");
  });
});

describe("contentHits", () => {
  it("keeps only hits whose body matched, documents before tasks", () => {
    const hits = contentHits(
      response(
        "sandbox",
        [doc("title-only", { snippetMatches: [], titleMatches: [[0, 3]] }), doc("body"), doc("body2")],
        [task("t-body"), task("t-title", { snippetMatches: [] })],
      ),
    );
    expect(hits.map((h) => `${h.kind}:${h.hit.id}`)).toEqual([
      "document:body",
      "document:body2",
      "task:t-body",
    ]);
  });

  it("is empty without a response", () => {
    expect(contentHits(null)).toEqual([]);
    expect(contentHits(response("x", [], []))).toEqual([]);
  });
});

describe("useContentSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const render = (search: SearchFn, initial: { query: string; enabled?: boolean; slug?: string }) =>
    renderHook(
      (props: { query: string; enabled?: boolean; slug?: string }) =>
        useContentSearch({ slug: props.slug ?? "acme", query: props.query, enabled: props.enabled, search }),
      { initialProps: initial },
    );

  it("waits for the debounce, then searches once with the trimmed query", async () => {
    const search = vi.fn<SearchFn>(async (_s, q) => response(q));
    const { result } = render(search, { query: "  sandbox " });
    expect(result.current.pending).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(search).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]!.slice(0, 2)).toEqual(["acme", "sandbox"]);
    expect(result.current.pending).toBe(false);
    expect(result.current.hits.map((h) => h.hit.id)).toEqual(["d1"]);
  });

  it("does not search for empty or one-character queries, or while the menu is closed", async () => {
    const search = vi.fn<SearchFn>(async (_s, q) => response(q));
    const { rerender, result } = render(search, { query: "" });
    rerender({ query: "a" });
    rerender({ query: "sandbox", enabled: false });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(search).not.toHaveBeenCalled();
    expect(result.current).toEqual({ hits: [], pending: false, failed: false });
  });

  it("coalesces keystrokes into one request and aborts the superseded one", async () => {
    const signals: AbortSignal[] = [];
    const search = vi.fn<SearchFn>(async (_s, q, signal) => {
      signals.push(signal);
      return response(q);
    });
    const { rerender } = render(search, { query: "sa" });
    await act(() => vi.advanceTimersByTimeAsync(100));
    rerender({ query: "san" });
    await act(() => vi.advanceTimersByTimeAsync(100));
    rerender({ query: "sand" });
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![1]).toBe("sand");

    // A request already in flight is aborted by the next keystroke.
    rerender({ query: "sandb" });
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(search).toHaveBeenCalledTimes(2);
    rerender({ query: "sandbo" });
    expect(signals[1]!.aborted).toBe(true);
  });

  it("drops a late response for an outdated query", async () => {
    const resolvers: Record<string, (r: SearchResponse) => void> = {};
    const search: SearchFn = (_s, q) => new Promise((resolve) => (resolvers[q] = resolve));
    const { rerender, result } = render(search, { query: "old" });
    await act(() => vi.advanceTimersByTimeAsync(250));
    rerender({ query: "new" });
    await act(() => vi.advanceTimersByTimeAsync(250));
    await act(async () => resolvers.old!(response("old", [doc("stale")])));
    expect(result.current.hits).toEqual([]);
    expect(result.current.pending).toBe(true);
    await act(async () => resolvers.new!(response("new", [doc("fresh")])));
    expect(result.current.hits.map((h) => h.hit.id)).toEqual(["fresh"]);
    expect(result.current.pending).toBe(false);
  });

  it("keeps the previous hits while the next response is pending, and clears them when the query empties", async () => {
    const search = vi.fn<SearchFn>(async (_s, q) => response(q, [doc(`for-${q}`)]));
    const { rerender, result } = render(search, { query: "sand" });
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(result.current.hits.map((h) => h.hit.id)).toEqual(["for-sand"]);
    rerender({ query: "sandb" });
    expect(result.current.pending).toBe(true);
    expect(result.current.hits.map((h) => h.hit.id)).toEqual(["for-sand"]);
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(result.current.hits.map((h) => h.hit.id)).toEqual(["for-sandb"]);
    rerender({ query: "" });
    expect(result.current.hits).toEqual([]);
    expect(result.current.pending).toBe(false);
  });

  it("reports a failed request as no hits, without throwing, and recovers on the next query", async () => {
    const search = vi.fn<SearchFn>(async (_s, q) => {
      if (q === "boom") throw new Error("network");
      return response(q);
    });
    const { rerender, result } = render(search, { query: "boom" });
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(result.current).toEqual({ hits: [], pending: false, failed: true });
    rerender({ query: "fine" });
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(result.current.failed).toBe(false);
    expect(result.current.hits).toHaveLength(1);
  });

  it("forgets earlier results once the menu closes", async () => {
    const search = vi.fn<SearchFn>(async (_s, q) => response(q));
    const { rerender, result } = render(search, { query: "sandbox", enabled: true });
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(result.current.hits).toHaveLength(1);
    rerender({ query: "sandbox", enabled: false });
    expect(result.current.hits).toEqual([]);
    rerender({ query: "sandbox", enabled: true });
    expect(result.current.hits).toEqual([]); // not stale hits from the previous opening
    expect(result.current.pending).toBe(true);
  });
});
