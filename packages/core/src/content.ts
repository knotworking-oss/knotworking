import { z } from "zod";

/**
 * Rich text is stored as a portable block tree (ProseMirror/Tiptap-compatible
 * JSON) rather than HTML or Markdown, so every client can render it natively
 * and future collaborative editing (CRDT) can map onto the same structure.
 */
export interface DocMark {
  type: "bold" | "italic" | "strike" | "code" | "link" | "highlight";
  attrs?: Record<string, unknown>;
}

export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
  marks?: DocMark[];
}

export interface DocContent {
  type: "doc";
  content: DocNode[];
}

/**
 * Attributes of an `image` block: an uploaded attachment (see `./attachments`), never a remote
 * URL, so images stay behind the workspace's access checks. Clients resolve `attachmentId` with
 * `attachmentContentPath`.
 */
export interface DocImageAttrs {
  attachmentId: string;
  /** Shown in plain-text projections and as a fallback label. */
  filename?: string;
  alt?: string;
}

/** What an inline `mention` node can point at. */
export const mentionKinds = ["user", "task", "doc"] as const;
export type MentionKind = (typeof mentionKinds)[number];

/**
 * An inline `@`-mention (`attrs: { kind, id, label }`). `id` is what counts; `label` is only a cache of
 * the name or title at the time of writing, so clients resolve it live and show "unavailable" if the
 * target is gone.
 */
export interface MentionAttrs {
  kind: MentionKind;
  id: string;
  label: string;
}

/** `GET …/documents/:id/backlinks` and `GET …/tasks/:id/backlinks`: what mentions this document or task. */
export interface BacklinksResponse {
  documents: { id: string; title: string; icon: string | null; updatedAt: string }[];
  tasks: { id: string; title: string; teamId: string; stateId: string; updatedAt: string }[];
}

