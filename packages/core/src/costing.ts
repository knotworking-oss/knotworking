import { z } from "zod";
import { formatWeek, weekStart, weekStartOf } from "./demand";
import { itemTypes, roundQuantity, unitDimension, units, type UnitBridge, type UnitCode } from "./items";
import { batchFactor, batchMaterials, openBatchStatuses, type ProductionBatchStatus } from "./production";
import { type BatchConversion } from "./costing-conversion";
import { addDays } from "./stock";

/**
 * Costing module: what a production batch actually cost, how much it yielded, and standard
 * against actual by product and period. Pure functions over the ledger the other modules keep:
 * batch records (production), purchase receipts and approved supplier invoices (purchasing), item
 * standard costs (items) and recipe versions (recipes). Nothing here is stored; see
 * docs/modules.md for why. No DOM or Node APIs.
 *
 * Money is a plain number in the workspace's currency (`currency.ts`; the currency only decides how
 * amounts are shown). Quantities are in the item's base
 * unit (g, ml or each), as in the stock ledger; unit costs in the results are per the item's own
 * unit (per kg, per l, per each), as standard costs and recipe roll-ups are.
 *
 * Variances follow one sign convention: **positive is adverse** (it cost more than standard).
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * Where a consumed lot's cost comes from:
 * - `invoice`: the matched price on the supplier's approved invoice for the order line it was
 *   received against (purchasing's three-way match), which takes over from the order price;
 * - `purchase`: the price on the purchase receipt that created it (purchasing goods-in);
 * - `batch`: it was made by a batch, at that batch's actual cost per unit (multi-stage flow);
 * - `standard`: no actual price is known, so the item's standard cost (an **estimate**);
 * - `missing`: no actual price and no standard cost either; the batch's cost is incomplete.
 */
export const lotCostSources = ["invoice", "purchase", "batch", "standard", "missing"] as const;
export type LotCostSource = (typeof lotCostSources)[number];
export const lotCostSourceLabels: Record<LotCostSource, string> = {
  invoice: "Invoice price",
  purchase: "Purchase price",
  batch: "Batch cost",
  standard: "Standard cost (estimated)",
  missing: "No cost",
};

/**
 * Why a lot fell back to the item's standard cost (or has none), or, for `invoice_unpriced`, why a
 * purchased lot is at its receipt price rather than its invoice's.
 */
export const lotCostReasons = [
  /** Received against a purchase order line that had no price. */
  "no_purchase_price",
  /** Not from a purchase order nor a batch: opening stock, manual goods-in. */
  "not_purchased",
  /** Valuing it would loop back to the batch being costed. */
  "cycle",
  /** Made by a batch further back than the costing follows (`COSTING_MAX_DEPTH`). */
  "too_deep",
  /** Its batch has no output on record, so it has no cost per unit. */
  "no_output",
  /**
   * An approved invoice bills it, but its price couldn't be put on the lot (the order line had no
   * price and the unit didn't convert at approval), so the receipt's price is used (or, without
   * one, the standard cost).
   */
  "invoice_unpriced",
] as const;
export type LotCostReason = (typeof lotCostReasons)[number];
export const lotCostReasonLabels: Record<LotCostReason, string> = {
  no_purchase_price: "Received without a price",
  not_purchased: "Not received against a purchase order",
  cycle: "Its batch consumed its own output",
  too_deep: "Made too many stages back",
  no_output: "Its batch has no output",
  invoice_unpriced:
    "Invoiced, but the invoice price couldn't be applied (no order price and the unit didn't convert)",
};

/**
 * How many batch stages back the costing follows lots (a lot → its batch → that batch's lots),
 * counted from the batch or lot being costed. The engine enforces it on every path, so a batch
 * costs the same on its own as in a report; the loader loads no further.
 */
export const COSTING_MAX_DEPTH = 20;

/** Decimal places of money in results (totals, variances): the same as order values. */
export const COST_DECIMALS = 4;
/** Decimal places of unit costs in results: per gram costs are small. */
export const UNIT_COST_DECIMALS = 8;

export const costingPeriods = ["week", "month"] as const;
export type CostingPeriod = (typeof costingPeriods)[number];
export const costingPeriodLabels: Record<CostingPeriod, string> = { week: "Week", month: "Month" };

/** Default report windows: the last 6 months, or the last 13 weeks, up to the current one. */
export const COSTING_DEFAULT_MONTHS = 6;
export const COSTING_DEFAULT_WEEKS = 13;
/** The longest report, in days (two years). */
export const COSTING_MAX_DAYS = 732;
/** Batches one report may cover; narrow the range or filter by product beyond this. */
export const COSTING_REPORT_MAX_BATCHES = 2000;

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface CostingItem extends UnitBridge {
  id: string;
  code: string;
  name: string;
  unit: UnitCode;
  /** Per `unit`; `null` when not costed. */
  standardCost: number | null;
}

export interface CostingBatch {
  id: string;
  batchCode: string;
  status: ProductionBatchStatus;
  outputItemId: string;
  /** Planned output, base unit. */
  plannedQuantity: number;
  recipeVersionId: string;
  /**
   * The date the standard side is priced on: the completion date of a completed batch, else its
   * planned date. Standard costs in force then are used (`CostingGraph.standardCosts`). Omitted:
   * the items' current standard costs.
   */
  costingDate?: string | null;
}

/** A standard cost taking effect on a date (`cost: null` = the item has none from then on). */
export interface StandardCostEntry {
  effectiveFrom: string;
  /** Per the item's own unit. */
  cost: number | null;
}

export interface CostingRecipeVersion {
  id: string;
  yieldQuantity: number;
  yieldUnit: UnitCode;
  lines: readonly { itemId: string; quantity: number; unit: UnitCode }[];
}

/**
 * The net quantity of a lot a batch consumed or produced (base unit), reversals netted off. Rows
 * that net to zero or below are ignored.
 */
export interface CostingFlow {
  batchId: string;
  lotId: string;
  itemId: string;
  kind: "consumption" | "output";
  quantity: number;
}

/** A lot and the accepted purchase receipts that brought it in (none for most lots). */
export interface CostingLot {
  id: string;
  itemId: string;
  lotCode: string;
  /**
   * The day it came in: an unpriced lot is estimated at the standard cost in force then.
   * Omitted: the current standard cost.
   */
  receivedOn?: string | null;
  receipts: readonly {
    /** Base unit. */
    quantity: number;
    /** Per base unit; `null` when the order line had no price. */
    unitPrice: number | null;
    /**
     * Per base unit: the price on the approved supplier invoices for the order line it was
     * received against, when there are any. It takes over from `unitPrice`.
     */
    invoicePrice?: number | null;
    /**
     * It has approved supplier invoices whose price couldn't be put on it (`invoicePricePerBase`):
     * the receipt's price is used and the lot says why (`invoice_unpriced`).
     */
    invoiceUnpriced?: boolean;
    /** Its stock movement was reversed. */
    reversed: boolean;
  }[];
}

