"use client";

import type { DocContent } from "@knotworking/core";
import { Alert, AlertDescription } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { Toggle } from "@knotworking/ui/components/toggle";
import { cn } from "@knotworking/ui/lib/utils";
import { TaskItem } from "@tiptap/extension-list";
import { NodeSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import {
  EditorContent,
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
  type ChainedCommands,
  type Editor,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Bold,
  Check,
  Code,
  Highlighter,
  Italic,
  Link2,
  PanelTop,
  Strikethrough,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { filterMentionItems, type MentionItem } from "@/lib/mentions";
import { useOptionalWorkspace } from "@/lib/workspace-store";
import { DocRenderer } from "../doc-renderer";
import { MentionMenu, type MentionMenuHandle } from "./mention-menu";
import { MentionSuggestion } from "./mention";
import { MentionWithView } from "./mention-view";
import {
  isEditableContent,
  Placeholder,
  schemaExtensions,
  SlashCommand,
  toStoredContent,
  type SlashCommandItem,
} from "./extensions";
import { SlashMenu, type SlashMenuHandle } from "./slash-menu";
import { useImageExtension, type ImageUploadTarget } from "./use-image-extension";

const editorClass = cn(
  "flex flex-col gap-1.5 outline-none",
  // Placeholder on the empty block under the cursor (or the empty doc).
  "[&_.is-empty]:before:pointer-events-none [&_.is-empty]:before:float-left [&_.is-empty]:before:h-0 [&_.is-empty]:before:text-muted-foreground/70 [&_.is-empty]:before:content-[attr(data-placeholder)]",
  "[&_.ProseMirror-selectednode]:rounded-sm [&_.ProseMirror-selectednode]:ring-2 [&_.ProseMirror-selectednode]:ring-ring/50",
  // Tables scroll sideways inside their wrapper; selected cells (drag across cells) are tinted.
  "[&_.tableWrapper]:my-1 [&_.tableWrapper]:max-w-full [&_.tableWrapper]:overflow-x-auto",
  "[&_.selectedCell]:bg-primary/15",
);

/**
 * Rich-text editor over the stored block JSON (`DocContent`). Uncontrolled:
 * `content` is the initial value (remount with a `key` to load another doc), and
 * `onChange` receives the stored form after every edit — pair it with
 * `useAutosave`.
 *
 * Supports what DocRenderer renders: paragraphs, headings 1–3, bulleted,
 * numbered and to-do lists, quotes, callouts, code blocks, dividers, tables and
 * bold/italic/strike/code/highlight/link. Markdown shortcuts work (`# `, `- `,
 * `[ ] `, `> `, ```` ``` ````), `/` opens the block menu, `@` mentions a person, task
 * or page, selecting text
 * shows the formatting toolbar and being in a table shows the table toolbar
 * (Tab / Shift-Tab move between cells).
 */
export function DocEditor({
  content,
  onChange,
  editable = true,
  placeholder = "Type '/' for commands…",
  className,
  emptyText,
  autofocus = false,
  onReady,
  images,
}: {
  /** Where pasted, dropped or picked images are attached. Without it, images can't be added. */
  images?: ImageUploadTarget;
  content: DocContent | null | undefined;
  onChange?: (content: DocContent) => void;
  editable?: boolean;
  placeholder?: string;
  className?: string;
  /** Shown when read-only and empty. */
  emptyText?: string;
  autofocus?: boolean;
  /** Receives the editor once it exists, e.g. to focus it from a title field. */
  onReady?: (editor: Editor) => void;
}) {
  // Content this editor version can't represent stays read-only, so saving never drops blocks.
  const [supported] = useState(() => isEditableContent(content));
  const canEdit = editable && supported;
  const slash = useRef<SlashMenuHandle>(null);
  const [slashProps, setSlashProps] = useState<SuggestionProps<SlashCommandItem, SlashCommandItem> | null>(
    null,
  );
  // `@` mentions: the picker searches the live workspace store (nothing when there is no workspace).
  const workspace = useOptionalWorkspace();
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const mentionMenu = useRef<MentionMenuHandle>(null);
  const [mentionProps, setMentionProps] = useState<SuggestionProps<MentionItem, MentionItem> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const image = useImageExtension(canEdit ? images : undefined);

  const extensions = useMemo(
    () => [
      ...schemaExtensions({ taskItem: TaskItemWithCheckbox, image, mention: MentionWithView }),
      // On the empty doc, or on the empty line being typed in.
      Placeholder.configure({
        placeholder: ({ editor }) => (editor.isEmpty || editor.isFocused ? placeholder : ""),
      }),
      MentionSuggestion.configure({
        getItems: (query) =>
          workspaceRef.current ? filterMentionItems(workspaceRef.current.idx, query) : [],
        render: () => ({
          onStart: (props) => setMentionProps(props),
          onUpdate: (props) => setMentionProps(props),
          onExit: () => setMentionProps(null),
          onKeyDown: (props: SuggestionKeyDownProps) => mentionMenu.current?.onKeyDown(props.event) ?? false,
        }),
      }),
      SlashCommand.configure({
        render: () => ({
          onStart: (props) => setSlashProps(props),
          onUpdate: (props) => setSlashProps(props),
          onExit: () => setSlashProps(null),
          onKeyDown: (props: SuggestionKeyDownProps) => slash.current?.onKeyDown(props.event) ?? false,
        }),
      }),
    ],
    // The editor is created once; later placeholder changes don't apply.
    [],
  );

  const editor = useEditor(
    {
      extensions,
      content: content?.content.length ? content : null,
      editable: canEdit,
      // Next.js renders on the server first; DocRenderer stands in until the editor mounts.
      immediatelyRender: false,
      autofocus: autofocus && canEdit ? "end" : false,
      editorProps: { attributes: { class: editorClass, "aria-label": "Document content" } },
      onCreate: ({ editor }) => onReadyRef.current?.(editor),
      onUpdate: ({ editor }) => onChangeRef.current?.(toStoredContent(editor.getJSON())),
    },
    [],
  );

  const body = (
    <div className={cn("text-[15px] leading-7", className)}>
      {!canEdit || !editor ? (
        <DocRenderer content={content} emptyText={canEdit ? placeholder : emptyText} />
      ) : (
        <>
          <EditorContent editor={editor} />
          <FormatMenu editor={editor} />
          <TableMenu editor={editor} />
          {slashProps && <SlashMenu ref={slash} {...slashProps} />}
          {mentionProps && <MentionMenu ref={mentionMenu} {...mentionProps} />}
        </>
      )}
    </div>
  );

  if (editable && !supported)
    return (
      <div className="flex flex-col gap-3">
        <Alert>
          <AlertDescription>
            This page has blocks this version of the editor doesn&apos;t support, so it&apos;s read-only here.
          </AlertDescription>
        </Alert>
        {body}
      </div>
    );
  return body;
}

/** Task items with the shadcn checkbox, matching DocRenderer. */
const TaskItemWithCheckbox = TaskItem.extend({
  addNodeView() {
    return ReactNodeViewRenderer(TaskItemView);
  },
});

function TaskItemView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const checked = Boolean(node.attrs.checked);
  return (
    <NodeViewWrapper as="li" className="flex items-start gap-2" data-checked={checked}>
      {/* Keep focus in the editor when ticking, so typing carries on where it was. */}
      <span contentEditable={false} className="flex select-none" onMouseDown={(e) => e.preventDefault()}>
        <Checkbox
          checked={checked}
          disabled={!editor.isEditable}
          onCheckedChange={(value) => updateAttributes({ checked: value === true })}
          aria-label={checked ? "Mark as not done" : "Mark as done"}
          className="mt-1.5"
        />
      </span>
      <NodeViewContent className={cn("min-w-0 flex-1", checked && "text-muted-foreground line-through")} />
    </NodeViewWrapper>
  );
}

// ─── Formatting toolbar (shown over a text selection) ───────────────────────

function FormatMenu({ editor }: { editor: Editor }) {
  const [linking, setLinking] = useState(false);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      highlight: e.isActive("highlight"),
      link: e.isActive("link"),
      href: (e.getAttributes("link").href as string | undefined) ?? "",
    }),
  });

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 8 }}
      shouldShow={({ editor: e, from, to }) =>
        e.isEditable &&
        from !== to &&
        !e.isActive("codeBlock") &&
        !(e.state.selection instanceof NodeSelection) &&
        // Several cells selected: the table toolbar is the relevant one.
        !(e.state.selection instanceof CellSelection)
      }
      className="z-50 flex items-center gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {linking ? (
        <LinkInput
          initial={state.href}
          onDone={(href) => {
            setLinking(false);
            const chain = editor.chain().focus().extendMarkRange("link");
            if (href === null) chain.run();
            else if (href === "") chain.unsetLink().run();
            else chain.setLink({ href }).run();
          }}
        />
      ) : (
        <>
          <Mark
            label="Bold"
            shortcut="⌘B"
            pressed={state.bold}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold />
          </Mark>
          <Mark
            label="Italic"
            shortcut="⌘I"
            pressed={state.italic}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic />
          </Mark>
          <Mark
            label="Strikethrough"
            pressed={state.strike}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <Strikethrough />
          </Mark>
          <Mark label="Code" pressed={state.code} onClick={() => editor.chain().focus().toggleCode().run()}>
            <Code />
          </Mark>
          <Mark
            label="Highlight"
            pressed={state.highlight}
            onClick={() => editor.chain().focus().toggleHighlight().run()}
          >
            <Highlighter />
          </Mark>
          <Mark label="Link" pressed={state.link} onClick={() => setLinking(true)}>
            <Link2 />
          </Mark>
        </>
      )}
    </BubbleMenu>
  );
}

