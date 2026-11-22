import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, safeHref } from "./assistant-markdown";

describe("assistant markdown", () => {
  it("parses paragraphs, headings, lists and code", () => {
    expect(
      parseMarkdown(
        "## Due\n\nTwo tasks:\n- **Fix** oven\n- Order `flour`\n\n1. one\n2. two\n\n```sh\nls\n```",
      ),
    ).toEqual([
      { type: "heading", level: 2, children: [{ type: "text", text: "Due" }] },
      { type: "paragraph", children: [{ type: "text", text: "Two tasks:" }] },
      {
        type: "list",
        ordered: false,
        items: [
          [
            { type: "strong", children: [{ type: "text", text: "Fix" }] },
            { type: "text", text: " oven" },
          ],
          [
            { type: "text", text: "Order " },
            { type: "code", text: "flour" },
          ],
        ],
      },
      {
        type: "list",
        ordered: true,
        items: [[{ type: "text", text: "one" }], [{ type: "text", text: "two" }]],
      },
      { type: "code", lang: "sh", text: "ls" },
    ]);
  });

  it("only links safe targets", () => {
    expect(parseInline("[task](/acme/task/1)")).toEqual([
      { type: "link", href: "/acme/task/1", children: [{ type: "text", text: "task" }] },
    ]);
    expect(parseInline("[x](javascript:alert(1))")[0]).toMatchObject({ type: "text" });
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
  });

  it("keeps an unterminated code fence as code", () => {
    expect(parseMarkdown("```\nstreaming")).toEqual([{ type: "code", lang: "", text: "streaming" }]);
  });
});
