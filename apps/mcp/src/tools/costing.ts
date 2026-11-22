import {
  costingBatchListStatuses,
  costingPeriods,
  lotCostReasonLabels,
  lotCostSourceLabels,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const SIGN =
  "Money is a plain number in the workspace's currency. Variances are actual minus standard: positive is adverse (it cost more), negative favourable.";

type Amount = { display: number; displayUnit: string };
const qty = (a: Amount) => `${a.display} ${a.displayUnit}`;
const itemName = (i: { code: string; name: string }) => `${i.code} ${i.name}`;

/**
 * Costing module: what batches actually cost, their yield, and standard against actual. Read-only:
 * costs are computed on read from batch records, purchase receipts and standard costs.
 */
export function registerCostingTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];
  const costing = (api: Api) => ws(api).costing;

  /** An item by id or exact stock code (case-insensitive). */
  async function resolveItemId(api: Api, slug: string, ref: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { items } = await api.call(
      ws(api).items.$get({ param: { slug }, query: { q: wanted, status: "all", limit: "200" } }),
    );
    const match = items.filter((i) => i.code.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError("not_found", `No item has the code "${wanted}". Use list_items to find it.`);
  }

  /** A batch by id or exact batch code (case-insensitive), among batches with something to cost. */
  async function resolveBatchId(api: Api, slug: string, ref: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { batches } = await api.call(
      costing(api).batches.$get({ param: { slug }, query: { q: wanted, status: "all", limit: "100" } }),
    );
    const match = batches.filter((b) => b.batchCode.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      "not_found",
      `No batch with records has the code "${wanted}" (a planned batch has nothing to cost yet). Use list_batch_costs to find it.`,
    );
  }

  define(
    "list_batch_costs",
    {
      module: "costing",
      resource: { name: "batch_costs", op: "list" },
      title: "List batch costs",
      description: `Production batches with their actual cost, newest first: completed batches by default (by completion date), or in-progress and cancelled ones (by planned date). Each row gives the actual cost, the share resting on estimated (standard) costs, cost per output unit against the standard per unit, the yield against plan and the total variance. Use get_batch_cost for one batch in full. ${SIGN}`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        status: z.enum(costingBatchListStatuses).optional().describe("Default completed."),
        from: isoDate
          .optional()
          .describe("Costing date from (completion date, or planned date if not completed)."),
        to: isoDate.optional(),
        product: z.string().max(200).optional().describe("Output item id or stock code."),
        query: z.string().max(200).optional().describe("Matches the batch code, the recipe's code or name."),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const outputItemId = a.product ? await resolveItemId(api, slug, a.product) : undefined;
      const res = await api.call(
        costing(api).batches.$get({
          param: { slug },
          query: {
            ...(a.status ? { status: a.status } : {}),
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
            ...(outputItemId ? { outputItemId } : {}),
            ...(a.query ? { q: a.query } : {}),
            limit: String(a.limit ?? 25),
            offset: String(a.offset ?? 0),
          },
        }),
      );
      return {
        total: res.total,
        offset: res.offset,
        batches: res.batches.map((b) => ({
          batch: b.batchCode,
          status: b.status,
          date: b.costingDate,
          recipe: b.recipe ? `${b.recipe.code} ${b.recipe.name}` : null,
          product: itemName(b.outputItem),
          produced: qty(b.cost.produced),
          yieldPercent: b.cost.yieldPercent,
          actualCost: b.cost.actualCost,
          estimatedPercent: b.cost.estimatedPercent,
          costComplete: b.cost.costComplete,
          provisional: b.cost.provisional,
          costPerUnit: b.cost.costPerUnit,
          standardCostPerUnit: b.cost.standardCostPerUnit,
          variance: b.cost.variance,
          variancePercent: b.cost.variancePercent,
        })),
      };
    },
  );

  define(
    "get_batch_cost",
    {
      module: "costing",
      resource: { name: "batch_costs", op: "get" },
      title: "Get a batch's cost",
      description: `One batch's actual cost in full: each lot it consumed with its cost per unit and where that comes from (the purchase price on the delivery; the cost per unit of the batch that made it, for work in progress; or the item's standard cost when no price is known, flagged as estimated), per ingredient what the plan needed against what was used, the yield against plan, and the variances against the recipe version's standard: price (prices paid), usage (inputs against the plan) and yield (output short of plan), which add up to the total. Figures are provisional while the batch, or any batch upstream of it, is still in progress. ${SIGN}`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        batch: z.string().min(1).max(200).describe("Batch id or batch code (e.g. B261112-001)."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveBatchId(api, slug, a.batch);
      const c = await api.call(costing(api).batches[":id"].$get({ param: { slug, id } }));
      const perUnit = c.outputUnit ? `per ${c.outputUnit}` : null;
      return {
        batch: c.batch.batchCode,
        status: c.batch.status,
        completedOn: c.batch.completedOn,
        recipe: c.batch.recipe ? `${c.batch.recipe.code} ${c.batch.recipe.name}` : null,
        recipeVersion: c.batch.recipeVersion?.versionNumber ?? null,
        product: itemName(c.batch.outputItem),
        provisional: c.provisional,
        planned: qty(c.planned),
        produced: qty(c.produced),
        yieldPercent: c.yield.percent,
        actualCost: c.actualCost,
        estimatedCost: c.estimatedCost,
        estimatedPercent: c.estimatedPercent,
        costComplete: c.costComplete,
        ...(c.missingItemCodes.length ? { itemsWithoutCost: c.missingItemCodes } : {}),
        costPerUnit: c.costPerUnit,
        standardCostPerUnit: c.standard.costPerUnit,
        perUnit,
        standardCostOfOutput: c.standard.producedCost,
        standardComplete: c.standard.complete,
        ...(c.standard.missingItemCodes.length
          ? { itemsWithoutStandardCost: c.standard.missingItemCodes }
          : {}),
        variance: c.variance,
        variancePercent: c.variancePercent,
        lots: c.lines.map((l) => ({
          lot: l.lotCode,
          item: itemName(l.item),
          quantity: qty(l.quantity),
          unitCost: l.unitCost,
          per: l.unit,
          cost: l.cost,
          source: lotCostSourceLabels[l.source],
          ...(l.reason ? { why: lotCostReasonLabels[l.reason] } : {}),
          ...(l.sourceBatch ? { madeBy: l.sourceBatch.batchCode } : {}),
          ...(l.estimatedPercent > 0 && l.source === "batch" ? { estimatedPercent: l.estimatedPercent } : {}),
          standardUnitCost: l.standardUnitCost,
        })),
        materials: c.materials.map((m) => ({
          item: itemName(m.item),
          inRecipe: m.inRecipe,
          required: m.required ? qty(m.required) : null,
          consumed: qty(m.consumed),
          actualCost: m.actualCost,
          priceVariance: m.priceVariance,
          usageVariance: m.usageVariance,
        })),
      };
    },
  );

  define(
    "costing_report",
    {
      module: "costing",
      title: "Standard against actual",
      description: `Standard against actual cost by product and period (ISO week or month) for completed batches, by completion date: batches, planned and produced quantities, yield, actual cost and the share estimated, standard cost of what was produced, and the price, usage and yield variances. Batches with a missing cost or standard cost count in actual cost but are left out of the standard and the variances (incompleteBatches says how many), so the comparison is like for like. Default: the last 6 months, or the last 13 weeks. ${SIGN}`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        period: z.enum(costingPeriods).optional().describe("Default month."),
        from: z.string().max(20).optional().describe("A date, ISO week (2026-W46) or month (2026-11)."),
        to: z.string().max(20).optional().describe("A date, ISO week (2026-W46) or month (2026-11)."),
        product: z.string().max(200).optional().describe("Output item id or stock code."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const outputItemId = a.product ? await resolveItemId(api, slug, a.product) : undefined;
      const r = await api.call(
        costing(api).report.$get({
          param: { slug },
          query: {
            ...(a.period ? { period: a.period } : {}),
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
            ...(outputItemId ? { outputItemId } : {}),
          },
        }),
      );
      const totals = (t: (typeof r)["totals"]) => ({
        batches: t.batches,
        incompleteBatches: t.incompleteBatches,
        actualCost: t.actualCost,
        estimatedPercent: t.estimatedPercent,
        standardCost: t.standardCost,
        comparedActualCost: t.comparedActualCost,
        variance: t.variance,
        variancePercent: t.variancePercent,
        // Labour and overhead absorbed (rates per batch hour and per kg): apart from the materials in actualCost.
        ...(t.conversion ? { labourAndOverhead: t.conversion, totalCost: t.totalCost } : {}),
      });
      return {
        period: r.period,
        from: r.from,
        to: r.to,
        totals: totals(r.totals),
        ...(r.adjustments ? { wasteAndAdjustments: r.adjustments } : {}),
        // A closed period shows its frozen figures; drift says whether today's differ.
        closedPeriods: (r.periods ?? [])
          .filter((p) => p.frozen)
          .map((p) => ({
            period: p.period,
            closedBy: p.frozen!.closedBy?.name ?? null,
            closedAt: p.frozen!.closedAt,
            driftedSince: p.frozen!.drift.changed,
          })),
        rows: r.rows.map((row) => ({
          product: itemName(row.item),
          period: row.period,
          ...totals(row),
          planned: qty(row.planned),
          produced: qty(row.produced),
          yieldPercent: row.yieldPercent,
          costPerUnit: row.costPerUnit,
          standardCostPerUnit: row.standardCostPerUnit,
          perUnit: row.item.unit,
        })),
      };
    },
  );

  define(
    "costing_valuation",
    {
      module: "costing",
      title: "Stock valuation",
      description: `Stock on hand valued at lot cost, per item and per lot, as of now: each lot at its invoice or purchase price, the batch that made it, or the item's standard cost (flagged as estimated); lots with no cost at all are counted but add nothing. Materials only. ${SIGN}`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        itemType: z.enum(["ingredient", "packaging", "wip", "finished"]).optional(),
        status: z.enum(["available", "quarantine", "rejected"]).optional().describe("Lot QA status."),
        q: z.string().max(200).optional().describe("Item name or code, or lot code."),
        lots: z.boolean().optional().describe("Include every lot (default: per item only)."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const r = await api.call(
        costing(api).valuation.$get({
          param: { slug },
          query: {
            ...(a.itemType ? { itemType: a.itemType } : {}),
            ...(a.status ? { status: a.status } : {}),
            ...(a.q ? { q: a.q } : {}),
          },
        }),
      );
      return {
        asOf: r.asOf,
        totals: r.totals,
        items: r.items.map((i) => ({
          item: itemName(i.item),
          quantity: qty(i.amount),
          value: i.value,
          estimatedValue: i.estimatedValue,
          lots: i.lots,
          unvaluedLots: i.unvaluedLots,
        })),
        ...(a.lots
          ? {
              lots: r.lots.map((l) => ({
                item: itemName(l.item),
                lot: l.lotCode,
                status: l.status,
                quantity: qty(l.amount),
                unitCost: l.unitCost,
                per: l.unit,
                value: l.value,
                source: l.source,
                estimatedPercent: l.estimatedPercent,
              })),
            }
          : {}),
      };
    },
  );

  define(
    "costing_write_offs",
    {
      module: "costing",
      title: "Cost of waste and stock adjustments",
      description: `What waste, manual stock adjustments and stocktake differences cost in a period (default the last 6 months), each movement valued at its lot's cost. Cost is a loss when positive and a gain when negative. ${SIGN}`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        from: z.string().max(20).optional().describe("A date, ISO week (2026-W46) or month (2026-11)."),
        to: z.string().max(20).optional().describe("A date, ISO week (2026-W46) or month (2026-11)."),
        product: z.string().max(200).optional().describe("Item id or stock code."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const itemId = a.product ? await resolveItemId(api, slug, a.product) : undefined;
      const r = await api.call(
        costing(api).adjustments.$get({
          param: { slug },
          query: {
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
            ...(itemId ? { itemId } : {}),
          },
        }),
      );
      return {
        from: r.from,
        to: r.to,
        totals: r.totals,
        lines: r.lines.map((l) => ({
          type: l.type,
          item: itemName(l.item),
          quantity: qty(l.amount),
          cost: l.loss,
          movements: l.movements,
        })),
      };
    },
  );
}
