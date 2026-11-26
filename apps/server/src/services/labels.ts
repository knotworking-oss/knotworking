import { foodItemFields, selectFoodItems } from "./food-items";
import {
  canApproveProductLabel,
  cleanMicronutrientMap,
  micronutrientRows,
  compareLabelSources,
  DEFAULT_LABEL_VARIANT,
  restylePanel,
  trafficLights,
  type EnergyMethod,
  computeLabelFacts,
  dateGuidance,
  isFoodItemType,
  itemNutrition,
  labelSourceSnapshot,
  mandatoryNutrientKeys,
  netQuantityFor,
  nutritionPanel,
  parseSegmentsMarkup,
  segmentsMarkup,
  segmentsText,
  storageGuidance,
  type CompoundStyle,
  type ItemLabelDataInput,
  type LabelFacts,
  type LabelFactsQuery,
  type LabelGraph,
  type LabelItemFacts,
  type LabelRecipeVersion,
  type LabelStaleReason,
  type ModuleId,
  type LabellingItemListQuery,
  type NutritionEntry,
  type NutritionInput,
  type ProductLabelCreateInput,
  type ProductLabelListQuery,
  type ProductLabelRefreshInput,
  type ProductLabelUpdateInput,
} from "@knotworking/core";
import {
  itemLabelData,
  items,
  lockWorkspaceLog,
  productLabels,
  recipeLines,
  recipes,
  recipeVersions,
  recordChanges,
  users,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { audience, memberAccess } from "./notifications";

/**
 * Labels and nutrition module.
 *
 * Items carry labelling data (declared name, a bought-in compound's components, nutrition per
 * 100 g or 100 ml). Everything else is computed on read from a {@link LabelGraph} of the
 * workspace: every item with its data, and the approved version of every active recipe, which is
 * how sub-recipes are followed. A product label is drafted from those computations, edited, and
 * approved by a person; it keeps a snapshot of what it was drafted from, and is reported stale
 * (never edited) when the recipe or an ingredient changes after that.
 *
 * Labels and labelling data are not in the bootstrap; every write appends to the sync log in the
 * same transaction.
 */

type ItemRow = typeof items.$inferSelect & { food?: ReturnType<typeof foodItemFields> | null };
type DataRow = typeof itemLabelData.$inferSelect;
type LabelRow = typeof productLabels.$inferSelect;
type RecipeRow = typeof recipes.$inferSelect;
type VersionRow = typeof recipeVersions.$inferSelect;

const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;

// ─── The graph ───────────────────────────────────────────────────────────────

/** An item's entered nutrition, when every mandatory value is there. */
function nutritionOf(row: DataRow | undefined): NutritionEntry | null {
  if (!row) return null;
  const { energyKj, energyKcal, fat, saturates, carbohydrate, sugars, protein, salt } = row;
  if (
    energyKj === null ||
    energyKcal === null ||
    fat === null ||
    saturates === null ||
    carbohydrate === null ||
    sugars === null ||
    protein === null ||
    salt === null
  ) {
    return null;
  }
  return {
    basis: row.nutritionBasis,
    values: {
      energyKj,
      energyKcal,
      fat,
      saturates,
      carbohydrate,
      sugars,
      fibre: row.fibre,
      protein,
      salt,
      polyols: row.polyols,
      erythritol: row.erythritol,
      organicAcids: row.organicAcids,
      alcohol: row.alcohol,
    },
  };
}

const factsOf = (item: ItemRow, data: DataRow | undefined): LabelItemFacts => ({
  id: item.id,
  code: item.code,
  name: item.name,
  type: item.type,
  unit: item.unit,
  densityGPerMl: item.densityGPerMl,
  unitWeightG: item.unitWeightG,
  ...foodItemFields(item.food),
  declarationName: data?.declarationName ?? null,
  components: data?.components ?? null,
  nutrition: nutritionOf(data),
  micronutrients: cleanMicronutrientMap(data?.micronutrients),
  retention: cleanMicronutrientMap(data?.retention),
});

/** Lines of some versions, in recipe order. */
async function linesByVersion(db: Executor, versionIds: string[]) {
  const out = new Map<string, LabelRecipeVersion["lines"][number][]>();
  if (versionIds.length === 0) return out;
  const rows = await db
    .select({
      versionId: recipeLines.versionId,
      itemId: recipeLines.itemId,
      quantity: recipeLines.quantity,
      unit: recipeLines.unit,
    })
    .from(recipeLines)
    .where(inArray(recipeLines.versionId, [...new Set(versionIds)]))
    .orderBy(asc(recipeLines.sortOrder), asc(recipeLines.id));
  for (const row of rows) {
    const list = out.get(row.versionId) ?? [];
    list.push({ itemId: row.itemId, quantity: row.quantity, unit: row.unit });
    out.set(row.versionId, list);
  }
  return out;
}

const toLabelVersion = (
  version: VersionRow,
  recipe: Pick<RecipeRow, "id" | "code" | "outputItemId">,
  lines: LabelRecipeVersion["lines"],
): LabelRecipeVersion => ({
  recipeId: recipe.id,
  recipeCode: recipe.code,
  versionId: version.id,
  versionNumber: version.versionNumber,
  outputItemId: recipe.outputItemId,
  yieldQuantity: version.yieldQuantity,
  yieldUnit: version.yieldUnit,
  lines,
});

/**
 * Every item of the workspace (deleted ones too: old versions still name them) with its labelling
 * data, and for each item made in house the approved version of its active recipe. When several
 * active recipes make the same item, the one approved most recently is followed.
 */
export async function loadLabelGraph(db: Executor, workspaceId: string): Promise<LabelGraph> {
  const [itemRows, dataRows, approved] = await Promise.all([
    selectFoodItems(db).where(eq(items.workspaceId, workspaceId)),
    db.select().from(itemLabelData).where(eq(itemLabelData.workspaceId, workspaceId)),
    db
      .select({ version: recipeVersions, recipe: recipes })
      .from(recipeVersions)
      .innerJoin(recipes, eq(recipes.id, recipeVersions.recipeId))
      .where(
        and(
          eq(recipeVersions.workspaceId, workspaceId),
          eq(recipeVersions.status, "approved"),
          isNull(recipeVersions.deletedAt),
          isNull(recipes.deletedAt),
          eq(recipes.status, "active"),
        ),
      )
      .orderBy(desc(recipeVersions.approvedAt), desc(recipeVersions.id)),
  ]);
  const data = new Map(dataRows.map((d) => [d.itemId, d]));
  const chosen = new Map<string, { version: VersionRow; recipe: RecipeRow }>();
  for (const row of approved) {
    if (!chosen.has(row.recipe.outputItemId)) chosen.set(row.recipe.outputItemId, row);
  }
  const lines = await linesByVersion(
    db,
    [...chosen.values()].map((c) => c.version.id),
  );
  return {
    items: new Map(itemRows.map((i) => [i.id, factsOf(i, data.get(i.id))])),
    subRecipes: new Map(
      [...chosen].map(([itemId, c]) => [
        itemId,
        toLabelVersion(c.version, c.recipe, lines.get(c.version.id) ?? []),
      ]),
    ),
  };
}

/** Recipe versions (any status) as the roll-ups read them, by version id. */
async function loadVersions(db: Executor, workspaceId: string, versionIds: string[]) {
  const out = new Map<string, LabelRecipeVersion & { status: VersionRow["status"] }>();
  if (versionIds.length === 0) return out;
  const rows = await db
    .select({ version: recipeVersions, recipe: recipes })
    .from(recipeVersions)
    .innerJoin(recipes, eq(recipes.id, recipeVersions.recipeId))
    .where(
      and(eq(recipeVersions.workspaceId, workspaceId), inArray(recipeVersions.id, [...new Set(versionIds)])),
    );
  const lines = await linesByVersion(
    db,
    rows.map((r) => r.version.id),
  );
  for (const { version, recipe } of rows) {
    out.set(version.id, {
      ...toLabelVersion(version, recipe, lines.get(version.id) ?? []),
      status: version.status,
    });
  }
  return out;
}

/** The approved version of each recipe, by recipe id. */
async function approvedVersions(db: Executor, recipeIds: string[]) {
  const out = new Map<string, VersionRow>();
  if (recipeIds.length === 0) return out;
  const rows = await db
    .select()
    .from(recipeVersions)
    .where(
      and(
        inArray(recipeVersions.recipeId, [...new Set(recipeIds)]),
        eq(recipeVersions.status, "approved"),
        isNull(recipeVersions.deletedAt),
      ),
    );
  for (const row of rows) out.set(row.recipeId, row);
  return out;
}

async function userNames(db: Executor, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((u) => [u.id, u.name]));
}

