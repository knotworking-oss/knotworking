import {
  PURCHASE_NOMINAL_CODE_MAX,
  PURCHASE_UNIT_LABEL_MAX,
  expiryTypes,
  purchaseOrderLineKinds,
  purchaseOrderListStatuses,
  unitCodes,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Creates a draft or, with an order, replaces its lines: neither is safe to repeat blindly. */
const DRAFT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const UNIT_HELP =
  "mg, g, kg (weight); ml, l (volume); each (count); mm, cm, m (length); mm2, cm2, m2 (area); s, min, h (time).";

const PERSON_ONLY =
  "Sending an order (a commitment to buy), closing it short and cancelling it are a person's acts in the app; there are no tools for them unless an owner or admin allows it under Settings → API access (send_purchase_order, email_purchase_order, close_purchase_order and cancel_purchase_order then appear).";

type Amount = { display: number; displayUnit: string | null; inLineUnit?: number | null };

/**
 * "15 kg", in the line's own unit when the API worked it out, else the item's unit. A non-stock
 * line's quantity is as entered, in its own unit ("3 visit") or bare when it has none.
 */
const qty = (a: Amount, lineUnit?: string | null) =>
  a.inLineUnit != null && lineUnit
    ? `${a.inLineUnit} ${lineUnit}`
    : a.displayUnit
      ? `${a.display} ${a.displayUnit}`
      : `${a.display}`;
const itemName = (i: { code: string; name: string }) => `${i.code} ${i.name}`;
/** A line's name: its item, or a non-stock line's description (with the item it names, if any). */
const lineName = (l: { item: { code: string; name: string } | null; description?: string | null }) =>
  l.description
    ? l.item
      ? `${l.description} (${itemName(l.item)})`
      : l.description
    : l.item
      ? itemName(l.item)
      : "";
const supplierName = (s: { name: string; code: string | null; approvalStatus: string }) =>
  `${s.name}${s.code ? ` (${s.code})` : ""}${s.approvalStatus === "approved" ? "" : `, ${s.approvalStatus}`}`;

/**
 * Purchasing module. Agents read orders, the shortfall proposal and supplier performance, draft and
 * edit orders and record deliveries. Sending, closing and cancelling are a person's, with tools only where an owner or admin allows
 * them under Settings → API access.
 */
export function registerPurchasingTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];
  const p = (api: Api) => ws(api).purchasing;

  /** An item by id or exact stock code (case-insensitive). */
  async function resolveItemId(api: Api, slug: string, ref: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { items } = await api.call(
      ws(api).items.$get({ param: { slug }, query: { q: wanted, status: "all", limit: "200" } }),
    );
    const match = items.filter((i) => i.code.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError("not_found", `No item has the code "${wanted}". Use list_items to find it.`);
  }

  /** A supplier by id, code or exact name (case-insensitive). */
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

  /** A location by id, code or exact name (case-insensitive). */
  async function resolveLocationId(api: Api, slug: string, ref: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { locations } = await api.call(
      ws(api).stock.locations.$get({ param: { slug }, query: { status: "all" } }),
    );
    const lower = wanted.toLowerCase();
    const byCode = locations.filter((l) => l.code?.toLowerCase() === lower);
    const match = byCode.length ? byCode : locations.filter((l) => l.name.toLowerCase() === lower);
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      match.length ? "ambiguous" : "not_found",
      match.length
        ? `More than one location is called "${wanted}"; pass its id.`
        : `No location is called "${wanted}". Locations: ${locations.map((l) => (l.code ? `${l.name} (${l.code})` : l.name)).join(", ") || "none yet (a person creates them in the app)"}.`,
    );
  }

  /** An order id, from an id or a reference such as PO-2026-001. */
  async function resolveOrderId(api: Api, slug: string, ref: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const upper = wanted.toUpperCase();
    const { orders } = await api.call(p(api).orders.$get({ param: { slug }, query: { q: upper } }));
    const hit = orders.find((o) => o.reference === upper);
    if (!hit)
      throw new ToolError(
        "not_found",
        `No purchase order has the reference "${ref}". References look like PO-2026-001; list_purchase_orders finds them.`,
      );
    return hit.id;
  }

  const getOrder = (api: Api, slug: string, id: string) =>
    api.call(p(api).orders[":id"].$get({ param: { slug, id } }));
  type Detail = Omit<Awaited<ReturnType<typeof getOrder>>, "supplierQuality"> & {
    /** Only the order read (GET) carries it; null when quality is off or unreadable. */
    supplierQuality?: { open: number; suggest: boolean; reasons: string[] } | null;
  };
  type Summary = Awaited<ReturnType<typeof listOrders>>["orders"][number];
  const listOrders = (api: Api, slug: string, query: Record<string, string>) =>
    api.call(p(api).orders.$get({ param: { slug }, query }));

  const header = (o: Summary | Detail) => ({
    reference: o.reference,
    state: o.state,
    supplier: supplierName(o.supplier),
    supplierReference: o.supplierReference,
    orderedOn: o.orderedOn,
    expectedOn: o.expectedOn,
    nextExpectedOn: o.nextExpectedOn,
    deliveryLocation: o.deliveryLocation?.name ?? null,
    overdue: o.overdue,
    lines: o.linesCount,
    outstandingLines: o.outstandingLines,
    value: o.value,
    valueComplete: o.valueComplete,
    notes: o.notes,
    ...(o.closeReason ? { closeReason: o.closeReason } : {}),
    ...(o.cancelReason ? { cancelReason: o.cancelReason } : {}),
  });

  const detailView = (o: Detail) => ({
    ...header(o),
    id: o.id,
    createdBy: o.createdByName,
    sent: o.sentAt ? { by: o.sentByName, at: o.sentAt } : null,
    // Above the workspace's threshold a manager other than the creator approves sending (a person).
    sendApproval: o.sendApproval?.state ?? "not_required",
    ...(o.supplierQuality?.open
      ? {
          supplierWarning: `${o.supplierQuality.open} open non-conformance(s) from this supplier${o.supplierQuality.suggest ? `; quality suggests reviewing its approval (${o.supplierQuality.reasons.join(", ")})` : ""}. Information only.`,
        }
      : {}),
    emailed: (o.emails ?? []).map((e) => `${e.status} to ${e.toEmail} at ${e.createdAt}`),
    orderLines: o.lines.map((l) => ({
      id: l.id,
      line: l.lineNo,
      kind: l.kind,
      item: lineName(l),
      ordered: qty(l.ordered, l.unit),
      received: qty(l.received, l.unit),
      rejected: qty(l.rejected, l.unit),
      outstanding: qty(l.outstanding, l.unit),
      state: l.state,
      unit: l.unit ?? l.unitLabel,
      ...(l.nominalCode ? { nominalCode: l.nominalCode } : {}),
      unitPrice: l.unitPrice,
      lineValue: l.lineValue,
      expectedOn: l.effectiveExpectedOn,
      ownExpectedOn: l.expectedOn,
      // The date promised when sent (supplier performance measures against it; edits don't move it).
      promisedOn: l.promisedOn,
      ...(l.promiseMoved ? { promiseMoved: true } : {}),
      overdue: l.overdue,
      supplierListed: l.supplierListed,
      notes: l.notes,
    })),
    deliveries: o.deliveries.map((d) => ({
      receivedOn: d.receivedOn,
      deliveryReference: d.deliveryReference,
      by: d.actorName,
      notes: d.notes,
      receipts: d.receipts.map((r) => ({
        line: r.lineNo,
        item: r.item ? itemName(r.item) : (o.lines.find((l) => l.id === r.lineId)?.description ?? null),
        outcome: r.outcome,
        quantity: qty(r.quantity),
        lot: r.lotCode,
        reason: r.reason,
        ...(r.overDeliveryReason ? { overDeliveryReason: r.overDeliveryReason } : {}),
        ...(r.reversed ? { reversed: true } : {}),
        ...(r.voided ? { voided: true } : {}),
      })),
    })),
  });

  define(
    "list_purchase_orders",
    {
      module: "purchasing",
      resource: { name: "purchase_orders", op: "list" },
      title: "List purchase orders",
      description:
        "Purchase orders, newest first, each with its supplier, state (draft, sent, part_received, received, closed, cancelled), next expected date, value (`valueComplete` is false when some lines have no price), outstanding lines and whether it is overdue. Status `open` = sent and not fully received. Filter by supplier (id, code or name), item (id or stock code), expected-date range or text (reference, supplier, supplier's reference). Use get_purchase_order for the lines.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        status: z.enum(purchaseOrderListStatuses).optional().describe("Default all."),
        supplier: z.string().max(200).optional().describe("Supplier id, code or exact name."),
        item: z.string().max(60).optional().describe("Item id or stock code: orders with a line for it."),
        from: isoDate.optional().describe("Expected on or after."),
        to: isoDate.optional().describe("Expected on or before."),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const [supplierId, itemId] = await Promise.all([
        a.supplier ? resolveSupplierId(api, slug, a.supplier) : undefined,
        a.item ? resolveItemId(api, slug, a.item) : undefined,
      ]);
      const page = await listOrders(api, slug, {
        ...(a.status ? { status: a.status } : {}),
        ...(supplierId ? { supplierId } : {}),
        ...(itemId ? { itemId } : {}),
        ...(a.from ? { from: a.from } : {}),
        ...(a.to ? { to: a.to } : {}),
        ...(a.search ? { q: a.search } : {}),
        limit: String(a.limit ?? 50),
        ...(a.offset ? { offset: String(a.offset) } : {}),
      });
      return { total: page.total, orders: page.orders.map(header) };
    },
  );

  define(
    "get_purchase_order",
    {
      module: "purchasing",
      resource: { name: "purchase_orders", op: "get" },
      title: "Get a purchase order",
      description:
        "One purchase order in full by its reference (PO-2026-001) or id: header, each line (with its `id`, `kind` (`stock`: an item received into stock; `non_stock`: a service, subscription or goods not kept in stock, named by its description, with its nominal code), quantities ordered, received, rejected and outstanding, price, expected date, the date promised when the order was sent (\`promisedOn\`; supplier performance measures against it, and re-dating a line doesn't move it), and whether the item is listed for this supplier) and every delivery with its lot codes (stock lines) and any rejections. Quantities are shown in the unit the line was ordered in.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        order_id: z.string().min(1).max(60).describe("Reference such as PO-2026-001, or the order id."),
      },
    },
    async ({ workspace, order_id }, api) => {
      const slug = await slugOf(api, workspace);
      return detailView(await getOrder(api, slug, await resolveOrderId(api, slug, order_id)));
    },
  );

  define(
    "send_purchase_order",
    {
      module: "purchasing",
      tokenAction: "purchasing.send",
      title: "Send a purchase order",
      description:
        "Mark a draft purchase order as sent to its supplier: a commitment to buy. This tool exists because an owner or admin allowed API tokens to send orders under Settings → API access; the token's owner needs manage access to the purchasing module. The order (reference such as PO-2026-001, or id) must be a draft with at least one line and an expected date on the order or on every line, and its supplier must not be suspended or rejected; the expected dates become the dates promised to the supplier. `ordered_on` defaults to today and can't be in the future. Sending does not email the supplier (email_purchase_order does). Check the order with get_purchase_order and the user's wish first: only send what the user asked you to send. Returns the order.",
      annotations: DRAFT,
      input: {
        workspace: workspaceParam,
        order_id: z.string().min(1).max(60).describe("Reference such as PO-2026-001, or the order id."),
        ordered_on: isoDate.optional().describe("Date the order was placed (default today)."),
        supplier_reference: z.string().max(120).optional().describe("The supplier's own reference."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveOrderId(api, slug, a.order_id);
      return detailView(
        await api.call(
          p(api).orders[":id"].send.$post({
            param: { slug, id },
            json: {
              ...(a.ordered_on ? { orderedOn: a.ordered_on } : {}),
              ...(a.supplier_reference ? { supplierReference: a.supplier_reference } : {}),
            },
          }),
        ),
      );
    },
  );

  define(
    "email_purchase_order",
    {
      module: "purchasing",
      tokenAction: "purchasing.send",
      title: "Email a purchase order to its supplier",
      description:
        "Email a sent purchase order to its supplier: a plain summary of the order (reference, dates, delivery location, lines with quantity and price, total, notes) with no links. This tool exists because an owner or admin allowed API tokens to send orders under Settings → API access (it is part of sending); the token's owner needs manage access to the purchasing module. Only a sent order can be emailed (send it first). `to` defaults to the supplier's email in the supplier register; without either the call is refused. `message` is an optional short covering note. Every attempt is logged on the order (see get_purchase_order). Emailing twice sends two emails, so only email what the user asked you to. When the server has no mail setup or the mail server fails, the result says `emailed: false` with the reason and the order is unchanged. Returns whether it was emailed, to whom, and the order's email log.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      input: {
        workspace: workspaceParam,
        order_id: z.string().min(1).max(60).describe("Reference such as PO-2026-001, or the order id."),
        to: z.email().max(254).optional().describe("Recipient; default the supplier's email."),
        message: z.string().max(1000).optional().describe("A short covering note above the order."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveOrderId(api, slug, a.order_id);
      const res = await api.call(
        p(api).orders[":id"].email.$post({
          param: { slug, id },
          json: { ...(a.to ? { to: a.to } : {}), ...(a.message ? { message: a.message } : {}) },
        }),
      );
      return {
        emailed: res.emailed,
        to: res.to,
        ...(res.mailError ? { problem: res.mailError } : {}),
        order: res.order.reference,
        emails: res.order.emails.map((e) => ({
          to: e.toEmail,
          status: e.status,
          at: e.createdAt,
          ...(e.error ? { error: e.error } : {}),
        })),
      };
    },
  );

  define(
    "list_supplier_prices",
    {
      module: "purchasing",
      resource: { name: "supplier_prices", op: "list" },
      title: "List supplier prices",
      description:
        "Read the supplier price lists: what a supplier charges for an item, per a unit, with the dates it is in force (effective from, and to when it ends). The price in force on an order's date is what a new order line from that supplier defaults to (draft_purchase_order takes it when no unit_price is given). Filter by supplier (id, code or exact name), item (id or stock code) and `on` (only prices in force on that date, default no date filter, `inForce` still says whether each is in force today). Read-only: prices are entered and ended in the app. Newest effective date first within each supplier and item.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        supplier: z.string().max(200).optional().describe("Supplier id, code or exact name."),
        item: z.string().max(200).optional().describe("Item id or stock code."),
        on: isoDate.optional().describe("Only prices in force on this date."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 100."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const [supplierId, itemId] = await Promise.all([
        a.supplier ? resolveSupplierId(api, slug, a.supplier) : undefined,
        a.item ? resolveItemId(api, slug, a.item) : undefined,
      ]);
      const res = await api.call(
        p(api).prices.$get({
          param: { slug },
          query: {
            ...(supplierId ? { supplierId } : {}),
            ...(itemId ? { itemId } : {}),
            ...(a.on ? { on: a.on } : {}),
            limit: String(a.limit ?? 100),
          },
        }),
      );
      return {
        total: res.total,
        prices: res.prices.map((r) => ({
          id: r.id,
          supplier: r.supplier.name,
          item: itemName(r.item),
          price: r.unitPrice,
          unit: r.unit,
          effectiveFrom: r.effectiveFrom,
          effectiveTo: r.effectiveTo,
          inForce: r.inForce,
          notes: r.notes,
        })),
      };
    },
  );

  define(
    "close_purchase_order",
    {
      module: "purchasing",
      tokenAction: "purchasing.close",
      title: "Close a purchase order",
      description:
        "Close a sent purchase order short: nothing more is expected from the supplier (a short close counts against in-full delivery in supplier performance). This tool exists because an owner or admin allowed API tokens to close orders under Settings → API access; the token's owner needs write access to the purchasing module. Only a sent order can be closed (a draft is cancelled instead). A reason is required. Closed orders can't be edited or received against. Returns the order.",
      annotations: DRAFT,
      input: {
        workspace: workspaceParam,
        order_id: z.string().min(1).max(60).describe("Reference such as PO-2026-001, or the order id."),
        reason: z.string().min(1).max(500).describe("Why nothing more is expected."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveOrderId(api, slug, a.order_id);
      return detailView(
        await api.call(p(api).orders[":id"].close.$post({ param: { slug, id }, json: { reason: a.reason } })),
      );
    },
  );

  define(
    "cancel_purchase_order",
    {
      module: "purchasing",
      tokenAction: "purchasing.cancel",
      title: "Cancel a purchase order",
      description:
        "Cancel a draft or sent purchase order. This tool exists because an owner or admin allowed API tokens to cancel orders under Settings → API access; the token's owner needs write access to the purchasing module. Refused with `has_receipts` once goods have been accepted against the order (close it instead), and for orders already closed or cancelled. A reason is required. Returns the order.",
      annotations: DRAFT,
      input: {
        workspace: workspaceParam,
        order_id: z.string().min(1).max(60).describe("Reference such as PO-2026-001, or the order id."),
        reason: z.string().min(1).max(500).describe("Why the order is cancelled."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveOrderId(api, slug, a.order_id);
      return detailView(
        await api.call(
          p(api).orders[":id"].cancel.$post({ param: { slug, id }, json: { reason: a.reason } }),
        ),
      );
    },
  );

  define(
    "draft_purchase_order",
    {
      module: "purchasing",
      title: "Draft or edit a purchase order",
      description: `Create a draft purchase order, or, with \`order_id\`, edit a draft or sent order. A draft needs a supplier (id, code or exact name; suspended or rejected suppliers are refused, a pending one may be ordered from) and may have lines of two kinds. A **stock** line (the default \`kind\`) is an ingredient or packaging item received into stock: an item (id or stock code), quantity and unit (${UNIT_HELP}); a price per unit is optional and defaults to the supplier's price list or the item's standard cost (\`unit_price: null\` = unknown); it needs the stock module. A **non_stock** line is a service, subscription or goods not kept in stock (cleaning, a software licence, office supplies): a \`description\`, quantity, optional free-text \`unit\` (hour, month, visit), price, optional \`nominal_code\` (the expense account it is coded to) and optionally an \`item\` it refers to; it is received without a lot. A delivery location only applies to stock lines. IMPORTANT when editing: \`lines\` replaces the whole list. Lines you leave out are removed, so pass every line you want to keep. Pass an existing line's \`id\` (from get_purchase_order) to keep and edit that line, leaving out fields you do not want to change (price, date and notes, plus item, unit and nominal code on non-stock lines); a line without an \`id\` is new. A sent order's supplier can't change, lines with receipts can't be removed, no quantity can go below what was accepted, it must keep at least one line and an expected date for every line, and while its supplier is suspended or rejected no line can be added or increased; closed and cancelled orders can't be edited. Use null to clear an optional item, unit or nominal code on a non-stock line. Needs an expected date on the order or on every line before a person can send it. ${PERSON_ONLY}`,
      annotations: DRAFT,
      input: {
        workspace: workspaceParam,
        order_id: z
          .string()
          .max(60)
          .optional()
          .describe("Reference (PO-2026-001) or id of the order to edit. Leave out to create a draft."),
        supplier: z
          .string()
          .max(200)
          .optional()
          .describe("Supplier id, code or exact name. Required for a new draft."),
        expected_on: isoDate.nullable().optional().describe("Requested delivery date; null clears it."),
        delivery_location: z
          .string()
          .max(200)
          .nullable()
          .optional()
          .describe("Default receiving location: id, code or exact name; null clears it."),
        supplier_reference: z.string().max(120).optional().describe("The supplier's confirmation number."),
        notes: z.string().max(4000).optional(),
        lines: z
          .array(
            z.object({
              id: z
                .uuid()
                .optional()
                .describe("An existing line's id (editing only): keeps that line and its receipts."),
              kind: z
                .enum(purchaseOrderLineKinds)
                .optional()
                .describe(
                  "stock (default): an item into stock. non_stock: a service or goods not kept in stock.",
                ),
              item: z
                .string()
                .min(1)
                .max(60)
                .nullable()
                .optional()
                .describe("Item id or stock code. Required on stock lines; optional on non_stock lines."),
              description: z
                .string()
                .min(1)
                .max(500)
                .optional()
                .describe("non_stock lines (required): what is bought, e.g. 'Window cleaning, March'."),
              quantity: z.number().positive(),
              unit: z
                .string()
                .max(PURCHASE_UNIT_LABEL_MAX)
                .nullable()
                .optional()
                .describe(
                  `Stock lines (required): ${UNIT_HELP} non_stock lines: any unit as text (hour, month, visit), or leave out.`,
                ),
              nominal_code: z
                .string()
                .max(PURCHASE_NOMINAL_CODE_MAX)
                .nullable()
                .optional()
                .describe("non_stock lines: the expense account or nominal code it is coded to (e.g. 7500)."),
              unit_price: z
                .number()
                .min(0)
                .nullable()
                .optional()
                .describe(
                  "Per `unit`. Left out: stock lines take the price list or standard cost (new lines); otherwise unchanged or unknown.",
                ),
              expected_on: isoDate
                .nullable()
                .optional()
                .describe("Overrides the order's date for this line."),
              notes: z.string().max(2000).optional(),
            }),
          )
          .max(200)
          .optional()
          .describe("The complete list of lines. When editing it replaces the existing lines."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const [supplierId, locationId, lines] = await Promise.all([
        a.supplier ? resolveSupplierId(api, slug, a.supplier) : undefined,
        a.delivery_location ? resolveLocationId(api, slug, a.delivery_location) : undefined,
        a.lines
          ? Promise.all(
              a.lines.map(async (l, i) => {
                const common = {
                  ...(l.id ? { id: l.id } : {}),
                  quantity: l.quantity,
                  ...(l.unit_price !== undefined ? { unitPrice: l.unit_price } : {}),
                  ...(l.expected_on !== undefined ? { expectedOn: l.expected_on } : {}),
                  ...(l.notes !== undefined ? { notes: l.notes } : {}),
                };
                if (l.kind === "non_stock") {
                  if (!l.description)
                    throw new ToolError(
                      "invalid_input",
                      `Line ${i + 1}: a non_stock line needs a \`description\`.`,
                    );
                  return {
                    ...common,
                    kind: "non_stock" as const,
                    description: l.description,
                    ...(l.item === undefined
                      ? {}
                      : { itemId: l.item === null ? null : await resolveItemId(api, slug, l.item) }),
                    ...(l.unit === undefined ? {} : { unit: l.unit }),
                    ...(l.nominal_code === undefined ? {} : { nominalCode: l.nominal_code }),
                  };
                }
                if (!l.item)
                  throw new ToolError(
                    "invalid_input",
                    `Line ${i + 1}: a stock line needs an \`item\` (or set kind: non_stock with a description).`,
                  );
                if (!l.unit || !(unitCodes as readonly string[]).includes(l.unit))
                  throw new ToolError(
                    "invalid_input",
                    `Line ${i + 1}: a stock line's unit is one of ${unitCodes.join(", ")}; free-text units are for non_stock lines.`,
                  );
                if (l.description || l.nominal_code)
                  throw new ToolError(
                    "invalid_input",
                    `Line ${i + 1}: description and nominal_code are for non_stock lines.`,
                  );
                return {
                  ...common,
                  kind: "stock" as const,
                  itemId: await resolveItemId(api, slug, l.item),
                  unit: l.unit as (typeof unitCodes)[number],
                };
              }),
            )
          : undefined,
      ]);
      const fields = {
        ...(a.expected_on !== undefined ? { expectedOn: a.expected_on } : {}),
        ...(a.delivery_location === null
          ? { deliveryLocationId: null }
          : locationId
            ? { deliveryLocationId: locationId }
            : {}),
        ...(a.supplier_reference !== undefined ? { supplierReference: a.supplier_reference } : {}),
        ...(a.notes !== undefined ? { notes: a.notes } : {}),
      };

      if (!a.order_id) {
        if (!supplierId) throw new ToolError("invalid_input", "A new draft needs a `supplier`.");
        if (lines?.some((l) => l.id))
          throw new ToolError("invalid_input", "Line ids only apply when editing an existing order.");
        const created = await api.call(
          p(api).orders.$post({
            param: { slug },
            json: { supplierId, ...fields, ...(lines ? { lines } : {}) },
          }),
        );
        return detailView(created);
      }

      const json = {
        ...(supplierId ? { supplierId } : {}),
        ...fields,
        ...(lines ? { lines } : {}),
      };
      if (!Object.keys(json).length) throw new ToolError("invalid_input", "Nothing to update");
      const id = await resolveOrderId(api, slug, a.order_id);
      return detailView(await api.call(p(api).orders[":id"].$patch({ param: { slug, id }, json })));
    },
  );

  const acceptedLine = z.object({
    line: z.union([z.number().int().min(1), z.string().min(1)]).describe("Line number (1, 2, …) or line id."),
    outcome: z.literal("accepted"),
    quantity: z.number().positive(),
    unit: z
      .enum(unitCodes)
      .optional()
      .describe(
        "Stock lines only. Default: the line's own unit. non_stock lines are counted in their own unit.",
      ),
    location: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Stock lines: where it goes (location id, code or exact name); default the order's delivery location. Leave out for non_stock lines.",
      ),
    lot_code: z.string().max(60).optional().describe("Our lot code; generated when left out."),
    supplier_lot_code: z.string().max(80).optional().describe("The supplier's own batch code."),
    expires_on: isoDate.optional(),
    expiry_type: z.enum(expiryTypes).optional().describe("use_by or best_before; needed with expires_on."),
    quarantine: z
      .boolean()
      .optional()
      .describe("Receive into quarantine. Required while the supplier is pending approval."),
    unit_price: z
      .number()
      .min(0)
      .nullable()
      .optional()
      .describe("Invoice price per `unit`, when it differs from the order's."),
    over_delivery_reason: z
      .string()
      .max(500)
      .optional()
      .describe("Needed when the workspace has an over-delivery tolerance and this takes the line past it."),
  });
  const rejectedLine = z.object({
    line: z.union([z.number().int().min(1), z.string().min(1)]).describe("Line number (1, 2, …) or line id."),
    outcome: z.literal("rejected"),
    quantity: z.number().positive(),
    unit: z
      .enum(unitCodes)
      .optional()
      .describe(
        "Stock lines only. Default: the line's own unit. non_stock lines are counted in their own unit.",
      ),
    reason: z.string().min(1).max(500).describe("Why it was refused."),
  });

  define(
    "receive_purchase_order",
    {
      module: "purchasing",
      title: "Receive a delivery against an order",
      description: `Record one delivery against a sent order. Each line is \`accepted\` or \`rejected\` (turned away at the door: recorded with a reason, creates no stock). An accepted **stock** line creates a lot with the order's supplier and goes into stock at a location (default the order's delivery location) with a goods-in movement referencing the order; quantities are in \`unit\` (${UNIT_HELP} default: the line's unit). An accepted **non_stock** line (a service or goods not kept in stock) records only the quantity received, in the line's own unit: leave out unit, location and the lot fields. Over-delivery is allowed unless the workspace sets a tolerance: past it a line needs an over_delivery_reason. The order must be sent (not draft, closed or cancelled). Accepted goods from a supplier that is suspended or rejected are refused (a delivery of only rejected lines is still recorded); a supplier still pending approval can only be received into quarantine, so pass \`quarantine: true\` on every accepted line. Accepted lines of an item archived or no longer an ingredient or packaging are refused. Accepted lines may carry the supplier's lot code, an expiry date with its type (use_by or best_before) and the invoice price. Everything is checked first and nothing is saved if any line is wrong. ${PERSON_ONLY}`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        command_id: z
          .uuid()
          .optional()
          .describe("Stable request ID: reuse it when retrying this delivery after a lost response."),
        order_id: z.string().min(1).max(60).describe("Reference such as PO-2026-001, or the order id."),
        received_on: isoDate.describe("YYYY-MM-DD, not in the future."),
        delivery_reference: z.string().max(120).optional().describe("The delivery note number."),
        notes: z.string().max(2000).optional(),
        lines: z
          .array(z.discriminatedUnion("outcome", [acceptedLine, rejectedLine]))
          .min(1)
          .max(100),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveOrderId(api, slug, a.order_id);
      const order = await getOrder(api, slug, id);
      const lineId = (ref: number | string) => {
        const wanted = String(ref).trim();
        const hit = order.lines.find((l) => l.id === wanted || String(l.lineNo) === wanted);
        if (!hit)
          throw new ToolError(
            "invalid_input",
            `${order.reference} has no line "${wanted}". It has lines 1 to ${order.lines.length}.`,
          );
        return hit;
      };
      const lines = await Promise.all(
        a.lines.map(async (l) => {
          const line = lineId(l.line);
          const stock = line.kind === "stock";
          if (!stock && l.unit)
            throw new ToolError(
              "invalid_input",
              `Line ${line.lineNo} is a non_stock line: give the quantity in its own unit${line.unitLabel ? ` (${line.unitLabel})` : ""} and leave out \`unit\`.`,
            );
          const unit = stock ? (l.unit ?? line.unit ?? undefined) : undefined;
          if (l.outcome === "rejected")
            return {
              lineId: line.id,
              outcome: "rejected" as const,
              quantity: l.quantity,
              ...(unit ? { unit } : {}),
              reason: l.reason,
            };
          if (
            !stock &&
            (l.location ||
              l.lot_code ||
              l.supplier_lot_code ||
              l.expires_on ||
              l.expiry_type ||
              l.quarantine !== undefined)
          )
            throw new ToolError(
              "invalid_input",
              `Line ${line.lineNo} is a non_stock line: nothing goes into stock, so leave out location, lot and expiry fields.`,
            );
          return {
            lineId: line.id,
            outcome: "accepted" as const,
            quantity: l.quantity,
            ...(unit ? { unit } : {}),
            ...(l.location ? { locationId: await resolveLocationId(api, slug, l.location) } : {}),
            ...(l.lot_code ? { lotCode: l.lot_code } : {}),
            ...(l.supplier_lot_code ? { supplierLotCode: l.supplier_lot_code } : {}),
            ...(l.expires_on ? { expiresOn: l.expires_on } : {}),
            ...(l.expiry_type ? { expiryType: l.expiry_type } : {}),
            ...(l.quarantine !== undefined
              ? { status: l.quarantine ? ("quarantine" as const) : ("available" as const) }
              : {}),
            ...(l.unit_price !== undefined ? { unitPrice: l.unit_price } : {}),
            ...(l.over_delivery_reason ? { overDeliveryReason: l.over_delivery_reason } : {}),
          };
        }),
      );
      const res = await api.call(
        p(api).orders[":id"].receipts.$post({
          param: { slug, id },
          json: {
            receivedOn: a.received_on,
            ...(a.command_id ? { commandId: a.command_id } : {}),
            ...(a.delivery_reference ? { deliveryReference: a.delivery_reference } : {}),
            ...(a.notes ? { notes: a.notes } : {}),
            lines,
          },
        }),
      );
      const after = res.order;
      return {
        reference: after.reference,
        state: after.state,
        received: res.receipts.map((r) => {
          const line = after.lines.find((l) => l.id === r.lineId);
          return {
            line: line?.lineNo ?? null,
            item: line ? lineName(line) : r.item ? itemName(r.item) : null,
            outcome: r.outcome,
            quantity: qty(r.quantity, line?.unit),
            lot: r.lotCode,
            reason: r.reason,
          };
        }),
        outstanding: after.lines
          .filter((l) => l.outstanding.base > 0)
          .map((l) => ({ line: l.lineNo, item: lineName(l), outstanding: qty(l.outstanding, l.unit) })),
      };
    },
  );

  define(
    "suggest_purchase_orders",
    {
      module: "purchasing",
      // The shortfall is production's (which needs stock): without it there is nothing to suggest.
      requiresModules: ["production"],
      title: "Suggest purchase orders",
      description:
        "What to buy to cover the planned production: the material shortfall for the window (default today to 28 days ahead, at most a year) minus what is already outstanding on sent orders, grouped by suggested supplier (the item's preferred or only supplier; items with no clear supplier come last under `supplier: null`). Each suggestion gives the shortfall, on order, on draft (shown but not subtracted), the quantity to order in its unit, the standard cost as the price, the date it is needed by and the other suppliers who could supply it. `covered` lists items sent orders already cover. `notPurchasable` lists items in the shortfall that can't be bought (reason `made_in_house` for work in progress and finished goods: plan their production instead; `archived` for archived items). Nothing is created: to order, call draft_purchase_order with the supplier and these lines (item, quantity, unit, unit_price, expected_on). Only offered where the production module is on and readable. Suggestions are stock lines only. Sending the drafts is a person's act in the app.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        from: isoDate.optional(),
        to: isoDate.optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const res = await api.call(
        p(api).suggestions.$get({
          param: { slug },
          query: { ...(a.from ? { from: a.from } : {}), ...(a.to ? { to: a.to } : {}) },
        }),
      );
      type S = (typeof res.covered)[number];
      const view = (s: S) => ({
        item: itemName(s.item),
        shortfall: qty(s.shortfall),
        onOrder: qty(s.onOrder),
        onDraft: qty(s.onDraft),
        toOrder: qty(s.toOrder),
        quantity: s.quantity,
        unit: s.unit,
        unitPrice: s.unitPrice,
        neededBy: s.neededBy,
        expectedOn: s.expectedOn,
        ...(s.incomplete ? { incomplete: true } : {}),
        otherSuppliers: s.otherSuppliers.map(supplierName),
      });
      return {
        from: res.from,
        to: res.to,
        groups: res.groups.map((g) => ({
          supplier: g.supplier ? supplierName(g.supplier) : null,
          suggestions: g.suggestions.map(view),
        })),
        covered: res.covered.map((s) => ({
          item: itemName(s.item),
          shortfall: qty(s.shortfall),
          onOrder: qty(s.onOrder),
        })),
        notPurchasable: res.notPurchasable.map((r) => ({
          item: itemName(r.item),
          shortfall: qty(r.shortfall),
          reason: r.reason,
        })),
      };
    },
  );

  define(
    "supplier_performance",
    {
      module: "purchasing",
      title: "Supplier performance",
      description:
        "On-time, in-full and OTIF percentages per supplier over a period (default the last 90 days), from the lines (stock and non-stock) of sent and closed orders whose promised date (the expected date when the order was sent; later re-dating doesn't move it) fell in the period, plus the deliveries received and how many had something rejected (cancelled orders' deliveries included). Percentages are null when no line was due. Suppliers sorted by name.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        from: isoDate.optional(),
        to: isoDate.optional(),
        supplier: z.string().max(200).optional().describe("Supplier id, code or exact name."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const supplierId = a.supplier ? await resolveSupplierId(api, slug, a.supplier) : undefined;
      const res = await api.call(
        p(api)["supplier-performance"].$get({
          param: { slug },
          query: {
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
            ...(supplierId ? { supplierId } : {}),
          },
        }),
      );
      return {
        from: res.from,
        to: res.to,
        suppliers: res.suppliers.map((s) => ({
          supplier: supplierName(s.supplier),
          linesDue: s.linesDue,
          onTime: s.onTime,
          inFull: s.inFull,
          otif: s.otif,
          onTimePercent: s.onTimePercent,
          inFullPercent: s.inFullPercent,
          otifPercent: s.otifPercent,
          deliveries: s.deliveries,
          rejectedDeliveries: s.rejectedDeliveries,
        })),
      };
    },
  );
}
