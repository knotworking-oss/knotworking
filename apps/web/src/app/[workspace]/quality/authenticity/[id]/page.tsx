import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { AuthenticityStatus } from "@/components/authenticity-review";
import { getAuthenticityAssessment, getBootstrap, getWorkspaceTimeZone } from "@/lib/api";
import { AuthenticityWorkspace } from "./authenticity-workspace";
export default async function Page({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const [detail, boot, timeZone] = await Promise.all([
    getAuthenticityAssessment(slug, id),
    getBootstrap(slug),
    getWorkspaceTimeZone(slug),
  ]);
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/quality/authenticity`}>Food authenticity</Link>
        <span>/</span>
        <h1 className="font-medium">{detail.title}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content space-y-5 py-6">
          <AuthenticityStatus assessment={detail} />
          <div className="flex flex-wrap gap-4 text-sm">
            <Link className="underline" href={`/${slug}/quality/authenticity/${id}/print`}>
              Print assessment evidence
            </Link>
            <Link
              className="underline"
              href={`/${slug}/items?q=${encodeURIComponent(detail.itemCode)}&status=all`}
            >
              View item register
            </Link>
            {detail.supplierId && (
              <Link className="underline" href={`/${slug}/suppliers/${detail.supplierId}`}>
                View supplier and approval controls
              </Link>
            )}
          </div>
          {detail.archiveReason && (
            <p className="rounded-md border p-3 text-sm">
              Archived {detail.archivedAt}: {detail.archiveReason}
            </p>
          )}
          <AuthenticityWorkspace
            key={detail.draftVersionId ?? detail.currentVersionId ?? detail.id}
            slug={slug}
            detail={detail}
            users={boot.users}
            timeZone={timeZone}
          />
        </div>
      </div>
    </>
  );
}
