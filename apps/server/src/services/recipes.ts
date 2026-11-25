import {
  allergenDrift,
  convertQuantity,
  isProducibleItem,
  rollUpAllergens,
  rollUpRecipe,
  scaleRecipe,
  unitDimension,
  type RecipeCreateInput,
  type RecipeDraftInput,
  type RecipeItemFacts,
  type RecipeListQuery,
  type RecipeScale,
  type RecipeScaleQuery,
  type RecipeUpdateInput,
} from "@knotworking/core";
import {
  items,
  lockWorkspaceLog,
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
import { and, asc, count, desc, eq, inArray, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { foodFieldsByItem, type FoodItem } from "./food-items";

/**
 * Recipes module: versioned bills of materials.
 *
 * A recipe has at most one draft (the only editable version) and at most one approved version;
 * approving supersedes the previous approved version, which is kept. Roll-ups (allergens, cost,
 * scaling) are computed on read from the lines and the items' current data. Recipes are read
 * through endpoints, not the bootstrap; every write appends to the sync log in one transaction.
 */

type RecipeRow = typeof recipes.$inferSelect;
type VersionRow = typeof recipeVersions.$inferSelect;
type LineRow = typeof recipeLines.$inferSelect;
type ItemRow = typeof items.$inferSelect & { food?: FoodItem | undefined };

const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;

const factsOf = (item: ItemRow): RecipeItemFacts => ({
  code: item.code,
  unit: item.unit,
  allergens: item.food?.allergens ?? [],
  mayContain: item.food?.mayContain ?? [],
  standardCost: item.standardCost,
  densityGPerMl: item.densityGPerMl,
  unitWeightG: item.unitWeightG,
});

const itemSummary = (item: ItemRow) => ({
  id: item.id,
  code: item.code,
  name: item.name,
  type: item.type,
  status: item.status,
  unit: item.unit,
  allergens: item.food?.allergens ?? [],
  mayContain: item.food?.mayContain ?? [],
  standardCost: item.standardCost,
  densityGPerMl: item.densityGPerMl,
  unitWeightG: item.unitWeightG,
});

// ─── Serialising ─────────────────────────────────────────────────────────────

function serializeRecipe(row: RecipeRow, output: ItemRow | undefined) {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return { ...rest, outputItem: output ? itemSummary(output) : null };
}

const versionChange = (row: VersionRow): ChangeInput => {
  const { workspaceId: _ws, deletedAt: _deleted, ...data } = row;
  return { entity: "recipe_version", entityId: row.id, action: "upsert", data };
};
const lineChange = (row: LineRow): ChangeInput => {
  const { workspaceId: _ws, deletedAt: _deleted, ...data } = row;
  return { entity: "recipe_line", entityId: row.id, action: "upsert", data };
};
const recipeChange = (row: RecipeRow): ChangeInput => {
  const { workspaceId: _ws, deletedAt: _deleted, ...data } = row;
  return { entity: "recipe", entityId: row.id, action: "upsert", data };
};

async function userNames(db: Executor, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map<string, { id: string; name: string }>();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((u) => [u.id, u]));
}

/** Items by id, including archived and deleted ones: existing versions keep showing them. */
async function itemsById(db: Executor, workspaceId: string, ids: string[], withFood: boolean) {
  if (ids.length === 0) return new Map<string, ItemRow>();
  const rows = await db
    .select()
    .from(items)
    .where(and(eq(items.workspaceId, workspaceId), inArray(items.id, [...new Set(ids)])));
  if (!withFood) return new Map(rows.map((row) => [row.id, row]));
  const food = await foodFieldsByItem(db, workspaceId, ids);
  return new Map(rows.map((row) => [row.id, { ...row, food: food.get(row.id) }]));
}

async function linesOf(db: Executor, versionIds: string[]) {
  if (versionIds.length === 0) return [];
  return db
    .select()
    .from(recipeLines)
    .where(inArray(recipeLines.versionId, versionIds))
    .orderBy(asc(recipeLines.sortOrder), asc(recipeLines.id));
}

const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10_000) / 10_000;

