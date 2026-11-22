import { emptyDoc, type DocContent } from "@knotworking/core";
import { Extension, getSchema, mergeAttributes, Node, type AnyExtension, type Range } from "@tiptap/core";
import { Heading } from "@tiptap/extension-heading";
import { Highlight } from "@tiptap/extension-highlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import type { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Suggestion, type SuggestionOptions } from "@tiptap/suggestion";
import { canAddImages, DocImage, pickImages } from "./image";
import { Mention } from "./mention";

/**
 * The editor's schema is the stored block tree from `@knotworking/core`
 * (`DocContent`), so documents saved by DocRenderer-era seeds and by the editor
 * are the same JSON. Node and mark names match what `DocRenderer` renders, and
 * the classes mirror its styles so editing and reading look alike.
 *
 * This module has no React imports, so the schema can be checked in tests.
 */

const headingStyles: Record<number, string> = {
  1: "mt-8 mb-1 text-3xl font-bold tracking-tight first:mt-0",
  2: "mt-6 mb-0.5 text-2xl font-semibold tracking-tight first:mt-0",
  3: "mt-4 text-base font-semibold first:mt-0",
};

/** Level 1–3, rendered one level down (h2–h4) like DocRenderer: the page title is the h1. */
const DocHeading = Heading.extend({
  renderHTML({ node, HTMLAttributes }) {
    const level = Math.min(Math.max(Number(node.attrs.level) || 2, 1), 3);
    return [
      `h${level + 1}`,
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: headingStyles[level] }),
      0,
    ];
  },
}).configure({ levels: [1, 2, 3] });

/** A tinted box with an emoji, as stored by `d.callout` (`attrs.emoji`). */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      emoji: {
        default: "💡",
        parseHTML: (el) => el.getAttribute("data-emoji") || "💡",
        renderHTML: (attrs) => ({ "data-emoji": attrs.emoji }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-callout]", contentElement: "[data-callout-content]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-callout": "",
        class: "my-1 flex gap-3 rounded-md bg-muted px-4 py-3",
      }),
      [
        "span",
        { contenteditable: "false", "aria-hidden": "true", class: "text-xl leading-7 select-none" },
        String(node.attrs.emoji ?? "💡"),
      ],
      ["div", { "data-callout-content": "", class: "min-w-0 flex-1" }, 0],
    ];
  },
});

/** Keep in sync with the table classes in DocRenderer (not imported there, to keep Tiptap out of its bundle). */
const tableClasses = {
  table: "w-full border-collapse text-sm",
  cell: "min-w-20 border border-border px-3 py-1.5 align-top",
  header: "min-w-20 border border-border bg-muted px-3 py-1.5 text-left align-top font-semibold",
};

/**
 * Tables (`table > tableRow > tableHeader | tableCell`), styled like DocRenderer. Not resizable: column
 * widths follow the content, and the wrapper scrolls sideways on narrow screens. Tab / Shift-Tab move
 * between cells (Tab in the last cell adds a row).
 */
export const tableExtensions: AnyExtension[] = [
  Table.configure({
    renderWrapper: true,
    cellMinWidth: 80,
    HTMLAttributes: { class: tableClasses.table },
  }),
  TableRow,
  TableHeader.configure({ HTMLAttributes: { class: tableClasses.header } }),
  TableCell.configure({ HTMLAttributes: { class: tableClasses.cell } }),
];

/** Every node and mark the stored format supports. Placeholder and slash commands add no schema. */
export function schemaExtensions({
  taskItem = TaskItem,
  image = DocImage,
  mention = Mention,
}: { taskItem?: AnyExtension; image?: AnyExtension; mention?: AnyExtension } = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: false,
      // Not part of the stored format (`DocMark`), so the API would reject it.
      underline: false,
      paragraph: { HTMLAttributes: { class: "min-h-[1lh] py-0.5" } },
      bold: { HTMLAttributes: { class: "font-semibold" } },
      bulletList: { HTMLAttributes: { class: "list-disc pl-6 marker:text-muted-foreground" } },
      orderedList: { HTMLAttributes: { class: "list-decimal pl-6 marker:text-muted-foreground" } },
      listItem: { HTMLAttributes: { class: "pl-1" } },
      blockquote: {
        HTMLAttributes: { class: "my-1 border-l-2 border-border pl-4 text-muted-foreground italic" },
      },
      codeBlock: {
        HTMLAttributes: { class: "my-1 overflow-x-auto rounded-md bg-muted p-4 font-mono text-sm leading-6" },
      },
      code: {
        HTMLAttributes: {
          class: "rounded-xs bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground",
        },
      },
      horizontalRule: { HTMLAttributes: { class: "my-4 border-border" } },
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        HTMLAttributes: {
          class: "underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground",
          rel: "noopener noreferrer nofollow",
          target: null,
        },
      },
    }),
    DocHeading,
    Highlight.configure({ HTMLAttributes: { class: "rounded-xs bg-label-yellow-bg px-0.5 text-inherit" } }),
    TaskList.configure({ HTMLAttributes: { class: "flex flex-col" } }),
    taskItem.configure({ nested: true }),
    Callout,
    mention,
    ...tableExtensions,
    image,
  ];
}