/**
 * What the costing reads. `batches` holds the batches whose flows are loaded; a lot made by a batch
 * that isn't in it (further back than the loader went) falls back to standard cost (`too_deep`).
 */
export interface CostingGraph {
  items: ReadonlyMap<string, CostingItem>;
  lots: ReadonlyMap<string, CostingLot>;
  batches: ReadonlyMap<string, CostingBatch>;
  /** Needed for the standard side of the batches being reported on. */
  versions: ReadonlyMap<string, CostingRecipeVersion>;
  flows: readonly CostingFlow[];
  /**
   * Standard cost history by item id, oldest first (`standardCostOn`). Items without history use
   * their current `standardCost`.
   */
  standardCosts?: ReadonlyMap<string, readonly StandardCostEntry[]>;
}

// ─── Unit costs ──────────────────────────────────────────────────────────────

/** An item's standard cost per base unit (g, ml or each), or `null` when it has none. */
export const standardCostPerBase = (item: Pick<CostingItem, "unit" | "standardCost">): number | null =>
  item.standardCost === null || item.standardCost === undefined
    ? null
    : item.standardCost / units[item.unit].toBase;

/**
 * An item's standard cost (per its own unit) in force on a date, from its history (oldest first):
 * the latest entry taking effect on or before it, or, for a date before the first entry, the first
 * (it was never known to be different). Without history, or without a date, the item's current
 * `standardCost`. `null` when the entry says the item has none.
 */
export function standardCostOn(
  item: Pick<CostingItem, "standardCost">,
  history: readonly StandardCostEntry[] | undefined,
  date: string | null | undefined,
): number | null {
  if (!history?.length || !date) return item.standardCost ?? null;
  let entry = history[0]!;
  for (const h of history) {
    if (h.effectiveFrom <= date) entry = h;
    else break;
  }
  return entry.cost;
}

/** A cost per base unit as a cost per the item's own unit (per g → per kg). */
export const costPerItemUnit = (perBase: number, unit: UnitCode): number => perBase * units[unit].toBase;

const money = (value: number) => roundQuantity(value, COST_DECIMALS);
const unitMoney = (value: number) => roundQuantity(value, UNIT_COST_DECIMALS);
const percent = (part: number, whole: number) =>
  whole === 0 ? null : roundQuantity((part / whole) * 100, 1);
const orNull = <T, R>(value: T | null, fn: (v: T) => R): R | null => (value === null ? null : fn(value));

// ─── Lot valuation ───────────────────────────────────────────────────────────

/** A lot's cost per base unit, before rounding. */
interface LotValue extends Reach {
  lotId: string;
  itemId: string;
  source: LotCostSource;
  /** Per base unit; `null` when `missing`. */
  unitCost: number | null;
  /** Share of the unit cost (0..1) that rests on standard costs rather than prices paid. */
  estimatedShare: number;
  /** Rests on a batch still in progress: its cost can still change. */
  provisional: boolean;
  /** False when part of the cost is missing (an item with neither price nor standard cost). */
  complete: boolean;
  missingItemCodes: string[];
  /** The batch that made it (`source: batch`). */
  batchId: string | null;
  reason: LotCostReason | null;
}

/** A batch's actual cost, before rounding. */
interface BatchValue extends Reach {
  batch: CostingBatch;
  lines: { flow: CostingFlow; lot: LotValue; cost: number | null }[];
  materialCost: number;
  estimatedCost: number;
  complete: boolean;
  missingItemCodes: string[];
  provisional: boolean;
  produced: number;
  /** Per base unit of output; `null` when nothing was produced. */
  costPerUnit: number | null;
}

/**
 * How far a value's walk went, so it can be reused safely: `need` is the number of batch stages
 * back it followed, and `depthCut` says the walk ran out of stages (`too_deep`) somewhere beneath.
 * A value with no cut is the same for any remaining depth of at least `need`; one with a cut is
 * the value for that remaining depth only.
 */
interface Reach {
  need: number;
  depthCut: boolean;
}

const deepest = (values: readonly Reach[]) => values.reduce((n, v) => Math.max(n, v.need), 0);

/** Values memoised by id: uncut ones for any depth they reach, cut ones per remaining depth. */
function depthMemo<T extends Reach>() {
  const full = new Map<string, T>();
  const cut = new Map<string, T>();
  return {
    get(id: string, remaining: number): T | undefined {
      const value = full.get(id);
      return value && remaining >= value.need ? value : cut.get(`${id}@${remaining}`);
    },
    set(id: string, remaining: number, value: T) {
      if (value.depthCut) cut.set(`${id}@${remaining}`, value);
      else full.set(id, value);
    },
  };
}

/**
 * The strongly connected components of a graph (Tarjan's algorithm, iterative so a long chain
 * can't overflow the stack): each node's component number.
 */
