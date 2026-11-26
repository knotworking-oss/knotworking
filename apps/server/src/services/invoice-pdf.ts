import { existsSync, readFileSync } from "node:fs";
import PDFDocument from "pdfkit";
import { badRequest } from "../errors";
import type { findCustomerDocument } from "./invoicing";

type Document = Awaited<ReturnType<typeof findCustomerDocument>>;

/**
 * Noto Sans (SIL OFL 1.1, licenses/noto-sans.txt) covers Latin, Greek and Cyrillic, so customer
 * names and addresses print as entered. PDFKit's built-in Helvetica only covers WinAnsi.
 * The fonts sit in apps/server/assets/fonts: next to src/ in development, next to dist/ in the image.
 */
let fonts: { regular: Buffer; bold: Buffer } | undefined;
function invoiceFonts() {
  if (fonts) return fonts;
  const directory = ["../../assets/fonts/", "../assets/fonts/"]
    .map((path) => new URL(path, import.meta.url))
    .find((url) => existsSync(new URL("NotoSans-Regular.ttf", url)));
  if (!directory) throw new Error("Invoice PDF fonts are missing from assets/fonts");
  fonts = {
    regular: readFileSync(new URL("NotoSans-Regular.ttf", directory)),
    bold: readFileSync(new URL("NotoSans-Bold.ttf", directory)),
  };
  return fonts;
}

export async function customerDocumentPdf(document: Document): Promise<Buffer> {
  if (document.status !== "issued") throw badRequest("Issue the document before downloading a PDF");
  const title = document.kind === "credit" ? "Credit note" : "Invoice";
  const pdf = new PDFDocument({
    size: "A4",
    margin: 48,
    font: "",
    info: { Title: `${title} ${document.number}` },
  });
  const { regular, bold } = invoiceFonts();
  pdf.registerFont("Body", regular);
  pdf.registerFont("Body-Bold", bold);
  pdf.font("Body");
  const result = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.once("end", () => resolve(Buffer.concat(chunks)));
    pdf.once("error", reject);
  });
  const start = 48;
  const width = pdf.page.width - 2 * start;
  const heading = () => {
    pdf.font("Body-Bold").fontSize(19).fillColor("#17263a").text(`${title} ${document.number}`);
    pdf.moveDown(0.6).font("Body").fontSize(10).fillColor("#24364b");
  };
  const columns = [
    { label: "Description", x: start, width: width - 250 },
    { label: "Quantity", x: start + width - 245, width: 61 },
    { label: "Unit price", x: start + width - 181, width: 61 },
    { label: "Net", x: start + width - 117, width: 59 },
    { label: "Tax", x: start + width - 55, width: 55 },
  ] as const;
  function row(values: string[], y: number) {
    const heights = values.map((value, i) => pdf.heightOfString(value, { width: columns[i]!.width }));
    values.forEach((value, i) => {
      const column = columns[i]!;
      pdf.text(value, column.x, y, { width: column.width, align: i ? "right" : "left" });
    });
    pdf.x = start;
    pdf.y = y + Math.max(...heights) + 9;
  }
  function tableHeader() {
    pdf.font("Body-Bold").fontSize(9);
    row(
      columns.map((column) => column.label),
      pdf.y,
    );
    pdf.font("Body").fontSize(9);
  }
  heading();
  pdf.text(`From  ${document.issuer.name}`);
  if (document.issuer.address) pdf.text(document.issuer.address);
  pdf.moveDown(0.6).text(`Bill to  ${document.customer.name}`);
  if (document.customer.address) pdf.text(document.customer.address);
  pdf.moveDown(0.6).text(`Issued  ${document.date}`);
  if (document.dueDate) pdf.text(`Due  ${document.dueDate}`);
  if (document.sourceReference) pdf.text(`Reference  ${document.sourceReference}`);
  if (document.creditReason) pdf.text(`Reason  ${document.creditReason}`);
  pdf.text(`Currency  ${document.currency}`).moveDown();
  tableHeader();
  for (const line of document.lines) {
    const values = [
      `${line.description}${line.unit ? ` (${line.unit})` : ""}`,
      line.quantity,
      line.unitPrice,
      line.net,
      `${line.tax}\n${line.taxRate}%`,
    ];
    const height = Math.max(
      ...values.map((value, i) => pdf.heightOfString(value, { width: columns[i]!.width })),
    );
    if (pdf.y + height + 18 > pdf.page.height - start) {
      pdf.addPage();
      heading();
      tableHeader();
    }
    row(values, pdf.y);
  }
  if (pdf.y + 70 > pdf.page.height - start) {
    pdf.addPage();
    heading();
  }
  pdf
    .moveDown(0.5)
    .fontSize(11)
    .text(`Subtotal  ${document.net}`, { align: "right" })
    .text(`Tax  ${document.tax}`, { align: "right" })
    .font("Body-Bold")
    .text(`Total  ${document.currency} ${document.gross}`, { align: "right" });
  pdf.end();
  return result;
}