/** ProseMirror schema of the stored format, for validating content before it is edited. */
export const docSchema = getSchema(schemaExtensions());

/**
 * Whether stored content fits the editor's schema. Content that doesn't (a block
 * type this version doesn't know) is shown read-only instead, so saving can never
 * drop it.
 */
export function isEditableContent(content: DocContent | null | undefined): boolean {
  if (!content?.content.length) return true;
  try {
    docSchema.nodeFromJSON(content).check();
    return true;
  } catch {
    return false;
  }
}

/** Editor JSON → stored content. A blank editor is stored as an empty doc. */
export function toStoredContent(json: { type?: string; content?: unknown[] }): DocContent {
  const content = (json.content ?? []) as DocContent["content"];
  const blank = content.every((n) => n.type === "paragraph" && !n.content?.length);
  return blank ? emptyDoc() : { type: "doc", content };
}

// ─── Slash commands ──────────────────────────────────────────────────────────

export interface SlashCommandItem {
  title: string;
  description: string;
  /** Extra words to match, e.g. "h1" or "todo". */
  keywords: string[];
  run: (editor: Editor, range: Range) => void;
  /** Hidden when this returns false (e.g. "Image" without an upload target). */
  available?: (editor: Editor) => boolean;
}

export const slashCommandItems: SlashCommandItem[] = [
  {
    title: "Text",
    description: "Plain paragraph",
    keywords: ["paragraph", "p"],
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
  },
  ...([1, 2, 3] as const).map((level): SlashCommandItem => ({
    title: `Heading ${level}`,
    description: ["Large section heading", "Medium section heading", "Small section heading"][level - 1]!,
    keywords: [`h${level}`, "title"],
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level }).run(),
  })),
  {
    title: "Bulleted list",
    description: "A simple list",
    keywords: ["ul", "unordered", "bullet"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    description: "A list with numbers",
    keywords: ["ol", "ordered"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    title: "To-do list",
    description: "Track items with checkboxes",
    keywords: ["todo", "task", "checkbox", "check"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    title: "Quote",
    description: "Capture a quotation",
    keywords: ["blockquote"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    title: "Callout",
    description: "Make a note stand out",
    keywords: ["note", "info", "tip"],
    run: (e, r) => e.chain().focus().deleteRange(r).wrapIn("callout", { emoji: "💡" }).run(),
  },
  {
    title: "Code block",
    description: "Monospaced code",
    keywords: ["pre", "snippet"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    title: "Table",
    description: "Rows and columns (3 × 3)",
    keywords: ["grid", "rows", "columns", "spreadsheet"],
    run: (e, r) =>
      e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    title: "Divider",
    description: "A horizontal line",
    keywords: ["hr", "rule", "separator"],
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
  {
    title: "Image",
    description: "Upload a picture",
    keywords: ["img", "picture", "photo", "upload"],
    available: canAddImages,
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      pickImages(e);
    },
  },
];

export function filterSlashCommands(query: string): SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return slashCommandItems;
  return slashCommandItems.filter(
    (i) => i.title.toLowerCase().includes(q) || i.keywords.some((k) => k.startsWith(q)),
  );
}

type SlashRender = NonNullable<SuggestionOptions<SlashCommandItem, SlashCommandItem>["render"]>;

/** Type `/` to open the block menu. Rendering is supplied by the React editor. */
export const SlashCommand = Extension.create<{ render: SlashRender | null }>({
  name: "slashCommand",
  addOptions: () => ({ render: null }),
  addProseMirrorPlugins() {
    const { render } = this.options;
    if (!render) return [];
    return [
      Suggestion<SlashCommandItem, SlashCommandItem>({
        editor: this.editor,
        char: "/",
        items: ({ query, editor }) => filterSlashCommands(query).filter((i) => i.available?.(editor) ?? true),
        command: ({ editor, range, props }) => props.run(editor, range),
        // Not inside code blocks, where "/" is just a character.
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        render,
      }),
    ];
  },
});

export { Placeholder };
