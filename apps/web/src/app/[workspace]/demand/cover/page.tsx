import { addWeeks, formatWeek, parsePeriod, weekStart } from "@knotworking/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { canReadModule, getDemandCapacity, getDemandCoverage, getWorkspaceToday } from "@/lib/api";
import { GRID_RANGES, type GridRange } from "../ranges";
import { CapacityCard } from "./capacity-card";
import { CoverView } from "./cover-view";

export const metadata: Metadata = { title: "Demand cover" };

export default async function DemandCoverPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string; weeks?: string; short?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const thisWeek = weekStart(await getWorkspaceToday(slug));
  const parsed = search.from ? parsePeriod(search.from) : null;
  // Cover starts no earlier than this week: stock is what is on the shelf now.
  const from = parsed && parsed > thisWeek ? parsed : thisWeek;
  const weeks: GridRange = GRID_RANGES.find((r) => String(r) === search.weeks) ?? 8;
  const shortOnly = search.short === "1";
  const coverage = await getDemandCoverage(slug, {
    from,
    to: addWeeks(from, weeks - 1),
    ...(shortOnly ? { shortOnly: "true" as const } : {}),
  });
  const capacity = (await canReadModule(slug, "production"))
    ? await getDemandCapacity(slug, { from, to: addWeeks(from, weeks - 1) })
    : null;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Demand</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <CoverView
          slug={slug}
          coverage={coverage}
          from={formatWeek(from)}
          fromDate={from}
          thisWeek={thisWeek}
          weeks={weeks}
          shortOnly={shortOnly}
        />
        {capacity && <CapacityCard slug={slug} capacity={capacity} />}
      </div>
    </>
  );
}
