import { isInlineImageType, type DocImageAttrs } from "@knotworking/core";
import { mergeAttributes, Node, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export interface DocImageOptions {
  /**
   * Receives image files pasted, dropped or picked (slash menu) into the editor, with the document
   * position to insert at. Null where images can't be added (read-only views, no upload target);
   * the editor then ignores image files.
   */
  onFiles: ((files: File[], pos: number | null, editor: Editor) => void) | null;
  /** The URL to show for an attachment (same-origin, session-authenticated). */
  resolveSrc: (attachmentId: string) => string;
}

const imageFiles = (list: FileList | null | undefined) =>
  [...(list ?? [])].filter((f) => f.type.startsWith("image/"));

/**
 * An uploaded image (`DocImageAttrs`: `attachmentId`, `filename`, `alt`). Never a remote URL:
 * HTML pasted from elsewhere only becomes an image when it carries `data-attachment-id`, so
 * pasted `<img src="https://…">` tags (trackers, hotlinks) are dropped.
 */
export const DocImage = Node.create<DocImageOptions>({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addOptions: () => ({ onFiles: null, resolveSrc: () => "" }),

  addAttributes() {
    return {
      attachmentId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-attachment-id"),
        renderHTML: () => ({}),
      },
      filename: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-filename"),
        renderHTML: () => ({}),
      },
      alt: { default: null, parseHTML: (el) => el.getAttribute("alt") || null, renderHTML: () => ({}) },
    };
  },

  parseHTML() {
    return [{ tag: "img[data-attachment-id]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as DocImageAttrs;
    return [
      "img",
      mergeAttributes(HTMLAttributes, {
        src: attrs.attachmentId ? this.options.resolveSrc(attrs.attachmentId) : "",
        alt: attrs.alt ?? attrs.filename ?? "",
        title: attrs.filename ?? null,
        "data-attachment-id": attrs.attachmentId,
        "data-filename": attrs.filename,
        loading: "lazy",
        draggable: "false",
        class: "my-1 h-auto max-w-full rounded-md border border-border",
      }),
    ];
  },

  addProseMirrorPlugins() {
    const { options, editor } = this;
    return [
      new Plugin({
        key: new PluginKey("docImageFiles"),
        props: {
          handlePaste: (view, event) => {
            const files = imageFiles(event.clipboardData?.files);
            if (!files.length || !options.onFiles || !view.editable) return false;
            options.onFiles(files, view.state.selection.to, editor);
            return true;
          },
          handleDrop: (view, event) => {
            const files = imageFiles(event.dataTransfer?.files);
            if (!files.length || !options.onFiles || !view.editable) return false;
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            options.onFiles(files, at?.pos ?? null, editor);
            return true;
          },
        },
      }),
    ];
  },
});

/** Whether `editor` accepts new images (an upload target is configured). */
export const canAddImages = (editor: Editor) =>
  Boolean(editor.extensionManager.extensions.find((e) => e.name === "image")?.options.onFiles);

/** Opens the file picker and hands the chosen images to the editor's `onFiles`. */
export function pickImages(editor: Editor) {
  const onFiles = editor.extensionManager.extensions.find((e) => e.name === "image")?.options
    .onFiles as DocImageOptions["onFiles"];
  if (!onFiles) return;
  const pos = editor.state.selection.to;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/gif,image/webp";
  input.multiple = true;
  input.onchange = () => onFiles([...(input.files ?? [])], pos, editor);
  input.click();
}

/** Image types the editor shows inline (the API serves only these as images). */
export const isInlineImageFile = (file: { type: string }) => isInlineImageType(file.type);
