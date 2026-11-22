import { mentionToPlainText } from "@knotworking/core";
import { Extension, mergeAttributes, Node } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { Suggestion, type SuggestionOptions } from "@tiptap/suggestion";
import type { MentionItem } from "@/lib/mentions";

/**
 * `@`-mentions of people, tasks and pages, stored as inline `mention` nodes
 * (`attrs: { kind: "user" | "task" | "doc", id, label }`; see `docContentSchema`). The node is an atom:
 * it is selected, moved and deleted as one unit. `label` is only a cache for readers that can't look the
 * target up (MCP plain text, the `renderHTML` output); the React node view and `DocRenderer` resolve the
 * name live from the workspace store.
 *
 * No React imports, so the schema can be checked in tests. The picker lives in `mention-menu.tsx`.
 */
export const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    const attr = (name: string, fallback: string | null) => ({
      default: fallback,
      parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`) ?? fallback,
      renderHTML: (attrs: Record<string, unknown>) => ({ [`data-${name}`]: attrs[name] }),
    });
    return { kind: attr("kind", "user"), id: attr("id", null), label: attr("label", "") };
  },
  parseHTML() {
    return [{ tag: "span[data-mention]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-mention": "",
        class: "rounded-sm bg-muted px-1.5 py-px text-[0.92em] font-medium",
      }),
      mentionToPlainText(node.attrs),
    ];
  },
  // Copying a mention as text gives what MCP readers see: @Ada, [[Doc]], #Task.
  renderText({ node }) {
    return mentionToPlainText(node.attrs);
  },
});

type MentionRender = NonNullable<SuggestionOptions<MentionItem, MentionItem>["render"]>;

/**
 * Type `@` to search the workspace's people, tasks and pages. Items come from `getItems` (the live
 * client store, no request); rendering is supplied by the React editor.
 */
export const MentionSuggestion = Extension.create<{
  render: MentionRender | null;
  getItems: (query: string) => MentionItem[];
}>({
  name: "mentionSuggestion",
  addOptions: () => ({ render: null, getItems: () => [] }),
  addProseMirrorPlugins() {
    const { render, getItems } = this.options;
    if (!render) return [];
    return [
      Suggestion<MentionItem, MentionItem>({
        editor: this.editor,
        // Its own key: the slash menu's suggestion plugin uses the default one.
        pluginKey: new PluginKey("mentionSuggestion"),
        char: "@",
        items: ({ query }) => getItems(query),
        command: ({ editor, range, props }) => {
          // Reuse a space already after the cursor instead of doubling it.
          const after = editor.view.state.selection.$to.nodeAfter;
          if (after?.text?.startsWith(" ")) range = { ...range, to: range.to + 1 };
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: "mention", attrs: { kind: props.kind, id: props.id, label: props.label } },
              { type: "text", text: " " },
            ])
            .run();
        },
        // Not inside code blocks, where "@" is just a character.
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        render,
      }),
    ];
  },
});
