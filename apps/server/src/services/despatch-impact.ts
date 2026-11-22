import {
  despatchImpactCsv,
  impactLimits,
  stockAmount,
  type DespatchImpactQuery,
  type DespatchImpactReport,
  type ImpactReason,
} from "@knotworking/core";
import {
  despatches,
  despatchLines,
  items,
  stockLots,
  stockMovements,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, count, countDistinct, eq, inArray, sql } from "drizzle-orm";
import { ApiError } from "../errors";
import { traceForwardProduction } from "./ports/production";

/** One repeatable-read snapshot for genealogy, stock and recipient history; never writes. */
export async function despatchImpact(
  db: Database,
  workspaceId: string,
  lotId: string,
  query: DespatchImpactQuery,
): Promise<DespatchImpactReport> {
  return db.transaction((tx) => readDespatchImpact(tx, workspaceId, lotId, query), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

export async function readDespatchImpact(
  tx: Executor,
  workspaceId: string,
  lotId: string,
  query: DespatchImpactQuery,
): Promise<DespatchImpactReport> {
  const graph = await traceForwardProduction(tx, workspaceId, lotId, query.depth);
  const ids = [...graph.lots.keys()];
  const lots = await tx
    .select({ lot: stockLots, item: items })
    .from(stockLots)
    .innerJoin(items, and(eq(items.id, stockLots.itemId), eq(items.workspaceId, workspaceId)))
    .where(and(eq(stockLots.workspaceId, workspaceId), inArray(stockLots.id, ids)))
    .orderBy(asc(stockLots.id));
  const balances = await tx
    .select({
      lotId: stockMovements.lotId,
      onHand: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)`,
      despatched: sql<string>`-coalesce(sum(${stockMovements.quantity}) filter (where ${stockMovements.type} = 'despatch'), 0)`,
    })
    .from(stockMovements)
    .where(and(eq(stockMovements.workspaceId, workspaceId), inArray(stockMovements.lotId, ids)))
    .groupBy(stockMovements.lotId);
  const balanceOf = new Map(balances.map((b) => [b.lotId, b]));
  const readableIds = lots.map((l) => l.lot.id);
  const where = and(
    eq(despatchLines.workspaceId, workspaceId),
    inArray(despatchLines.lotId, readableIds),
    eq(despatches.status, "confirmed"),
  );
  const rows = await tx
    .select({ d: despatches, line: despatchLines })
    .from(despatchLines)
    .innerJoin(
      despatches,
      and(eq(despatches.id, despatchLines.despatchId), eq(despatches.workspaceId, workspaceId)),
    )
    .where(where)
    .orderBy(asc(despatches.despatchedOn), asc(despatches.id), asc(despatchLines.id))
    .limit(query.limit)
    .offset(query.offset);
  const [summary] = await tx
    .select({
      lines: count(),
      customers: countDistinct(despatches.customerId),
      despatches: countDistinct(despatches.id),
    })
    .from(despatchLines)
    .innerJoin(
      despatches,
      and(eq(despatches.id, despatchLines.despatchId), eq(despatches.workspaceId, workspaceId)),
    )
    .where(where);
  const reasons: ImpactReason[] = [...graph.reasons];
  if (lots.length !== ids.length) reasons.push("missing_lot");
  return {
    rootLotId: lotId,
    returnLinks: graph.returnLinks,
    generatedAt: new Date().toISOString(),
    scope: "forward_production_and_despatch",
    coverage: {
      status: reasons.length ? "partial" : "complete",
      reasons,
      depth: query.depth,
      limits: { lots: graph.limits.lots, batches: graph.limits.batches, links: graph.limits.links },
    },
    lots: lots
      .map(({ lot, item }) => ({
        id: lot.id,
        lotCode: lot.lotCode,
        depth: graph.lots.get(lot.id)!,
        item: { id: item.id, code: item.code, name: item.name, unit: item.unit },
        status: lot.status,
        expiresOn: lot.expiresOn,
        onHand: stockAmount(Number(balanceOf.get(lot.id)?.onHand ?? 0), item),
        despatched: stockAmount(Number(balanceOf.get(lot.id)?.despatched ?? 0), item),
      }))
      .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id)),
    batches: graph.batches,
    summary: {
      lots: lots.length,
      batches: graph.batches.length,
      despatches: summary?.despatches ?? 0,
      customers: summary?.customers ?? 0,
      deliveryLines: summary?.lines ?? 0,
    },
    deliveries: {
      lines: rows.map(({ d, line }) => ({
        lineId: line.id,
        despatchId: d.id,
        reference: d.reference,
        despatchedOn: d.despatchedOn,
        customerId: d.customerId,
        customerCode: d.customerCode,
        customerName: d.customerName,
        customerAddress: d.customerAddress,
        deliveryAddress: d.deliveryAddress,
        contactName: d.contactName,
        email: d.email,
        phone: d.phone,
        externalReference: d.externalReference,
        lotId: line.lotId,
        lotCode: line.lotCode,
        itemCode: line.itemCode,
        itemName: line.itemName,
        amount: stockAmount(line.quantity, { unit: line.itemUnit }),
      })),
      total: summary?.lines ?? 0,
      limit: query.limit,
      offset: query.offset,
    },
  };
}

export async function exportDespatchImpact(db: Database, workspaceId: string, lotId: string, depth: number) {
  const report = await despatchImpact(db, workspaceId, lotId, {
    depth,
    limit: impactLimits.exportLines,
    offset: 0,
  });
  if (report.deliveries.total > impactLimits.exportLines)
    throw new ApiError(
      413,
      "impact_export_limit",
      `This trace has ${report.deliveries.total} known delivery lines; CSV exports support at most ${impactLimits.exportLines}. No partial contact file was exported.`,
    );
  return "\ufeff" + despatchImpactCsv(report);
}
