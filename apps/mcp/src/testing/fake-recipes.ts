import { newId, rollUpAllergens, rollUpRecipe, scaleRecipe } from "@knotworking/core";
import type { Hono } from "hono";

/** In-memory stand-in for the Recipes module's routes (apps/server/src/routes/recipes.ts). */
export function mountFakeRecipes(app: Hono, ws: string, items: Record<string, any>[]) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const now = "2026-01-05T09:00:00.000Z";
  const byCode = (code: string) => items.find((i) => i.code === code)!;

  interface Version {
    id: string;
    versionNumber: number;
    status: "draft" | "approved" | "superseded";
    yieldQuantity: number;
    yieldUnit: string;
    method: string | null;
    changeNote: string | null;
    approvedAt: string | null;
    approvedBy: string | null;
    lines: { id: string; itemId: string; quantity: number; unit: string; note: string | null }[];
  }
  interface Recipe {
    id: string;
    code: string;
    name: string;
    description: string | null;
    status: "active" | "archived";
    outputItemId: string;
    versions: Version[];
  }

  const facts = (item: Record<string, any>) => ({ ...item, standardCost: item.standardCost ?? null });
  const summary = (item: Record<string, any>) => ({ ...item, suppliers: undefined, supplierIds: undefined });

  const recipes: Recipe[] = [
    {
      id: newId(),
      code: "SPONGE",
      name: "Victoria sponge",
      description: null,
      status: "active",
      outputItemId: byCode("BOX-12").id,
      versions: [
        {
          id: newId(),
          versionNumber: 1,
          status: "approved",
          yieldQuantity: 10,
          yieldUnit: "kg",
          method: "Mix and bake.",
          changeNote: "First version",
          approvedAt: now,
          approvedBy: "Ada Lovelace",
          lines: [
            { id: newId(), itemId: byCode("FLR-001").id, quantity: 4, unit: "kg", note: null },
            { id: newId(), itemId: byCode("MLK-001").id, quantity: 2, unit: "l", note: null },
          ],
        },
      ],
    },
  ];

  const draftOf = (r: Recipe) => r.versions.find((v) => v.status === "draft");
  const approvedOf = (r: Recipe) => r.versions.find((v) => v.status === "approved");
  const output = (r: Recipe) => items.find((i) => i.id === r.outputItemId)!;

  const fullVersion = (r: Recipe, v: Version, scaleQuery?: Record<string, string>) => {
    const lines = v.lines.map((l) => ({
      quantity: l.quantity,
      unit: l.unit,
      item: facts(items.find((i) => i.id === l.itemId)!),
    }));
    const yieldInfo = { yieldQuantity: v.yieldQuantity, yieldUnit: v.yieldUnit };
    const rollup = rollUpRecipe(lines as never, yieldInfo as never, facts(output(r)) as never);
    const target = scaleQuery?.batches
      ? { batches: Number(scaleQuery.batches) }
      : scaleQuery?.outputQuantity
        ? { outputQuantity: Number(scaleQuery.outputQuantity), outputUnit: scaleQuery.outputUnit }
        : undefined;
    const scale = target ? scaleRecipe(lines, yieldInfo as never, target as never, output(r)) : null;
    return {
      id: v.id,
      recipeId: r.id,
      versionNumber: v.versionNumber,
      status: v.status,
      yieldQuantity: v.yieldQuantity,
      yieldUnit: v.yieldUnit,
      method: v.method,
      changeNote: v.changeNote,
      approvedAt: v.approvedAt,
      approvedBy: v.approvedBy,
      approvedByName: v.approvedBy,
      createdAt: now,
      updatedAt: now,
      outputItem: summary(output(r)),
      lines: v.lines.map((l, i) => {
        const item = items.find((x) => x.id === l.itemId)!;
        return {
          id: l.id,
          itemId: l.itemId,
          item: summary(item),
          quantity: l.quantity,
          unit: l.unit,
          sortOrder: i,
          note: l.note,
          cost: item.standardCost != null ? l.quantity * item.standardCost : null,
          ...(scale
            ? { scaledQuantity: scale.quantities[i], scaledQuantityRounded: scale.quantities[i] }
            : {}),
        };
      }),
      rollup,
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
  };

  const detail = (r: Recipe) => {
    const current = approvedOf(r) ?? draftOf(r);
    const draft = draftOf(r);
    const { versions: _v, ...head } = r;
    return {
      ...head,
      createdAt: now,
      updatedAt: now,
      outputItem: summary(output(r)),
      versions: [...r.versions]
        .sort((a, b) => b.versionNumber - a.versionNumber)
        .map((v) => ({
          ...v,
          lines: undefined,
          approvedByName: v.approvedBy,
          createdAt: now,
          updatedAt: now,
        })),
      currentVersion: current ? fullVersion(r, current) : null,
      draftVersion: draft && current && draft !== current ? fullVersion(r, draft) : null,
    };
  };

  /** Applies a draft body like the API: items must exist and be active; the output can't be a line. */
  const saveDraft = (r: Recipe, body: any) => {
    for (const l of body.lines ?? []) {
      const item = items.find((i) => i.id === l.itemId);
      if (!item) return err("invalid_input", `Unknown item ${l.itemId}`);
      if (item.id === r.outputItemId)
        return err("invalid_input", `${item.code} can't be an ingredient of itself`);
      if (item.status === "archived") return err("invalid_input", `${item.code} is archived`);
    }
    let draft = draftOf(r);
    if (!draft) {
      draft = {
        id: newId(),
        versionNumber: Math.max(0, ...r.versions.map((v) => v.versionNumber)) + 1,
        status: "draft",
        yieldQuantity: 0,
        yieldUnit: "kg",
        method: null,
        changeNote: null,
        approvedAt: null,
        approvedBy: null,
        lines: [],
      };
      r.versions.push(draft);
    }
    draft.yieldQuantity = body.yieldQuantity;
    draft.yieldUnit = body.yieldUnit;
    draft.method = body.method ?? null;
    draft.changeNote = body.changeNote ?? null;
    draft.lines = body.lines.map((l: any) => ({
      id: newId(),
      itemId: l.itemId,
      quantity: l.quantity,
      unit: l.unit,
      note: l.note ?? null,
    }));
    return draft;
  };

  app.get(`${ws}/recipes`, (c) => {
    const q = c.req.query();
    const text = q.q?.toLowerCase();
    const status = q.status ?? "active";
    const found = recipes.filter(
      (r) =>
        (status === "all" || r.status === status) &&
        (!q.outputItemId || r.outputItemId === q.outputItemId) &&
        (!q.itemId || (approvedOf(r) ?? draftOf(r))?.lines.some((l) => l.itemId === q.itemId)) &&
        (!text || r.name.toLowerCase().includes(text) || r.code.toLowerCase().includes(text)),
    );
    const limit = Number(q.limit ?? 50);
    const offset = Number(q.offset ?? 0);
    return c.json({
      recipes: found.slice(offset, offset + limit).map((r) => {
        const current = approvedOf(r) ?? draftOf(r);
        const { versions: _v, ...head } = r;
        return {
          ...head,
          outputItem: summary(output(r)),
          approvedVersionNumber: approvedOf(r)?.versionNumber ?? null,
          hasDraft: !!draftOf(r),
          draftVersionNumber: draftOf(r)?.versionNumber ?? null,
          allergens: rollUpAllergens(
            (current?.lines ?? []).map((l) => ({
              item: facts(items.find((i) => i.id === l.itemId)!) as never,
            })),
          ),
        };
      }),
      total: found.length,
      limit,
      offset,
    });
  });
  app.get(`${ws}/recipes/:id`, (c) => {
    const found = recipes.find((r) => r.id === c.req.param("id"));
    return found ? c.json(detail(found)) : c.json(err("not_found", "Recipe not found"), 404);
  });
  app.get(`${ws}/recipes/:id/versions/:versionId`, (c) => {
    const found = recipes.find((r) => r.id === c.req.param("id"));
    const version = found?.versions.find((v) => v.id === c.req.param("versionId"));
    return found && version
      ? c.json(fullVersion(found, version, c.req.query()))
      : c.json(err("not_found", "Recipe version not found"), 404);
  });
  app.post(`${ws}/recipes`, async (c) => {
    const body = await c.req.json();
    if (recipes.some((r) => r.code.toLowerCase() === String(body.code).toLowerCase()))
      return c.json(err("code_taken", `Another recipe already uses the code "${body.code}"`), 409);
    const out = items.find((i) => i.id === body.outputItemId);
    if (!out) return c.json(err("invalid_input", "Unknown outputItemId"), 400);
    // The real API also requires a wip or finished output item (covered by the server tests).
    const created: Recipe = {
      id: newId(),
      code: body.code,
      name: body.name,
      description: body.description ?? null,
      status: "active",
      outputItemId: out.id,
      versions: [],
    };
    if (body.draft) {
      const saved = saveDraft(created, body.draft);
      if ("error" in saved) return c.json(saved, 400);
    }
    recipes.push(created);
    return c.json(detail(created), 201);
  });
  app.patch(`${ws}/recipes/:id`, async (c) => {
    const found = recipes.find((r) => r.id === c.req.param("id"));
    if (!found) return c.json(err("not_found", "Recipe not found"), 404);
    Object.assign(found, await c.req.json());
    return c.json(detail(found));
  });
  app.put(`${ws}/recipes/:id/draft`, async (c) => {
    const found = recipes.find((r) => r.id === c.req.param("id"));
    if (!found) return c.json(err("not_found", "Recipe not found"), 404);
    const saved = saveDraft(found, await c.req.json());
    return "error" in saved ? c.json(saved, 400) : c.json(fullVersion(found, saved));
  });

  return { recipes };
}
