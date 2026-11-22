import { describe, expect, it } from "vitest";
import { docContentSchema, type DocNode } from "./content";

describe("rich text parser limits", () => {
  it("rejects deeply nested content before recursive validation can exhaust the stack", () => {
    let node: DocNode = { type: "paragraph" };
    for (let depth = 0; depth < 2000; depth++) node = { type: "blockquote", content: [node] };
    expect(docContentSchema.safeParse({ type: "doc", content: [node] }).success).toBe(false);
  });

  it("accepts normal nested rich text", () => {
    expect(
      docContentSchema.safeParse({
        type: "doc",
        content: [
          {
            type: "blockquote",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
          },
        ],
      }).success,
    ).toBe(true);
  });
});
