import type { Metadata } from "next";
import { AuditRecordList } from "@/components/audit-record-list";
import { DateRangeForm, PrintHeading, PrintNotice, PrintPage } from "@/components/print-page";
import { QualityNav } from "@/components/quality-nav";
import { todayInZone } from "@knotworking/core";
import { getAudit, getBootstrap, getQualityAuditRecords, getWorkspaceTimeZone } from "@/lib/api";
import { auditInRange, qualityAuditEntries, recallTestEntries } from "@/lib/audit-records";
import { describeRange, inDayRange, parseDayRange } from "@/lib/print";

export const metadata: Metadata = { title: "Quality audit records" };

/** Internal audits (with their findings and sign-off) and mock recall tests between two days. */
export default async function QualityRecordsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const timeZone = await getWorkspaceTimeZone(slug);
  const range = parseDayRange(search, todayInZone(timeZone));
  const [boot, { audits, recallTests }] = await Promise.all([
    getBootstrap(slug),
    getQualityAuditRecords(slug),
  ]);
  const details = await Promise.all(
    audits.filter((a) => auditInRange(a, range)).map((a) => getAudit(slug, a.id)),
  );
  const tests = (recallTests ?? []).filter((t) => inDayRange(t.conductedOn, range, timeZone));
  // Oldest first, like the other record prints.
  const auditEntries = qualityAuditEntries(details, timeZone).sort((a, b) => a.at.localeCompare(b.at));
  const recallEntries = recallTestEntries(tests, timeZone).sort((a, b) => a.at.localeCompare(b.at));
  const failed = tests.filter((t) => !t.passed && t.voidedAt === null).length;

  return (
    <PrintPage
      crumbs={<h1 className="font-medium">Quality</h1>}
      controls={
        <>
          <QualityNav slug={slug} />
          <DateRangeForm range={range} />
        </>
      }
    >
      <PrintHeading
        timeZone={timeZone}
        workspace={boot.workspace.name}
        title="Quality audit records"
        subtitle={`Internal audits${recallTests ? " and mock recall tests" : ""} · ${describeRange(range)}`}
      />
      {failed > 0 && (
        <div className="mb-2">
          <PrintNotice>
            {failed} mock recall test{failed === 1 ? "" : "s"} in this range failed.
          </PrintNotice>
        </div>
      )}
      <AuditRecordList
        title="Internal audits"
        description="Audits completed in the range, and those planned or cancelled for it, with their findings and sign-off."
        entries={auditEntries}
      />
      {recallTests && (
        <AuditRecordList
          title="Mock recall tests"
          description="A voided test stays on the record, struck through."
          entries={recallEntries}
        />
      )}
    </PrintPage>
  );
}