/** A version in full: lines with their items, and the roll-ups (optionally scaled). */
async function fullVersion(
  db: Executor,
  workspaceId: string,
  recipe: RecipeRow,
  version: VersionRow,
  withFood: boolean,
  scaleQuery?: RecipeScaleQuery,
) {
  const lines = await linesOf(db, [version.id]);
  const itemMap = await itemsById(
    db,
    workspaceId,
    [recipe.outputItemId, ...lines.map((l) => l.itemId)],
    withFood,
  );
  const output = itemMap.get(recipe.outputItemId);
  if (!output) throw notFound("Output item");
  const rollLines = lines.map((l) => ({
    quantity: l.quantity,
    unit: l.unit,
    item: factsOf(itemMap.get(l.itemId)!),
  }));
  const yieldInfo = { yieldQuantity: version.yieldQuantity, yieldUnit: version.yieldUnit };
  const rollup = rollUpRecipe(rollLines, yieldInfo, factsOf(output));

  let scale: (RecipeScale & { quantities: number[] }) | null = null;
  if (scaleQuery && (scaleQuery.batches !== undefined || scaleQuery.outputQuantity !== undefined)) {
    const target =
      scaleQuery.batches !== undefined
        ? { batches: scaleQuery.batches }
        : { outputQuantity: scaleQuery.outputQuantity!, outputUnit: scaleQuery.outputUnit! };
    scale = scaleRecipe(rollLines, yieldInfo, target, factsOf(output));
    if (!scale) {
      throw badRequest(
        "Can't scale to that target: the recipe has no yield, or the unit can't be converted to the yield's unit",
      );
    }
  }

  const people = await userNames(db, [version.approvedBy, version.createdBy]);
  const { workspaceId: _ws, deletedAt: _deleted, ...fields } = version;
  return {
    ...fields,
    approvedAllergens: withFood ? fields.approvedAllergens : null,
    foodItemsIncluded: withFood,
    approvedByName: version.approvedBy ? (people.get(version.approvedBy)?.name ?? null) : null,
    outputItem: itemSummary(output),
    lines: lines.map((l, i) => {
      const item = itemMap.get(l.itemId)!;
      const inItemUnit = convertQuantity(l.quantity, l.unit, item.unit, item);
      return {
        id: l.id,
        itemId: l.itemId,
        item: itemSummary(item),
        quantity: l.quantity,
        unit: l.unit,
        sortOrder: l.sortOrder,
        note: l.note,
        cost: inItemUnit !== null && item.standardCost !== null ? inItemUnit * item.standardCost : null,
        ...(scale
          ? { scaledQuantity: scale.quantities[i]!, scaledQuantityRounded: round4(scale.quantities[i]!) }
          : {}),
      };
    }),
    rollup,
    /** Approved versions only: how today's ingredient declarations differ from the roll-up recorded at approval. */
    allergenDrift:
      withFood && version.status === "approved"
        ? allergenDrift(version.approvedAllergens, rollup.allergens)
        : null,
    ...(scale
      ? {
          scale: {
            factor: scale.factor,
            outputQuantity: scale.outputQuantity,
            outputUnit: scale.outputUnit,
          },
        }
      : {}),
  };
}

// ─── Reading ─────────────────────────────────────────────────────────────────

async function findRecipe(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(recipes)
    .where(and(eq(recipes.id, id), eq(recipes.workspaceId, workspaceId), isNull(recipes.deletedAt)));
  if (!row) throw notFound("Recipe");
  return row;
}

async function versionsOf(db: Executor, recipeId: string) {
  return db
    .select()
    .from(recipeVersions)
    .where(and(eq(recipeVersions.recipeId, recipeId), isNull(recipeVersions.deletedAt)))
    .orderBy(desc(recipeVersions.versionNumber));
}

/**
 * Recipes whose approved version declares different allergens now than when it was approved (an
 * ingredient's declaration changed), with the drift. Versions approved before the roll-up was
 * kept are never flagged. Used by the list filter and the notification sweep.
 */
export async function recipesWithAllergenDrift(db: Executor, workspaceId: string) {
  const approved = await db
    .select({ version: recipeVersions, recipe: recipes })
    .from(recipeVersions)
    .innerJoin(recipes, eq(recipes.id, recipeVersions.recipeId))
    .where(
      and(
        eq(recipeVersions.workspaceId, workspaceId),
        eq(recipeVersions.status, "approved"),
        isNull(recipeVersions.deletedAt),
        isNull(recipes.deletedAt),
        sql`${recipeVersions.approvedAllergens} is not null`,
      ),
    );
  if (approved.length === 0) return [];
  const lines = await linesOf(
    db,
    approved.map((a) => a.version.id),
  );
  const itemMap = await itemsById(
    db,
    workspaceId,
    lines.map((l) => l.itemId),
    true,
  );
  const flagged = [];
  for (const { version, recipe } of approved) {
    const allergens = rollUpAllergens(
      lines
        .filter((l) => l.versionId === version.id)
        .flatMap((l) => (itemMap.has(l.itemId) ? [{ item: factsOf(itemMap.get(l.itemId)!) }] : [])),
    );
    const drift = allergenDrift(version.approvedAllergens, allergens);
    if (drift) {
      flagged.push({
        recipeId: recipe.id,
        code: recipe.code,
        name: recipe.name,
        status: recipe.status,
        versionId: version.id,
        versionNumber: version.versionNumber,
        drift,
        allergens,
      });
    }
  }
  return flagged;
}

