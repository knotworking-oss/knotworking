import {
  DEMAND_SET_MAX_LINES,
  FORECAST_DEFAULT_WINDOW,
  FORECAST_MAX_WINDOW,
  FORECAST_MIN_WINDOW,
  PACK_UNITS_PER_ITEM,
  demandItemTypes,
  demandSources,
  unitCodes,
} from "@knotworking/core";
import { z } from "zod";
import type { Api } from "../api";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Setting demand replaces quantities (and can remove lines); sending the same thing again is a no-op. */
const REPLACE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD_HELP = "A date (YYYY-MM-DD; read as the ISO week it falls in) or an ISO week such as 2026-W46.";
const UNIT_HELP =
  "mg, g, kg (weight); ml, l (volume); each (count); or one of the item's pack units such as case (see list_pack_units). Default: the item's own unit.";

/** An item reference as the API's filters take it: an id, or a stock code. */
const itemFilter = (ref: string | undefined) =>
  !ref ? {} : UUID.test(ref.trim()) ? { itemId: ref.trim() } : { itemCode: ref.trim() };

/**
 * Demand module: demand per product per ISO week (by customer), totals for planning, setting
 * lines and CSV import. Quantities come back as `{ base, baseUnit, display, displayUnit }`.
 */
export function registerDemandTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];

  define(
    "get_demand_summary",
    {
      module: "demand",
      title: "Get demand summary",
      description: `Total demand per product per ISO week over a range (default: 12 weeks from this week; at most 104), as production plans it. Each row is an item (or an item and customer with \`by_customer\`) with its total and the weeks that have demand. Filter by \`item\` (id or code) or \`item_type\`. \`from\`/\`to\`: ${PERIOD_HELP}`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        from: z.string().max(20).optional(),
        to: z.string().max(20).optional(),
        item: z.string().max(200).optional().describe("Item id or exact stock code."),
        item_type: z.enum(demandItemTypes).optional(),
        by_customer: z.boolean().optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const res = await api.call(
        ws(api).demand.summary.$get({
          param: { slug },
          query: {
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
            ...itemFilter(a.item),
            ...(a.item_type ? { itemType: a.item_type } : {}),
            ...(a.by_customer ? { byCustomer: "true" } : {}),
          },
        }),
      );
      return {
        from: res.from,
        to: res.to,
        weeks: res.weeks.map((w) => w.week),
        rows: res.rows.map((r) => ({
          item: { id: r.item.id, code: r.item.code, name: r.item.name, type: r.item.type },
          ...(res.byCustomer ? { customer: r.customer } : {}),
          total: r.total,
          weeks: r.periods.map((p) => ({ week: p.week, periodStart: p.periodStart, quantity: p.quantity })),
        })),
      };
    },
  );

  define(
    "list_demand_lines",
    {
      module: "demand",
      resource: { name: "demand_lines", op: "list" },
      title: "List demand lines",
      description: `Individual demand lines (one per item, week and customer) with quantity, note, source (manual, import, api or forecast), what was typed when it was entered in a pack unit, the sales system's reference and who set them, by week then item code. Filter by \`item\` (id or code), \`from\`/\`to\` (${PERIOD_HELP}), \`customer\` (exact), \`source\`, \`query\` (item name or code). Paged with \`offset\` while \`hasMore\` is true.`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        item: z.string().max(200).optional().describe("Item id or exact stock code."),
        from: z.string().max(20).optional(),
        to: z.string().max(20).optional(),
        customer: z.string().max(120).optional(),
        source: z.enum(demandSources).optional(),
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum lines (default 100, max 500)."),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const res = await api.call(
        ws(api).demand.lines.$get({
          param: { slug },
          query: {
            ...itemFilter(a.item),
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
            ...(a.customer ? { customer: a.customer } : {}),
            ...(a.source ? { source: a.source } : {}),
            ...(a.query ? { q: a.query } : {}),
            limit: String(a.limit ?? 100),
            offset: String(a.offset ?? 0),
          },
        }),
      );
      return {
        lines: res.lines.map((l) => ({
          id: l.id,
          item: { id: l.item.id, code: l.item.code, name: l.item.name },
          week: l.week,
          periodStart: l.periodStart,
          customer: l.customer,
          quantity: l.amount,
          ...(l.enteredUnit ? { entered: { quantity: l.enteredQuantity, unit: l.enteredUnit } } : {}),
          note: l.note,
          source: l.source,
          externalRef: l.externalRef,
          updatedBy: l.updatedByName,
          updatedAt: l.updatedAt,
        })),
        total: res.total,
        offset: res.offset,
        returned: res.lines.length,
        hasMore: res.offset + res.lines.length < res.total,
      };
    },
  );

  define(
    "set_demand",
    {
      module: "demand",
      title: "Set demand",
      description: `Set demand for products by week: each line names an item (id or stock code), a week (${PERIOD_HELP}), a quantity (in \`unit\`; ${UNIT_HELP}) and optionally a customer. There is one line per item, week and customer: setting it again replaces the quantity (sending the same values again changes nothing), and \`quantity: null\` removes it. Only active finished goods and work in progress can have demand. All lines are checked first; if any is wrong nothing is saved and the error lists each problem by line number. Up to ${DEMAND_SET_MAX_LINES} lines per call.`,
      annotations: REPLACE,
      input: {
        workspace: workspaceParam,
        lines: z
          .array(
            z.object({
              item: z.string().min(1).max(200).describe("Item id or exact stock code."),
              week: z.string().min(1).max(20).describe(PERIOD_HELP),
              quantity: z.number().min(0).nullable().describe("null removes the line."),
              unit: z.string().min(1).max(40).optional().describe(UNIT_HELP),
              customer: z.string().max(120).optional().describe("Customer or channel; leave out for none."),
              note: z.string().max(500).optional(),
              external_ref: z.string().max(120).optional().describe("The sales system's reference."),
            }),
          )
          .min(1)
          .max(DEMAND_SET_MAX_LINES),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const res = await api.call(
        ws(api).demand.lines.$put({
          param: { slug },
          json: {
            lines: a.lines.map((l) => ({
              ...(UUID.test(l.item.trim()) ? { itemId: l.item.trim() } : { itemCode: l.item.trim() }),
              period: l.week,
              quantity: l.quantity,
              ...(l.unit ? { unit: l.unit } : {}),
              ...(l.customer ? { customer: l.customer } : {}),
              ...(l.note !== undefined ? { note: l.note } : {}),
              ...(l.external_ref !== undefined ? { externalRef: l.external_ref } : {}),
            })),
          },
        }),
      );
      return {
        created: res.created,
        updated: res.updated,
        removed: res.removed,
        unchanged: res.unchanged,
        lines: res.lines.map((r) => ({
          action: r.action,
          ...(r.line
            ? {
                id: r.line.id,
                item: r.line.item.code,
                week: r.line.week,
                customer: r.line.customer,
                quantity: r.line.amount,
              }
            : {}),
        })),
      };
    },
  );

  define(
    "import_demand_csv",
    {
      module: "demand",
      title: "Import demand from CSV",
      description: `Import demand from CSV text with a header row. Columns (any order): item (stock code), period (${PERIOD_HELP} UK dates such as 09/11/2026 also work), quantity (0 or more); optional unit, customer, note and reference. Other columns are ignored. Use \`dry_run: true\` first: it checks every row and reports what would be created, updated or left unchanged, writing nothing. A real import writes every row in one go, or nothing if any row has a problem (each listed with its row number). A file never removes lines unless you pass \`replace_horizon: true\`: then every live demand line (any product, but only for the customers the file names; a blank customer counts as one) in the weeks from the file's first to its last that the file doesn't have is removed (kept in the history), and the result lists them as \`remove\` changes. This is destructive: run it with \`dry_run: true\` first and check the removals with the person.`,
      annotations: REPLACE,
      input: {
        workspace: workspaceParam,
        csv: z.string().min(1).max(2_000_000),
        file_name: z.string().max(200).optional(),
        dry_run: z.boolean().optional(),
        replace_horizon: z.boolean().optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const res = await api.call(
        ws(api).demand.imports.$post({
          param: { slug },
          json: {
            csv: a.csv,
            ...(a.file_name ? { fileName: a.file_name } : {}),
            ...(a.dry_run ? { dryRun: true } : {}),
            ...(a.replace_horizon ? { replaceHorizon: true } : {}),
          },
        }),
      );
      return {
        dryRun: res.dryRun,
        rows: res.rowCount,
        ...(res.ignoredColumns.length ? { ignoredColumns: res.ignoredColumns } : {}),
        errors: res.errors,
        created: res.created,
        updated: res.updated,
        ...(res.horizon
          ? { removed: res.removed, horizon: `${res.horizon.fromWeek} to ${res.horizon.toWeek}` }
          : {}),
        unchanged: res.unchanged,
        changes: res.changes.slice(0, 50).map((c) => ({
          ...(c.action === "remove" && c.row === 0 ? {} : { row: c.row }),
          action: c.action,
          item: c.item.code,
          week: c.week,
          customer: c.customer,
          quantity: c.amount,
          previous: c.previous,
        })),
        ...(res.changes.length > 50 || res.changesTruncated ? { changesShown: 50 } : {}),
        ...(res.import ? { importId: res.import.id } : {}),
      };
    },
  );

  define(
    "list_pack_units",
    {
      module: "demand",
      resource: { name: "pack_units", op: "list" },
      title: "List units of sale",
      description:
        "Units of sale (pack units such as case = 12 each) per product. `size` is in the product's base unit (g, ml or each). Demand can be entered in a pack unit by giving its name as the unit in set_demand or in a CSV import. Filter by `item` (id or code).",
      annotations: READ,
      input: { workspace: workspaceParam, item: z.string().max(200).optional() },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const res = await api.call(
        ws(api).demand["pack-units"].$get({ param: { slug }, query: itemFilter(a.item) }),
      );
      return {
        packUnits: res.packUnits.map((p) => ({
          id: p.id,
          item: p.item.code,
          name: p.name,
          size: p.amount,
        })),
      };
    },
  );

  define(
    "set_pack_units",
    {
      module: "demand",
      title: "Set units of sale",
      description: `Create, resize or remove units of sale for finished goods and work in progress, e.g. case = 12 each. \`size\` is how much is in one pack, in \`unit\` (default: the item's base unit g, ml or each; for a 6 kg case use size 6, unit kg); \`size: null\` removes the pack. A name can't be a plain unit (kg, each...). At most ${PACK_UNITS_PER_ITEM} per item. Demand already entered keeps its base quantity when a pack is resized.`,
      annotations: REPLACE,
      input: {
        workspace: workspaceParam,
        pack_units: z
          .array(
            z.object({
              item: z.string().min(1).max(200).describe("Item id or exact stock code."),
              name: z.string().min(1).max(40),
              size: z.number().positive().nullable().describe("null removes the pack."),
              unit: z.enum(unitCodes).optional(),
            }),
          )
          .min(1)
          .max(200),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const res = await api.call(
        ws(api).demand["pack-units"].$put({
          param: { slug },
          json: {
            packUnits: a.pack_units.map((p) => ({
              ...(UUID.test(p.item.trim()) ? { itemId: p.item.trim() } : { itemCode: p.item.trim() }),
              name: p.name,
              size: p.size,
              ...(p.unit ? { unit: p.unit } : {}),
            })),
          },
        }),
      );
      return {
        results: res.results.map((r) => ({
          action: r.action,
          ...(r.packUnit
            ? { item: r.packUnit.item.code, name: r.packUnit.name, size: r.packUnit.amount }
            : {}),
        })),
      };
    },
  );

  const forecastInput = {
    workspace: workspaceParam,
    from: z
      .string()
      .max(20)
      .optional()
      .describe(`First week to forecast (default: this week). ${PERIOD_HELP}`),
    to: z.string().max(20).optional().describe("Last week (default: 8 weeks from `from`; at most 52)."),
    item: z.string().max(200).optional().describe("Item id or exact stock code."),
    item_type: z.enum(demandItemTypes).optional(),
    by_customer: z.boolean().optional().describe("Forecast each customer separately."),
    window: z
      .number()
      .int()
      .min(FORECAST_MIN_WINDOW)
      .max(FORECAST_MAX_WINDOW)
      .optional()
      .describe(`Weeks of history to average (default ${FORECAST_DEFAULT_WINDOW}).`),
    seasonal: z
      .boolean()
      .optional()
      .describe("Scale by the same weeks last year when there is that history (default true)."),
  };

  define(
    "get_demand_forecast",
    {
      module: "demand",
      title: "Get demand forecast",
      description:
        "A simple, explainable forecast per product (and customer) from past demand: the average weekly demand over the last N weeks, scaled by a seasonal index from the same weeks last year when there is a year of history. No model, no guess: each week says how it was worked out. Lines copied from an earlier forecast are not counted as history. Writes nothing; use copy_demand_forecast to put it into demand lines.",
      annotations: READ,
      input: forecastInput,
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const res = await api.call(
        ws(api).demand.forecast.$get({
          param: { slug },
          query: {
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
            ...itemFilter(a.item),
            ...(a.item_type ? { itemType: a.item_type } : {}),
            ...(a.by_customer ? { byCustomer: "true" } : {}),
            ...(a.window ? { window: String(a.window) } : {}),
            ...(a.seasonal === undefined
              ? {}
              : { seasonal: a.seasonal ? ("true" as const) : ("false" as const) }),
          },
        }),
      );
      return {
        method: res.method,
        from: res.from,
        to: res.to,
        rows: res.rows.map((r) => ({
          item: { id: r.item.id, code: r.item.code, name: r.item.name },
          ...(res.byCustomer ? { customer: r.customer } : {}),
          weeks: r.periods.map((p) => ({ week: p.week, quantity: p.quantity, how: p.explanation })),
        })),
      };
    },
  );

  define(
    "copy_demand_forecast",
    {
      module: "demand",
      title: "Copy forecast into demand",
      description:
        "Writes the forecast (same options as get_demand_forecast) into demand lines with source `forecast`, as an ordinary write that is kept in the history. By default only weeks where the product has no demand at all are filled, so real orders and hand-entered plans are never overwritten; `overwrite: true` replaces the line with the same item, week and customer (never a total over customer lines). Weeks forecast at 0 are not written. Check the forecast with the person first. The result lists what was skipped and why.",
      annotations: REPLACE,
      input: { ...forecastInput, overwrite: z.boolean().optional() },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const res = await api.call(
        ws(api).demand.forecast.apply.$post({
          param: { slug },
          json: {
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
            ...(a.item
              ? UUID.test(a.item.trim())
                ? { itemId: a.item.trim() }
                : { itemCode: a.item.trim() }
              : {}),
            ...(a.item_type ? { itemType: a.item_type } : {}),
            ...(a.by_customer !== undefined ? { byCustomer: a.by_customer } : {}),
            ...(a.window ? { window: a.window } : {}),
            ...(a.seasonal !== undefined ? { seasonal: a.seasonal } : {}),
            ...(a.overwrite ? { overwrite: true } : {}),
          },
        }),
      );
      return {
        created: res.created,
        updated: res.updated,
        unchanged: res.unchanged,
        skipped: res.skipped,
      };
    },
  );

  define(
    "get_demand_capacity",
    {
      module: "demand",
      title: "Compare demand with production line capacity",
      description: `Per week: the hours the active production lines can run (hours per day on each working day; days off in the working-day calendar count nothing), the hours of batches already booked on lines, and the hours needed to make what get_demand_coverage says is still short (the week's new shortfall, at the fastest line's rate for the product). \`loadPercent\` is (booked + needed) ÷ capacity; \`status\` is ok, tight (90% or more) or over. Also per week: days off, batches planned on a day off, open batches on no line (their hours are unknown), and products no line has a rate for (\`unratedItems\`). Advisory: it picks no line and schedules nothing. Only for callers who can read production (\`available: false\` otherwise); shortfalls count stock and batches as get_demand_coverage does. \`from\`/\`to\`: ${PERIOD_HELP}`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        from: z.string().max(20).optional(),
        to: z.string().max(20).optional(),
        item: z.string().max(200).optional().describe("Item id or exact stock code."),
        item_type: z.enum(demandItemTypes).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const res = await api.call(
        ws(api).demand.capacity.$get({
          param: { slug },
          query: {
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
            ...itemFilter(a.item),
            ...(a.item_type ? { itemType: a.item_type } : {}),
          },
        }),
      );
      return {
        from: res.from,
        to: res.to,
        available: res.available,
        lineCount: res.lineCount,
        basis: res.basis,
        overWeeks: res.overWeeks,
        weeks: res.weeks.map((w) => ({
          week: w.week,
          capacityHours: w.capacityHours,
          bookedHours: w.bookedHours,
          neededHours: w.neededHours,
          freeHours: w.freeHours,
          loadPercent: w.loadPercent,
          status: w.status,
          unassignedBatches: w.unassignedBatches,
          unratedBatches: w.unratedBatches,
          unratedItems: w.unratedItems,
          daysOff: w.daysOff,
          batchesOnDaysOff: w.batchesOnDaysOff,
          lines: w.lines,
        })),
        needs: res.needs.map((n) => ({
          item: { id: n.item.id, code: n.item.code, name: n.item.name },
          fastestLine: n.rate,
          weeks: n.weeks
            .filter((x) => x.shortfall.base > 0)
            .map((x) => ({ week: x.week, shortfall: x.shortfall, hours: x.hours })),
        })),
      };
    },
  );

  define(
    "get_demand_coverage",
    {
      module: "demand",
      title: "Compare demand with stock and planned batches",
      description: `Per product per week: demand, the output of planned and in-progress production batches due that week, and what is left at the end of the week (stock available now + planned batches so far - demand so far). \`shortfall\` is how much more is needed by the end of that week; \`status\` is ok, short or unknown. Stock and batch figures appear only when the caller can read the stock and production modules; \`basis\` says what is counted (without either, status is unknown). Starts no earlier than this week. \`from\`/\`to\`: ${PERIOD_HELP}`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        from: z.string().max(20).optional(),
        to: z.string().max(20).optional(),
        item: z.string().max(200).optional().describe("Item id or exact stock code."),
        item_type: z.enum(demandItemTypes).optional(),
        short_only: z.boolean().optional().describe("Only products that run short."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const res = await api.call(
        ws(api).demand.coverage.$get({
          param: { slug },
          query: {
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
            ...itemFilter(a.item),
            ...(a.item_type ? { itemType: a.item_type } : {}),
            ...(a.short_only ? { shortOnly: "true" } : {}),
          },
        }),
      );
      return {
        from: res.from,
        to: res.to,
        basis: res.basis,
        rows: res.rows.map((r) => ({
          item: { id: r.item.id, code: r.item.code, name: r.item.name },
          stock: r.stock,
          firstShortWeek: r.firstShortWeek,
          maxShortfall: r.maxShortfall,
          weeks: r.periods.map((p) => ({
            week: p.week,
            demand: p.demand,
            planned: p.planned,
            projected: p.projected,
            shortfall: p.shortfall,
            status: p.status,
          })),
        })),
      };
    },
  );
}