/** Facts without the snapshot (internal: what staleness is compared against). */
const factsView = ({ snapshot: _snapshot, ...facts }: LabelFacts) => ({
  ...facts,
  nutrition: {
    ...facts.nutrition,
    /** Vitamins and minerals of the roll-up as rows (information only: never on the panel). */
    micronutrientRows: micronutrientRows(facts.nutrition.micronutrients),
  },
});

// ─── Items' labelling data ───────────────────────────────────────────────────

function itemView(item: ItemRow, data: DataRow | undefined, graph: LabelGraph, names: Map<string, string>) {
  const effective = itemNutrition(item.id, graph);
  const sub = graph.subRecipes.get(item.id);
  const entered = nutritionOf(data);
  return {
    itemId: item.id,
    code: item.code,
    name: item.name,
    type: item.type,
    status: item.status,
    unit: item.unit,
    allergens: foodItemFields(item.food).allergens,
    mayContain: foodItemFields(item.food).mayContain,
    declarationName: data?.declarationName ?? null,
    components: data?.components ?? null,
    /** As entered (from a specification). Not used while the item is made by an approved recipe. */
    nutrition: entered ? { basis: entered.basis, ...entered.values } : null,
    micronutrients: cleanMicronutrientMap(data?.micronutrients),
    retention: cleanMicronutrientMap(data?.retention),
    nutritionSource: data?.nutritionSource ?? null,
    updatedAt: data?.updatedAt ?? null,
    updatedByName: data?.updatedBy ? (names.get(data.updatedBy) ?? null) : null,
    /** The recipe version this item's nutrition is computed from, when made in house. */
    madeBy: sub
      ? {
          recipeId: sub.recipeId,
          recipeCode: sub.recipeCode,
          versionId: sub.versionId,
          versionNumber: sub.versionNumber,
        }
      : null,
    /** What the roll-ups use: `entered`, `recipe` (computed) or `missing`. */
    effective: {
      source: effective.source,
      basis: effective.entry?.basis ?? effective.rollup?.basis ?? entered?.basis ?? "100g",
      values: effective.entry?.values ?? null,
      missing: effective.rollup?.missing ?? [],
    },
  };
}

