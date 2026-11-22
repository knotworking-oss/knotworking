import {
  buildCapacityComparison,
  unavailableCapacity,
  weekStart,
  addDays,
  type CapacityBatch,
  type DemandCapacity,
  type DemandCapacityQuery,
  type ItemRate,
} from "@knotworking/core";
import {
  productionBatches,
  productionLineRecipes,
  productionLines,
  recipes,
  type Database,
} from "@knotworking/db";
import { and, eq, gte, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { getDemandCoverage } from "./ports/demand";
import { loadCalendar } from "./production-calendar";
import { shiftsOf } from "./production-lines";

/**
 * `GET /demand/capacity`: the cover view's shortfall, and the batches already planned, against what
 * the production lines can do each week (see core `demand-capacity.ts` for the rules). Reads the
 * production module's tables, so callers who cannot read production get `available: false`, like
 * the cover view leaves out the figures it may not show. Advisory; nothing is scheduled.
 */
export async function getDemandCapacity(
  db: Database,
  workspaceId: string,
  query: DemandCapacityQuery,
  access: { stock: boolean; production: boolean },
): Promise<DemandCapacity> {
  const coverage = await getDemandCoverage(db, workspaceId, { ...query, shortOnly: false }, access);
  if (!access.production) return unavailableCapacity(coverage);

  const lines = await db
    .select()
    .from(productionLines)
    .where(
      and(
        eq(productionLines.workspaceId, workspaceId),
        isNull(productionLines.deletedAt),
        eq(productionLines.active, true),
      ),
    );
  const lineIds = lines.map((l) => l.id);
  const rateRows = lineIds.length
    ? await db
        .select({ rate: productionLineRecipes, recipe: recipes })
        .from(productionLineRecipes)
        .innerJoin(recipes, eq(recipes.id, productionLineRecipes.recipeId))
        .where(
          and(
            inArray(productionLineRecipes.lineId, lineIds),
            isNull(productionLineRecipes.deletedAt),
            isNull(recipes.deletedAt),
          ),
        )
    : [];
  const rates = new Map<string, Record<string, number>>();
  const itemRates = new Map<string, ItemRate>();
  const lineName = new Map(lines.map((l) => [l.id, l.name]));
  for (const { rate, recipe } of rateRows) {
    const rec = rates.get(rate.lineId) ?? {};
    rec[rate.recipeId] = rate.ratePerHour;
    rates.set(rate.lineId, rec);
    // The fastest line for an item, over its active recipes (a retired recipe is not planned).
    if (recipe.status !== "active") continue;
    const best = itemRates.get(recipe.outputItemId);
    if (!best || rate.ratePerHour > best.ratePerHour) {
      itemRates.set(recipe.outputItemId, {
        ratePerHour: rate.ratePerHour,
        lineId: rate.lineId,
        lineName: lineName.get(rate.lineId)!,
      });
    }
  }

  const last = coverage.weeks.at(-1)?.periodStart ?? coverage.from;
  const rangeEnd = addDays(weekStart(last), 6);
  const batchRows = await db
    .select()
    .from(productionBatches)
    .where(
      and(
        eq(productionBatches.workspaceId, workspaceId),
        isNull(productionBatches.deletedAt),
        ne(productionBatches.status, "cancelled"),
        lte(productionBatches.plannedOn, rangeEnd),
        // Finished batches before the range are history; open ones that are overdue still need the time.
        or(
          gte(productionBatches.plannedOn, coverage.from),
          inArray(productionBatches.status, ["planned", "in_progress"]),
        ),
      ),
    );
  const batches: CapacityBatch[] = batchRows.map((b) => ({
    id: b.id,
    batchCode: b.batchCode,
    lineId: b.lineId,
    recipeId: b.recipeId,
    plannedOn: b.plannedOn,
    plannedQuantity: b.plannedQuantity,
    status: b.status,
  }));
  const calendar = await loadCalendar(db, workspaceId, coverage.from, rangeEnd);
  const shifts = await shiftsOf(db, lineIds);
  return buildCapacityComparison({
    coverage,
    lines: lines.map((l) => ({
      id: l.id,
      name: l.name,
      hoursPerDay: l.hoursPerDay,
      shifts: shifts.get(l.id) ?? [],
    })),
    rates,
    batches,
    itemRates,
    calendar,
  });
}
