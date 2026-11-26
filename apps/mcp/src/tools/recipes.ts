import { allergens, recipeStatuses, unitCodes } from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UPDATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APPROVAL_NOTE =
  "Approving a version is a sign-off made by a person in the Knotworking app; there is no tool for it. Tell the user when a draft is ready for approval.";

/** Recipes module: versioned recipes. Agents may read and draft; approval is a person's. */
export function registerRecipeTools({ define, slugOf, workspaceParam }: ToolContext) {
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

  /** A recipe id from an id or exact code (case-insensitive). */
  async function resolveRecipeId(api: Api, slug: string, ref: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { recipes } = await api.call(
      ws(api).recipes.$get({ param: { slug }, query: { q: wanted, status: "all", limit: "200" } }),
    );
    const match = recipes.filter((r) => r.code.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      "not_found",
      `No recipe has the code "${wanted}". Use list_recipes to find it, then pass its id or exact code.`,
    );
  }

  const lineArg = z.object({
    item: z.string().min(1).max(200).describe("Ingredient item id or exact code."),
    quantity: z.number().positive().describe("Amount in `unit`, at most 4 decimal places."),
    unit: z
      .enum(unitCodes)
      .describe("Must convert to the item's own unit (same kind, or the item has a density / unit weight)."),
    note: z.string().max(500).nullable().optional(),
  });
  const draftFields = {
    yield_quantity: z.number().min(0).describe("What one batch makes, in `yield_unit`."),
    yield_unit: z.enum(unitCodes).describe("Same kind (weight, volume, count) as the output item's unit."),
    method: z.string().max(50_000).nullable().optional().describe("Plain-text method."),
    change_note: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .describe("What changed since the previous version."),
    lines: z
      .array(lineArg)
      .max(200)
      .describe("The full ingredient list, in order. It replaces the draft's lines."),
  };
  type DraftArgs = {
    yield_quantity: number;
    yield_unit: (typeof unitCodes)[number];
    method?: string | null | undefined;
    change_note?: string | null | undefined;
    lines: z.infer<typeof lineArg>[];
  };
  const draftBody = async (api: Api, slug: string, a: DraftArgs) => ({
    yieldQuantity: a.yield_quantity,
    yieldUnit: a.yield_unit,
    ...(a.method !== undefined ? { method: a.method } : {}),
    ...(a.change_note !== undefined ? { changeNote: a.change_note } : {}),
    lines: await Promise.all(
      a.lines.map(async (l) => ({
        itemId: await resolveItemId(api, slug, l.item),
        quantity: l.quantity,
        unit: l.unit,
        ...(l.note !== undefined ? { note: l.note } : {}),
      })),
    ),
  });

  type RecipeFull = Awaited<ReturnType<typeof fetchRecipe>>;
  type VersionFull = NonNullable<RecipeFull["currentVersion"]>;
  const fetchRecipe = (api: Api, slug: string, id: string) =>
    api.call(ws(api).recipes[":id"].$get({ param: { slug, id } }));

  const versionView = (v: VersionFull) => ({
    versionNumber: v.versionNumber,
    status: v.status,
    yield: { quantity: v.yieldQuantity, unit: v.yieldUnit },
    method: v.method,
    changeNote: v.changeNote,
    approvedAt: v.approvedAt,
    approvedBy: v.approvedByName,
    lines: v.lines.map((l) => ({
      item: l.item.code,
      name: l.item.name,
      quantity: l.quantity,
      unit: l.unit,
      note: l.note,
      cost: l.cost,
      ...("scaledQuantity" in l ? { scaledQuantity: l.scaledQuantityRounded } : {}),
    })),
    ...(v.foodItemsIncluded !== false
      ? {
          allergens: {
            contains: v.rollup.allergens.contains,
            containsNames: v.rollup.allergens.contains.map((c) => allergens[c]),
            mayContain: v.rollup.allergens.mayContain,
            mayContainNames: v.rollup.allergens.mayContain.map((c) => allergens[c]),
          },
          allergenMismatch: {
            ...v.rollup.allergenMismatch,
            note:
              v.rollup.allergenMismatch.undeclared.length || v.rollup.allergenMismatch.unexplained.length
                ? "The output item's declared allergens don't match what the ingredients bring in: fix the item or the recipe."
                : "Matches the output item's declaration.",
          },
        }
      : {}),
    cost: v.rollup.cost,
    ...(v.foodItemsIncluded !== false && v.status === "approved"
      ? {
          allergenRecheck: v.allergenDrift
            ? {
                ...v.allergenDrift,
                note: "An ingredient's allergen declaration changed after this version was approved: its recorded allergens are out of date. A person should review and approve a new version.",
              }
            : null,
        }
      : {}),
  });

  const header = (r: RecipeFull) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    status: r.status,
    description: r.description,
    outputItem: { code: r.outputItem?.code, name: r.outputItem?.name, unit: r.outputItem?.unit },
  });

  define(
    "list_recipes",
    {
      module: "recipes",
      resource: { name: "recipes", op: "list" },
      title: "List recipes",
      description:
        "List bills of materials (recipes in food workspaces) with their output item, current approved version number, whether a draft is in progress, and rolled-up allergens when Food items is readable. Filter by `query` (name or code), `output_item`, `ingredient` (recipes whose approved or draft version uses that item), `allergen_drift` (true: only recipes whose approved version's ingredients now declare different allergens than when it was approved) or `status` (default: active). Paged: use `offset` while `hasMore` is true.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        query: z.string().max(200).optional().describe("Text to find in the name or code."),
        output_item: z
          .string()
          .max(200)
          .optional()
          .describe("Item id or exact code of what the recipe makes."),
        ingredient: z.string().max(200).optional().describe("Item id or exact code used as an ingredient."),
        status: z.enum([...recipeStatuses, "all"]).optional(),
        allergen_drift: z.boolean().optional().describe("True: only flagged recipes."),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum recipes (default 50, max 200)."),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const outputItemId = a.output_item ? await resolveItemId(api, slug, a.output_item) : undefined;
      const itemId = a.ingredient ? await resolveItemId(api, slug, a.ingredient) : undefined;
      const page = await api.call(
        ws(api).recipes.$get({
          param: { slug },
          query: {
            ...(a.query ? { q: a.query } : {}),
            ...(outputItemId ? { outputItemId } : {}),
            ...(itemId ? { itemId } : {}),
            ...(a.status ? { status: a.status } : {}),
            ...(a.allergen_drift !== undefined
              ? { allergenDrift: String(a.allergen_drift) as "true" | "false" }
              : {}),
            limit: String(a.limit ?? 50),
            offset: String(a.offset ?? 0),
          },
        }),
      );
      return {
        recipes: page.recipes.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          status: r.status,
          outputItem: r.outputItem ? { code: r.outputItem.code, name: r.outputItem.name } : null,
          approvedVersion: r.approvedVersionNumber,
          hasDraft: r.hasDraft,
          ...(r.foodItemsIncluded !== false ? { allergens: r.allergens } : {}),
        })),
        total: page.total,
        offset: page.offset,
        returned: page.recipes.length,
        hasMore: page.offset + page.recipes.length < page.total,
      };
    },
  );

  define(
    "get_recipe",
    {
      module: "recipes",
      resource: { name: "recipes", op: "get" },
      title: "Get recipe",
      description:
        "One bill of materials (recipe) by id or exact code: its current version (the approved one, else the draft) with ingredient lines, yield, method, allergen roll-up (contains / may contain, and whether it mismatches the output item's declaration), and cost per batch and per output unit (partial when an ingredient has no cost). Also lists every version and any draft in progress. Pass `batches`, or `output_quantity` with `output_unit`, to get each line scaled as `scaledQuantity`.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        recipe: z.string().min(1).max(200).describe("Recipe id or exact code."),
        batches: z.number().positive().optional().describe("Scale to this many batches."),
        output_quantity: z
          .number()
          .positive()
          .optional()
          .describe("Scale to make this much (needs `output_unit`)."),
        output_unit: z.enum(unitCodes).optional(),
      },
    },
    async ({ workspace, recipe, batches, output_quantity, output_unit }, api) => {
      const slug = await slugOf(api, workspace);
      if (batches !== undefined && output_quantity !== undefined) {
        throw new ToolError("invalid_input", "Pass either `batches` or `output_quantity`, not both.");
      }
      if ((output_quantity === undefined) !== (output_unit === undefined)) {
        throw new ToolError("invalid_input", "`output_quantity` and `output_unit` go together.");
      }
      const found = await fetchRecipe(api, slug, await resolveRecipeId(api, slug, recipe));
      let current = found.currentVersion;
      let scale: unknown;
      if (current && (batches !== undefined || output_quantity !== undefined)) {
        const scaled = await api.call(
          ws(api).recipes[":id"].versions[":versionId"].$get({
            param: { slug, id: found.id, versionId: current.id },
            query: {
              ...(batches !== undefined ? { batches: String(batches) } : {}),
              ...(output_quantity !== undefined
                ? { outputQuantity: String(output_quantity), outputUnit: output_unit! }
                : {}),
            },
          }),
        );
        current = scaled as unknown as typeof current;
        scale = (scaled as { scale?: unknown }).scale;
      }
      return {
        ...header(found),
        versions: found.versions.map((v) => ({
          versionNumber: v.versionNumber,
          status: v.status,
          changeNote: v.changeNote,
          approvedAt: v.approvedAt,
          approvedBy: v.approvedByName,
        })),
        currentVersion: current ? versionView(current) : null,
        ...(scale ? { scale } : {}),
        draft: found.draftVersion ? versionView(found.draftVersion) : null,
        approvalNote: APPROVAL_NOTE,
      };
    },
  );

  define(
    "create_recipe",
    {
      module: "recipes",
      title: "Create recipe",
      description: `Create a recipe for a work-in-progress or finished item. \`code\` must be unique (search with list_recipes first). To include a first draft, pass \`yield_quantity\`, \`yield_unit\` and \`lines\` together; otherwise save one later with save_recipe_draft. ${APPROVAL_NOTE}`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        code: z.string().min(1).max(40),
        name: z.string().min(1).max(200),
        output_item: z.string().min(1).max(200).describe("Item id or exact code of what one batch makes."),
        description: z.string().max(2000).nullable().optional(),
        yield_quantity: draftFields.yield_quantity.optional(),
        yield_unit: draftFields.yield_unit.optional(),
        method: draftFields.method,
        change_note: draftFields.change_note,
        lines: draftFields.lines.optional(),
      },
    },
    async ({ workspace, code, name, output_item, description, ...draft }, api) => {
      const slug = await slugOf(api, workspace);
      const wantsDraft =
        draft.yield_quantity !== undefined || draft.yield_unit !== undefined || draft.lines !== undefined;
      if (
        wantsDraft &&
        (draft.yield_quantity === undefined || draft.yield_unit === undefined || !draft.lines)
      ) {
        throw new ToolError(
          "invalid_input",
          "A first draft needs `yield_quantity`, `yield_unit` and `lines` together.",
        );
      }
      const outputItemId = await resolveItemId(api, slug, output_item);
      const body = wantsDraft ? await draftBody(api, slug, draft as DraftArgs) : undefined;
      const created = await api.call(
        ws(api).recipes.$post({
          param: { slug },
          json: {
            code,
            name,
            outputItemId,
            ...(description !== undefined ? { description } : {}),
            ...(body ? { draft: body } : {}),
          },
        }),
      );
      return {
        ...header(created),
        versions: created.versions.map((v) => ({ versionNumber: v.versionNumber, status: v.status })),
        currentVersion: created.currentVersion ? versionView(created.currentVersion) : null,
        approvalNote: APPROVAL_NOTE,
      };
    },
  );

  define(
    "save_recipe_draft",
    {
      module: "recipes",
      title: "Save recipe draft",
      description: `Save the draft version of a recipe, by id or exact code. It replaces the draft's yield, method, change note and its whole list of ingredient lines; if there is no draft yet, a new version is started (send the full content, copying from the current version when changing it). Approved versions are never edited. Lines use an item id or exact code, a quantity and a unit that converts to the item's unit; archived items and the recipe's own output item are refused. ${APPROVAL_NOTE}`,
      annotations: UPDATE,
      input: {
        workspace: workspaceParam,
        recipe: z.string().min(1).max(200).describe("Recipe id or exact code."),
        ...draftFields,
      },
    },
    async ({ workspace, recipe, ...draft }, api) => {
      const slug = await slugOf(api, workspace);
      const id = await resolveRecipeId(api, slug, recipe);
      const saved = await api.call(
        ws(api).recipes[":id"].draft.$put({ param: { slug, id }, json: await draftBody(api, slug, draft) }),
      );
      return { recipe: id, ...versionView(saved), approvalNote: APPROVAL_NOTE };
    },
  );

  define(
    "update_recipe",
    {
      module: "recipes",
      title: "Update recipe",
      description:
        "Update a recipe's header by id or exact code: `code`, `name`, `description`, or `status` (set `archived` to retire it; there is no delete tool). Versions and lines are changed with save_recipe_draft.",
      annotations: UPDATE,
      input: {
        workspace: workspaceParam,
        recipe: z.string().min(1).max(200).describe("Recipe id or exact code."),
        code: z.string().min(1).max(40).optional(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        status: z.enum(recipeStatuses).optional(),
      },
    },
    async ({ workspace, recipe, code, name, description, status }, api) => {
      const slug = await slugOf(api, workspace);
      const json = {
        ...(code !== undefined ? { code } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(status !== undefined ? { status } : {}),
      };
      if (Object.keys(json).length === 0)
        throw new ToolError("invalid_input", "Pass at least one field to change.");
      const id = await resolveRecipeId(api, slug, recipe);
      return header(await api.call(ws(api).recipes[":id"].$patch({ param: { slug, id }, json })));
    },
  );
}
