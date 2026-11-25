import { expiryTypes, itemTypes, lotStatuses, unitCodes } from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Writes that remove or invent stock on the books, or post final counts; only a person can reverse them. */
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/** How many reference lookups one tool call runs at once. */
const LOOKUP_CONCURRENCY = 8;

/** `Promise.all` over `items`, with at most `limit` calls of `fn` in flight; stops at the first error. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIT_HELP = "mg, g, kg (weight); ml, l (volume); each (count).";
const PERSON_ONLY =
  "Lot status (quarantine, release, reject) and reversals are done by a person in the app; there are no tools for them. Waste, adjustments and stocktakes are too, unless an owner or admin allows them under Settings → API access (record_stock_waste, adjust_stock and post_stocktake then appear).";

/**
 * Stock module: levels, lots with traceability, FEFO pick suggestions, goods-in and transfers.
 * Quantities come back as `{ base, baseUnit, display, displayUnit }`: the ledger's base unit
 * (g, ml, each) and the item's own unit.
 */
export function registerStockTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];

  /** An item by id or exact stock code (case-insensitive). */
  async function resolveItemId(api: Api, slug: string, ref: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { items } = await api.call(
      ws(api).items.$get({ param: { slug }, query: { q: wanted, status: "all", limit: "200" } }),
    );
    const match = items.filter((i) => i.code.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      "not_found",
      `No item has the code "${wanted}". Use list_items to find it, then pass its id or exact code.`,
    );
  }

  type LocationList = Awaited<ReturnType<typeof listLocations>>;
  const listLocations = async (api: Api, slug: string) =>
    (await api.call(ws(api).stock.locations.$get({ param: { slug }, query: { status: "all" } }))).locations;

  /** A location by id, code or exact name (case-insensitive). Pass `known` to reuse a fetched list. */
  async function resolveLocationId(
    api: Api,
    slug: string,
    ref: string,
    known?: () => Promise<LocationList>,
  ): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const locations = await (known ? known() : listLocations(api, slug));
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

  /** A lot by id, or by lot code (exact, case-insensitive; pass the item when codes repeat). */
  async function resolveLotId(
    api: Api,
    slug: string,
    ref: string,
    item?: string,
    itemOf: (ref: string) => Promise<string> = (r) => resolveItemId(api, slug, r),
  ): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const itemId = item ? await itemOf(item) : undefined;
    const { lots } = await api.call(
      ws(api).stock.lots.$get({
        param: { slug },
        query: { q: wanted, includeEmpty: "true", limit: "200", ...(itemId ? { itemId } : {}) },
      }),
    );
    const match = lots.filter((l) => l.lotCode.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      match.length ? "ambiguous" : "not_found",
      match.length
        ? `Several items have a lot "${wanted}"; pass \`item\` or the lot id.`
        : `No lot has the code "${wanted}". Use list_stock_lots to find it.`,
    );
  }

  /**
   * Lookups for one call that resolves many references (a stocktake of up to 500 counts): the
   * location list is fetched once, each distinct item and lot reference is looked up once, and
   * lookups run a few at a time, so a large call stays well inside the token's read budget.
   */
  function batchResolver(api: Api, slug: string) {
    const memo = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
      let hit = cache.get(key);
      if (!hit) {
        hit = load();
        cache.set(key, hit);
      }
      return hit;
    };
    let locations: Promise<LocationList> | undefined;
    const knownLocations = () => (locations ??= listLocations(api, slug));
    const items = new Map<string, Promise<string>>();
    const lots = new Map<string, Promise<string>>();
    const locationIds = new Map<string, Promise<string>>();
    const item = (ref: string) => memo(items, ref.trim().toLowerCase(), () => resolveItemId(api, slug, ref));
    return {
      item,
      location: (ref: string) =>
        memo(locationIds, ref.trim().toLowerCase(), () => resolveLocationId(api, slug, ref, knownLocations)),
      lot: (ref: string, itemRef?: string) =>
        memo(lots, `${ref.trim().toLowerCase()}\u0000${itemRef?.trim().toLowerCase() ?? ""}`, () =>
          resolveLotId(api, slug, ref, itemRef, item),
        ),
    };
  }

  type LotPage = Awaited<ReturnType<typeof listLots>>;
  const listLots = (api: Api, slug: string, query: Record<string, string>) =>
    api.call(ws(api).stock.lots.$get({ param: { slug }, query }));
  const lotView = (l: LotPage["lots"][number]) => ({
    id: l.id,
    lotCode: l.lotCode,
    item: { id: l.item.id, code: l.item.code, name: l.item.name },
    status: l.status,
    receivedOn: l.receivedOn,
    expiresOn: l.expiresOn,
    expiryType: l.expiryType,
    expiryState: l.expiryState,
    supplierName: l.supplierName,
    supplierLotCode: l.supplierLotCode,
    onHand: l.onHand,
    balances: l.balances.map((b) => ({
      location: b.locationName,
      locationId: b.locationId,
      amount: b.amount,
    })),
  });

  const page = (offset: number, returned: number, total: number) => ({
    total,
    offset,
    returned,
    hasMore: offset + returned < total,
  });

  define(
    "get_stock_levels",
    {
      module: "stock",
      title: "Get stock levels",
      description:
        "Stock on hand per item: total, the split between available, quarantine and rejected lots, how many lots and the earliest expiry. Filter by `query` (item name or code), `item_type`, `location` (id, code or name), `expiring_within_days`; `include_zero` adds active items with no stock. Paged with `offset` while `hasMore` is true.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        query: z.string().max(200).optional(),
        item_type: z.enum(itemTypes).optional(),
        location: z.string().max(200).optional().describe("Location id, code or exact name."),
        expiring_within_days: z.number().int().min(0).max(3650).optional(),
        include_zero: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum rows (default 50, max 200)."),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const locationId = a.location ? await resolveLocationId(api, slug, a.location) : undefined;
      const res = await api.call(
        ws(api).stock.levels.$get({
          param: { slug },
          query: {
            ...(a.query ? { q: a.query } : {}),
            ...(a.item_type ? { itemType: a.item_type } : {}),
            ...(locationId ? { locationId } : {}),
            ...(a.expiring_within_days !== undefined
              ? { expiringWithinDays: String(a.expiring_within_days) }
              : {}),
            ...(a.include_zero ? { includeZero: "true" } : {}),
            limit: String(a.limit ?? 50),
            offset: String(a.offset ?? 0),
          },
        }),
      );
      return {
        levels: res.levels.map((l) => ({
          item: { id: l.item.id, code: l.item.code, name: l.item.name, type: l.item.type },
          onHand: l.onHand,
          available: l.available,
          quarantine: l.quarantine,
          rejected: l.rejected,
          lotCount: l.lotCount,
          earliestExpiry: l.earliestExpiry,
          expiryState: l.expiryState,
        })),
        ...page(res.offset, res.levels.length, res.total),
      };
    },
  );

  define(
    "list_stock_lots",
    {
      module: "stock",
      resource: { name: "stock_lots", op: "list" },
      title: "List stock lots",
      description:
        "Lots (batches) in first-expired-first-out order, each with its balance per location, status (available, quarantine, rejected), expiry and supplier lot code. Filter by `item` (id or code), `status`, `location`, `query` (our lot code or the supplier's), and `expiring_within_days` (e.g. 7 for lots expiring within a week, including those already expired). Only lots with stock unless `include_empty`.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        item: z.string().max(200).optional().describe("Item id or exact code."),
        status: z.enum(lotStatuses).optional(),
        location: z.string().max(200).optional().describe("Location id, code or exact name."),
        query: z.string().max(200).optional(),
        expiring_within_days: z.number().int().min(0).max(3650).optional(),
        include_empty: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum lots (default 50, max 200)."),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const itemId = a.item ? await resolveItemId(api, slug, a.item) : undefined;
      const locationId = a.location ? await resolveLocationId(api, slug, a.location) : undefined;
      const res = await listLots(api, slug, {
        ...(itemId ? { itemId } : {}),
        ...(a.status ? { status: a.status } : {}),
        ...(locationId ? { locationId } : {}),
        ...(a.query ? { q: a.query } : {}),
        ...(a.expiring_within_days !== undefined
          ? { expiringWithinDays: String(a.expiring_within_days) }
          : {}),
        ...(a.include_empty ? { includeEmpty: "true" } : {}),
        limit: String(a.limit ?? 50),
        offset: String(a.offset ?? 0),
      });
      return { lots: res.lots.map(lotView), ...page(res.offset, res.lots.length, res.total) };
    },
  );

  define(
    "get_stock_lot",
    {
      module: "stock",
      resource: { name: "stock_lots", op: "get" },
      title: "Get stock lot (traceability)",
      description:
        "One lot by id or lot code: its item, supplier and the supplier's lot code (one step back), QA status with who changed it, balances per location, and every movement in the ledger in order (goods-in, transfers, waste, adjustments, stocktakes, reversals) with who posted it. Use it to trace a lot.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        lot: z.string().min(1).max(200).describe("Lot id or lot code."),
        item: z.string().max(200).optional().describe("Item id or code, when lot codes repeat across items."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveLotId(api, slug, a.lot, a.item);
      const lot = await api.call(ws(api).stock.lots[":id"].$get({ param: { slug, id } }));
      return {
        id: lot.id,
        lotCode: lot.lotCode,
        item: lot.item,
        status: lot.status,
        statusChangedAt: lot.statusChangedAt,
        statusChangedBy: lot.statusChangedByName,
        statusNote: lot.statusNote,
        receivedOn: lot.receivedOn,
        expiresOn: lot.expiresOn,
        expiryType: lot.expiryType,
        expiryState: lot.expiryState,
        supplier: lot.supplier,
        supplierLotCode: lot.supplierLotCode,
        notes: lot.notes,
        onHand: lot.onHand,
        balances: lot.balances.map((b) => ({
          location: b.locationName,
          locationId: b.locationId,
          amount: b.amount,
        })),
        movements: lot.movements.map((m) => ({
          id: m.id,
          type: m.type,
          amount: m.amount,
          location: m.locationName,
          occurredAt: m.occurredAt,
          by: m.actorName,
          reason: m.reason,
          reference: m.reference,
          ...(m.transferId ? { transferId: m.transferId } : {}),
          ...(m.reversesMovementId ? { reversesMovementId: m.reversesMovementId } : {}),
          ...(m.reversed ? { reversed: true } : {}),
        })),
      };
    },
  );

  define(
    "suggest_stock_pick",
    {
      module: "stock",
      title: "Suggest a FEFO stock pick",
      description:
        "Which lots to use for a quantity of an item, first expired first out: available lots only (never quarantined, rejected or past a use-by date), earliest expiry first, lots with no expiry last. Lots past a best-before date are flagged `pastBestBefore`. Reports any `shortfall`. A suggestion only: nothing is reserved or moved.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        item: z.string().min(1).max(200).describe("Item id or exact code."),
        quantity: z.number().positive(),
        unit: z.enum(unitCodes).describe(UNIT_HELP),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const itemId = await resolveItemId(api, slug, a.item);
      const res = await api.call(
        ws(api).stock.items[":itemId"].pick.$get({
          param: { slug, itemId },
          query: { quantity: String(a.quantity), unit: a.unit },
        }),
      );
      return {
        item: { id: res.item.id, code: res.item.code, name: res.item.name },
        required: res.required,
        allocated: res.allocated,
        shortfall: res.shortfall,
        allocations: res.allocations.map((x) => ({
          lotId: x.lotId,
          lotCode: x.lotCode,
          location: x.locationName,
          locationId: x.locationId,
          expiresOn: x.expiresOn,
          expiryType: x.expiryType,
          pastBestBefore: x.pastBestBefore,
          amount: x.amount,
        })),
      };
    },
  );

  define(
    "receive_stock",
    {
      module: "stock",
      title: "Receive stock (goods-in)",
      description: `Record a delivery: creates a lot and its goods-in movement. Choose a purchasable stock item. Give the item (id or code), quantity and unit (converted to the item's unit; ${UNIT_HELP}), location and received date. Pass the supplier and the supplier's own lot code for traceability, and the expiry date with its type when the label shows one (otherwise the item's shelf life sets a best-before date). A suspended or rejected supplier is refused, and a supplier pending approval can only deliver into quarantine (\`quarantine: true\`). The lot code is generated when left out. ${PERSON_ONLY}`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        command_id: z
          .uuid()
          .optional()
          .describe("Stable request ID: reuse it when retrying this delivery after a lost response."),
        item: z.string().min(1).max(200).describe("Item id or exact code."),
        quantity: z.number().positive(),
        unit: z.enum(unitCodes),
        location: z.string().min(1).max(200).describe("Location id, code or exact name."),
        received_on: z.iso.date().describe("YYYY-MM-DD."),
        supplier: z.string().max(200).optional().describe("Supplier id, code or exact name."),
        supplier_lot_code: z.string().max(80).optional(),
        lot_code: z.string().max(60).optional().describe("Our lot code; generated when left out."),
        expires_on: z.iso.date().optional().describe("YYYY-MM-DD; needs expiry_type."),
        expiry_type: z.enum(expiryTypes).optional(),
        reference: z.string().max(120).optional().describe("e.g. the delivery note number."),
        quarantine: z.boolean().optional().describe("Receive into quarantine, held until QA releases it."),
        notes: z.string().max(2000).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const [itemId, locationId, supplierId] = await Promise.all([
        resolveItemId(api, slug, a.item),
        resolveLocationId(api, slug, a.location),
        a.supplier ? resolveSupplierId(api, slug, a.supplier) : undefined,
      ]);
      const lot = await api.call(
        ws(api).stock.receipts.$post({
          param: { slug },
          json: {
            itemId,
            locationId,
            quantity: a.quantity,
            unit: a.unit,
            receivedOn: a.received_on,
            ...(a.command_id ? { commandId: a.command_id } : {}),
            ...(supplierId ? { supplierId } : {}),
            ...(a.supplier_lot_code ? { supplierLotCode: a.supplier_lot_code } : {}),
            ...(a.lot_code ? { lotCode: a.lot_code } : {}),
            ...(a.expires_on ? { expiresOn: a.expires_on } : {}),
            ...(a.expiry_type ? { expiryType: a.expiry_type } : {}),
            ...(a.reference ? { reference: a.reference } : {}),
            ...(a.quarantine ? { status: "quarantine" as const } : {}),
            ...(a.notes ? { notes: a.notes } : {}),
          },
        }),
      );
      return {
        id: lot.id,
        lotCode: lot.lotCode,
        item: lot.item,
        status: lot.status,
        receivedOn: lot.receivedOn,
        expiresOn: lot.expiresOn,
        expiryType: lot.expiryType,
        supplier: lot.supplier,
        supplierLotCode: lot.supplierLotCode,
        onHand: lot.onHand,
      };
    },
  );

  define(
    "transfer_stock",
    {
      module: "stock",
      title: "Transfer stock",
      description: `Move a quantity of one lot from one location to another (recorded as a transfer out and a transfer in). Lots are referenced by id or lot code; locations by id, code or exact name. Refused with \`insufficient_stock\` (saying what is available) when the lot doesn't have that much at the source. ${PERSON_ONLY}`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        lot: z.string().min(1).max(200).describe("Lot id or lot code."),
        item: z.string().max(200).optional().describe("Item id or code, when lot codes repeat across items."),
        from_location: z.string().min(1).max(200),
        to_location: z.string().min(1).max(200),
        quantity: z.number().positive(),
        unit: z.enum(unitCodes),
        reason: z.string().max(500).optional(),
        reference: z.string().max(120).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const [lotId, fromLocationId, toLocationId] = await Promise.all([
        resolveLotId(api, slug, a.lot, a.item),
        resolveLocationId(api, slug, a.from_location),
        resolveLocationId(api, slug, a.to_location),
      ]);
      const res = await api.call(
        ws(api).stock.transfers.$post({
          param: { slug },
          json: {
            lotId,
            fromLocationId,
            toLocationId,
            quantity: a.quantity,
            unit: a.unit,
            ...(a.reason ? { reason: a.reason } : {}),
            ...(a.reference ? { reference: a.reference } : {}),
          },
        }),
      );
      return {
        transferId: res.transferId,
        movements: res.movements.map((m) => ({
          id: m.id,
          type: m.type,
          locationId: m.locationId,
          amount: m.amount,
        })),
      };
    },
  );

  const movementView = (m: {
    id: string;
    type: string;
    locationId: string;
    amount: unknown;
    reference?: string | null;
    reason?: string | null;
  }) => ({
    id: m.id,
    type: m.type,
    locationId: m.locationId,
    amount: m.amount,
    reference: m.reference ?? null,
    reason: m.reason ?? null,
  });

  define(
    "record_stock_waste",
    {
      module: "stock",
      tokenAction: "stock.waste",
      title: "Record stock waste",
      description: `Write off a quantity of one lot at one location as waste (a waste movement that removes it from stock, with a reason). This tool exists because an owner or admin allowed API tokens to record waste under Settings → API access; the token's owner needs write access to the stock module. The lot is an id or lot code (pass \`item\` when codes repeat), the location an id, code or exact name; quantity is positive, in \`unit\` (${UNIT_HELP}). Refused with \`insufficient_stock\` (saying what is available) when the lot doesn't have that much there. A reason is required. Do not use it to correct a miscount (that is adjust_stock or post_stocktake).`,
      annotations: DESTRUCTIVE,
      input: {
        workspace: workspaceParam,
        lot: z.string().min(1).max(200).describe("Lot id or lot code."),
        item: z.string().max(200).optional().describe("Item id or code, when lot codes repeat across items."),
        location: z.string().min(1).max(200).describe("Location id, code or exact name."),
        quantity: z.number().positive(),
        unit: z.enum(unitCodes),
        reason: z.string().min(1).max(500).describe("Why it was wasted."),
        reference: z.string().max(120).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const [lotId, locationId] = await Promise.all([
        resolveLotId(api, slug, a.lot, a.item),
        resolveLocationId(api, slug, a.location),
      ]);
      const res = await api.call(
        ws(api).stock.waste.$post({
          param: { slug },
          json: {
            lotId,
            locationId,
            quantity: a.quantity,
            unit: a.unit,
            reason: a.reason,
            ...(a.reference ? { reference: a.reference } : {}),
          },
        }),
      );
      return movementView(res);
    },
  );

  define(
    "adjust_stock",
    {
      module: "stock",
      tokenAction: "stock.adjust",
      title: "Adjust stock",
      description: `Post a signed correction to one lot at one location: a positive quantity adds stock, a negative one removes it (an adjustment movement with a reason). This tool exists because an owner or admin allowed API tokens to post adjustments under Settings → API access; the token's owner needs manage access to the stock module. It invents or destroys stock on the books, so only use it when the user asked for that correction; for a recount use post_stocktake, for spoilage record_stock_waste. The lot is an id or lot code (pass \`item\` when codes repeat), the location an id, code or exact name; quantity is non-zero, in \`unit\` (${UNIT_HELP}). A removal is refused with \`insufficient_stock\` when the lot doesn't have that much there. A reason is required.`,
      annotations: DESTRUCTIVE,
      input: {
        workspace: workspaceParam,
        lot: z.string().min(1).max(200).describe("Lot id or lot code."),
        item: z.string().max(200).optional().describe("Item id or code, when lot codes repeat across items."),
        location: z.string().min(1).max(200).describe("Location id, code or exact name."),
        quantity: z
          .number()
          .refine((v) => v !== 0, "The adjustment can't be zero")
          .describe("Positive adds stock, negative removes it."),
        unit: z.enum(unitCodes),
        reason: z.string().min(1).max(500).describe("Why the books are being corrected."),
        reference: z.string().max(120).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const [lotId, locationId] = await Promise.all([
        resolveLotId(api, slug, a.lot, a.item),
        resolveLocationId(api, slug, a.location),
      ]);
      const res = await api.call(
        ws(api).stock.adjustments.$post({
          param: { slug },
          json: {
            lotId,
            locationId,
            quantity: a.quantity,
            unit: a.unit,
            reason: a.reason,
            ...(a.reference ? { reference: a.reference } : {}),
          },
        }),
      );
      return movementView(res);
    },
  );

  define(
    "post_stocktake",
    {
      module: "stock",
      tokenAction: "stock.stocktake",
      title: "Post a stocktake",
      description: `Post the counts of a stocktake: for each counted lot at a location, the quantity actually found. The difference from the book balance is posted as a stocktake movement (nothing is posted for counts that match) and every variance is returned. This tool exists because an owner or admin allowed API tokens to post stocktakes under Settings → API access; the token's owner needs manage access to the stock module. Each count is a lot (id or lot code; \`item\` when codes repeat), a location (id, code or exact name), the counted quantity (zero is allowed) and its unit (${UNIT_HELP}). 1 to 500 counts; a lot may be counted once per location. All or nothing: if one count is wrong none is posted. Counts are final once posted (only a person can reverse movements), so confirm the numbers with the user first.`,
      annotations: DESTRUCTIVE,
      input: {
        workspace: workspaceParam,
        counts: z
          .array(
            z.object({
              lot: z.string().min(1).max(200).describe("Lot id or lot code."),
              item: z
                .string()
                .max(200)
                .optional()
                .describe("Item id or code, when lot codes repeat across items."),
              location: z.string().min(1).max(200).describe("Location id, code or exact name."),
              counted_quantity: z.number().min(0).describe("What was actually found; 0 if none."),
              unit: z.enum(unitCodes),
            }),
          )
          .min(1)
          .max(500),
        reference: z
          .string()
          .max(120)
          .optional()
          .describe("Shared by the movements; generated when left out."),
        reason: z.string().max(500).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const resolve = batchResolver(api, slug);
      const counts = await mapLimit(a.counts, LOOKUP_CONCURRENCY, async (c, i) => {
        try {
          const [lotId, locationId] = await Promise.all([
            resolve.lot(c.lot, c.item),
            resolve.location(c.location),
          ]);
          return { lotId, locationId, countedQuantity: c.counted_quantity, unit: c.unit };
        } catch (err) {
          if (err instanceof ToolError)
            throw new ToolError(err.code, `counts[${i}]: ${err.message}`, err.options);
          throw err;
        }
      });
      const res = await api.call(
        ws(api).stock.stocktakes.$post({
          param: { slug },
          json: {
            counts,
            ...(a.reference ? { reference: a.reference } : {}),
            ...(a.reason ? { reason: a.reason } : {}),
          },
        }),
      );
      return {
        reference: res.reference,
        posted: res.posted,
        variances: res.variances.map((v) => ({
          lotId: v.lotId,
          lotCode: v.lotCode,
          item: v.item.code,
          location: v.locationName,
          locationId: v.locationId,
          expected: v.expected,
          counted: v.counted,
          variance: v.variance,
        })),
      };
    },
  );

  define(
    "get_lot_qa_evidence",
    {
      module: "stock",
      title: "Get lot QA evidence",
      description:
        "What releasing a lot would be checked against, as it stands: test samples pending, open investigations and unresolved failures (Testing), and the item's release rule (a required passing test, an approved specification, reviewed CCP monitoring with no open corrective action), plus deviations and packing checks for the record. `blocked` says whether a release would be refused. Releasing, and releasing as an exception with a reason and evidence, is a person's QA decision in the Knotworking app; there is no tool for it.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        lot: z.string().min(1).max(200).describe("Lot id or lot code."),
        item: z.string().max(200).optional().describe("Item id or code, when lot codes repeat across items."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveLotId(api, slug, a.lot, a.item);
      const check = await api.call(ws(api).stock.lots[":id"]["release-check"].$get({ param: { slug, id } }));
      return {
        status: check.status,
        blocked: check.blocked,
        ruleVersion: check.ruleVersion,
        rule: check.rule,
        checks: check.checks.map((c) => ({
          check: c.label,
          status: c.status,
          detail: c.detail,
          fromRule: c.fromRule,
          ...(c.hidden
            ? { hidden: "You can't read this module; ask someone who can" }
            : { refs: c.refs.map((r) => r.label) }),
        })),
      };
    },
  );
}