export async function listLabellingItems(db: Database, workspaceId: string, query: LabellingItemListQuery) {
  const where: (SQL | undefined)[] = [
    eq(items.workspaceId, workspaceId),
    isNull(items.deletedAt),
    ne(items.type, "packaging"),
  ];
  if (query.status !== "all") where.push(eq(items.status, query.status));
  if (query.type) where.push(eq(items.type, query.type));
  if (query.q) {
    where.push(
      sql`(${items.name} ilike ${like(query.q)} escape '!' or ${items.code} ilike ${like(query.q)} escape '!')`,
    );
  }
  const [rows, graph, dataRows] = await Promise.all([
    selectFoodItems(db)
      .where(and(...where))
      .orderBy(asc(items.code), asc(items.id)),
    loadLabelGraph(db, workspaceId),
    db.select().from(itemLabelData).where(eq(itemLabelData.workspaceId, workspaceId)),
  ]);
  const data = new Map(dataRows.map((d) => [d.itemId, d]));
  const names = await userNames(
    db,
    dataRows.map((d) => d.updatedBy),
  );
  const all = rows.map((item) => itemView(item, data.get(item.id), graph, names));
  const filtered =
    query.nutrition === "all" ? all : all.filter((i) => i.effective.source === query.nutrition);
  return {
    items: filtered.slice(query.offset, query.offset + query.limit),
    total: filtered.length,
    limit: query.limit,
    offset: query.offset,
  };
}

async function findItem(db: Executor, workspaceId: string, itemId: string) {
  const [row] = await selectFoodItems(db).where(
    and(eq(items.id, itemId), eq(items.workspaceId, workspaceId), isNull(items.deletedAt)),
  );
  if (!row) throw notFound("Item");
  return row;
}

export async function getLabellingItem(db: Database, workspaceId: string, itemId: string) {
  const item = await findItem(db, workspaceId, itemId);
  const [[data], graph] = await Promise.all([
    db.select().from(itemLabelData).where(eq(itemLabelData.itemId, item.id)),
    loadLabelGraph(db, workspaceId),
  ]);
  const names = await userNames(db, [data?.updatedBy ?? null]);
  return itemView(item, data, graph, names);
}

export const dataChange = (row: DataRow): ChangeInput => {
  const { workspaceId: _ws, deletedAt: _deleted, ...data } = row;
  return { entity: "item_label_data", entityId: row.id, action: "upsert", data };
};

/** Replaces an item's labelling data. Packaging is not food and has none. */
export async function setItemLabelData(
  db: Database,
  workspaceId: string,
  actorId: string,
  itemId: string,
  input: ItemLabelDataInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const item = await findItem(tx, workspaceId, itemId);
    if (!isFoodItemType(item.type)) {
      throw badRequest(`${item.code} is packaging; only food items have labelling data`);
    }
    const n = input.nutrition ?? null;
    const fields = {
      declarationName: input.declarationName ?? null,
      components: input.components ?? null,
      nutritionBasis: n?.basis ?? ("100g" as const),
      energyKj: n?.energyKj ?? null,
      energyKcal: n?.energyKcal ?? null,
      fat: n?.fat ?? null,
      saturates: n?.saturates ?? null,
      carbohydrate: n?.carbohydrate ?? null,
      sugars: n?.sugars ?? null,
      fibre: n?.fibre ?? null,
      protein: n?.protein ?? null,
      salt: n?.salt ?? null,
      polyols: n?.polyols || null,
      erythritol: n?.erythritol || null,
      organicAcids: n?.organicAcids || null,
      alcohol: n?.alcohol || null,
      micronutrients: cleanMicronutrientMap(input.micronutrients),
      retention: cleanMicronutrientMap(input.retention),
      nutritionSource: input.nutritionSource ?? null,
      updatedBy: actorId,
    };
    const [row] = await tx
      .insert(itemLabelData)
      .values({ ...fields, workspaceId, itemId: item.id })
      .onConflictDoUpdate({ target: itemLabelData.itemId, set: { ...fields, updatedAt: new Date() } })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [dataChange(row!)]);
  });
  return getLabellingItem(db, workspaceId, itemId);
}

// ─── Computed facts for any recipe version ───────────────────────────────────

