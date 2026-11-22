import {
  absorbConversion,
  absorptionRateOn,
  batchRunHours,
  COSTING_MAX_DEPTH,
  createCostingEngine,
  outputKilograms,
  type AbsorptionRateEntry,
  stockAmount,
  UNIT_COST_DECIMALS,
  convertUnitPrice,
  creditTotals,
  invoicePricePerBase,
  itemBaseUnit,
  type ApprovedCreditTotals,
  type ApprovedInvoicePriceLine,
  type BatchCost,
  type CostingBatch,
  type CostingBatchListQuery,
  type CostingFlow,
  type CostingGraph,
  type CostingItem,
  type CostingLot,
  type CostingRecipeVersion,
  dateInZone,
  endOfDayInZone,
  startOfDayInZone,
} from "@knotworking/core";
import {
  items,
  productionBatches,
  productionRecords,
  purchaseOrders,
  purchaseReceipts,
  recipeLines,
  recipes,
  recipeVersions,
  stockLots,
  stockMovements,
  type Executor,
} from "@knotworking/db";
import { alias } from "drizzle-orm/pg-core";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { badRequest } from "../errors";
import { absorptionRateEntries, standardCostHistory } from "./costing-settings";
import { workspaceTimeZone } from "./time-zone";
import { findBatch } from "./ports/production";
import { approvedCreditLines } from "./purchase-credit-notes";
import { approvedInvoiceLines } from "./ports/purchase-invoices";
import { findLot, itemSummary, num } from "./ports/stock";

/**
 * Costing module: actual batch cost, yield and standard against actual. **Computed on read**, from
 * the append-only records the other modules keep, and never stored:
 *
 * - batch records (production): what each batch consumed and produced, reversals netted off;
 * - purchase receipts (purchasing): the price per base unit of each lot bought against an order,
 *   frozen when it was received; and approved supplier invoices for the order line, whose matched
 *   price takes over from it (the receipt itself is append-only and never changed);
 * - item standard costs (items): the fallback for lots with no price, and the standard side;
 * - recipe versions (recipes): what the plan needed.
 *
 * A stored snapshot would go stale: a completed batch's records can still be corrected (a person
 * with `manage` reverses them), and a lot's cost depends on the batches upstream of it. The core
 * engine (`createCostingEngine`) does the arithmetic; this file loads the part of the ledger it
 * needs, following lots back through the batches that made them up to `COSTING_MAX_DEPTH` stages.
 */

type BatchRow = typeof productionBatches.$inferSelect;
type ItemRow = typeof items.$inferSelect;
type LotRow = typeof stockLots.$inferSelect;

const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
const reversal = alias(stockMovements, "reversal");

/** The date of a timestamp in the workspace's time zone. */
const localDate = (at: Date | null, timeZone: string) => (at ? dateInZone(at, timeZone) : null);

/**
 * A completed batch's costing date is its completion date (in the workspace's time zone); any other
 * batch's its planned date. Filters compare the completion instant with the local day's bounds
 * (`costingDateFrom`, `costingDateTo`); this expression only orders the list, and compares dates with
 * dates (the completion's local date, bound to the zone, against the planned date).
 */
const costingOrder = (timeZone: string) =>
  sql<string>`coalesce((${productionBatches.completedAt} at time zone ${timeZone})::date, ${productionBatches.plannedOn})`;
const costingDateFrom = (from: string, timeZone: string) =>
  or(
    and(
      isNotNull(productionBatches.completedAt),
      gte(productionBatches.completedAt, startOfDayInZone(from, timeZone)),
    ),
    and(isNull(productionBatches.completedAt), gte(productionBatches.plannedOn, from)),
  );
const costingDateTo = (to: string, timeZone: string) =>
  or(
    and(
      isNotNull(productionBatches.completedAt),
      lt(productionBatches.completedAt, endOfDayInZone(to, timeZone)),
    ),
    and(isNull(productionBatches.completedAt), lte(productionBatches.plannedOn, to)),
  );

const hasRecords = sql`exists (select 1 from ${productionRecords} where ${productionRecords.batchId} = ${productionBatches.id})`;