/** Bound recursion in the parser itself, before the structural refinement runs. */
const MAX_DEPTH = 24;
const docNodeAtDepth = (depth: number): z.ZodType<DocNode> =>
  z.lazy(() =>
    z.object({
      type: z.string().min(1),
      attrs: z.record(z.string(), z.unknown()).optional(),
      content: z.array(depth < MAX_DEPTH ? docNodeAtDepth(depth + 1) : z.never()).optional(),
      text: z.string().optional(),
      marks: z
        .array(
          z.object({
            type: z.enum(["bold", "italic", "strike", "code", "link", "highlight"]),
            attrs: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .optional(),
    }),
  );
const docNode = docNodeAtDepth(1);

/** Most rows and columns a stored table may have (a sanity bound, well above what the editor offers). */
export const MAX_TABLE_ROWS = 200;
export const MAX_TABLE_COLUMNS = 50;
/** Most mentions one body may hold (a sanity bound: each one is a link, and people get notified). */
export const MAX_MENTIONS = 500;
const mentionAttrsSchema = z.object({
  kind: z.enum(mentionKinds),
  id: z.uuid(),
  label: z.string().max(512),
});

const CELL_TYPES = new Set(["tableCell", "tableHeader"]);
const validSpan = (value: unknown) =>
  value === undefined ||
  value === null ||
  (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_TABLE_COLUMNS);

/**
 * Structural checks the generic node schema can't express: tables are `table > tableRow > (tableCell |
 * tableHeader) > blocks`, with sane span attributes and bounded size. Other node types stay open-ended
 * (unknown blocks round-trip, and the editor falls back to read-only for them).
 */
function checkNode(node: DocNode, depth: number, report: (message: string) => void): void {
  if (depth > MAX_DEPTH) return report(`Content is nested more than ${MAX_DEPTH} levels deep`);
  const children = node.content ?? [];
  if (node.type === "mention") {
    if (!mentionAttrsSchema.safeParse(node.attrs).success)
      report("A mention needs a kind (user, task or doc), an id (UUID) and a label");
    if (children.length || node.text !== undefined) report("A mention can't have content");
  } else if (node.type === "table") {
    if (!children.length || children.length > MAX_TABLE_ROWS)
      report(`A table needs between 1 and ${MAX_TABLE_ROWS} rows`);
    if (children.some((row) => row.type !== "tableRow")) report("A table can only contain table rows");
  } else if (node.type === "tableRow") {
    if (!children.length || children.length > MAX_TABLE_COLUMNS)
      report(`A table row needs between 1 and ${MAX_TABLE_COLUMNS} cells`);
    if (children.some((cell) => !CELL_TYPES.has(cell.type)))
      report("A table row can only contain table cells");
  } else if (CELL_TYPES.has(node.type)) {
    if (!children.length) report("A table cell can't be empty (it needs at least one block)");
    if (!validSpan(node.attrs?.colspan) || !validSpan(node.attrs?.rowspan))
      report(`Table cell colspan and rowspan must be whole numbers from 1 to ${MAX_TABLE_COLUMNS}`);
  }
  for (const child of children) checkNode(child, depth + 1, report);
}

export const docContentSchema = z
  .object({
    type: z.literal("doc"),
    content: z.array(docNode),
  })
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    const report = (message: string) => {
      if (seen.has(message)) return;
      seen.add(message);
      ctx.addIssue({ code: "custom", message });
    };
    for (const node of doc.content) checkNode(node, 1, report);
    if (countMentions(doc) > MAX_MENTIONS) report(`A body can hold at most ${MAX_MENTIONS} mentions`);
  });

/** Every mention node in a body, in document order (duplicates included). Tolerates malformed input. */
function mentionNodes(node: DocContent | DocNode | null | undefined, out: MentionAttrs[] = [], depth = 0) {
  if (!node || depth > MAX_DEPTH + 1) return out;
  if (node.type === "mention") {
    const parsed = mentionAttrsSchema.safeParse(node.attrs);
    if (parsed.success) out.push(parsed.data);
    return out;
  }
  for (const child of node.content ?? []) mentionNodes(child, out, depth + 1);
  return out;
}

const countMentions = (doc: DocContent) => mentionNodes(doc).length;

/** The distinct things a body mentions (one entry per kind and id), for diffing, notifications and links. */
export function extractMentions(content: DocContent | DocNode | null | undefined): MentionAttrs[] {
  const seen = new Map<string, MentionAttrs>();
  for (const m of mentionNodes(content)) {
    const key = `${m.kind}:${m.id}`;
    if (!seen.has(key)) seen.set(key, m);
  }
  return [...seen.values()];
}

/** Mentions in `after` that `before` didn't have: what a save newly adds. */
export function addedMentions(
  before: DocContent | null | undefined,
  after: DocContent | null | undefined,
): MentionAttrs[] {
  const had = new Set(extractMentions(before).map((m) => `${m.kind}:${m.id}`));
  return extractMentions(after).filter((m) => !had.has(`${m.kind}:${m.id}`));
}

/** How a mention reads as plain text: `@Ada`, `[[Doc title]]`, `#Task title`. */
export function mentionToPlainText(attrs: Record<string, unknown> | undefined): string {
  const label = typeof attrs?.label === "string" && attrs.label ? attrs.label : "unknown";
  switch (attrs?.kind) {
    case "user":
      return `@${label}`;
    case "doc":
      return `[[${label}]]`;
    case "task":
      return `#${label}`;
    default:
      return label;
  }
}

/** The distinct attachment ids of the images in a body (for checking they belong to the record). */
export function extractImageIds(content: DocContent | DocNode | null | undefined): string[] {
  const ids = new Set<string>();
  const walk = (node: DocNode | undefined) => {
    if (!node) return;
    if (node.type === "image" && typeof node.attrs?.attachmentId === "string") {
      ids.add(node.attrs.attachmentId.toLowerCase());
    }
    node.content?.forEach(walk);
  };
  walk(content ?? undefined);
  return [...ids];
}

export const emptyDoc = (): DocContent => ({ type: "doc", content: [] });

/** Plain text (one paragraph per line) → block content. Blank input gives an empty doc. */
export function textToDoc(text: string): DocContent {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\s+$/g, "")
    .split("\n");
  if (lines.length === 1 && lines[0] === "") return emptyDoc();
  return {
    type: "doc",
    content: lines.map((line) =>
      line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" },
    ),
  };
}

