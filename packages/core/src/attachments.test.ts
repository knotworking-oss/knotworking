import { describe, expect, it } from "vitest";
import {
  attachmentContentPath,
  attachmentRef,
  attachmentUploadFieldsSchema,
  d,
  docContentSchema,
  docToPlainText,
  documentUpdateSchema,
  parseAttachmentRef,
  sanitizeContentType,
  sanitizeFilename,
  sniffImageType,
} from "./index";

const bytes = (...b: (number | string)[]) =>
  new Uint8Array(b.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));

describe("attachments", () => {
  it("sniffs raster images from their magic bytes only", () => {
    expect(sniffImageType(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe("image/png");
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageType(bytes("GIF89a"))).toBe("image/gif");
    expect(sniffImageType(bytes("RIFF", 1, 2, 3, 4, "WEBP"))).toBe("image/webp");
    expect(sniffImageType(bytes("<svg xmlns='http://www.w3.org/2000/svg'>"))).toBeNull();
    expect(sniffImageType(bytes("<html>"))).toBeNull();
    expect(sniffImageType(bytes())).toBeNull();
  });

  it("never keeps a script-capable or unproven type", () => {
    expect(sanitizeContentType("image/png", "image/png")).toBe("image/png");
    expect(sanitizeContentType("image/png", null)).toBe("application/octet-stream");
    expect(sanitizeContentType("text/plain", "image/gif")).toBe("image/gif");
    for (const bad of [
      "image/svg+xml",
      "text/html",
      "application/xhtml+xml",
      "text/javascript",
      "text/xml",
      "",
      null,
    ])
      expect(sanitizeContentType(bad, null)).toBe("application/octet-stream");
    expect(sanitizeContentType("Application/PDF; charset=binary", null)).toBe("application/pdf");
  });

  it("sanitizes filenames for display and headers", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFilename('a"b<c>.txt')).toBe("a_b_c_.txt");
    expect(sanitizeFilename("evil\u202Etxt.exe")).toBe("eviltxt.exe");
    expect(sanitizeFilename("line\r\nbreak.txt")).toBe("linebreak.txt");
    expect(sanitizeFilename("...")).toBe("file");
    expect(sanitizeFilename("")).toBe("file");
    const long = sanitizeFilename(`${"x".repeat(300)}.png`);
    expect(long).toHaveLength(200);
    expect(long.endsWith(".png")).toBe(true);
  });

  it("validates upload fields", () => {
    const id = "01900000-0000-7000-8000-000000000000";
    expect(attachmentUploadFieldsSchema.safeParse({ taskId: id }).success).toBe(true);
    expect(attachmentUploadFieldsSchema.safeParse({ taskId: id, documentId: id }).success).toBe(false);
    expect(attachmentUploadFieldsSchema.safeParse({ taskId: "x" }).success).toBe(false);
  });

  it("references attachments from documents without public URLs", () => {
    const id = "01900000-0000-7000-8000-00000000abcd";
    expect(parseAttachmentRef(attachmentRef(id))).toBe(id);
    expect(parseAttachmentRef("https://example.com/a.png")).toBeNull();
    expect(parseAttachmentRef(`attachment:${id}/../x`)).toBeNull();
    expect(attachmentContentPath("acme", id)).toBe(`/v1/workspaces/acme/attachments/${id}/content`);
    expect(documentUpdateSchema.safeParse({ coverUrl: attachmentRef(id) }).success).toBe(true);
    expect(documentUpdateSchema.safeParse({ coverUrl: null }).success).toBe(true);
    expect(documentUpdateSchema.safeParse({ coverUrl: "https://tracker.example/p.gif" }).success).toBe(false);
  });

  it("shows images as [image: filename] in plain text", () => {
    const doc = d.doc(
      d.p("Before"),
      d.image("01900000-0000-7000-8000-000000000000", "diagram.png"),
      d.p("After"),
    );
    expect(docContentSchema.safeParse(doc).success).toBe(true);
    expect(docToPlainText(doc)).toBe("Before\n[image: diagram.png]\nAfter\n");
    expect(docToPlainText(d.doc({ type: "image", attrs: { attachmentId: "x", alt: "A chart" } }))).toBe(
      "[image: A chart]\n",
    );
    expect(docToPlainText(d.doc({ type: "image", attrs: { filename: "a]\nb.png" } }))).toBe(
      "[image: a b.png]\n",
    );
  });
});
