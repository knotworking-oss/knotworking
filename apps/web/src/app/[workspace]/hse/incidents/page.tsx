import Link from "next/link";
import { hasModuleLevel } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { PageHeader } from "@/components/page-header";
import { hseIncidentKindLabels, hseIncidentKinds } from "@knotworking/core";
import { getHseIncidentOverview, getHseIncidents, getBootstrap } from "@/lib/api";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ offset?: string }>;
}) {
  const [{ workspace: slug }, q] = await Promise.all([params, searchParams]);
  const offset = /^\d{1,8}$/.test(q.offset ?? "") ? Number(q.offset) : 0;
  const [page, boot, overview] = await Promise.all([
    getHseIncidents(slug, String(offset)),
    getBootstrap(slug),
    getHseIncidentOverview(slug),
  ]);
  const stat = (label: string, value: string | number, warn = false) => (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${warn ? "text-destructive" : ""}`}>{value}</div>
    </div>
  );
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Restricted HSE incidents</h1>
      </PageHeader>
      <div className="mx-auto w-full max-w-5xl flex-1 space-y-5 overflow-y-auto p-6">
        <div className="flex flex-wrap items-start justify-end gap-3">
          {hasModuleLevel(boot.modules.find((m) => m.id === "hse_incidents")?.access, "write") && (
            <Button asChild>
              <Link href={`/${slug}/hse/incidents/new`}>Record incident</Link>
            </Button>
          )}
        </div>
        <section aria-label="Overview" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            {stat("Open incidents", overview.counts.open)}
            {stat(
              "Reporting decisions to make",
              overview.counts.decisionsPending,
              overview.counts.decisionsPending > 0,
            )}
            {stat("Overdue actions", overview.counts.overdueActions, overview.counts.overdueActions > 0)}
            {stat("Days since a lost-time injury", overview.daysSinceLostTime ?? "None recorded")}
          </div>
          {overview.overdueActions.length > 0 && (
            <ul className="space-y-1 text-sm">
              {overview.overdueActions.map((a) => (
                <li key={a.id}>
                  <Link href={`/${slug}/hse/incidents/${a.incidentId}`} className="underline">
                    {a.reference}
                  </Link>{" "}
                  {a.description} · <span className="text-destructive">due {a.dueOn}</span>
                  {a.ownerName ? ` · ${a.ownerName}` : ""}
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-muted-foreground">
            Last 12 months:{" "}
            {hseIncidentKinds
              .map((k) => `${hseIncidentKindLabels[k]} ${overview.lastYearByKind[k] ?? 0}`)
              .join(" · ")}
          </p>
        </section>
        {page.incidents.map((r) => (
          <article key={r.id} className="space-y-2 rounded-md border p-4 text-sm">
            <Link href={`/${slug}/hse/incidents/${r.id}`} className="font-medium underline">
              {r.reference} · {r.summary}
            </Link>
            <p>
              {hseIncidentKindLabels[r.kind as keyof typeof hseIncidentKindLabels] ?? r.kind} · {r.occurredOn}{" "}
              · {r.status}
            </p>
          </article>
        ))}
        {!page.total && <p className="text-sm text-muted-foreground">No restricted incidents recorded.</p>}
        <nav aria-label="Restricted incident pages" className="flex gap-4 text-sm">
          <span>{page.total} incidents</span>
          {offset > 0 && <Link href={`?offset=${Math.max(0, offset - page.limit)}`}>Previous</Link>}
          {offset + page.incidents.length < page.total && (
            <Link href={`?offset=${offset + page.limit}`}>Next</Link>
          )}
        </nav>
      </div>
    </>
  );
}