// ─── Loading the ledger ──────────────────────────────────────────────────────

/** Ids per `IN (...)` list: Postgres takes at most 65,535 bind parameters a query. */
const ID_CHUNK = 5000;

/** `read` over `ids` in chunks of `ID_CHUNK`, one query after another, rows concatenated. */
async function inChunks<T>(ids: readonly string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let at = 0; at < ids.length; at += ID_CHUNK) {
    for (const row of await read(ids.slice(at, at + ID_CHUNK))) rows.push(row);
  }
  return rows;
}

/**
 * Per order line, its lines on approved invoices and which invoices, read in chunks (`inChunks`).
 * Order lines without an approved invoice are absent.
 */
async function approvedInvoices(db: Executor, workspaceId: string, orderLineIds: readonly string[]) {
  const rows = await inChunks([...new Set(orderLineIds)], (ids) =>
    approvedInvoiceLines(db, workspaceId, ids),
  );
  const credits = await inChunks([...new Set(orderLineIds)], (ids) =>
    approvedCreditLines(db, workspaceId, ids),
  );
  const creditsByLine = new Map<string, typeof credits>();
  for (const c of credits)
    creditsByLine.set(c.orderLineId!, [...(creditsByLine.get(c.orderLineId!) ?? []), c]);
  const map = new Map<
    string,
    {
      lines: ApprovedInvoicePriceLine[];
      invoices: { id: string; invoiceNumber: string; version: number }[];
      /** What approved credit notes took off these lines (value, units returned). */
      credits: ApprovedCreditTotals | null;
    }
  >();
  for (const r of rows) {
    const entry = map.get(r.orderLineId!) ?? {
      lines: [],
      invoices: [],
      credits: creditsByLine.has(r.orderLineId!) ? creditTotals(creditsByLine.get(r.orderLineId!)!) : null,
    };
    entry.lines.push({ quantity: r.quantity, unitPrice: r.unitPrice, approvedMatch: r.approvedMatch });
    if (!entry.invoices.some((i) => i.id === r.invoiceId))
      entry.invoices.push({ id: r.invoiceId, invoiceNumber: r.invoiceNumber, version: r.version });
    map.set(r.orderLineId!, entry);
  }
  return map;
}

/** A receipt's approved invoice price per base unit (null when none), and whether one couldn't be priced. */
const receiptInvoicePrice = (
  invoiced: Awaited<ReturnType<typeof approvedInvoices>>,
  receipt: { lineId: string; unitPrice: number | null },
) => {
  const entry = invoiced.get(receipt.lineId);
  return entry
    ? invoicePricePerBase(entry.lines, receipt.unitPrice, entry.credits)
    : { pricePerBase: null, unpriced: false };
};

/** Net quantity per batch, lot, item and kind (reversals cancel what they reverse). */
async function netFlows(db: Executor, where: SQL): Promise<CostingFlow[]> {
  const rows = await db
    .select({
      batchId: productionRecords.batchId,
      lotId: productionRecords.lotId,
      itemId: productionRecords.itemId,
      kind: productionRecords.kind,
      total: sql<string>`sum(${productionRecords.quantity})`,
    })
    .from(productionRecords)
    .where(where)
    .groupBy(
      productionRecords.batchId,
      productionRecords.lotId,
      productionRecords.itemId,
      productionRecords.kind,
    )
    .having(sql`sum(${productionRecords.quantity}) > 0`);
  return rows.map((r) => ({ ...r, quantity: num(r.total) }));
}

const toCostingItem = (row: ItemRow): CostingItem => ({
  id: row.id,
  code: row.code,
  name: row.name,
  unit: row.unit,
  standardCost: row.standardCost,
  densityGPerMl: row.densityGPerMl,
  unitWeightG: row.unitWeightG,
});

const toCostingBatch = (row: BatchRow, timeZone: string): CostingBatch => ({
  id: row.id,
  batchCode: row.batchCode,
  status: row.status,
  outputItemId: row.outputItemId,
  plannedQuantity: row.plannedQuantity,
  recipeVersionId: row.recipeVersionId,
  // The standard side is priced on the completion date (the planned date until then).
  costingDate: localDate(row.completedAt, timeZone) ?? row.plannedOn,
});