function components(nodes: Iterable<string>, next: (id: string) => readonly string[]) {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const component = new Map<string, number>();
  let counter = 0;
  let count = 0;
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: { id: string; edges: readonly string[]; at: number }[] = [];
    const open = (id: string) => {
      index.set(id, counter);
      low.set(id, counter);
      counter++;
      stack.push(id);
      onStack.add(id);
      work.push({ id, edges: next(id), at: 0 });
    };
    open(start);
    while (work.length) {
      const frame = work[work.length - 1]!;
      if (frame.at < frame.edges.length) {
        const to = frame.edges[frame.at++]!;
        if (!index.has(to)) open(to);
        else if (onStack.has(to)) low.set(frame.id, Math.min(low.get(frame.id)!, index.get(to)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === index.get(frame.id)) {
        let id: string;
        do {
          id = stack.pop()!;
          onStack.delete(id);
          component.set(id, count);
        } while (id !== frame.id);
        count++;
      }
    }
  }
  return { component, count };
}

/**
 * The costing over one graph. Batch and lot values are memoised, so a report over many batches
 * values each upstream batch once (or once per remaining depth, near the depth limit).
 *
 * A lot's cost: its approved invoice price, else its purchase receipt's price; else, when a batch
 * made it, that batch's actual cost per unit (recursively, so cost flows through WIP into finished goods); else the item's
 * standard cost, flagged as estimated. The walk follows lots back at most `COSTING_MAX_DEPTH`
 * batch stages from the batch (or lot) being costed; a lot made further back falls back to
 * standard cost (`too_deep`). A lot made inside a loop with the batch consuming it falls back to
 * standard cost (`cycle`).
 *
 * A batch's (or lot's) cost depends only on it and the graph, never on what else was costed first:
 * - a lot made by a batch in a loop with the batch consuming it (the same strongly connected
 *   component: rework, or a starter fed back into its own pot) is cut, wherever the walk started:
 *   it is valued at standard cost (`cycle`). With every edge inside a loop cut, the walk never
 *   meets a batch again, so every value can be memoised and a report is linear in the graph
 *   (times the depth, near the limit) however tangled the loops;
 * - values the depth limit cut are memoised per remaining depth (see `depthMemo`).
 */
export function createCostingEngine(graph: CostingGraph) {
  const flowsByBatch = new Map<string, CostingFlow[]>();
  const producersByLot = new Map<string, CostingFlow[]>();
  for (const flow of graph.flows) {
    if (!(flow.quantity > 0)) continue;
    const byBatch = flowsByBatch.get(flow.batchId) ?? [];
    byBatch.push(flow);
    flowsByBatch.set(flow.batchId, byBatch);
    if (flow.kind === "output") {
      const byLot = producersByLot.get(flow.lotId) ?? [];
      byLot.push(flow);
      producersByLot.set(flow.lotId, byLot);
    }
  }
  // Batch → the batches that made what it consumed, and the cycles among them.
  const { component, count } = components(graph.batches.keys(), (batchId) => [
    ...new Set(
      (flowsByBatch.get(batchId) ?? [])
        .filter((f) => f.kind === "consumption")
        .flatMap((f) => producersByLot.get(f.lotId) ?? [])
        .map((f) => f.batchId)
        .filter((id) => graph.batches.has(id)),
    ),
  ]);
  void count;
  /** Batches being costed further up the walk: a safety net; cutting loops means none is met again. */
  const visiting = new Set<string>();
  /**
   * The lot was made by a batch in a loop with the one consuming it (the same strongly connected
   * component, or the batch itself): its cost would feed back into itself, so it is cut.
   */
  const inLoopWith = (consumerId: string, lotId: string) => {
    const at = component.get(consumerId);
    return (producersByLot.get(lotId) ?? []).some(
      (f) => graph.batches.has(f.batchId) && component.get(f.batchId) === at,
    );
  };

  const lotCache = depthMemo<LotValue>();
  const batchCache = depthMemo<BatchValue>();

  const itemOf = (id: string): CostingItem | undefined => graph.items.get(id);

  function fallback(lotId: string, itemId: string, reason: LotCostReason, reach: Reach): LotValue {
    const item = itemOf(itemId);
    // The standard cost in force the day the lot came in (the current one without history).
    const standard = item
      ? standardCostPerBase({
          unit: item.unit,
          standardCost: standardCostOn(
            item,
            graph.standardCosts?.get(itemId),
            graph.lots.get(lotId)?.receivedOn,
          ),
        })
      : null;
    return {
      lotId,
      itemId,
      source: standard === null ? "missing" : "standard",
      unitCost: standard,
      estimatedShare: standard === null ? 0 : 1,
      provisional: false,
      complete: standard !== null,
      missingItemCodes: standard === null ? [item?.code ?? itemId] : [],
      batchId: null,
      reason,
      ...reach,
    };
  }

  /** A lot's cost, following at most `remaining` more batch stages back. */
  function valueLot(lotId: string, itemId: string, remaining: number): LotValue {
    const producers = producersByLot.get(lotId) ?? [];
    const cached = lotCache.get(lotId, remaining);
    if (cached) return cached;
    const remember = (value: LotValue) => {
      lotCache.set(lotId, remaining, value);
      return value;
    };
    const lot = graph.lots.get(lotId);
    // Purchase price: the approved invoice's price where there is one, else the receipt's;
    // weighted over priced receipts, ignoring reversed ones while others remain.
    const priced = (lot?.receipts ?? []).flatMap((r) => {
      const price = r.invoicePrice ?? r.unitPrice;
      return price !== null && r.quantity > 0
        ? [{ ...r, price, invoiced: r.invoicePrice !== null && r.invoicePrice !== undefined }]
        : [];
    });
    const live = priced.filter((r) => !r.reversed);
    const use = live.length ? live : priced;
    if (use.length) {
      const quantity = use.reduce((t, r) => t + r.quantity, 0);
      return remember({
        lotId,
        itemId,
        // `invoice` once every receipt it rests on has an approved invoice price.
        source: use.every((r) => r.invoiced) ? "invoice" : "purchase",
        unitCost: use.reduce((t, r) => t + r.quantity * r.price, 0) / quantity,
        estimatedShare: 0,
        provisional: false,
        complete: true,
        missingItemCodes: [],
        batchId: null,
        reason: use.some((r) => !r.invoiced && r.invoiceUnpriced) ? "invoice_unpriced" : null,
        need: 0,
        depthCut: false,
      });
    }

    if (producers.length) {
      // Out of stages: the depth limit, the same whatever else is costed alongside.
      if (remaining <= 0) return remember(fallback(lotId, itemId, "too_deep", { need: 1, depthCut: true }));
      // Never met with loops cut (see `inLoopWith`); kept so a bug can't recurse forever.
      if (producers.some((f) => visiting.has(f.batchId)))
        return fallback(lotId, itemId, "cycle", { need: 0, depthCut: false });
      let reason: LotCostReason | null = null;
      const followed: BatchValue[] = [];
      const made: { quantity: number; value: BatchValue }[] = [];
      for (const flow of producers) {
        if (!graph.batches.has(flow.batchId)) reason ??= "too_deep";
        else {
          const value = costBatchValue(flow.batchId, remaining - 1);
          followed.push(value);
          if (value.costPerUnit === null) reason ??= "no_output";
          else made.push({ quantity: flow.quantity, value });
        }
      }
      const reach: Reach = { need: 1 + deepest(followed), depthCut: followed.some((v) => v.depthCut) };
      if (reason) return remember(fallback(lotId, itemId, reason, reach));
      const quantity = made.reduce((t, m) => t + m.quantity, 0);
      const weighted = (pick: (v: BatchValue) => number) =>
        made.reduce((t, m) => t + m.quantity * pick(m.value), 0) / quantity;
      return remember({
        lotId,
        itemId,
        source: "batch",
        unitCost: weighted((v) => v.costPerUnit!),
        estimatedShare: weighted((v) => (v.materialCost > 0 ? v.estimatedCost / v.materialCost : 0)),
        provisional: made.some((m) => m.value.provisional),
        complete: made.every((m) => m.value.complete),
        missingItemCodes: [...new Set(made.flatMap((m) => m.value.missingItemCodes))],
        batchId: made[0]!.value.batch.id,
        reason: null,
        ...reach,
      });
    }

    return remember(
      fallback(
        lotId,
        itemId,
        lot?.receipts.some((r) => r.invoiceUnpriced)
          ? "invoice_unpriced"
          : lot?.receipts.length
            ? "no_purchase_price"
            : "not_purchased",
        {
          need: 0,
          depthCut: false,
        },
      ),
    );
  }

  /** A batch's cost, following its lots back at most `remaining` more batch stages. */
  function costBatchValue(batchId: string, remaining: number): BatchValue {
    const batch = graph.batches.get(batchId);
    if (!batch) throw new Error(`Batch ${batchId} is not in the costing graph`);
    const cached = batchCache.get(batchId, remaining);
    if (cached) return cached;
    visiting.add(batchId);
    const flows = flowsByBatch.get(batchId) ?? [];
    const lines = flows
      .filter((f) => f.kind === "consumption")
      .map((flow) => {
        const lot = inLoopWith(batchId, flow.lotId)
          ? fallback(flow.lotId, flow.itemId, "cycle", { need: 0, depthCut: false })
          : valueLot(flow.lotId, flow.itemId, remaining);
        return { flow, lot, cost: lot.unitCost === null ? null : flow.quantity * lot.unitCost };
      });
    visiting.delete(batchId);
    const materialCost = lines.reduce((t, l) => t + (l.cost ?? 0), 0);
    const produced = roundQuantity(
      flows.filter((f) => f.kind === "output").reduce((t, f) => t + f.quantity, 0),
    );
    const value: BatchValue = {
      batch,
      lines,
      materialCost,
      estimatedCost: lines.reduce((t, l) => t + (l.cost ?? 0) * l.lot.estimatedShare, 0),
      complete: lines.every((l) => l.cost !== null && l.lot.complete),
      missingItemCodes: [...new Set(lines.flatMap((l) => l.lot.missingItemCodes))],
      provisional:
        (openBatchStatuses as readonly ProductionBatchStatus[]).includes(batch.status) ||
        lines.some((l) => l.lot.provisional),
      produced,
      costPerUnit: produced > 0 ? materialCost / produced : null,
      need: deepest(lines.map((l) => l.lot)),
      depthCut: lines.some((l) => l.lot.depthCut),
    };
    batchCache.set(batchId, remaining, value);
    return value;
  }

  return {
    /** A lot's cost per the item's own unit, with where it comes from. */
    lotCost(lotId: string): LotCost | null {
      const lot = graph.lots.get(lotId);
      if (!lot) return null;
      return presentLot(valueLot(lotId, lot.itemId, COSTING_MAX_DEPTH), itemOf(lot.itemId));
    },
    /** A batch's actual cost, yield and variances against its recipe version's standard. */
    batchCost(batchId: string): BatchCost {
      return presentBatch(costBatchValue(batchId, COSTING_MAX_DEPTH), graph);
    },
  };
}

// ─── Results ─────────────────────────────────────────────────────────────────

export interface LotCost {
  lotId: string;
  itemId: string;
  source: LotCostSource;
  /** Per the item's own unit (8 places); `null` when `missing`. */
  unitCost: number | null;
  /** The item's unit `unitCost` is per. */
  unit: UnitCode | null;
  /** True when any of the cost rests on standard costs. */
  estimated: boolean;
  /** How much of the cost rests on standard costs, as a percentage (1 decimal). */
  estimatedPercent: number;
  provisional: boolean;
  complete: boolean;
  missingItemCodes: string[];
  batchId: string | null;
  reason: LotCostReason | null;
}

function presentLot(value: LotValue, item: CostingItem | undefined): LotCost {
  return {
    lotId: value.lotId,
    itemId: value.itemId,
    source: value.source,
    unitCost: value.unitCost === null || !item ? null : unitMoney(costPerItemUnit(value.unitCost, item.unit)),
    unit: item?.unit ?? null,
    estimated: value.estimatedShare > 0,
    estimatedPercent: roundQuantity(value.estimatedShare * 100, 1),
    provisional: value.provisional,
    complete: value.complete,
    missingItemCodes: value.missingItemCodes,
    batchId: value.batchId,
    reason: value.reason,
  };
}

/** One consumed lot of a batch. */
export interface BatchCostLine extends LotCost {
  /** Net consumed, base unit. */
  quantity: number;
  /** `quantity` × the lot's cost (4 places); `null` when the lot has no cost. */
  cost: number | null;
  /** The item's standard cost per its own unit, for comparison; `null` when it has none. */
  standardUnitCost: number | null;
}

/** Per ingredient: what the plan needed, what was used, and the variances it causes. */
export interface BatchCostMaterial {
  itemId: string;
  /** On the batch's recipe version. Consumed items that aren't required nothing (`required: 0`). */
  inRecipe: boolean;
  /** For the planned output, base unit; `null` when the recipe line can't be converted. */
  required: number | null;
  /** Net consumed, base unit. */
  consumed: number;
  /** What the consumed lots cost; `null` when any of them has no cost. */
  actualCost: number | null;
  /** Per the item's own unit. */
  standardUnitCost: number | null;
  /** `actualCost` − consumed × standard. */
  priceVariance: number | null;
  /** (consumed − required) × standard. */
  usageVariance: number | null;
  /**
   * The part of `usageVariance` that is the mix: what this ingredient cost at standard for using
   * more or less of it than its share of the inputs actually used, had they been in the plan's
   * proportions (see `mixVariances`). `null` when the batch's mix can't be worked out.
   */
  mixVariance: number | null;
}

export interface CostVariances {
  /** Prices paid against standard prices, for what was used: actual − inputs at standard. */
  price: number | null;
  /** Inputs used against what the plan needed, at standard prices. */
  usage: number | null;
  /**
   * Part of `usage`: the ingredients used in other proportions than the plan's (more of a dearer
   * one, less of a cheaper), at standard prices, holding the total input quantity as used.
   * Separate from `yield`. `null` when an input has no standard cost or no plan quantity.
   */
  mix: number | null;
  /**
   * The rest of `usage` (`usage` − `mix`): using more or less in total than the plan needed,
   * in the plan's proportions. `null` when `mix` is.
   */
  inputQuantity: number | null;
  /** Output short of (or over) the plan, at the standard cost per unit: the yield's cost effect. */
  yield: number | null;
  /** `usage` + `yield`: inputs at standard against the standard cost of what was made. */
  quantity: number | null;
  /** Actual cost − standard cost of what was made (= price + quantity). */
  total: number | null;
}

export interface BatchCost {
  batchId: string;
  status: ProductionBatchStatus;
  /** The output item's unit, which the per-unit costs are per. */
  outputUnit: UnitCode | null;
  lines: BatchCostLine[];
  materials: BatchCostMaterial[];
  /** What the consumed lots cost (the lines that have a cost). */
  actualCost: number;
  /** The part of `actualCost` that rests on standard costs (estimates). */
  estimatedCost: number;
  estimatedPercent: number | null;
  /** False when a consumed lot has no cost at all: `actualCost` is then understated. */
  costComplete: boolean;
  missingItemCodes: string[];
  /** Still in progress, or rests on a batch that is: the figures can still change. */
  provisional: boolean;
  /** Base unit. */
  planned: number;
  produced: number;
  /** Actual cost per output unit (item's own unit); `null` when nothing was produced. */
  costPerUnit: number | null;
  yield: {
    /** `produced − planned`, base unit. */
    difference: number;
    /** `produced ÷ planned` as a percentage (1 decimal). */
    percent: number | null;
  };
  standard: {
    /** The version's standard cost per output unit (item's own unit), from current standard costs. */
    costPerUnit: number | null;
    /** Standard cost of the planned output. */
    plannedCost: number | null;
    /** Standard cost of what was produced: what the actual is compared with. */
    producedCost: number | null;
    /** What was consumed, at standard prices. */
    inputsAtStandard: number | null;
    /** False when a recipe or consumed item has no standard cost, or a line can't be converted. */
    complete: boolean;
    missingItemCodes: string[];
  };
  variance: CostVariances;
  /** `variance.total` ÷ `standard.producedCost`, as a percentage. */
  variancePercent: number | null;
}

/** An ingredient as the mix variance sees it. */
export interface MixInput {
  itemId: string;
  /** Quantities of different dimensions (mass, volume, count) can't be added: each mixes within its own. */
  dimension: ReturnType<typeof unitDimension> | null;
  /** The plan's need, base unit; `null` when the recipe line can't be converted. */
  required: number | null;
  /** Net consumed, base unit. */
  consumed: number;
  /** Standard cost per base unit; `null` when it has none. */
  standard: number | null;
}

/**
 * The mix variance of a batch's inputs, per ingredient: how much the standard cost of what was
 * used differs from what it would have been had the **same total quantity** been used in the
 * plan's proportions. Within one dimension (say, everything weighed in grams), with `A` the total
 * used and `P` the total the plan needed, ingredient `i` has
 * `mix = (consumed − A × required ÷ P) × standard`. Positive is adverse (more of a dearer
 * ingredient, less of a cheaper one). The rest of the usage variance, `(A ÷ P − 1) × required ×
 * standard`, is using more or less in total; the two add up to the usage variance, which is
 * separate from the yield variance (output against the plan).
 *
 * `null` when any ingredient that was needed or used has no standard cost, or no plan quantity,
 * so a partial mix is never presented. An ingredient used though the plan didn't need it counts
 * wholly as mix.
 */
export function mixVariances(inputs: readonly MixInput[]): Map<string, number> | null {
  const active = inputs.filter((i) => i.consumed > 0 || (i.required ?? 0) > 0);
  if (active.some((i) => i.required === null || i.standard === null || i.dimension === null)) return null;
  const totals = new Map<string, { used: number; planned: number }>();
  for (const i of active) {
    const t = totals.get(i.dimension!) ?? { used: 0, planned: 0 };
    t.used += i.consumed;
    t.planned += i.required!;
    totals.set(i.dimension!, t);
  }
  const result = new Map<string, number>();
  for (const i of inputs) {
    const t = i.dimension ? totals.get(i.dimension) : undefined;
    if (!t || !(i.consumed > 0 || (i.required ?? 0) > 0)) {
      result.set(i.itemId, 0);
      continue;
    }
    const share = t.planned > 0 ? i.required! / t.planned : 0;
    result.set(i.itemId, (i.consumed - t.used * share) * i.standard!);
  }
  return result;
}

function presentBatch(value: BatchValue, graph: CostingGraph): BatchCost {
  const { batch } = value;
  const output = graph.items.get(batch.outputItemId);
  const version = graph.versions.get(batch.recipeVersionId);

  // What the plan needed of each ingredient, base units (production's own scaling).
  let required: Map<string, number | null> | null = null;
  if (version && output) {
    const factor = batchFactor(version, output, batch.plannedQuantity);
    const lines = version.lines.map((l) => ({ ...l, item: graph.items.get(l.itemId) }));
    if (lines.every((l) => l.item)) {
      const materials =
        factor === null
          ? lines.map((l) => ({ itemId: l.itemId, required: null }))
          : batchMaterials(
              lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, unit: l.unit, item: l.item! })),
              factor,
            );
      required = new Map(materials.map((m) => [m.itemId, m.required]));
    }
  }

  // The standard side is priced on the batch's own date: the standard costs in force then.
  const standardOf = (item: CostingItem | undefined) =>
    item
      ? standardCostPerBase({
          unit: item.unit,
          standardCost: standardCostOn(item, graph.standardCosts?.get(item.id), batch.costingDate),
        })
      : null;
  const standardMissing = new Set<string>();
  const materialIds = [...(required?.keys() ?? [])];
  for (const line of value.lines)
    if (!materialIds.includes(line.flow.itemId)) materialIds.push(line.flow.itemId);
  let inputsAtStandard: number | null = 0;
  let plannedCost: number | null = required ? 0 : null;
  const materials: BatchCostMaterial[] = [];
  for (const itemId of materialIds) {
    const item = graph.items.get(itemId);
    const standard = standardOf(item);
    const inRecipe = required?.has(itemId) ?? false;
    const need = inRecipe ? required!.get(itemId)! : required ? 0 : null;
    const lines = value.lines.filter((l) => l.flow.itemId === itemId);
    const consumed = roundQuantity(lines.reduce((t, l) => t + l.flow.quantity, 0));
    const actual = lines.some((l) => l.cost === null) ? null : lines.reduce((t, l) => t + l.cost!, 0);
    if (standard === null && (inRecipe || consumed > 0)) standardMissing.add(item?.code ?? itemId);
    if (consumed > 0)
      inputsAtStandard =
        standard === null || inputsAtStandard === null ? null : inputsAtStandard + consumed * standard;
    if (inRecipe)
      plannedCost =
        standard === null || need === null || plannedCost === null ? null : plannedCost + need * standard;
    materials.push({
      itemId,
      inRecipe,
      required: need,
      consumed,
      actualCost: orNull(actual, money),
      standardUnitCost: standard === null || !item ? null : unitMoney(costPerItemUnit(standard, item.unit)),
      priceVariance: actual === null || standard === null ? null : money(actual - consumed * standard),
      usageVariance: need === null || standard === null ? null : money((consumed - need) * standard),
      mixVariance: null,
    });
  }
  const mix = mixVariances(
    materials.map((m) => {
      const item = graph.items.get(m.itemId);
      return {
        itemId: m.itemId,
        dimension: item ? unitDimension(item.unit) : null,
        required: m.required,
        consumed: m.consumed,
        standard: standardOf(item),
      };
    }),
  );
  for (const m of materials) m.mixVariance = orNull(mix?.get(m.itemId) ?? null, money);
  const mixTotal = mix ? [...mix.values()].reduce((t, v) => t + v, 0) : null;
  const planned = batch.plannedQuantity;
  const produced = value.produced;
  const standardPerUnit = plannedCost !== null && planned > 0 ? plannedCost / planned : null;
  const producedCost = standardPerUnit === null ? null : produced * standardPerUnit;
  const actual = value.complete ? value.materialCost : null;
  const usage = inputsAtStandard === null || plannedCost === null ? null : inputsAtStandard - plannedCost;
  const yieldEffect = plannedCost === null || producedCost === null ? null : plannedCost - producedCost;
  const total = actual === null || producedCost === null ? null : actual - producedCost;

  return {
    batchId: batch.id,
    status: batch.status,
    outputUnit: output?.unit ?? null,
    lines: value.lines.map(({ flow, lot, cost }) => {
      const item = graph.items.get(flow.itemId);
      const standard = standardOf(item);
      return {
        ...presentLot(lot, item),
        quantity: roundQuantity(flow.quantity),
        cost: orNull(cost, money),
        standardUnitCost: standard === null || !item ? null : unitMoney(costPerItemUnit(standard, item.unit)),
      };
    }),
    materials,
    actualCost: money(value.materialCost),
    estimatedCost: money(value.estimatedCost),
    estimatedPercent: percent(value.estimatedCost, value.materialCost),
    costComplete: value.complete,
    missingItemCodes: value.missingItemCodes,
    provisional: value.provisional,
    planned,
    produced,
    costPerUnit:
      value.costPerUnit === null || !output
        ? null
        : unitMoney(costPerItemUnit(value.costPerUnit, output.unit)),
    yield: {
      difference: roundQuantity(produced - planned),
      percent: planned > 0 ? percent(produced, planned) : null,
    },
    standard: {
      costPerUnit:
        standardPerUnit === null || !output ? null : unitMoney(costPerItemUnit(standardPerUnit, output.unit)),
      plannedCost: orNull(plannedCost, money),
      producedCost: orNull(producedCost, money),
      inputsAtStandard: orNull(inputsAtStandard, money),
      complete: required !== null && plannedCost !== null && inputsAtStandard !== null,
      missingItemCodes: [...standardMissing],
    },
    variance: {
      price: actual === null || inputsAtStandard === null ? null : money(actual - inputsAtStandard),
      usage: orNull(usage, money),
      mix: usage === null || mixTotal === null ? null : money(mixTotal),
      inputQuantity: usage === null || mixTotal === null ? null : money(usage - mixTotal),
      yield: orNull(yieldEffect, money),
      quantity: usage === null || yieldEffect === null ? null : money(usage + yieldEffect),
      total: orNull(total, money),
    },
    variancePercent: total === null || !producedCost ? null : percent(total, producedCost),
  };
}