export async function listRecipes(
  db: Database,
  workspaceId: string,
  query: RecipeListQuery,
  withFood: boolean,
) {
  const where: (SQL | undefined)[] = [eq(recipes.workspaceId, workspaceId), isNull(recipes.deletedAt)];
  if (query.allergenDrift !== undefined) {
    // Decided before paging, in the query: `total` and the pages count only the matching recipes.
    const flagged = (await recipesWithAllergenDrift(db, workspaceId)).map((f) => f.recipeId);
    if (query.allergenDrift) where.push(flagged.length ? inArray(recipes.id, flagged) : sql`false`);
    else if (flagged.length) where.push(notInArray(recipes.id, flagged));
  }
  if (query.status !== "all") where.push(eq(recipes.status, query.status));
  if (query.outputItemId) where.push(eq(recipes.outputItemId, query.outputItemId));
  if (query.q) {
    where.push(
      or(
        sql`${recipes.name} ilike ${like(query.q)} escape '!'`,
        sql`${recipes.code} ilike ${like(query.q)} escape '!'`,
      ),
    );
  }
  if (query.itemId) {
    where.push(
      sql`exists (select 1 from ${recipeVersions} rv join ${recipeLines} rl on rl.version_id = rv.id
        where rv.recipe_id = ${recipes.id} and rv.deleted_at is null
        and rv.status in ('approved', 'draft') and rl.item_id = ${query.itemId})`,
    );
  }
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(recipes)
      .where(and(...where))
      .orderBy(asc(recipes.name), asc(recipes.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(recipes)
      .where(and(...where)),
  ]);

  const ids = rows.map((r) => r.id);
  const versions = ids.length
    ? await db
        .select()
        .from(recipeVersions)
        .where(
          and(
            inArray(recipeVersions.recipeId, ids),
            isNull(recipeVersions.deletedAt),
            inArray(recipeVersions.status, ["approved", "draft"]),
          ),
        )
    : [];
  const lines = await linesOf(
    db,
    versions.map((v) => v.id),
  );
  const itemMap = await itemsById(
    db,
    workspaceId,
    [...rows.map((r) => r.outputItemId), ...lines.map((l) => l.itemId)],
    withFood,
  );

  const data = rows.map((row) => {
    const mine = versions.filter((v) => v.recipeId === row.id);
    const approved = mine.find((v) => v.status === "approved");
    const draft = mine.find((v) => v.status === "draft");
    const current = approved ?? draft;
    const allergens = rollUpAllergens(
      lines
        .filter((l) => l.versionId === current?.id)
        .map((l) => ({ item: factsOf(itemMap.get(l.itemId)!) })),
    );
    const hasAllergenDrift = withFood && !!approved && !!allergenDrift(approved.approvedAllergens, allergens);
    return {
      ...serializeRecipe(row, itemMap.get(row.outputItemId)),
      approvedVersionNumber: approved?.versionNumber ?? null,
      hasDraft: !!draft,
      draftVersionNumber: draft?.versionNumber ?? null,
      allergens,
      foodItemsIncluded: withFood,
      /** The approved version's ingredients now declare different allergens than when it was approved. */
      allergenDrift: hasAllergenDrift,
    };
  });
  return { recipes: data, total: total?.n ?? 0, limit: query.limit, offset: query.offset };
}

export async function getRecipe(db: Database, workspaceId: string, id: string, withFood: boolean) {
  const recipe = await findRecipe(db, workspaceId, id);
  const versions = await versionsOf(db, id);
  const people = await userNames(
    db,
    versions.map((v) => v.approvedBy),
  );
  const current = versions.find((v) => v.status === "approved") ?? versions.find((v) => v.status === "draft");
  const draft = versions.find((v) => v.status === "draft");
  const output = (await itemsById(db, workspaceId, [recipe.outputItemId], withFood)).get(recipe.outputItemId);
  return {
    ...serializeRecipe(recipe, output),
    versions: versions.map((v) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      status: v.status,
      changeNote: v.changeNote,
      approvedAt: v.approvedAt,
      approvedBy: v.approvedBy,
      approvedByName: v.approvedBy ? (people.get(v.approvedBy)?.name ?? null) : null,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    })),
    currentVersion: current ? await fullVersion(db, workspaceId, recipe, current, withFood) : null,
    /** The draft in full, when the current version is an approved one and a draft exists beside it. */
    draftVersion:
      draft && current && draft.id !== current.id
        ? await fullVersion(db, workspaceId, recipe, draft, withFood)
        : null,
  };
}

