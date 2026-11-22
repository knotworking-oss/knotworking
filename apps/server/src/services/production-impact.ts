import { impactLimits, type ImpactBatch, type ImpactReason } from "@knotworking/core";
import { productionBatches, productionRecords, despatchReturns, type Executor } from "@knotworking/db";
import { and, asc, eq, inArray, notInArray, isNull, sql } from "drizzle-orm";
import { findLot } from "./ports/stock";

export interface ForwardImpactLimits {
  lots: number;
  batches: number;
  links: number;
}

/** Net consumption by affected lot, including corrections; batches are explored once. */
async function consumingBatches(
  db: Executor,
  workspaceId: string,
  lotIds: string[],
  seen: string[],
  limit: number,
) {
  return db
    .selectDistinct({
      id: productionBatches.id,
      batchCode: productionBatches.batchCode,
      status: productionBatches.status,
    })
    .from(productionRecords)
    .innerJoin(
      productionBatches,
      and(
        eq(productionBatches.id, productionRecords.batchId),
        eq(productionBatches.workspaceId, workspaceId),
      ),
    )
    .where(
      and(
        eq(productionRecords.workspaceId, workspaceId),
        eq(productionRecords.kind, "consumption"),
        inArray(productionRecords.lotId, lotIds),
        seen.length ? notInArray(productionRecords.batchId, seen) : undefined,
      ),
    )
    .groupBy(
      productionBatches.id,
      productionBatches.batchCode,
      productionBatches.status,
      productionRecords.lotId,
    )
    .having(sql`sum(${productionRecords.quantity}) > 0`)
    .orderBy(asc(productionBatches.id))
    .limit(limit);
}

async function returnedLots(db: Executor, workspaceId: string, lotIds: string[], limit: number) {
  return db
    .select({
      id: despatchReturns.id,
      originalLotId: despatchReturns.originalLotId,
      lotId: despatchReturns.lotId,
      lotCode: despatchReturns.lotCode,
    })
    .from(despatchReturns)
    .where(
      and(
        eq(despatchReturns.workspaceId, workspaceId),
        inArray(despatchReturns.originalLotId, lotIds),
        isNull(despatchReturns.voidedAt),
      ),
    )
    .orderBy(asc(despatchReturns.id))
    .limit(limit);
}
/** Production's public forward read model. The caller supplies a consistent read transaction. */
export async function traceForwardProduction(
  db: Executor,
  workspaceId: string,
  rootLotId: string,
  depth: number,
  limits: ForwardImpactLimits = impactLimits,
) {
  await findLot(db, workspaceId, rootLotId);
  const lots = new Map([[rootLotId, 0]]);
  const batches = new Map<string, ImpactBatch>();
  const reasons = new Set<ImpactReason>();
  const returnLinks: { id: string; originalLotId: string; lotId: string; lotCode: string }[] = [];
  let frontier = [rootLotId];
  let links = 0;
  let bounded = false;
  for (let step = 0; step < depth && frontier.length; step++) {
    const remaining = limits.batches - batches.size;
    const found = await consumingBatches(db, workspaceId, frontier, [...batches.keys()], remaining + 1);
    if (found.length > remaining) {
      reasons.add("batch_limit");
      bounded = true;
    }
    const selected = found.slice(0, remaining);
    for (const b of selected) {
      batches.set(b.id, { ...b, depth: step + 1, outputLinks: 0 });
      if (b.status === "planned" || b.status === "in_progress") reasons.add("open_batches");
    }
    const outputBudget = limits.links - links;
    const rows = !selected.length
      ? []
      : await db
          .select({ batchId: productionRecords.batchId, lotId: productionRecords.lotId })
          .from(productionRecords)
          .where(
            and(
              eq(productionRecords.workspaceId, workspaceId),
              eq(productionRecords.kind, "output"),
              inArray(
                productionRecords.batchId,
                selected.map((b) => b.id),
              ),
            ),
          )
          .groupBy(productionRecords.batchId, productionRecords.lotId)
          .having(sql`sum(${productionRecords.quantity}) > 0`)
          .orderBy(asc(productionRecords.batchId), asc(productionRecords.lotId))
          .limit(outputBudget + 1);
    const outputLimited = rows.length > outputBudget;
    if (outputLimited) {
      reasons.add("link_limit");
      bounded = true;
    }
    const next: string[] = [];
    for (const o of rows.slice(0, outputBudget)) {
      links++;
      batches.get(o.batchId)!.outputLinks++;
      if (!lots.has(o.lotId)) {
        if (lots.size >= limits.lots) {
          reasons.add("lot_limit");
          bounded = true;
          continue;
        }
        lots.set(o.lotId, step + 1);
        next.push(o.lotId);
      }
    }
    if (!outputLimited && selected.some((b) => batches.get(b.id)!.outputLinks === 0))
      reasons.add("missing_output");
    const returnBudget = Math.max(0, limits.links - links);
    const returned = await returnedLots(db, workspaceId, frontier, returnBudget + 1);
    if (returned.length > returnBudget) {
      reasons.add("link_limit");
      bounded = true;
    }
    for (const ret of returned.slice(0, returnBudget)) {
      links++;
      returnLinks.push(ret);
      if (!lots.has(ret.lotId)) {
        if (lots.size >= limits.lots) {
          reasons.add("lot_limit");
          bounded = true;
          continue;
        }
        lots.set(ret.lotId, step + 1);
        next.push(ret.lotId);
      }
    }
    frontier = next;
    if (bounded) break;
  }
  // Reaching the selected depth is only a limit if unexplored production really remains.
  if (
    !bounded &&
    frontier.length &&
    ((await consumingBatches(db, workspaceId, frontier, [...batches.keys()], 1)).length ||
      (await returnedLots(db, workspaceId, frontier, 1)).length)
  )
    reasons.add("depth_limit");
  return { lots, returnLinks, batches: [...batches.values()], reasons: [...reasons], limits };
}
