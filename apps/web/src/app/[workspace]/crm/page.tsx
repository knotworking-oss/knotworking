import { crmOpportunityStatusLabels, formatMoney } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { formatLongDate } from "@/lib/format";
import { getCrmPipeline, getMe, type CrmOpportunitySummary } from "@/lib/api";
import { OpportunityEditor, StageSelect } from "./crm-controls";
import { leadLabel, opportunityValue } from "./crm-format";

export const metadata: Metadata = { title: "Pipeline" };

export default async function CrmPipelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ owner?: string }>;
}) {
  const [{ workspace: slug }, { owner }, me] = await Promise.all([params, searchParams, getMe()]);
  const mine = owner === "mine";
  const pipeline = await getCrmPipeline(slug, mine ? { ownerId: me.user.id } : {});
  const stages = pipeline.stages.map(({ id, name, probability }) => ({ id, name, probability }));
  const base = `/${slug}/crm`;
  const card = (o: CrmOpportunitySummary) => (
    <li key={o.id} className="space-y-2 rounded-md border bg-background p-3 text-sm">
      <Link href={`${base}/opportunities/${o.id}`} className="block font-medium break-words hover:underline">
        {o.title}
      </Link>
      <p className="text-muted-foreground">
        {o.customer?.name ?? (o.lead ? leadLabel(o.lead) : o.reference)}
      </p>
      <p className="flex flex-wrap justify-between gap-2 tabular-nums">
        <span>{opportunityValue(o)}</span>
        {o.expectedCloseDate && (
          <span className="text-muted-foreground">Close {formatLongDate(o.expectedCloseDate)}</span>
        )}
      </p>
      <StageSelect opportunity={o} stages={stages} />
    </li>
  );
  return (
    <>
      <PageHeader
        actions={
          <>
            <Button asChild size="sm" variant="outline">
              <Link href={mine ? base : `${base}?owner=mine`}>{mine ? "Everyone" : "Mine"}</Link>
            </Button>
            <OpportunityEditor stages={stages} />
          </>
        }
      >
        <h1 className="font-medium">Pipeline{mine ? " · Mine" : ""}</h1>
      </PageHeader>
      <div className="flex-1 overflow-auto">
        <div className="workspace-content space-y-4 py-4 md:py-6">
          {pipeline.truncated && (
            <p className="text-sm text-muted-foreground">
              Showing the first 500 open opportunities. Filter to your own to see the rest.
            </p>
          )}
          <div className="flex gap-3 overflow-x-auto pb-2">
            {pipeline.stages.map((stage) => (
              <section key={stage.id} className="w-72 shrink-0 space-y-2 rounded-lg bg-muted/50 p-3">
                <header className="space-y-0.5">
                  <h2 className="flex items-center justify-between gap-2 font-medium">
                    {stage.name}
                    <Badge variant="secondary">{stage.count}</Badge>
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {stage.probability}% likely
                    {stage.totals.map((t) => (
                      <span key={t.currency} className="block tabular-nums">
                        {formatMoney(Number(t.value), t.currency)} · weighted{" "}
                        {formatMoney(Number(t.weighted), t.currency)}
                      </span>
                    ))}
                  </p>
                </header>
                <ul className="space-y-2">{stage.opportunities.map(card)}</ul>
              </section>
            ))}
            {pipeline.unstaged.length > 0 && (
              <section className="w-72 shrink-0 space-y-2 rounded-lg bg-muted/50 p-3">
                <h2 className="font-medium">No current stage</h2>
                <ul className="space-y-2">{pipeline.unstaged.map(card)}</ul>
              </section>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {(["won", "lost"] as const).map((status) => (
              <section key={status} className="space-y-2">
                <h2 className="flex items-center gap-2 font-medium">
                  {crmOpportunityStatusLabels[status]}
                  <Badge variant="secondary">{pipeline[status].count}</Badge>
                </h2>
                {pipeline[status].recent.length ? (
                  <ul className="divide-y rounded-lg border">
                    {pipeline[status].recent.map((o) => (
                      <li key={o.id}>
                        <Link
                          href={`${base}/opportunities/${o.id}`}
                          className="flex flex-wrap justify-between gap-2 p-3 text-sm hover:bg-muted/60"
                        >
                          <span className="min-w-0 break-words">{o.title}</span>
                          <span className="text-muted-foreground tabular-nums">{opportunityValue(o)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">None yet.</p>
                )}
              </section>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
