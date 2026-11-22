import { sopVersionStatusLabels, type DocContent } from "@knotworking/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DocRenderer } from "@/components/doc-renderer";
import { PrintHeading, PrintNotice, PrintPage, SignatureLine } from "@/components/print-page";
import { getBootstrap, getMembers, getSop, getSopCopy, getSopVersion } from "@/lib/api";
import { printDate } from "@/lib/print";

export const metadata: Metadata = { title: "Print SOP" };

/**
 * An SOP as a controlled copy on A4: the current approved version (or `?version=<id>` for an older
 * one), with its reference, version, effective and review dates and who approved it. Save as PDF
 * from the print dialog. A version that is not the current approved one is boxed as such. With
 * `?copy=<id>` it is a numbered controlled copy from the register (who it was issued to, and when)
 * instead of an uncontrolled print.
 */
export default async function PrintSopPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<{ version?: string; copy?: string }>;
}) {
  const [{ workspace: slug, id }, search] = await Promise.all([params, searchParams]);
  const [sop, boot, members] = await Promise.all([getSop(slug, id), getBootstrap(slug), getMembers(slug)]);
  const current = sop.currentVersion;
  const copy = search.copy ? await getSopCopy(slug, search.copy) : null;
  if (copy && copy.sopId !== id) notFound();
  const wanted = copy?.versionId ?? search.version;
  const version = wanted && wanted !== current?.id ? await getSopVersion(slug, id, wanted) : current;
  if (!version) notFound();
  const zone = boot.workspace.timeZone;
  const nameOf = (userId: string | null | undefined) =>
    (userId && members.members.find((m) => m.userId === userId)?.name) || null;
  const isCurrent = version.id === current?.id;
  const approved = "decidedAt" in version && version.status !== "in_review" && version.status !== "rejected";

  return (
    <PrintPage
      crumbs={
        <>
          <Link href={`/${slug}/sops`} className="text-muted-foreground hover:text-foreground">
            SOPs
          </Link>
          <span className="text-muted-foreground">/</span>
          <Link href={`/${slug}/sops/${sop.id}`} className="text-muted-foreground hover:text-foreground">
            {sop.code}
          </Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="font-medium">Print</h1>
        </>
      }
    >
      <PrintHeading
        workspace={boot.workspace.name}
        timeZone={zone}
        title={version.title}
        subtitle={`${sop.code} · version ${version.versionNumber}${sop.category ? ` · ${sop.category}` : ""}`}
      />
      {copy && (
        <div className="mb-4">
          <PrintNotice strong>
            Controlled copy no. {copy.copyNumber}
            <p className="text-sm font-normal normal-case">
              Issued to {copy.issuedTo}
              {copy.location ? ` (${copy.location})` : ""} on {printDate(copy.issuedAt, zone)}
              {copy.issuedByName ? ` by ${copy.issuedByName}` : ""}. Return it when it is replaced or no
              longer needed; do not copy it.
            </p>
          </PrintNotice>
        </div>
      )}
      {!isCurrent && (
        <div className="mb-4">
          <PrintNotice strong>
            {sopVersionStatusLabels[version.status].toUpperCase()}
            <p className="text-sm font-normal normal-case">
              This is not the current approved version of {sop.code}.
            </p>
          </PrintNotice>
        </div>
      )}
      <dl className="mb-4 grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 border-b border-black/40 pb-3 text-[12px]">
        <dt className="text-muted-foreground">Owner</dt>
        <dd>{nameOf(sop.ownerId) ?? "—"}</dd>
        <dt className="text-muted-foreground">Effective</dt>
        <dd>{printDate(version.effectiveOn, zone) || "—"}</dd>
        <dt className="text-muted-foreground">Review due</dt>
        <dd>{printDate(version.reviewDueOn, zone) || "—"}</dd>
        <dt className="text-muted-foreground">Change</dt>
        <dd>{version.changeSummary}</dd>
      </dl>

      <DocRenderer content={version.content as DocContent} />

      <div className="mt-8 flex flex-wrap gap-6 border-t border-black/40 pt-3">
        <SignatureLine
          label="Submitted by"
          name={nameOf(version.submittedBy)}
          at={printDate(version.submittedAt, zone)}
        />
        {approved && (
          <SignatureLine
            label="Approved by"
            name={nameOf(version.decidedBy)}
            at={printDate(version.decidedAt, zone)}
          />
        )}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        {copy
          ? `Controlled copy ${copy.copyNumber} of version ${copy.versionNumber}: recorded in the controlled-copy register.`
          : "Uncontrolled when printed: check the SOPs module for the current version."}
      </p>
    </PrintPage>
  );
}
