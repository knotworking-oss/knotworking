import type { Metadata } from "next";
import Link from "next/link";
import { ExportCsvButton } from "@/components/export-csv-button";
import { AuditRecordList } from "@/components/audit-record-list";
import { DateRangeForm, PrintHeading, PrintNotice, PrintPage } from "@/components/print-page";
import { dateInZone, todayInZone } from "@knotworking/core";
import { HazardAnalysis } from "@/components/hazard-analysis";
import {
  getAllCorrectiveActions,
  getBootstrap,
  getHaccpAuditAssetRecords,
  getHaccpAuditLogs,
  getHaccpPlan,
  getHaccpSignoffs,
  getWorkspaceTimeZone,
} from "@/lib/api";
import {
  calibrationEntries,
  ccpLogEntries,
  cleaningEntries,
  correctiveActionEntries,
  planCorrectiveActions,
} from "@/lib/audit-records";
import { ccpLogsCsv, correctiveActionsCsv } from "@/lib/csv-export";
import { describeRange, parseDayRange, printDate, printDateTime } from "@/lib/print";

export const metadata: Metadata = { title: "HACCP audit record" };

/** A plan's CCP logs and corrective actions between two days, ready for an auditor. */
export default async function HaccpAuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const [{ workspace: slug, id }, search] = await Promise.all([params, searchParams]);
  const timeZone = await getWorkspaceTimeZone(slug);
  const range = parseDayRange(search, todayInZone(timeZone));
  const [plan, boot, { logs, total }, actions, assetRecords, { signoffs }] = await Promise.all([
    getHaccpPlan(slug, id),
    getBootstrap(slug),
    getHaccpAuditLogs(slug, id, range),
    getAllCorrectiveActions(slug),
    getHaccpAuditAssetRecords(slug, range),
    getHaccpSignoffs(slug, id, range),
  ]);
  const planActions = planCorrectiveActions(actions, id, range, timeZone);
  const entries = ccpLogEntries(logs, timeZone);
  const actionEntries = correctiveActionEntries(planActions, timeZone);
  const cleaning = cleaningEntries(assetRecords.cleaning, timeZone);
  const calibration = calibrationEntries(assetRecords.calibration, timeZone);
  const failedCalibrations = assetRecords.calibration.filter((r) => !r.passed).length;
  const outOfLimits = logs.filter((l) => !l.withinLimits && l.correctedByLogId === null).length;
  const version = plan.currentVersion;
  // Days with a counted check that no supervisor has signed off.
  const signedDays = new Set(signoffs.map((s) => s.day));
  const unsignedDays = [
    ...new Set(
      logs.filter((l) => l.correctedByLogId === null).map((l) => dateInZone(new Date(l.checkedAt), timeZone)),
    ),
  ]
    .filter((d) => !signedDays.has(d))
    .sort();

  return (
    <PrintPage
      crumbs={
        <>
          <Link href={`/${slug}/haccp/plans`} className="text-muted-foreground hover:text-foreground">
            HACCP plans
          </Link>
          <span className="text-muted-foreground">/</span>
          <Link href={`/${slug}/haccp/plans/${id}`} className="text-muted-foreground hover:text-foreground">
            {plan.code}
          </Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="font-medium">Audit record</h1>
        </>
      }
      controls={
        <>
          <DateRangeForm range={range} />
          <div className="flex flex-wrap gap-2">
            <ExportCsvButton
              name={`${plan.code} CCP checks`}
              rows={ccpLogsCsv(logs)}
              label="CCP checks CSV"
            />
            <ExportCsvButton
              name={`${plan.code} corrective actions`}
              rows={correctiveActionsCsv(planActions)}
              label="Corrective actions CSV"
            />
          </div>
        </>
      }
    >
      <PrintHeading
        timeZone={timeZone}
        workspace={boot.workspace.name}
        title="HACCP monitoring record"
        subtitle={`${plan.code} ${plan.name}${version ? ` · plan v${version.versionNumber}` : ""} · ${describeRange(range)}`}
      />
      <p className="text-[12px]">
        {total} CCP check{total === 1 ? "" : "s"}
        {outOfLimits > 0 ? `, ${outOfLimits} out of limits` : ", none out of limits"} · {actionEntries.length}{" "}
        corrective action{actionEntries.length === 1 ? "" : "s"} · {cleaning.length} cleaning record
        {cleaning.length === 1 ? "" : "s"} · {calibration.length} calibration
        {calibration.length === 1 ? "" : "s"}
        {failedCalibrations > 0 ? `, ${failedCalibrations} failed` : ""}
      </p>
      {(assetRecords.cleaningTotal > cleaning.length ||
        assetRecords.calibrationTotal > calibration.length) && (
        <div className="mt-2">
          <PrintNotice>Not every cleaning or calibration record is shown. Narrow the dates.</PrintNotice>
        </div>
      )}
      {total > logs.length && (
        <div className="mt-2">
          <PrintNotice>
            Only the first {logs.length} of {total} checks are shown. Narrow the dates.
          </PrintNotice>
        </div>
      )}
      {version && version.steps.length > 0 && (
        <section className="mt-6 break-inside-avoid">
          <h2 className="border-b border-black pb-1 text-base font-bold">
            Hazard analysis and process flow{" "}
            <span className="text-[12px] font-normal text-muted-foreground">
              (plan v{version.versionNumber})
            </span>
          </h2>
          <div className="mt-2 text-[12px]">
            <HazardAnalysis version={version} />
          </div>
        </section>
      )}
      <section className="mt-6">
        <h2 className="border-b border-black pb-1 text-base font-bold">
          Supervisor sign-off{" "}
          <span className="text-[12px] font-normal text-muted-foreground">({signoffs.length})</span>
        </h2>
        {signoffs.length === 0 ? (
          <p className="py-3 text-[12px] text-muted-foreground">No day in this range has been signed off.</p>
        ) : (
          <ul className="divide-y divide-black/25 text-[12px]">
            {[...signoffs].reverse().map((s) => (
              <li key={s.id} className="break-inside-avoid py-1.5">
                <span className="font-semibold">{printDate(s.day)}</span>: {s.checkCount} check
                {s.checkCount === 1 ? "" : "s"}, {s.deviationCount} deviation
                {s.deviationCount === 1 ? "" : "s"}. Signed off by {s.signedByName ?? "—"},{" "}
                {printDateTime(s.signedAt, timeZone)}
                {s.note ? `: ${s.note}` : ""}
                {s.addedAfter > 0 && (
                  <span className="font-bold">
                    {" "}
                    · {s.addedAfter} check{s.addedAfter === 1 ? "" : "s"} entered for this day after the
                    sign-off
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {unsignedDays.length > 0 && (
          <p className="py-1 text-[12px] font-bold">
            Not signed off: {unsignedDays.map((d) => printDate(d)).join(", ")}
          </p>
        )}
      </section>
      <AuditRecordList
        title="CCP checks"
        description="Oldest first. A corrected reading stays on the record, struck through, followed by the reading that replaced it."
        entries={entries}
      />
      <AuditRecordList
        title="Corrective actions"
        description="Actions that answer this plan's deviations."
        entries={actionEntries}
        empty="No corrective actions in this range."
      />
      <AuditRecordList
        title="Cleaning"
        description="Cleaning of all areas and equipment on the site's register in this range (not limited to this plan)."
        entries={cleaning}
        empty="No cleaning recorded in this range."
      />
      <AuditRecordList
        title="Calibration"
        description="Calibration of all equipment on the site's register in this range. A failed calibration opened a corrective action."
        entries={calibration}
        empty="No calibration recorded in this range."
      />
    </PrintPage>
  );
}
