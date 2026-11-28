import { crmOpportunityListSchema, crmOpportunityStatusLabels } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { formatLongDate } from "@/lib/format";
import { getCrmOpportunities, getCrmStages } from "@/lib/api";
import { OpportunityEditor } from "../crm-controls";
import { leadLabel, opportunityValue } from "../crm-format";

export const metadata: Metadata = { title: "Opportunities" };

const filters = ["open", "won", "lost", "all"] as const;

export default async function CrmOpportunitiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string; before?: string }>;
}) {
  const [{ workspace: slug }, raw] = await Promise.all([params, searchParams]);
  const parsed = crmOpportunityListSchema.safeParse(raw);
  const status = parsed.success ? parsed.data.status : "open";
  const before = parsed.success ? parsed.data.before : undefined;
  const [{ opportunities, nextCursor }, { stages }] = await Promise.all([
    getCrmOpportunities(slug, { status, ...(before ? { before } : {}) }),
    getCrmStages(slug),
  ]);
  const base = `/${slug}/crm/opportunities`;
  return (
    <>
      <PageHeader actions={<OpportunityEditor stages={stages} />}>
        <h1 className="font-medium">Opportunities</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content space-y-4 py-4 md:py-6">
          <div className="flex flex-wrap gap-2">
            {filters.map((value) => (
              <Button key={value} asChild size="sm" variant={status === value ? "secondary" : "ghost"}>
                <Link href={`${base}?status=${value}`}>
                  {value === "all" ? "All" : crmOpportunityStatusLabels[value]}
                </Link>
              </Button>
            ))}
          </div>
          {opportunities.length ? (
            <ul className="divide-y rounded-lg border">
              {opportunities.map((o) => (
                <li key={o.id}>
                  <Link
                    href={`${base}/${o.id}`}
                    className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm hover:bg-muted/60"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium break-words">{o.title}</span>
                      <span className="text-muted-foreground">
                        {o.reference} · {o.customer?.name ?? (o.lead ? leadLabel(o.lead) : "")}
                        {o.expectedCloseDate ? ` · Close ${formatLongDate(o.expectedCloseDate)}` : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
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
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No opportunities here yet.
            </p>
          )}
          {nextCursor && (
            <Button asChild size="sm" variant="outline">
              <Link href={`${base}?status=${status}&before=${nextCursor}`}>Older opportunities</Link>
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
