import { crmOpportunityStatusLabels } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Card } from "@knotworking/ui/components/card";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getCrmOpportunity, getCrmStages } from "@/lib/api";
import { printDateTime } from "@/lib/print";
import {
  ActivityEditor,
  ActivityList,
  OpportunityEditor,
  OutcomeActions,
  QuoteLink,
  StageSelect,
} from "../../crm-controls";
import { leadLabel, opportunityValue } from "../../crm-format";

export default async function CrmOpportunityPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [opportunity, { stages }, boot] = await Promise.all([
    getCrmOpportunity(slug, id),
    getCrmStages(slug),
    getBootstrap(slug),
  ]);
  const name = (userId: string | null) => boot.users.find((u) => u.id === userId)?.name ?? "No owner";
  const o = opportunity;
  const handoffHref =
    o.handoff?.kind === "sales_order"
      ? `/${slug}/sales/${o.handoff.id}`
      : o.handoff?.kind === "service_project" && o.handoff.reference
        ? `/${slug}/projects/${o.handoff.id}`
        : null;
  return (
    <>
      <PageHeader
        actions={
          <>
            <OpportunityEditor key={`edit-${o.revision}`} opportunity={o} stages={stages} />
            <OutcomeActions key={`outcome-${o.revision}`} opportunity={o} />
          </>
        }
      >
        <Link href={`/${slug}/crm`} className="hover:underline">
          Pipeline
        </Link>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
          <div className="flex flex-wrap items-start gap-3">
            <h1 className="text-xl font-semibold break-words">{o.title}</h1>
            <Badge variant="secondary">{crmOpportunityStatusLabels[o.status]}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Opportunity {o.reference} · Owner {name(o.ownerId)}
          </p>
          <Card className="gap-4 p-4 text-sm">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Customer</dt>
                <dd>
                  {o.customer ? (
                    <Link href={`/${slug}/customers/${o.customer.id}`} className="underline">
                      {o.customer.code} · {o.customer.name}
                    </Link>
                  ) : (
                    "Not yet a customer"
                  )}
                </dd>
                {o.lead && (
                  <dd>
                    <Link href={`/${slug}/crm/leads/${o.lead.id}`} className="underline">
                      Lead {o.lead.reference} · {leadLabel(o.lead)}
                    </Link>
                  </dd>
                )}
              </div>
              <div>
                <dt className="text-muted-foreground">Stage</dt>
                <dd className="space-y-1">
                  {o.status === "open" ? (
                    <>
                      <span className="block">
                        {o.stage?.name ?? "No current stage"}
                        {o.stage ? ` · ${o.stage.probability}% likely` : ""}
                      </span>
                      <StageSelect key={o.revision} opportunity={o} stages={stages} />
                    </>
                  ) : (
                    <span>
                      {crmOpportunityStatusLabels[o.status]}
                      {o.closedAt ? ` ${printDateTime(o.closedAt, boot.workspace.timeZone)}` : ""} by{" "}
                      {name(o.closedBy)}
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Estimated value</dt>
                <dd className="tabular-nums">{opportunityValue(o)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Expected close</dt>
                <dd>{o.expectedCloseDate ?? "Not set"}</dd>
              </div>
              {o.closedReason && (
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Outcome reason</dt>
                  <dd className="break-words whitespace-pre-wrap">{o.closedReason}</dd>
                </div>
              )}
            </dl>
            {o.notes && <p className="break-words whitespace-pre-wrap">{o.notes}</p>}
          </Card>
          {(o.salesQuoteId || o.serviceQuoteId || o.status === "open") && (
            <Card className="gap-3 p-4 text-sm">
              <h2 className="font-medium">Quote and handoff</h2>
              {o.salesQuote && (
                <p>
                  Sales quote{" "}
                  <Link href={`/${slug}/sales/${o.salesQuote.id}`} className="underline">
                    {o.salesQuote.reference}
                  </Link>{" "}
                  · {o.salesQuote.status}
                  {o.salesQuote.validUntil ? ` · valid until ${o.salesQuote.validUntil}` : ""}
                </p>
              )}
              {o.serviceQuote && (
                <p>
                  Service quote{" "}
                  <Link href={`/${slug}/client-services/${o.serviceQuote.id}`} className="underline">
                    {o.serviceQuote.reference}
                  </Link>{" "}
                  · {o.serviceQuote.title} · {o.serviceQuote.quoteTotal} {o.serviceQuote.currency} ·{" "}
                  {o.serviceQuote.status}
                </p>
              )}
              {((o.salesQuoteId && !o.salesQuote) || (o.serviceQuoteId && !o.serviceQuote)) && (
                <p className="text-muted-foreground">A linked quote is in a module you can&apos;t open.</p>
              )}
              {o.handoff && (
                <p>
                  Handed off to {o.handoff.kind === "sales_order" ? "order" : "delivery project"}{" "}
                  {handoffHref ? (
                    <Link href={handoffHref} className="underline">
                      {o.handoff.reference}
                    </Link>
                  ) : (
                    (o.handoff.reference ?? "")
                  )}
                </p>
              )}
              {!o.salesQuoteId && !o.serviceQuoteId && (
                <p className="text-muted-foreground">
                  No quote linked. With Sales or Client services, link a quote to hand a won deal off to an
                  order or delivery project.
                </p>
              )}
              <QuoteLink key={o.revision} opportunity={o} />
            </Card>
          )}
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-medium">Activities</h2>
              <ActivityEditor opportunityId={o.id} />
            </div>
            <ActivityList activities={o.activities} />
          </section>
        </div>
      </div>
    </>
  );
}
