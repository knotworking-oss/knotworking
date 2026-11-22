import { describe, expect, it } from "vitest";
import {
  addedMentions,
  commentUpdateSchema,
  compareSortKeys,
  d,
  docContentSchema,
  docToPlainText,
  extractMentions,
  MAX_MENTIONS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  type DocNode,
  documentUpdateSchema,
  taskCreateSchema,
  taskRelationCreateSchema,
  taskUpdateSchema,
  newId,
  isReservedWorkspaceSlug,
  isValidSortKey,
  RESERVED_WORKSPACE_SLUGS,
  safeWorkspaceSlug,
  sortKeyBetween,
  sortKeyForMove,
  sortKeysBetween,
  textToDoc,
  wouldCreateBlockingCycle,
} from "./index";

describe("ids", () => {
  it("generates time-ordered UUIDv7s", () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe("ordering", () => {
  it("creates keys between neighbours without renumbering", () => {
    const [a, c] = sortKeysBetween(null, null, 2) as [string, string];
    const b = sortKeyBetween(a, c);
    expect([c, b, a].sort(compareSortKeys)).toEqual([a, b, c]);
  });

  it("places dropped items between neighbours, tolerating conflicting ones", () => {
    const [a, b] = sortKeysBetween(null, null, 2) as [string, string];
    const mid = sortKeyForMove(a, b);
    expect(compareSortKeys(a, mid)).toBeLessThan(0);
    expect(compareSortKeys(mid, b)).toBeLessThan(0);
    expect(compareSortKeys(sortKeyForMove(null, a), a)).toBeLessThan(0);
    expect(compareSortKeys(sortKeyForMove(b, null), b)).toBeGreaterThan(0);
    // Duplicate or reversed neighbours (concurrent moves) still produce a key after `before`.
    expect(compareSortKeys(sortKeyForMove(a, a), a)).toBeGreaterThan(0);
    expect(compareSortKeys(sortKeyForMove(b, a), b)).toBeGreaterThan(0);
    expect(isValidSortKey(sortKeyForMove("not a key!", null))).toBe(true);
  });

  it("keeps strict order when many items are dropped into the same gap", () => {
    // Always dropping right after the first item (the newest key lands between it and the previous one).
    const [first, last] = sortKeysBetween(null, null, 2) as [string, string];
    const placed = [first, last];
    for (let i = 0; i < 200; i++) placed.splice(1, 0, sortKeyForMove(placed[0], placed[1]));
    expect(placed.every(isValidSortKey)).toBe(true);
    expect(placed.slice(1).every((k, i) => compareSortKeys(placed[i]!, k) < 0)).toBe(true);
    // Likewise when appending and prepending repeatedly.
    const tail = [first];
    for (let i = 0; i < 50; i++) tail.push(sortKeyForMove(tail[tail.length - 1], null));
    for (let i = 0; i < 50; i++) tail.unshift(sortKeyForMove(null, tail[0]));
    expect(tail.slice(1).every((k, i) => compareSortKeys(tail[i]!, k) < 0)).toBe(true);
  });

  it("sorts by byte order rather than locale (uppercase prefixes come first)", () => {
    expect(compareSortKeys("Zz", "a0")).toBeLessThan(0);
    expect(["b", "B", "a", "A"].sort(compareSortKeys)).toEqual(["A", "B", "a", "b"]);
    expect(compareSortKeys("a0", "a0")).toBe(0);
  });

  it("validates sort keys", () => {
    expect(isValidSortKey(sortKeyBetween(null, null))).toBe(true);
    expect(isValidSortKey("")).toBe(false);
    expect(isValidSortKey("a00")).toBe(false);
    expect(taskCreateSchema.safeParse({ teamId: newId(), title: "x", sortOrder: "%%" }).success).toBe(false);
  });
});

describe("content", () => {
  it("converts plain text to paragraphs", () => {
    expect(textToDoc("  \n")).toEqual({ type: "doc", content: [] });
    expect(textToDoc("One\r\n\nTwo\n")).toEqual(d.doc(d.p("One"), { type: "paragraph" }, d.p("Two")));
  });

  it("projects block content to plain text", () => {
    const doc = d.doc(d.h(1, "Title"), d.p("Hello ", d.text("world", "bold")), d.bullets("one", "two"));
    expect(docToPlainText(doc)).toBe("Title\nHello world\none\ntwo\n");
  });

  it("flattens tables to one line per row with cells separated by ' | '", () => {
    const doc = d.doc(
      d.p("Before"),
      d.table([
        ["Name", "Owner", "Status"],
        ["Login", "", "Done"],
      ]),
      d.p("After"),
    );
    expect(docToPlainText(doc)).toBe("Before\nName | Owner | Status\nLogin |  | Done\nAfter\n");
    // Multi-block cells stay on their row; spans and header kinds don't matter.
    const multi: DocNode = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableCell", attrs: { colspan: 2 }, content: [d.p("a"), d.p("b")] },
            { type: "tableCell", content: [d.bullets("x", "y")] },
          ],
        },
      ],
    };
    expect(docToPlainText(d.doc(multi))).toBe("a b | x y\n");
  });
});