// ─── Periods ─────────────────────────────────────────────────────────────────

/** The first day of the period a date falls in. */
export const costingPeriodStart = (isoDate: string, period: CostingPeriod): string =>
  period === "week" ? weekStart(isoDate) : `${isoDate.slice(0, 7)}-01`;

/** The last day of the period a date falls in. */
export function costingPeriodEnd(isoDate: string, period: CostingPeriod): string {
  if (period === "week") return addDays(weekStart(isoDate), 6);
  const [year, month] = [Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7))];
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return addDays(next, -1);
}

/** How a period is written: `2026-W46` or `2026-11`. */
export const costingPeriodLabel = (periodStart: string, period: CostingPeriod): string =>
  period === "week" ? formatWeek(periodStart) : periodStart.slice(0, 7);

/** Every period from the one `from` falls in to the one `to` falls in, as their first days. */
export function costingPeriodsInRange(from: string, to: string, period: CostingPeriod): string[] {
  const out: string[] = [];
  for (let p = costingPeriodStart(from, period); p <= to; p = addDays(costingPeriodEnd(p, period), 1))
    out.push(p);
  return out;
}

const validDate = (year: number, month: number, day: number) => {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
};

/**
 * Reads a report bound: a date (`2026-11-12`), an ISO week (`2026-W46`) or a month (`2026-11`), as
 * its first day (`edge: "start"`) or its last (`"end"`). `null` when it is none of these.
 */
