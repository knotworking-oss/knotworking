import {
  allergenCodes,
  allergens,
  itemStatuses,
  itemTypes,
  storageConditions,
  supplierApprovalStatuses,
  unitCodes,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import { importCsvBody, importCsvInput, importCsvView, type ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Replaces fields from a file; sending the same file again changes nothing. */
const REPLACE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const UPDATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allergenParam = z.array(z.enum(allergenCodes)).max(allergenCodes.length);
const ALLERGEN_HELP = `Allergen codes: ${allergenCodes.join(", ")}.`;

/** Items module: items (ingredients, packaging, WIP, finished goods) and suppliers. */
export function registerItemTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];

  type Item = Awaited<ReturnType<typeof getItemById>>;
  const getItemById = (api: Api, slug: string, id: string) =>
    api.call(ws(api).items[":id"].$get({ param: { slug, id } }));

  /** An item by id or exact stock code (case-insensitive). */
  async function resolveItem(api: Api, slug: string, ref: string): Promise<Item> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return getItemById(api, slug, wanted);
    const { items } = await api.call(
      ws(api).items.$get({ param: { slug }, query: { q: wanted, status: "all", limit: "200" } }),
    );
    const match = items.filter((i) => i.code.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!;
    throw new ToolError(
      "not_found",
      `No item has the code "${wanted}". Use list_items to find it, then pass its id or exact code.`,
    );
  }

  const listSuppliers = (api: Api, slug: string, query: { q?: string; status?: string } = {}) =>
    api.call(ws(api).suppliers.$get({ param: { slug }, query: query as never }));

  /** A supplier by id, exact code or exact name (case-insensitive). */
  async function resolveSupplier(api: Api, slug: string, ref: string) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return api.call(ws(api).suppliers[":id"].$get({ param: { slug, id: wanted } }));
    const { suppliers } = await listSuppliers(api, slug, { q: wanted });
    const lower = wanted.toLowerCase();
    const match = suppliers.filter((s) => s.code?.toLowerCase() === lower || s.name.toLowerCase() === lower);
    if (match.length === 1) return match[0]!;
    throw new ToolError(
      match.length ? "ambiguous" : "not_found",
      match.length
        ? `More than one supplier matches "${wanted}"; pass its id.`
        : `No supplier is called "${wanted}". Use list_suppliers to find it, or create_supplier first.`,
    );
  }

  const supplierLinks = async (api: Api, slug: string, refs: string[] | undefined) =>
    refs === undefined
      ? undefined
      : Promise.all(refs.map(async (ref) => ({ supplierId: (await resolveSupplier(api, slug, ref)).id })));

  const itemSummary = (i: Item) => ({
    id: i.id,
    code: i.code,
    name: i.name,
    type: i.type,
    status: i.status,
    unit: i.unit,
    allergens: i.allergens,
    mayContain: i.mayContain,
    storage: i.storage,
  });
  const itemDetail = (i: Item) => ({
    ...itemSummary(i),
    description: i.description,
    shelfLifeDays: i.shelfLifeDays,
    standardCost: i.standardCost,
    densityGPerMl: i.densityGPerMl,
    unitWeightG: i.unitWeightG,
    suppliers: i.suppliers.map((s) => ({
      id: s.supplierId,
      name: s.name,
      approvalStatus: s.approvalStatus,
      supplierCode: s.supplierCode,
      preferred: s.preferred,
    })),
    updatedAt: i.updatedAt,
  });

  const itemFields = {
    description: z.string().max(2000).nullable().optional().describe("Free text; null clears it."),
    allergens: allergenParam
      .optional()
      .describe(`Allergens the item contains (replaces the list). ${ALLERGEN_HELP}`),
    may_contain: allergenParam
      .optional()
      .describe("Precautionary 'may contain' allergens (replaces the list)."),
    storage: z.enum(storageConditions).optional(),
    shelf_life_days: z.number().int().min(0).max(3650).nullable().optional(),
    standard_cost: z
      .number()
      .min(0)
      .nullable()
      .optional()
      .describe("Cost per `unit`, in the workspace's currency."),
    density_g_per_ml: z
      .number()
      .positive()
      .nullable()
      .optional()
      .describe("Grams per millilitre, so volumes and weights of this item can be converted."),
    unit_weight_g: z
      .number()
      .positive()
      .nullable()
      .optional()
      .describe("Grams per each, so counts and weights of this item can be converted."),
    suppliers: z
      .array(z.string().min(1).max(200))
      .max(20)
      .optional()
      .describe("Suppliers of this item (ids, codes or exact names); replaces the list."),
  };
  type ItemFieldArgs = z.infer<z.ZodObject<typeof itemFields>>;
  /** Tool arguments → API body, leaving out what the agent didn't pass. */
  const itemBody = async (api: Api, slug: string, a: ItemFieldArgs) => {
    const suppliers = await supplierLinks(api, slug, a.suppliers);
    return {
      ...(a.description !== undefined ? { description: a.description } : {}),
      ...(a.allergens !== undefined ? { allergens: a.allergens } : {}),
      ...(a.may_contain !== undefined ? { mayContain: a.may_contain } : {}),
      ...(a.storage !== undefined ? { storage: a.storage } : {}),
      ...(a.shelf_life_days !== undefined ? { shelfLifeDays: a.shelf_life_days } : {}),
      ...(a.standard_cost !== undefined ? { standardCost: a.standard_cost } : {}),
      ...(a.density_g_per_ml !== undefined ? { densityGPerMl: a.density_g_per_ml } : {}),
      ...(a.unit_weight_g !== undefined ? { unitWeightG: a.unit_weight_g } : {}),
      ...(suppliers !== undefined ? { suppliers } : {}),
    };
  };

  define(
    "list_items",
    {
      module: "items",
      resource: { name: "items", op: "list" },
      title: "List items",
      description:
        "List catalogue items with their code and unit. Allergen and storage fields require Food items access. Filter by `type`, `query` (matches name or code), `allergen` (contains or may contain), `supplier` or `status` (default: active only). Paged: use `offset` while `hasMore` is true.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        query: z.string().max(200).optional().describe("Text to find in the name or code."),
        type: z.enum(itemTypes).optional(),
        allergen: z.enum(allergenCodes).optional().describe(ALLERGEN_HELP),
        supplier: z.string().max(200).optional().describe("Supplier id, code or exact name."),
        status: z.enum([...itemStatuses, "all"]).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum items (default 50, max 200)."),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const supplierId = a.supplier ? (await resolveSupplier(api, slug, a.supplier)).id : undefined;
      const page = await api.call(
        ws(api).items.$get({
          param: { slug },
          query: {
            ...(a.query ? { q: a.query } : {}),
            ...(a.type ? { type: a.type } : {}),
            ...(a.allergen ? { allergen: a.allergen } : {}),
            ...(supplierId ? { supplierId } : {}),
            ...(a.status ? { status: a.status } : {}),
            limit: String(a.limit ?? 50),
            offset: String(a.offset ?? 0),
          },
        }),
      );
      return {
        items: page.items.map(itemSummary),
        total: page.total,
        offset: page.offset,
        returned: page.items.length,
        hasMore: page.offset + page.items.length < page.total,
      };
    },
  );

  define(
    "get_item",
    {
      module: "items",
      resource: { name: "items", op: "get" },
      title: "Get item",
      description:
        "One item by id or exact stock code: description, unit, allergens (contains and may contain, with their names), storage, shelf life, standard cost, conversion factors and its suppliers with their approval status.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        item: z.string().min(1).max(200).describe("Item id or exact code."),
      },
    },
    async ({ workspace, item }, api) => {
      const found = await resolveItem(api, await slugOf(api, workspace), item);
      return {
        ...itemDetail(found),
        ...(found.allergens && { allergenNames: found.allergens.map((code) => allergens[code]) }),
        ...(found.mayContain && { mayContainNames: found.mayContain.map((code) => allergens[code]) }),
      };
    },
  );

  define(
    "create_item",
    {
      module: "items",
      title: "Create item",
      description:
        "Create a catalogue item for a material, product or service. `code` must be unique in the workspace (search with list_items first). `unit` is how quantities of the item are entered and its dimension can't change later. Allergens and other food fields require Food items write access.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        code: z.string().min(1).max(40).describe("Stock code / SKU, e.g. FLR-001."),
        name: z.string().min(1).max(200),
        type: z.enum(itemTypes),
        unit: z.enum(unitCodes),
        ...itemFields,
      },
    },
    async ({ workspace, code, name, type, unit, ...rest }, api) => {
      const slug = await slugOf(api, workspace);
      const body = await itemBody(api, slug, rest);
      return itemDetail(
        await api.call(ws(api).items.$post({ param: { slug }, json: { code, name, type, unit, ...body } })),
      );
    },
  );

  define(
    "update_item",
    {
      module: "items",
      title: "Update item",
      description:
        "Partial update of an item by id or exact code. Only the fields you pass change; list fields (`allergens`, `may_contain`, `suppliers`) are replaced as a whole. Set `status` to `archived` to retire an item (there is no delete tool). The unit can change within its kind only (g ↔ kg, not kg → l).",
      annotations: UPDATE,
      input: {
        workspace: workspaceParam,
        item: z.string().min(1).max(200).describe("Item id or exact code."),
        code: z.string().min(1).max(40).optional(),
        name: z.string().min(1).max(200).optional(),
        type: z.enum(itemTypes).optional(),
        unit: z.enum(unitCodes).optional(),
        status: z.enum(itemStatuses).optional(),
        ...itemFields,
      },
    },
    async ({ workspace, item, code, name, type, unit, status, ...rest }, api) => {
      const slug = await slugOf(api, workspace);
      const current = await resolveItem(api, slug, item);
      const json = {
        ...(code !== undefined ? { code } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(unit !== undefined ? { unit } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(await itemBody(api, slug, rest)),
      };
      if (Object.keys(json).length === 0)
        throw new ToolError("invalid_input", "Pass at least one field to change.");
      return itemDetail(
        await api.call(ws(api).items[":id"].$patch({ param: { slug, id: current.id }, json })),
      );
    },
  );

  // ── Suppliers ──

  type Supplier = Awaited<ReturnType<typeof listSuppliers>>["suppliers"][number];
  const supplierView = (s: Omit<Supplier, "itemCount"> & { itemCount?: number }) => ({
    id: s.id,
    name: s.name,
    code: s.code,
    approvalStatus: s.approvalStatus,
    reviewDueOn: s.reviewDueOn,
    certification: s.certification,
    certificateExpiresOn: s.certificateExpiresOn,
    contactName: s.contactName,
    email: s.email,
    phone: s.phone,
    address: s.address,
    notes: s.notes,
    ...(s.itemCount !== undefined ? { itemCount: s.itemCount } : {}),
  });

  const supplierFields = {
    code: z.string().max(40).nullable().optional().describe("Short reference; unique when set."),
    contact_name: z.string().max(200).nullable().optional(),
    email: z.string().max(320).nullable().optional(),
    phone: z.string().max(60).nullable().optional(),
    address: z.string().max(1000).nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    certification: z
      .string()
      .max(200)
      .nullable()
      .optional()
      .describe('e.g. "BRCGS Food Safety AA", "SALSA".'),
    certificate_expires_on: z.iso.date().nullable().optional().describe("YYYY-MM-DD."),
  };
  const supplierBody = (a: z.infer<z.ZodObject<typeof supplierFields>>) => ({
    ...(a.code !== undefined ? { code: a.code } : {}),
    ...(a.contact_name !== undefined ? { contactName: a.contact_name } : {}),
    ...(a.email !== undefined ? { email: a.email } : {}),
    ...(a.phone !== undefined ? { phone: a.phone } : {}),
    ...(a.address !== undefined ? { address: a.address } : {}),
    ...(a.notes !== undefined ? { notes: a.notes } : {}),
    ...(a.certification !== undefined ? { certification: a.certification } : {}),
    ...(a.certificate_expires_on !== undefined ? { certificateExpiresOn: a.certificate_expires_on } : {}),
  });

  define(
    "list_suppliers",
    {
      module: "items",
      resource: { name: "suppliers", op: "list" },
      title: "List suppliers",
      description:
        "List suppliers with their approval status (pending, approved, suspended, rejected), review date, certification and how many items they supply. Filter by `query` (name or code) or `status`.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        query: z.string().max(200).optional(),
        status: z.enum(supplierApprovalStatuses).optional(),
      },
    },
    async ({ workspace, query, status }, api) => {
      const { suppliers } = await listSuppliers(api, await slugOf(api, workspace), {
        ...(query ? { q: query } : {}),
        ...(status ? { status } : {}),
      });
      return { suppliers: suppliers.map(supplierView), total: suppliers.length };
    },
  );

  define(
    "create_supplier",
    {
      module: "items",
      title: "Create supplier",
      description:
        "Create a supplier. It starts as `pending`: approving a supplier is a food-safety sign-off that a person does in the app, and this server has no tool for it. Search with list_suppliers first to avoid duplicates.",
      annotations: CREATE,
      input: { workspace: workspaceParam, name: z.string().min(1).max(200), ...supplierFields },
    },
    async ({ workspace, name, ...rest }, api) => {
      const slug = await slugOf(api, workspace);
      return supplierView(
        await api.call(ws(api).suppliers.$post({ param: { slug }, json: { name, ...supplierBody(rest) } })),
      );
    },
  );

  define(
    "update_supplier",
    {
      module: "items",
      title: "Update supplier",
      description:
        "Partial update of a supplier's details by id, code or exact name; null clears a field. Approval status can't be changed here (a person does that in the app).",
      annotations: UPDATE,
      input: {
        workspace: workspaceParam,
        supplier: z.string().min(1).max(200).describe("Supplier id, code or exact name."),
        name: z.string().min(1).max(200).optional(),
        ...supplierFields,
      },
    },
    async ({ workspace, supplier, name, ...rest }, api) => {
      const slug = await slugOf(api, workspace);
      const current = await resolveSupplier(api, slug, supplier);
      const json = { ...(name !== undefined ? { name } : {}), ...supplierBody(rest) };
      if (Object.keys(json).length === 0)
        throw new ToolError("invalid_input", "Pass at least one field to change.");
      return supplierView(
        await api.call(ws(api).suppliers[":id"].$patch({ param: { slug, id: current.id }, json })),
      );
    },
  );

  define(
    "import_items_csv",
    {
      module: "items",
      title: "Import items from CSV",
      description: `Create and update items from CSV text with a header row. Rows are matched to existing items by stock code, ignoring case. Columns (any order): code (required); name, type (${itemTypes.join(", ")}) and unit (${unitCodes.join(", ")}) are needed for new items; optional description, density (g/ml), unit weight (g), allergens (contains) and may contain (names such as "milk; eggs", ${ALLERGEN_HELP}), storage (${storageConditions.join(", ")}), shelf life (days), standard cost, status (${itemStatuses.join(", ")}). A missing column leaves existing items alone; an empty cell clears the value (an empty allergens cell means none) except in name, type, unit, storage and status, which keep it. An item's unit can't change dimension. Use \`dry_run: true\` first: it checks every row and reports what would be created or updated, writing nothing. A real import writes every row in one go, or nothing if any row has a problem (each listed with its row number). Up to 5000 rows.`,
      annotations: REPLACE,
      input: { workspace: workspaceParam, ...importCsvInput },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return importCsvView(
        await api.call(ws(api).items.import.$post({ param: { slug }, json: importCsvBody(a) })),
      );
    },
  );

  define(
    "import_suppliers_csv",
    {
      module: "items",
      title: "Import suppliers from CSV",
      description:
        "Create and update suppliers from CSV text with a header row. Rows are matched by code, else by name (ignoring case). Columns (any order): code and/or name (a new supplier needs a name); optional contact name, email, phone, address, notes, certification, certificate expiry (YYYY-MM-DD or DD/MM/YYYY). A missing column leaves existing suppliers alone; an empty cell clears the value. Approval status is NOT importable: new suppliers start `pending` and existing approvals are never changed (a person approves in the app); an approval column is ignored and reported. Use `dry_run: true` first to check every row and preview; a real import writes every row in one go, or nothing if any row has a problem. Up to 5000 rows.",
      annotations: REPLACE,
      input: { workspace: workspaceParam, ...importCsvInput },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return importCsvView(
        await api.call(ws(api).suppliers.import.$post({ param: { slug }, json: importCsvBody(a) })),
      );
    },
  );
}