describe("table validation", () => {
  const parse = (...content: DocNode[]) => docContentSchema.safeParse(d.doc(...content));

  it("accepts well-formed tables, including spans and nested blocks", () => {
    expect(
      parse(
        d.table([
          ["a", "b"],
          ["c", ""],
        ]),
      ).success,
    ).toBe(true);
    expect(
      parse({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", attrs: { colspan: 2, rowspan: 1, colwidth: null }, content: [d.p("h")] },
            ],
          },
        ],
      }).success,
    ).toBe(true);
    expect(parse({ type: "someFutureBlock", content: [d.p("kept")] }).success).toBe(true);
  });

  it("rejects malformed tables", () => {
    expect(parse({ type: "table", content: [] }).success).toBe(false);
    expect(parse({ type: "table" }).success).toBe(false);
    expect(parse({ type: "table", content: [d.p("not a row")] }).success).toBe(false);
    expect(parse({ type: "table", content: [{ type: "tableRow", content: [d.p("x")] }] }).success).toBe(
      false,
    );
    expect(parse({ type: "table", content: [{ type: "tableRow", content: [] }] }).success).toBe(false);
    const cell = (attrs?: Record<string, unknown>, content: DocNode[] = [d.p("x")]): DocNode => ({
      type: "table",
      content: [{ type: "tableRow", content: [{ type: "tableCell", attrs, content }] }],
    });
    expect(parse(cell({ colspan: 0 })).success).toBe(false);
    expect(parse(cell({ rowspan: 1.5 })).success).toBe(false);
    expect(parse(cell({ colspan: 100_000 })).success).toBe(false);
    expect(parse(cell(undefined, [])).success).toBe(false);
  });

  it("bounds table size and nesting depth", () => {
    const wide = d.table([Array.from({ length: MAX_TABLE_COLUMNS + 1 }, () => "x")]);
    expect(parse(wide).success).toBe(false);
    expect(parse(d.table(Array.from({ length: MAX_TABLE_ROWS }, () => ["x", "y"]))).success).toBe(true);
    expect(parse(d.table(Array.from({ length: MAX_TABLE_ROWS + 1 }, () => ["x"]))).success).toBe(false);
    let deep: DocNode = d.p("x");
    for (let i = 0; i < 30; i++) deep = { type: "blockquote", content: [deep] };
    expect(parse(deep).success).toBe(false);
  });

  it("applies to documents and comment bodies", () => {
    const bad = d.doc({ type: "table", content: [d.p("nope")] });
    expect(documentUpdateSchema.safeParse({ content: bad }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ teamId: newId(), title: "t", description: bad }).success).toBe(false);
    expect(commentUpdateSchema.safeParse({ body: bad }).success).toBe(false);
    expect(commentUpdateSchema.safeParse({ body: d.doc(d.table([["a", "b"]])) }).success).toBe(true);
  });
});

