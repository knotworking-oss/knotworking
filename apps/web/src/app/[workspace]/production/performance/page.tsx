import { addDays } from "@knotworking/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import {
  getProductionDowntime,
  getProductionLines,
  getProductionPerformance,
  getWorkspaceToday,
} from "@/lib/api";
import { PerformanceView } from "./performance-view";

export const metadata: Metadata = { title: "Factory performance" };

/** Monday of the week that holds `iso`. */
function weekStart(iso: string) {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return addDays(iso, -((day + 6) % 7));
}

export default async function PerformancePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string; line?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const today = await getWorkspaceToday(slug);
  const from = weekStart(/^\d{4}-\d{2}-\d{2}$/.test(search.from ?? "") ? search.from! : today);
  const to = addDays(from, 6);
  const { lines } = await getProductionLines(slug);
  const lineId = lines.some((l) => l.id === search.line) ? search.line : undefined;
  const [performance, downtime] = await Promise.all([
    getProductionPerformance(slug, from, to, lineId),
    getProductionDowntime(slug, from, to, lineId),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Factory performance</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PerformanceView
          slug={slug}
          today={today}
          from={from}
          lineId={lineId ?? null}
          lines={lines.map((l) => ({ id: l.id, name: l.name, active: l.active }))}
          performance={performance}
          downtime={downtime}
        />
      </div>
    </>
  );
}