async function findRecipe(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(recipes)
    .where(and(eq(recipes.id, id), eq(recipes.workspaceId, workspaceId), isNull(recipes.deletedAt)));
  if (!row) throw notFound("Recipe");
  return row;
}

/** Nutrition, declaration and allergens of a recipe version, computed now (draft versions too). */
export async function getVersionFacts(
  db: Database,
  workspaceId: string,
  recipeId: string,
  versionId: string,
  query: LabelFactsQuery,
) {
  const recipe = await findRecipe(db, workspaceId, recipeId);
  const [version] = await db
    .select()
    .from(recipeVersions)
    .where(
      and(
        eq(recipeVersions.id, versionId),
        eq(recipeVersions.recipeId, recipe.id),
        isNull(recipeVersions.deletedAt),
      ),
    );
  if (!version) throw notFound("Recipe version");
  const [graph, lines] = await Promise.all([
    loadLabelGraph(db, workspaceId),
    linesByVersion(db, [version.id]),
  ]);
  const facts = computeLabelFacts(toLabelVersion(version, recipe, lines.get(version.id) ?? []), graph, {
    compoundStyle: query.compoundStyle,
    quidItemIds: query.quid,
    volatileItemIds: query.volatile,
    energyMethod: query.energyMethod,
    negligibleAsZero: query.negligibleAsZero,
    portionSize: query.portionSize,
    portionLabel: query.portionLabel,
  });
  const output = graph.items.get(recipe.outputItemId);
  const storage = output?.storage ?? "ambient";
  return {
    /**
     * The label as it would read, never stored and never approvable: a label is only drafted (and
     * then approved) from a recipe's approved version. For a draft recipe version it carries the
     * watermark `DRAFT`, for a superseded one `SUPERSEDED`; clients print it across the preview.
     */
    preview: {
      previewOnly: true,
      watermark: version.status === "draft" ? "DRAFT" : version.status === "superseded" ? "SUPERSEDED" : null,
      productName: output?.name ?? recipe.name,
      ingredients: facts.declaration,
      allergenStatement: facts.allergenStatement || null,
      nutrition: facts.nutrition.panel,
      trafficLights: facts.nutrition.trafficLights,
      storageInstructions: storageGuidance[storage],
      dateGuidance: dateGuidance(storage, output?.shelfLifeDays),
      netQuantity: output ? netQuantityFor(output) : null,
    },
    recipe: { id: recipe.id, code: recipe.code, name: recipe.name },
    version: { id: version.id, versionNumber: version.versionNumber, status: version.status },
    outputItem: output ? { id: output.id, code: output.code, name: output.name, unit: output.unit } : null,
    ...factsView(facts),
    declarationMarkup: segmentsMarkup(facts.declaration),
    declarationText: segmentsText(facts.declaration),
  };
}

// ─── Product labels: reading ─────────────────────────────────────────────────

const labelChange = (row: LabelRow): ChangeInput => {
  // The snapshot is internal bookkeeping: clients get `stale` from the API.
  const { workspaceId: _ws, deletedAt: _deleted, sourceSnapshot: _snapshot, ...data } = row;
  return { entity: "product_label", entityId: row.id, action: "upsert", data };
};

/**
 * Why a label is out of date: approved and draft labels only (a superseded label is history).
 * An approved label then needs review; a draft needs a refresh before it can be approved.
 */
function staleReasons(
  row: LabelRow,
  graph: LabelGraph,
  version: LabelRecipeVersion | undefined,
  currentApproved: VersionRow | undefined,
): LabelStaleReason[] {
  if (row.status === "superseded" || !version) return [];
  const reasons = compareLabelSources(
    row.sourceSnapshot,
    labelSourceSnapshot(version, graph),
    row.includeNutrition,
  );
  if (currentApproved?.id !== row.recipeVersionId) {
    reasons.unshift({ kind: "recipe_version_superseded", itemCodes: [] });
  }
  return reasons;
}

interface LabelContext {
  graph: LabelGraph;
  versions: Map<string, LabelRecipeVersion & { status: VersionRow["status"] }>;
  approved: Map<string, VersionRow>;
  recipes: Map<string, RecipeRow>;
  names: Map<string, string>;
}

async function labelContext(db: Executor, workspaceId: string, rows: LabelRow[], graph?: LabelGraph) {
  const [g, versions, approved, recipeRows, names] = await Promise.all([
    graph ?? loadLabelGraph(db, workspaceId),
    loadVersions(
      db,
      workspaceId,
      rows.map((r) => r.recipeVersionId),
    ),
    approvedVersions(
      db,
      rows.map((r) => r.recipeId),
    ),
    rows.length
      ? db
          .select()
          .from(recipes)
          .where(inArray(recipes.id, [...new Set(rows.map((r) => r.recipeId))]))
      : Promise.resolve([] as RecipeRow[]),
    userNames(
      db,
      rows.flatMap((r) => [r.approvedBy, r.createdBy, r.lastEditedBy]),
    ),
  ]);
  return {
    graph: g,
    versions,
    approved,
    recipes: new Map(recipeRows.map((r) => [r.id, r])),
    names,
  } satisfies LabelContext;
}