/**
 * The part of the ledger that values `batchIds` (and `lotIds`): their flows, the lots they
 * consumed with their purchase receipts, the batches that made those lots, and so on back up to
 * `COSTING_MAX_DEPTH` stages. Versions are loaded for `batchIds` only (the standard side).
 */
export async function loadGraph(
  db: Executor,
  workspaceId: string,
  batchIds: string[],
  lotIds: string[] = [],
) {
  const timeZone = await workspaceTimeZone(db, workspaceId);
  const batches = new Map<string, BatchRow>();
  const lots = new Map<string, LotRow>();
  const flows = new Map<string, CostingFlow>();
  const receipts = new Map<string, CostingLot["receipts"][number][]>();
  const addFlows = (list: CostingFlow[]) => {
    for (const f of list) flows.set(`${f.batchId}|${f.lotId}|${f.kind}`, f);
  };

  let batchFrontier = [...new Set(batchIds)];
  let lotFrontier = [...new Set(lotIds)];
  for (let depth = 0; depth <= COSTING_MAX_DEPTH; depth++) {
    // Every id list is read in chunks (`inChunks`): a report's frontier can run to many
    // thousands of batches or lots. Flows group by batch and lot, so chunks never split a sum.
    const rows = await inChunks(batchFrontier, (ids) =>
      db
        .select()
        .from(productionBatches)
        .where(and(eq(productionBatches.workspaceId, workspaceId), inArray(productionBatches.id, ids))),
    );
    for (const row of rows) batches.set(row.id, row);
    const loaded = await inChunks(batchFrontier, (ids) =>
      netFlows(db, inArray(productionRecords.batchId, ids)),
    );
    addFlows(loaded);
    for (const f of loaded) if (f.kind === "consumption" && !lots.has(f.lotId)) lotFrontier.push(f.lotId);
    const wanted = [...new Set(lotFrontier)].filter((id) => !lots.has(id));
    batchFrontier = [];
    lotFrontier = [];
    if (wanted.length === 0) break;

    const lotRows = await inChunks(wanted, (ids) =>
      db
        .select()
        .from(stockLots)
        .where(and(eq(stockLots.workspaceId, workspaceId), inArray(stockLots.id, ids))),
    );
    for (const row of lotRows) lots.set(row.id, row);
    const receiptRows = await inChunks(wanted, (ids) =>
      db
        .select({
          lotId: purchaseReceipts.lotId,
          lineId: purchaseReceipts.lineId,
          quantity: purchaseReceipts.quantity,
          unitPrice: purchaseReceipts.unitPrice,
          reversalId: reversal.id,
        })
        .from(purchaseReceipts)
        .leftJoin(reversal, eq(reversal.reversesMovementId, purchaseReceipts.stockMovementId))
        .where(and(inArray(purchaseReceipts.lotId, ids), eq(purchaseReceipts.outcome, "accepted"))),
    );
    // Approved supplier invoices take over from the receipt's (order) price.
    const invoiced = await approvedInvoices(
      db,
      workspaceId,
      receiptRows.map((r) => r.lineId),
    );
    for (const r of receiptRows) {
      const list = receipts.get(r.lotId!) ?? [];
      const price = receiptInvoicePrice(invoiced, r);
      list.push({
        quantity: r.quantity,
        unitPrice: r.unitPrice,
        invoicePrice: price.pricePerBase,
        invoiceUnpriced: price.unpriced,
        reversed: r.reversalId !== null,
      });
      receipts.set(r.lotId!, list);
    }
    const producers = await inChunks(wanted, (ids) =>
      netFlows(db, and(inArray(productionRecords.lotId, ids), eq(productionRecords.kind, "output"))!),
    );
    addFlows(producers);
    batchFrontier = [...new Set(producers.map((f) => f.batchId))].filter((id) => !batches.has(id));
  }

  const rootVersions = [
    ...new Set(batchIds.map((id) => batches.get(id)?.recipeVersionId).filter((v): v is string => !!v)),
  ];
  const versions = await inChunks(rootVersions, (ids) =>
    db.select().from(recipeVersions).where(inArray(recipeVersions.id, ids)),
  );
  // Chunked by version, so each version's lines stay in order.
  const lines = await inChunks(rootVersions, (ids) =>
    db
      .select()
      .from(recipeLines)
      .where(inArray(recipeLines.versionId, ids))
      .orderBy(asc(recipeLines.sortOrder), asc(recipeLines.id)),
  );
  const itemIds = new Set<string>([
    ...[...lots.values()].map((l) => l.itemId),
    ...[...batches.values()].map((b) => b.outputItemId),
    ...[...flows.values()].map((f) => f.itemId),
    ...lines.map((l) => l.itemId),
  ]);
  const itemRows = await inChunks([...itemIds], (ids) =>
    db
      .select()
      .from(items)
      .where(and(eq(items.workspaceId, workspaceId), inArray(items.id, ids))),
  );
  const itemMap = new Map(itemRows.map((r) => [r.id, r]));

  const graph: CostingGraph = {
    items: new Map(itemRows.map((r) => [r.id, toCostingItem(r)])),
    lots: new Map(
      [...lots.values()].map((l) => [
        l.id,
        {
          id: l.id,
          itemId: l.itemId,
          lotCode: l.lotCode,
          receivedOn: l.receivedOn,
          receipts: receipts.get(l.id) ?? [],
        },
      ]),
    ),
    batches: new Map([...batches.values()].map((b) => [b.id, toCostingBatch(b, timeZone)])),
    versions: new Map(
      versions.map((v): [string, CostingRecipeVersion] => [
        v.id,
        {
          id: v.id,
          yieldQuantity: v.yieldQuantity,
          yieldUnit: v.yieldUnit,
          lines: lines
            .filter((l) => l.versionId === v.id)
            .map((l) => ({ itemId: l.itemId, quantity: l.quantity, unit: l.unit })),
        },
      ]),
    ),
    flows: [...flows.values()],
    standardCosts: await standardCostHistory(db, workspaceId, [...itemMap.keys()]),
  };
  return { graph, engine: createCostingEngine(graph), batches, lots, items: itemMap, versions, timeZone };
}

