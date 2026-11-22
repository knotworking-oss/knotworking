import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getHseIncident, getHseIncidentHistory, getWorkspaceToday, getWorkspaceTimeZone } from "@/lib/api";
import { printDateTime } from "@/lib/print";
import { hseIncidentKindLabels } from "@knotworking/core";
import { IncidentEditor, IncidentClose } from "../../incident-editor";
import { IncidentActions, PeopleHurt } from "../../incident-follow-up";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<{ offset?: string }>;
}) {
  const [{ workspace: slug, id }, q] = await Promise.all([params, searchParams]);
  const offset = /^\d{1,8}$/.test(q.offset ?? "") ? Number(q.offset) : 0;
  const [r, history, today, zone] = await Promise.all([
    getHseIncident(slug, id),
    getHseIncidentHistory(slug, id, String(offset)),
    getWorkspaceToday(slug),
    getWorkspaceTimeZone(slug),
  ]);
  const fields = [
    ["Incident summary", r.body.summary],
    ["Location", r.body.place],
    ["Restricted health details", r.body.healthDetails],
    ["Immediate actions", r.body.immediateActions],
    ["Investigation", r.body.investigation],
    ["Root cause", r.body.rootCause],
    ["Corrective actions", r.body.correctiveActions],
    ["Effectiveness", r.body.effectiveness],
    ["Reporting decision", r.body.reportingDecision.replace(/_/g, " ")],
    ["Reporting basis", r.body.reportingBasis],
    ["Reporting due", r.body.reportingDueOn],
    ["Submission/evidence reference", r.body.reportReference],
  ];
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/hse/incidents`}>Restricted incidents</Link>
        <span>/</span>
        <h1 className="font-medium">{r.reference}</h1>
      </PageHeader>
      <article className="mx-auto w-full max-w-4xl flex-1 space-y-6 overflow-y-auto p-6">
        <div>
          <h1 className="text-xl font-medium">
            {r.reference} · {r.status}
          </h1>
          <p className="text-sm text-muted-foreground">
            {hseIncidentKindLabels[r.body.kind]} · {r.body.occurredOn} · revision {r.revision}
          </p>
        </div>
        <section className="text-sm">
          <h2 className="font-medium">Affected people</h2>
          {r.affectedPeople.map((p) => (
            <p key={p.id}>
              {p.staffNumber} · {p.firstName} {p.lastName}
            </p>
          ))}
        </section>
        <dl className="space-y-4 text-sm">
          {fields
            .filter(([, v]) => v)
            .map(([label, value]) => (
              <div key={label}>
                <dt className="font-medium">{label}</dt>
                <dd className="whitespace-pre-line">{value}</dd>
              </div>
            ))}
        </dl>
        <PeopleHurt key={`people-${r.revision}`} slug={slug} incident={r} />
        <IncidentActions key={`actions-${r.revision}`} slug={slug} incident={r} today={today} />
        <IncidentClose key={`close-${r.revision}`} slug={slug} incident={r} />
        <IncidentEditor key={r.revision} slug={slug} today={today} incident={r} />
        <section className="space-y-3">
          <h2 className="font-medium">Restricted investigation history</h2>
          {history.events.map((e) => {
            const snapshot = e.snapshot as unknown as typeof r;
            return (
              <details key={e.id} className="rounded-md border p-3">
                <summary className="cursor-pointer text-sm">
                  Revision {e.revision} · {e.action} · {printDateTime(e.createdAt, zone)}
                </summary>
                <div className="mt-3 space-y-2 text-sm whitespace-pre-line">
                  <p>{e.reason}</p>
                  <p>{snapshot.body.summary}</p>
                  <p>{snapshot.body.healthDetails}</p>
                  <p>{snapshot.body.investigation}</p>
                  <p>{snapshot.body.correctiveActions}</p>
                  <p>{snapshot.body.reportingBasis}</p>
                </div>
              </details>
            );
          })}
          <nav aria-label="Restricted history pages" className="flex gap-4 text-sm">
            {offset > 0 && <Link href={`?offset=${Math.max(0, offset - history.limit)}`}>Newer</Link>}
            {offset + history.events.length < history.total && (
              <Link href={`?offset=${offset + history.limit}`}>Older</Link>
            )}
          </nav>
        </section>
      </article>
    </>
  );
}
