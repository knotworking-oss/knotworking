import Link from "next/link";
import { notFound } from "next/navigation";
import { PrintPage, PrintHeading, PrintNotice } from "@/components/print-page";
import { AuthenticityReview } from "@/components/authenticity-review";
import { getAuthenticityAssessment, getBootstrap, canReadModule } from "@/lib/api";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const { workspace: slug, id } = await params;
  const search = await searchParams;
  const [d, boot, showTesting] = await Promise.all([
    getAuthenticityAssessment(slug, id),
    getBootstrap(slug),
    canReadModule(slug, "testing"),
  ]);
  const version = d.versions.find((v) => v.id === (search.version ?? d.currentVersionId ?? d.draftVersionId));
  if (!version) notFound();
  return (
    <PrintPage
      crumbs={<Link href={`/${slug}/quality/authenticity/${id}`}>{d.reference} / Authenticity evidence</Link>}
    >
      <PrintHeading
        workspace={boot.workspace.name}
        timeZone={boot.workspace.timeZone}
        title="Food authenticity assessment"
        subtitle={`${d.reference} · ${d.title}`}
      />
      {(d.status === "archived" || version.status !== "approved") && (
        <PrintNotice strong>
          {d.status === "archived"
            ? "Archived assessment scope"
            : version.status === "draft"
              ? "Draft — not a signed assessment"
              : "Superseded assessment revision"}
        </PrintNotice>
      )}
      <p className="my-4 text-sm">
        Control states calculated at the workspace business date {d.today}. Signing an assessment approves its
        judgement and plan; verification evidence is recorded separately.
      </p>
      <AuthenticityReview
        version={version}
        verifications={d.verifications}
        today={d.today}
        users={boot.users}
        slug={slug}
        showTesting={showTesting}
        timeZone={boot.workspace.timeZone}
      />
      <section className="mt-5 text-sm">
        <h2 className="font-medium">Recorded review triggers</h2>
        <ul>
          {d.triggers.map((t) => (
            <li key={t.id} className="my-2">
              {t.kind} · {t.createdAt} · {t.note} · {t.reference} ·{" "}
              {t.resolvedByVersionId
                ? `Reviewed in revision ${d.versions.find((v) => v.id === t.resolvedByVersionId)?.number}`
                : "Open"}
            </li>
          ))}
        </ul>
      </section>
    </PrintPage>
  );
}