export function parseCostingBound(text: string, edge: "start" | "end"): string | null {
  const value = text.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3])) ? value : null;
  m = /^(\d{4})-?W(\d{1,2})$/i.exec(value);
  if (m) {
    const monday = weekStartOf(Number(m[1]), Number(m[2]));
    return monday && (edge === "start" ? monday : addDays(monday, 6));
  }
  m = /^(\d{4})-(\d{2})$/.exec(value);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    const first = `${m[1]}-${m[2]}-01`;
    return edge === "start" ? first : costingPeriodEnd(first, "month");
  }
  return null;
}

/**
 * The report window, widened to whole periods: default the last `COSTING_DEFAULT_MONTHS` months or
 * `COSTING_DEFAULT_WEEKS` weeks up to the current one. `error` (answer 400) when a bound can't be
 * read, `to` is before `from`, or it is longer than two years.
 */
export function costingReportRange(
  query: { period: CostingPeriod; from?: string | undefined; to?: string | undefined },
  today: string,
): { from: string; to: string; error: string | null } {
  const { period } = query;
  const toBound = query.to ? parseCostingBound(query.to, "end") : costingPeriodEnd(today, period);
  if (!toBound)
    return { from: "", to: "", error: `"${query.to}" is not a date, week (2026-W46) or month (2026-11)` };
  let fromBound: string | null;
  if (query.from) fromBound = parseCostingBound(query.from, "start");
  else if (period === "week") fromBound = addDays(weekStart(toBound), -7 * (COSTING_DEFAULT_WEEKS - 1));
  else {
    let first = costingPeriodStart(toBound, "month");
    for (let i = 1; i < COSTING_DEFAULT_MONTHS; i++) first = costingPeriodStart(addDays(first, -1), "month");
    fromBound = first;
  }
  if (!fromBound)
    return { from: "", to: "", error: `"${query.from}" is not a date, week (2026-W46) or month (2026-11)` };
  const from = costingPeriodStart(fromBound, period);
  const to = costingPeriodEnd(toBound, period);
  const error =
    from > to
      ? "`to` is before `from`"
      : (Date.parse(to) - Date.parse(from)) / 86_400_000 > COSTING_MAX_DAYS
        ? "At most two years at a time"
        : null;
  return { from, to, error };
}

