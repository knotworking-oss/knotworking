import {
  allergens,
  compoundStyles,
  energyMethods,
  trafficLightLabels,
  labelItemTypes,
  labelStaleKindLabels,
  micronutrientKeys,
  micronutrientRows,
  micronutrients,
  missingNutritionReasonLabels,
  nutritionBases,
  nutritionPanelRows,
  nutritionSources,
  productLabelStatuses,
  type LabelStaleReason,
  type MissingNutrition,
  type NutritionPanel,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import { importCsvBody, importCsvInput, importCsvView, type ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const UPDATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const REPLACE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const DRAFT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APPROVAL_NOTE =
  "Approving a label is a sign-off made by a person with manage access in the Knotworking app; there is no tool for it. Tell the user when a draft is ready for approval.";
const MARKUP_NOTE =
  "Allergens are emphasised with ** markers (**milk**): render them in bold on a label, never as asterisks.";

/**
 * Labels and nutrition module: items' nutrition (from specifications), the computed ingredient
 * declaration and nutrition of a recipe, and product labels. Agents read, enter nutrition and
 * draft labels; approving a label is a person's.
 */
export function registerLabelTools({ define, slugOf, workspaceParam }: ToolContext) {
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
      `No item has the code "${wanted}". Use list_item_nutrition or list_items to find it, then pass its id or exact code.`,
    );
  }

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

  const panelView = (panel: NutritionPanel | null) =>
    panel
      ? {
          basis: panel.basis,
          rows: nutritionPanelRows(panel).map((r) => ({
            label: r.label,
            value: r.value,
            ...(r.portionValue !== undefined ? { perPortion: r.portionValue } : {}),
            ...(r.ri !== undefined ? { referenceIntake: r.ri } : {}),
          })),
          ...(panel.portion
            ? {
                portion: {
                  size: panel.portion.size,
                  unit: panel.basis === "100ml" ? "ml" : "g",
                  label: panel.portion.label,
                },
              }
            : {}),
          energy: panel.energyMethod ?? "declared",
          raw: panel.raw,
        }
      : null;
  const missingView = (missing: MissingNutrition[]) =>
    missing.map((m) => ({
      item: m.code,
      name: m.name,
      reason: missingNutritionReasonLabels[m.reason],
      ...(m.path.length ? { via: m.path } : {}),
    }));
  const staleView = (reasons: LabelStaleReason[]) =>
    reasons.map((r) => ({ reason: labelStaleKindLabels[r.kind], kind: r.kind, items: r.itemCodes }));
  const allergenNames = (codes: readonly (keyof typeof allergens)[]) => codes.map((c) => allergens[c]);

  type Label = Awaited<ReturnType<typeof getLabel>>;
  const getLabel = (api: Api, slug: string, id: string) =>
    api.call(ws(api).labelling.labels[":id"].$get({ param: { slug, id } }));

  const labelView = (l: Label) => ({
    id: l.id,
    recipe: l.recipe ? { code: l.recipe.code, name: l.recipe.name } : null,
    variant: l.variant ?? "Standard",
    otherLabels: l.otherLabels ?? [],
    labelVersion: l.versionNumber,
    status: l.status,
    recipeVersion: l.recipeVersion?.versionNumber ?? null,
    currentRecipeVersion: l.currentRecipeVersion?.versionNumber ?? null,
    productName: l.productName,
    ingredients: l.ingredientsMarkup,
    allergenStatement: l.allergenStatement,
    allergens: {
      contains: allergenNames(l.allergens.contains),
      mayContain: allergenNames(l.allergens.mayContain),
    },
    nutrition: l.includeNutrition
      ? l.nutrition
        ? {
            ...panelView(l.nutrition),
            // `computed` from the ingredients, or `entered` (typed in, e.g. a laboratory analysis).
            source: l.panelSource,
          }
        : "Incomplete: see missingNutrition"
      : "Not declared",
    storageInstructions: l.storageInstructions,
    dateGuidance: l.dateGuidance,
    netQuantity: l.netQuantity,
    /** The pack's EAN-13, printed as bars on the label's print page. */
    gtin: l.gtin ?? null,
    notes: l.notes,
    compoundStyle: l.compoundStyle,
    options: {
      volatileItemIds: l.volatileItemIds ?? [],
      energyMethod: l.energyMethod ?? "declared",
      negligibleAsZero: l.negligibleAsZero ?? false,
      portionSize: l.portionSize ?? null,
      portionLabel: l.portionLabel ?? null,
    },
    /** UK front-of-pack colours, from the declared values. */
    trafficLights: (l.trafficLights ?? []).map((t) => ({
      nutrient: t.nutrient,
      level: trafficLightLabels[t.level],
      colour: t.level,
    })),
    lastEditedBy: l.lastEditedByName ?? null,
    approvedAt: l.approvedAt,
    approvedBy: l.approvedByName,
    stale: l.stale,
    staleReasons: staleView(l.staleReasons),
    missingNutrition: l.facts ? missingView(l.facts.nutrition.missing) : [],
    warnings: l.facts?.warnings.map((w) => w.message) ?? [],
    history: l.history.map((h) => ({
      labelVersion: h.versionNumber,
      status: h.status,
      recipeVersion: h.recipeVersionNumber,
      approvedAt: h.approvedAt,
      approvedBy: h.approvedByName,
    })),
    markupNote: MARKUP_NOTE,
    approvalNote: APPROVAL_NOTE,
  });

  /** The label for a recipe: its draft when `prefer` is draft and there is one, else the approved one. */
  async function labelForRecipe(
    api: Api,
    slug: string,
    recipeId: string,
    prefer: "draft" | "approved",
    variant?: string,
  ) {
    const { labels: all } = await api.call(
      ws(api).labelling.labels.$get({
        param: { slug },
        query: { recipeId, status: "current", limit: "100" },
      }),
    );
    // A recipe may have several labels (variants): the one named, else the first one's.
    const named = variant
      ? all.filter((l) => (l.variant ?? "Standard").toLowerCase() === variant.toLowerCase())
      : all;
    const labels =
      variant || named.length === 0
        ? named
        : named.filter((l) => (l.variant ?? "Standard") === (named[0]!.variant ?? "Standard"));
    return labels.find((l) => l.status === prefer) ?? labels.find((l) => l.status !== prefer) ?? null;
  }

  define(
    "list_item_nutrition",
    {
      module: "labels",
      resource: { name: "item_nutrition", op: "list" },
      title: "List item nutrition",
      description:
        "Food items (ingredients, work in progress, finished goods) with their nutrition per 100 g (or 100 ml) and where it comes from: `entered` (from a supplier's specification), `recipe` (computed from the approved recipe of an item made in house) or `missing`. Filter `nutrition: missing` to find what still needs a specification before labels can be completed. Each item also shows its declared name and, for a bought-in compound, its components.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        nutrition: z
          .enum(["all", ...nutritionSources])
          .optional()
          .describe("Default all."),
        type: z.enum(labelItemTypes).optional(),
        query: z.string().max(200).optional().describe("Text in the item's code or name."),
        limit: z.number().int().min(1).max(500).optional().describe("Default 100."),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const page = await api.call(
        ws(api).labelling.items.$get({
          param: { slug },
          query: {
            ...(a.nutrition ? { nutrition: a.nutrition } : {}),
            ...(a.type ? { type: a.type } : {}),
            ...(a.query ? { q: a.query } : {}),
            limit: String(a.limit ?? 100),
            offset: String(a.offset ?? 0),
          },
        }),
      );
      return {
        items: page.items.map((i) => ({
          code: i.code,
          name: i.name,
          type: i.type,
          declarationName: i.declarationName,
          components: i.components,
          source: i.effective.source,
          basis: i.effective.basis,
          per100: i.effective.values,
          ...(i.micronutrients ? { vitaminsAndMinerals: i.micronutrients } : {}),
          ...(i.retention ? { retentionAfterCooking: i.retention } : {}),
          ...(i.madeBy ? { madeBy: `${i.madeBy.recipeCode} v${i.madeBy.versionNumber}` } : {}),
          ...(i.effective.missing.length ? { missing: missingView(i.effective.missing) } : {}),
          nutritionSource: i.nutritionSource,
        })),
        total: page.total,
        offset: page.offset,
        returned: page.items.length,
        hasMore: page.offset + page.items.length < page.total,
      };
    },
  );

  const nutritionArg = z
    .object({
      basis: z
        .enum(nutritionBases)
        .optional()
        .describe("Default 100g; 100ml for liquids specified per 100 ml."),
      energy_kj: z.number().min(0),
      energy_kcal: z.number().min(0),
      fat: z.number().min(0),
      saturates: z.number().min(0).describe("Of which saturates; not more than fat."),
      carbohydrate: z.number().min(0),
      sugars: z.number().min(0).describe("Of which sugars; not more than carbohydrate."),
      fibre: z.number().min(0).nullable().optional().describe("Optional."),
      protein: z.number().min(0),
      salt: z.number().min(0).describe("Salt, not sodium (salt = sodium × 2.5)."),
      polyols: z
        .number()
        .min(0)
        .nullable()
        .optional()
        .describe(
          "Polyols (sorbitol, maltitol, xylitol, …, not erythritol) in g: part of the carbohydrate. Only used for the calculated energy (10 kJ / 2.4 kcal per g); never declared.",
        ),
      erythritol: z
        .number()
        .min(0)
        .nullable()
        .optional()
        .describe("Erythritol in g: part of the carbohydrate, counts as 0 kJ. Never declared."),
      organic_acids: z
        .number()
        .min(0)
        .nullable()
        .optional()
        .describe("Organic acids in g (13 kJ / 3 kcal per g) for the calculated energy. Never declared."),
      alcohol: z
        .number()
        .min(0)
        .nullable()
        .optional()
        .describe("Alcohol (ethanol) in g (29 kJ / 7 kcal per g) for the calculated energy. Never declared."),
    })
    .describe("Per 100 g (or 100 ml), at most 3 decimal places, as the specification gives it.");

  define(
    "set_item_nutrition",
    {
      module: "labels",
      title: "Set item nutrition",
      description:
        'Enter or change an item\'s labelling data from its specification: nutrition per 100 g (or 100 ml), how it is named in an ingredients list (`declaration_name`, e.g. "Wheat flour"), and for a bought-in compound ingredient its own ingredients (`components`, e.g. "sugar, cocoa mass, cocoa butter, emulsifier: soya lecithin"). Fields left out keep their current value; pass `nutrition: null` to clear it. Items made in house with an approved recipe have their nutrition computed from it instead. Packaging has no labelling data. Approved labels that use the item are then reported stale for a person to review.',
      annotations: UPDATE,
      input: {
        workspace: workspaceParam,
        item: z.string().min(1).max(200).describe("Item id or exact stock code."),
        nutrition: nutritionArg.nullable().optional(),
        declaration_name: z.string().max(200).nullable().optional(),
        components: z.string().max(2000).nullable().optional(),
        vitamins_and_minerals: z
          .partialRecord(z.enum(micronutrientKeys), z.number().min(0))
          .nullable()
          .optional()
          .describe(
            `Optional vitamins and minerals per 100 g (or ml), in each one's own unit: ${micronutrientKeys.map((k) => `${k} (${micronutrients[k].unit})`).join(", ")}. Information only: never on the declared panel. Left out keeps the current ones; null clears them.`,
          ),
        retention_after_cooking: z
          .partialRecord(z.enum(micronutrientKeys), z.number().min(0).max(1))
          .nullable()
          .optional()
          .describe(
            "Fraction (0 to 1) of each vitamin or mineral that survives cooking this item in a recipe (0.6: 40% is lost); left out: no loss. Your own figures from a retention table or analysis. Left out keeps the current ones; null clears them.",
          ),
        source: z
          .string()
          .max(300)
          .nullable()
          .optional()
          .describe('Where the figures came from, e.g. "Supplier specification v3, March 2026".'),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const itemId = await resolveItemId(api, slug, a.item);
      const current = await api.call(ws(api).labelling.items[":itemId"].$get({ param: { slug, itemId } }));
      const n = a.nutrition;
      const nutrition =
        n === undefined
          ? current.nutrition
          : n === null
            ? null
            : {
                basis: n.basis ?? "100g",
                energyKj: n.energy_kj,
                energyKcal: n.energy_kcal,
                fat: n.fat,
                saturates: n.saturates,
                carbohydrate: n.carbohydrate,
                sugars: n.sugars,
                fibre: n.fibre ?? null,
                protein: n.protein,
                salt: n.salt,
                polyols: n.polyols ?? null,
                erythritol: n.erythritol ?? null,
                organicAcids: n.organic_acids ?? null,
                alcohol: n.alcohol ?? null,
              };
      const saved = await api.call(
        ws(api).labelling.items[":itemId"].$put({
          param: { slug, itemId },
          json: {
            declarationName: a.declaration_name !== undefined ? a.declaration_name : current.declarationName,
            components: a.components !== undefined ? a.components : current.components,
            nutrition,
            micronutrients:
              a.vitamins_and_minerals !== undefined ? a.vitamins_and_minerals : current.micronutrients,
            retention:
              a.retention_after_cooking !== undefined ? a.retention_after_cooking : current.retention,
            nutritionSource: a.source !== undefined ? a.source : current.nutritionSource,
          },
        }),
      );
      return {
        item: saved.code,
        declarationName: saved.declarationName,
        components: saved.components,
        nutrition: saved.nutrition,
        nutritionSource: saved.nutritionSource,
        usedInLabels:
          saved.effective.source === "recipe"
            ? "Computed from its recipe; entered figures are not used"
            : undefined,
      };
    },
  );

  define(
    "get_label_facts",
    {
      module: "labels",
      title: "Get label facts for a recipe",
      description: `Compute what a recipe's label would say, without saving anything: nutrition per 100 g (or 100 ml for liquids) rolled up from the ingredients and sub-recipes and adjusted for the yield (moisture loss), with the declared values rounded as the UK/EU guidance says and the raw values beside them; the ingredients list in descending order of weight with allergens emphasised; allergens (contains / may contain) and the allergen statement; and warnings. Ingredients without nutrition are listed under \`missingNutrition\` (never counted as zero). Defaults to the approved version (else the draft); \`version\` picks another by number. \`quid\` lists ingredients whose percentage is declared (those named in the product's name). ${MARKUP_NOTE}`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        recipe: z.string().min(1).max(200).describe("Recipe id or exact code."),
        version: z.number().int().min(1).optional().describe("Recipe version number."),
        compound_style: z
          .enum(compoundStyles)
          .optional()
          .describe(
            "bracketed (default): sub-recipes with their ingredients in brackets; expanded: merged into the list.",
          ),
        quid: z.array(z.string().min(1).max(200)).max(20).optional().describe("Item ids or codes."),
        volatile: z
          .array(z.string().min(1).max(200))
          .max(20)
          .optional()
          .describe(
            "Item ids or codes of added water and volatile ingredients: listed by their weight in the finished product. Added water of 5% or less of the finished product is left out of the list (the 5% rule).",
          ),
        energy_method: z
          .enum(energyMethods)
          .optional()
          .describe(
            "`calculated`: energy from fat, carbohydrate (less polyols), protein, fibre, polyols, organic acids and alcohol with the UK conversion factors.",
          ),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const recipeId = await resolveRecipeId(api, slug, a.recipe);
      const recipe = await api.call(ws(api).recipes[":id"].$get({ param: { slug, id: recipeId } }));
      const version =
        a.version !== undefined
          ? recipe.versions.find((v) => v.versionNumber === a.version)
          : (recipe.versions.find((v) => v.status === "approved") ??
            recipe.versions.find((v) => v.status === "draft"));
      if (!version) {
        throw new ToolError(
          "not_found",
          a.version !== undefined
            ? `${recipe.code} has no version ${a.version}.`
            : `${recipe.code} has no versions yet.`,
        );
      }
      const quid = a.quid ? await Promise.all(a.quid.map((q) => resolveItemId(api, slug, q))) : [];
      const volatile = a.volatile
        ? await Promise.all(a.volatile.map((q) => resolveItemId(api, slug, q)))
        : [];
      const facts = await api.call(
        ws(api).labelling.recipes[":id"].versions[":versionId"].$get({
          param: { slug, id: recipeId, versionId: version.id },
          query: {
            ...(a.compound_style ? { compoundStyle: a.compound_style } : {}),
            ...(quid.length ? { quid: quid.join(",") } : {}),
            ...(volatile.length ? { volatile: volatile.join(",") } : {}),
            ...(a.energy_method ? { energyMethod: a.energy_method } : {}),
          },
        }),
      );
      return {
        recipe: { code: facts.recipe.code, name: facts.recipe.name },
        version: { number: facts.version.versionNumber, status: facts.version.status },
        ingredients: facts.declarationMarkup,
        ...(facts.omittedWater?.length
          ? {
              omittedWater: facts.omittedWater.map((w) => ({
                item: w.code,
                grams: w.weightG,
                percentOfProduct: w.percent,
                why: "Added water of 5% or less of the finished product need not be listed (FIC Annex VII part A).",
              })),
            }
          : {}),
        allergens: {
          contains: allergenNames(facts.allergens.contains),
          mayContain: allergenNames(facts.mayContain),
          mismatchWithProductItem: facts.allergenMismatch,
        },
        allergenStatement: facts.allergenStatement,
        nutrition: {
          complete: facts.nutrition.complete,
          basis: facts.nutrition.basis,
          declared: panelView(facts.nutrition.panel),
          per100Raw: facts.nutrition.per100,
          bowlWeightG: facts.nutrition.bowlWeightG,
          yieldFactor: facts.nutrition.yieldFactor,
          ...(facts.nutrition.fibreMissing.length ? { fibreUnknownFor: facts.nutrition.fibreMissing } : {}),
          ...(Object.keys(facts.nutrition.micronutrients ?? {}).length
            ? {
                // After each ingredient's retention factors. Information only: never on the declared panel.
                vitaminsAndMinerals: {
                  per100: micronutrientRows(facts.nutrition.micronutrients).map((r) => ({
                    nutrient: r.label,
                    amount: `${r.value} ${r.unit}`,
                    nrvPercent: r.nrvPercent,
                  })),
                  ...(facts.nutrition.micronutrientsMissing.length
                    ? { noFiguresFor: facts.nutrition.micronutrientsMissing }
                    : {}),
                },
              }
            : {}),
        },
        missingNutrition: missingView(facts.nutrition.missing),
        warnings: facts.warnings.map((w) => w.message),
        markupNote: MARKUP_NOTE,
      };
    },
  );

  define(
    "list_product_labels",
    {
      module: "labels",
      resource: { name: "product_labels", op: "list" },
      title: "List product labels",
      description:
        "Product labels, one per recipe version they were approved for (a recipe may have several labels, told apart by `variant`: pack sizes, a customer's own label; each is drafted, numbered and approved on its own): status (draft, approved, superseded), the recipe and its version, and whether the label is `stale` with the reasons: an approved label is flagged for review (never edited) when the recipe has a newer approved version or an ingredient's nutrition, allergens or wording changed; a stale draft needs draft_product_label to refresh it. Default status `current` = drafts and approved labels. Filter `stale: true` for the labels to review.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        status: z.enum([...productLabelStatuses, "current", "all"]).optional(),
        stale: z.boolean().optional(),
        recipe: z.string().max(200).optional().describe("Recipe id or exact code."),
        query: z
          .string()
          .max(200)
          .optional()
          .describe("Text in the product name or the recipe's code or name."),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const recipeId = a.recipe ? await resolveRecipeId(api, slug, a.recipe) : undefined;
      const page = await api.call(
        ws(api).labelling.labels.$get({
          param: { slug },
          query: {
            ...(a.status ? { status: a.status } : {}),
            ...(a.stale !== undefined ? { stale: String(a.stale) as "true" | "false" } : {}),
            ...(recipeId ? { recipeId } : {}),
            ...(a.query ? { q: a.query } : {}),
            limit: String(a.limit ?? 50),
            offset: String(a.offset ?? 0),
          },
        }),
      );
      return {
        labels: page.labels.map((l) => ({
          id: l.id,
          recipe: l.recipe?.code ?? null,
          productName: l.productName,
          variant: l.variant ?? "Standard",
          labelVersion: l.versionNumber,
          status: l.status,
          recipeVersion: l.recipeVersion?.versionNumber ?? null,
          approvedAt: l.approvedAt,
          approvedBy: l.approvedByName,
          stale: l.stale,
          staleReasons: staleView(l.staleReasons),
        })),
        total: page.total,
        offset: page.offset,
        returned: page.labels.length,
        hasMore: page.offset + page.labels.length < page.total,
      };
    },
  );

  define(
    "get_product_label",
    {
      module: "labels",
      title: "Get product label",
      description: `One product label in full: product name, ingredients list, allergen statement, nutrition panel (declared values, and its \`source\`: \`computed\` from the ingredients or \`entered\` by a person), storage and date wording, net quantity, approval, whether it is stale and why, nutrition still missing, warnings, and the label's version history. Pass the label id, or a recipe (id or code) for its approved label (\`draft: true\` for its draft). ${MARKUP_NOTE}`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        label_id: z.string().uuid().optional(),
        recipe: z.string().max(200).optional().describe("Recipe id or exact code."),
        draft: z
          .boolean()
          .optional()
          .describe("With `recipe`: its draft label rather than the approved one."),
        variant: z
          .string()
          .max(80)
          .optional()
          .describe("With `recipe`: which of its labels (default: the first)."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      if (!a.label_id && !a.recipe) throw new ToolError("invalid_input", "Pass `label_id` or `recipe`.");
      let id = a.label_id;
      if (!id) {
        const recipeId = await resolveRecipeId(api, slug, a.recipe!);
        const found = await labelForRecipe(api, slug, recipeId, a.draft ? "draft" : "approved", a.variant);
        if (!found) {
          throw new ToolError(
            "not_found",
            `${a.recipe} has no label yet. Use draft_product_label to draft one.`,
          );
        }
        id = found.id;
      }
      return labelView(await getLabel(api, slug, id));
    },
  );

  define(
    "import_item_nutrition_csv",
    {
      module: "labels",
      title: "Import item nutrition from CSV",
      description: `Set items' nutrition per 100 g (or 100 ml) from CSV text with a header row: a supplier's specification sheet, or McCance and Widdowson's composition of foods columns. Rows are matched to existing food items by stock code (\`code\`), or by exact item name (\`name\`) when there is no code; an import never creates items. Columns (any order, headers matched without case or punctuation): code or name; basis (100g or 100ml; default from the item's unit); energy kJ and/or energy kcal (one is worked out from the other, 1 kcal = 4.184 kJ); fat, saturates ("Satd FA /100g fd"), carbohydrate, sugars ("Total sugars"), protein and salt (or sodium: "sodium" is g, "sodium mg" is mg, salt = sodium × 2.5) are all needed; optional fibre (AOAC), polyols, erythritol, organic acids, alcohol, vitamins and minerals (${micronutrientKeys.map((k) => micronutrients[k].label).join(", ")}), declaration name, components and source. Cells: "Tr" or "<0.1" read as 0; "N", "-" or empty are not given. A file with a vitamin or mineral column replaces the item's vitamins and minerals; retention factors are never imported. The nutrition of an item made by an approved recipe is computed, so the entered figures are not used for it. Use \`dry_run: true\` first: it checks every row and previews what would be created or updated, writing nothing. A real import writes every row in one go, or nothing if any row has a problem (each listed with its row number). Up to 5000 rows. Approved labels that use a changed item are then reported stale for a person to review.`,
      annotations: REPLACE,
      input: { workspace: workspaceParam, ...importCsvInput },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return importCsvView(
        await api.call(ws(api).labelling.items.import.$post({ param: { slug }, json: importCsvBody(a) })),
      );
    },
  );

  define(
    "draft_product_label",
    {
      module: "labels",
      title: "Draft a product label",
      description: `Draft or update the label of a recipe (id or code), against its approved version. With no draft yet, one is created from the computed data (ingredients list, allergens, nutrition panel, storage and date wording from the product item; text from the approved label when there is one). With a draft, it is refreshed from current data when \`refresh\` is true or the options change (\`compound_style\`, \`quid\`, \`declare_nutrition\`), which redrafts the ingredients, allergens and nutrition and keeps the text fields. The text fields given are then written: \`ingredients\` uses ** around allergens. A nutrition panel is only drafted when every ingredient has nutrition (see missingNutrition). Approved labels are never edited: this makes a new draft to correct one. ${APPROVAL_NOTE}`,
      annotations: DRAFT,
      input: {
        workspace: workspaceParam,
        recipe: z.string().min(1).max(200).describe("Recipe id or exact code."),
        variant: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe(
            "Which of the recipe's labels (a pack size, a customer's own label); default Standard. A new name starts another label.",
          ),
        refresh: z
          .boolean()
          .optional()
          .describe("Redraft an existing draft's computed parts from current data."),
        volatile: z
          .array(z.string().min(1).max(200))
          .max(20)
          .optional()
          .describe(
            "Item ids or codes of added water and volatile ingredients: listed by their weight in the finished product, not at the mixing bowl.",
          ),
        energy_method: z
          .enum(energyMethods)
          .optional()
          .describe(
            "`calculated`: energy from fat, carbohydrate, protein and fibre with the UK conversion factors.",
          ),
        negligible_as_zero: z.boolean().optional().describe('Declare "<0.5 g" amounts as "0 g".'),
        portion_size: z
          .number()
          .positive()
          .max(5000)
          .nullable()
          .optional()
          .describe(
            "Portion in g (ml for a liquid): adds per-portion values and % reference intake. null removes it.",
          ),
        portion_label: z.string().max(60).nullable().optional().describe('E.g. "1 slice".'),
        compound_style: z.enum(compoundStyles).optional(),
        quid: z
          .array(z.string().min(1).max(200))
          .max(20)
          .optional()
          .describe("Item ids or codes whose percentage is declared."),
        declare_nutrition: z
          .boolean()
          .optional()
          .describe("False for a product exempt from the nutrition declaration."),
        product_name: z.string().min(1).max(300).optional(),
        ingredients: z
          .string()
          .min(1)
          .max(10_000)
          .optional()
          .describe("The whole list, ** around allergens."),
        allergen_statement: z.string().max(2000).nullable().optional(),
        storage_instructions: z.string().max(1000).nullable().optional(),
        date_guidance: z.string().max(500).nullable().optional(),
        net_quantity: z.string().max(100).nullable().optional(),
        gtin: z
          .string()
          .max(40)
          .nullable()
          .optional()
          .describe(
            "The pack's barcode: an EAN-13 (a 12-digit UPC-A is accepted), check digit validated. null or empty removes it.",
          ),
        notes: z.string().max(2000).nullable().optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const recipeId = await resolveRecipeId(api, slug, a.recipe);
      const quidItemIds = a.quid
        ? await Promise.all(a.quid.map((q) => resolveItemId(api, slug, q)))
        : undefined;
      const volatileItemIds = a.volatile
        ? await Promise.all(a.volatile.map((q) => resolveItemId(api, slug, q)))
        : undefined;
      const options = {
        ...(a.compound_style ? { compoundStyle: a.compound_style } : {}),
        ...(quidItemIds ? { quidItemIds } : {}),
        ...(volatileItemIds ? { volatileItemIds } : {}),
        ...(a.energy_method ? { energyMethod: a.energy_method } : {}),
        ...(a.negligible_as_zero !== undefined ? { negligibleAsZero: a.negligible_as_zero } : {}),
        ...(a.portion_size !== undefined ? { portionSize: a.portion_size } : {}),
        ...(a.portion_label !== undefined ? { portionLabel: a.portion_label } : {}),
        ...(a.declare_nutrition !== undefined ? { includeNutrition: a.declare_nutrition } : {}),
      };
      const existing = await labelForRecipe(api, slug, recipeId, "draft", a.variant ?? "Standard");
      let id: string;
      let action: "created" | "refreshed" | "updated";
      if (existing?.status === "draft") {
        id = existing.id;
        action = "updated";
        if (a.refresh || Object.keys(options).length) {
          await api.call(
            ws(api).labelling.labels[":id"].refresh.$post({ param: { slug, id }, json: options }),
          );
          action = "refreshed";
        }
      } else {
        const created = await api.call(
          ws(api).labelling.labels.$post({
            param: { slug },
            json: { recipeId, ...(a.variant ? { variant: a.variant } : {}), ...options },
          }),
        );
        id = created.id;
        action = "created";
      }
      const patch = {
        ...(a.product_name !== undefined ? { productName: a.product_name } : {}),
        ...(a.ingredients !== undefined ? { ingredients: a.ingredients } : {}),
        ...(a.allergen_statement !== undefined ? { allergenStatement: a.allergen_statement } : {}),
        ...(a.storage_instructions !== undefined ? { storageInstructions: a.storage_instructions } : {}),
        ...(a.date_guidance !== undefined ? { dateGuidance: a.date_guidance } : {}),
        ...(a.net_quantity !== undefined ? { netQuantity: a.net_quantity } : {}),
        ...(a.gtin !== undefined ? { gtin: a.gtin ?? "" } : {}),
        ...(a.notes !== undefined ? { notes: a.notes } : {}),
      };
      if (Object.keys(patch).length) {
        await api.call(ws(api).labelling.labels[":id"].$patch({ param: { slug, id }, json: patch }));
      }
      return { action, ...labelView(await getLabel(api, slug, id)) };
    },
  );
}
