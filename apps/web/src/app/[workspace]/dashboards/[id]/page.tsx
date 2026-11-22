import { biPeriodPresets, isCalendarDate, type BiPeriodPreset } from "@knotworking/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getDashboard, getDashboardData } from "@/lib/api";
import { DashboardActions } from "./dashboard-actions";
import { DashboardView } from "./dashboard-view";

export const metadata: Metadata = { title: "Dashboard" };

/** Only real dates reach the API: a malformed one in the URL is ignored, never a failed page. */
const isDate = (v: unknown): v is string => typeof v === "string" && isCalendarDate(v);

/**
 * The view parameters live in the URL, so a filtered dashboard can be shared and printed as seen:
 * `?period=<preset>` or `?from=&to=`, and `?f.<param id>=<value>` per dashboard filter.
 */
function viewParams(search: Record<string, string | string[] | undefined>) {
  const period =
    typeof search.period === "string" && (biPeriodPresets as readonly string[]).includes(search.period)
      ? { preset: search.period as BiPeriodPreset }
      : isDate(search.from) || isDate(search.to)
        ? {
            ...(isDate(search.from) ? { from: search.from } : {}),
            ...(isDate(search.to) ? { to: search.to } : {}),
          }
        : undefined;
  const filters: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(search)) {
    // Filter values the API would refuse (too long, too many) are dropped rather than failing the page.
    if (!key.startsWith("f.") || value === undefined || value === "") continue;
    const values = (Array.isArray(value) ? value : [value]).filter((v) => v.length <= 200).slice(0, 50);
    if (values.length) filters[key.slice(2)] = Array.isArray(value) ? values : values[0]!;
  }
  return { ...(period ? { period } : {}), filters };
}

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: slug, id }, search] = await Promise.all([params, searchParams]);
  const view = viewParams(search);
  const [dashboard, data] = await Promise.all([
    getDashboard(slug, id),
    getDashboardData(slug, id, JSON.stringify(view)),
  ]);
  return (
    <>
      <PageHeader actions={<DashboardActions slug={slug} dashboard={dashboard} view={view} />}>
        <h1 className="truncate font-medium">{dashboard.title}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <DashboardView slug={slug} dashboard={dashboard} data={data} view={view} />
      </div>
    </>
  );
}