export async function getRecipeVersion(
  db: Database,
  workspaceId: string,
  id: string,
  versionId: string,
  withFood: boolean,
  scale?: RecipeScaleQuery,
) {
  const recipe = await findRecipe(db, workspaceId, id);
  const [version] = await db
    .select()
    .from(recipeVersions)
    .where(
      and(
        eq(recipeVersions.id, versionId),
        eq(recipeVersions.recipeId, id),
        isNull(recipeVersions.deletedAt),
      ),
    );
  if (!version) throw notFound("Recipe version");
  return fullVersion(db, workspaceId, recipe, version, withFood, scale);
}

// ─── Writing ─────────────────────────────────────────────────────────────────

async function assertCodeFree(tx: Transaction, workspaceId: string, code: string, exceptId?: string) {
  const [taken] = await tx
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        eq(recipes.workspaceId, workspaceId),
        isNull(recipes.deletedAt),
        sql`lower(${recipes.code}) = lower(${code})`,
        exceptId ? ne(recipes.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `Another recipe already uses the code "${code}"`);
}

async function liveItem(tx: Executor, workspaceId: string, id: string) {
  const [row] = await tx
    .select()
    .from(items)
    .where(and(eq(items.id, id), eq(items.workspaceId, workspaceId), isNull(items.deletedAt)));
  return row;
}

/**
 * Checks draft content against the recipe's output item: the yield is the same dimension as the
 * output's unit, and every line is a live, active item other than the output, in a unit that
 * converts to the item's own.
 */
async function validateDraftContent(
  tx: Executor,
  workspaceId: string,
  output: ItemRow,
  draft: RecipeDraftInput,
) {
  if (unitDimension(draft.yieldUnit) !== unitDimension(output.unit)) {
    throw badRequest(
      `The yield must be in ${unitDimension(output.unit)} units like the output item (${output.code} is in ${output.unit}), not ${draft.yieldUnit}`,
    );
  }
  const ids = [...new Set(draft.lines.map((l) => l.itemId))];
  const found = new Map<string, ItemRow>();
  if (ids.length) {
    const rows = await tx
      .select()
      .from(items)
      .where(and(eq(items.workspaceId, workspaceId), isNull(items.deletedAt), inArray(items.id, ids)));
    for (const row of rows) found.set(row.id, row);
  }
  for (const line of draft.lines) {
    const item = found.get(line.itemId);
    if (!item) throw badRequest(`Unknown item ${line.itemId}`);
    if (item.type === "service")
      throw badRequest(`${item.code} is a service and cannot be consumed in production`);
    if (item.id === output.id) {
      throw badRequest(`${item.code} is what this recipe makes; it can't be an input of itself`);
    }
    if (item.status === "archived") {
      throw badRequest(`${item.code} is archived; replace it or restore the item before saving`);
    }
    if (convertQuantity(line.quantity, line.unit, item.unit, item) === null) {
      throw badRequest(
        `${item.code} is held in ${item.unit}; ${line.unit} can't be converted to that unit with the item's conversion factors`,
      );
    }
  }
}

/** Replaces the lines of a draft version: returns the sync changes. */
async function replaceLines(
  tx: Transaction,
  workspaceId: string,
  versionId: string,
  lines: RecipeDraftInput["lines"],
): Promise<ChangeInput[]> {
  const old = await tx
    .delete(recipeLines)
    .where(eq(recipeLines.versionId, versionId))
    .returning({ id: recipeLines.id });
  const changes: ChangeInput[] = old.map((l) => ({
    entity: "recipe_line",
    entityId: l.id,
    action: "delete",
  }));
  if (lines.length) {
    const inserted = await tx
      .insert(recipeLines)
      .values(
        lines.map((l, i) => ({
          workspaceId,
          versionId,
          itemId: l.itemId,
          quantity: l.quantity,
          unit: l.unit,
          sortOrder: i,
          note: l.note ?? null,
        })),
      )
      .returning();
    changes.push(...inserted.map(lineChange));
  }
  return changes;
}