// ─── Standard against actual ─────────────────────────────────────────────────

/** A completed batch as the report needs it. */
export interface CostingReportBatch {
  outputItemId: string;
  /** The completion (sign-off) date: what puts the batch in a period. */
  completedOn: string;
  cost: BatchCost;
  /** The labour and overhead it absorbed (`costing-conversion.ts`); omitted: none. */
  conversion?: BatchConversion | undefined;
}

/** Labour and overhead absorbed by a set of batches: kept apart from the materials in `actualCost`. */
export interface ConversionTotals {
  labour: number;
  overhead: number;
  /** `labour` + `overhead`. */
  total: number;
  /** Batches where a rate needed hours or kilograms the batch lacks, so the amounts are understated. */
  incompleteBatches: number;
}

export interface CostingTotals {
  batches: number;
  /** Batches whose actual cost or standard is incomplete: variances leave them out (see below). */
  incompleteBatches: number;
  actualCost: number;
  estimatedCost: number;
  estimatedPercent: number | null;
  /**
   * Standard cost of what was produced, and the variances, over the complete batches only, so
   * each figure compares like with like; `null` when no batch is complete.
   */
  standardCost: number | null;
  /** Actual cost of the complete batches: what `standardCost` and `variance.total` compare. */
  comparedActualCost: number | null;
  variance: CostVariances;
  variancePercent: number | null;
  /** Labour and overhead absorbed (the rates in force on each batch's completion date). */
  conversion: ConversionTotals;
  /** Materials (`actualCost`) plus conversion: what the batches cost to make. */
  totalCost: number;
}

