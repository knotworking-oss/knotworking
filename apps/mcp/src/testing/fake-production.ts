import {
  batchFactor,
  batchMaterials,
  batchSizeTarget,
  classifyExpiry,
  demandRange,
  demandWeek,
  generateBatchCode,
  isPickable,
  lotMassBalance,
  materialRequirements,
  materialRequirementsQuerySchema,
  newId,
  planFromDemand,
  planFromDemandQuerySchema,
  plannedOutputBase,
  productionBatchCancelSchema,
  productionBatchCreateSchema,
  productionBatchUpdateSchema,
  productionReleaseSchema,
  productionReserveSchema,
  scheduleLoads,
  lineSequenceSetSchema,
  downtimeRecordSchema,
  downtimeCategory,
  rejectRecordSchema,
  labourRecordSchema,
  oeeDefinitions,
  evaluatePackingCheck,
  packingCheckSchema,
  packingRunOpenSchema,
  deviceReadingsPostSchema,
  planLineDay,
  proposeLineDaySequence,
  productionPlanBatchesSchema,
  roundQuantity,
  stockAmount,
  weeksInRange,
  type ProductionBatchCreateInput,
  type RequirementStock,
} from "@knotworking/core";
import type { Hono } from "hono";

/**
 * In-memory stand-in for the Production module's routes (apps/server/src/routes/production.ts)
 * that the MCP tools use: list, get and plan batches, material requirements and lot tracing.
 * Request bodies are checked with the real schemas from `@knotworking/core`. Tests add batch
 * records with `record()`, which also posts the stock movement, as the API does.
 */
