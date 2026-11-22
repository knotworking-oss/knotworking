import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getSops } from "@/lib/api";
import { SopsManager } from "./sops-manager";

export const metadata: Metadata = { title: "SOPs" };

export default async function SopsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ q?: string; category?: string; due?: string; status?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const filters = {
    q: search.q?.trim() || undefined,
    category: search.category?.trim() || undefined,
    due:
      search.due === "overdue" ? ("overdue" as const) : search.due === "soon" ? ("soon" as const) : undefined,
    status: search.status === "all" ? ("all" as const) : ("active" as const),
  };
  const [page, everything] = await Promise.all([
    getSops(slug, {
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.due ? { due: filters.due } : {}),
      status: filters.status,
    }),
    // Unfiltered, only to offer the categories that exist.
    getSops(slug, { status: "all" }),
  ]);
  const categories = [...new Set(everything.sops.flatMap((s) => (s.category ? [s.category] : [])))].sort();
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">SOPs</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <SopsManager
          slug={slug}
          sops={page.sops}
          total={page.total}
          categories={categories}
          filters={filters}
        />
      </div>
    </>
  );
}
