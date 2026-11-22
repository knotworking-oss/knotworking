import { despatches, despatchLines, type Executor } from "@knotworking/db";
import { and, eq, isNotNull, ne, sql, inArray } from "drizzle-orm";
import { lotLocationKey, roundQuantity } from "@knotworking/core";
export async function despatchAllocated(
  db: Executor,
  ws: string,
  opts: { lotIds?: string[]; itemIds?: string[]; exceptDespatchId?: string } = {},
) {
  if (opts.lotIds?.length === 0 || opts.itemIds?.length === 0)
    return { lots: new Map<string, number>(), locations: new Map<string, number>() };
  const rows = await db
    .select({
      lotId: despatchLines.lotId,
      locationId: despatchLines.locationId,
      quantity: sql<string>`sum(${despatchLines.quantity})`,
    })
    .from(despatchLines)
    .innerJoin(despatches, and(eq(despatches.id, despatchLines.despatchId), eq(despatches.workspaceId, ws)))
    .where(
      and(
        eq(despatchLines.workspaceId, ws),
        eq(despatches.status, "draft"),
        isNotNull(despatches.allocatedAt),
        opts.exceptDespatchId ? ne(despatches.id, opts.exceptDespatchId) : undefined,
        opts.lotIds ? inArray(despatchLines.lotId, opts.lotIds) : undefined,
        opts.itemIds ? inArray(despatchLines.itemId, opts.itemIds) : undefined,
      ),
    )
    .groupBy(despatchLines.lotId, despatchLines.locationId);
  const lots = new Map<string, number>(),
    locations = new Map<string, number>();
  for (const r of rows) {
    lots.set(r.lotId, roundQuantity((lots.get(r.lotId) ?? 0) + Number(r.quantity)));
    locations.set(lotLocationKey(r.lotId, r.locationId), Number(r.quantity));
  }
  return { lots, locations };
}
