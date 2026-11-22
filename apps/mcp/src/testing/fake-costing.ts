import type { Hono } from "hono";

/**
 * In-memory stand-in for the Costing module's routes (apps/server/src/routes/costing.ts). Costing
 * is read-only and computed by the server, so the fake serves canned results (tests may replace
 * them through `state`) and records the queries it was asked.
 */
export function mountFakeCosting(app: Hono, ws: string) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const dough = {
    id: "0190a000-0000-7000-8000-00000000d001",
    code: "DGH-1",
    name: "Dough",
    type: "wip",
    unit: "kg",
    status: "active",
  };
  const flour = {
    id: "0190a000-0000-7000-8000-00000000f001",
    code: "FLR-001",
    name: "Flour",
    type: "ingredient",
    unit: "kg",
    status: "active",
  };
  const amount = (base: number, unit: string, displayUnit: string, factor: number) => ({
    base,
    baseUnit: unit,
    display: base / factor,
    displayUnit,
  });
  const batch = {
    id: "0190a000-0000-7000-8000-00000000b001",
    batchCode: "B261110-001",
    status: "completed",
    plannedOn: "2026-11-10",
    completedAt: "2026-11-10T16:00:00.000Z",
    completedOn: "2026-11-10",
    recipe: { id: "0190a000-0000-7000-8000-00000000c001", code: "R-DGH", name: "Dough" },
    recipeVersion: {
      id: "0190a000-0000-7000-8000-00000000c002",
      versionNumber: 2,
      status: "approved",
      yieldQuantity: 10,
      yieldUnit: "kg",
    },
    outputItem: dough,
  };
  const variance = { price: 1.7, usage: 0.5, yield: 0.55, quantity: 1.05, total: 2.75 };
  const detail = {
    batch,
    batchId: batch.id,
    status: "completed",
    outputUnit: "kg",
    lines: [
      {
        lotId: "0190a000-0000-7000-8000-00000000a001",
        itemId: flour.id,
        source: "purchase",
        unitCost: 0.9,
        unit: "kg",
        estimated: false,
        estimatedPercent: 0,
        provisional: false,
        complete: true,
        missingItemCodes: [],
        batchId: null,
        reason: null,
        quantity: amount(6000, "g", "kg", 1000),
        cost: 5.4,
        standardUnitCost: 0.8,
        lotCode: "FL-01",
        item: flour,
        sourceBatch: null,
      },
      {
        lotId: "0190a000-0000-7000-8000-00000000a002",
        itemId: "0190a000-0000-7000-8000-00000000f002",
        source: "standard",
        unitCost: 1.2,
        unit: "kg",
        estimated: true,
        estimatedPercent: 100,
        provisional: false,
        complete: true,
        missingItemCodes: [],
        batchId: null,
        reason: "not_purchased",
        quantity: amount(1000, "g", "kg", 1000),
        cost: 1.2,
        standardUnitCost: 1.2,
        lotCode: "SUG-OPEN",
        item: { ...flour, id: "0190a000-0000-7000-8000-00000000f002", code: "SUG-001", name: "Sugar" },
        sourceBatch: null,
      },
    ],
    materials: [
      {
        itemId: flour.id,
        item: flour,
        inRecipe: true,
        required: amount(6000, "g", "kg", 1000),
        consumed: amount(6000, "g", "kg", 1000),
        actualCost: 5.4,
        standardUnitCost: 0.8,
        priceVariance: 0.6,
        usageVariance: 0,
      },
    ],
    actualCost: 13.2,
    estimatedCost: 1.2,
    estimatedPercent: 9.1,
    costComplete: true,
    missingItemCodes: [],
    provisional: false,
    planned: amount(10_000, "g", "kg", 1000),
    produced: amount(9500, "g", "kg", 1000),
    costPerUnit: 1.38947368,
    yield: { difference: amount(-500, "g", "kg", 1000), percent: 95 },
    standard: {
      costPerUnit: 1.1,
      plannedCost: 11,
      producedCost: 10.45,
      inputsAtStandard: 11.5,
      complete: true,
      missingItemCodes: [],
    },
    variance,
    variancePercent: 26.3,
  };
  const totals = {
    batches: 1,
    incompleteBatches: 0,
    actualCost: 13.2,
    estimatedCost: 1.2,
    estimatedPercent: 9.1,
    standardCost: 10.45,
    comparedActualCost: 13.2,
    variance,
    variancePercent: 26.3,
  };
  const state = {
    batches: [detail] as (typeof detail)[],
    /** The last `GET /costing/report` and `GET /costing/batches` queries. */
    reportQueries: [] as Record<string, string>[],
    valuationQueries: [] as Record<string, string>[],
    adjustmentQueries: [] as Record<string, string>[],
    listQueries: [] as Record<string, string>[],
  };

  app.get(`${ws}/costing/batches`, (c) => {
    const q = c.req.query();
    state.listQueries.push(q);
    const status = q.status ?? "completed";
    const rows = state.batches.filter(
      (d) =>
        (status === "all" || d.batch.status === status) &&
        (!q.outputItemId || d.batch.outputItem.id === q.outputItemId) &&
        (!q.q || d.batch.batchCode.toLowerCase().includes(q.q.toLowerCase())),
    );
    const offset = Number(q.offset ?? 0);
    const limit = Number(q.limit ?? 25);
    return c.json({
      batches: rows.slice(offset, offset + limit).map((d) => ({
        ...d.batch,
        costingDate: d.batch.completedOn ?? d.batch.plannedOn,
        cost: {
          actualCost: d.actualCost,
          estimatedPercent: d.estimatedPercent,
          costComplete: d.costComplete,
          provisional: d.provisional,
          planned: d.planned,
          produced: d.produced,
          yieldPercent: d.yield.percent,
          costPerUnit: d.costPerUnit,
          standardCostPerUnit: d.standard.costPerUnit,
          standardCost: d.standard.producedCost,
          variance: d.variance.total,
          variancePercent: d.variancePercent,
        },
      })),
      total: rows.length,
      limit,
      offset,
    });
  });

  app.get(`${ws}/costing/batches/:id`, (c) => {
    const found = state.batches.find((d) => d.batch.id === c.req.param("id"));
    return found ? c.json(found) : c.json(err("not_found", "Batch not found"), 404);
  });

  app.get(`${ws}/costing/report`, (c) => {
    const q = c.req.query();
    state.reportQueries.push(q);
    if (q.from === "soon")
      return c.json(err("invalid_input", `"soon" is not a date, week (2026-W46) or month (2026-11)`), 400);
    return c.json({
      period: q.period ?? "month",
      from: "2026-06-01",
      to: "2026-11-30",
      periods: [{ periodStart: "2026-11-01", period: "2026-11", totals }],
      rows: [
        {
          ...totals,
          itemId: dough.id,
          item: dough,
          periodStart: "2026-11-01",
          period: "2026-11",
          planned: detail.planned,
          produced: detail.produced,
          costPerUnit: 1.38947368,
          standardCostPerUnit: 1.1,
          yieldPercent: 95,
        },
      ],
      totals,
    });
  });

  app.get(`${ws}/costing/valuation`, (c) => {
    state.valuationQueries.push(c.req.query());
    return c.json({
      asOf: "2026-11-14",
      totals: {
        lots: 1,
        value: 22.5,
        estimatedValue: 0,
        unvaluedLots: 0,
        byStatus: { available: 22.5, quarantine: 0, rejected: 0 },
      },
      items: [
        {
          itemId: flour.id,
          item: flour,
          amount: amount(25000, "g", "kg", 1000),
          quantity: 25000,
          lots: 1,
          value: 22.5,
          estimatedValue: 0,
          unvaluedLots: 0,
          unvaluedQuantity: 0,
        },
      ],
      lots: [
        {
          lotId: "0190a000-0000-7000-8000-00000000a001",
          lotCode: "FLR-L1",
          itemId: flour.id,
          item: flour,
          status: "available",
          receivedOn: "2026-11-01",
          expiresOn: null,
          quantity: 25000,
          amount: amount(25000, "g", "kg", 1000),
          value: 22.5,
          estimatedValue: 0,
          unitCost: 0.9,
          unit: "kg",
          source: "purchase",
          estimatedPercent: 0,
          provisional: false,
        },
      ],
    });
  });
  app.get(`${ws}/costing/adjustments`, (c) => {
    state.adjustmentQueries.push(c.req.query());
    return c.json({
      from: "2026-06-01",
      to: "2026-11-30",
      totals: { waste: 1.8, adjustment: 0, stocktake: 0, total: 1.8, incomplete: false, movements: 1 },
      lines: [
        {
          type: "waste",
          itemId: flour.id,
          item: flour,
          quantity: -2000,
          amount: amount(-2000, "g", "kg", 1000),
          unvaluedAmount: amount(0, "g", "kg", 1000),
          loss: 1.8,
          unvaluedQuantity: 0,
          movements: 1,
        },
      ],
    });
  });

  return { state, detail };
}