// ─── Table toolbar (shown while the cursor is in a table) ───────────────────

/** The DOM element of the table around the selection, for anchoring the toolbar above it. */
function tableElement(editor: Editor): HTMLElement | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name !== "table") continue;
    const dom = editor.view.nodeDOM($from.before(depth));
    return dom instanceof HTMLElement ? (dom.querySelector("table") ?? dom) : null;
  }
  return null;
}

function TableMenu({ editor }: { editor: Editor }) {
  const run = (command: (chain: ChainedCommands) => ChainedCommands) => () =>
    command(editor.chain().focus()).run();
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableMenu"
      options={{ placement: "top-start", offset: 8 }}
      getReferencedVirtualElement={() => {
        const table = tableElement(editor);
        return table ? { getBoundingClientRect: () => table.getBoundingClientRect() } : null;
      }}
      shouldShow={({ editor: e }) => e.isEditable && e.isActive("table")}
      role="toolbar"
      aria-label="Table"
      className="z-50 flex items-center gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
    >
      <TableButton label="Add row above" onClick={run((c) => c.addRowBefore())}>
        <BetweenHorizontalStart />
      </TableButton>
      <TableButton label="Add row below" onClick={run((c) => c.addRowAfter())}>
        <BetweenHorizontalEnd />
      </TableButton>
      <TableButton label="Add column before" onClick={run((c) => c.addColumnBefore())}>
        <BetweenVerticalStart />
      </TableButton>
      <TableButton label="Add column after" onClick={run((c) => c.addColumnAfter())}>
        <BetweenVerticalEnd />
      </TableButton>
      <TableButton label="Toggle header row" onClick={run((c) => c.toggleHeaderRow())}>
        <PanelTop />
      </TableButton>
      <span aria-hidden className="mx-1 h-5 w-px bg-border" />
      <TableButton label="Delete row" onClick={run((c) => c.deleteRow())} text="Row">
        <Trash2 />
      </TableButton>
      <TableButton label="Delete column" onClick={run((c) => c.deleteColumn())} text="Column">
        <Trash2 />
      </TableButton>
      <TableButton label="Delete table" onClick={run((c) => c.deleteTable())} text="Table" destructive>
        <Trash2 />
      </TableButton>
    </BubbleMenu>
  );
}

