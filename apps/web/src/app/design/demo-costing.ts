import {
  absorbConversion,
  createCostingEngine,
  stockAmount,
  type CostingBatch,
  type CostingFlow,
  type CostingItem,
  type CostingLot,
  type CostingRecipeVersion,
} from "@knotworking/core";
import type { BatchCostDetail } from "@/lib/api";

/**
 * A lemon cake batch for the `/design` showcase, costed by the real engine and shaped like the
 * API's `GET /costing/batches/:id`: flour bought at 0.90 a kg (standard 0.80), sugar from opening
 * stock (no price, so standard cost, estimated), lemon curd made in house by an earlier batch (at
 * that batch's 4.50 a kg, against a standard of 4.00), and 22 cakes made of the 24 planned.
 */

const at = "2026-11-10T09:30:00.000Z";
type DemoItem = CostingItem & { type: "ingredient" | "wip" | "finished" };
const items: DemoItem[] = [
  { id: "item-flour", code: "FLR", name: "Flour", unit: "kg", standardCost: 0.8, type: "ingredient" },
  { id: "item-sugar", code: "SUG", name: "Sugar", unit: "kg", standardCost: 1.2, type: "ingredient" },
  { id: "item-lemons", code: "LEM", name: "Lemons", unit: "kg", standardCost: 2.5, type: "ingredient" },
  { id: "item-curd", code: "CURD", name: "Lemon curd", unit: "kg", standardCost: 4, type: "wip" },
  { id: "item-cake", code: "CAKE", name: "Lemon cake", unit: "each", standardCost: null, type: "finished" },
];
const lots: CostingLot[] = [
  {
    id: "lot-flour",
    itemId: "item-flour",
    lotCode: "FL-2611",
    receipts: [{ quantity: 25_000, unitPrice: 0.0009, reversed: false }],
  },
  {
    id: "lot-lemons",
    itemId: "item-lemons",
    lotCode: "LEM-2611",
    receipts: [{ quantity: 10_000, unitPrice: 0.003, reversed: false }],
  },
  { id: "lot-sugar", itemId: "item-sugar", lotCode: "SUG-OPEN", receipts: [] },
  { id: "lot-curd", itemId: "item-curd", lotCode: "B261109-1", receipts: [] },
];
const batches: CostingBatch[] = [
  {
    id: "batch-curd",
    batchCode: "B261109-1",
    status: "completed",
    outputItemId: "item-curd",
    plannedQuantity: 2000,
    recipeVersionId: "version-curd",
  },
  {
    id: "batch-cake",
    batchCode: "B261110-1",
    status: "completed",
    outputItemId: "item-cake",
    plannedQuantity: 24,
    recipeVersionId: "version-cake",
  },
];
const cakeVersion: CostingRecipeVersion = {
  id: "version-cake",
  yieldQuantity: 12,
  yieldUnit: "each",
  lines: [
    { itemId: "item-flour", quantity: 1.5, unit: "kg" },
    { itemId: "item-sugar", quantity: 500, unit: "g" },
    { itemId: "item-curd", quantity: 500, unit: "g" },
  ],
};
const flows: CostingFlow[] = [
  { batchId: "batch-curd", lotId: "lot-lemons", itemId: "item-lemons", kind: "consumption", quantity: 3000 },
  { batchId: "batch-curd", lotId: "lot-curd", itemId: "item-curd", kind: "output", quantity: 2000 },
  { batchId: "batch-cake", lotId: "lot-flour", itemId: "item-flour", kind: "consumption", quantity: 3000 },
  { batchId: "batch-cake", lotId: "lot-sugar", itemId: "item-sugar", kind: "consumption", quantity: 1000 },
  { batchId: "batch-cake", lotId: "lot-curd", itemId: "item-curd", kind: "consumption", quantity: 1000 },
  { batchId: "batch-cake", lotId: "lot-cake", itemId: "item-cake", kind: "output", quantity: 22 },
];

const engine = createCostingEngine({
  items: new Map(items.map((i) => [i.id, i])),
  lots: new Map(lots.map((l) => [l.id, l])),
  batches: new Map(batches.map((b) => [b.id, b])),
  versions: new Map([[cakeVersion.id, cakeVersion]]),
  flows,
});

const summary = (id: string) => {
  const i = items.find((x) => x.id === id)!;
  return { id: i.id, code: i.code, name: i.name, type: i.type, unit: i.unit, status: "active" as const };
};
const cost = engine.batchCost("batch-cake");
const cake = summary("item-cake");

export const demoBatchCost: BatchCostDetail = {
  batch: {
    id: "batch-cake",
    batchCode: "B261110-1",
    status: "completed",
    plannedOn: "2026-11-10",
    completedAt: at,
    completedOn: "2026-11-10",
    recipe: { id: "recipe-cake", code: "R-CAKE", name: "Lemon cake" },
    recipeVersion: {
      id: "version-cake",
      versionNumber: 2,
      status: "approved",
      yieldQuantity: 12,
      yieldUnit: "each",
    },
    outputItem: cake,
  },
  ...cost,
  conversion: absorbConversion({
    hours: 3,
    kg: 2,
    rate: { labourPerHour: 12, labourPerKg: 0, overheadPerHour: 4, overheadPerKg: 0 },
  }),
  planned: stockAmount(cost.planned, cake),
  produced: stockAmount(cost.produced, cake),
  yield: { ...cost.yield, difference: stockAmount(cost.yield.difference, cake) },
  lines: cost.lines.map((line) => {
    const item = summary(line.itemId);
    const madeBy = batches.find((b) => b.id === line.batchId);
    return {
      ...line,
      quantity: stockAmount(line.quantity, item),
      lotCode: lots.find((l) => l.id === line.lotId)?.lotCode ?? null,
      item,
      sourceBatch: madeBy ? { id: madeBy.id, batchCode: madeBy.batchCode, status: madeBy.status } : null,
    };
  }),
  materials: cost.materials.map((m) => {
    const item = summary(m.itemId);
    return {
      ...m,
      item,
      required: m.required === null ? null : stockAmount(m.required, item),
      consumed: stockAmount(m.consumed, item),
    };
  }),
};
