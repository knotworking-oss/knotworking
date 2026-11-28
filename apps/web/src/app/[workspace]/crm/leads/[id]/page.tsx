import { crmLeadStatusLabels, crmOpportunityStatusLabels } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Card } from "@knotworking/ui/components/card";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getCrmLead, getCrmStages } from "@/lib/api";
import { printDateTime } from "@/lib/print";
import { ActivityEditor, ActivityList, LeadActions, LeadEditor, OpportunityEditor } from "../../crm-controls";
import { opportunityValue } from "../../crm-format";

export default async function CrmLeadPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [lead, { stages }, boot] = await Promise.all([
    getCrmLead(slug, id),
    getCrmStages(slug),
    getBootstrap(slug),
  ]);
  const owner = boot.users.find((u) => u.id === lead.ownerId)?.name ?? "No owner";
  const base = `/${slug}/crm`;
  return (
    <>
      <PageHeader
        actions={
          <>
            <LeadEditor key={`edit-${lead.revision}`} lead={lead} />
            <LeadActions key={`actions-${lead.revision}`} lead={lead} />
          </>
        }
      >
        <Link href={`${base}/leads`} className="hover:underline">
          Leads
        </Link>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content space-y-4 py-4 md:py-6">
          <div className="flex flex-wrap items-start gap-3">
            <h1 className="text-xl font-semibold break-words">{lead.company || lead.name}</h1>
            <Badge variant="secondary">{crmLeadStatusLabels[lead.status]}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Lead {lead.reference} · Owner {owner}
          </p>
          <Card className="gap-4 p-4 text-sm">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Contact</dt>
                <dd>{lead.name}</dd>
                {lead.email && <dd>{lead.email}</dd>}
                {lead.phone && <dd>{lead.phone}</dd>}
              </div>
              <div>
                <dt className="text-muted-foreground">Source</dt>
                <dd>{lead.source ?? "Not recorded"}</dd>
              </div>
              {lead.customer && (
                <div>
                  <dt className="text-muted-foreground">Customer</dt>
                  <dd>
                    <Link
                      href={`/${slug}/customers?${new URLSearchParams({ q: lead.customer.code })}`}
                      className="underline"
                    >
                      {lead.customer.code} · {lead.customer.name}
                    </Link>
                  </dd>
                  {lead.convertedAt && (
                    <dd className="text-muted-foreground">
                      Converted {printDateTime(lead.convertedAt, boot.workspace.timeZone)}
                    </dd>
                  )}
                </div>
              )}
              {lead.statusReason && (
                <div>
                  <dt className="text-muted-foreground">Disqualified because</dt>
                  <dd className="break-words whitespace-pre-wrap">{lead.statusReason}</dd>
                </div>
              )}
            </dl>
            {lead.notes && <p className="break-words whitespace-pre-wrap">{lead.notes}</p>}
          </Card>
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-medium">Opportunities</h2>
              {lead.status !== "disqualified" && (
                <OpportunityEditor
                  stages={stages}
                  lead={{ id: lead.id, customerId: lead.customerId, label: lead.company || lead.name }}
                />
              )}
            </div>
            {lead.opportunities.length ? (
              <ul className="divide-y rounded-lg border">
                {lead.opportunities.map((o) => (
                  <li key={o.id}>
                    <Link
                      href={`${base}/opportunities/${o.id}`}
                      className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm hover:bg-muted/60"
                    >
                      <span className="min-w-0 break-words">{o.title}</span>
                      <span className="flex items-center gap-2">
                        <span className="tabular-nums">{opportunityValue(o)}</span>
                        <Badge variant="secondary">
                          {o.status === "open"
                            ? (o.stage?.name ?? "Open")
                            : crmOpportunityStatusLabels[o.status]}
                        </Badge>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No opportunities yet.</p>
            )}
          </section>
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-medium">Activities</h2>
              {lead.status !== "converted" && <ActivityEditor leadId={lead.id} />}
            </div>
            <ActivityList activities={lead.activities} />
          </section>
        </div>
      </div>
    </>
  );
}
