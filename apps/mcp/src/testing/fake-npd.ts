import {
  newId,
  npdLaunchChecklist,
  npdProjectCreateSchema,
  npdProjectUpdateSchema,
  npdTrialSchema,
} from "@knotworking/core";
import type { Hono } from "hono";

/** In-memory stand-in for the Product development routes (apps/server/src/routes/npd.ts). */
export function mountFakeNpd(
  app: Hono,
  ws: string,
  deps: { items: Record<string, any>[]; recipes: Record<string, any>[] },
) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const projects: Record<string, any>[] = [];
  const view = (p: Record<string, any>) => {
    const item = deps.items.find((i) => i.id === p.outputItemId);
    const recipe = deps.recipes.find((r) => r.id === p.recipeId);
    const approved = recipe?.versions.find((v: any) => v.status === "approved");
    const checklist = npdLaunchChecklist({
      active: ["items", "recipes"],
      project: p as never,
      recipeApprovedVersion: approved?.versionNumber ?? null,
      trials: p.trials,
      approvedSpecification: null,
      approvedLabel: null,
    });
    return {
      ...p,
      outputItem: item ? { id: item.id, code: item.code, name: item.name } : null,
      recipe: recipe ? { id: recipe.id, code: recipe.code, name: recipe.name } : null,
      trials: [...p.trials].reverse(),
      checklist: checklist.checks,
      readyToLaunch: checklist.ready,
    };
  };
  app.get(`${ws}/npd/projects`, (c) => {
    const q = c.req.query("q")?.toLowerCase();
    const rows = projects.filter(
      (p) => !q || p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
    );
    return c.json({
      projects: rows.map((p) => ({ ...p, itemCode: null, recipeCode: null, trialCount: p.trials.length })),
      total: rows.length,
      offset: 0,
    });
  });
  app.get(`${ws}/npd/projects/:id`, (c) => {
    const p = projects.find((x) => x.id === c.req.param("id"));
    return p ? c.json(view(p)) : c.json(err("not_found", "Project not found"), 404);
  });
  app.post(`${ws}/npd/projects`, async (c) => {
    const parsed = npdProjectCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const p = {
      id: newId(),
      status: "brief",
      brief: null,
      customerName: null,
      targetLaunchOn: null,
      targetCost: null,
      targetShelfLifeDays: null,
      storage: null,
      constraints: null,
      outputItemId: null,
      recipeId: null,
      signoffs: {},
      trials: [] as any[],
      ...parsed.data,
    };
    projects.push(p);
    return c.json(view(p), 201);
  });
  app.patch(`${ws}/npd/projects/:id`, async (c) => {
    const p = projects.find((x) => x.id === c.req.param("id"));
    if (!p) return c.json(err("not_found", "Project not found"), 404);
    const parsed = npdProjectUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    Object.assign(p, parsed.data);
    return c.json(view(p));
  });
  app.post(`${ws}/npd/projects/:id/trials`, async (c) => {
    const p = projects.find((x) => x.id === c.req.param("id"));
    if (!p) return c.json(err("not_found", "Project not found"), 404);
    const parsed = npdTrialSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    p.trials.push({
      id: newId(),
      trialNumber: p.trials.length + 1,
      findings: null,
      achievedShelfLifeDays: null,
      recipeVersionNumber: null,
      ...parsed.data,
    });
    if (p.status === "brief" || p.status === "development") p.status = "trials";
    return c.json(view(p), 201);
  });
  return { projects };
}
