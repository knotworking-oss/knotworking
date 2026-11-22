import { d, docContentSchema, docToPlainText, type DocContent } from "@knotworking/core";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { docSchema, filterSlashCommands, isEditableContent, schemaExtensions } from "./extensions";
import { canAddImages, DocImage } from "./image";

const ID = "01900000-0000-7000-8000-000000000abc";
const withImage: DocContent = d.doc(d.p("Before"), d.image(ID, "diagram.png"), d.p("After"));

let editor: Editor | undefined;
afterEach(() => editor?.destroy());

const makeEditor = (content: DocContent | string, onFiles: ((files: File[]) => void) | null = null) =>
  (editor = new Editor({
    extensions: schemaExtensions({
      image: DocImage.configure({
        resolveSrc: (id) => `/api/v1/workspaces/acme/attachments/${id}/content`,
        onFiles,
      }),
    }),
    content,
  }));

describe("image node", () => {
  it("is part of the stored format and round-trips", () => {
    expect(isEditableContent(withImage)).toBe(true);
    const json = docSchema.nodeFromJSON(withImage).toJSON() as DocContent;
    expect(json.content[1]).toMatchObject({
      type: "image",
      attrs: { attachmentId: ID, filename: "diagram.png" },
    });
    expect(docContentSchema.safeParse(json).success).toBe(true);
    expect(docToPlainText(json)).toBe("Before\n[image: diagram.png]\nAfter\n");
  });

  it("renders through the authenticated same-origin attachment URL", () => {
    const html = makeEditor(withImage).getHTML();
    expect(html).toContain(`src="/api/v1/workspaces/acme/attachments/${ID}/content"`);
    expect(html).toContain('alt="diagram.png"');
  });

  it("drops pasted remote images and keeps attachment images", () => {
    const remote = makeEditor('<p>a</p><img src="https://tracker.example/p.gif"><p>b</p>').getJSON();
    expect(JSON.stringify(remote)).not.toContain("tracker.example");
    expect(remote.content?.some((n) => n.type === "image")).toBe(false);
    editor!.destroy();
    const ours = makeEditor(
      `<img data-attachment-id="${ID}" data-filename="x.png" src="/whatever">`,
    ).getJSON();
    expect(ours.content?.[0]).toMatchObject({
      type: "image",
      attrs: { attachmentId: ID, filename: "x.png" },
    });
  });

  it("offers the Image slash command only with an upload target", () => {
    const image = filterSlashCommands("image").find((i) => i.title === "Image")!;
    expect(image).toBeDefined();
    expect(image.available!(makeEditor(withImage))).toBe(false);
    editor!.destroy();
    const onFiles = vi.fn();
    const writable = makeEditor(withImage, onFiles);
    expect(canAddImages(writable)).toBe(true);
    expect(image.available!(writable)).toBe(true);
  });
});