export interface CostingReportRow extends CostingTotals {
  itemId: string;
  periodStart: string;
  period: string;
  /** Base unit. */
  planned: number;
  produced: number;
  /** Per the item's own unit; `null` when nothing was produced. */
  costPerUnit: number | null;
  /** Standard per unit of the complete batches. */
  standardCostPerUnit: number | null;
  /** `produced ÷ planned` (1 decimal). */
  yieldPercent: number | null;
}

const isComplete = (cost: BatchCost) =>
  cost.costComplete && cost.standard.complete && cost.variance.total !== null;

function totalsOf(batches: readonly CostingReportBatch[]): CostingTotals {
  const complete = batches.filter((b) => isComplete(b.cost));
  const sum = (list: readonly CostingReportBatch[], pick: (c: BatchCost) => number | null) =>
    list.length ? money(list.reduce((t, b) => t + (pick(b.cost) ?? 0), 0)) : null;
  const actualCost = money(batches.reduce((t, b) => t + b.cost.actualCost, 0));
  const estimatedCost = money(batches.reduce((t, b) => t + b.cost.estimatedCost, 0));
  // Every variance of a complete batch is known (see `isComplete`), so these sums are exact.
  const variance: CostVariances = {
    price: sum(complete, (c) => c.variance.price),
    usage: sum(complete, (c) => c.variance.usage),
    mix: sum(complete, (c) => c.variance.mix),
    inputQuantity: sum(complete, (c) => c.variance.inputQuantity),
    yield: sum(complete, (c) => c.variance.yield),
    quantity: sum(complete, (c) => c.variance.quantity),
    total: sum(complete, (c) => c.variance.total),
  };
  const standardCost = sum(complete, (c) => c.standard.producedCost);
  const labour = money(batches.reduce((t, b) => t + (b.conversion?.labour ?? 0), 0));
  const overhead = money(batches.reduce((t, b) => t + (b.conversion?.overhead ?? 0), 0));
  return {
    batches: batches.length,
    incompleteBatches: batches.length - complete.length,
    actualCost,
    estimatedCost,
    estimatedPercent: percent(estimatedCost, actualCost),
    standardCost,
    comparedActualCost: sum(complete, (c) => c.actualCost),
    variance,
    variancePercent: variance.total === null || !standardCost ? null : percent(variance.total, standardCost),
    conversion: {
      labour,
      overhead,
      total: money(labour + overhead),
      incompleteBatches: batches.filter((b) => b.conversion && !b.conversion.complete).length,
    },
    totalCost: money(actualCost + labour + overhead),
  };
}

/**
 * The totals of several sets of batches added together (a frozen period beside live ones). Each
 * figure is the sum of the parts' that have it, `null` when none does, as `totalsOf` does.
 */
export function combineTotals(parts: readonly CostingTotals[]): CostingTotals {
  const total = (pick: (t: CostingTotals) => number) => money(parts.reduce((n, t) => n + pick(t), 0));
  const sum = (pick: (t: CostingTotals) => number | null) => {
    const known = parts.map(pick).filter((v): v is number => v !== null);
    return known.length ? money(known.reduce((n, v) => n + v, 0)) : null;
  };
  const actualCost = total((t) => t.actualCost);
  const estimatedCost = total((t) => t.estimatedCost);
  const variance: CostVariances = {
    price: sum((t) => t.variance.price),
    usage: sum((t) => t.variance.usage),
    mix: sum((t) => t.variance.mix),
    inputQuantity: sum((t) => t.variance.inputQuantity),
    yield: sum((t) => t.variance.yield),
    quantity: sum((t) => t.variance.quantity),
    total: sum((t) => t.variance.total),
  };
  const standardCost = sum((t) => t.standardCost);
  const labour = total((t) => t.conversion.labour);
  const overhead = total((t) => t.conversion.overhead);
  return {
    batches: parts.reduce((n, t) => n + t.batches, 0),
    incompleteBatches: parts.reduce((n, t) => n + t.incompleteBatches, 0),
    actualCost,
    estimatedCost,
    estimatedPercent: percent(estimatedCost, actualCost),
    standardCost,
    comparedActualCost: sum((t) => t.comparedActualCost),
    variance,
    variancePercent: variance.total === null || !standardCost ? null : percent(variance.total, standardCost),
    conversion: {
      labour,
      overhead,
      total: money(labour + overhead),
      incompleteBatches: parts.reduce((n, t) => n + t.conversion.incompleteBatches, 0),
    },
    totalCost: money(actualCost + labour + overhead),
  };
}