function labelView(row: LabelRow, ctx: LabelContext) {
  const { workspaceId: _ws, deletedAt: _deleted, sourceSnapshot: _snapshot, ...fields } = row;
  const recipe = ctx.recipes.get(row.recipeId);
  const version = ctx.versions.get(row.recipeVersionId);
  const reasons = staleReasons(row, ctx.graph, version, ctx.approved.get(row.recipeId));
  const current = ctx.approved.get(row.recipeId);
  return {
    ...fields,
    ingredientsMarkup: segmentsMarkup(row.ingredients),
    ingredientsText: segmentsText(row.ingredients),
    recipe: recipe ? { id: recipe.id, code: recipe.code, name: recipe.name, status: recipe.status } : null,
    recipeVersion: version
      ? { id: version.versionId, versionNumber: version.versionNumber, status: version.status }
      : null,
    /** The recipe's approved version now (what a refresh drafts against). */
    currentRecipeVersion: current ? { id: current.id, versionNumber: current.versionNumber } : null,
    approvedByName: row.approvedBy ? (ctx.names.get(row.approvedBy) ?? null) : null,
    createdByName: row.createdBy ? (ctx.names.get(row.createdBy) ?? null) : null,
    lastEditedByName: row.lastEditedBy ? (ctx.names.get(row.lastEditedBy) ?? null) : null,
    /** Front-of-pack traffic lights (UK guidance) for the panel; null without one. */
    trafficLights: row.nutrition ? trafficLights(row.nutrition) : null,
    /**
     * Approved: needs review (the recipe or an ingredient changed after approval; it is never
     * edited). Draft: out of date, refresh before approving.
     */
    stale: reasons.length > 0,
    staleReasons: reasons,
  };
}

async function findLabel(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(productLabels)
    .where(
      and(
        eq(productLabels.id, id),
        eq(productLabels.workspaceId, workspaceId),
        isNull(productLabels.deletedAt),
      ),
    );
  if (!row) throw notFound("Label");
  return row;
}

