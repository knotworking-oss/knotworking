import { describe, expect, it } from "vitest";
import {
  findMatches,
  makeSnippet,
  searchQuerySchema,
  searchTerms,
  SEARCH_MAX_TERMS,
  splitByRanges,
} from "./search";

describe("searchTerms", () => {
  it("keeps letter and digit runs, lowercased and unique; punctuation is separator", () => {
    expect(searchTerms("Hello, World! hello")).toEqual(["hello", "world"]);
    expect(searchTerms("C++ & foo.bar() | 'x':*")).toEqual(["c", "foo", "bar", "x"]);
    expect(searchTerms("Käse 日本語 v2")).toEqual(["käse", "日本語", "v2"]);
    expect(searchTerms("%_!\\\"'()<>")).toEqual([]);
    expect(searchTerms("")).toEqual([]);
  });

  it("caps the number of terms", () => {
    expect(searchTerms("a b c d e f g h i j k")).toHaveLength(SEARCH_MAX_TERMS);
  });
});

describe("findMatches", () => {
  it("highlights whole words for prefix matches and the whole phrase as a substring", () => {
    expect(findMatches("The roadmap review", "roadm", ["roadm"])).toEqual([[4, 11]]);
    expect(findMatches("Cost: C++ course", "C++", [])).toEqual([[6, 9]]);
    // The terms of a query are word prefixes too ("c" starts Cost, C++ and course).
    expect(findMatches("Cost: C++ course", "C++", ["c"])).toEqual([
      [0, 4],
      [6, 9],
      [10, 16],
    ]);
    // Terms only match at word starts.
    expect(findMatches("unplanned plan", "", ["plan"])).toEqual([[10, 14]]);
  });

  it("merges overlapping ranges and is case-insensitive", () => {
    expect(findMatches("Launch Plan launch", "launch plan", ["launch", "plan"])).toEqual([
      [0, 11],
      [12, 18],
    ]);
  });
});

describe("makeSnippet", () => {
  it("collapses whitespace and marks the match relative to the snippet", () => {
    const { snippet, matches } = makeSnippet("first line\n\nsecond   line with Needle", "needle", ["needle"]);
    expect(snippet).toBe("first line second line with Needle");
    expect(matches).toEqual([[28, 34]]);
    expect(snippet.slice(...matches[0]!)).toBe("Needle");
  });

  it("windows long text around the first match with ellipses, keeping offsets right", () => {
    const text = `${"alpha ".repeat(100)}needle ${"omega ".repeat(100)}`;
    const { snippet, matches } = makeSnippet(text, "needle", ["needle"]);
    expect(snippet.length).toBeLessThan(200);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.slice(...matches[0]!)).toBe("needle");
    // Starts on a word boundary, not mid-word.
    expect(snippet.slice(1, 6)).toBe("alpha");
  });

  it("falls back to the start of the text when nothing matches, and handles empty text", () => {
    const { snippet, matches } = makeSnippet("Nothing here but words", "zzz", ["zzz"]);
    expect(snippet).toBe("Nothing here but words");
    expect(matches).toEqual([]);
    expect(makeSnippet("  \n ", "a", ["a"])).toEqual({ snippet: "", matches: [] });
  });

  it("drops matches outside the window", () => {
    const text = `needle ${"filler ".repeat(100)}needle`;
    const { snippet, matches } = makeSnippet(text, "needle", ["needle"]);
    expect(matches).toHaveLength(1);
    expect(snippet.slice(...matches[0]!)).toBe("needle");
  });
});

describe("splitByRanges", () => {
  it("alternates plain and highlighted parts and tolerates bad ranges", () => {
    expect(splitByRanges("abcdef", [[1, 3]])).toEqual([
      { text: "a", match: false },
      { text: "bc", match: true },
      { text: "def", match: false },
    ]);
    expect(splitByRanges("abc", [])).toEqual([{ text: "abc", match: false }]);
    expect(
      splitByRanges("abc", [
        [2, 99],
        [5, 6],
      ]),
    ).toEqual([
      { text: "ab", match: false },
      { text: "c", match: true },
    ]);
    expect(splitByRanges("", [[0, 1]])).toEqual([]);
  });
});

describe("searchQuerySchema", () => {
  it("trims and defaults, and rejects empty, oversized and out-of-range input", () => {
    expect(searchQuerySchema.parse({ q: "  hi  " })).toEqual({ q: "hi", scope: "all", limit: 10 });
    expect(searchQuerySchema.parse({ q: "x", limit: "5", scope: "tasks" })).toEqual({
      q: "x",
      scope: "tasks",
      limit: 5,
    });
    for (const bad of [
      {},
      { q: "" },
      { q: "   " },
      { q: "x".repeat(201) },
      { q: "x", limit: 0 },
      { q: "x", limit: 51 },
    ]) {
      expect(searchQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
