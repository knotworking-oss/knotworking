import { inflateSync } from "node:zlib";
import { newId } from "@knotworking/core";
import { describe, expect, it } from "vitest";
import { customerDocumentPdf } from "./invoice-pdf";

type Document = Parameters<typeof customerDocumentPdf>[0];

const utf16 = (hex: string) =>
  String.fromCharCode(...(hex.replace(/\s+/g, "").match(/.{4}/g) ?? []).map((unit) => parseInt(unit, 16)));

/** The text a PDF reader extracts: each TJ run's glyph codes, mapped through its font's ToUnicode. */
function extractText(pdf: Buffer) {
  const objects = new Map<string, { dict: string; stream: string }>();
  for (const [, id, body] of pdf.toString("latin1").matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) {
    const [dict, data] = body!.split(/stream\r?\n/);
    let stream = "";
    if (data !== undefined) {
      const bytes = Buffer.from(data.replace(/\r?\nendstream\s*$/, ""), "latin1");
      stream = (dict!.includes("/FlateDecode") ? inflateSync(bytes) : bytes).toString("latin1");
    }
    objects.set(id!, { dict: dict!, stream });
  }
  const unicode = (cmap: string) => {
    const glyphs = new Map<number, string>();
    for (const [, start, list] of cmap.matchAll(/<([0-9a-f]+)> <[0-9a-f]+> \[([^\]]*)\]/gi))
      [...list!.matchAll(/<([^>]*)>/g)].forEach(([, hex], i) =>
        glyphs.set(parseInt(start!, 16) + i, utf16(hex!)),
      );
    return glyphs;
  };
  const fonts = new Map<string, Map<number, string>>();
  for (const { dict } of objects.values())
    for (const [, name, ref] of dict.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
      const cmap = objects.get(ref!)?.dict.match(/\/ToUnicode (\d+) 0 R/)?.[1];
      if (cmap) fonts.set(name!, unicode(objects.get(cmap)!.stream));
    }
  expect(fonts.size).toBeGreaterThan(0);
  const lines: string[] = [];
  for (const { stream } of objects.values()) {
    let font: Map<number, string> | undefined;
    for (const [, name, run] of stream.matchAll(/\/(F\d+) [\d.]+ Tf|\[([^\]]*)\] TJ/g)) {
      if (name) font = fonts.get(name);
      else
        lines.push(
          [...run!.matchAll(/<([0-9a-f]+)>/gi)]
            .flatMap(([, hex]) =>
              hex!.match(/.{4}/g)!.map((code) => font?.get(parseInt(code, 16)) ?? "\uFFFD"),
            )
            .join(""),
        );
    }
  }
  return lines.join("\n");
}

function document(extra: Partial<Document> = {}): Document {
  return {
    id: newId(),
    workspaceId: newId(),
    kind: "invoice",
    status: "issued",
    number: "INV-000042",
    serial: 42,
    revision: 2,
    customerId: newId(),
    customer: {
      name: "Łódź Spółka – Кириллица",
      address: "ul. Piotrkowska 1, 90-001 Łódź",
      taxNumber: "PL5260250995",
    },
    issuer: { name: "Ørsted & Søn Ltd", address: "1 Fixture Street", taxNumber: "GB123456789" },
    date: "2026-11-20",
    dueDate: "2026-12-20",
    currency: "PLN",
    source: "manual",
    sourceId: null,
    sourceReference: null,
    creditOf: null,
    creditReason: null,
    lines: [
      {
        id: newId(),
        description: "Herbata – Чай «Ёлка»",
        unit: "kg",
        quantity: "2",
        unitPrice: "10",
        taxRate: 23,
        net: "20.00",
        tax: "4.60",
        priceLocked: false,
        sourceLineId: null,
      },
    ],
    net: "20.00",
    tax: "4.60",
    gross: "24.60",
    issuedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  } as Document;
}

describe("customer document PDF", () => {
  it("embeds a Unicode font so Polish and Cyrillic names print as entered", async () => {
    const pdf = await customerDocumentPdf(document());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const raw = pdf.toString("latin1");
    expect(raw).toContain("NotoSans");
    expect(raw).not.toContain("/BaseFont /Helvetica");
    const text = extractText(pdf);
    for (const expected of [
      "Łódź Spółka – Кириллица",
      "ul. Piotrkowska 1, 90-001 Łódź",
      "Ørsted & Søn Ltd",
      "Tax registration number  GB123456789",
      "Customer tax number  PL5260250995",
      "Herbata – Чай «Ёлка» (kg)",
      "Total  PLN 24.60",
    ])
      expect(text).toContain(expected);
  });

  it("refuses a draft", async () => {
    await expect(customerDocumentPdf(document({ status: "draft", number: null }))).rejects.toMatchObject({
      status: 400,
    });
  });
});
