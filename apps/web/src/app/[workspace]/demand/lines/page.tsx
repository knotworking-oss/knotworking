import { demandSources, parsePeriod, type DemandSource } from "@knotworking/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getDemandImports, getDemandLines } from "@/lib/api";
import { DemandLines } from "./demand-lines";

export const metadata: Metadata = { title: "Demand lines" };

export default async function DemandLinesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{
    q?: string;
    customer?: string;
    source?: string;
    from?: string;
    to?: string;
    importId?: string;
    offset?: string;
  }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const filters = {
    q: search.q?.trim() || undefined,
    customer: search.customer?.trim() || undefined,
    source: demandSources.find((s) => s === search.source) as DemandSource | undefined,
    from: (search.from && parsePeriod(search.from) && search.from.trim()) || undefined,
    to: (search.to && parsePeriod(search.to) && search.to.trim()) || undefined,
    importId: /^[0-9a-f-]{36}$/i.test(search.importId ?? "") ? search.importId : undefined,
  };
  const offset = Math.max(0, Number.parseInt(search.offset ?? "0", 10) || 0);
  const [page, { imports }] = await Promise.all([
    getDemandLines(slug, {
      ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined)),
      offset: String(offset),
    }),
    getDemandImports(slug),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Demand lines</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <DemandLines
          slug={slug}
          lines={page.lines}
          total={page.total}
          offset={page.offset}
          limit={page.limit}
          imports={imports}
          filters={filters}
        />
      </div>
    </>
  );
}