/** Saves a draft inside a transaction: edits the existing draft or starts the next version. */
async function saveDraftIn(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  recipe: RecipeRow,
  input: RecipeDraftInput,
): Promise<{ version: VersionRow; changes: ChangeInput[] }> {
  if (recipe.status === "archived") {
    throw new ApiError(409, "recipe_archived", "This recipe is archived; make it active before editing it");
  }
  const output = await liveItem(tx, workspaceId, recipe.outputItemId);
  if (!output) throw badRequest("The recipe's output item no longer exists");
  await validateDraftContent(tx, workspaceId, output, input);

  const fields = {
    yieldQuantity: input.yieldQuantity,
    yieldUnit: input.yieldUnit,
    method: input.method ?? null,
    changeNote: input.changeNote ?? null,
  };
  const [draft] = await tx
    .select()
    .from(recipeVersions)
    .where(
      and(
        eq(recipeVersions.recipeId, recipe.id),
        eq(recipeVersions.status, "draft"),
        isNull(recipeVersions.deletedAt),
      ),
    );
  let version: VersionRow;
  if (draft) {
    const [updated] = await tx
      .update(recipeVersions)
      .set(fields)
      .where(eq(recipeVersions.id, draft.id))
      .returning();
    version = updated!;
  } else {
    const [latest] = await tx
      .select({ n: sql<number>`coalesce(max(${recipeVersions.versionNumber}), 0)::int` })
      .from(recipeVersions)
      .where(eq(recipeVersions.recipeId, recipe.id));
    const [inserted] = await tx
      .insert(recipeVersions)
      .values({
        ...fields,
        workspaceId,
        recipeId: recipe.id,
        versionNumber: (latest?.n ?? 0) + 1,
        status: "draft",
        createdBy: actorId,
      })
      .returning();
    version = inserted!;
  }
  const lineChanges = await replaceLines(tx, workspaceId, version!.id, input.lines);
  return { version: version!, changes: [versionChange(version!), ...lineChanges] };
}

export async function createRecipe(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: RecipeCreateInput,
  withFood: boolean,
) {
  const { draft, id, ...fields } = input;
  const recipeId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertCodeFree(tx, workspaceId, fields.code);
    const output = await liveItem(tx, workspaceId, fields.outputItemId);
    if (!output) throw badRequest("Unknown outputItemId");
    if (!isProducibleItem(output.type)) {
      throw badRequest(
        `${output.code} is ${output.type}; choose a component, work-in-progress item or finished good as the output`,
      );
    }
    if (output.status === "archived") throw badRequest(`${output.code} is archived`);
    const [row] = await tx
      .insert(recipes)
      .values({ ...fields, ...(id ? { id } : {}), workspaceId })
      .returning();
    const changes: ChangeInput[] = [recipeChange(row!)];
    if (draft) changes.push(...(await saveDraftIn(tx, workspaceId, actorId, row!, draft)).changes);
    await recordChanges(tx, workspaceId, actorId, changes);
    return row!.id;
  });
  return getRecipe(db, workspaceId, recipeId, withFood);
}

export async function updateRecipe(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: RecipeUpdateInput,
  withFood: boolean,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findRecipe(tx, workspaceId, id);
    if (patch.code !== undefined) await assertCodeFree(tx, workspaceId, patch.code, id);
    const [row] = await tx.update(recipes).set(patch).where(eq(recipes.id, id)).returning();
    await recordChanges(tx, workspaceId, actorId, [recipeChange(row!)]);
  });
  return getRecipe(db, workspaceId, id, withFood);
}

export async function saveRecipeDraft(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: RecipeDraftInput,
  withFood: boolean,
) {
  const versionId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const recipe = await findRecipe(tx, workspaceId, id);
    const { version, changes } = await saveDraftIn(tx, workspaceId, actorId, recipe, input);
    await recordChanges(tx, workspaceId, actorId, changes);
    return version.id;
  });
  return getRecipeVersion(db, workspaceId, id, versionId, withFood);
}