describe("mentions", () => {
  const [u1, u2, t1, d1] = [newId(), newId(), newId(), newId()];
  const parse = (...content: DocNode[]) => docContentSchema.safeParse(d.doc(...content));

  it("flattens to @name, [[doc title]] and #task title for plain-text readers", () => {
    const doc = d.doc(
      d.p(
        "Hi ",
        d.mention("user", u1, "Ada"),
        ", see ",
        d.mention("doc", d1, "Roadmap"),
        " and ",
        d.mention("task", t1, "Fix login"),
      ),
    );
    expect(docToPlainText(doc)).toBe("Hi @Ada, see [[Roadmap]] and #Fix login\n");
    // Inside list items and table cells too, and an empty label still reads.
    expect(
      docToPlainText(
        d.doc(d.table([["a", ""]]), {
          type: "bulletList",
          content: [{ type: "listItem", content: [d.p(d.mention("user", u2, ""))] }],
        }),
      ),
    ).toBe("a | \n@unknown\n");
  });

  it("validates kind, id and label, and that a mention is a leaf", () => {
    expect(parse(d.p(d.mention("user", u1, "Ada"))).success).toBe(true);
    expect(parse(d.p(d.mention("task", t1, ""))).success).toBe(true);
    const bad = (attrs: unknown) => parse(d.p({ type: "mention", attrs: attrs as Record<string, unknown> }));
    expect(bad({ kind: "team", id: u1, label: "x" }).success).toBe(false);
    expect(bad({ kind: "user", id: "nope", label: "x" }).success).toBe(false);
    expect(bad({ kind: "user", id: u1 }).success).toBe(false);
    expect(bad({ kind: "user", id: u1, label: 3 }).success).toBe(false);
    expect(bad({ kind: "user", id: u1, label: "x".repeat(513) }).success).toBe(false);
    expect(bad(undefined).success).toBe(false);
    expect(parse(d.p({ ...d.mention("user", u1, "x"), content: [d.text("y")] })).success).toBe(false);
    expect(parse(d.p({ ...d.mention("user", u1, "x"), text: "y" })).success).toBe(false);
  });

  it("bounds how many mentions a body can hold", () => {
    const many = (n: number) => d.p(...Array.from({ length: n }, () => d.mention("user", u1, "A")));
    expect(parse(many(MAX_MENTIONS)).success).toBe(true);
    expect(parse(many(MAX_MENTIONS + 1)).success).toBe(false);
  });

  it("extracts distinct mentions in document order, wherever they are nested", () => {
    const doc = d.doc(
      d.p(d.mention("user", u1, "Ada"), d.mention("user", u1, "Ada again")),
      d.quote("x"),
      { type: "bulletList", content: [{ type: "listItem", content: [d.p(d.mention("task", t1, "T"))] }] },
      d.table([["a"]]),
      d.p(d.mention("doc", d1, "D"), d.mention("task", u1, "same id, other kind")),
    );
    expect(extractMentions(doc).map((m) => `${m.kind}:${m.id}`)).toEqual([
      `user:${u1}`,
      `task:${t1}`,
      `doc:${d1}`,
      `task:${u1}`,
    ]);
    expect(extractMentions(null)).toEqual([]);
    // Malformed nodes are skipped, not thrown on.
    expect(
      extractMentions({ type: "doc", content: [d.p({ type: "mention", attrs: { kind: "x" } })] }),
    ).toEqual([]);
  });

  it("diffs what a save adds", () => {
    const before = d.doc(d.p(d.mention("user", u1, "Ada")));
    const after = d.doc(
      d.p(d.mention("user", u1, "Ada"), d.mention("user", u2, "Marcus")),
      d.p(d.mention("user", u2, "Marcus")),
    );
    expect(addedMentions(before, after).map((m) => m.id)).toEqual([u2]);
    expect(addedMentions(after, before)).toEqual([]);
    expect(addedMentions(null, before).map((m) => m.id)).toEqual([u1]);
    expect(addedMentions(before, before)).toEqual([]);
    // The label is a cache: renaming it is not a new mention.
    expect(addedMentions(before, d.doc(d.p(d.mention("user", u1, "Ada Lovelace"))))).toEqual([]);
  });

  it("applies to documents, task descriptions and comment bodies", () => {
    const bad = d.doc(d.p({ type: "mention", attrs: { kind: "user", id: "nope", label: "x" } }));
    expect(documentUpdateSchema.safeParse({ content: bad }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ teamId: newId(), title: "t", description: bad }).success).toBe(false);
    expect(commentUpdateSchema.safeParse({ body: bad }).success).toBe(false);
  });
});