// ─── Labour and overhead ─────────────────────────────────────────────────────

/**
 * The labour and overhead a batch absorbs: the rates in force on its costing date for its line
 * (else the workspace default), over the hours it ran (started to completed) and the kilograms it
 * made. Nothing until it is completed: an open batch has no end to measure.
 */
export function batchConversion(
  row: BatchRow,
  loaded: Loaded,
  rates: readonly AbsorptionRateEntry[],
  produced: number,
) {
  const output = loaded.items.get(row.outputItemId)!;
  const date = localDate(row.completedAt, loaded.timeZone) ?? row.plannedOn;
  return absorbConversion({
    hours: batchRunHours(row.startedAt, row.completedAt),
    kg: outputKilograms(produced, output),
    rate: absorptionRateOn(rates, row.lineId, date),
  });
}

// ─── Presenting ──────────────────────────────────────────────────────────────

export type Loaded = Awaited<ReturnType<typeof loadGraph>>;

const batchRef = (row: BatchRow | undefined) =>
  row ? { id: row.id, batchCode: row.batchCode, status: row.status } : null;

/** A batch's cost with the names, codes and amounts a page or an agent reads. */
function batchCostView(cost: BatchCost, loaded: Loaded) {
  const output = loaded.items.get(loaded.batches.get(cost.batchId)!.outputItemId)!;
  const amount = (itemId: string, base: number) => stockAmount(base, loaded.items.get(itemId)!);
  return {
    ...cost,
    planned: stockAmount(cost.planned, output),
    produced: stockAmount(cost.produced, output),
    yield: { ...cost.yield, difference: stockAmount(cost.yield.difference, output) },
    lines: cost.lines.map((line) => ({
      ...line,
      quantity: amount(line.itemId, line.quantity),
      lotCode: loaded.lots.get(line.lotId)?.lotCode ?? null,
      item: itemSummary(loaded.items.get(line.itemId)!),
      sourceBatch: batchRef(line.batchId ? loaded.batches.get(line.batchId) : undefined),
    })),
    materials: cost.materials.map((m) => ({
      ...m,
      item: itemSummary(loaded.items.get(m.itemId)!),
      required: m.required === null ? null : amount(m.itemId, m.required),
      consumed: amount(m.itemId, m.consumed),
    })),
  };
}