export function mountFakeProduction(
  app: Hono,
  ws: string,
  deps: {
    items: Record<string, any>[];
    recipes: Record<string, any>[];
    stock: {
      locations: Record<string, any>[];
      lots: Record<string, any>[];
      movements: Record<string, any>[];
    };
    /** The fake demand module's own products and its lines (production plans from them). */
    demand: { products: Record<string, any>[]; lines: Record<string, any>[] };
  },
) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const today = "2026-11-11";
  const now = "2026-11-11T09:00:00.000Z";
  const batches: Record<string, any>[] = [];
  const records: Record<string, any>[] = [];
  const reservations: Record<string, any>[] = [];
  /** Lines the tests set up: `{ id, name, active, hoursPerDay, rates: { [recipeId]: perHour } }`. */
  const lines: Record<string, any>[] = [];
  const itemOf = (id: string): any => deps.items.find((i) => i.id === id);
  const summary = (i: Record<string, any>) => ({
    id: i.id,
    code: i.code,
    name: i.name,
    type: i.type,
    unit: i.unit,
    status: i.status,
  });
  const recipeOf = (id: string): any => deps.recipes.find((r) => r.id === id);
  const versionOf = (b: Record<string, any>): any =>
    recipeOf(b.recipeId).versions.find((v: any) => v.id === b.recipeVersionId);
  const onHand = (lotId: string) =>
    roundQuantity(deps.stock.movements.filter((m) => m.lotId === lotId).reduce((s, m) => s + m.quantity, 0));

  const batchView = (b: Record<string, any>) => {
    const recipe = recipeOf(b.recipeId);
    const version = versionOf(b);
    const output = itemOf(b.outputItemId);
    const produced = records
      .filter((r) => r.batchId === b.id && r.kind === "output")
      .reduce((s, r) => s + r.quantity, 0);
    const factor = batchFactor(version, output, b.plannedQuantity);
    return {
      ...b,
      recipe: { id: recipe.id, code: recipe.code, name: recipe.name },
      recipeVersion: { id: version.id, versionNumber: version.versionNumber, status: version.status },
      outputItem: summary(output),
      line: b.lineId ? { id: b.lineId, name: lines.find((l) => l.id === b.lineId)?.name ?? null } : null,
      outputLocation: b.outputLocationId
        ? {
            id: b.outputLocationId,
            name: deps.stock.locations.find((l) => l.id === b.outputLocationId)?.name ?? null,
          }
        : null,
      planned: stockAmount(b.plannedQuantity, output),
      batches: factor === null ? null : roundQuantity(factor),
      produced: stockAmount(produced, output),
    };
  };
  const materialsOf = (b: Record<string, any>) => {
    const version = versionOf(b);
    const factor = batchFactor(version, itemOf(b.outputItemId), b.plannedQuantity) ?? 0;
    return batchMaterials(
      version.lines.map((l: any) => ({ ...l, item: itemOf(l.itemId) })),
      factor,
    );
  };
  const detail = (b: Record<string, any>) => {
    const consumed = (itemId: string) =>
      records
        .filter((r) => r.batchId === b.id && r.kind === "consumption" && r.itemId === itemId)
        .reduce((s, r) => s + r.quantity, 0);
    return {
      ...batchView(b),
      createdByName: "Ada Lovelace",
      startedByName: null,
      completedByName: null,
      cancelledByName: null,
      materials: materialsOf(b).map((m) => {
        const item = itemOf(m.itemId);
        const used = consumed(m.itemId);
        return {
          item: summary(item),
          inRecipe: true,
          lines: [],
          required: m.required === null ? null : stockAmount(m.required, item),
          consumed: stockAmount(used, item),
          outstanding: m.required === null ? null : stockAmount(Math.max(m.required - used, 0), item),
        };
      }),
      outputs: [],
      reservations: reservations
        .filter((r) => r.batchId === b.id)
        .map((r) => {
          const item = itemOf(r.itemId);
          const lot = deps.stock.lots.find((l) => l.id === r.lotId)!;
          const held = r.status === "active" ? r.quantity - r.fulfilledQuantity : 0;
          return {
            ...r,
            item: summary(item),
            lotCode: lot.lotCode,
            reserved: stockAmount(r.quantity, item),
            held: stockAmount(held, item),
          };
        }),
      records: records
        .filter((r) => r.batchId === b.id)
        .map((r) => {
          const lot = deps.stock.lots.find((l) => l.id === r.lotId)!;
          return {
            ...r,
            amount: stockAmount(r.quantity, itemOf(r.itemId)),
            item: summary(itemOf(r.itemId)),
            lotCode: lot.lotCode,
            lotStatus: lot.status,
            locationName: deps.stock.locations.find((l) => l.id === r.locationId)?.name ?? "",
            reversed: false,
          };
        }),
    };
  };

  app.get(`${ws}/production/batches`, (c) => {
    const q = c.req.query();
    const text = q.q?.toLowerCase();
    const found = batches
      .filter(
        (b) =>
          (!q.from || b.plannedOn >= q.from) &&
          (!q.to || b.plannedOn <= q.to) &&
          (!q.status ||
            q.status === "all" ||
            (q.status === "open" ? ["planned", "in_progress"].includes(b.status) : b.status === q.status)) &&
          (!q.recipeId || b.recipeId === q.recipeId) &&
          (!text ||
            b.batchCode.toLowerCase().includes(text) ||
            recipeOf(b.recipeId).code.toLowerCase().includes(text)),
      )
      .sort((a, b) => a.plannedOn.localeCompare(b.plannedOn) || a.batchCode.localeCompare(b.batchCode));
    const limit = Number(q.limit ?? 50);
    const offset = Number(q.offset ?? 0);
    return c.json({
      batches: found.slice(offset, offset + limit).map(batchView),
      total: found.length,
      limit,
      offset,
    });
  });

  app.get(`${ws}/production/batches/:id`, (c) => {
    const batch = batches.find((b) => b.id === c.req.param("id"));
    return batch ? c.json(detail(batch)) : c.json(err("not_found", "Batch not found"), 404);
  });

  type Refusal = { status: 400 | 404 | 409; code: string; message: string };
  /** Checks and builds a batch as the API's create does; `pending` are batches about to be added with it. */
  function buildBatch(
    input: ProductionBatchCreateInput,
    pending: Record<string, any>[] = [],
  ): { batch: Record<string, any> } | { refusal: Refusal } {
    const all = [...batches, ...pending];
    const recipe = recipeOf(input.recipeId);
    if (!recipe) return { refusal: { status: 404, code: "not_found", message: "Recipe not found" } };
    const version = recipe.versions.find((v: any) => v.status === "approved");
    if (recipe.status === "archived" || !version) {
      return {
        refusal: {
          status: 409,
          code: "no_approved_version",
          message: `${recipe.name} has no approved version`,
        },
      };
    }
    const output = itemOf(recipe.outputItemId);
    const plannedQuantity = plannedOutputBase(version, output, batchSizeTarget(input)!);
    if (plannedQuantity === null) {
      return { refusal: { status: 400, code: "unit_not_convertible", message: "Can't size the batch" } };
    }
    const batchCode =
      input.batchCode ??
      generateBatchCode(input.plannedOn, all.filter((b) => b.plannedOn === input.plannedOn).length + 1);
    if (all.some((b) => b.batchCode.toLowerCase() === batchCode.toLowerCase())) {
      return {
        refusal: {
          status: 409,
          code: "code_taken",
          message: `Another batch already uses the code "${batchCode}"`,
        },
      };
    }
    return {
      batch: {
        id: input.id ?? newId(),
        batchCode,
        recipeId: recipe.id,
        recipeVersionId: version.id,
        outputItemId: output.id,
        plannedOn: input.plannedOn,
        plannedQuantity,
        outputLocationId: input.outputLocationId ?? null,
        lineId: input.lineId ?? null,
        status: "planned",
        notes: input.notes ?? null,
        createdBy: null,
        startedAt: null,
        startedBy: null,
        completedAt: null,
        completedBy: null,
        completionNote: null,
        cancelledAt: null,
        cancelledBy: null,
        cancelReason: null,
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  app.post(`${ws}/production/batches`, async (c) => {
    const parsed = productionBatchCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const built = buildBatch(parsed.data);
    if ("refusal" in built)
      return c.json(err(built.refusal.code, built.refusal.message), built.refusal.status);
    batches.push(built.batch);
    return c.json(detail(built.batch), 201);
  });

  app.post(`${ws}/production/batches/:id/cancel`, async (c) => {
    const batch = batches.find((b) => b.id === c.req.param("id"));
    if (!batch) return c.json(err("not_found", "Batch not found"), 404);
    const parsed = productionBatchCancelSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    if (batch.status !== "planned" && batch.status !== "in_progress")
      return c.json(
        err("invalid_batch_status", `Batch ${batch.batchCode} is ${batch.status}; it can't become cancelled`),
        409,
      );
    if (batch.status === "in_progress" && records.some((r) => r.batchId === batch.id && r.kind === "output"))
      return c.json(
        err("batch_has_output", "This batch has output on record; reverse it before cancelling"),
        409,
      );
    Object.assign(batch, { status: "cancelled", cancelledAt: now, cancelReason: parsed.data.reason });
    return c.json(detail(batch));
  });

  app.patch(`${ws}/production/batches/:id`, async (c) => {
    const batch = batches.find((b) => b.id === c.req.param("id"));
    if (!batch) return c.json(err("not_found", "Batch not found"), 404);
    const parsed = productionBatchUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    if (parsed.data.lineId) {
      const line = lines.find((l) => l.id === parsed.data.lineId);
      if (!line) return c.json(err("not_found", "Production line not found"), 404);
      if (!line.active) return c.json(err("line_inactive", `${line.name} is not active`), 409);
    }
    if (parsed.data.lineId !== undefined) batch.lineId = parsed.data.lineId;
    return c.json(detail(batch));
  });

  app.post(`${ws}/production/batches/:id/reservations`, async (c) => {
    const batch = batches.find((b) => b.id === c.req.param("id"));
    if (!batch) return c.json(err("not_found", "Batch not found"), 404);
    const parsed = productionReserveSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    for (const line of parsed.data.lines ?? []) {
      if (!("lotId" in line)) continue;
      const lot = deps.stock.lots.find((l) => l.id === line.lotId);
      if (!lot) return c.json(err("not_found", "Lot not found"), 404);
      const item = itemOf(lot.itemId);
      const quantity =
        line.unit === item.unit ? line.quantity * (item.unit === "kg" ? 1000 : 1) : line.quantity;
      const held = reservations
        .filter((r) => r.lotId === lot.id && r.status === "active")
        .reduce((t, r) => t + r.quantity - r.fulfilledQuantity, 0);
      if (quantity > onHand(lot.id) - held)
        return c.json(err("insufficient_unreserved_stock", "Not enough unreserved stock"), 409);
      reservations.push({
        id: newId(),
        batchId: batch.id,
        itemId: lot.itemId,
        lotId: lot.id,
        quantity,
        fulfilledQuantity: 0,
        status: "active",
        releaseReason: null,
      });
    }
    return c.json({ ...detail(batch), shortfalls: [] }, 201);
  });

  app.post(`${ws}/production/reservations/:id/release`, async (c) => {
    const found = reservations.find((r) => r.id === c.req.param("id"));
    if (!found) return c.json(err("not_found", "Reservation not found"), 404);
    const parsed = productionReleaseSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    if (found.status !== "active")
      return c.json(err("reservation_released", "This reservation has already been released"), 409);
    Object.assign(found, { status: "released", releaseReason: "manual" });
    return c.json(detail(batches.find((b) => b.id === found.batchId)!));
  });

  app.get(`${ws}/production/lines`, (c) =>
    c.json({
      lines: lines.map((l) => ({
        id: l.id,
        name: l.name,
        active: l.active,
        hoursPerDay: l.hoursPerDay,
        notes: null,
        recipes: Object.entries(l.rates).map(([recipeId, rate]) => ({
          recipeId,
          recipeCode: recipeOf(recipeId).code,
          recipeName: recipeOf(recipeId).name,
          ratePerHour: stockAmount(rate as number, itemOf(recipeOf(recipeId).outputItemId)),
        })),
      })),
    }),
  );

  app.get(`${ws}/production/schedule`, (c) => {
    const { from, to } = c.req.query();
    if (!from || !to) return c.json(err("invalid_input", "from and to are required"), 400);
    const days: string[] = [];
    for (
      let d = new Date(`${from}T00:00:00Z`);
      d <= new Date(`${to}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1)
    )
      days.push(d.toISOString().slice(0, 10));
    const inRange = batches.filter((b) => b.plannedOn >= from && b.plannedOn <= to);
    const loads = scheduleLoads(
      lines.map((l) => ({ id: l.id, hoursPerDay: l.hoursPerDay, rates: l.rates })),
      inRange as any,
      days,
    );
    return c.json({
      from,
      to,
      days,
      lines: lines.map((l) => ({
        id: l.id,
        name: l.name,
        active: l.active,
        hoursPerDay: l.hoursPerDay,
        days: loads[l.id]!.map((d) => ({
          ...d,
          batches: d.batches.map((b) => ({
            ...b,
            id: b.batchId,
            batchCode: batches.find((x) => x.id === b.batchId)!.batchCode,
          })),
        })),
        totalHours: loads[l.id]!.reduce((t, d) => t + d.hours, 0),
        overloadedDays: loads[l.id]!.filter((d) => d.overloaded).length,
      })),
      unassigned: inRange
        .filter((b) => !b.lineId && ["planned", "in_progress"].includes(b.status))
        .map((b) => ({ id: b.id, batchCode: b.batchCode, plannedOn: b.plannedOn, hours: null })),
    });
  });

  // Detailed scheduling: no shifts or changeover rules in the fake, so times run from 06:00.
  const dayPlan = (lineId: string, date: string) => {
    const line = lines.find((l) => l.id === lineId)!;
    const onDay = batches
      .filter((b) => b.lineId === lineId && b.plannedOn === date && b.status !== "cancelled")
      .sort((x, y) => (x.sequence ?? 1e9) - (y.sequence ?? 1e9) || x.batchCode.localeCompare(y.batchCode));
    const planLine = {
      id: line.id,
      name: line.name,
      hoursPerDay: line.hoursPerDay,
      shifts: [],
      changeoverMinutes: 0,
      allergenCleanMinutes: 0,
      crewAvailable: null,
      changeovers: [],
    };
    const planBatches = onDay.map((b) => {
      const rate = line.rates[b.recipeId] as number | undefined;
      return {
        id: b.id,
        batchCode: b.batchCode,
        recipeId: b.recipeId,
        status: b.status,
        runMinutes: rate ? Math.round((b.plannedQuantity / rate) * 60) : null,
        crew: null,
        contains: [],
        mayContain: [],
      };
    });
    return {
      line: { id: line.id, name: line.name },
      ...planLineDay(planLine, date, null, planBatches),
      proposal: proposeLineDaySequence(planLine, date, null, planBatches),
    };
  };
  app.get(`${ws}/production/schedule/day`, (c) => {
    const { lineId, date } = c.req.query();
    if (!lines.some((l) => l.id === lineId))
      return c.json(err("not_found", "Production line not found"), 404);
    return c.json(dayPlan(lineId!, date!));
  });
  app.put(`${ws}/production/schedule/sequence`, async (c) => {
    const parsed = lineSequenceSetSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const { lineId, date, batchIds } = parsed.data;
    if (!lines.some((l) => l.id === lineId))
      return c.json(err("not_found", "Production line not found"), 404);
    const live = batches.filter(
      (b) => b.lineId === lineId && b.plannedOn === date && b.status !== "cancelled",
    );
    if (live.length !== batchIds.length || live.some((b) => !batchIds.includes(b.id)))
      return c.json(err("sequence_stale", "The batches on this line and day have changed"), 409);
    for (const [i, id] of batchIds.entries()) batches.find((b) => b.id === id)!.sequence = i + 1;
    return c.json(dayPlan(lineId, date));
  });
  app.get(`${ws}/production/daily-demand`, (c) =>
    c.json({
      from: today,
      to: today,
      days: [today],
      basis: { salesCommitments: false, stock: true, weeklyDemand: true, weeklyDemandCombined: false },
      items: [],
      shortItems: 0,
    }),
  );

  // Factory performance: records are kept in memory; the report carries only the definitions.
  const downtime: Record<string, any>[] = [];
  app.post(`${ws}/production/downtime`, async (c) => {
    const parsed = downtimeRecordSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    if (!lines.some((l) => l.id === parsed.data.lineId))
      return c.json(err("not_found", "Production line not found"), 404);
    if (parsed.data.batchId) {
      const batch = batches.find((b) => b.id === parsed.data.batchId);
      if (!batch) return c.json(err("not_found", "Batch not found"), 404);
      if (batch.lineId !== parsed.data.lineId)
        return c.json(err("invalid_input", `Batch ${batch.batchCode} is not on this line`), 400);
    }
    const row = { id: newId(), ...parsed.data, category: downtimeCategory(parsed.data.reason) };
    downtime.push(row);
    return c.json(row, 201);
  });
  const recordable = (id: string) => {
    const batch = batches.find((b) => b.id === id);
    if (!batch) return { error: err("not_found", "Batch not found"), status: 404 as const };
    if (batch.status !== "in_progress" && batch.status !== "completed")
      return {
        error: err("batch_not_running", `Batch ${batch.batchCode} is ${batch.status}: start it first`),
        status: 409 as const,
      };
    return { batch };
  };
  app.post(`${ws}/production/batches/:id/rejects`, async (c) => {
    const parsed = rejectRecordSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const r = recordable(c.req.param("id"));
    if ("error" in r) return c.json(r.error, r.status);
    return c.json({ id: newId(), batchId: r.batch.id, ...parsed.data }, 201);
  });
  app.post(`${ws}/production/batches/:id/labour`, async (c) => {
    const parsed = labourRecordSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const r = recordable(c.req.param("id"));
    if ("error" in r) return c.json(r.error, r.status);
    return c.json({ id: newId(), batchId: r.batch.id, ...parsed.data }, 201);
  });
  app.get(`${ws}/production/performance`, (c) => {
    const { from, to } = c.req.query();
    return c.json({
      from,
      to,
      days: [],
      definitions: oeeDefinitions,
      costBasis: null,
      lines: [],
      batchesWithOutput: [],
    });
  });

  // Packing: runs and checks in memory, evaluated by the real rules.
  const packingRuns: Record<string, any>[] = [];
  const packingView = (batchId: string) => {
    const runs = packingRuns.filter((r) => r.batchId === batchId);
    return {
      batchId,
      open: runs.find((r) => r.status === "open") ?? null,
      runs,
      candidates: {
        labels: [],
        specifications: [],
        defaultLotCode: batches.find((b) => b.id === batchId)?.batchCode,
      },
    };
  };
  app.get(`${ws}/production/batches/:id/packing`, (c) => c.json(packingView(c.req.param("id"))));
  app.post(`${ws}/production/batches/:id/packing`, async (c) => {
    const parsed = packingRunOpenSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const batch = batches.find((b) => b.id === c.req.param("id"));
    if (!batch) return c.json(err("not_found", "Batch not found"), 404);
    if (batch.status !== "in_progress")
      return c.json(err("batch_not_running", `Batch ${batch.batchCode} is ${batch.status}`), 409);
    if (packingRuns.some((r) => r.batchId === batch.id && r.status === "open"))
      return c.json(err("packing_run_open", "This batch already has an open packing run"), 409);
    packingRuns.push({
      id: newId(),
      batchId: batch.id,
      status: "open",
      ...parsed.data,
      nominalQuantity: parsed.data.nominalQuantity ?? null,
      expectedLotCode: parsed.data.expectedLotCode ?? batch.batchCode,
      checks: [],
    });
    return c.json(packingView(batch.id), 201);
  });
  app.post(`${ws}/production/packing/:id/checks`, async (c) => {
    const run = packingRuns.find((r) => r.id === c.req.param("id"));
    if (!run) return c.json(err("not_found", "Packing run not found"), 404);
    if (run.status !== "open") return c.json(err("packing_run_closed", "This packing run is closed"), 409);
    const parsed = packingCheckSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    if (parsed.data.kind === "weight_sample" && run.nominalQuantity === null)
      return c.json(err("no_nominal_quantity", "This run has no nominal quantity to weigh against"), 409);
    const outcome = evaluatePackingCheck(parsed.data, run as any);
    if (!outcome.passed && !parsed.data.failureAction)
      return c.json(err("failure_action_required", outcome.reasons.join("; ")), 400);
    run.checks.push({
      id: newId(),
      kind: parsed.data.kind,
      passed: outcome.passed,
      reasons: outcome.reasons,
    });
    return c.json(packingView(run.batchId), 201);
  });
  // Devices: one in-memory registry; readings deduplicated by reading id as the API does.
  const devices: Record<string, any>[] = [];
  const deviceReadings: Record<string, any>[] = [];
  app.get(`${ws}/production/devices`, (c) => c.json({ devices }));
  app.post(`${ws}/production/devices/:id/readings`, async (c) => {
    const device = devices.find((d) => d.id === c.req.param("id"));
    if (!device) return c.json(err("not_found", "Device not found"), 404);
    const parsed = deviceReadingsPostSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const results = parsed.data.readings.map((r) => {
      const prior = deviceReadings.find((x) => x.deviceId === device.id && x.readingId === r.readingId);
      if (prior)
        return {
          readingId: r.readingId,
          // As the API: same value, unit and time is a duplicate; anything else a conflict.
          outcome:
            prior.value === r.value &&
            prior.unit === r.unit &&
            +new Date(prior.takenAt) === +new Date(r.takenAt)
              ? "duplicate"
              : "conflict",
        };
      const row = { id: newId(), deviceId: device.id, ...r };
      deviceReadings.push(row);
      return { readingId: r.readingId, outcome: "accepted", id: row.id };
    });
    const count = (o: string) => results.filter((r) => r.outcome === o).length;
    return c.json({
      deviceId: device.id,
      accepted: count("accepted"),
      duplicate: count("duplicate"),
      conflict: count("conflict"),
      rejected: 0,
      results,
    });
  });

  app.get(`${ws}/production/devices/:id/readings`, (c) => {
    const device = devices.find((d) => d.id === c.req.param("id"));
    if (!device) return c.json(err("not_found", "Device not found"), 404);
    return c.json({ device, readings: deviceReadings.filter((r) => r.deviceId === device.id).reverse() });
  });

  app.get(`${ws}/production/lots/:lotId/packing`, (c) =>
    c.json({ lotId: c.req.param("lotId"), lotCode: null, batches: [] }),
  );

  app.get(`${ws}/production/plan-from-demand`, (c) => {
    const parsed = planFromDemandQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const range = demandRange(parsed.data, today);
    if (!range) return c.json(err("invalid_input", "Choose a shorter range"), 400);
    const weeks = weeksInRange(range.from, range.to);
    const demandItemOf = (id: string): any =>
      [...deps.demand.products, ...deps.items].find((i) => i.id === id);
    const live = deps.demand.lines
      .filter((l) => !l.deletedAt && l.periodStart >= range.from && l.periodStart <= range.to)
      .sort((a, b) => demandItemOf(a.itemId).code.localeCompare(demandItemOf(b.itemId).code));
    const itemIds = [...new Set(live.map((l) => l.itemId))];
    const items = new Map(itemIds.map((id) => [id, demandItemOf(id)]));
    const recipeRows = [...deps.recipes]
      .filter((r) => itemIds.includes(r.outputItemId))
      .sort((a, b) => a.code.localeCompare(b.code));
    const choices: Record<string, string> = {};
    for (const id of parsed.data.recipeIds) {
      const chosen = recipeRows.find((r) => r.id === id);
      if (chosen) choices[chosen.outputItemId] = id;
    }
    const approvedOf = (r: any) => r.versions.find((v: any) => v.status === "approved") ?? null;
    const rows = planFromDemand({
      weeks,
      items,
      demand: live as { itemId: string; periodStart: string; quantity: number }[],
      batches: batches.map((b) => ({
        id: b.id,
        itemId: b.outputItemId,
        plannedOn: b.plannedOn,
        status: b.status,
        planned: b.plannedQuantity,
        produced: records
          .filter((r) => r.batchId === b.id && r.kind === "output")
          .reduce((s, r) => s + r.quantity, 0),
      })),
      recipes: recipeRows.map((r) => ({
        id: r.id,
        outputItemId: r.outputItemId,
        status: r.status,
        approvedVersion: approvedOf(r),
      })),
      choices,
    });
    const recipeView = (id: string, item: any) => {
      const r = recipeRows.find((x) => x.id === id)!;
      const version = approvedOf(r);
      const perBatch = version ? plannedOutputBase(version, item, { batches: 1 }) : null;
      return {
        id: r.id,
        code: r.code,
        name: r.name,
        version: version ? { id: version.id, versionNumber: version.versionNumber } : null,
        perBatch: perBatch ? stockAmount(perBatch, item) : null,
      };
    };
    return c.json({
      from: range.from,
      to: range.to,
      weeks: weeks.map(demandWeek),
      rows: rows.map((row) => {
        const item = items.get(row.itemId)!;
        const amount = (q: number) => stockAmount(q, item);
        return {
          item: summary(item),
          recipe: row.recipeId ? recipeView(row.recipeId, item) : null,
          options: row.optionIds.map((id) => recipeView(id, item)),
          issue: row.issue,
          perBatch: row.perBatch === null ? null : amount(row.perBatch),
          cells: row.cells.map((cell) => ({
            ...demandWeek(cell.periodStart),
            demand: amount(cell.demand),
            planned: amount(cell.planned),
            gap: amount(cell.gap),
            suggestedBatches: cell.suggestedBatches,
            suggestedOutput: amount(cell.suggestedOutput),
            batches: cell.batchIds.map((id) => {
              const b: Record<string, any> = batchView(batches.find((x) => x.id === id)!);
              return {
                id: b.id,
                batchCode: b.batchCode,
                status: b.status,
                plannedOn: b.plannedOn,
                recipe: b.recipe,
                planned: b.planned,
                produced: b.produced,
              };
            }),
          })),
          totals: {
            demand: amount(row.totals.demand),
            planned: amount(row.totals.planned),
            gap: amount(row.totals.gap),
            suggestedBatches: row.totals.suggestedBatches,
            suggestedOutput: amount(row.totals.suggestedOutput),
          },
        };
      }),
    });
  });

  app.post(`${ws}/production/plan-from-demand`, async (c) => {
    const parsed = productionPlanBatchesSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const pending: Record<string, any>[] = [];
    for (const [index, input] of parsed.data.batches.entries()) {
      const built = buildBatch(input, pending);
      if ("refusal" in built) {
        return c.json(
          {
            error: {
              code: built.refusal.code,
              message: `Batch ${index + 1} (${input.plannedOn}): ${built.refusal.message}. Nothing was planned.`,
              details: { index },
            },
          },
          built.refusal.status,
        );
      }
      pending.push(built.batch);
    }
    batches.push(...pending);
    return c.json({ batches: pending.map(batchView) }, 201);
  });

  app.get(`${ws}/production/requirements`, (c) => {
    const parsed = materialRequirementsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const { from, to } = parsed.data;
    const open = batches
      .filter(
        (b) => ["planned", "in_progress"].includes(b.status) && b.plannedOn >= from && b.plannedOn <= to,
      )
      .sort((a, b) => a.plannedOn.localeCompare(b.plannedOn));
    const stock: Record<string, RequirementStock> = {};
    for (const lot of deps.stock.lots) {
      const quantity = onHand(lot.id);
      const s = (stock[lot.itemId] ??= { available: 0, quarantine: 0 });
      if (isPickable({ ...lot, quantity } as never, today)) s.available += quantity;
      else if (lot.status === "quarantine") s.quarantine += quantity;
    }
    const rows = materialRequirements(
      open.map((b) => ({ ...b, batchId: b.id, materials: materialsOf(b) })) as never,
      stock,
    );
    const amount = (q: number | null, item: any) => (q === null ? null : stockAmount(q, item));
    return c.json({
      from,
      to,
      batches: open.map(batchView),
      requirements: rows.map((r) => {
        const item = itemOf(r.itemId);
        return {
          ...r,
          item: summary(item),
          required: stockAmount(r.required, item),
          consumed: stockAmount(r.consumed, item),
          outstanding: stockAmount(r.outstanding, item),
          available: stockAmount(r.available, item),
          quarantine: stockAmount(r.quarantine, item),
          shortfall: stockAmount(r.shortfall, item),
          batches: r.batches.map((b) => ({
            ...b,
            required: amount(b.required, item),
            outstanding: amount(b.outstanding, item),
          })),
        };
      }),
    });
  });

  app.get(`${ws}/production/lots/:lotId/trace`, (c) => {
    const lot = deps.stock.lots.find((l) => l.id === c.req.param("lotId"));
    if (!lot) return c.json(err("not_found", "Lot not found"), 404);
    const depth = Number(c.req.query("depth") ?? 10);
    const item = itemOf(lot.itemId);
    const lotView = (id: string) => {
      const l = deps.stock.lots.find((x) => x.id === id)!;
      return {
        id: l.id,
        lotCode: l.lotCode,
        item: summary(itemOf(l.itemId)),
        status: l.status,
        expiresOn: l.expiresOn,
        expiryType: l.expiryType,
        expiryState: classifyExpiry(l.expiresOn, today),
        supplierName: null,
        supplierLotCode: l.supplierLotCode ?? null,
        onHand: stockAmount(onHand(l.id), itemOf(l.itemId)),
      };
    };
    const edge = (r: Record<string, any>) => ({
      lot: lotView(r.lotId),
      amount: stockAmount(r.quantity, itemOf(r.itemId)),
    });
    const batchRef = (id: string) => {
      const b = batches.find((x) => x.id === id)!;
      return {
        id: b.id,
        batchCode: b.batchCode,
        status: b.status,
        plannedOn: b.plannedOn,
        completedAt: b.completedAt,
        recipe: { id: b.recipeId, code: recipeOf(b.recipeId).code, name: recipeOf(b.recipeId).name },
        recipeVersion: { id: b.recipeVersionId, versionNumber: versionOf(b).versionNumber },
      };
    };
    const walk = (from: "consumption" | "output") => {
      const to = from === "consumption" ? "output" : "consumption";
      const steps: Record<string, any>[] = [];
      let frontier = [lot.id];
      const seen = new Set<string>();
      for (let level = 1; level <= depth && frontier.length; level++) {
        const hits = records.filter(
          (r) => r.kind === from && frontier.includes(r.lotId) && !seen.has(r.batchId),
        );
        const next: string[] = [];
        for (const hit of hits) {
          const others = records.filter((r) => r.batchId === hit.batchId && r.kind === to);
          steps.push(
            from === "consumption"
              ? { depth: level, batch: batchRef(hit.batchId), consumed: edge(hit), outputs: others.map(edge) }
              : { depth: level, batch: batchRef(hit.batchId), produced: edge(hit), inputs: others.map(edge) },
          );
          next.push(...others.map((o) => o.lotId));
        }
        hits.forEach((h) => seen.add(h.batchId));
        frontier = next;
      }
      return steps;
    };
    const balance = lotMassBalance(deps.stock.movements.filter((m) => m.lotId === lot.id) as never);
    return c.json({
      lot: {
        id: lot.id,
        lotCode: lot.lotCode,
        item: summary(item),
        status: lot.status,
        expiresOn: lot.expiresOn,
        expiryType: lot.expiryType,
      },
      massBalance: Object.fromEntries(
        Object.entries(balance).map(([k, v]) => [
          k,
          k === "adjustedPercent" ? v : stockAmount(v as number, item),
        ]),
      ),
      forward: walk("consumption"),
      backward: walk("output"),
    });
  });

  /** Posts a batch record and its stock movement, as recording consumption or output does. */
  function record(batchId: string, kind: "consumption" | "output", lotId: string, quantity: number) {
    const lot = deps.stock.lots.find((l) => l.id === lotId)!;
    const locationId = deps.stock.locations[0]!.id;
    const movementId = newId();
    deps.stock.movements.push({
      id: movementId,
      lotId,
      itemId: lot.itemId,
      locationId,
      quantity: kind === "consumption" ? -quantity : quantity,
      type: kind === "consumption" ? "consumption" : "production",
      transferId: null,
      reversesMovementId: null,
      reason: null,
      reference: batches.find((b) => b.id === batchId)?.batchCode ?? null,
      actorId: null,
      occurredAt: now,
      createdAt: now,
    });
    const row = {
      id: newId(),
      batchId,
      kind,
      itemId: lot.itemId,
      lotId,
      locationId,
      quantity,
      movementId,
      reversesRecordId: null,
      note: null,
      actorId: null,
      occurredAt: now,
      createdAt: now,
    };
    records.push(row);
    return row;
  }

  return { batches, records, record, reservations, lines, devices };
}
