import { jobCardStatuses, jobCardStatusLabels } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import type { Metadata } from "next";
import Link from "next/link";
import { JobCardStatusBadge } from "@/components/job-card-status-badge";
import { PageHeader } from "@/components/page-header";
import { getJobCards, getWorkCentres } from "@/lib/api";

export const metadata: Metadata = { title: "Job cards" };

const PAGE = 50;
const filters = ["open", ...jobCardStatuses, "all"] as const;
type Filter = (typeof filters)[number];

/** Job cards: one per operation of a production batch, open ones first. */
export default async function JobCardsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string; workCentreId?: string; offset?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const status: Filter = (filters as readonly string[]).includes(search.status ?? "")
    ? (search.status as Filter)
    : "open";
  const offset = Math.max(0, Number(search.offset) || 0);
  const [page, { workCentres }] = await Promise.all([
    getJobCards(slug, {
      status,
      ...(search.workCentreId ? { workCentreId: search.workCentreId } : {}),
      offset: String(offset),
    }),
    getWorkCentres(slug, { status: "all" }),
  ]);
  const base = `/${slug}/routings/job-cards`;
  const href = (patch: Record<string, string | number | undefined>) => {
    const query = new URLSearchParams();
    const merged = {
      status: status === "open" ? undefined : status,
      workCentreId: search.workCentreId,
      ...patch,
    };
    for (const [key, value] of Object.entries(merged))
      if (value !== undefined && value !== "") query.set(key, String(value));
    const qs = query.toString();
    return qs ? `${base}?${qs}` : base;
  };
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Job cards</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
          <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5">
            {filters.map((f) => (
              <Button key={f} size="sm" variant={status === f ? "secondary" : "ghost"} asChild>
                <Link href={href({ status: f === "open" ? undefined : f, offset: undefined })}>
                  {f === "open" ? "Open" : f === "all" ? "All" : jobCardStatusLabels[f]}
                </Link>
              </Button>
            ))}
          </nav>
          {workCentres.length > 1 && (
            <nav aria-label="Filter by work centre" className="flex flex-wrap gap-1.5">
              <Button size="sm" variant={search.workCentreId ? "ghost" : "secondary"} asChild>
                <Link href={href({ workCentreId: undefined, offset: undefined })}>Every work centre</Link>
              </Button>
              {workCentres.map((w) => (
                <Button
                  key={w.id}
                  size="sm"
                  variant={search.workCentreId === w.id ? "secondary" : "ghost"}
                  asChild
                >
                  <Link href={href({ workCentreId: w.id, offset: undefined })}>{w.code}</Link>
                </Button>
              ))}
            </nav>
          )}
          {page.jobCards.length ? (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2">Batch</th>
                    <th className="p-2">Operation</th>
                    <th className="p-2">Work centre</th>
                    <th className="p-2 text-right">Good / scrap</th>
                    <th className="p-2 text-right">Minutes (actual / expected)</th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {page.jobCards.map((card) => (
                    <tr key={card.id} className="border-t">
                      <td className="p-2">
                        <Link className="underline" href={`/${slug}/production/batches/${card.batch.id}`}>
                          {card.batch.batchCode}
                        </Link>
                        <span className="block text-xs text-muted-foreground">{card.plannedOn}</span>
                      </td>
                      <td className="p-2">
                        <Link className="font-medium underline" href={`${base}/${card.id}`}>
                          {card.position}. {card.name}
                        </Link>
                        {card.openExceptions > 0 && (
                          <span className="block text-xs text-destructive">
                            {card.openExceptions} open exception(s)
                          </span>
                        )}
                      </td>
                      <td className="p-2">{card.workCentre?.code ?? "—"}</td>
                      <td className="p-2 text-right tabular-nums">
                        {card.good.display} / {card.scrap.display} {card.good.displayUnit}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {card.actualMinutes} / {card.expected.totalMinutes}
                      </td>
                      <td className="p-2">
                        <JobCardStatusBadge status={card.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No job cards match. Make them from a production batch whose bill of materials has an approved
              routing.
            </p>
          )}
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {page.total === 0
                ? "0 job cards"
                : `${page.offset + 1}–${page.offset + page.jobCards.length} of ${page.total}`}
            </span>
            <span className="flex gap-2">
              {page.offset > 0 && (
                <Button size="sm" variant="outline" asChild>
                  <Link href={href({ offset: Math.max(0, page.offset - PAGE) || undefined })}>Previous</Link>
                </Button>
              )}
              {page.offset + page.jobCards.length < page.total && (
                <Button size="sm" variant="outline" asChild>
                  <Link href={href({ offset: page.offset + PAGE })}>Next</Link>
                </Button>
              )}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
