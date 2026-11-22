import Link from "next/link";
import { HseContentView } from "../../content-view";
import type { HseContent } from "@knotworking/core";
import { PageHeader } from "@/components/page-header";
import { RecordAttachments } from "@/components/record-attachments";
import { getHsePermit, getHsePermitHistory, getWorkspaceTimeZone, getBootstrap } from "@/lib/api";
import { printDateTime } from "@/lib/print";
import { PermitActions } from "../../permit-actions";
type Evidence = {
  asset: { name: string };
  provider: { name: string };
  contractor: { content: HseContent };
  assessments: { number: number; content: HseContent }[];
  competence: { name: string; courses: { title: string; expiresOn: string | null }[] } | null;
};
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<{ offset?: string }>;
}) {
  const [{ workspace: slug, id }, q] = await Promise.all([params, searchParams]);
  const offset = /^\d{1,8}$/.test(q.offset ?? "") ? Number(q.offset) : 0;
  const [p, history, zone, boot] = await Promise.all([
    getHsePermit(slug, id),
    getHsePermitHistory(slug, id, String(offset)),
    getWorkspaceTimeZone(slug),
    getBootstrap(slug),
  ]);
  const evidence = p.evidenceSnapshot as unknown as Evidence | null;
  return (
    <>
      <div className="print:hidden">
        <PageHeader>
          <Link href={`/${slug}/hse/permits`}>Permits</Link>
          <span>/</span>
          <span className="font-medium">{p.title}</span>
        </PageHeader>
      </div>
      <article className="print-sheet print-scroll mx-auto w-full max-w-5xl flex-1 space-y-5 overflow-y-auto p-6">
        <h1 className="text-xl font-medium">{p.title}</h1>
        <p className="text-sm">
          {p.status} · revision {p.revision} · {p.body.startsOn} to {p.body.endsOn}
        </p>
        <p className="text-sm">
          Asset: {evidence?.asset.name ?? p.assetName} · Contractor:{" "}
          {evidence?.provider.name ?? p.contractorTitle}
        </p>
        <section className="space-y-2 text-sm">
          <h2 className="font-medium">Work scope and precautions</h2>
          <p className="whitespace-pre-line">{p.body.workScope}</p>
          <p className="whitespace-pre-line">{p.body.precautions}</p>
          <h3 className="font-medium">Isolation {p.isolationRequired ? "required" : "not required"}</h3>
          <p className="whitespace-pre-line">{p.body.isolationPoints}</p>
        </section>
        {["draft", "suspended"].includes(p.status) && (
          <section className="space-y-1 rounded-lg border p-4 text-sm print:hidden">
            <h2 className="font-medium">Evidence a signature will rely on</h2>
            <p>
              Contractor competence: {p.contractorTitle}
              {p.currentEvidence.contractorVersionNumber
                ? ` · approved version ${p.currentEvidence.contractorVersionNumber}`
                : " · no approved version"}
            </p>
            {p.currentEvidence.assessments.map((a) => (
              <p key={a.id}>
                <Link className="underline" href={`/${slug}/hse/registers/${a.id}`}>
                  {a.title}
                </Link>
                {a.number ? ` · approved version ${a.number}` : " · no approved version"}
              </p>
            ))}
            <p className="text-muted-foreground">
              Review these versions before signing. If one is replaced in the meantime, the signature is
              refused until you reload and review it.
            </p>
          </section>
        )}
        <PermitActions key={p.revision} slug={slug} permit={p} />
        <section className="space-y-3">
          <h2 className="font-medium">Referenced assessments</h2>
          {p.assessments.map((a) => (
            <p key={a.id} className="text-sm">
              <Link className="underline" href={`/${slug}/hse/registers/${a.id}`}>
                {a.title}
              </Link>
            </p>
          ))}
          {evidence?.assessments.map((a, i) => (
            <details key={i} className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm">
                Signed assessment version {a.number} as reviewed for this permit
              </summary>
              <HseContentView content={a.content} references={p.references} />
            </details>
          ))}
          {evidence?.competence && (
            <div className="text-sm">
              <p>Worker: {evidence.competence.name}</p>
              {evidence.competence.courses.map((c, i) => (
                <p key={i}>
                  {c.title} · expires {c.expiresOn ?? "no recorded expiry"}
                </p>
              ))}
            </div>
          )}
        </section>
        <section className="space-y-3 print:hidden">
          <h2 className="font-medium">Permit evidence</h2>
          <RecordAttachments entityType="hse_permit" entityId={id} />
        </section>
        <section className="space-y-3">
          <h2 className="font-medium">Signed decision history</h2>
          {history.events.map((e) => (
            <details key={e.id} className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm">
                Revision {e.revision} · {e.action} · {printDateTime(e.createdAt, zone)}
              </summary>
              <p className="mt-2 text-sm whitespace-pre-line">
                {e.reason} · {boot.users.find((u) => u.id === e.actorId)?.name ?? "Retained signer"}
              </p>
            </details>
          ))}
          <nav className="flex gap-4 text-sm print:hidden" aria-label="Permit history pages">
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