/** Deletes the draft and its lines. The version number is free for the next draft. */
async function removeDraft(tx: Transaction, recipeId: string): Promise<ChangeInput[]> {
  const [draft] = await tx
    .select()
    .from(recipeVersions)
    .where(
      and(
        eq(recipeVersions.recipeId, recipeId),
        eq(recipeVersions.status, "draft"),
        isNull(recipeVersions.deletedAt),
      ),
    );
  if (!draft) return [];
  const lines = await tx
    .delete(recipeLines)
    .where(eq(recipeLines.versionId, draft.id))
    .returning({ id: recipeLines.id });
  await tx.delete(recipeVersions).where(eq(recipeVersions.id, draft.id));
  return [
    ...lines.map((l): ChangeInput => ({ entity: "recipe_line", entityId: l.id, action: "delete" })),
    { entity: "recipe_version", entityId: draft.id, action: "delete" },
  ];
}

export async function discardRecipeDraft(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findRecipe(tx, workspaceId, id);
    const changes = await removeDraft(tx, id);
    if (changes.length === 0) throw new ApiError(409, "no_draft", "This recipe has no draft to discard");
    await recordChanges(tx, workspaceId, actorId, changes);
  });
}

/**
 * Approves the draft (BRCGS document control): it becomes the approved version, the previous one
 * is superseded, and who and when are recorded. The route needs `manage` and refuses API tokens.
 */
export async function approveRecipeDraft(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  food: { active: boolean; readable: boolean },
) {
  const versionId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const recipe = await findRecipe(tx, workspaceId, id);
    if (recipe.status === "archived") {
      throw new ApiError(409, "recipe_archived", "This recipe is archived; make it active before approving");
    }
    const [draft] = await tx
      .select()
      .from(recipeVersions)
      .where(
        and(
          eq(recipeVersions.recipeId, id),
          eq(recipeVersions.status, "draft"),
          isNull(recipeVersions.deletedAt),
        ),
      );
    if (!draft) throw new ApiError(409, "no_draft", "This recipe has no draft to approve");
    const lines = await linesOf(tx, [draft.id]);
    if (lines.length === 0) throw badRequest("A recipe with no ingredients can't be approved");
    if (!(draft.yieldQuantity > 0)) throw badRequest("Set a yield above zero before approving");
    const output = await liveItem(tx, workspaceId, recipe.outputItemId);
    if (!output) throw badRequest("The recipe's output item no longer exists");
    if (output.status !== "active" || !isProducibleItem(output.type)) {
      throw badRequest(
        `${output.code} must be an active component, work-in-progress item or finished good to approve this version`,
      );
    }
    await validateDraftContent(tx, workspaceId, output, {
      yieldQuantity: draft.yieldQuantity,
      yieldUnit: draft.yieldUnit,
      lines,
    });
    const itemMap = food.active
      ? await itemsById(
          tx,
          workspaceId,
          lines.map((line) => line.itemId),
          true,
        )
      : null;

    const changes: ChangeInput[] = [];
    const [previous] = await tx
      .update(recipeVersions)
      .set({ status: "superseded" })
      .where(
        and(
          eq(recipeVersions.recipeId, id),
          eq(recipeVersions.status, "approved"),
          isNull(recipeVersions.deletedAt),
        ),
      )
      .returning();
    if (previous) changes.push(versionChange(previous));
    const [approved] = await tx
      .update(recipeVersions)
      .set({
        status: "approved",
        approvedAt: new Date(),
        approvedBy: actorId,
        approvedAllergens: itemMap
          ? rollUpAllergens(lines.map((l) => ({ item: factsOf(itemMap.get(l.itemId)!) })))
          : null,
      })
      .where(eq(recipeVersions.id, draft.id))
      .returning();
    changes.push(versionChange(approved!));
    await recordChanges(tx, workspaceId, actorId, changes);
    return approved!.id;
  });
  return getRecipeVersion(db, workspaceId, id, versionId, food.readable);
}

/** Soft delete; a recipe that has ever been approved can only be archived (document control). */
export async function deleteRecipe(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findRecipe(tx, workspaceId, id);
    const [released] = await tx
      .select({ id: recipeVersions.id })
      .from(recipeVersions)
      .where(
        and(
          eq(recipeVersions.recipeId, id),
          inArray(recipeVersions.status, ["approved", "superseded"]),
          isNull(recipeVersions.deletedAt),
        ),
      );
    if (released) {
      throw new ApiError(
        409,
        "recipe_approved",
        "This recipe has an approved version and can't be deleted; archive it instead",
      );
    }
    const changes = await removeDraft(tx, id);
    await tx.update(recipes).set({ deletedAt: new Date() }).where(eq(recipes.id, id));
    await recordChanges(tx, workspaceId, actorId, [
      ...changes,
      { entity: "recipe", entityId: id, action: "delete" },
    ]);
  });
}
