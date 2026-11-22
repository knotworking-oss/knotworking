import {
  invoiceMatchIssueLabels,
  purchaseCreditLineReasons,
  purchaseCreditNoteListStatuses,
  purchaseInvoiceListStatuses,
  type InvoiceMatchIssue,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Creates a draft or replaces a draft's lines: not safe to repeat blindly. */
const DRAFT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const PERSON_ONLY =
  "Approving an invoice or a credit note for payment is a person's act in the app (it needs manage access, and a reason when the invoice doesn't match); there is no tool for it, and none can be switched on. Approved invoices can't change: pass `correct: true` with an approved invoice's id to draft a new version, which a person then approves in its place.";

/**
 * Supplier invoices (purchasing module). Agents read invoices with their three-way match and draft
 * them (and corrections of approved ones). Approval is a person's, with no tool.
 */
export function registerPurchaseInvoiceTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];
  const p = (api: Api) => ws(api).purchasing;

  async function resolveSupplierId(api: Api, slug: string, ref: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { suppliers } = await api.call(ws(api).suppliers.$get({ param: { slug }, query: { q: wanted } }));
    const lower = wanted.toLowerCase();
    const match = suppliers.filter((s) => s.code?.toLowerCase() === lower || s.name.toLowerCase() === lower);
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      match.length ? "ambiguous" : "not_found",
      match.length
        ? `More than one supplier matches "${wanted}"; pass its id.`
        : `No supplier is called "${wanted}". Use list_suppliers to find it.`,
    );
  }

  const getOrderByRef = async (api: Api, slug: string, ref: string) => {
    const wanted = ref.trim();
    let id = wanted;
    if (!UUID.test(wanted)) {
      const upper = wanted.toUpperCase();
      const { orders } = await api.call(p(api).orders.$get({ param: { slug }, query: { q: upper } }));
      const hit = orders.find((o) => o.reference === upper);
      if (!hit)
        throw new ToolError(
          "not_found",
          `No purchase order has the reference "${ref}". list_purchase_orders finds them.`,
        );
      id = hit.id;
    }
    return api.call(p(api).orders[":id"].$get({ param: { slug, id } }));
  };

  /** An invoice id, from an id or the supplier's invoice number (with the supplier when shared). */
  async function resolveInvoiceId(api: Api, slug: string, ref: string, supplier?: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const supplierId = supplier ? await resolveSupplierId(api, slug, supplier) : undefined;
    const { invoices } = await api.call(
      p(api).invoices.$get({
        param: { slug },
        query: { q: wanted, status: "current", ...(supplierId ? { supplierId } : {}) },
      }),
    );
    const match = invoices.filter((i) => i.invoiceNumber.toLowerCase() === wanted.toLowerCase());
    // A number in draft revision and approved: the latest version.
    const suppliersHit = new Set(match.map((i) => i.supplierId));
    if (suppliersHit.size === 1) return match.sort((a, b) => b.version - a.version)[0]!.id;
    throw new ToolError(
      match.length ? "ambiguous" : "not_found",
      match.length
        ? `More than one supplier has an invoice numbered "${wanted}"; pass the supplier or the invoice id.`
        : `No invoice is numbered "${wanted}". list_purchase_invoices finds them.`,
    );
  }

  const getInvoice = (api: Api, slug: string, id: string) =>
    api.call(p(api).invoices[":id"].$get({ param: { slug, id } }));
  type Detail = Awaited<ReturnType<typeof getInvoice>>;
  const listInvoices = (api: Api, slug: string, query: Record<string, string>) =>
    api.call(p(api).invoices.$get({ param: { slug }, query }));
  type Summary = Awaited<ReturnType<typeof listInvoices>>["invoices"][number];

  const header = (i: Summary | Detail) => ({
    id: i.id,
    invoiceNumber: i.invoiceNumber,
    version: i.version,
    supplier: i.supplier.name,
    status: i.status,
    invoiceDate: i.invoiceDate,
    dueDate: i.dueDate,
    net: i.net,
    vat: i.vat,
    gross: i.gross,
    match: i.matchStatus,
    ...(i.status !== "draft" && i.matchStatusNow !== i.matchStatus ? { matchNow: i.matchStatusNow } : {}),
    mismatchedLines: i.mismatchedLines,
    orders: i.orders.map((o) => o.reference),
    ...(i.approvedMatchStatus ? { approvedAtMatch: i.approvedMatchStatus } : {}),
    ...(i.approvalReason ? { approvalReason: i.approvalReason } : {}),
  });

  const detailView = (i: Detail) => ({
    ...header(i),
    notes: i.notes,
    createdBy: i.createdByName,
    approved: i.approvedAt ? { by: i.approvedByName, at: i.approvedAt } : null,
    tolerances: i.tolerances,
    versions: i.versions.map((v) => `v${v.version} ${v.status}`),
    lines: i.lines.map((l) =>
      l.kind === "charge" || !l.orderLine || !l.match
        ? {
            line: l.lineNo,
            charge: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            value: l.value,
          }
        : {
            line: l.lineNo,
            order: l.orderLine.reference,
            orderLine: l.orderLine.lineNo,
            orderLineId: l.orderLine.id,
            item: l.item ? `${l.item.code} ${l.item.name}` : null,
            unit: l.unit,
            invoiced: l.quantity,
            unitPrice: l.unitPrice,
            value: l.value,
            ordered: l.orderLine.quantity,
            orderPrice: l.orderLine.unitPrice,
            received: l.received,
            invoicedElsewhere: l.invoicedElsewhere,
            match: l.match.status,
            priceVariance: l.match.priceVariance,
            priceVariancePercent: l.match.priceVariancePercent,
            quantityVariance: l.match.quantityVariance,
            issues: l.match.issues.map((x) => invoiceMatchIssueLabels[x as InvoiceMatchIssue]),
            ...(l.now && l.now.match.status !== l.match.status
              ? {
                  now: {
                    received: l.now.received,
                    invoicedElsewhere: l.now.invoicedElsewhere,
                    match: l.now.match.status,
                    issues: l.now.match.issues.map((x) => invoiceMatchIssueLabels[x as InvoiceMatchIssue]),
                  },
                }
              : {}),
          },
    ),
  });

  define(
    "list_purchase_invoices",
    {
      module: "purchasing",
      resource: { name: "purchase_invoices", op: "list" },
      title: "List supplier invoices",
      description:
        "Supplier invoices, latest invoice date first, each with its supplier, status (draft, approved, superseded), net, VAT and gross, the purchase orders it bills and its three-way match now: `matched`, `within_tolerance` or `mismatch` (the worst of its order lines). Status `current` (the default) leaves out superseded versions. Filter by supplier, purchase order reference, invoice-date range or text (invoice number, supplier). Use get_purchase_invoice for the lines.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        status: z.enum(purchaseInvoiceListStatuses).optional().describe("Default current."),
        supplier: z.string().max(200).optional().describe("Supplier id, code or exact name."),
        order: z.string().max(60).optional().describe("Purchase order reference (PO-2026-001) or id."),
        from: isoDate.optional().describe("Invoice date on or after."),
        to: isoDate.optional().describe("Invoice date on or before."),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const [supplierId, order] = await Promise.all([
        a.supplier ? resolveSupplierId(api, slug, a.supplier) : undefined,
        a.order ? getOrderByRef(api, slug, a.order) : undefined,
      ]);
      const page = await listInvoices(api, slug, {
        ...(a.status ? { status: a.status } : {}),
        ...(supplierId ? { supplierId } : {}),
        ...(order ? { purchaseOrderId: order.id } : {}),
        ...(a.from ? { from: a.from } : {}),
        ...(a.to ? { to: a.to } : {}),
        ...(a.search ? { q: a.search } : {}),
        limit: String(a.limit ?? 50),
        ...(a.offset ? { offset: String(a.offset) } : {}),
      });
      return { total: page.total, invoices: page.invoices.map(header) };
    },
  );

  define(
    "get_purchase_invoice",
    {
      module: "purchasing",
      resource: { name: "purchase_invoices", op: "get" },
      title: "Get a supplier invoice",
      description:
        "One supplier invoice in full by its id, or by the supplier's invoice number (pass `supplier` when two suppliers use the same number): header, totals, who approved it and why, its versions, and each line. An order line shows what was invoiced against the order (quantity and price per the order line's unit), what was received and already invoiced on other approved invoices, the price and quantity variances (positive is over the order price, or over-invoiced) and its match with the reasons (`received` is null, flagged as not convertible, when the item's unit weight or density is missing); charges (carriage) are not matched. A draft is matched live against the workspace's tolerances. An approved or superseded invoice shows the match it was approved at (the order prices, unit conversions and tolerances then; it never re-grades), with `now` on a line, and `matchNow` on the invoice, only where today's comparison differs.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        invoice: z.string().min(1).max(60).describe("Invoice id, or the supplier's invoice number."),
        supplier: z.string().max(200).optional().describe("Supplier id, code or exact name."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return detailView(
        await getInvoice(api, slug, await resolveInvoiceId(api, slug, a.invoice, a.supplier)),
      );
    },
  );

  const lineInput = z.object({
    order: z
      .string()
      .max(60)
      .optional()
      .describe("Purchase order reference (PO-2026-001) or id, with `order_line`. Leave out for a charge."),
    order_line: z.number().int().min(1).optional().describe("The line number on that order."),
    order_line_id: z
      .string()
      .max(60)
      .optional()
      .describe("Or the order line's id (from get_purchase_order)."),
    charge: z
      .string()
      .max(200)
      .optional()
      .describe("For a non-stock line (carriage, a pallet charge, a discount): what it is. No order then."),
    quantity: z
      .number()
      .positive()
      .optional()
      .describe("Invoiced, in the order line's unit (charges: default 1)."),
    unit_price: z
      .number()
      .describe(
        "Per the order line's unit (charges: per one). A charge may be negative: a discount (\"Settlement discount\", -3.50). Order lines can't be negative, and the invoice can't total less than nothing.",
      ),
  });

  define(
    "draft_purchase_invoice",
    {
      module: "purchasing",
      title: "Draft or edit a supplier invoice",
      description: `Enter a supplier's invoice as a draft, or, with \`invoice_id\`, edit a draft. A new draft needs the supplier (id, code or exact name), the supplier's invoice number (unique per supplier) and the invoice date; a due date, VAT (a plain amount, default 0) and notes are optional. Each line is either an order line, given as \`order\` (reference) and \`order_line\` (its line number) or \`order_line_id\`, with the quantity and unit price per that order line's unit as invoiced (the order must be with the same supplier and sent or closed), or a \`charge\` such as carriage with its price. IMPORTANT when editing: \`lines\` replaces every line. The result shows the three-way match against the order and what was received, so you can tell the user what doesn't match. ${PERSON_ONLY}`,
      annotations: DRAFT,
      input: {
        workspace: workspaceParam,
        invoice_id: z
          .string()
          .max(60)
          .optional()
          .describe("Id of the draft to edit (or, with `correct`, of the approved invoice to correct)."),
        correct: z
          .boolean()
          .optional()
          .describe(
            "With an approved invoice's id: draft a new version of it, then apply the changes. If a correction is already being drafted, the changes go to that draft; if they are refused, a correction this call drafted is deleted again.",
          ),
        supplier: z.string().max(200).optional().describe("Required for a new draft."),
        invoice_number: z.string().min(1).max(60).optional().describe("Required for a new draft."),
        invoice_date: isoDate.optional().describe("Required for a new draft."),
        due_date: isoDate.nullable().optional(),
        vat: z.number().min(0).optional(),
        notes: z.string().max(4000).nullable().optional(),
        lines: z.array(lineInput).max(200).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const orders = new Map<string, Awaited<ReturnType<typeof getOrderByRef>>>();
      const lines = a.lines
        ? await Promise.all(
            a.lines.map(async (l, i) => {
              if (l.charge) {
                return {
                  kind: "charge" as const,
                  description: l.charge,
                  quantity: l.quantity ?? 1,
                  unitPrice: l.unit_price,
                };
              }
              let orderLineId = l.order_line_id;
              if (!orderLineId) {
                if (!l.order || !l.order_line)
                  throw new ToolError(
                    "invalid_input",
                    `Line ${i + 1}: give \`order\` and \`order_line\`, \`order_line_id\`, or \`charge\`.`,
                  );
                const key = l.order.trim().toUpperCase();
                if (!orders.has(key)) orders.set(key, await getOrderByRef(api, slug, l.order));
                const found = orders.get(key)!.lines.find((x) => x.lineNo === l.order_line);
                if (!found)
                  throw new ToolError("not_found", `Line ${i + 1}: ${l.order} has no line ${l.order_line}.`);
                orderLineId = found.id;
              }
              if (l.quantity === undefined)
                throw new ToolError("invalid_input", `Line ${i + 1}: an order line needs a quantity.`);
              return { kind: "order" as const, orderLineId, quantity: l.quantity, unitPrice: l.unit_price };
            }),
          )
        : undefined;
      const header = {
        ...(a.invoice_number !== undefined ? { invoiceNumber: a.invoice_number } : {}),
        ...(a.invoice_date !== undefined ? { invoiceDate: a.invoice_date } : {}),
        ...(a.due_date !== undefined ? { dueDate: a.due_date } : {}),
        ...(a.vat !== undefined ? { vat: a.vat } : {}),
        ...(a.notes !== undefined ? { notes: a.notes } : {}),
      };
      if (!a.invoice_id) {
        if (!a.supplier || !a.invoice_number || !a.invoice_date)
          throw new ToolError(
            "invalid_input",
            "A new invoice needs `supplier`, `invoice_number` and `invoice_date`.",
          );
        const supplierId = await resolveSupplierId(api, slug, a.supplier);
        return detailView(
          await api.call(
            p(api).invoices.$post({
              param: { slug },
              json: {
                supplierId,
                invoiceNumber: a.invoice_number,
                invoiceDate: a.invoice_date,
                ...header,
                lines: lines ?? [],
              },
            }),
          ),
        );
      }
      if (a.correct && (a.supplier !== undefined || a.invoice_number !== undefined))
        throw new ToolError(
          "invalid_input",
          "A correction keeps the supplier and invoice number: leave out `supplier` and `invoice_number`.",
        );
      let id = await resolveInvoiceId(api, slug, a.invoice_id);
      // Everything is resolved before a correction is drafted, so a bad reference leaves nothing behind.
      const supplierId = a.supplier ? await resolveSupplierId(api, slug, a.supplier) : undefined;
      const patch = { ...header, ...(supplierId ? { supplierId } : {}), ...(lines ? { lines } : {}) };
      /** A correction drafted by this call (deleted again if the changes are refused). */
      let drafted: string | null = null;
      if (a.correct) {
        try {
          id = (await api.call(p(api).invoices[":id"].revise.$post({ param: { slug, id } }))).id;
          drafted = id;
        } catch (err) {
          // A correction already being drafted (an earlier attempt, say): apply the changes to it.
          const pending = (err as ToolError).options?.details as { invoiceId?: string } | undefined;
          if (!(err instanceof ToolError && err.code === "revision_exists" && pending?.invoiceId)) throw err;
          id = pending.invoiceId;
        }
      }
      if (!Object.keys(patch).length) return detailView(await getInvoice(api, slug, id));
      try {
        return detailView(
          await api.call(p(api).invoices[":id"].$patch({ param: { slug, id }, json: patch })),
        );
      } catch (err) {
        if (drafted) {
          // Don't leave an empty correction behind; a failure to delete it is not the error to report.
          await api
            .call(p(api).invoices[":id"].$delete({ param: { slug, id: drafted } }))
            .catch(() => undefined);
        }
        throw err;
      }
    },
  );

  // ── Credit notes ──
  const creditHeader = (n: {
    id: string;
    creditNoteNumber: string;
    status: string;
    creditDate: string;
    net: number;
    vat: number;
    gross: number;
    supplier: { name: string };
    invoice: { invoiceNumber: string; version: number };
    voidReason?: string | null;
  }) => ({
    id: n.id,
    creditNoteNumber: n.creditNoteNumber,
    status: n.status,
    creditDate: n.creditDate,
    supplier: n.supplier.name,
    invoice: `${n.invoice.invoiceNumber} v${n.invoice.version}`,
    net: n.net,
    vat: n.vat,
    gross: n.gross,
    ...(n.voidReason ? { voidReason: n.voidReason } : {}),
  });
  const getCreditNote = (api: Api, slug: string, id: string) =>
    api.call(p(api)["credit-notes"][":id"].$get({ param: { slug, id } }));
  const creditDetail = (n: Awaited<ReturnType<typeof getCreditNote>>) => ({
    ...creditHeader(n),
    notes: n.notes,
    createdBy: n.createdByName,
    approved: n.approvedAt ? { by: n.approvedByName, at: n.approvedAt } : null,
    lines: n.lines.map((l) =>
      l.kind === "charge"
        ? {
            line: l.lineNo,
            charge: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            value: l.value,
          }
        : {
            line: l.lineNo,
            invoiceLine: l.invoiceLine?.lineNo ?? null,
            item: l.invoiceLine?.item ? `${l.invoiceLine.item.code} ${l.invoiceLine.item.name}` : null,
            reason: l.reason,
            unit: l.unit,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            value: l.value,
          },
    ),
  });

  define(
    "list_purchase_credit_notes",
    {
      module: "purchasing",
      resource: { name: "purchase_credit_notes", op: "list" },
      title: "List supplier credit notes",
      description:
        "Supplier credit notes, latest credit date first, each with its supplier, the invoice it credits, status (draft, approved, voided) and net, VAT and gross credited. A credit note is its own document against one approved invoice: a price credit lowers what its lines cost (and so what the lots are costed at), returned goods credit units sent back. Status `current` (the default) leaves out voided ones. Pass `credit_note` (its id) to get one in full with its lines. Filter by supplier, invoice (id or the supplier's invoice number) or text.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        credit_note: z.string().max(60).optional().describe("A credit note id: returns it with its lines."),
        status: z.enum(purchaseCreditNoteListStatuses).optional().describe("Default current."),
        supplier: z.string().max(200).optional().describe("Supplier id, code or exact name."),
        invoice: z.string().max(60).optional().describe("Invoice id or the supplier's invoice number."),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      if (a.credit_note) return creditDetail(await getCreditNote(api, slug, a.credit_note));
      const supplierId = a.supplier ? await resolveSupplierId(api, slug, a.supplier) : undefined;
      const invoiceId = a.invoice ? await resolveInvoiceId(api, slug, a.invoice, a.supplier) : undefined;
      const page = await api.call(
        p(api)["credit-notes"].$get({
          param: { slug },
          query: {
            ...(a.status ? { status: a.status } : {}),
            ...(supplierId ? { supplierId } : {}),
            ...(invoiceId ? { invoiceId } : {}),
            ...(a.search ? { q: a.search } : {}),
            limit: String(a.limit ?? 50),
            ...(a.offset ? { offset: String(a.offset) } : {}),
          },
        }),
      );
      return { total: page.total, creditNotes: page.creditNotes.map(creditHeader) };
    },
  );

  const creditLineInput = z.object({
    invoice_line: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("The credited invoice's line number (an order line). Leave out for a charge."),
    reason: z
      .enum(purchaseCreditLineReasons)
      .optional()
      .describe(
        "`price`: the line cost too much (the credited value comes off its cost). `goods_returned`: units sent back.",
      ),
    charge: z
      .string()
      .max(200)
      .optional()
      .describe("For a credited charge (carriage): what it is. No invoice line then."),
    quantity: z.number().positive().optional().describe("In the invoice line's unit (charges: default 1)."),
    unit_price: z.number().min(0).describe("Credited per unit, positive."),
    description: z.string().max(200).optional(),
  });

  define(
    "draft_purchase_credit_note",
    {
      module: "purchasing",
      title: "Draft or edit a supplier credit note",
      description: `Enter a supplier's credit note as a draft against an approved invoice, or, with \`credit_note_id\`, edit a draft. A new draft needs the invoice (id, or the supplier's invoice number with \`supplier\` when two suppliers share a number), the supplier's credit note number (unique per supplier) and the credit date; VAT credited (a plain amount) and notes are optional. Each line credits a line of that invoice (\`invoice_line\` number, a \`reason\` of price or goods_returned, the quantity and the amount credited per unit, all positive) or a credited \`charge\` such as carriage. A credit can't exceed what the invoice line billed (or the invoice's net). IMPORTANT when editing: \`lines\` replaces every line. Returned goods only credit the money: the stock is reversed in the app. ${PERSON_ONLY}`,
      annotations: DRAFT,
      input: {
        workspace: workspaceParam,
        credit_note_id: z.string().max(60).optional().describe("Id of the draft to edit."),
        invoice: z
          .string()
          .min(1)
          .max(60)
          .optional()
          .describe("Required for a new draft: invoice id or number."),
        supplier: z.string().max(200).optional().describe("With an invoice number."),
        credit_note_number: z.string().min(1).max(60).optional().describe("Required for a new draft."),
        credit_date: isoDate.optional().describe("Required for a new draft."),
        vat: z.number().min(0).optional(),
        notes: z.string().max(4000).nullable().optional(),
        lines: z.array(creditLineInput).max(200).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const resolveLines = async (invoiceId: string) => {
        if (!a.lines) return undefined;
        const invoice = await getInvoice(api, slug, invoiceId);
        return a.lines.map((l, i) => {
          if (l.charge) {
            return {
              kind: "charge" as const,
              description: l.charge,
              quantity: l.quantity ?? 1,
              unitPrice: l.unit_price,
            };
          }
          const invoiceLine = invoice.lines.find((x) => x.kind === "order" && x.lineNo === l.invoice_line);
          if (!l.invoice_line || !invoiceLine)
            throw new ToolError(
              "invalid_input",
              `Line ${i + 1}: give \`invoice_line\` (an order line number of invoice ${invoice.invoiceNumber}) or \`charge\`.`,
            );
          if (!l.reason || l.quantity === undefined)
            throw new ToolError(
              "invalid_input",
              `Line ${i + 1}: an invoice line needs a reason and a quantity.`,
            );
          return {
            kind: "invoice_line" as const,
            invoiceLineId: invoiceLine.id,
            reason: l.reason,
            quantity: l.quantity,
            unitPrice: l.unit_price,
            ...(l.description ? { description: l.description } : {}),
          };
        });
      };
      if (!a.credit_note_id) {
        if (!a.invoice || !a.credit_note_number || !a.credit_date)
          throw new ToolError(
            "invalid_input",
            "A new credit note needs `invoice`, `credit_note_number` and `credit_date`.",
          );
        const invoiceId = await resolveInvoiceId(api, slug, a.invoice, a.supplier);
        const lines = await resolveLines(invoiceId);
        return creditDetail(
          await api.call(
            p(api)["credit-notes"].$post({
              param: { slug },
              json: {
                invoiceId,
                creditNoteNumber: a.credit_note_number,
                creditDate: a.credit_date,
                ...(a.vat !== undefined ? { vat: a.vat } : {}),
                ...(a.notes !== undefined ? { notes: a.notes } : {}),
                lines: lines ?? [],
              },
            }),
          ),
        );
      }
      const current = await getCreditNote(api, slug, a.credit_note_id);
      const lines = await resolveLines(current.invoice.id);
      const json = {
        ...(a.credit_note_number !== undefined ? { creditNoteNumber: a.credit_note_number } : {}),
        ...(a.credit_date !== undefined ? { creditDate: a.credit_date } : {}),
        ...(a.vat !== undefined ? { vat: a.vat } : {}),
        ...(a.notes !== undefined ? { notes: a.notes } : {}),
        ...(lines ? { lines } : {}),
      };
      if (!Object.keys(json).length) throw new ToolError("invalid_input", "Nothing to update");
      return creditDetail(
        await api.call(p(api)["credit-notes"][":id"].$patch({ param: { slug, id: current.id }, json })),
      );
    },
  );
}
