import Link from "next/link";
import { ReturnReceipts } from "@/components/return-receipts";
import { IncidentOverview } from "@/components/incident-overview";
import { PageHeader } from "@/components/page-header";
import { DistributionImpact } from "@/components/distribution-impact";
import { getBootstrap, getIncident, getWorkspaceTimeZone } from "@/lib/api";
import { IncidentForms } from "../forms";
export default async function Page({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const [c, timeZone, boot] = await Promise.all([
    getIncident(slug, id),
    getWorkspaceTimeZone(slug),
    getBootstrap(slug),
  ]);
  const name = (id: string | null) => boot.users.find((u) => u.id === id)?.name ?? id ?? "Former member";
  const corrected = new Set(
    c.events.filter((e) => e.data.kind === "correction").map((e) => e.data.correctsEventId),
  );
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/quality/incidents`}>Live cases</Link>
        <span>/</span>
        <h1>{c.title}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content space-y-6 py-6">
          <IncidentOverview incident={c} ownerName={name(c.ownerUserId)} />
          <section className="rounded-md border p-4">
            <h2 className="font-medium">Initial assessment</h2>
            <p className="text-sm whitespace-pre-wrap">{c.assessment}</p>
          </section>
          <IncidentForms slug={slug} detail={c} />
          <section className="rounded-md border p-4">
            <h2 className="font-medium">Containment holds</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {c.holds.map((h) => (
                <li key={h.lotId}>
                  <Link className="underline" href={`/${slug}/stock/lots/${h.lotId}`}>
                    {c.snapshots.flatMap((s) => s.report.lots).find((l) => l.id === h.lotId)?.lotCode ??
                      h.lotId}
                  </Link>{" "}
                  ·{" "}
                  {h.releasedAt
                    ? `Case hold released ${h.releasedAt} by ${h.releasedBy}: ${h.releaseNote}`
                    : "Active incident hold"}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="font-medium">Evidence and contact log</h2>
            <ol className="mt-3 divide-y rounded-md border">
              {c.events.map((e) => (
                <li className="space-y-1 p-3 text-sm" key={e.id}>
                  <p className="font-medium">
                    {e.data.kind}
                    {corrected.has(e.id) ? " · corrected (excluded from current evidence)" : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {e.createdAt} · {name(e.actorId)} · Event {e.id}
                  </p>
                  <p className="whitespace-pre-wrap">{e.data.note}</p>
                  {e.data.kind === "contact" && (
                    <p>
                      {e.data.party}: {e.data.contact} · {e.data.contactStatus}
                      {e.data.dueAt ? ` · Due ${e.data.dueAt} (${e.data.requirementSource})` : ""}
                    </p>
                  )}
                  {e.data.kind === "recovery" && (
                    <p>
                      {e.data.disposition} · {e.data.quantity}{" "}
                      {
                        c.snapshots
                          .flatMap((s) => s.report.deliveries.lines)
                          .find((l) => l.lineId === e.data.deliveryLineId)?.amount.displayUnit
                      }{" "}
                      · Delivery {e.data.deliveryLineId}
                    </p>
                  )}
                  {e.data.correctsEventId && <p>Corrects {e.data.correctsEventId}</p>}
                </li>
              ))}
            </ol>
          </section>
          <ReturnReceipts slug={slug} returns={c.physicalReturns ?? []} />
          {c.snapshots.map((s, i) => (
            <details className="rounded-md border p-4" key={s.id}>
              <summary className="cursor-pointer font-medium">
                Distribution snapshot {i + 1} · {s.createdAt}
              </summary>
              <p className="my-3 text-sm">
                {s.note} · Recorded by {name(s.createdBy)}
              </p>
              <DistributionImpact slug={slug} report={s.report} timeZone={timeZone} />
            </details>
          ))}
          {c.closure && (
            <section className="space-y-2 rounded-md border p-4 text-sm">
              <h2 className="font-medium">
                Signed closure · {c.closedAt} · {name(c.closedBy)}
              </h2>
              <p>{c.closure.note}</p>
              <p>Coverage: {c.closure.coverageReview}</p>
              <p>Reconciliation: {c.closure.reconciliation}</p>
              {c.closure.nonconformanceId ? (
                <Link
                  className="underline"
                  href={`/${slug}/quality/nonconformances/${c.closure.nonconformanceId}`}
                >
                  Verified CAPA
                </Link>
              ) : (
                <p>No CAPA: {c.closure.noCapaReason}</p>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
