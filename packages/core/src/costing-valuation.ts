import { roundQuantity, units, type UnitCode } from "./items";
import type { LotStatus } from "./stock";

/**
 * Stock valuation and the cost of waste and stock adjustments. Pure functions over lot costs the
 * costing engine already worked out (`createCostingEngine().lotCost`): a lot is valued at its
 * cost per unit (invoice or purchase price, the batch that made it, or the standard cost, each
 * flagged as the engine does), so the valuation, a batch's cost and the waste figures agree.
 * Materials only: absorbed labour and overhead (`costing-conversion.ts`) are not in a lot's cost.
 * No DOM or Node APIs.
 */

const money = (value: number) => roundQuantity(value, 4);

/** What the valuation needs of a lot's cost (`LotCost`). */
export interface ValuationCost {
  /** Per the item's own unit; `null` when the lot has no cost. */
  unitCost: number | null;
  source: string;
  estimatedPercent: number;
  provisional: boolean;
}

export interface ValuationLotInput {
  lotId: string;
  lotCode: string;
  itemId: string;
  status: LotStatus;
  receivedOn: string;
  expiresOn: string | null;
  /** On hand across locations, base unit (positive). */
  quantity: number;
  cost: ValuationCost | null;
}

export interface ValuationLot extends ValuationLotInput {
  /** `quantity` × the lot's cost (4 places); `null` when the lot has no cost. */
  value: number | null;
  /** The part of `value` resting on standard costs (estimates). */
  estimatedValue: number;
}

export interface ValuationItem {
  itemId: string;
  lots: number;
  /** Base unit. */
  quantity: number;
  value: number;
  estimatedValue: number;
  /** Lots with no cost at all: left out of `value`. */
  unvaluedLots: number;
  /** Quantity of those lots, base unit. */
  unvaluedQuantity: number;
}

export interface ValuationTotals {
  lots: number;
  value: number;
  estimatedValue: number;
  unvaluedLots: number;
  /** `value` by the lot's QA status (available, quarantine, rejected). */
  byStatus: Record<LotStatus, number>;
}

export interface StockValuation {
  lots: ValuationLot[];
  items: ValuationItem[];
  totals: ValuationTotals;
}

/** `quantity` (base unit) × `unitCost` (per the item's own unit), without rounding. */
export const valueOf = (quantity: number, unitCost: number, unit: UnitCode): number =>
  (quantity / units[unit].toBase) * unitCost;

/**
 * Stock on hand valued per lot, and rolled up per item: lots in the order given, items in the
 * order of their first lot. A lot without a cost is counted (`unvaluedLots`) but adds nothing,
 * so the total is never presented as complete when it isn't.
 */
export function stockValuation(input: {
  lots: readonly ValuationLotInput[];
  units: ReadonlyMap<string, UnitCode>;
}): StockValuation {
  const lots: ValuationLot[] = input.lots.map((lot) => {
    const unit = input.units.get(lot.itemId);
    const value =
      lot.cost?.unitCost != null && unit ? money(valueOf(lot.quantity, lot.cost.unitCost, unit)) : null;
    return {
      ...lot,
      value,
      estimatedValue: value === null ? 0 : money((value * (lot.cost?.estimatedPercent ?? 0)) / 100),
    };
  });
  const items = new Map<string, ValuationItem>();
  const totals: ValuationTotals = {
    lots: lots.length,
    value: 0,
    estimatedValue: 0,
    unvaluedLots: 0,
    byStatus: { available: 0, quarantine: 0, rejected: 0 },
  };
  for (const lot of lots) {
    const item = items.get(lot.itemId) ?? {
      itemId: lot.itemId,
      lots: 0,
      quantity: 0,
      value: 0,
      estimatedValue: 0,
      unvaluedLots: 0,
      unvaluedQuantity: 0,
    };
    item.lots += 1;
    item.quantity = roundQuantity(item.quantity + lot.quantity);
    if (lot.value === null) {
      item.unvaluedLots += 1;
      item.unvaluedQuantity = roundQuantity(item.unvaluedQuantity + lot.quantity);
      totals.unvaluedLots += 1;
    } else {
      item.value = money(item.value + lot.value);
      item.estimatedValue = money(item.estimatedValue + lot.estimatedValue);
      totals.value = money(totals.value + lot.value);
      totals.estimatedValue = money(totals.estimatedValue + lot.estimatedValue);
      totals.byStatus[lot.status] = money(totals.byStatus[lot.status] + lot.value);
    }
    items.set(lot.itemId, item);
  }
  return { lots, items: [...items.values()], totals };
}

