import { Alert, AlertDescription } from "@knotworking/ui/components/alert";
import type { Metadata } from "next";
import { ModuleDashboardsLink } from "@/components/module-dashboards-link";
import { PageHeader } from "@/components/page-header";
import { TimeReportResults } from "@/components/time-report-results";
import { TimeReportToolbar } from "@/components/time-report-toolbar";
import { getTimeReport, getWorkspaceTimeZone } from "@/lib/api";
import { filtersToApiQuery, parseReportFilters } from "@/lib/time-report";

export const metadata: Metadata = { title: "Time" };

/**
 * Time report: logged against estimated time per project, person, task or day, for a period and
 * filters kept in the URL (see `parseReportFilters`). Every member can open it: it shows what the
 * time-entry routes already show (see `routes/reports.ts`).
 */
export default async function TimePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: slug }, query] = await Promise.all([params, searchParams]);
  const { filters, error } = parseReportFilters(query, new Date(), await getWorkspaceTimeZone(slug));
  const report = await getTimeReport(slug, filtersToApiQuery(filters));

  return (
    <>
      <PageHeader actions={<ModuleDashboardsLink module="time" />}>
        <h1 className="font-medium">Time</h1>
      </PageHeader>
      <div className="workspace-content flex flex-1 flex-col gap-5 overflow-y-auto py-6">
        <TimeReportToolbar filters={filters} />
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error} Showing this week instead.</AlertDescription>
          </Alert>
        )}
        <TimeReportResults report={report} slug={slug} />
      </div>
    </>
  );
}
