import { hasModuleLevel } from "@knotworking/core";
import { formatMinutes, formatMoney, serviceQuoteStatusLabels } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getServiceQuote } from "@/lib/api";
import { printDateTime } from "@/lib/print";
import { ServiceQuoteActions } from "../quote-controls";

const eventLabels: Record<string, string> = {
  created: "Draft created",
  edited: "Draft edited",
  issue: "Quote issued",
  accept: "Acceptance recorded",
  deliver: "Delivery signed off",
  cancel: "Quote cancelled",
};

export default async function ServiceQuotePage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [quote, boot] = await Promise.all([getServiceQuote(slug, id), getBootstrap(slug)]);
  const project = boot.projects.find((p) => p.id === quote.projectId);
  const hourly = quote.quotedMinutes !== null;
  return (
    <>
      <div className="print:hidden">
        <PageHeader actions={<ServiceQuoteActions key={quote.revision} quote={quote} />}>
          <Link href={`/${slug}/client-services`} className="hover:underline">
            Client services
          </Link>
        </PageHeader>
      </div>
      <article className="print-sheet print-scroll flex-1 overflow-y-auto">
        <div className="workspace-content space-y-4 py-4 md:py-6">
          <div className="flex flex-wrap items-start gap-3">
            <h1 className="text-xl font-semibold break-words">{quote.title}</h1>
            <Badge variant="secondary">{serviceQuoteStatusLabels[quote.status]}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Service quote {quote.reference} · Revision {quote.revision}
          </p>
          <Card className="gap-4 p-4 text-sm">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Customer</dt>
                <dd>{quote.recipient.name}</dd>
                <dd className="whitespace-pre-wrap">{quote.recipient.address}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Target delivery</dt>
                <dd>{quote.deliveryDate ?? "To be agreed"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{hourly ? "Hourly rate" : "Fixed fee"}</dt>
                <dd>
                  {formatMoney(quote.unitPrice, quote.currency, { maxDecimals: 8 })}
                  {hourly ? " per hour" : ""}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Quoted total before tax</dt>
                <dd>
                  {quote.quoteTotal} {quote.currency}
                  {hourly ? ` for up to ${formatMinutes(quote.quotedMinutes!)}` : ""}
                </dd>
              </div>
            </dl>
            <section>
              <h2 className="font-medium">Scope and deliverables</h2>
              <p className="mt-1 break-words whitespace-pre-wrap">{quote.scope}</p>
            </section>
          </Card>
          {(project || quote.loggedMinutes !== null || quote.billingTotal !== null) && (
            <Card className="gap-3 p-4 text-sm print:hidden">
              <h2 className="font-medium">Delivery and billing</h2>
              {project && (
                <Link href={`/${slug}/projects/${project.id}`} className="underline">
                  Open delivery project
                </Link>
              )}
              {quote.loggedMinutes !== null && (
                <p>{formatMinutes(quote.loggedMinutes)} of finished time logged on the project.</p>
              )}
              {quote.billingTotal !== null && (
                <>
                  <p>
                    Draft billing total before tax · {quote.billingTotal} {quote.currency}
                    {quote.approvedMinutes !== null &&
                      ` for ${formatMinutes(quote.approvedMinutes)} approved`}
                  </p>
                  {quote.status === "delivered" &&
                    hasModuleLevel(
                      boot.modules.find((module) => module.id === "invoicing")?.access,
                      "write",
                    ) && (
                      <Link
                        className="text-sm underline print:hidden"
                        href={`/${slug}/invoicing/new?source=service&id=${id}`}
                      >
                        Draft customer invoice
                      </Link>
                    )}
                  <div>
                    <Button asChild size="sm" variant="outline">
                      <a href={`/api/v1/workspaces/${slug}/client-services/${id}/billing-draft.csv`}>
                        Download billing draft
                      </a>
                    </Button>
                  </div>
                </>
              )}
            </Card>
          )}
          <details className="text-sm print:hidden">
            <summary className="cursor-pointer font-medium">Decision history</summary>
            <ul className="mt-2 divide-y rounded-lg border">
              {quote.history.map((event) => (
                <li key={event.revision} className="space-y-1 p-3">
                  <p>
                    {eventLabels[event.action] ?? event.action} · Revision {event.revision}
                  </p>
                  <p className="text-muted-foreground">
                    {boot.users.find((u) => u.id === event.actorId)?.name ?? "Former member"} ·{" "}
                    {printDateTime(event.createdAt, boot.workspace.timeZone)}
                  </p>
                  <p className="break-words whitespace-pre-wrap">{event.reason}</p>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </article>
    </>
  );
}