/** Plain-text projection — used for search indexing, previews and notifications. */
export function docToPlainText(node: DocContent | DocNode | null | undefined): string {
  if (!node) return "";
  if ("text" in node && typeof node.text === "string") return node.text;
  if (node.type === "mention") return mentionToPlainText(node.attrs);
  // Tables read as one line per row, cells separated by " | " (no markup, so output stays compact).
  if (node.type === "table") return (node.content ?? []).map(rowToPlainText).join("");
  if (node.type === "image") {
    const attrs = (node.attrs ?? {}) as Partial<DocImageAttrs>;
    const label = String(attrs.filename || attrs.alt || "image").replace(/[\]\r\n]+/g, " ");
    return `[image: ${label}]\n`;
  }
  const inner = (node.content ?? []).map(docToPlainText).join("");
  // Textblocks end a line; containers (lists, quotes, callouts) just concatenate children.
  return TEXTBLOCKS.has(node.type) ? `${inner}\n` : inner;
}
const TEXTBLOCKS = new Set(["paragraph", "heading", "codeBlock"]);

function rowToPlainText(row: DocNode): string {
  // A cell holds blocks; their lines are joined with spaces so a row stays on one line.
  const cells = (row.content ?? []).map((cell) =>
    docToPlainText(cell)
      .trim()
      .replace(/\s*\n\s*/g, " "),
  );
  return `${cells.join(" | ")}\n`;
}

/** Convenience builders for seeds and tests. */
export const d = {
  doc: (...content: DocNode[]): DocContent => ({ type: "doc", content }),
  p: (...content: (DocNode | string)[]): DocNode => ({ type: "paragraph", content: content.map(toNode) }),
  h: (level: 1 | 2 | 3, text: string): DocNode => ({
    type: "heading",
    attrs: { level },
    content: [{ type: "text", text }],
  }),
  text: (text: string, ...marks: DocMark["type"][]): DocNode => ({
    type: "text",
    text,
    ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
  }),
  bullets: (...items: string[]): DocNode => ({
    type: "bulletList",
    content: items.map((i) => ({ type: "listItem", content: [d.p(i)] })),
  }),
  numbered: (...items: string[]): DocNode => ({
    type: "orderedList",
    content: items.map((i) => ({ type: "listItem", content: [d.p(i)] })),
  }),
  tasks: (...items: [string, boolean][]): DocNode => ({
    type: "taskList",
    content: items.map(([text, checked]) => ({ type: "taskItem", attrs: { checked }, content: [d.p(text)] })),
  }),
  callout: (emoji: string, text: string): DocNode => ({
    type: "callout",
    attrs: { emoji },
    content: [d.p(text)],
  }),
  quote: (text: string): DocNode => ({ type: "blockquote", content: [d.p(text)] }),
  code: (language: string, text: string): DocNode => ({
    type: "codeBlock",
    attrs: { language },
    content: [{ type: "text", text }],
  }),
  hr: (): DocNode => ({ type: "horizontalRule" }),
  /** An inline mention of a user, task or doc (`label` is the cached name or title). */
  mention: (kind: MentionKind, id: string, label: string): DocNode => ({
    type: "mention",
    attrs: { kind, id, label },
  }),
  /** A table from rows of cell text; `header` makes the first row header cells. */
  table: (rows: string[][], { header = true }: { header?: boolean } = {}): DocNode => ({
    type: "table",
    content: rows.map((cells, r) => ({
      type: "tableRow",
      content: cells.map((text) => ({
        type: header && r === 0 ? "tableHeader" : "tableCell",
        content: [text ? d.p(text) : d.p()],
      })),
    })),
  }),
  image: (attachmentId: string, filename?: string): DocNode => ({
    type: "image",
    attrs: { attachmentId, ...(filename ? { filename } : {}) },
  }),
};

function toNode(n: DocNode | string): DocNode {
  return typeof n === "string" ? { type: "text", text: n } : n;
}
