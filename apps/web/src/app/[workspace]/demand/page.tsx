import { addWeeks, parsePeriod, weekStart } from "@knotworking/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getAllItems, getDemandPackUnits, getDemandSummary, getWorkspaceToday } from "@/lib/api";
import { DemandGrid } from "./demand-grid";
import { GRID_RANGES, type GridRange } from "./ranges";

export const metadata: Metadata = { title: "Demand" };

export default async function DemandPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string; weeks?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const from = (search.from && parsePeriod(search.from)) || weekStart(await getWorkspaceToday(slug));
  const weeks: GridRange = GRID_RANGES.find((r) => String(r) === search.weeks) ?? 8;
  const [summary, finished, wip, packs] = await Promise.all([
    getDemandSummary(slug, { from, to: addWeeks(from, weeks - 1), byCustomer: "true" }),
    // Every finished and WIP product, however many: the grid's product picker offers them all.
    getAllItems(slug, { type: "finished", status: "active" }),
    getAllItems(slug, { type: "wip", status: "active" }),
    getDemandPackUnits(slug),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Demand</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <DemandGrid
          slug={slug}
          summary={summary}
          products={[...finished.items, ...wip.items]}
          packUnits={packs.packUnits}
          from={from}
          weeks={weeks}
        />
      </div>
    </>
  );
}
