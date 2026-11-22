import { d, docContentSchema, docToPlainText, emptyDoc, newId, type DocContent } from "@knotworking/core";
import { describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import type { MentionItem } from "@/lib/mentions";
import { MentionSuggestion } from "./mention";
import {
  docSchema,
  filterSlashCommands,
  isEditableContent,
  schemaExtensions,
  toStoredContent,
} from "./extensions";

/** Every block and mark DocRenderer renders, as the seeds and older clients store them. */
const everything: DocContent = d.doc(
  d.h(1, "Title"),
  d.h(2, "Section"),
  d.h(3, "Subsection"),
  d.p(
    "Plain ",
    d.text("bold", "bold"),
    d.text("italic", "italic"),
    d.text("strike", "strike"),
    d.text("code", "code"),
    d.text("mark", "highlight"),
    { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
    { type: "hardBreak" },
    "after break",
  ),
  { type: "paragraph" },
  d.bullets("one", "two"),
  d.numbered("first", "second"),
  d.tasks(["open", false], ["done", true]),
  d.quote("Say less, mean more."),
  d.callout("⚠️", "Submit expenses within 30 days."),
  d.code("ts", "const x = 1;"),
  d.hr(),
);

describe("editor schema", () => {
  it("accepts every stored block and mark", () => {
    expect(isEditableContent(everything)).toBe(true);
    expect(isEditableContent(emptyDoc())).toBe(true);
    expect(isEditableContent(null)).toBe(true);
  });

  it("round-trips stored content without losing anything", () => {
    const json = docSchema.nodeFromJSON(everything).toJSON() as DocContent;
    // The editor adds default attrs (e.g. orderedList `start`) but keeps types, text and values.
    expect(docToPlainText(json)).toBe(docToPlainText(everything));
    expect(json.content.map((n) => n.type)).toEqual(everything.content.map((n) => n.type));
    const callout = json.content.find((n) => n.type === "callout");
    expect(callout?.attrs?.emoji).toBe("⚠️");
    const tasks = json.content.find((n) => n.type === "taskList");
    expect(tasks?.content?.map((i) => i.attrs?.checked)).toEqual([false, true]);
    expect(json.content[0]?.attrs?.level).toBe(1);
    expect(json.content.find((n) => n.type === "codeBlock")?.attrs?.language).toBe("ts");
    // And the API still accepts what the editor produces.
    expect(docContentSchema.safeParse(json).success).toBe(true);
  });

  it("supports tables, in the editor and for the API", () => {
    const table = d.table([
      ["Name", "Status"],
      ["Login", ""],
    ]);
    const doc = d.doc(d.p("Before"), table, d.p("After"));
    expect(isEditableContent(doc)).toBe(true);
    const json = docSchema.nodeFromJSON(doc).toJSON() as DocContent;
    expect(json.content.map((n) => n.type)).toEqual(["paragraph", "table", "paragraph"]);
    const rows = json.content[1]!.content!;
    expect(rows.map((r) => r.content!.map((c) => c.type))).toEqual([
      ["tableHeader", "tableHeader"],
      ["tableCell", "tableCell"],
    ]);
    // Header row, spans and empty cells survive; the API accepts what the editor produces.
    expect(docToPlainText(json)).toBe(docToPlainText(doc));
    expect(docContentSchema.safeParse(json).success).toBe(true);
    // Spans and merged cells are valid editor content too.
    const merged = d.doc({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [{ type: "tableCell", attrs: { colspan: 2 }, content: [d.p("wide")] }],
        },
      ],
    });
    expect(isEditableContent(merged)).toBe(true);
  });

  it("falls back to read-only for tables the schema can't hold", () => {
    expect(isEditableContent(d.doc({ type: "table", content: [] }))).toBe(false);
    // Rows must hold cells; cells need a block.
    expect(isEditableContent(d.doc({ type: "table", content: [d.p("x")] }))).toBe(false);
    expect(
      isEditableContent(
        d.doc({
          type: "table",
          content: [{ type: "tableRow", content: [{ type: "tableCell", content: [] }] }],
        }),
      ),
    ).toBe(false);
  });

  it("refuses to edit content it can't represent", () => {
    expect(isEditableContent(d.doc({ type: "futureBlock", content: [d.p("x")] }))).toBe(false);
    expect(
      isEditableContent(d.doc(d.p({ type: "text", text: "u", marks: [{ type: "underline" as "bold" }] }))),
    ).toBe(false);
  });
});

