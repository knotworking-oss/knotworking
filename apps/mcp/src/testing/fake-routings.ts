import {
  jobCardExceptionSchema,
  jobCardQuantitySchema,
  jobCardTimeEntrySchema,
  newId,
  routingCreateSchema,
  routingDraftSchema,
  workCentreCreateSchema,
  workCentreUpdateSchema,
} from "@knotworking/core";
import type { Context, Hono } from "hono";
import type { ZodType } from "zod";

/**
 * In-memory stand-in for the Routings routes (apps/server/src/routes/routings.ts) that the MCP
 * tools use. Bodies are checked with the real schemas from `@knotworking/core`. Seeded with one
 * work centre (`CUT`). Job cards are made for any batch id with an approved routing; the sequence
 * rule (an operation can't report more than the one before passed as good) is enforced.
 */
export function mountFakeRoutings(app: Hono, ws: string) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const prefix = `${ws}/routings`;
  const workCentres: Record<string, any>[] = [
    { id: newId(), code: "CUT", name: "Cutting cell", hoursPerDay: 8, stations: 1, costPerHour: 30, status: "active" },
  ];
  const routings: Record<string, any>[] = [];
  const jobCards: Record<string, any>[] = [];

  async function body<T>(c: Context, schema: ZodType<T>) {
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    return parsed.success ? { data: parsed.data } : { error: parsed.error.message };
  }
  const invalid = (c: Context, message: string) => c.json(err("invalid_input", message), 400);

  app.get(`${prefix}/work-centres`, (c) => {
    const status = c.req.query("status") ?? "active";
    const q = c.req.query("q")?.toLowerCase();
    return c.json({
      workCentres: workCentres.filter(
        (w) => (status === "all" || w.status === status) && (!q || `${w.code} ${w.name}`.toLowerCase().includes(q)),
      ),
    });
  });
  app.post(`${prefix}/work-centres`, async (c) => {
    const { data, error } = await body(c, workCentreCreateSchema);
    if (!data) return invalid(c, error!);
    if (workCentres.some((w) => w.code.toLowerCase() === data.code.toLowerCase())) {
      return c.json(err("code_taken", `A work centre with code ${data.code} already exists`), 409);
    }
    const row = { ...data, id: data.id ?? newId(), status: "active" };
    workCentres.push(row);
    return c.json(row, 201);
  });
  app.patch(`${prefix}/work-centres/:id`, async (c) => {
    const row = workCentres.find((w) => w.id === c.req.param("id"));
    if (!row) return c.json(err("not_found", "Work centre not found"), 404);
    const { data, error } = await body(c, workCentreUpdateSchema);
    if (!data) return invalid(c, error!);
    Object.assign(row, data);
    return c.json(row);
  });

  app.get(`${prefix}/job-cards`, (c) => {
    const status = c.req.query("status") ?? "open";
    const batchId = c.req.query("batchId");
    const found = jobCards.filter(
      (j) =>
        (status === "all" ||
          (status === "open" ? ["pending", "in_progress"].includes(j.status) : j.status === status)) &&
        (!batchId || j.batchId === batchId),
    );
    return c.json({ jobCards: found, total: found.length, limit: 50, offset: 0 });
  });
  const card = (c: Context) => jobCards.find((j) => j.id === c.req.param("id"));
  app.get(`${prefix}/job-cards/:id`, (c) => {
    const row = card(c);
    return row ? c.json(row) : c.json(err("not_found", "Job card not found"), 404);
  });
  app.post(`${prefix}/job-cards/:id/time`, async (c) => {
    const row = card(c);
    if (!row) return c.json(err("not_found", "Job card not found"), 404);
    const { data, error } = await body(c, jobCardTimeEntrySchema);
    if (!data) return invalid(c, error!);
    row.actualMinutes += data.minutes;
    row.status = "in_progress";
    return c.json(row, 201);
  });
  app.post(`${prefix}/job-cards/:id/quantities`, async (c) => {
    const row = card(c);
    if (!row) return c.json(err("not_found", "Job card not found"), 404);
    const { data, error } = await body(c, jobCardQuantitySchema);
    if (!data) return invalid(c, error!);
    const previous = jobCards.find((j) => j.batchId === row.batchId && j.position === row.position - 1);
    if (previous && row.good + row.scrap + data.good + data.scrap > previous.good) {
      return c.json(err("exceeds_previous_good", "More than the previous operation passed as good"), 409);
    }
    row.good += data.good;
    row.scrap += data.scrap;
    row.status = "in_progress";
    return c.json(row, 201);
  });
  app.post(`${prefix}/job-cards/:id/exceptions`, async (c) => {
    const row = card(c);
    if (!row) return c.json(err("not_found", "Job card not found"), 404);
    const { data, error } = await body(c, jobCardExceptionSchema);
    if (!data) return invalid(c, error!);
    row.exceptions.push({ id: newId(), ...data, status: "open" });
    row.openExceptions += 1;
    return c.json(row, 201);
  });
  app.post(`${prefix}/job-cards/:id/complete`, (c) => {
    const row = card(c);
    if (!row) return c.json(err("not_found", "Job card not found"), 404);
    if (row.openExceptions > 0) return c.json(err("open_exceptions", "Resolve the open exceptions first"), 409);
    row.status = "completed";
    return c.json(row);
  });
  app.post(`${prefix}/batches/:batchId/job-cards`, (c) => {
    const batchId = c.req.param("batchId");
    const routing = routings.find((r) => r.versions.some((v: { status: string }) => v.status === "approved"));
    if (!routing) return c.json(err("no_routing", "This batch's bill of materials has no routing"), 409);
    const version = routing.versions.find((v: { status: string }) => v.status === "approved");
    const made = version.operations.map((op: Record<string, any>) => ({
      id: newId(),
      batchId,
      position: op.position,
      name: op.name,
      workCentreId: op.workCentreId,
      status: "pending",
      good: 0,
      scrap: 0,
      actualMinutes: 0,
      openExceptions: 0,
      exceptions: [],
    }));
    jobCards.push(...made);
    return c.json({ batch: { id: batchId }, jobCards: made }, 201);
  });

  app.get(prefix, (c) => {
    const found = routings.filter((r) => !c.req.query("recipeId") || r.recipe.id === c.req.query("recipeId"));
    return c.json({ routings: found, total: found.length, limit: 50, offset: 0 });
  });
  app.post(prefix, async (c) => {
    const { data, error } = await body(c, routingCreateSchema);
    if (!data) return invalid(c, error!);
    const row = {
      id: data.id ?? newId(),
      code: data.code,
      name: data.name,
      status: "active",
      recipe: { id: data.recipeId },
      versions: data.draft
        ? [{ versionNumber: 1, status: "draft", operations: data.draft.operations.map((o, i) => ({ ...o, position: i + 1 })) }]
        : [],
    };
    routings.push(row);
    return c.json(row, 201);
  });
  const routing = (c: Context) => routings.find((r) => r.id === c.req.param("id"));
  app.get(`${prefix}/:id`, (c) => {
    const row = routing(c);
    return row ? c.json(row) : c.json(err("not_found", "Routing not found"), 404);
  });
  app.put(`${prefix}/:id/draft`, async (c) => {
    const row = routing(c);
    if (!row) return c.json(err("not_found", "Routing not found"), 404);
    const { data, error } = await body(c, routingDraftSchema);
    if (!data) return invalid(c, error!);
    const operations = data.operations.map((o, i) => ({ ...o, position: i + 1 }));
    const draft = row.versions.find((v: { status: string }) => v.status === "draft");
    if (draft) draft.operations = operations;
    else row.versions.unshift({ versionNumber: row.versions.length + 1, status: "draft", operations });
    return c.json(row);
  });

  /** The test's stand-in for a person approving a draft in the app. */
  const approve = (id: string) => {
    const row = routings.find((r) => r.id === id)!;
    for (const v of row.versions) if (v.status === "approved") v.status = "superseded";
    row.versions.find((v: { status: string }) => v.status === "draft").status = "approved";
  };
  return { workCentres, routings, jobCards, approve };
}