function TableButton({
  label,
  onClick,
  text,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  text?: string;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={destructive ? "destructive" : "ghost"}
      size={text ? "sm" : "icon-sm"}
      aria-label={label}
      title={label}
      // Keep the cursor in the cell so the toolbar stays open.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
      {text}
    </Button>
  );
}

function Mark({
  label,
  shortcut,
  pressed,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Toggle
      size="sm"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      pressed={pressed}
      onPressedChange={onClick}
      className="px-1.5"
    >
      {children}
    </Toggle>
  );
}

/** `null` cancels, `""` removes the link. */
function LinkInput({ initial, onDone }: { initial: string; onDone: (href: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const submit = () => onDone(normalizeHref(value));
  return (
    <form
      className="flex items-center gap-0.5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        autoFocus
        aria-label="Link URL"
        placeholder="Paste a link…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onDone(null);
          }
        }}
        className="h-7 w-56 rounded-md bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Button type="submit" variant="ghost" size="icon-sm" aria-label="Apply link">
        <Check />
      </Button>
      {initial && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Remove link"
          onClick={() => onDone("")}
        >
          <X />
        </Button>
      )}
    </form>
  );
}

/** Adds `https://` to bare domains; the link extension rejects unsafe schemes. */
function normalizeHref(raw: string): string {
  const href = raw.trim();
  if (!href) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("#")) return href;
  return `https://${href}`;
}
