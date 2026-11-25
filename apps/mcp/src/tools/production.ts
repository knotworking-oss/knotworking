import {
  deviceUnits,
  downtimeReasons,
  MAX_TRACE_DEPTH,
  packingCheckSchema,
  PLAN_FROM_DEMAND_MAX_BATCHES,
  planIssueLabels,
  productionBatchStatuses,
  rejectReasons,
  unitCodes,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERSON_ONLY =
  "Starting a batch, recording what it consumed and produced, corrections and completing (the sign-off) are done by people in the app; there are no tools for them. Cancelling a batch is too, unless an owner or admin allows it under Settings → API access (cancel_production_batch then appears).";

/**
 * Production module: the batch schedule, material requirements and lot tracing. Agents read and
 * plan; batch records and the completion sign-off are people's. Quantities come back as
 * `{ base, baseUnit, display, displayUnit }`.
 */
export function registerProductionTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];

  /** A recipe by id or exact code (case-insensitive). */
  async function resolveRecipeId(api: Api, slug: string, ref: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { recipes } = await api.call(
      ws(api).recipes.$get({ param: { slug }, query: { q: wanted, status: "all", limit: "200" } }),
    );
    const match = recipes.filter((r) => r.code.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      "not_found",
      `No recipe has the code "${wanted}". Use list_recipes to find it, then pass its id or exact code.`,
    );
  }

  /** A location by id, code or exact name (case-insensitive). */
  async function resolveLocationId(api: Api, slug: string, ref: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { locations } = await api.call(
      ws(api).stock.locations.$get({ param: { slug }, query: { status: "active" } }),
    );
    const lower = wanted.toLowerCase();
    const byCode = locations.filter((l) => l.code?.toLowerCase() === lower);
    const match = byCode.length ? byCode : locations.filter((l) => l.name.toLowerCase() === lower);
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      match.length ? "ambiguous" : "not_found",
      match.length
        ? `More than one location is called "${wanted}"; pass its id.`
        : `No active location is called "${wanted}". Locations: ${locations.map((l) => (l.code ? `${l.name} (${l.code})` : l.name)).join(", ") || "none yet"}.`,
    );
  }

  /** An item by id or exact stock code (case-insensitive). */
  async function resolveItemId(api: Api, slug: string, ref: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { items } = await api.call(
      ws(api).items.$get({ param: { slug }, query: { q: wanted, limit: "200" } }),
    );
    const match = items.filter((i) => i.code.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError("not_found", `No item has the stock code "${wanted}". Use list_items to find it.`);
  }

  /** A batch by id or exact batch code (case-insensitive). */
  async function resolveBatchId(api: Api, slug: string, ref: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { batches } = await api.call(
      ws(api).production.batches.$get({ param: { slug }, query: { q: wanted, limit: "200" } }),
    );
    const match = batches.filter((b) => b.batchCode.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      "not_found",
      `No batch has the code "${wanted}". Use list_production_batches to find it.`,
    );
  }

  /** A lot by id, or by lot code (exact, case-insensitive; pass the item when codes repeat). */
  async function resolveLotId(api: Api, slug: string, ref: string, item?: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { lots } = await api.call(
      ws(api).stock.lots.$get({
        param: { slug },
        query: { q: wanted, includeEmpty: "true", limit: "200" },
      }),
    );
    const lower = item?.trim().toLowerCase();
    const match = lots.filter(
      (l) =>
        l.lotCode.toLowerCase() === wanted.toLowerCase() &&
        (!lower || l.item.id === item!.trim() || l.item.code.toLowerCase() === lower),
    );
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      match.length ? "ambiguous" : "not_found",
      match.length
        ? `Several items have a lot "${wanted}"; pass \`item\` or the lot id.`
        : `No lot has the code "${wanted}". Use list_stock_lots to find it.`,
    );
  }

  /** A production line by id or exact name (case-insensitive). */
  async function resolveLineId(api: Api, slug: string, ref: string): Promise<string> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { lines } = await api.call(ws(api).production.lines.$get({ param: { slug } }));
    const match = lines.filter((l) => l.name.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      "not_found",
      `No production line is called "${wanted}". Lines: ${lines.map((l) => l.name).join(", ") || "none yet"}.`,
    );
  }

  type BatchSummary = Awaited<ReturnType<typeof listBatches>>["batches"][number];
  const listBatches = (api: Api, slug: string, query: Record<string, string>) =>
    api.call(ws(api).production.batches.$get({ param: { slug }, query }));
  const summaryView = (b: BatchSummary) => ({
    id: b.id,
    batchCode: b.batchCode,
    plannedOn: b.plannedOn,
    status: b.status,
    recipe: b.recipe,
    recipeVersion: b.recipeVersion,
    outputItem: { id: b.outputItem.id, code: b.outputItem.code, name: b.outputItem.name },
    batches: b.batches,
    planned: b.planned,
    produced: b.produced,
    outputLocation: b.outputLocation?.name ?? null,
    line: b.line?.name ?? null,
    notes: b.notes,
  });

  type BatchDetail = Awaited<ReturnType<typeof getBatch>>;
  const getBatch = (api: Api, slug: string, id: string) =>
    api.call(ws(api).production.batches[":id"].$get({ param: { slug, id } }));
  const detailView = (b: BatchDetail) => ({
    ...summaryView(b),
    createdBy: b.createdByName,
    started: b.startedAt ? { at: b.startedAt, by: b.startedByName } : null,
    completed: b.completedAt ? { at: b.completedAt, by: b.completedByName, note: b.completionNote } : null,
    cancelled: b.cancelledAt ? { at: b.cancelledAt, by: b.cancelledByName, reason: b.cancelReason } : null,
    materials: b.materials.map((m) => ({
      item: { id: m.item.id, code: m.item.code, name: m.item.name },
      required: m.required,
      consumed: m.consumed,
      outstanding: m.outstanding,
      reserved: m.reserved,
      ...(m.inRecipe ? {} : { notInRecipe: true }),
    })),
    reservations: b.reservations.map((r) => ({
      id: r.id,
      item: r.item.code,
      lotId: r.lotId,
      lotCode: r.lotCode,
      reserved: r.reserved,
      held: r.held,
      status: r.status,
      ...(r.releaseReason ? { releasedBecause: r.releaseReason } : {}),
    })),
    ...(b.lineCheck ? { lineCheck: b.lineCheck } : {}),
    outputs: b.outputs,
    records: b.records.map((r) => ({
      id: r.id,
      kind: r.kind,
      item: r.item.code,
      lotId: r.lotId,
      lotCode: r.lotCode,
      location: r.locationName,
      amount: r.amount,
      at: r.occurredAt,
      by: r.actorName,
      ...(r.note ? { note: r.note } : {}),
      ...(r.reversesRecordId ? { reversesRecordId: r.reversesRecordId } : {}),
      ...(r.reversed ? { reversed: true } : {}),
    })),
  });

  const page = (offset: number, returned: number, total: number) => ({
    total,
    offset,
    returned,
    hasMore: offset + returned < total,
  });

  define(
    "list_production_batches",
    {
      module: "production",
      resource: { name: "production_batches", op: "list" },
      title: "List production batches",
      description:
        "The production schedule: batches in planned-date order with recipe, the approved recipe version each is made to, output item, size (number of batches and planned output), what has been produced and status (planned, in_progress, completed, cancelled). Filter by `from` / `to` (planned date, inclusive), `status` (`open` = planned or in progress), `recipe` (id or code) and `query` (batch or recipe code or name). Paged with `offset` while `hasMore` is true.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        from: z.iso.date().optional().describe("YYYY-MM-DD."),
        to: z.iso.date().optional().describe("YYYY-MM-DD."),
        status: z.enum([...productionBatchStatuses, "open", "all"]).optional(),
        recipe: z.string().max(200).optional().describe("Recipe id or exact code."),
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum batches (default 50, max 200)."),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const recipeId = a.recipe ? await resolveRecipeId(api, slug, a.recipe) : undefined;
      const res = await listBatches(api, slug, {
        ...(a.from ? { from: a.from } : {}),
        ...(a.to ? { to: a.to } : {}),
        ...(a.status ? { status: a.status } : {}),
        ...(recipeId ? { recipeId } : {}),
        ...(a.query ? { q: a.query } : {}),
        limit: String(a.limit ?? 50),
        offset: String(a.offset ?? 0),
      });
      return { batches: res.batches.map(summaryView), ...page(res.offset, res.batches.length, res.total) };
    },
  );

  define(
    "get_production_batch",
    {
      module: "production",
      resource: { name: "production_batches", op: "get" },
      title: "Get production batch",
      description:
        "One batch by id or batch code: recipe and version, size, each ingredient's required, consumed and outstanding quantity, the lots it produced (with QA status and expiry), and the batch record (every consumption and output line with lot, location, who and when; reversals reference the line they correct). Who started, completed (signed off) or cancelled it.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        batch: z.string().min(1).max(200).describe("Batch id or batch code."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveBatchId(api, slug, a.batch);
      return detailView(await getBatch(api, slug, id));
    },
  );

  const sizeFields = {
    batches: z.number().positive().optional().describe("Number of batches, at most 4 decimal places."),
    output_quantity: z.number().positive().optional(),
    output_unit: z.enum(unitCodes).optional(),
    output_location: z.string().max(200).optional().describe("Location id, code or exact name."),
    line: z
      .string()
      .max(200)
      .optional()
      .describe("Production line id or exact name (see list_production_lines)."),
    notes: z.string().max(2000).optional(),
  };
  type PlanEntry = {
    recipe?: string | undefined;
    planned_on?: string | undefined;
    batches?: number | undefined;
    output_quantity?: number | undefined;
    output_unit?: (typeof unitCodes)[number] | undefined;
    output_location?: string | undefined;
    batch_code?: string | undefined;
    notes?: string | undefined;
    line?: string | undefined;
  };
  /** One batch as `POST /production/batches` takes it, with recipe and location references resolved. */
  async function batchInput(api: Api, slug: string, e: PlanEntry, label = "") {
    if (!e.recipe || !e.planned_on) {
      throw new ToolError("invalid_input", `${label}Give \`recipe\` and \`planned_on\`, or a \`plan\` list.`);
    }
    if ((e.batches === undefined) === (e.output_quantity === undefined)) {
      throw new ToolError(
        "invalid_input",
        `${label}Give either \`batches\` or \`output_quantity\` (with \`output_unit\`).`,
      );
    }
    if (e.output_quantity !== undefined && !e.output_unit) {
      throw new ToolError("invalid_input", `${label}\`output_quantity\` needs \`output_unit\`.`);
    }
    const [recipeId, outputLocationId, lineId] = await Promise.all([
      resolveRecipeId(api, slug, e.recipe),
      e.output_location ? resolveLocationId(api, slug, e.output_location) : undefined,
      e.line ? resolveLineId(api, slug, e.line) : undefined,
    ]);
    return {
      recipeId,
      plannedOn: e.planned_on,
      ...(e.batches !== undefined ? { batches: e.batches } : {}),
      ...(e.output_quantity !== undefined
        ? { outputQuantity: e.output_quantity, outputUnit: e.output_unit! }
        : {}),
      ...(outputLocationId ? { outputLocationId } : {}),
      ...(lineId ? { lineId } : {}),
      ...(e.batch_code ? { batchCode: e.batch_code } : {}),
      ...(e.notes ? { notes: e.notes } : {}),
    };
  }

  define(
    "plan_production_batch",
    {
      module: "production",
      title: "Plan production batches",
      description: `Plan a batch of a recipe (id or code) on a date, or several at once with \`plan\` (all or nothing: if one is refused, none is planned and the error names it). A batch is made to the recipe's current approved version (refused with \`no_approved_version\` if there is none). Size it with \`batches\` (e.g. 2.5) or a target \`output_quantity\` with \`output_unit\` (mg, g, kg, ml, l, each; converted with the output item's units). Optionally the output location (id, code or name), a batch code (generated as B + yymmdd + sequence when left out) and notes. To plan from demand, call propose_batches_from_demand and pass its \`plan\` here (after checking it with the user). Check stock with get_material_requirements. ${PERSON_ONLY}`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        recipe: z.string().min(1).max(200).optional().describe("Recipe id or exact code (one batch)."),
        planned_on: z.iso.date().optional().describe("YYYY-MM-DD (one batch)."),
        ...sizeFields,
        batch_code: z.string().max(60).optional(),
        plan: z
          .array(
            z.object({
              recipe: z.string().min(1).max(200).describe("Recipe id or exact code."),
              planned_on: z.iso.date().describe("YYYY-MM-DD."),
              ...sizeFields,
            }),
          )
          .min(1)
          .max(PLAN_FROM_DEMAND_MAX_BATCHES)
          .optional()
          .describe(
            "Several batches, created together; instead of the single-batch fields. Codes are generated.",
          ),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      if (!a.plan)
        return detailView(
          await api.call(
            ws(api).production.batches.$post({ param: { slug }, json: await batchInput(api, slug, a) }),
          ),
        );
      if (
        a.recipe ||
        a.planned_on ||
        a.batches !== undefined ||
        a.output_quantity !== undefined ||
        a.batch_code
      ) {
        throw new ToolError("invalid_input", "Give either `plan` or the fields of one batch, not both.");
      }
      const json = {
        batches: await Promise.all(a.plan.map((e, i) => batchInput(api, slug, e, `plan[${i}]: `))),
      };
      const res = await api.call(ws(api).production["plan-from-demand"].$post({ param: { slug }, json }));
      return { planned: res.batches.length, batches: res.batches.map(summaryView) };
    },
  );

  define(
    "propose_batches_from_demand",
    {
      module: "production",
      // Demand is a soft dependency of production: no demand, nothing to propose from.
      requiresModules: ["demand"],
      title: "Propose batches from demand",
      description: `Production planning from demand, per finished or WIP item and ISO week (Monday to Sunday) between \`from\` and \`to\` (dates or weeks like 2026-W46; default 12 weeks from this one): demand, what batches planned in that week already cover (in progress: planned or made, if more; completed: what was made), the gap, and the whole batches of the item's recipe (current approved version) that cover it, with what they make. Quantities are \`{ base, baseUnit, display, displayUnit }\`. \`issue\` flags items that can't be planned: \`no_recipe\`, \`no_approved_version\` (a person must approve one), \`choose_recipe\` (several recipes make it: ask which, then pass it in \`recipes\`), \`no_yield\`. Returns \`plan\`: the suggested batches on each week's Monday, ready for plan_production_batch's \`plan\` after the user agrees (change dates or sizes as they say). Reads only; nothing is reserved or planned.`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        from: z
          .string()
          .max(20)
          .optional()
          .describe("First week: a date (YYYY-MM-DD) or ISO week (2026-W46)."),
        to: z.string().max(20).optional().describe("Last week, as `from`."),
        recipes: z
          .array(z.string().min(1).max(200))
          .max(100)
          .optional()
          .describe("Recipe ids or codes to use for items several recipes make."),
        gaps_only: z
          .boolean()
          .optional()
          .describe("Only items with a gap or an issue, and only weeks with demand, batches or a gap."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const recipeIds = a.recipes?.length
        ? await Promise.all(a.recipes.map((r) => resolveRecipeId(api, slug, r)))
        : [];
      const res = await api.call(
        ws(api).production["plan-from-demand"].$get({
          param: { slug },
          query: {
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
            ...(recipeIds.length ? { recipeIds: recipeIds.join(",") } : {}),
          },
        }),
      );
      const rows = a.gaps_only ? res.rows.filter((r) => r.issue || r.totals.gap.base > 0) : res.rows;
      const recipeRef = (r: NonNullable<(typeof res.rows)[number]["recipe"]>) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        versionNumber: r.version?.versionNumber ?? null,
        perBatch: r.perBatch,
      });
      return {
        from: res.from,
        to: res.to,
        weeks: res.weeks.map((w) => w.week),
        items: rows.map((r) => ({
          item: { id: r.item.id, code: r.item.code, name: r.item.name, unit: r.item.unit },
          recipe: r.recipe ? recipeRef(r.recipe) : null,
          ...(r.options.length > 1 ? { options: r.options.map(recipeRef) } : {}),
          ...(r.issue ? { issue: r.issue, issueText: planIssueLabels[r.issue] } : {}),
          totals: r.totals,
          weeks: r.cells
            .filter((c) => !a.gaps_only || c.demand.base > 0 || c.batches.length > 0 || c.gap.base > 0)
            .map((c) => ({
              week: c.week,
              periodStart: c.periodStart,
              demand: c.demand,
              planned: c.planned,
              gap: c.gap,
              suggestedBatches: c.suggestedBatches,
              suggestedOutput: c.suggestedOutput,
              ...(c.batches.length
                ? {
                    batches: c.batches.map((b) => ({
                      batchCode: b.batchCode,
                      status: b.status,
                      plannedOn: b.plannedOn,
                    })),
                  }
                : {}),
            })),
        })),
        plan: res.rows.flatMap((r) =>
          r.recipe
            ? r.cells
                .filter((c) => c.suggestedBatches > 0)
                .map((c) => ({
                  recipe: r.recipe!.code,
                  planned_on: c.periodStart,
                  batches: c.suggestedBatches,
                }))
            : [],
        ),
      };
    },
  );

  define(
    "get_material_requirements",
    {
      module: "production",
      title: "Get material requirements",
      description:
        "What the planned and in-progress batches between two dates (inclusive, at most a year) need of each ingredient, scaled from their recipe versions to base units: required, already consumed, outstanding, stock available today (released and not past use-by), stock in quarantine (usable once QA releases it) and the shortfall (stock reserved for batches outside the range is not counted as available; `reserved` is what the range's own batches hold). `incomplete` flags a line whose unit can't be converted. This reserves nothing: use reserve_batch_ingredients.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        from: z.iso.date().describe("YYYY-MM-DD."),
        to: z.iso.date().describe("YYYY-MM-DD."),
        shortfalls_only: z.boolean().optional().describe("Only ingredients that are short."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const res = await api.call(
        ws(api).production.requirements.$get({ param: { slug }, query: { from: a.from, to: a.to } }),
      );
      const rows = a.shortfalls_only
        ? res.requirements.filter((r) => r.shortfall.base > 0 || r.incomplete)
        : res.requirements;
      return {
        from: res.from,
        to: res.to,
        batches: res.batches.map((b) => ({
          id: b.id,
          batchCode: b.batchCode,
          plannedOn: b.plannedOn,
          status: b.status,
          recipe: b.recipe.code,
          batches: b.batches,
          planned: b.planned,
        })),
        requirements: rows.map((r) => ({
          item: { id: r.item.id, code: r.item.code, name: r.item.name },
          required: r.required,
          consumed: r.consumed,
          outstanding: r.outstanding,
          available: r.available,
          quarantine: r.quarantine,
          shortfall: r.shortfall,
          ...(r.incomplete ? { incomplete: true } : {}),
          batches: r.batches.map((b) => ({
            batchCode: b.batchCode,
            plannedOn: b.plannedOn,
            outstanding: b.outstanding,
          })),
        })),
      };
    },
  );

  define(
    "trace_lot",
    {
      module: "production",
      pinned: true,
      title: "Trace a lot through production",
      description: `Traceability through batch records for one lot (id or lot code). \`forward\`: the batches that consumed it and the lots they produced, then onwards (one-down, repeated; use for a recall: where did it go, and how much is still on hand). \`backward\`: the batch that produced it and the lots it consumed, back to goods-in lots with their supplier lot codes (one-up, repeated). \`massBalance\`: received or produced, consumed, wasted, adjusted and on hand. \`depth\` limits the levels (default ${MAX_TRACE_DEPTH}). Reversed records are left out.`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        lot: z.string().min(1).max(200).describe("Lot id or lot code."),
        item: z.string().max(200).optional().describe("Item id or code, when lot codes repeat across items."),
        depth: z.number().int().min(1).max(MAX_TRACE_DEPTH).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const lotId = await resolveLotId(api, slug, a.lot, a.item);
      const res = await api.call(
        ws(api).production.lots[":lotId"].trace.$get({
          param: { slug, lotId },
          query: a.depth ? { depth: String(a.depth) } : {},
        }),
      );
      type Lot = (typeof res.forward)[number]["consumed"]["lot"];
      const lot = (l: Lot) => ({
        id: l.id,
        lotCode: l.lotCode,
        item: l.item.code,
        status: l.status,
        expiresOn: l.expiresOn,
        ...(l.supplierName || l.supplierLotCode
          ? { supplier: l.supplierName, supplierLotCode: l.supplierLotCode }
          : {}),
        onHand: l.onHand,
      });
      const batch = (b: (typeof res.forward)[number]["batch"]) => ({
        batchCode: b.batchCode,
        status: b.status,
        plannedOn: b.plannedOn,
        recipe: b.recipe.code,
        recipeVersion: b.recipeVersion.versionNumber,
      });
      return {
        lot: res.lot,
        massBalance: res.massBalance,
        forward: res.forward.map((f) => ({
          depth: f.depth,
          batch: batch(f.batch),
          consumed: { lot: lot(f.consumed.lot), amount: f.consumed.amount },
          produced: f.outputs.map((o) => ({ lot: lot(o.lot), amount: o.amount })),
        })),
        backward: res.backward.map((b) => ({
          depth: b.depth,
          batch: batch(b.batch),
          produced: { lot: lot(b.produced.lot), amount: b.produced.amount },
          consumed: b.inputs.map((i) => ({ lot: lot(i.lot), amount: i.amount })),
        })),
      };
    },
  );

  define(
    "cancel_production_batch",
    {
      module: "production",
      tokenAction: "production.cancel",
      title: "Cancel a production batch",
      description:
        "Cancel a planned or in-progress batch (by batch code or id), with a reason. This tool exists because an owner or admin allowed API tokens to cancel batches under Settings → API access; the token's owner needs write access to the production module, and manage access to cancel a batch that has already started. A batch with output on record can't be cancelled (`batch_has_output`: a person reverses the output first), and completed or cancelled batches are refused with `invalid_batch_status`. Consumption already recorded stays on the books. Returns the batch.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      input: {
        workspace: workspaceParam,
        batch: z.string().min(1).max(200).describe("Batch code or id."),
        reason: z.string().min(1).max(500).describe("Why the batch is cancelled."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveBatchId(api, slug, a.batch);
      return detailView(
        await api.call(
          ws(api).production.batches[":id"].cancel.$post({ param: { slug, id }, json: { reason: a.reason } }),
        ),
      );
    },
  );

  define(
    "reserve_batch_ingredients",
    {
      module: "production",
      title: "Reserve stock for a batch",
      description:
        "Set stock aside for a planned or in-progress batch (id or code) so it is not promised twice: available stock is on hand minus reserved. Each line is either a lot (id or exact lot code, with `quantity` and `unit`; refused if it is not released, is past use-by, or not enough of it is unreserved) or an ingredient `item` (id or stock code) picked first expired first out from unreserved stock, for `quantity` and `unit` or, without them, everything the batch still needs (short stock reserves what there is and reports the `shortfalls`). `all_outstanding: true` does that for every ingredient. A line (or the whole request, with `location`) can be tied to a stock `location` (id, code or exact name): it then reserves the lot's balance there, or, for an ingredient, picks only from there. `expires_on` (YYYY-MM-DD, on a line or for all of them) is the last day the reservation holds; after it the stock is free again and the reservation is released (reason expired). Reserving a lot the batch already holds at that place adds to it and sets the new expiry. A batch can't hold more of an ingredient than it still needs. A reservation never blocks consumption: it is released as the batch uses the lot, when it completes or is cancelled, or with unreserve_batch_ingredients.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        batch: z.string().min(1).max(200).describe("Batch id or batch code."),
        lines: z
          .array(
            z.object({
              lot: z.string().min(1).max(200).optional().describe("Lot id or exact lot code."),
              item: z.string().min(1).max(200).optional().describe("Ingredient id or stock code (FEFO)."),
              quantity: z.number().positive().optional(),
              unit: z.enum(unitCodes).optional(),
              location: z.string().min(1).max(200).optional().describe("Location id, code or exact name."),
              expires_on: z.iso.date().optional().describe("Last day it holds, YYYY-MM-DD."),
              note: z.string().max(500).optional(),
            }),
          )
          .max(100)
          .optional(),
        all_outstanding: z.boolean().optional(),
        location: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("With all_outstanding: pick only from this location (id, code or exact name)."),
        expires_on: z.iso.date().optional().describe("Default last day it holds for every line without one."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveBatchId(api, slug, a.batch);
      const extras = (
        l: { note?: string; expires_on?: string },
        locationId: string | undefined,
      ): { note?: string; expiresOn?: string; locationId?: string } => ({
        ...(l.note ? { note: l.note } : {}),
        ...(l.expires_on ? { expiresOn: l.expires_on } : {}),
        ...(locationId ? { locationId } : {}),
      });
      const lines = await Promise.all(
        (a.lines ?? []).map(async (l, i) => {
          const locationId = l.location ? await resolveLocationId(api, slug, l.location) : undefined;
          if (!!l.lot === !!l.item)
            throw new ToolError("invalid_input", `lines[${i}]: give either \`lot\` or \`item\`.`);
          if (l.lot) {
            if (l.quantity === undefined || !l.unit)
              throw new ToolError("invalid_input", `lines[${i}]: a lot needs \`quantity\` and \`unit\`.`);
            return {
              lotId: await resolveLotId(api, slug, l.lot),
              quantity: l.quantity,
              unit: l.unit,
              ...extras(l, locationId),
            };
          }
          const itemId = await resolveItemId(api, slug, l.item!);
          return {
            itemId,
            ...(l.quantity !== undefined && l.unit ? { quantity: l.quantity, unit: l.unit } : {}),
            ...extras(l, locationId),
          };
        }),
      );
      const res = await api.call(
        ws(api).production.batches[":id"].reservations.$post({
          param: { slug, id },
          json: {
            ...(lines.length ? { lines } : {}),
            ...(a.all_outstanding ? { allOutstanding: true } : {}),
            ...(a.expires_on ? { expiresOn: a.expires_on } : {}),
            ...(a.all_outstanding && a.location
              ? { locationId: await resolveLocationId(api, slug, a.location) }
              : {}),
          },
        }),
      );
      const { shortfalls, ...rest } = res as typeof res & { shortfalls?: unknown[] };
      return { ...detailView(rest as BatchDetail), shortfalls: shortfalls ?? [] };
    },
  );

  define(
    "unreserve_batch_ingredients",
    {
      module: "production",
      title: "Release a reservation",
      description:
        "Release one stock reservation (its id, from get_production_batch) by hand: the stock is free for other batches again. Returns the batch.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        reservation: z.uuid().describe("Reservation id."),
        note: z.string().max(500).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return detailView(
        await api.call(
          ws(api).production.reservations[":id"].release.$post({
            param: { slug, id: a.reservation },
            json: a.note ? { note: a.note } : {},
          }),
        ),
      );
    },
  );

  define(
    "list_production_lines",
    {
      module: "production",
      resource: { name: "production_lines", op: "list" },
      title: "List production lines",
      description:
        "Production lines with their hours per day, whether they are active, and the recipes each can make with its rate (output per hour). Lines and rates are set up by a person in the app (Production → Lines).",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(ws(api).production.lines.$get({ param: { slug } }));
    },
  );

  define(
    "get_production_schedule",
    {
      module: "production",
      title: "Get the line schedule",
      description:
        "The line schedule between two dates (inclusive, at most 62 days): per line per day the batches with their hours, the hours planned against the line's hours per day, the load percentage and an `overloaded` flag (a warning only: nothing is blocked), `unrated` batches whose recipe the line has no rate for, and `unassigned` open batches that are on no line. A day off in the working-day calendar (see list_production_days_off) has no capacity: it shows as `dayOff` on the line's day (and `daysOff` for the workspace's), and a batch on it counts as overloaded. Assign a batch with assign_batch_line.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        from: z.iso.date().describe("YYYY-MM-DD."),
        to: z.iso.date().describe("YYYY-MM-DD."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(
        ws(api).production.schedule.$get({ param: { slug }, query: { from: a.from, to: a.to } }),
      );
    },
  );

  define(
    "get_production_day_plan",
    {
      module: "production",
      title: "Get a line's day plan",
      description:
        "One production line on one day, timed: its shift windows (or its hours per day from 06:00 when it has no shifts), each batch in the applied order with its changeover before it (the line's rule for that pair of recipes, the same recipe again, or the line's default) and why, allergen clean-downs (the batch before leaves an allergen this one doesn't contain; a \"may contain\" label doesn't replace cleaning), start and end times (minutes from midnight and clock times, \"+1\" past midnight), crew needed against the line's crew, overruns past the last shift and labour hours. `proposal` is an explained order (started batches first, then avoiding clean-downs, shortest changeovers, fewest allergens) with the current and proposed changeover minutes, clean-downs and end time; it changes nothing. Apply an order with set_production_sequence.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        line: z.string().min(1).max(200).describe("Line id or exact name."),
        date: z.iso.date().describe("YYYY-MM-DD."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const lineId = await resolveLineId(api, slug, a.line);
      return api.call(
        ws(api).production.schedule.day.$get({ param: { slug }, query: { lineId, date: a.date } }),
      );
    },
  );

  define(
    "set_production_sequence",
    {
      module: "production",
      title: "Set the order of a line's day",
      description:
        "Apply an order to the batches on one production line on one day, first to last (ids or codes). The list must be exactly the line's uncancelled batches that day, so an order made from an out-of-date plan is refused (`sequence_stale`): read get_production_day_plan again. Returns the re-timed day plan. Moving a batch to another day or line later drops its place.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        line: z.string().min(1).max(200).describe("Line id or exact name."),
        date: z.iso.date().describe("YYYY-MM-DD."),
        batches: z
          .array(z.string().min(1).max(200))
          .min(1)
          .max(100)
          .describe("Batch ids or codes, first to last."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const lineId = await resolveLineId(api, slug, a.line);
      const batchIds: string[] = [];
      for (const b of a.batches) batchIds.push(await resolveBatchId(api, slug, b));
      return api.call(
        ws(api).production.schedule.sequence.$put({
          param: { slug },
          json: { lineId, date: a.date, batchIds },
        }),
      );
    },
  );

  define(
    "get_production_daily_demand",
    {
      module: "production",
      title: "Get daily demand against planned production",
      description:
        "Per product per day from today (1 to 31 days, default 14): outstanding confirmed sales order lines due (overdue ones count on today), output of planned and in-progress batches (late ones count on today), and the projected stock (today's free stock + planned so far − committed so far) with `short` days and `firstShortDate`. Quantities are in each item's base unit (`baseUnit`). Weekly demand from the demand module (forecasts and entered demand) is listed per week beside it and never added in, so an order and its forecast are not counted twice. `basis` says which sources were readable: sales commitments need Sales access, the projection needs Stock, weekly demand needs Demand.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        days: z.number().int().min(1).max(31).optional().describe("Days from today (default 14)."),
        item: z.string().min(1).max(200).optional().describe("Item id or stock code (only this product)."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const itemId = a.item ? await resolveItemId(api, slug, a.item) : undefined;
      return api.call(
        ws(api).production["daily-demand"].$get({
          param: { slug },
          query: {
            ...(a.days ? { days: String(a.days) } : {}),
            ...(itemId ? { itemId } : {}),
          },
        }),
      );
    },
  );

  define(
    "get_production_performance",
    {
      module: "production",
      title: "Get factory performance (OEE)",
      description:
        "OEE per production line per day and over a range (at most 93 days), with the definitions used (`definitions`, version oee-v1): planned production time (capacity less planned downtime), run time (less unplanned downtime), availability, performance (ideal time at the line's rate ÷ run time), quality (ideal good time ÷ ideal total time) and OEE. Also downtime by reason (minutes and events), rejects by reason (records and the run time they cost), standard against actual labour person-hours, and, only for callers who can read costing, line hours costed at the costing module's per-hour absorption rates (standard hours against actual run hours; `cost: null` otherwise). Good output is net output recorded into stock by batches planned that day, and downtime against a batch counts on that day too; a day with nothing planned on a line is not scheduled (its downtime is listed as `unscheduledDowntimeMinutes`, not counted). Rejects are never put into stock.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        from: z.iso.date().describe("YYYY-MM-DD."),
        to: z.iso.date().describe("YYYY-MM-DD."),
        line: z.string().min(1).max(200).optional().describe("Line id or exact name (default: every line)."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const lineId = a.line ? await resolveLineId(api, slug, a.line) : undefined;
      return api.call(
        ws(api).production.performance.$get({
          param: { slug },
          query: { from: a.from, to: a.to, ...(lineId ? { lineId } : {}) },
        }),
      );
    },
  );

  define(
    "record_production_downtime",
    {
      module: "production",
      title: "Record downtime on a line",
      description:
        "Record minutes a production line didn't run on a day, with a reason. Planned reasons (planned_maintenance, cleaning, changeover, break, no_orders, trial) reduce planned production time; unplanned ones (breakdown, minor_stops, material_shortage, staff_shortage, quality_hold, utilities_failure, other_unplanned) reduce availability. Optionally name the batch running (it must be on that line). Records are append-only: a mistake is voided by a person in the app, never edited.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        line: z.string().min(1).max(200).describe("Line id or exact name."),
        date: z.iso.date().describe("The production day, YYYY-MM-DD."),
        minutes: z.number().int().min(1).max(1440),
        reason: z.enum(downtimeReasons),
        batch: z.string().min(1).max(200).optional().describe("Batch id or code running at the time."),
        command_id: z
          .uuid()
          .optional()
          .describe("A UUID you choose. Retry with the same one after a lost response and it records once."),
        note: z.string().max(1000).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const lineId = await resolveLineId(api, slug, a.line);
      const batchId = a.batch ? await resolveBatchId(api, slug, a.batch) : undefined;
      return api.call(
        ws(api).production.downtime.$post({
          param: { slug },
          json: {
            lineId,
            date: a.date,
            minutes: a.minutes,
            reason: a.reason,
            ...(batchId ? { batchId } : {}),
            note: a.note ?? "",
            ...(a.command_id ? { commandId: a.command_id } : {}),
          },
        }),
      );
    },
  );

  define(
    "record_batch_rejects",
    {
      module: "production",
      title: "Record rejects on a batch",
      description:
        "Record output a started batch rejected (scrap), in a unit of its output item, with a reason (setup_waste, underweight, overweight, seal_failure, label_or_code_error, foreign_body, metal_detector_reject, appearance, damaged, temperature, other). Rejects are never put into stock; they count against quality in get_production_performance. A signed-off batch needs manage access. Append-only: a person voids mistakes in the app.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        batch: z.string().min(1).max(200).describe("Batch id or code."),
        quantity: z.number().positive(),
        unit: z.enum(unitCodes),
        reason: z.enum(rejectReasons),
        command_id: z
          .uuid()
          .optional()
          .describe("A UUID you choose. Retry with the same one after a lost response and it records once."),
        note: z.string().max(1000).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveBatchId(api, slug, a.batch);
      return api.call(
        ws(api).production.batches[":id"].rejects.$post({
          param: { slug, id },
          json: {
            quantity: a.quantity,
            unit: a.unit,
            reason: a.reason,
            note: a.note ?? "",
            ...(a.command_id ? { commandId: a.command_id } : {}),
          },
        }),
      );
    },
  );

  define(
    "record_batch_labour",
    {
      module: "production",
      title: "Record labour on a batch",
      description:
        "Record actual labour on a started batch: so many people for so many minutes. get_production_performance compares it with standard labour (standard hours at the line's rate × the recipe's crew size). A signed-off batch needs manage access. Append-only: a person voids mistakes in the app.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        batch: z.string().min(1).max(200).describe("Batch id or code."),
        people: z.number().int().min(1).max(500),
        minutes: z.number().int().min(1).max(1440),
        command_id: z
          .uuid()
          .optional()
          .describe("A UUID you choose. Retry with the same one after a lost response and it records once."),
        note: z.string().max(1000).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveBatchId(api, slug, a.batch);
      return api.call(
        ws(api).production.batches[":id"].labour.$post({
          param: { slug, id },
          json: {
            people: a.people,
            minutes: a.minutes,
            note: a.note ?? "",
            ...(a.command_id ? { commandId: a.command_id } : {}),
          },
        }),
      );
    },
  );

  define(
    "get_batch_packing",
    {
      module: "production",
      title: "Get a batch's packing record",
      description:
        "A batch's packing runs (newest first): the approved label and specification version each pinned, the date and lot codes the packs must carry, the nominal pack quantity, every check (line clearance, first-off and in-run label and code checks, metal detector challenges, weight samples) with whether it passed, why not and what was done, voided checks, `gaps` (what stands between an open run and closing) and, once closed, packs produced and packaging reconciliation. `candidates` lists the approved labels (drafted from the batch's own recipe version) and approved specification versions a new run may pin.",
      annotations: READ,
      input: { workspace: workspaceParam, batch: z.string().min(1).max(200).describe("Batch id or code.") },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveBatchId(api, slug, a.batch);
      return api.call(ws(api).production.batches[":id"].packing.$get({ param: { slug, id } }));
    },
  );

  define(
    "get_lot_packing",
    {
      module: "production",
      title: "Which label a lot carries",
      description:
        "For a lot (id): the batches that produced it and each batch's packing runs with the approved label (recipe, variant, version, product name, barcode) and specification version pinned, and the date and lot codes expected. `unrecorded: true` means the batch has no packing run, so what its packs carry wasn't recorded.",
      annotations: READ,
      input: { workspace: workspaceParam, lot: z.uuid().describe("Lot id.") },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(ws(api).production.lots[":lotId"].packing.$get({ param: { slug, lotId: a.lot } }));
    },
  );

  define(
    "open_packing_run",
    {
      module: "production",
      title: "Start packing a batch",
      description:
        "Open a packing run on a started or completed batch: the approved label its packs carry (id from get_batch_packing's candidates; required when the labels module is on, and it must be drafted from the batch's recipe version), optionally an approved specification version, the date code packs must show, the lot code (default: the batch code), the nominal pack quantity in g or ml (turns on weight samples) and whether there's a metal detector to challenge. One open run per batch. Closing (with packaging reconciliation) is done by a person in the app.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        batch: z.string().min(1).max(200).describe("Batch id or code."),
        label: z
          .uuid()
          .nullable()
          .describe(
            "Approved label id from get_batch_packing's candidates, or null: with the labels module on, the only approved label for the batch's recipe version is pinned (several must be chosen between).",
          ),
        specification_version: z.uuid().optional(),
        expected_date_code: z.string().min(1).max(80),
        expected_lot_code: z.string().min(1).max(80).optional(),
        nominal_quantity: z.number().min(5).max(50_000).optional().describe("g or ml per pack."),
        detector_required: z.boolean().optional(),
        command_id: z
          .uuid()
          .optional()
          .describe("A UUID you choose. Retry with the same one after a lost response and it records once."),
        note: z.string().max(1000).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveBatchId(api, slug, a.batch);
      return api.call(
        ws(api).production.batches[":id"].packing.$post({
          param: { slug, id },
          json: {
            labelId: a.label,
            ...(a.specification_version ? { specificationVersionId: a.specification_version } : {}),
            expectedDateCode: a.expected_date_code,
            ...(a.expected_lot_code ? { expectedLotCode: a.expected_lot_code } : {}),
            ...(a.nominal_quantity ? { nominalQuantity: a.nominal_quantity } : {}),
            ...(a.detector_required !== undefined ? { detectorRequired: a.detector_required } : {}),
            note: a.note ?? "",
            ...(a.command_id ? { commandId: a.command_id } : {}),
          },
        }),
      );
    },
  );

  define(
    "record_packing_check",
    {
      module: "production",
      title: "Record a packing check",
      description:
        'Record a check on an open packing run (run id from get_batch_packing). `check` is one of: `{ kind: "line_clearance", items: { previous_product_removed, previous_packaging_and_labels_removed, coders_and_printers_cleared, line_clean_and_ready } }` (all true to pass; a missing item counts as not done); `{ kind: "first_off" | "in_run_label", labelCorrect, dateCodeSeen, lotCodeSeen, legible }` (codes are compared with the run\'s, ignoring case and spaces); `{ kind: "detector_challenge", detector, pieces: [{ piece: ferrous | non_ferrous | stainless_steel, sizeMm, rejected }] }` (one of each piece); `{ kind: "weight_sample", readings: [g per pack] }` (against the nominal: mean at least nominal, at most 2.5% below nominal less TNE, none below nominal less twice TNE). A failed check needs `failure_action` (what was done, e.g. packs held). Append-only: voiding is done by a person in the app.',
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        run: z.uuid().describe("Packing run id."),
        check: z.record(z.string(), z.unknown()).describe("The check, by kind (see the description)."),
        failure_action: z.string().max(2000).optional(),
        command_id: z
          .uuid()
          .optional()
          .describe("A UUID you choose. Retry with the same one after a lost response and it records once."),
        note: z.string().max(1000).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const parsed = packingCheckSchema.safeParse({
        ...a.check,
        ...(a.failure_action ? { failureAction: a.failure_action } : {}),
        ...(a.note ? { note: a.note } : {}),
        ...(a.command_id ? { commandId: a.command_id } : {}),
      });
      if (!parsed.success)
        throw new ToolError(
          "invalid_input",
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      return api.call(
        ws(api).production.packing[":id"].checks.$post({ param: { slug, id: a.run }, json: parsed.data }),
      );
    },
  );

  define(
    "list_production_devices",
    {
      module: "production",
      resource: { name: "production_devices", op: "list" },
      title: "List line devices",
      description:
        "Registered line devices (scales, checkweighers, metal detectors, temperature probes, scanners, label printers): code, kind, unit, line, status, when a reading was last received, and calibration state from the linked HACCP equipment (in_date, overdue, failed, unknown, or not_required when not linked). Devices are registered by a person in the app.",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(ws(api).production.devices.$get({ param: { slug } }));
    },
  );

  define(
    "list_device_readings",
    {
      module: "production",
      resource: { name: "device_readings", op: "list" },
      title: "List a device's readings",
      description:
        "Readings a device sent, newest first (at most 500): the device's reading id, when taken and received, the value in the device's unit with what was sent, whether it arrived late (buffered offline), the calibration state when it was taken, and the packing check it became part of. `unused: true` lists only readings not yet part of a check, e.g. for record_weight_from_device. `from`/`to` filter by time taken.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        device: z.uuid().describe("Device id."),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        unused: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(
        ws(api).production.devices[":id"].readings.$get({
          param: { slug, id: a.device },
          query: {
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
            ...(a.unused !== undefined ? { unused: String(a.unused) as "true" | "false" } : {}),
            ...(a.limit ? { limit: String(a.limit) } : {}),
          },
        }),
      );
    },
  );

  define(
    "send_device_readings",
    {
      module: "production",
      title: "Send a device's readings",
      description:
        "Send measured readings from a registered scale, checkweigher or temperature probe (device id from list_production_devices), as a site gateway would: each with the device's own `reading_id`, the time it was taken (ISO with offset), value and unit. Readings buffered while offline are accepted up to 30 days old and marked late; readings in the future are refused. Each comes back accepted, duplicate (same id and value: stored once, so resending is safe), conflict (same id, different value, unit or time: refused) or rejected (with the reason, e.g. a unit that doesn't convert). Readings are stamped with the device's calibration state.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        device: z.uuid().describe("Device id."),
        readings: z
          .array(
            z.object({
              reading_id: z.string().min(1).max(120),
              taken_at: z.iso.datetime({ offset: true }),
              value: z.number(),
              unit: z.enum(deviceUnits),
            }),
          )
          .min(1)
          .max(500),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(
        ws(api).production.devices[":id"].readings.$post({
          param: { slug, id: a.device },
          json: {
            readings: a.readings.map((r) => ({
              readingId: r.reading_id,
              takenAt: r.taken_at,
              value: r.value,
              unit: r.unit,
            })),
          },
        }),
      );
    },
  );

  define(
    "record_weight_from_device",
    {
      module: "production",
      title: "Record a weight sample from a scale",
      description:
        "Turn a scale's or checkweigher's readings (ids from list_device_readings with `unused: true`) into a weight sample on an open packing run. The device must be linked to calibrated equipment that is in date now and was when each reading was taken; readings must have been taken after the run started and not already be part of a check. The sample is judged like any weight sample (mean, nominal less TNE, twice TNE); a failure needs `failure_action`.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        run: z.uuid().describe("Packing run id."),
        device: z.uuid().describe("Device id."),
        readings: z.array(z.uuid()).min(1).max(500).describe("Reading ids."),
        failure_action: z.string().max(2000).optional(),
        command_id: z
          .uuid()
          .optional()
          .describe("A UUID you choose. Retry with the same one after a lost response and it records once."),
        note: z.string().max(1000).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(
        ws(api).production.packing[":id"].checks["weight-from-device"].$post({
          param: { slug, id: a.run },
          json: {
            deviceId: a.device,
            readingIds: a.readings,
            ...(a.failure_action ? { failureAction: a.failure_action } : {}),
            note: a.note ?? "",
            ...(a.command_id ? { commandId: a.command_id } : {}),
          },
        }),
      );
    },
  );

  define(
    "assign_batch_line",
    {
      module: "production",
      title: "Assign a batch to a line",
      description:
        "Put a planned or in-progress batch (id or code) on a production line (id or exact name), or take it off with `line: null`. Overloading the line's day is allowed: the batch comes back with a `lineCheck` listing warnings (overloaded, no rate for the recipe). An inactive line is refused.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        batch: z.string().min(1).max(200).describe("Batch id or batch code."),
        line: z.string().min(1).max(200).nullable().describe("Line id or exact name, or null to clear."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveBatchId(api, slug, a.batch);
      const lineId = a.line === null ? null : await resolveLineId(api, slug, a.line);
      return detailView(
        await api.call(ws(api).production.batches[":id"].$patch({ param: { slug, id }, json: { lineId } })),
      );
    },
  );

  define(
    "list_production_days_off",
    {
      module: "production",
      resource: { name: "production_days_off", op: "list" },
      title: "Get the production working-day calendar",
      description:
        "The days the workspace, or one production line, does not produce (bank holidays, shutdowns, a line down), between two dates (inclusive, at most two years), each with its reason and line (`lineId` null: the whole workspace). Every day is a working day unless listed here. Advisory: the schedule, a batch's `calendarWarning`, and get_demand_capacity warn about batches planned on these days; nothing is blocked or moved.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        from: z.iso.date().describe("YYYY-MM-DD."),
        to: z.iso.date().describe("YYYY-MM-DD."),
        line: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Only this line's days off (and the workspace's): line id or exact name."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const lineId = a.line ? await resolveLineId(api, slug, a.line) : undefined;
      return api.call(
        ws(api).production.calendar.$get({
          param: { slug },
          query: { from: a.from, to: a.to, ...(lineId ? { lineId } : {}) },
        }),
      );
    },
  );

  define(
    "set_non_working_days",
    {
      module: "production",
      title: "Mark non-working days, or put them back",
      description:
        "Mark every date from `from` to `to` (default: `from` alone) as non-working for the workspace, or for one production `line` (id or exact name), optionally only on some `weekdays` (1 = Monday … 7 = Sunday, e.g. [6, 7] for weekends) and with a `reason`. Dates already marked are left alone, so it is safe to repeat; at most 366 days per call. `remove` takes days off the calendar again by their ids (from list_production_days_off). Advisory: planning warns, nothing is moved or blocked.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        from: z.iso.date().optional().describe("First date to mark, YYYY-MM-DD."),
        to: z.iso.date().optional().describe("Last date to mark; default `from`."),
        weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
        line: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Line id or exact name; default the whole workspace."),
        reason: z.string().max(200).optional(),
        remove: z.array(z.uuid()).max(100).optional().describe("Ids of days off to take off the calendar."),
      },
    },
    async (a, api) => {
      if (!a.from && !a.remove?.length) {
        throw new ToolError(
          "invalid_input",
          "Give `from` (and optionally `to`) to mark days, or `remove` ids.",
        );
      }
      const slug = await slugOf(api, a.workspace);
      for (const id of a.remove ?? []) {
        await api.call(ws(api).production.calendar[":id"].$delete({ param: { slug, id } }));
      }
      const removed = a.remove?.length ?? 0;
      if (!a.from) return { created: 0, existing: 0, removed, days: [] };
      const lineId = a.line ? await resolveLineId(api, slug, a.line) : undefined;
      const res = await api.call(
        ws(api).production.calendar.$post({
          param: { slug },
          json: {
            from: a.from,
            ...(a.to ? { to: a.to } : {}),
            ...(a.weekdays ? { weekdays: a.weekdays } : {}),
            ...(lineId ? { lineId } : {}),
            ...(a.reason ? { reason: a.reason } : {}),
          },
        }),
      );
      return { ...res, removed };
    },
  );
}
