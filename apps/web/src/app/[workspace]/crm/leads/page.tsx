import { crmLeadListSchema, crmLeadStatuses, crmLeadStatusLabels } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getCrmLeads } from "@/lib/api";
import { LeadEditor } from "../crm-controls";

export const metadata: Metadata = { title: "Leads" };

export default async function CrmLeadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string; q?: string; before?: string }>;
}) {
  const [{ workspace: slug }, raw] = await Promise.all([params, searchParams]);
  const parsed = crmLeadListSchema.safeParse(raw);
  const query = parsed.success ? parsed.data : {};
  const { leads, nextCursor } = await getCrmLeads(slug, {
    ...(query.status ? { status: query.status } : {}),
    ...(query.q ? { q: query.q } : {}),
    ...(query.before ? { before: query.before } : {}),
  });
  const base = `/${slug}/crm/leads`;
  const href = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ status: query.status, q: query.q, ...patch }))
      if (value) params.set(key, value);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };
  return (
    <>
      <PageHeader actions={<LeadEditor />}>
        <h1 className="font-medium">Leads</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
          <div className="flex flex-wrap items-center gap-2">
            {[undefined, ...crmLeadStatuses].map((status) => (
              <Button
                key={status ?? "all"}
                asChild
                size="sm"
                variant={query.status === status ? "secondary" : "ghost"}
              >
                <Link href={href({ status, before: undefined })}>
                  {status ? crmLeadStatusLabels[status] : "All"}
                </Link>
              </Button>
            ))}
            <form action={base} className="ml-auto flex gap-2">
              {query.status && <input type="hidden" name="status" value={query.status} />}
              <Input name="q" aria-label="Search leads" placeholder="Search leads" defaultValue={query.q} />
            </form>
          </div>
          {leads.length ? (
            <ul className="divide-y rounded-lg border">
              {leads.map((lead) => (
                <li key={lead.id}>
                  <Link
                    href={`${base}/${lead.id}`}
                    className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm hover:bg-muted/60"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium break-words">{lead.company || lead.name}</span>
                      <span className="text-muted-foreground">
                        {lead.reference}
                        {lead.company ? ` · ${lead.name}` : ""}
                        {lead.source ? ` · ${lead.source}` : ""}
                      </span>
                    </span>
                    <Badge variant="secondary">{crmLeadStatusLabels[lead.status]}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No leads{query.status || query.q ? " match" : " yet"}.
            </p>
          )}
          {nextCursor && (
            <Button asChild size="sm" variant="outline">
              <Link href={href({ before: nextCursor })}>Older leads</Link>
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
