import {
  compareLabelSources,
  computeLabelFacts,
  csvImportSchema,
  parseNutritionCsv,
  dateGuidance,
  itemLabelDataSchema,
  itemNutrition,
  labelSourceSnapshot,
  netQuantityFor,
  newId,
  nutritionPanel,
  parseSegmentsMarkup,
  productLabelCreateSchema,
  productLabelRefreshSchema,
  productLabelUpdateSchema,
  segmentsMarkup,
  segmentsText,
  storageGuidance,
  type LabelFacts,
  type LabelGraph,
  type LabelItemFacts,
  type LabelRecipeVersion,
  type NutritionEntry,
} from "@knotworking/core";
import type { Hono } from "hono";
import type { mountFakeRecipes } from "./fake-recipes";

/**
 * In-memory stand-in for the Labels and nutrition module's routes (apps/server/src/routes/labels.ts),
 * computing with the same core functions the server uses. Approval is a person's: the fake refuses
 * it to tokens, as the API does.
 */
export function mountFakeLabels(
  app: Hono,
  ws: string,
  deps: { items: Record<string, any>[]; recipes: ReturnType<typeof mountFakeRecipes>["recipes"] },
) {
  const err = (code: string, message: string, details?: unknown) => ({ error: { code, message, details } });
  const now = "2026-11-12T09:00:00.000Z";
  const data = new Map<string, Record<string, any>>();
  const labels: Record<string, any>[] = [];

  const nutritionOf = (d: Record<string, any> | undefined): NutritionEntry | null => {
    if (!d?.nutrition) return null;
    const { basis, ...values } = d.nutrition;
    return { basis, values };
  };

  const graph = (): LabelGraph => ({
    items: new Map(
      deps.items.map((i): [string, LabelItemFacts] => [
        i.id,
        {
          id: i.id,
          code: i.code,
          name: i.name,
          type: i.type,
          unit: i.unit,
          densityGPerMl: i.densityGPerMl,
          unitWeightG: i.unitWeightG,
          allergens: i.allergens ?? [],
          mayContain: i.mayContain ?? [],
          storage: i.storage,
          shelfLifeDays: i.shelfLifeDays,
          declarationName: data.get(i.id)?.declarationName ?? null,
          components: data.get(i.id)?.components ?? null,
          nutrition: nutritionOf(data.get(i.id)),
          micronutrients: data.get(i.id)?.micronutrients ?? null,
          retention: data.get(i.id)?.retention ?? null,
        },
      ]),
    ),
    subRecipes: new Map(
      deps.recipes
        .filter((r) => r.status === "active" && r.versions.some((v) => v.status === "approved"))
        .map((r) => [
          r.outputItemId,
          labelVersion(
            r,
            r.versions.find((v) => v.status === "approved")!,
          ),
        ]),
    ),
  });
  const labelVersion = (
    r: (typeof deps.recipes)[number],
    v: (typeof deps.recipes)[number]["versions"][number],
  ): LabelRecipeVersion => ({
    recipeId: r.id,
    recipeCode: r.code,
    versionId: v.id,
    versionNumber: v.versionNumber,
    outputItemId: r.outputItemId,
    yieldQuantity: v.yieldQuantity,
    yieldUnit: v.yieldUnit as never,
    lines: v.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, unit: l.unit as never })),
  });
  const findVersion = (versionId: string) => {
    for (const r of deps.recipes) {
      const v = r.versions.find((x) => x.id === versionId);
      if (v) return { recipe: r, version: v };
    }
    return null;
  };
  const factsView = ({ snapshot: _s, ...facts }: LabelFacts) => ({
    ...facts,
    declarationMarkup: segmentsMarkup(facts.declaration),
    declarationText: segmentsText(facts.declaration),
  });

  const itemView = (item: Record<string, any>, g: LabelGraph) => {
    const d = data.get(item.id);
    const effective = itemNutrition(item.id, g);
    const sub = g.subRecipes.get(item.id);
    const entered = nutritionOf(d);
    return {
      itemId: item.id,
      code: item.code,
      name: item.name,
      type: item.type,
      status: item.status,
      unit: item.unit,
      allergens: item.allergens,
      mayContain: item.mayContain,
      declarationName: d?.declarationName ?? null,
      components: d?.components ?? null,
      nutrition: entered ? { basis: entered.basis, ...entered.values } : null,
      micronutrients: d?.micronutrients ?? null,
      retention: d?.retention ?? null,
      nutritionSource: d?.nutritionSource ?? null,
      updatedAt: d ? now : null,
      updatedByName: d ? "Ada Lovelace" : null,
      madeBy: sub
        ? {
            recipeId: sub.recipeId,
            recipeCode: sub.recipeCode,
            versionId: sub.versionId,
            versionNumber: sub.versionNumber,
          }
        : null,
      effective: {
        source: effective.source,
        basis: effective.entry?.basis ?? effective.rollup?.basis ?? "100g",
        values: effective.entry?.values ?? null,
        missing: effective.rollup?.missing ?? [],
      },
    };
  };

  const labelView = (l: Record<string, any>) => {
    const g = graph();
    const found = findVersion(l.recipeVersionId)!;
    const current = found.recipe.versions.find((v) => v.status === "approved");
    const lv = labelVersion(found.recipe, found.version);
    const reasons =
      l.status === "superseded"
        ? []
        : [
            ...(current?.id !== l.recipeVersionId
              ? [{ kind: "recipe_version_superseded", itemCodes: [] }]
              : []),
            ...compareLabelSources(l.sourceSnapshot, labelSourceSnapshot(lv, g), l.includeNutrition),
          ];
    const facts = computeLabelFacts(lv, g, { compoundStyle: l.compoundStyle, quidItemIds: l.quidItemIds });
    const { sourceSnapshot: _s, ...fields } = l;
    return {
      ...fields,
      ingredientsMarkup: segmentsMarkup(l.ingredients),
      ingredientsText: segmentsText(l.ingredients),
      recipe: {
        id: found.recipe.id,
        code: found.recipe.code,
        name: found.recipe.name,
        status: found.recipe.status,
      },
      recipeVersion: {
        id: found.version.id,
        versionNumber: found.version.versionNumber,
        status: found.version.status,
      },
      currentRecipeVersion: current ? { id: current.id, versionNumber: current.versionNumber } : null,
      approvedByName: null,
      createdByName: "Ada Lovelace",
      stale: reasons.length > 0,
      staleReasons: reasons,
      facts: factsView(facts),
      history: labels
        .filter((h) => h.recipeId === l.recipeId)
        .sort((a, b) => b.versionNumber - a.versionNumber)
        .map((h) => ({
          id: h.id,
          versionNumber: h.versionNumber,
          status: h.status,
          recipeVersionNumber: findVersion(h.recipeVersionId)?.version.versionNumber ?? null,
          approvedAt: h.approvedAt,
          approvedByName: null,
          createdAt: now,
          updatedAt: now,
        })),
    };
  };

  const computed = (
    facts: LabelFacts,
    options: { compoundStyle: string; quidItemIds: string[]; includeNutrition: boolean },
  ) => ({
    recipeVersionId: facts.recipeVersionId,
    ingredients: facts.declaration,
    allergenStatement: facts.allergenStatement || null,
    allergens: { contains: facts.allergens.contains, mayContain: facts.mayContain },
    includeNutrition: options.includeNutrition,
    nutrition: options.includeNutrition ? facts.nutrition.panel : null,
    compoundStyle: options.compoundStyle,
    quidItemIds: options.quidItemIds,
    sourceSnapshot: facts.snapshot,
  });

  // ── Items ──
  app.get(`${ws}/labelling/items`, (c) => {
    const q = c.req.query();
    const g = graph();
    const text = q.q?.toLowerCase();
    const all = deps.items
      .filter((i) => i.type !== "packaging" && (q.status === "all" || i.status === (q.status ?? "active")))
      .filter((i) => !q.type || i.type === q.type)
      .filter((i) => !text || i.code.toLowerCase().includes(text) || i.name.toLowerCase().includes(text))
      .map((i) => itemView(i, g))
      .filter((i) => !q.nutrition || q.nutrition === "all" || i.effective.source === q.nutrition);
    const limit = Number(q.limit ?? 100);
    const offset = Number(q.offset ?? 0);
    return c.json({ items: all.slice(offset, offset + limit), total: all.length, limit, offset });
  });
  app.get(`${ws}/labelling/items/:itemId`, (c) => {
    const item = deps.items.find((i) => i.id === c.req.param("itemId"));
    return item ? c.json(itemView(item, graph())) : c.json(err("not_found", "Item not found"), 404);
  });
  app.put(`${ws}/labelling/items/:itemId`, async (c) => {
    const item = deps.items.find((i) => i.id === c.req.param("itemId"));
    if (!item) return c.json(err("not_found", "Item not found"), 404);
    if (item.type === "packaging") {
      return c.json(
        err("invalid_input", `${item.code} is packaging; only food items have labelling data`),
        400,
      );
    }
    const parsed = itemLabelDataSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.issues[0]!.message), 400);
    data.set(item.id, { ...parsed.data, nutrition: parsed.data.nutrition ?? null });
    return c.json(itemView(item, graph()));
  });

  // CSV import of nutrition: matched by stock code (or exact name); a simpler stand-in for the server's.
  app.post(`${ws}/labelling/items/import`, async (c) => {
    const body = csvImportSchema.parse(await c.req.json());
    const parsed = parseNutritionCsv(body.csv);
    const errors: { row: number; column?: string; message: string }[] = [...parsed.errors];
    const plan: { entry: (typeof parsed.entries)[number]; item: Record<string, any>; action: string }[] = [];
    for (const entry of parsed.entries) {
      const item = deps.items.find((i) =>
        entry.code
          ? i.code.toLowerCase() === entry.code.toLowerCase()
          : i.name.toLowerCase() === entry.name!.toLowerCase(),
      );
      if (!item)
        errors.push({ row: entry.row, column: entry.code ? "code" : "name", message: "No such item" });
      else plan.push({ entry, item, action: data.has(item.id) ? "update" : "create" });
    }
    const result = (dryRun: boolean) => ({
      dryRun,
      fileName: body.fileName ?? null,
      rowCount: parsed.rowCount,
      ignoredColumns: parsed.ignoredColumns,
      errors: dryRun ? errors : [],
      created: plan.filter((p) => p.action === "create").length,
      updated: plan.filter((p) => p.action === "update").length,
      unchanged: 0,
      changes: plan.map((p) => ({
        row: p.entry.row,
        action: p.action,
        key: p.item.code,
        name: p.item.name,
        fields: [],
      })),
      changesTruncated: false,
    });
    if (errors.length) {
      return body.dryRun
        ? c.json(result(true))
        : c.json(
            {
              error: {
                code: "invalid_rows",
                message: "Some rows have problems; nothing was saved.",
                details: { errors },
              },
            },
            400,
          );
    }
    if (!body.dryRun) {
      for (const { entry, item } of plan) {
        data.set(item.id, {
          ...data.get(item.id),
          nutrition: { basis: entry.basis ?? "100g", ...entry.nutrition },
          ...(entry.micronutrients ? { micronutrients: entry.micronutrients } : {}),
          nutritionSource: entry.nutritionSource ?? null,
        });
      }
    }
    return c.json(result(!!body.dryRun), body.dryRun ? 200 : 201);
  });

  // ── Computed ──
  app.get(`${ws}/labelling/recipes/:id/versions/:versionId`, (c) => {
    const found = findVersion(c.req.param("versionId"));
    if (!found || found.recipe.id !== c.req.param("id")) {
      return c.json(err("not_found", "Recipe version not found"), 404);
    }
    const q = c.req.query();
    const g = graph();
    const facts = computeLabelFacts(labelVersion(found.recipe, found.version), g, {
      compoundStyle: q.compoundStyle as never,
      quidItemIds: q.quid ? q.quid.split(",") : [],
      volatileItemIds: q.volatile ? q.volatile.split(",") : [],
      energyMethod: q.energyMethod as never,
    });
    const output = g.items.get(found.recipe.outputItemId);
    return c.json({
      recipe: { id: found.recipe.id, code: found.recipe.code, name: found.recipe.name },
      version: {
        id: found.version.id,
        versionNumber: found.version.versionNumber,
        status: found.version.status,
      },
      outputItem: output ? { id: output.id, code: output.code, name: output.name, unit: output.unit } : null,
      ...factsView(facts),
    });
  });

  // ── Labels ──
  app.get(`${ws}/labelling/labels`, (c) => {
    const q = c.req.query();
    const status = q.status ?? "current";
    const all = labels
      .filter((l) => !q.recipeId || l.recipeId === q.recipeId)
      .filter((l) =>
        status === "all" ? true : status === "current" ? l.status !== "superseded" : l.status === status,
      )
      .map(labelView)
      .filter((l) => q.stale === undefined || String(l.stale) === q.stale);
    const limit = Number(q.limit ?? 50);
    const offset = Number(q.offset ?? 0);
    return c.json({ labels: all.slice(offset, offset + limit), total: all.length, limit, offset });
  });
  app.get(`${ws}/labelling/labels/:id`, (c) => {
    const l = labels.find((x) => x.id === c.req.param("id"));
    return l ? c.json(labelView(l)) : c.json(err("not_found", "Label not found"), 404);
  });
  app.post(`${ws}/labelling/labels`, async (c) => {
    const parsed = productLabelCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.issues[0]!.message), 400);
    const input = parsed.data;
    const recipe = deps.recipes.find((r) => r.id === input.recipeId);
    if (!recipe) return c.json(err("not_found", "Recipe not found"), 404);
    const approved = recipe.versions.find((v) => v.status === "approved");
    if (!approved) return c.json(err("no_approved_version", "This recipe has no approved version"), 409);
    const mine = labels.filter((l) => l.recipeId === recipe.id);
    const draft = mine.find((l) => l.status === "draft");
    if (draft)
      return c.json(
        err("label_draft_exists", "This recipe already has a draft label", { id: draft.id }),
        409,
      );
    const previous = mine.find((l) => l.status === "approved");
    const options = {
      compoundStyle: input.compoundStyle ?? previous?.compoundStyle ?? "bracketed",
      quidItemIds: input.quidItemIds ?? previous?.quidItemIds ?? [],
      includeNutrition: input.includeNutrition ?? previous?.includeNutrition ?? true,
    };
    const g = graph();
    const facts = computeLabelFacts(labelVersion(recipe, approved), g, options as never);
    const output = deps.items.find((i) => i.id === recipe.outputItemId)!;
    const storage = (output.storage ?? "ambient") as keyof typeof storageGuidance;
    const label = {
      id: newId(),
      recipeId: recipe.id,
      versionNumber: Math.max(0, ...mine.map((l) => l.versionNumber)) + 1,
      status: "draft",
      productName: previous?.productName ?? output.name,
      storageInstructions: previous ? previous.storageInstructions : storageGuidance[storage],
      dateGuidance: previous ? previous.dateGuidance : dateGuidance(storage, output.shelfLifeDays),
      netQuantity: previous ? previous.netQuantity : netQuantityFor(output as never),
      notes: null,
      approvedAt: null,
      approvedBy: null,
      createdBy: "ada",
      generatedAt: now,
      createdAt: now,
      updatedAt: now,
      ...computed(facts, options),
    };
    labels.push(label);
    return c.json(labelView(label), 201);
  });
  const draftOr409 = (id: string) => {
    const l = labels.find((x) => x.id === id);
    if (!l) return { error: [err("not_found", "Label not found"), 404] as const };
    if (l.status !== "draft") {
      return {
        error: [err("label_not_draft", "An approved or superseded label never changes"), 409] as const,
      };
    }
    return { label: l };
  };
  app.patch(`${ws}/labelling/labels/:id`, async (c) => {
    const found = draftOr409(c.req.param("id"));
    if (found.error) return c.json(found.error[0], found.error[1]);
    const parsed = productLabelUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.issues[0]!.message), 400);
    const { ingredients, nutrition, ...text } = parsed.data;
    Object.assign(found.label, text);
    if (ingredients !== undefined) found.label.ingredients = parseSegmentsMarkup(ingredients);
    if (nutrition !== undefined) {
      found.label.includeNutrition = nutrition !== null;
      if (nutrition) {
        const { basis, ...values } = nutrition;
        found.label.nutrition = nutritionPanel(basis, values);
      } else found.label.nutrition = null;
    }
    return c.json(labelView(found.label));
  });
  app.post(`${ws}/labelling/labels/:id/refresh`, async (c) => {
    const found = draftOr409(c.req.param("id"));
    if (found.error) return c.json(found.error[0], found.error[1]);
    const parsed = productLabelRefreshSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.issues[0]!.message), 400);
    const l = found.label;
    const recipe = deps.recipes.find((r) => r.id === l.recipeId)!;
    const approved = recipe.versions.find((v) => v.status === "approved")!;
    const options = {
      compoundStyle: parsed.data.compoundStyle ?? l.compoundStyle,
      quidItemIds: parsed.data.quidItemIds ?? l.quidItemIds,
      includeNutrition: parsed.data.includeNutrition ?? l.includeNutrition,
    };
    Object.assign(l, computed(computeLabelFacts(labelVersion(recipe, approved), graph(), options), options));
    return c.json(labelView(l));
  });
  app.post(`${ws}/labelling/labels/:id/approve`, (c) =>
    c.json(err("token_not_allowed", "API tokens can't be used for this"), 403),
  );
  app.delete(`${ws}/labelling/labels/:id`, (c) => {
    const found = draftOr409(c.req.param("id"));
    if (found.error) return c.json(found.error[0], found.error[1]);
    labels.splice(labels.indexOf(found.label), 1);
    return c.body(null, 204);
  });

  return { labels, data };
}