describe("mentions", () => {
  const [user, task, doc] = [newId(), newId(), newId()];
  const mentions = d.doc(
    d.p(
      "cc ",
      d.mention("user", user, "Ada"),
      " re ",
      d.mention("task", task, "Fix login"),
      " and ",
      d.mention("doc", doc, "Runbook"),
    ),
    d.bullets("item"),
    d.table([["a", "b"]]),
  );

  it("are editor content, kept intact through the editor schema, and accepted by the API", () => {
    expect(isEditableContent(mentions)).toBe(true);
    const json = docSchema.nodeFromJSON(mentions).toJSON() as DocContent;
    expect(json.content[0]!.content!.filter((n) => n.type === "mention").map((n) => n.attrs)).toEqual([
      { kind: "user", id: user, label: "Ada" },
      { kind: "task", id: task, label: "Fix login" },
      { kind: "doc", id: doc, label: "Runbook" },
    ]);
    expect(docToPlainText(json)).toBe(docToPlainText(mentions));
    expect(docToPlainText(json)).toContain("cc @Ada re #Fix login and [[Runbook]]");
    expect(docContentSchema.safeParse(json).success).toBe(true);
  });

  it("round-trip through a live editor, in a paragraph, a list item and a table cell", () => {
    const withNested = d.doc(
      d.p("see ", d.mention("user", user, "Ada")),
      {
        type: "bulletList",
        content: [{ type: "listItem", content: [d.p(d.mention("task", task, "Fix login"))] }],
      },
      d.table([["x", ""]]),
    );
    const editor = new Editor({ extensions: schemaExtensions(), content: withNested });
    const out = toStoredContent(editor.getJSON());
    expect(JSON.stringify(out)).toContain(`"kind":"user","id":"${user}","label":"Ada"`);
    expect(JSON.stringify(out)).toContain(`"kind":"task","id":"${task}","label":"Fix login"`);
    expect(docContentSchema.safeParse(out).success).toBe(true);
    // Copying a chip as text gives what MCP readers see; as HTML it carries its data attributes.
    expect(editor.getText()).toContain("see @Ada");
    expect(editor.getHTML()).toContain(`data-id="${user}"`);
    editor.destroy();
  });

  it("parse back from their HTML (paste and drag)", () => {
    const editor = new Editor({
      extensions: schemaExtensions(),
      content: `<p>hi <span data-mention data-kind="doc" data-id="${doc}" data-label="Runbook">[[Runbook]]</span></p>`,
    });
    const node = (editor.getJSON().content![0]!.content as DocContent["content"]).find(
      (n) => n.type === "mention",
    );
    expect(node?.attrs).toEqual({ kind: "doc", id: doc, label: "Runbook" });
    editor.destroy();
  });

  it("still send unknown nodes (or malformed mentions) to the read-only fallback", () => {
    expect(isEditableContent(d.doc(d.p(d.mention("user", user, "Ada")), { type: "futureBlock" }))).toBe(
      false,
    );
    expect(
      isEditableContent(d.doc(d.p({ type: "mention", attrs: { kind: "user" }, content: [d.text("x")] }))),
    ).toBe(false);
  });

  it("are inserted by picking from the @ menu, replacing the typed query", async () => {
    const items: MentionItem[] = [
      { kind: "user", id: user, label: "Ada Park" },
      { kind: "task", id: task, label: "Fix login", hint: "ENG" },
    ];
    const queries: string[] = [];
    const started: MentionItem[][] = [];
    let pick: (item: MentionItem) => void = () => {};
    const editor = new Editor({
      extensions: [
        ...schemaExtensions(),
        MentionSuggestion.configure({
          getItems: (query) => (queries.push(query), items),
          render: () => ({
            onStart: (props) => (started.push(props.items), (pick = props.command)),
            onUpdate: (props) => (started.push(props.items), (pick = props.command)),
            onKeyDown: () => false,
            onExit: () => {},
          }),
        }),
      ],
      content: d.doc(d.p("ping ")),
    });
    editor.commands.focus("end");
    editor.view.dispatch(editor.state.tr.insertText("@ad"));
    await vi.waitFor(() => expect(started.at(-1)).toEqual(items));
    expect(queries.at(-1)).toBe("ad");

    // Picking replaces "@ad" with the chip and a space, so typing carries on after it.
    pick(items[0]!);
    const stored = toStoredContent(editor.getJSON());
    expect(stored.content[0]!.content).toEqual([
      { type: "text", text: "ping " },
      { type: "mention", attrs: { kind: "user", id: user, label: "Ada Park" } },
      { type: "text", text: " " },
    ]);
    expect(docContentSchema.safeParse(stored).success).toBe(true);
    editor.destroy();
  });

  it("don't open the menu in the middle of a word (an email address)", async () => {
    const queries: string[] = [];
    const editor = new Editor({
      extensions: [
        ...schemaExtensions(),
        MentionSuggestion.configure({
          getItems: (query) => (queries.push(query), []),
          render: () => ({ onStart: () => {}, onUpdate: () => {}, onKeyDown: () => false, onExit: () => {} }),
        }),
      ],
      content: d.doc(d.p("mail ")),
    });
    editor.commands.focus("end");
    editor.view.dispatch(editor.state.tr.insertText("me@example.com"));
    await new Promise((r) => setTimeout(r, 20));
    expect(queries).toEqual([]);
    editor.destroy();
  });
});

