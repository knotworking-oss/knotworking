import Link from "next/link";
import { hasModuleLevel, hseKinds, hseKindLabels } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { PageHeader } from "@/components/page-header";
import { HseAttention } from "@/components/hse-attention";
import { getHseRecords, getBootstrap } from "@/lib/api";
import { ReportNearMissButton } from "./incident-follow-up";
export const metadata = { title: "Health, safety and environment" };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ kind?: string; status?: string; offset?: string }>;
}) {
  const [{ workspace: slug }, q] = await Promise.all([params, searchParams]);
  const kind = hseKinds.find((k) => k === q.kind),
    status = q.status === "archived" ? "archived" : "active";
  const offset = /^\d{1,8}$/.test(q.offset ?? "") ? Number(q.offset) : 0;
  const [page, boot] = await Promise.all([
    getHseRecords(slug, { kind, status, offset: String(offset) }),
    getBootstrap(slug),
  ]);
  const href = (o: number) =>
    `?${new URLSearchParams({ ...(kind ? { kind } : {}), status, offset: String(o) })}`;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Health, safety and environment</h1>
      </PageHeader>
      <div className="workspace-content flex-1 space-y-5 overflow-y-auto py-6">
        <div className="flex flex-wrap items-start justify-end gap-3">
          <div className="flex flex-wrap gap-2">
            <ReportNearMissButton slug={slug} />
            {hasModuleLevel(boot.modules.find((m) => m.id === "hse")?.access, "write") && (
              <Button asChild>
                <Link href={`/${slug}/hse/registers/new`}>New HSE register</Link>
              </Button>
            )}
          </div>
        </div>
        <form className="flex flex-wrap gap-3">
          <select
            aria-label="Register type"
            name="kind"
            defaultValue={kind ?? ""}
            className="h-9 rounded-md border bg-background px-3"
          >
            <option value="">All types</option>
            {hseKinds.map((k) => (
              <option key={k} value={k}>
                {hseKindLabels[k]}
              </option>
            ))}
          </select>
          <select
            aria-label="Register status"
            name="status"
            defaultValue={status}
            className="h-9 rounded-md border bg-background px-3"
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
          <Button variant="outline">Show</Button>
        </form>
        {page.records.map((r) => (
          <article key={r.id} className="space-y-2 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Link className="font-medium underline" href={`/${slug}/hse/registers/${r.id}`}>
                {r.title}
              </Link>
              <span className="text-sm text-muted-foreground">
                {hseKindLabels[r.kind]} ·{" "}
                {r.approvedVersion ? `Signed version ${r.approvedVersion}` : "Draft only"}
              </span>
            </div>
            <HseAttention attention={r.attention} />
          </article>
        ))}
        {!page.total && (
          <p className="text-sm text-muted-foreground">
            No registers match these filters. This list describes recorded scopes, not complete site coverage.
          </p>
        )}
        <nav aria-label="HSE register pages" className="flex gap-4 text-sm">
          <span>{page.total} matching registers</span>
          {offset > 0 && <Link href={href(Math.max(0, offset - page.limit))}>Previous</Link>}
          {offset + page.records.length < page.total && <Link href={href(offset + page.limit)}>Next</Link>}
        </nav>
      </div>
    </>
  );
}
