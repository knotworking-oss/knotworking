import { sopCopyStatusLabels, sopCopyStatuses } from "@knotworking/core";
import type { Metadata } from "next";
import Link from "next/link";
import { PrintHeading, PrintPage } from "@/components/print-page";
import { getBootstrap, getSopCopies } from "@/lib/api";
import { printDate } from "@/lib/print";

export const metadata: Metadata = { title: "Controlled SOP copies" };

const filters = ["issued", ...sopCopyStatuses.filter((s) => s !== "issued"), "all"] as const;
type Filter = (typeof filters)[number];

/**
 * The controlled-copy register on A4: every printed copy of an SOP that was issued, to whom, of
 * which version, and whether it is still out (`?status=` issued by default, or returned, destroyed,
 * all). Copies of a version that is no longer current are marked: they are to be called in.
 */
export default async function SopCopiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const status: Filter = filters.find((f) => f === search.status) ?? "issued";
  const [boot, { copies, total }] = await Promise.all([
    getBootstrap(slug),
    getSopCopies(slug, { status, limit: "500" }),
  ]);
  const zone = boot.workspace.timeZone;
  const oldOnes = copies.filter((c) => c.outOfDate).length;

  return (
    <PrintPage
      crumbs={
        <>
          <Link href={`/${slug}/sops`} className="text-muted-foreground hover:text-foreground">
            SOPs
          </Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="font-medium">Controlled copies</h1>
        </>
      }
      controls={
        <nav className="flex flex-wrap gap-2 text-sm" aria-label="Show">
          {filters.map((f) => (
            <Link
              key={f}
              href={`/${slug}/sops/copies?status=${f}`}
              aria-current={f === status ? "page" : undefined}
              className={`rounded-md border px-2.5 py-1 ${f === status ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >
              {f === "all" ? "All" : sopCopyStatusLabels[f]}
            </Link>
          ))}
        </nav>
      }
    >
      <PrintHeading
        workspace={boot.workspace.name}
        timeZone={zone}
        title="Controlled copy register"
        subtitle={`${status === "all" ? "All copies" : `${sopCopyStatusLabels[status]} copies`} · ${total}`}
      />
      {oldOnes > 0 && (
        <p className="mb-3 font-medium">
          {oldOnes} {oldOnes === 1 ? "copy is" : "copies are"} of a version that is no longer current: call
          {oldOnes === 1 ? " it" : " them"} in.
        </p>
      )}
      {copies.length === 0 ? (
        <p className="text-sm text-muted-foreground">No copies.</p>
      ) : (
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-black text-left">
              <th className="py-1 pr-2">SOP</th>
              <th className="py-1 pr-2">Version</th>
              <th className="py-1 pr-2">Copy</th>
              <th className="py-1 pr-2">Issued to</th>
              <th className="py-1 pr-2">Issued</th>
              <th className="py-1">Status</th>
            </tr>
          </thead>
          <tbody>
            {copies.map((c) => (
              <tr key={c.id} className="border-b border-black/20 align-top">
                <td className="py-1 pr-2">
                  <Link href={`/${slug}/sops/${c.sopId}`} className="hover:underline">
                    <span className="font-mono">{c.sopCode}</span> {c.title}
                  </Link>
                </td>
                <td className="py-1 pr-2">
                  v{c.versionNumber}
                  {c.outOfDate ? " (old)" : ""}
                </td>
                <td className="py-1 pr-2">{c.copyNumber}</td>
                <td className="py-1 pr-2">
                  {c.issuedTo}
                  {c.location ? <span className="block text-muted-foreground">{c.location}</span> : null}
                </td>
                <td className="py-1 pr-2">
                  {printDate(c.issuedAt, zone)}
                  {c.issuedByName ? (
                    <span className="block text-muted-foreground">{c.issuedByName}</span>
                  ) : null}
                </td>
                <td className="py-1">
                  {sopCopyStatusLabels[c.status]}
                  {c.closedAt ? (
                    <span className="block text-muted-foreground">
                      {printDate(c.closedAt, zone)}
                      {c.closedByName ? ` · ${c.closedByName}` : ""}
                      {c.closedNote ? ` · ${c.closedNote}` : ""}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PrintPage>
  );
}