export async function listProductLabels(
  db: Database,
  workspaceId: string,
  query: ProductLabelListQuery,
  /** Only these labels (the notification sweep narrows to labels it hasn't told everyone about). */
  options: { ids?: string[] } = {},
) {
  const where: (SQL | undefined)[] = [
    eq(productLabels.workspaceId, workspaceId),
    isNull(productLabels.deletedAt),
  ];
  if (options.ids) where.push(inArray(productLabels.id, options.ids));
  if (query.recipeId) where.push(eq(productLabels.recipeId, query.recipeId));
  if (query.status === "current") where.push(inArray(productLabels.status, ["draft", "approved"]));
  else if (query.status !== "all") where.push(eq(productLabels.status, query.status));
  if (query.q) {
    where.push(
      sql`(${productLabels.productName} ilike ${like(query.q)} escape '!' or ${productLabels.variant} ilike ${like(query.q)} escape '!' or exists (select 1 from ${recipes} r
        where r.id = ${productLabels.recipeId} and (r.name ilike ${like(query.q)} escape '!' or r.code ilike ${like(query.q)} escape '!')))`,
    );
  }
  const rows = await db
    .select()
    .from(productLabels)
    .where(and(...where))
    .orderBy(asc(productLabels.productName), desc(productLabels.versionNumber), asc(productLabels.id));
  const ctx = await labelContext(db, workspaceId, rows);
  const views = rows.map((row) => labelView(row, ctx));
  const filtered = query.stale === undefined ? views : views.filter((v) => v.stale === query.stale);
  return {
    labels: filtered.slice(query.offset, query.offset + query.limit),
    total: filtered.length,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getProductLabel(db: Database, workspaceId: string, id: string) {
  const row = await findLabel(db, workspaceId, id);
  const history = await db
    .select()
    .from(productLabels)
    .where(and(eq(productLabels.recipeId, row.recipeId), isNull(productLabels.deletedAt)))
    .orderBy(desc(productLabels.versionNumber));
  const siblings = history.filter((h) => h.variant.toLowerCase() !== row.variant.toLowerCase());
  const ownHistory = history.filter((h) => h.variant.toLowerCase() === row.variant.toLowerCase());
  const ctx = await labelContext(db, workspaceId, history);
  const version = ctx.versions.get(row.recipeVersionId);
  const facts = version
    ? computeLabelFacts(version, ctx.graph, {
        compoundStyle: row.compoundStyle,
        quidItemIds: row.quidItemIds,
        volatileItemIds: row.volatileItemIds,
        energyMethod: row.energyMethod,
        negligibleAsZero: row.negligibleAsZero,
        portionSize: row.portionSize,
        portionLabel: row.portionLabel,
      })
    : null;
  return {
    ...labelView(row, ctx),
    /** Computed now from the label's recipe version and current data, for comparison. */
    facts: facts ? { ...factsView(facts), declarationMarkup: segmentsMarkup(facts.declaration) } : null,
    /** The recipe's other labels (other variants), current ones first. */
    otherLabels: siblings
      .filter((h) => h.status !== "superseded")
      .map((h) => ({ id: h.id, variant: h.variant, versionNumber: h.versionNumber, status: h.status })),
    history: ownHistory.map((h) => ({
      id: h.id,
      versionNumber: h.versionNumber,
      status: h.status,
      recipeVersionNumber: ctx.versions.get(h.recipeVersionId)?.versionNumber ?? null,
      approvedAt: h.approvedAt,
      approvedByName: h.approvedBy ? (ctx.names.get(h.approvedBy) ?? null) : null,
      createdAt: h.createdAt,
      updatedAt: h.updatedAt,
    })),
  };
}

// ─── Product labels: writing ─────────────────────────────────────────────────

/** What shapes a label's computed parts; stored on the label and carried to its next draft. */
interface LabelOptions {
  compoundStyle: CompoundStyle;
  quidItemIds: string[];
  includeNutrition: boolean;
  volatileItemIds: string[];
  energyMethod: EnergyMethod;
  negligibleAsZero: boolean;
  portionSize: number | null;
  portionLabel: string | null;
}

/** The options of a label that is being drafted, edited or refreshed: the input, else `from`, else defaults. */
function optionsFor(
  input: Partial<{ [K in keyof LabelOptions]: LabelOptions[K] | undefined }>,
  from?: Partial<LabelOptions>,
): LabelOptions {
  return {
    compoundStyle: input.compoundStyle ?? from?.compoundStyle ?? "bracketed",
    quidItemIds: input.quidItemIds ?? from?.quidItemIds ?? [],
    includeNutrition: input.includeNutrition ?? from?.includeNutrition ?? true,
    volatileItemIds: input.volatileItemIds ?? from?.volatileItemIds ?? [],
    energyMethod: input.energyMethod ?? from?.energyMethod ?? "declared",
    negligibleAsZero: input.negligibleAsZero ?? from?.negligibleAsZero ?? false,
    portionSize: input.portionSize !== undefined ? input.portionSize : (from?.portionSize ?? null),
    portionLabel: input.portionLabel !== undefined ? input.portionLabel : (from?.portionLabel ?? null),
  };
}

/** The parts of a label drafted from computed data. */
function computedFields(facts: LabelFacts, options: LabelOptions) {
  return {
    recipeVersionId: facts.recipeVersionId,
    ingredients: facts.declaration,
    allergenStatement: facts.allergenStatement || null,
    allergens: { contains: facts.allergens.contains, mayContain: facts.mayContain },
    includeNutrition: options.includeNutrition,
    // Never a partial panel: an incomplete roll-up leaves it empty until the data is there.
    nutrition: options.includeNutrition ? facts.nutrition.panel : null,
    panelSource: options.includeNutrition && facts.nutrition.panel ? ("computed" as const) : null,
    compoundStyle: options.compoundStyle,
    quidItemIds: [...new Set(options.quidItemIds)],
    volatileItemIds: [...new Set(options.volatileItemIds)],
    energyMethod: options.energyMethod,
    negligibleAsZero: options.negligibleAsZero,
    portionSize: options.portionSize,
    portionLabel: options.portionLabel,
    sourceSnapshot: facts.snapshot,
    generatedAt: new Date(),
  };
}

/** The recipe (live, active) and its approved version, for drafting against. */
async function draftableRecipe(tx: Executor, workspaceId: string, recipeId: string) {
  const recipe = await findRecipe(tx, workspaceId, recipeId);
  if (recipe.status === "archived") {
    throw new ApiError(409, "recipe_archived", "This recipe is archived; make it active before labelling it");
  }
  const approved = (await approvedVersions(tx, [recipe.id])).get(recipe.id);
  if (!approved) {
    throw new ApiError(
      409,
      "no_approved_version",
      "This recipe has no approved version: a label is drafted from the approved recipe",
    );
  }
  return { recipe, approved };
}

async function factsFor(
  tx: Executor,
  workspaceId: string,
  recipe: RecipeRow,
  version: VersionRow,
  options: Pick<
    LabelOptions,
    | "compoundStyle"
    | "quidItemIds"
    | "volatileItemIds"
    | "energyMethod"
    | "negligibleAsZero"
    | "portionSize"
    | "portionLabel"
  >,
) {
  const [graph, lines] = await Promise.all([
    loadLabelGraph(tx, workspaceId),
    linesByVersion(tx, [version.id]),
  ]);
  const labelVersion = toLabelVersion(version, recipe, lines.get(version.id) ?? []);
  return { graph, labelVersion, facts: computeLabelFacts(labelVersion, graph, options) };
}

/**
 * Drafts a label for a recipe's approved version from the computed data. A recipe has at most one
 * draft label. Text the computation can't give (name, storage, date wording, net quantity) is
 * taken from the approved label when there is one, else from the product item.
 */
export async function createProductLabel(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: ProductLabelCreateInput,
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const { recipe, approved } = await draftableRecipe(tx, workspaceId, input.recipeId);
    const variant = input.variant ?? DEFAULT_LABEL_VARIANT;
    const existing = await tx
      .select()
      .from(productLabels)
      .where(
        and(
          eq(productLabels.recipeId, recipe.id),
          sql`lower(${productLabels.variant}) = lower(${variant})`,
          isNull(productLabels.deletedAt),
        ),
      )
      .orderBy(desc(productLabels.versionNumber));
    const draft = existing.find((l) => l.status === "draft");
    if (draft) {
      throw new ApiError(
        409,
        "label_draft_exists",
        `This recipe already has a draft of the "${draft.variant}" label: edit or refresh it`,
        {
          id: draft.id,
        },
      );
    }
    const previous = existing.find((l) => l.status === "approved");
    const options = optionsFor(input, previous);
    const { graph, facts } = await factsFor(tx, workspaceId, recipe, approved, options);
    const output = graph.items.get(recipe.outputItemId);
    const storage = output?.storage ?? "ambient";
    const [maxRow] = await tx
      .select({ n: sql<number>`coalesce(max(${productLabels.versionNumber}), 0)::int` })
      .from(productLabels)
      .where(
        and(eq(productLabels.recipeId, recipe.id), sql`lower(${productLabels.variant}) = lower(${variant})`),
      );
    const [row] = await tx
      .insert(productLabels)
      .values({
        workspaceId,
        recipeId: recipe.id,
        variant: previous?.variant ?? variant,
        versionNumber: (maxRow?.n ?? 0) + 1,
        status: "draft",
        productName: previous?.productName ?? output?.name ?? recipe.name,
        storageInstructions: previous ? previous.storageInstructions : storageGuidance[storage],
        dateGuidance: previous ? previous.dateGuidance : dateGuidance(storage, output?.shelfLifeDays),
        netQuantity: previous ? previous.netQuantity : output ? netQuantityFor(output) : null,
        gtin: previous?.gtin ?? null,
        notes: null,
        createdBy: actorId,
        lastEditedBy: actorId,
        ...computedFields(facts, options),
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [labelChange(row!)]);
    return row!.id;
  });
  return getProductLabel(db, workspaceId, id);
}

async function draftLabel(tx: Executor, workspaceId: string, id: string) {
  const row = await findLabel(tx, workspaceId, id);
  if (row.status !== "draft") {
    throw new ApiError(
      409,
      "label_not_draft",
      "An approved or superseded label never changes; draft a new version to correct it",
    );
  }
  return row;
}

/**
 * True when a typed-in panel is the partial values of an incomplete roll-up (each mandatory value
 * the same to the 3 decimal places nutrition is stored with): the missing ingredients counted as
 * zero, not an analysis.
 */
function isPartialRollup(input: NutritionInput, rollup: LabelFacts["nutrition"]) {
  const partial = rollup.per100;
  if (rollup.complete || !partial || input.basis !== rollup.basis) return false;
  return mandatoryNutrientKeys.every((key) => Math.abs(input[key] - partial[key]) <= 0.0005 + 1e-9);
}

/**
 * Edits a draft's text. Nutrition typed in here (from a laboratory analysis, say) is rounded for
 * the panel like computed values and recorded as `entered`. It is refused when it is just the
 * partial values of an incomplete roll-up, which would understate every nutrient.
 */
export async function updateProductLabel(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: ProductLabelUpdateInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const label = await draftLabel(tx, workspaceId, id);
    const { ingredients, nutrition, ...text } = patch;
    const set: Partial<typeof productLabels.$inferInsert> = { ...text, lastEditedBy: actorId };
    const style = {
      negligibleAsZero: patch.negligibleAsZero ?? label.negligibleAsZero,
      portionSize: patch.portionSize !== undefined ? patch.portionSize : label.portionSize,
      portionLabel: patch.portionLabel !== undefined ? patch.portionLabel : label.portionLabel,
    };
    if (ingredients !== undefined) set.ingredients = parseSegmentsMarkup(ingredients);
    if (nutrition !== undefined) {
      if (nutrition === null) {
        set.includeNutrition = false;
        set.nutrition = null;
        set.panelSource = null;
      } else {
        const [graph, versions] = await Promise.all([
          loadLabelGraph(tx, workspaceId),
          loadVersions(tx, workspaceId, [label.recipeVersionId]),
        ]);
        const version = versions.get(label.recipeVersionId);
        const rollup = version ? computeLabelFacts(version, graph).nutrition : null;
        if (rollup && isPartialRollup(nutrition, rollup)) {
          throw new ApiError(
            409,
            "nutrition_incomplete",
            `These are the computed values of an incomplete roll-up (nutrition is missing for ${[...new Set(rollup.missing.map((m) => m.code))].join(", ")}), which count the missing ingredients as zero: enter their nutrition and refresh, or type in a panel from an analysis`,
            { missing: rollup.missing },
          );
        }
        const { basis, ...values } = nutrition;
        set.includeNutrition = true;
        set.nutrition = nutritionPanel(basis, values, style);
        set.panelSource = "entered";
        set.energyMethod = "declared";
      }
    } else if (
      label.nutrition &&
      (patch.negligibleAsZero !== undefined ||
        patch.portionSize !== undefined ||
        patch.portionLabel !== undefined)
    ) {
      // Presentation only: the raw values stay, the rounding and the portion are redone.
      set.nutrition = restylePanel(label.nutrition, style);
    }
    const [row] = await tx.update(productLabels).set(set).where(eq(productLabels.id, id)).returning();
    await recordChanges(tx, workspaceId, actorId, [labelChange(row!)]);
  });
  return getProductLabel(db, workspaceId, id);
}