export interface CostingReport {
  period: CostingPeriod;
  from: string;
  to: string;
  /** Every period in the window, in order (also those without batches). */
  periods: { periodStart: string; period: string; totals: CostingTotals }[];
  /** One row per product and period with batches, by product (in `itemOrder`) then period. */
  rows: CostingReportRow[];
  totals: CostingTotals;
}

/**
 * Standard against actual by product and period: completed batches grouped by output item and the
 * period of their completion date. Actual cost is every batch's; the standard and the variances
 * are summed over the batches whose figures are complete (`incompleteBatches` counts the rest),
 * so a missing standard cost never turns a partial sum into a false variance.
 */
export function costingReport(input: {
  period: CostingPeriod;
  from: string;
  to: string;
  batches: readonly CostingReportBatch[];
  /** Output item units, for per-unit figures. */
  itemUnits: ReadonlyMap<string, UnitCode>;
  /** Product order of the rows (e.g. by item code); items not listed go last. */
  itemOrder?: readonly string[];
}): CostingReport {
  const { period } = input;
  const inRange = input.batches.filter((b) => b.completedOn >= input.from && b.completedOn <= input.to);
  const groups = new Map<string, CostingReportBatch[]>();
  for (const b of inRange) {
    const key = `${b.outputItemId}|${costingPeriodStart(b.completedOn, period)}`;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  const order = new Map((input.itemOrder ?? []).map((id, i) => [id, i]));
  const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  const rows: CostingReportRow[] = [...groups.entries()]
    .map(([key, batches]) => {
      const [itemId, periodStart] = key.split("|") as [string, string];
      const unit = input.itemUnits.get(itemId);
      const totals = totalsOf(batches);
      const planned = roundQuantity(batches.reduce((t, b) => t + b.cost.planned, 0));
      const produced = roundQuantity(batches.reduce((t, b) => t + b.cost.produced, 0));
      const complete = batches.filter((b) => isComplete(b.cost));
      const producedComplete = complete.reduce((t, b) => t + b.cost.produced, 0);
      const perUnit = (cost: number, quantity: number) =>
        unit && quantity > 0 ? unitMoney(costPerItemUnit(cost / quantity, unit)) : null;
      return {
        ...totals,
        itemId,
        periodStart,
        period: costingPeriodLabel(periodStart, period),
        planned,
        produced,
        costPerUnit: perUnit(totals.actualCost, produced),
        standardCostPerUnit:
          totals.standardCost === null ? null : perUnit(totals.standardCost, producedComplete),
        yieldPercent: planned > 0 ? percent(produced, planned) : null,
      };
    })
    .sort(
      (a, b) =>
        rank(a.itemId) - rank(b.itemId) ||
        a.itemId.localeCompare(b.itemId) ||
        a.periodStart.localeCompare(b.periodStart),
    );
  return {
    period,
    from: input.from,
    to: input.to,
    periods: costingPeriodsInRange(input.from, input.to, period).map((periodStart) => ({
      periodStart,
      period: costingPeriodLabel(periodStart, period),
      totals: totalsOf(inRange.filter((b) => costingPeriodStart(b.completedOn, period) === periodStart)),
    })),
    rows,
    totals: totalsOf(inRange),
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

const isoDate = z.iso.date();
const bound = z.string().trim().min(1).max(20);

/**
 * `GET /costing/batches`: batches with their cost. The date is the batch's costing date: its
 * completion date when completed, else its planned date. Planned batches have no cost and are
 * never listed.
 */
export const costingBatchListStatuses = ["completed", "in_progress", "cancelled", "all"] as const;
export type CostingBatchListStatus = (typeof costingBatchListStatuses)[number];
export const costingBatchListQuerySchema = z
  .object({
    status: z.enum(costingBatchListStatuses).default("completed"),
    from: isoDate.optional(),
    to: isoDate.optional(),
    outputItemId: z.uuid().optional(),
    recipeId: z.uuid().optional(),
    /** Batch code, recipe code or name. */
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ["to"], message: "`to` is before `from`" });
export type CostingBatchListQuery = z.infer<typeof costingBatchListQuerySchema>;

/** `GET /costing/report`: standard against actual (`costingReportRange` reads the bounds). */
export const costingReportQuerySchema = z.object({
  period: z.enum(costingPeriods).default("month"),
  /** A date, ISO week (`2026-W46`) or month (`2026-11`). */
  from: bound.optional(),
  to: bound.optional(),
  outputItemId: z.uuid().optional(),
  recipeId: z.uuid().optional(),
});
export type CostingReportQuery = z.infer<typeof costingReportQuerySchema>;

// ─── Standard cost history, valuation, adjustments ───────────────────────────

/**
 * `PUT /costing/standard-costs`: an item's standard cost from a date (`cost: null`: none from then
 * on). The standard side of a batch uses the cost in force on its completion date. Setting a date
 * that already has an entry replaces it. Changing an item's standard cost on the item itself adds
 * an entry effective today, so history builds up on its own.
 */
export const standardCostSetSchema = z.object({
  itemId: z.uuid(),
  effectiveFrom: isoDate,
  cost: z.number().min(0).max(1_000_000_000).nullable(),
  note: z.string().trim().max(500).nullish(),
});
export type StandardCostSetInput = z.infer<typeof standardCostSetSchema>;

/** `GET /costing/valuation`: stock on hand valued at lot cost. */
export const costingValuationQuerySchema = z.object({
  itemType: z.enum(itemTypes).optional(),
  status: z.enum(["available", "quarantine", "rejected"]).optional(),
  q: z.string().trim().max(200).optional(),
});
export type CostingValuationQuery = z.infer<typeof costingValuationQuerySchema>;

/** `GET /costing/adjustments`: waste and stock adjustments costed (`from`/`to`: date, week or month). */
export const costingAdjustmentsQuerySchema = z.object({
  from: bound.optional(),
  to: bound.optional(),
  itemId: z.uuid().optional(),
});
export type CostingAdjustmentsQuery = z.infer<typeof costingAdjustmentsQuerySchema>;