describe("schemas", () => {
  it("validates task creation", () => {
    const ok = taskCreateSchema.safeParse({ teamId: newId(), title: "  Fix login  ", priority: 2 });
    expect(ok.success && ok.data.title).toBe("Fix login");
    expect(taskCreateSchema.safeParse({ teamId: newId(), title: "" }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ teamId: newId(), title: "x", priority: 9 }).success).toBe(false);
  });

  it("keeps a task's start date on or before its due date", () => {
    const teamId = newId();
    const ok = (start: string | null, due: string | null) =>
      taskCreateSchema.safeParse({ teamId, title: "x", startDate: start, dueDate: due }).success;
    expect(ok("2026-01-01", "2026-01-02")).toBe(true);
    expect(ok("2026-01-02", "2026-01-02")).toBe(true);
    expect(ok("2026-01-03", "2026-01-02")).toBe(false);
    expect(ok("2026-01-03", null)).toBe(true);
    expect(ok("2026-02-30", null)).toBe(false);
    expect(taskUpdateSchema.safeParse({ startDate: "2026-01-03", dueDate: "2026-01-02" }).success).toBe(
      false,
    );
    // One date alone passes the schema (the server checks it against the stored other).
    expect(taskUpdateSchema.safeParse({ startDate: "2026-01-03" }).success).toBe(true);
  });

  it("rejects a task relation to itself", () => {
    const a = newId();
    expect(taskRelationCreateSchema.safeParse({ blockingTaskId: a, blockedTaskId: a }).success).toBe(false);
    expect(taskRelationCreateSchema.safeParse({ blockingTaskId: a, blockedTaskId: newId() }).success).toBe(
      true,
    );
  });

  it("leaves fields out of a partial document update", () => {
    const patch = documentUpdateSchema.parse({ content: d.doc(d.p("hi")) });
    expect(patch).not.toHaveProperty("title");
    expect(documentUpdateSchema.parse({ title: "Plan" }).title).toBe("Plan");
  });
});

describe("reserved workspace slugs", () => {
  it("reserves paths the proxy and the web app own", () => {
    for (const slug of ["api", "mcp", "v1", "login", "setup", "invite", "design", "health", "_next"]) {
      expect(isReservedWorkspaceSlug(slug)).toBe(true);
    }
    expect(isReservedWorkspaceSlug(" API ")).toBe(true);
    expect(isReservedWorkspaceSlug("acme")).toBe(false);
    expect(isReservedWorkspaceSlug("api-team")).toBe(false);
  });

  it("only lists lowercase, URL-safe segments", () => {
    for (const slug of RESERVED_WORKSPACE_SLUGS) expect(slug).toBe(slug.toLowerCase());
  });

  it("suffixes reserved slugs and leaves others alone", () => {
    expect(safeWorkspaceSlug("mcp")).toBe("mcp-workspace");
    expect(safeWorkspaceSlug("acme")).toBe("acme");
    expect(isReservedWorkspaceSlug(safeWorkspaceSlug("api"))).toBe(false);
  });
});

describe("task relations", () => {
  const rel = (blockingTaskId: string, blockedTaskId: string) => ({ blockingTaskId, blockedTaskId });
  const chain = [rel("a", "b"), rel("b", "c"), rel("c", "d")];

  it("detects self-links and direct or transitive cycles", () => {
    expect(wouldCreateBlockingCycle(chain, "a", "a")).toBe(true);
    expect(wouldCreateBlockingCycle(chain, "b", "a")).toBe(true);
    expect(wouldCreateBlockingCycle(chain, "d", "a")).toBe(true);
    expect(wouldCreateBlockingCycle(chain, "d", "b")).toBe(true);
  });

  it("allows links that don't close a loop", () => {
    expect(wouldCreateBlockingCycle(chain, "a", "d")).toBe(false);
    expect(wouldCreateBlockingCycle(chain, "d", "e")).toBe(false);
    expect(wouldCreateBlockingCycle([], "x", "y")).toBe(false);
    // A cycle elsewhere in the graph doesn't hang the search.
    expect(wouldCreateBlockingCycle([rel("p", "q"), rel("q", "p")], "a", "b")).toBe(false);
  });
});
