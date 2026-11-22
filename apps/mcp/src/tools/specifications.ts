import {
  allergenCodes,
  allergens,
  specificationKinds,
  specificationParameterCategories,
  specificationReviewFilters,
  specificationStatuses,
  storageConditions,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UPDATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APPROVAL_NOTE =
  "Approving a specification is a sign-off made in the Knotworking app by someone with manage access other than its last editor; there is no tool for it. Tell the user when a draft has no blockers left.";

/**
 * Specifications module: controlled ingredient, packaging and product specifications. Agents may
 * read, create and draft; approval is a person's.
 */
export function registerSpecificationTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];

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

  async function resolveSupplierId(api: Api, slug: string, ref: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { suppliers } = await api.call(
      ws(api).suppliers.$get({ param: { slug }, query: { q: wanted } as never }),
    );
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

  async function resolveSpecificationId(api: Api, slug: string, ref: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { specifications } = await api.call(
      ws(api).specifications.$get({ param: { slug }, query: { q: wanted, status: "all", limit: "200" } }),
    );
    const match = specifications.filter((s) => s.code.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      "not_found",
      `No specification has the code "${wanted}". Use list_specifications to find it, then pass its id or exact code.`,
    );
  }

  const fetchSpec = (api: Api, slug: string, id: string) =>
    api.call(ws(api).specifications[":id"].$get({ param: { slug, id } }));
  type Spec = Awaited<ReturnType<typeof fetchSpec>>;
  type Version = NonNullable<Spec["approvedVersion"]>;

  const names = (codes: readonly (typeof allergenCodes)[number][]) => codes.map((c) => allergens[c]);
  const versionView = (v: Version) => ({
    versionNumber: v.versionNumber,
    status: v.status,
    description: v.description,
    storage: v.storage,
    storageInstructions: v.storageInstructions,
    shelfLifeDays: v.shelfLifeDays,
    minimumLifeOnReceiptDays: v.minimumLifeOnReceiptDays,
    allergens: v.allergens,
    allergenNames: names(v.allergens),
    mayContain: v.mayContain,
    mayContainNames: names(v.mayContain),
    countryOfOrigin: v.countryOfOrigin,
    provenance: v.provenance,
    claims: v.claims,
    packagingDetails: v.packagingDetails,
    parameters: v.parameters.map(({ id: _id, ...p }) => p),
    reviewDueOn: v.reviewDueOn,
    agreement: v.agreedOn ? { by: v.agreedBy, on: v.agreedOn, reference: v.agreementReference } : null,
    changeNote: v.changeNote,
    approvedAt: v.approvedAt,
    approvedBy: v.approvedByName,
    lastEditedBy: v.lastEditedByName,
  });

  const specView = (s: Spec) => ({
    id: s.id,
    code: s.code,
    title: s.title,
    status: s.status,
    kind: s.kind,
    party: s.party,
    item: { code: s.item.code, name: s.item.name, type: s.item.type },
    supplier: s.supplier ? { name: s.supplier.name, code: s.supplier.code } : null,
    customerName: s.customerName,
    reviewState: s.reviewState,
    versions: s.versions.map((v) => ({
      versionNumber: v.versionNumber,
      status: v.status,
      changeNote: v.changeNote,
      approvedAt: v.approvedAt,
      approvedBy: v.approvedByName,
    })),
    approvedVersion: s.approvedVersion ? versionView(s.approvedVersion) : null,
    itemDiscrepancies: s.discrepancies,
    draft: s.draftVersion
      ? {
          ...versionView(s.draftVersion),
          changes: s.draftChanges,
          blockers: s.draftBlockers,
          itemDiscrepanciesOnceApproved: s.draftDiscrepancies,
        }
      : null,
    approvalNote: APPROVAL_NOTE,
  });

  const parameterArg = z.object({
    category: z.enum(specificationParameterCategories),
    name: z.string().min(1).max(120).describe('Unique per category, e.g. "Moisture", "Salmonella".'),
    unit: z.string().max(20).nullable().optional().describe('e.g. "%", "cfu/g", "mm".'),
    min: z.number().nullable().optional(),
    target: z.number().nullable().optional(),
    max: z.number().nullable().optional(),
    limit_text: z.string().max(200).nullable().optional().describe('A written limit, e.g. "Absent in 25 g".'),
    method: z.string().max(200).nullable().optional().describe('Test method, e.g. "ISO 6579-1".'),
    note: z.string().max(500).nullable().optional(),
  });
  const draftArgs = {
    description: z.string().max(5000).nullable().optional(),
    storage: z.enum(storageConditions).nullable().optional(),
    storage_instructions: z.string().max(1000).nullable().optional(),
    shelf_life_days: z.number().int().min(1).max(3650).nullable().optional(),
    minimum_life_on_receipt_days: z
      .number()
      .int()
      .min(0)
      .max(3650)
      .nullable()
      .optional()
      .describe("Bought-in items: least remaining life accepted at goods-in."),
    allergens: z.array(z.enum(allergenCodes)).optional().describe("Allergens it contains (UK FIC 14 codes)."),
    may_contain: z
      .array(z.enum(allergenCodes))
      .optional()
      .describe("Precautionary allergens; not also in `allergens`."),
    country_of_origin: z.string().max(200).nullable().optional(),
    provenance: z.string().max(2000).nullable().optional(),
    claims: z.array(z.string().min(1).max(80)).max(30).optional().describe('e.g. ["Organic", "Vegan"].'),
    packaging_details: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .describe("Packaging: material, food-contact compliance, dimensions."),
    parameters: z
      .array(parameterArg)
      .max(200)
      .optional()
      .describe("The full list; it replaces the draft's parameters."),
    review_due_on: z.string().date().nullable().optional().describe("YYYY-MM-DD, in the future to approve."),
    agreed_by: z.string().max(200).nullable().optional().describe("The supplier's or customer's signatory."),
    agreed_on: z.string().date().nullable().optional().describe("YYYY-MM-DD; with `agreed_by`."),
    agreement_reference: z.string().max(200).nullable().optional(),
    change_note: z.string().max(2000).nullable().optional(),
  };
  type DraftArgs = { [K in keyof typeof draftArgs]?: z.infer<(typeof draftArgs)[K]> };
  const draftKeys = Object.keys(draftArgs) as (keyof DraftArgs)[];

  /** The API body for a draft: given fields over `base` (the current draft or approved version). */
  const draftBody = (a: DraftArgs, base: Version | null) => {
    const pick = <K extends keyof DraftArgs, T>(key: K, fallback: T) =>
      a[key] !== undefined ? a[key] : fallback;
    return {
      description: pick("description", base?.description ?? null),
      storage: pick("storage", base?.storage ?? null),
      storageInstructions: pick("storage_instructions", base?.storageInstructions ?? null),
      shelfLifeDays: pick("shelf_life_days", base?.shelfLifeDays ?? null),
      minimumLifeOnReceiptDays: pick("minimum_life_on_receipt_days", base?.minimumLifeOnReceiptDays ?? null),
      allergens: pick("allergens", base?.allergens ?? []) ?? [],
      mayContain: pick("may_contain", base?.mayContain ?? []) ?? [],
      countryOfOrigin: pick("country_of_origin", base?.countryOfOrigin ?? null),
      provenance: pick("provenance", base?.provenance ?? null),
      claims: pick("claims", base?.claims ?? []) ?? [],
      packagingDetails: pick("packaging_details", base?.packagingDetails ?? null),
      parameters:
        a.parameters !== undefined
          ? a.parameters.map((p) => ({
              category: p.category,
              name: p.name,
              unit: p.unit ?? null,
              min: p.min ?? null,
              target: p.target ?? null,
              max: p.max ?? null,
              limitText: p.limit_text ?? null,
              method: p.method ?? null,
              note: p.note ?? null,
            }))
          : (base?.parameters ?? []).map(({ id: _id, ...p }) => p),
      reviewDueOn: pick("review_due_on", base?.reviewDueOn ?? null),
      agreedBy: pick("agreed_by", base?.agreedBy ?? null),
      agreedOn: pick("agreed_on", base?.agreedOn ?? null),
      agreementReference: pick("agreement_reference", base?.agreementReference ?? null),
      // A change note describes one revision: never carried over from an approved version.
      changeNote: pick("change_note", base?.status === "draft" ? base.changeNote : null),
    };
  };

  define(
    "list_specifications",
    {
      module: "specifications",
      resource: { name: "specifications", op: "list" },
      title: "List specifications",
      description:
        "List ingredient, packaging and product specifications with their item, supplier or customer, approved version and review date, and whether a draft is in progress. Filter by `query` (code, title, item, supplier or customer), `kind`, `item`, `supplier`, `review` (overdue, due_soon, or attention: either, or never approved) or `status` (default active). Paged: use `offset` while `hasMore` is true.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        query: z.string().max(200).optional(),
        kind: z.enum(specificationKinds).optional(),
        item: z.string().max(200).optional().describe("Item id or exact code."),
        supplier: z.string().max(200).optional().describe("Supplier id, exact code or exact name."),
        review: z.enum(specificationReviewFilters).optional(),
        status: z.enum([...specificationStatuses, "all"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const itemId = a.item ? await resolveItemId(api, slug, a.item) : undefined;
      const supplierId = a.supplier ? await resolveSupplierId(api, slug, a.supplier) : undefined;
      const offset = a.offset ?? 0;
      const page = await api.call(
        ws(api).specifications.$get({
          param: { slug },
          query: {
            ...(a.query ? { q: a.query } : {}),
            ...(a.kind ? { kind: a.kind } : {}),
            ...(itemId ? { itemId } : {}),
            ...(supplierId ? { supplierId } : {}),
            ...(a.review ? { review: a.review } : {}),
            ...(a.status ? { status: a.status } : {}),
            limit: String(a.limit ?? 50),
            offset: String(offset),
          },
        }),
      );
      return {
        specifications: page.specifications.map((s) => ({
          id: s.id,
          code: s.code,
          title: s.title,
          status: s.status,
          kind: s.kind,
          party: s.party,
          item: s.item.code,
          supplier: s.supplierName,
          customerName: s.customerName,
          approvedVersion: s.approvedVersion?.versionNumber ?? null,
          reviewDueOn: s.approvedVersion?.reviewDueOn ?? null,
          reviewState: s.reviewState,
          draftVersion: s.draftVersion?.versionNumber ?? null,
        })),
        total: page.total,
        returned: page.specifications.length,
        hasMore: offset + page.specifications.length < page.total,
        today: page.today,
      };
    },
  );

  define(
    "get_specification",
    {
      module: "specifications",
      resource: { name: "specifications", op: "get" },
      title: "Get specification",
      description:
        "One specification by id or exact code: the approved version in full (limits, allergens, storage, shelf life, provenance, claims, agreement), where the item record disagrees with it, and any draft with what it changes and why it can't be approved yet. Pass `include_impact` to also list the recipes that use or make the item (through work-in-progress recipes), their labels and open production batches; parts you can't read are listed under `hidden`, which never means nothing is affected.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        specification: z.string().min(1).max(200).describe("Specification id or exact code."),
        include_impact: z.boolean().optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveSpecificationId(api, slug, a.specification);
      const spec = await fetchSpec(api, slug, id);
      if (!a.include_impact) return specView(spec);
      const impact = await api.call(ws(api).specifications[":id"].impact.$get({ param: { slug, id } }));
      return {
        ...specView(spec),
        impact: {
          recipes:
            impact.recipes?.map((r) => ({
              code: r.code,
              name: r.name,
              relation: r.relation,
              depth: r.depth,
              makes: r.outputItem?.code ?? null,
            })) ?? null,
          labels:
            impact.labels?.map((l) => ({
              recipe: l.recipeCode,
              variant: l.variant,
              version: l.versionNumber,
              status: l.status,
              productName: l.productName,
            })) ?? null,
          openBatches:
            impact.batches?.map((b) => ({
              batchCode: b.batchCode,
              recipe: b.recipeCode,
              plannedOn: b.plannedOn,
              status: b.status,
            })) ?? null,
          hidden: impact.hidden,
          depthLimited: impact.depthLimited,
          truncated: impact.truncated,
        },
      };
    },
  );

  define(
    "create_specification",
    {
      module: "specifications",
      title: "Create specification",
      description: `Create a specification for an item. \`code\` (the document number) must be unique. A bought-in item's specification may name its \`supplier\`; a product's may name its \`customer\`; neither makes it internal. Any draft fields given are saved as version 1's draft. ${APPROVAL_NOTE}`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        code: z.string().min(1).max(40),
        title: z.string().min(1).max(200),
        item: z.string().min(1).max(200).describe("Item id or exact code."),
        supplier: z
          .string()
          .max(200)
          .optional()
          .describe("Ingredients and packaging: supplier id, code or name."),
        customer: z.string().max(200).optional().describe("Products: the customer's name."),
        ...draftArgs,
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const hasDraft = draftKeys.some((k) => a[k] !== undefined);
      const created = await api.call(
        ws(api).specifications.$post({
          param: { slug },
          json: {
            code: a.code,
            title: a.title,
            itemId: await resolveItemId(api, slug, a.item),
            ...(a.supplier ? { supplierId: await resolveSupplierId(api, slug, a.supplier) } : {}),
            ...(a.customer ? { customerName: a.customer } : {}),
            ...(hasDraft ? { draft: draftBody(a, null) } : {}),
          },
        }),
      );
      return specView(created);
    },
  );

  define(
    "save_specification_draft",
    {
      module: "specifications",
      title: "Save specification draft",
      description: `Create or update a specification's draft (the next version). Fields you leave out are kept from the current draft, or copied from the approved version when there is no draft; \`parameters\`, when given, replaces the whole list. Returns what the draft changes and any approval blockers. ${APPROVAL_NOTE}`,
      annotations: UPDATE,
      input: {
        workspace: workspaceParam,
        specification: z.string().min(1).max(200).describe("Specification id or exact code."),
        ...draftArgs,
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveSpecificationId(api, slug, a.specification);
      const current = await fetchSpec(api, slug, id);
      const saved = await api.call(
        ws(api).specifications[":id"].draft.$put({
          param: { slug, id },
          json: draftBody(a, current.draftVersion ?? current.approvedVersion),
        }),
      );
      return specView(saved);
    },
  );
}
