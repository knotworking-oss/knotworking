import { todayInZone } from "@knotworking/core";
import type { Metadata } from "next";
import { ExportCsvButton } from "@/components/export-csv-button";
import { AuditRecordList } from "@/components/audit-record-list";
import { DateRangeForm, PrintHeading, PrintNotice, PrintPage } from "@/components/print-page";
import { SiteNav } from "@/components/site-nav";
import { getBootstrap, getSiteAuditRecords, getWorkspaceTimeZone } from "@/lib/api";
import {
  checklistCheckEntries,
  glassBreakageEntries,
  glassCheckEntries,
  maintenanceEntries,
  pestVisitEntries,
  storageReadingEntries,
} from "@/lib/audit-records";
import {
  checklistChecksCsv,
  glassBreakagesCsv,
  glassChecksCsv,
  maintenanceRecordsCsv,
  pestVisitsCsv,
  storageReadingsCsv,
} from "@/lib/csv-export";
import { describeRange, parseDayRange } from "@/lib/print";

export const metadata: Metadata = { title: "Site audit records" };

/**
 * Storage readings, pre-start and changeover checks, glass checks and breakages, maintenance and
 * pest visits between two days.
 */
export default async function SiteRecordsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const timeZone = await getWorkspaceTimeZone(slug);
  const range = parseDayRange(search, todayInZone(timeZone));
  const [boot, records] = await Promise.all([getBootstrap(slug), getSiteAuditRecords(slug, range)]);

  return (
    <PrintPage
      crumbs={<SiteNav slug={slug} />}
      controls={
        <>
          <DateRangeForm range={range} />
          <div className="flex flex-wrap gap-2">
            <ExportCsvButton
              name="Storage readings"
              rows={storageReadingsCsv(records.readings)}
              label="Storage CSV"
            />
            {records.checks && (
              <ExportCsvButton
                name="Site checks"
                rows={checklistChecksCsv(records.checks)}
                label="Checks CSV"
              />
            )}
            <ExportCsvButton
              name="Glass checks"
              rows={glassChecksCsv(records.glassChecks)}
              label="Glass checks CSV"
            />
            <ExportCsvButton
              name="Glass breakages"
              rows={glassBreakagesCsv(records.breakages)}
              label="Breakages CSV"
            />
            {records.maintenance && (
              <ExportCsvButton
                name="Maintenance records"
                rows={maintenanceRecordsCsv(records.maintenance)}
                label="Maintenance CSV"
              />
            )}
            <ExportCsvButton
              name="Pest visits"
              rows={pestVisitsCsv(records.visits)}
              label="Pest visits CSV"
            />
          </div>
        </>
      }
    >
      <PrintHeading
        timeZone={timeZone}
        workspace={boot.workspace.name}
        title="Site records"
        subtitle={`Storage, glass, pest control${records.checks ? ", checks" : ""}${records.maintenance ? ", maintenance" : ""} · ${describeRange(range)}`}
      />
      {records.truncated && (
        <div className="mb-2">
          <PrintNotice>Some lists are cut short. Narrow the dates to see everything.</PrintNotice>
        </div>
      )}
      <AuditRecordList
        title="Storage temperatures"
        entries={storageReadingEntries(records.readings, timeZone)}
      />
      {records.checks && (
        <AuditRecordList
          title="Pre-start and changeover checks"
          entries={checklistCheckEntries(records.checks, timeZone)}
        />
      )}
      <AuditRecordList
        title="Glass and brittle plastics checks"
        entries={glassCheckEntries(records.glassChecks, timeZone)}
      />
      <AuditRecordList title="Glass breakages" entries={glassBreakageEntries(records.breakages, timeZone)} />
      {records.maintenance && (
        <AuditRecordList title="Maintenance" entries={maintenanceEntries(records.maintenance, timeZone)} />
      )}
      <AuditRecordList title="Pest control visits" entries={pestVisitEntries(records.visits, timeZone)} />
    </PrintPage>
  );
}