// ─── Waste and stock adjustments ─────────────────────────────────────────────

/** Ledger movement types that write stock off or correct it (`stock.ts`). */
export const adjustmentCostTypes = ["waste", "adjustment", "stocktake"] as const;
export type AdjustmentCostType = (typeof adjustmentCostTypes)[number];
export const adjustmentCostTypeLabels: Record<AdjustmentCostType, string> = {
  waste: "Waste",
  adjustment: "Stock adjustments",
  stocktake: "Stocktake differences",
};

/** A ledger movement of one of those types (reversals are rows of their own and net off). */
export interface AdjustmentMovement {
  type: AdjustmentCostType;
  itemId: string;
  /** Signed, base unit: negative takes stock out. */
  quantity: number;
  /** The cost of the lot it was posted to, per the item's own unit; `null` when it has none. */
  unitCost: number | null;
}

export interface AdjustmentCostLine {
  type: AdjustmentCostType;
  itemId: string;
  /** Net signed quantity, base unit. */
  quantity: number;
  /** Value written off: positive is a loss, negative a gain (an adjustment or stocktake up). */
  loss: number;
  /** Net quantity of movements on lots with no cost: not in `loss`. */
  unvaluedQuantity: number;
  movements: number;
}

export interface AdjustmentCostTotals {
  /** Value lost to waste. */
  waste: number;
  /** Net loss from manual stock adjustments (negative when they added more than they took). */
  adjustment: number;
  /** Net loss from stocktake differences. */
  stocktake: number;
  /** `waste` + `adjustment` + `stocktake`. */
  total: number;
  /** A movement was on a lot with no cost: the totals are understated. */
  incomplete: boolean;
  movements: number;
}

export const noAdjustmentCosts: AdjustmentCostTotals = {
  waste: 0,
  adjustment: 0,
  stocktake: 0,
  total: 0,
  incomplete: false,
  movements: 0,
};

/**
 * What waste and stock adjustments cost: each movement valued at its lot's cost (`loss` =
 * −quantity × cost per base unit), summed per type and item. Reversals are movements too, with
 * the opposite sign, so a corrected entry nets to nothing.
 */
export function adjustmentCosts(input: {
  movements: readonly AdjustmentMovement[];
  units: ReadonlyMap<string, UnitCode>;
}): { lines: AdjustmentCostLine[]; totals: AdjustmentCostTotals } {
  const lines = new Map<string, AdjustmentCostLine>();
  const totals: AdjustmentCostTotals = { ...noAdjustmentCosts };
  for (const m of input.movements) {
    const unit = input.units.get(m.itemId);
    const key = `${m.type}|${m.itemId}`;
    const line = lines.get(key) ?? {
      type: m.type,
      itemId: m.itemId,
      quantity: 0,
      loss: 0,
      unvaluedQuantity: 0,
      movements: 0,
    };
    line.movements += 1;
    line.quantity = roundQuantity(line.quantity + m.quantity);
    if (m.unitCost === null || !unit) {
      line.unvaluedQuantity = roundQuantity(line.unvaluedQuantity + m.quantity);
      totals.incomplete = true;
    } else {
      line.loss = money(line.loss - valueOf(m.quantity, m.unitCost, unit));
    }
    totals.movements += 1;
    lines.set(key, line);
  }
  for (const line of lines.values()) totals[line.type] = money(totals[line.type] + line.loss);
  totals.total = money(totals.waste + totals.adjustment + totals.stocktake);
  const order = (type: AdjustmentCostType) => adjustmentCostTypes.indexOf(type);
  return {
    lines: [...lines.values()].sort(
      (a, b) => order(a.type) - order(b.type) || b.loss - a.loss || a.itemId.localeCompare(b.itemId),
    ),
    totals,
  };
}
