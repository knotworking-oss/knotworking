import Link from "next/link";
import { hasModuleLevel } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { PageHeader } from "@/components/page-header";
import { getHsePermits, getBootstrap } from "@/lib/api";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ offset?: string }>;
}) {
  const [{ workspace: slug }, q] = await Promise.all([params, searchParams]);
  const offset = /^\d{1,8}$/.test(q.offset ?? "") ? Number(q.offset) : 0;
  const [page, boot] = await Promise.all([getHsePermits(slug, String(offset)), getBootstrap(slug)]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Contractor permits</h1>
      </PageHeader>
      <div className="flex-1 space-y-5 overflow-y-auto p-6">
        <div className="flex flex-wrap items-start justify-end gap-3">
          {hasModuleLevel(boot.modules.find((m) => m.id === "hse")?.access, "write") && (
            <Button asChild>
              <Link href={`/${slug}/hse/permits/new`}>Prepare permit</Link>
            </Button>
          )}
        </div>
        {page.permits.map((p) => (
          <article key={p.id} className="space-y-1 rounded-md border p-4 text-sm">
            <Link className="font-medium underline" href={`/${slug}/hse/permits/${p.id}`}>
              {p.title}
            </Link>
            <p>
              {p.status} · {p.body.startsOn} to {p.body.endsOn}
              {p.expired ? " · expired — review work authorisation" : ""}
            </p>
            <p>{p.body.workScope}</p>
          </article>
        ))}
        {!page.total && <p className="text-sm text-muted-foreground">No permits recorded.</p>}
        <nav className="flex gap-4 text-sm" aria-label="Permit pages">
          <span>{page.total} permits</span>
          {offset > 0 && <Link href={`?offset=${Math.max(0, offset - page.limit)}`}>Previous</Link>}
          {offset + page.permits.length < page.total && (
            <Link href={`?offset=${offset + page.limit}`}>Next</Link>
          )}
        </nav>
      </div>
    </>
  );
}
