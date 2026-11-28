import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getItemOptions, getMembers, getNonconformances } from "@/lib/api";
import { QualityNav } from "@/components/quality-nav";
import { NonconformancesBoard, type NcFilter } from "./nonconformances-board";

export const metadata: Metadata = { title: "Non-conformances" };

const FILTERS: readonly NcFilter[] = ["unresolved", "open", "action_taken", "overdue", "closed", "all"];

export default async function NonconformancesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string; q?: string; audit?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const auditId = search.audit && /^[0-9a-f-]{36}$/i.test(search.audit) ? search.audit : undefined;
  // An audit's findings: all of them unless a status is chosen.
  const status = FILTERS.find((f) => f === search.status) ?? (auditId ? "all" : "unresolved");
  const q = search.q?.trim() || undefined;
  const [page, items, { members }] = await Promise.all([
    getNonconformances(slug, { status, ...(q ? { q } : {}), ...(auditId ? { auditId } : {}) }),
    getItemOptions(slug, { status: "active" }),
    getMembers(slug),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Quality</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-4 py-8">
          <QualityNav slug={slug} />
          <NonconformancesBoard
            slug={slug}
            status={status}
            q={q ?? ""}
            auditId={auditId}
            nonconformances={page.nonconformances}
            total={page.total}
            items={items.map((i) => ({ id: i.id, code: i.code, name: i.name }))}
            members={members.filter((m) => !m.deactivatedAt).map((m) => ({ userId: m.userId, name: m.name }))}
          />
        </div>
      </div>
    </>
  );
}
