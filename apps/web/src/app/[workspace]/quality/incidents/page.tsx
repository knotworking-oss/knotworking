import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { QualityNav } from "@/components/quality-nav";
import { getIncidents } from "@/lib/api";
import { IncidentCreate } from "./forms";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ offset?: string }>;
}) {
  const { workspace: slug } = await params;
  const search = await searchParams;
  const offset = /^\d+$/.test(search.offset ?? "") ? Math.min(Number(search.offset), 1e7) : 0;
  const page = await getIncidents(slug, String(offset));
  return (
    <>
      <PageHeader>
        <h1>Live incidents, withdrawals and recalls</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content space-y-6 py-6">
          <QualityNav slug={slug} />
          <p className="text-sm text-muted-foreground">
            Coordinate a real case using recorded distribution evidence. Contact logs do not send messages.
            Check current regulator, certification and customer requirements for each incident.
          </p>
          <IncidentCreate slug={slug} />
          <ul className="divide-y rounded-md border">
            {page.incidents.map((c) => (
              <li key={c.id} className="p-3">
                <Link className="underline" href={`/${slug}/quality/incidents/${c.id}`}>
                  {c.title}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {c.reference} · {c.kind} · {c.severity} · {c.status}
                </p>
              </li>
            ))}
          </ul>
          {offset > 0 && (
            <Link className="mr-4 underline" href={`?offset=${Math.max(0, offset - 50)}`}>
              Previous
            </Link>
          )}
          {page.hasMore && (
            <Link className="underline" href={`?offset=${offset + 50}`}>
              Next
            </Link>
          )}
        </div>
      </div>
    </>
  );
}
