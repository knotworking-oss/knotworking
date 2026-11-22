import { addDays } from "@knotworking/core";
import type { Metadata } from "next";
import { ModuleDashboardsLink } from "@/components/module-dashboards-link";
import { PageHeader } from "@/components/page-header";
import { getProductionBatches, getRecipes, getStockLocations, getWorkspaceToday } from "@/lib/api";
import { BatchSchedule } from "./batch-schedule";

export const metadata: Metadata = { title: "Production" };

/** Monday of the week that holds `iso` (a calendar date; today is the workspace's). */
function weekStart(iso: string) {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return addDays(iso, -((day + 6) % 7));
}

export default async function ProductionPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const today = await getWorkspaceToday(slug);
  const from = weekStart(/^\d{4}-\d{2}-\d{2}$/.test(search.week ?? "") ? search.week! : today);
  const to = addDays(from, 6);
  const [week, earlier, { recipes }, { locations }] = await Promise.all([
    getProductionBatches(slug, { from, to }),
    // Batches from before this week that are still open: late, or still running.
    getProductionBatches(slug, { to: addDays(from, -1), status: "open" }),
    getRecipes(slug, { status: "active" }),
    getStockLocations(slug),
  ]);
  return (
    <>
      <PageHeader actions={<ModuleDashboardsLink module="production" />}>
        <h1 className="font-medium">Production</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <BatchSchedule
          slug={slug}
          from={from}
          to={to}
          today={today}
          batches={week.batches}
          earlier={earlier.batches}
          recipes={recipes.filter((r) => r.approvedVersionNumber !== null)}
          locations={locations}
        />
      </div>
    </>
  );
}
