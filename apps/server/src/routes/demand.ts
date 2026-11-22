import {
  demandCapacityQuerySchema,
  demandCoverageQuerySchema,
  demandForecastApplySchema,
  demandForecastQuerySchema,
  packUnitListQuerySchema,
  packUnitsSetSchema,
  demandImportListQuerySchema,
  demandImportSchema,
  demandLineListQuerySchema,
  demandLinesSetSchema,
  demandSummaryQuerySchema,
} from "@knotworking/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import {
  applyDemandForecast,
  deletePackUnit,
  getDemandCoverage,
  getDemandForecast,
  listPackUnits,
  setPackUnits,
  deleteDemandLine,
  getDemandLineHistory,
  getDemandSummary,
  importDemandCsv,
  listDemandImports,
  listDemandLines,
  setDemandLines,
} from "../services/demand";
import { canRead } from "../middleware/modules";
import { getDemandCapacity } from "../services/demand-capacity";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });

/** A person in the app sets demand by hand; an API token is the sales system's feed or an agent. */
const sourceOf = (c: Context<WorkspaceEnv>) => (c.var.credential.kind === "token" ? "api" : "manual");

/**
 * Demand module (`demand`): demand per item per ISO week, by customer. Mounted at
 * `/v1/workspaces/:slug`; the module guard has already required `read` for safe methods and
 * `write` for the rest. Every route takes API tokens, so agents and the sales system can post
 * demand; nothing here needs `manage`.
 */
export const demandRoutes = new Hono<WorkspaceEnv>()
  // Totals per item per week: what production plans from.
  .get("/demand/summary", validate("query", demandSummaryQuerySchema), async (c) => {
    const { itemId, ...query } = c.req.valid("query");
    return c.json(
      await getDemandSummary(c.var.db, c.var.workspace.id, {
        ...query,
        ...(itemId ? { itemIds: [itemId] } : {}),
      }),
    );
  })
  // A simple forecast per item (and customer) from past demand.
  .get("/demand/forecast", validate("query", demandForecastQuerySchema), async (c) =>
    c.json(await getDemandForecast(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  // Copies the forecast into demand lines (source `forecast`); only empty weeks unless `overwrite`.
  .post("/demand/forecast/apply", validate("json", demandForecastApplySchema), async (c) =>
    c.json(await applyDemandForecast(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"))),
  )
  // Demand against stock and planned batches. Stock and production figures are included only when
  // the caller can read those modules (demand doesn't depend on them).
  .get("/demand/coverage", validate("query", demandCoverageQuerySchema), async (c) =>
    c.json(
      await getDemandCoverage(c.var.db, c.var.workspace.id, c.req.valid("query"), {
        stock: c.var.activeModules.includes("stock") && canRead(c, "stock"),
        production: c.var.activeModules.includes("production") && canRead(c, "production"),
      }),
    ),
  )
  // The cover view's shortfall against production line capacity. Production figures only for
  // people who can read production (demand doesn't depend on it): others get `available: false`.
  .get("/demand/capacity", validate("query", demandCapacityQuerySchema), async (c) =>
    c.json(
      await getDemandCapacity(c.var.db, c.var.workspace.id, c.req.valid("query"), {
        stock: c.var.activeModules.includes("stock") && canRead(c, "stock"),
        production: c.var.activeModules.includes("production") && canRead(c, "production"),
      }),
    ),
  )
  // Units of sale (case = 12 each).
  .get("/demand/pack-units", validate("query", packUnitListQuerySchema), async (c) =>
    c.json(await listPackUnits(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .put("/demand/pack-units", validate("json", packUnitsSetSchema), async (c) =>
    c.json(await setPackUnits(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"))),
  )
  .delete("/demand/pack-units/:id", validate("param", idParam), async (c) => {
    await deletePackUnit(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })
  .get("/demand/lines", validate("query", demandLineListQuerySchema), async (c) =>
    c.json(await listDemandLines(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  // Create, replace or remove (`quantity: null`) many lines at once; idempotent per key.
  .put("/demand/lines", validate("json", demandLinesSetSchema), async (c) =>
    c.json(
      await setDemandLines(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), sourceOf(c)),
    ),
  )
  .get("/demand/lines/:id/history", validate("param", idParam), async (c) =>
    c.json(await getDemandLineHistory(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .delete("/demand/lines/:id", validate("param", idParam), async (c) => {
    await deleteDemandLine(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id, sourceOf(c));
    return c.body(null, 204);
  })
  .get("/demand/imports", validate("query", demandImportListQuerySchema), async (c) =>
    c.json(await listDemandImports(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  // CSV import: `dryRun` checks and previews; otherwise all rows or none.
  .post("/demand/imports", validate("json", demandImportSchema), async (c) => {
    const input = c.req.valid("json");
    const result = await importDemandCsv(c.var.db, c.var.workspace.id, c.var.user.id, input);
    return c.json(result, input.dryRun ? 200 : 201);
  });
