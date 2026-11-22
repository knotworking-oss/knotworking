import { despatchImpactQuerySchema, despatchLotParamSchema } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DistributionImpact } from "@/components/distribution-impact";
import { PageHeader } from "@/components/page-header";
import { findImpactLots, getDespatchImpact, getWorkspaceTimeZone, requireModule } from "@/lib/api";

import { ImpactExportButton } from "./export-button";

export const metadata: Metadata = { title: "Distribution impact" };
export default async function ImpactPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ lot?: string; depth?: string; offset?: string; q?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  await requireModule(slug, "production");
  const query = despatchImpactQuerySchema.safeParse({ depth: search.depth, offset: search.offset });
  if (!query.success) notFound();
  const q = search.q?.trim().slice(0, 200) ?? "";
  if (!search.lot) {
    const choices = q ? await findImpactLots(slug, q) : null;
    return (
      <>
        <PageHeader>
          <h1 className="font-medium">Distribution impact</h1>
        </PageHeader>
        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 overflow-y-auto px-6 py-6">
          <form method="get" className="flex gap-2">
            <Input
              name="q"
              aria-label="Find a lot by code"
              defaultValue={q}
              required
              maxLength={200}
              placeholder="Lot code"
            />
            <Button>Find lots</Button>
          </form>
          {choices && (
            <>
              <p className="text-sm text-muted-foreground">
                {choices.total} matching lots
                {choices.total > choices.lots.length
                  ? `; showing the first ${choices.lots.length}. Refine the code to find more.`
                  : "."}
              </p>
              <ul className="divide-y rounded-md border">
                {choices.lots.map((l) => (
                  <li key={l.id} className="p-3">
                    <Link
                      prefetch={false}
                      className="text-sm underline"
                      href={`/${slug}/despatch/impact?lot=${l.id}`}
                    >
                      {l.lotCode} · {l.item.code} · {l.item.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </>
    );
  }
  const parsed = despatchLotParamSchema.safeParse({ lotId: search.lot });
  if (!parsed.success) notFound();
  const lotId = parsed.data.lotId;
  const [report, timeZone] = await Promise.all([
    getDespatchImpact(slug, lotId, { depth: String(query.data.depth), offset: String(query.data.offset) }),
    getWorkspaceTimeZone(slug),
  ]);
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/despatch`} className="text-muted-foreground">
          Despatch
        </Link>
        <span>/</span>
        <h1 className="font-medium">Distribution impact</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <form method="get" className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="lot" value={lotId} />
              <label className="space-y-1 text-sm">
                Maximum trace stages
                <Input
                  type="number"
                  min={1}
                  max={20}
                  name="depth"
                  defaultValue={query.data.depth}
                  required
                  className="w-40"
                />
              </label>
              <Button variant="outline">Refresh trace</Button>
              <Link href={`/${slug}/despatch/impact`} className="py-2 text-sm underline">
                Choose another lot
              </Link>
            </form>
            <ImpactExportButton slug={slug} lotId={lotId} depth={query.data.depth} />
          </div>
          <DistributionImpact slug={slug} report={report} timeZone={timeZone} />
        </div>
      </div>
    </>
  );
}
