import {
  absorptionRateSetSchema,
  costingAdjustmentsQuerySchema,
  costingBatchListQuerySchema,
  costingCloseListQuerySchema,
  costingCloseSchema,
  costingExportQuerySchema,
  costingReopenSchema,
  costingReportQuerySchema,
  costingReportRange,
  costingValuationQuerySchema,
  standardCostSetSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { badRequest } from "../errors";
import { forbidTokens } from "../middleware/auth";
import { canRead, requireModuleLevel } from "../middleware/modules";
import { getBatchCost, getLotCost, listBatchCosts } from "../services/costing";
import {
  closePeriod,
  costingExport,
  getAdjustmentCosts,
  getClose,
  getCostingReport,
  getStockValuation,
  listCloses,
  reopenPeriod,
} from "../services/costing-reports";
import {
  listAbsorptionRates,
  listStandardCosts,
  setAbsorptionRate,
  setStandardCost,
} from "../services/costing-settings";
import { todayIn } from "../middleware/workspace";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const itemIdParam = z.object({ itemId: z.uuid() });

/**
 * Costing module (`costing`). Mounted at `/v1/workspaces/:slug`; the module guard has already
 * required `read`, so costs (commercially sensitive) reach only people granted costing. Costs are
 * computed from the ledger on each request and nothing about them is stored, so reading needs
 * nothing more. What people set needs `manage` and, because it changes what the figures say,
 * a person rather than an API token: closing and reopening a period, standard cost history and
 * absorption rates.
 */
export const costingRoutes = new Hono<WorkspaceEnv>()
  .get("/costing/batches", validate("query", costingBatchListQuerySchema), async (c) =>
    c.json(await listBatchCosts(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/costing/batches/:id", validate("param", idParam), async (c) =>
    c.json(
      await getBatchCost(c.var.db, c.var.workspace.id, c.req.valid("param").id, {
        operations: c.var.activeModules.includes("routings") && canRead(c, "routings"),
      }),
    ),
  )
  .get("/costing/lots/:id", validate("param", idParam), async (c) =>
    c.json(await getLotCost(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .get("/costing/report", validate("query", costingReportQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const range = costingReportRange(query, todayIn(c));
    if (range.error) throw badRequest(range.error);
    return c.json(
      await getCostingReport(c.var.db, c.var.workspace.id, {
        period: query.period,
        from: range.from,
        to: range.to,
        outputItemId: query.outputItemId,
        recipeId: query.recipeId,
      }),
    );
  })

  // ── Stock valuation, waste and adjustments, accounting export ──
  .get("/costing/valuation", validate("query", costingValuationQuerySchema), async (c) =>
    c.json(await getStockValuation(c.var.db, c.var.workspace.id, c.req.valid("query"), todayIn(c))),
  )
  .get("/costing/adjustments", validate("query", costingAdjustmentsQuerySchema), async (c) =>
    c.json(await getAdjustmentCosts(c.var.db, c.var.workspace.id, c.req.valid("query"), todayIn(c))),
  )
  .get("/costing/export.csv", validate("query", costingExportQuerySchema), async (c) => {
    const file = await costingExport(c.var.db, c.var.workspace.id, c.req.valid("query"), todayIn(c));
    return c.body(`﻿${file.csv}`, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file.fileName}"`,
      "cache-control": "no-store",
    });
  })

  // ── Closing a period: a sign-off by a person with `manage`, never an API token ──
  .get("/costing/closes", validate("query", costingCloseListQuerySchema), async (c) =>
    c.json(await listCloses(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/costing/closes/:id", validate("param", idParam), async (c) =>
    c.json(await getClose(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post(
    "/costing/closes",
    forbidTokens,
    requireModuleLevel("costing", "manage"),
    validate("json", costingCloseSchema),
    async (c) =>
      c.json(
        await closePeriod(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"), todayIn(c)),
        201,
      ),
  )
  .post(
    "/costing/closes/:id/reopen",
    forbidTokens,
    requireModuleLevel("costing", "manage"),
    validate("param", idParam),
    validate("json", costingReopenSchema),
    async (c) =>
      c.json(
        await reopenPeriod(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json").reason,
        ),
      ),
  )

  // ── Standard cost history and absorption rates ──
  .get("/costing/standard-costs/:itemId", validate("param", itemIdParam), async (c) =>
    c.json(await listStandardCosts(c.var.db, c.var.workspace.id, c.req.valid("param").itemId)),
  )
  .put(
    "/costing/standard-costs",
    forbidTokens,
    requireModuleLevel("costing", "manage"),
    validate("json", standardCostSetSchema),
    async (c) =>
      c.json(await setStandardCost(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"))),
  )
  .get("/costing/rates", async (c) => c.json(await listAbsorptionRates(c.var.db, c.var.workspace.id)))
  .put(
    "/costing/rates",
    forbidTokens,
    requireModuleLevel("costing", "manage"),
    validate("json", absorptionRateSetSchema),
    async (c) =>
      c.json(await setAbsorptionRate(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"))),
  );
