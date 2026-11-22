import Link from "next/link";
import { hseKindLabels } from "@knotworking/core";
import { PageHeader } from "@/components/page-header";
import { RecordAttachments } from "@/components/record-attachments";
import { HseAttention } from "@/components/hse-attention";
import {
  getHseRecord,
  getHseHistory,
  getHseEntries,
  getWorkspaceToday,
  getWorkspaceTimeZone,
  getBootstrap,
} from "@/lib/api";
import { printDateTime } from "@/lib/print";
import { HseContentView } from "../../content-view";
import { RegisterActions, HseEntryForm, HseEntryEvidence } from "../../register-actions";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<{ offset?: string; historyOffset?: string }>;
}) {
  const [{ workspace: slug, id }, q] = await Promise.all([params, searchParams]);
  const offset = /^\d{1,8}$/.test(q.offset ?? "") ? Number(q.offset) : 0,
    historyOffset = /^\d{1,8}$/.test(q.historyOffset ?? "") ? Number(q.historyOffset) : 0;
  const [record, history, entries, today, zone, boot] = await Promise.all([
    getHseRecord(slug, id),
    getHseHistory(slug, id, String(historyOffset)),
    getHseEntries(slug, id, String(offset)),
    getWorkspaceToday(slug),
    getWorkspaceTimeZone(slug),
    getBootstrap(slug),
  ]);
  return (
    <>
      <div className="print:hidden">
        <PageHeader>
          <Link href={`/${slug}/hse`}>HSE</Link>
          <span>/</span>
          <span className="font-medium">{record.title}</span>
        </PageHeader>
      </div>
      <article className="print-sheet print-scroll mx-auto w-full max-w-5xl flex-1 space-y-6 overflow-y-auto p-6">
        <div>
          <h1 className="text-xl font-medium">{record.title}</h1>
          <p className="text-sm text-muted-foreground">
            {hseKindLabels[record.kind]} · {record.status} · revision {record.revision}
          </p>
        </div>
        <HseAttention attention={record.attention} />
        <RegisterActions key={record.revision} slug={slug} record={record} />
        {record.approved && (
          <section className="space-y-3">
            <h2 className="font-medium">Signed version {record.approved.number}</h2>
            <HseContentView content={record.approved.content} references={record.references} />
            <p className="text-xs text-muted-foreground">
              Approved by{" "}
              {boot.users.find((u) => u.id === record.approved?.approvedBy)?.name ?? "Retained approver"} at{" "}
              {printDateTime(record.approved.approvedAt, zone)} · {record.approved.reason}
            </p>
          </section>
        )}
        {record.draft && (
          <section className="space-y-3 rounded-lg border p-4">
            <h2 className="font-medium">Draft version {record.draft.number} — not yet approved</h2>
            <HseContentView content={record.draft.content} references={record.references} />
          </section>
        )}
        <section className="space-y-3">
          <h2 className="font-medium">Checks, exercises and measurements</h2>
          {entries.entries.map((entry) => (
            <article key={entry.id} className="space-y-2 rounded-md border p-3 text-sm">
              <h3 className="font-medium">
                {entry.performedOn} · {entry.outcome}
                {entry.voidedAt ? " · corrected" : ""}
              </h3>
              <p className="whitespace-pre-line">{entry.findings}</p>
              {entry.quantity !== null && (
                <p>
                  {entry.periodFrom ? `${entry.periodFrom} to ${entry.performedOn}: ` : ""}
                  {entry.quantity} {entry.unit}
                </p>
              )}
              <p className="whitespace-pre-line">{entry.actions}</p>
              <p>Evidence: {entry.evidenceReference}</p>
              {entry.resolvesEntryId && <p>Explicit resolution of a preceding failed check</p>}
              {entry.voidReason && <p>Correction: {entry.voidReason}</p>}
              <HseEntryEvidence slug={slug} record={record} entry={entry} />
            </article>
          ))}
          <nav aria-label="HSE entry pages" className="flex gap-4 text-sm print:hidden">
            <span>{entries.total} retained entries</span>
            {offset > 0 && <Link href={`?offset=${Math.max(0, offset - entries.limit)}`}>Newer entries</Link>}
            {offset + entries.entries.length < entries.total && (
              <Link href={`?offset=${offset + entries.limit}`}>Older entries</Link>
            )}
          </nav>
          <HseEntryForm
            key={`entries-${record.revision}`}
            slug={slug}
            record={record}
            today={today}
            entries={entries.entries}
          />
        </section>
        <section className="space-y-3 print:hidden">
          <h2 className="font-medium">Supporting SDS / evidence files</h2>
          <p className="text-sm text-muted-foreground">
            Uploaded evidence is retained. Use the Restricted incidents register for health information; do
            not attach personal injury files here.
          </p>
          <RecordAttachments entityType="hse_record" entityId={id} />
        </section>
        <section className="space-y-3">
          <h2 className="font-medium">Retained assessment versions</h2>
          {history.versions.map((v) => (
            <details key={v.id} className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm">
                Version {v.number} · {v.status} · {v.reason}
              </summary>
              <div className="mt-3">
                <HseContentView content={v.content} references={history.references} />
              </div>
            </details>
          ))}
          <nav className="flex gap-4 text-sm print:hidden" aria-label="HSE version pages">
            {historyOffset > 0 && (
              <Link href={`?historyOffset=${Math.max(0, historyOffset - history.limit)}`}>
                Newer versions
              </Link>
            )}
            {historyOffset + history.versions.length < history.total && (
              <Link href={`?historyOffset=${historyOffset + history.limit}`}>Older versions</Link>
            )}
          </nav>
        </section>
      </article>
    </>
  );
}