describe("toStoredContent", () => {
  it("stores a blank editor as an empty doc", () => {
    expect(toStoredContent({ type: "doc", content: [{ type: "paragraph" }] })).toEqual(emptyDoc());
    expect(toStoredContent({ type: "doc", content: [{ type: "paragraph" }, { type: "paragraph" }] })).toEqual(
      emptyDoc(),
    );
  });

  it("keeps real content", () => {
    const doc = d.doc(d.p("hi"));
    expect(toStoredContent(doc)).toEqual(doc);
  });
});

describe("slash commands", () => {
  it("filters by title and keyword", () => {
    expect(filterSlashCommands("").length).toBeGreaterThan(5);
    expect(filterSlashCommands("h2").map((i) => i.title)).toEqual(["Heading 2"]);
    expect(filterSlashCommands("todo").map((i) => i.title)).toEqual(["To-do list"]);
    expect(filterSlashCommands("zzz")).toEqual([]);
  });

  it("offers a table", () => {
    expect(filterSlashCommands("table").map((i) => i.title)).toEqual(["Table"]);
    expect(filterSlashCommands("grid").map((i) => i.title)).toEqual(["Table"]);
  });

  it("inserts a 3x3 table with a header row, and Tab moves between cells", () => {
    const editor = new Editor({ extensions: [...schemaExtensions()], content: "<p>/table</p>" });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const range = { from: 1, to: editor.state.doc.content.size - 1 };
    filterSlashCommands("table")[0]!.run(editor, range);
    const json = toStoredContent(editor.getJSON());
    const table = json.content.find((n) => n.type === "table")!;
    expect(table.content).toHaveLength(3);
    expect(table.content!.map((r) => r.content!.length)).toEqual([3, 3, 3]);
    expect(table.content![0]!.content!.every((c) => c.type === "tableHeader")).toBe(true);
    expect(table.content![1]!.content!.every((c) => c.type === "tableCell")).toBe(true);
    expect(json.content.some((n) => n.type === "paragraph" && docToPlainText(n).includes("/table"))).toBe(
      false,
    );
    expect(docContentSchema.safeParse(json).success).toBe(true);

    // The cursor starts in the first cell; next/previous cell commands (bound to Tab / Shift-Tab) move it.
    const cellStart = () => editor.state.selection.$from.start();
    const first = cellStart();
    expect(editor.commands.goToNextCell()).toBe(true);
    expect(cellStart()).toBeGreaterThan(first);
    expect(editor.commands.goToPreviousCell()).toBe(true);
    expect(cellStart()).toBe(first);
    editor.destroy();
  });
});