/**
 * Redrafts a draft's computed parts (ingredients, allergens, allergen statement, nutrition) from
 * current data and the recipe's approved version now. The name, storage, date wording, net
 * quantity and notes are kept.
 */
export async function refreshProductLabel(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: ProductLabelRefreshInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const label = await draftLabel(tx, workspaceId, id);
    const { recipe, approved } = await draftableRecipe(tx, workspaceId, label.recipeId);
    const options = optionsFor(input, label);
    const { facts } = await factsFor(tx, workspaceId, recipe, approved, options);
    const [row] = await tx
      .update(productLabels)
      .set({ ...computedFields(facts, options), lastEditedBy: actorId })
      .where(eq(productLabels.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [labelChange(row!)]);
  });
  return getProductLabel(db, workspaceId, id);
}

/**
 * Approves a draft label (a sign-off: the route needs `manage` and refuses API tokens). It must be
 * drafted from the recipe's approved version and up to date with the data, with a product name,
 * an ingredients list and, unless the product is exempt, a complete nutrition panel. The previous
 * approved label is superseded.
 */
export async function approveProductLabel(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  id: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const label = await draftLabel(tx, workspaceId, id);
    // Four-eyes: not whoever last edited the draft, unless they are the only manager.
    const managers = audience(await memberAccess(tx, workspaceId, active), "labels", "manage");
    if (
      !canApproveProductLabel({ lastEditedBy: label.lastEditedBy, deciderId: actorId, managerIds: managers })
    ) {
      throw new ApiError(
        403,
        "four_eyes",
        "You made the last edit to this label, so someone else with manage access must approve it",
      );
    }
    const { recipe, approved } = await draftableRecipe(tx, workspaceId, label.recipeId);
    if (approved.id !== label.recipeVersionId) {
      throw new ApiError(
        409,
        "version_superseded",
        `This draft was made from an older version of the recipe; refresh it onto v${approved.versionNumber} first`,
      );
    }
    const { graph, labelVersion, facts } = await factsFor(tx, workspaceId, recipe, approved, label);
    const reasons = compareLabelSources(
      label.sourceSnapshot,
      labelSourceSnapshot(labelVersion, graph),
      label.includeNutrition,
    );
    if (reasons.length) {
      throw new ApiError(
        409,
        "label_out_of_date",
        "The recipe's ingredients have changed since this draft was made; refresh it and check it again",
        { reasons },
      );
    }
    if (!label.productName.trim()) throw badRequest("Give the label a product name");
    if (label.ingredients.length === 0 || !segmentsText(label.ingredients).trim()) {
      throw badRequest("The label has no ingredients list");
    }
    // A computed panel is only stored from a complete roll-up, and the staleness check above
    // catches data changed since; this holds even for a label stored before that was so.
    const computedButIncomplete = label.panelSource !== "entered" && !facts.nutrition.complete;
    if (label.includeNutrition && (!label.nutrition || computedButIncomplete)) {
      throw new ApiError(
        409,
        "nutrition_incomplete",
        facts.nutrition.missing.length
          ? `Nutrition is missing for ${[...new Set(facts.nutrition.missing.map((m) => m.code))].join(", ")}: enter it and refresh, type the panel in, or declare no nutrition`
          : "The label has no nutrition panel: refresh it, type the panel in, or declare no nutrition",
        { missing: facts.nutrition.missing },
      );
    }
    const changes: ChangeInput[] = [];
    const [previous] = await tx
      .update(productLabels)
      .set({ status: "superseded" })
      .where(
        and(
          eq(productLabels.recipeId, label.recipeId),
          sql`lower(${productLabels.variant}) = lower(${label.variant})`,
          eq(productLabels.status, "approved"),
          isNull(productLabels.deletedAt),
        ),
      )
      .returning();
    if (previous) changes.push(labelChange(previous));
    const [row] = await tx
      .update(productLabels)
      .set({ status: "approved", approvedAt: new Date(), approvedBy: actorId })
      .where(eq(productLabels.id, id))
      .returning();
    changes.push(labelChange(row!));
    await recordChanges(tx, workspaceId, actorId, changes);
  });
  return getProductLabel(db, workspaceId, id);
}

/** Deletes a draft label. Approved and superseded labels are kept. */
export async function deleteProductLabel(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx: Transaction) => {
    await lockWorkspaceLog(tx, workspaceId);
    await draftLabel(tx, workspaceId, id);
    await tx.delete(productLabels).where(eq(productLabels.id, id));
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "product_label", entityId: id, action: "delete" },
    ]);
  });
}