/** The headline figures of a batch's cost, for lists. */
const costSummary = (cost: BatchCost, output: ItemRow) => ({
  actualCost: cost.actualCost,
  estimatedPercent: cost.estimatedPercent,
  costComplete: cost.costComplete,
  provisional: cost.provisional,
  planned: stockAmount(cost.planned, output),
  produced: stockAmount(cost.produced, output),
  yieldPercent: cost.yield.percent,
  costPerUnit: cost.costPerUnit,
  standardCostPerUnit: cost.standard.costPerUnit,
  standardCost: cost.standard.producedCost,
  variance: cost.variance.total,
  variancePercent: cost.variancePercent,
});

async function batchHeaders(db: Executor, rows: BatchRow[], timeZone: string) {
  const recipeIds = [...new Set(rows.map((r) => r.recipeId))];
  const versionIds = [...new Set(rows.map((r) => r.recipeVersionId))];
  const [recipeRows, versionRows] = await Promise.all([
    recipeIds.length
      ? db
          .select({ id: recipes.id, code: recipes.code, name: recipes.name })
          .from(recipes)
          .where(inArray(recipes.id, recipeIds))
      : [],
    versionIds.length
      ? db
          .select({
            id: recipeVersions.id,
            versionNumber: recipeVersions.versionNumber,
            status: recipeVersions.status,
            yieldQuantity: recipeVersions.yieldQuantity,
            yieldUnit: recipeVersions.yieldUnit,
          })
          .from(recipeVersions)
          .where(inArray(recipeVersions.id, versionIds))
      : [],
  ]);
  const recipeMap = new Map(recipeRows.map((r) => [r.id, r]));
  const versionMap = new Map(versionRows.map((v) => [v.id, v]));
  return (row: BatchRow, output: ItemRow) => ({
    id: row.id,
    batchCode: row.batchCode,
    status: row.status,
    plannedOn: row.plannedOn,
    completedAt: row.completedAt,
    completedOn: localDate(row.completedAt, timeZone),
    recipe: recipeMap.get(row.recipeId) ?? null,
    recipeVersion: versionMap.get(row.recipeVersionId) ?? null,
    outputItem: itemSummary(output),
  });
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/**
 * A batch's cost in full: each consumed lot with its cost and where it comes from, per ingredient
 * the plan's need against what was used, the yield, and the variances against the version's
 * standard. Any batch with records can be costed; until it is completed the figures are
 * provisional.
 */
export async function getBatchCost(db: Executor, workspaceId: string, id: string) {
  const row = await findBatch(db, workspaceId, id);
  const loaded = await loadGraph(db, workspaceId, [id]);
  const output = loaded.items.get(row.outputItemId)!;
  const header = await batchHeaders(db, [row], await workspaceTimeZone(db, workspaceId));
  const cost = loaded.engine.batchCost(id);
  const rates = await absorptionRateEntries(db, workspaceId);
  return {
    batch: header(row, output),
    ...batchCostView(cost, loaded),
    /** Labour and overhead absorbed (rates in force on its completion date): apart from the materials above. */
    conversion: batchConversion(row, loaded, rates, cost.produced),
  };
}

/** Batches with records, newest costing date first, each with its headline cost. */
export async function listBatchCosts(db: Executor, workspaceId: string, query: CostingBatchListQuery) {
  const where: (SQL | undefined)[] = [
    eq(productionBatches.workspaceId, workspaceId),
    isNull(productionBatches.deletedAt),
    query.status === "all"
      ? inArray(productionBatches.status, ["in_progress", "completed", "cancelled"])
      : eq(productionBatches.status, query.status),
    hasRecords,
  ];
  const timeZone = await workspaceTimeZone(db, workspaceId);
  if (query.from) where.push(costingDateFrom(query.from, timeZone));
  if (query.to) where.push(costingDateTo(query.to, timeZone));
  if (query.outputItemId) where.push(eq(productionBatches.outputItemId, query.outputItemId));
  if (query.recipeId) where.push(eq(productionBatches.recipeId, query.recipeId));
  if (query.q) {
    where.push(
      or(
        sql`${productionBatches.batchCode} ilike ${like(query.q)} escape '!'`,
        sql`${recipes.code} ilike ${like(query.q)} escape '!'`,
        sql`${recipes.name} ilike ${like(query.q)} escape '!'`,
      ),
    );
  }
  const [rows, [total]] = await Promise.all([
    db
      .select({ batch: productionBatches })
      .from(productionBatches)
      .innerJoin(recipes, eq(recipes.id, productionBatches.recipeId))
      .where(and(...where))
      .orderBy(desc(costingOrder(timeZone)), desc(productionBatches.batchCode), desc(productionBatches.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(productionBatches)
      .innerJoin(recipes, eq(recipes.id, productionBatches.recipeId))
      .where(and(...where)),
  ]);
  const batchRows = rows.map((r) => r.batch);
  const loaded = await loadGraph(
    db,
    workspaceId,
    batchRows.map((b) => b.id),
  );
  const header = await batchHeaders(db, batchRows, timeZone);
  return {
    batches: batchRows.map((row) => {
      const output = loaded.items.get(row.outputItemId)!;
      return {
        ...header(row, output),
        costingDate: localDate(row.completedAt, timeZone) ?? row.plannedOn,
        cost: costSummary(loaded.engine.batchCost(row.id), output),
      };
    }),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

/**
 * What a lot costs per unit and why: its purchase receipts (with the order reference), or the
 * batch that made it, or the standard cost it falls back to.
 */
export async function getLotCost(db: Executor, workspaceId: string, lotId: string) {
  const { lot } = await findLot(db, workspaceId, lotId);
  const loaded = await loadGraph(db, workspaceId, [], [lot.id]);
  const cost = loaded.engine.lotCost(lot.id)!;
  const item = loaded.items.get(lot.itemId)!;
  const receiptRows = await db
    .select({
      receipt: purchaseReceipts,
      reference: purchaseOrders.reference,
      reversalId: reversal.id,
    })
    .from(purchaseReceipts)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseReceipts.purchaseOrderId))
    .leftJoin(reversal, eq(reversal.reversesMovementId, purchaseReceipts.stockMovementId))
    .where(and(eq(purchaseReceipts.lotId, lot.id), eq(purchaseReceipts.outcome, "accepted")))
    .orderBy(asc(purchaseReceipts.receivedOn), asc(purchaseReceipts.id));
  const perItemUnit = (price: number | null) =>
    price === null ? null : convertUnitPrice(price, itemBaseUnit(item), item.unit, item, UNIT_COST_DECIMALS);
  const invoiced = await approvedInvoices(
    db,
    workspaceId,
    receiptRows.map((r) => r.receipt.lineId),
  );
  return {
    lot: { id: lot.id, lotCode: lot.lotCode, status: lot.status, receivedOn: lot.receivedOn },
    item: itemSummary(item),
    standardCost: item.standardCost,
    ...cost,
    sourceBatch: batchRef(cost.batchId ? loaded.batches.get(cost.batchId) : undefined),
    receipts: receiptRows.map(({ receipt, reference, reversalId }) => {
      const price = receiptInvoicePrice(invoiced, receipt);
      return {
        id: receipt.id,
        purchaseOrderId: receipt.purchaseOrderId,
        reference,
        receivedOn: receipt.receivedOn,
        quantity: stockAmount(receipt.quantity, item),
        unitPrice: perItemUnit(receipt.unitPrice),
        /** The approved invoice price (per the item's unit), which takes over from `unitPrice`. */
        invoicePrice: perItemUnit(price.pricePerBase),
        /**
         * It has approved invoices, but their price couldn't be put on it (no order price and the
         * unit didn't convert at approval): the receipt's price stands.
         */
        invoiceUnpriced: price.unpriced,
        invoices: invoiced.get(receipt.lineId)?.invoices ?? [],
        reversed: reversalId !== null,
      };
    }),
  };
}
