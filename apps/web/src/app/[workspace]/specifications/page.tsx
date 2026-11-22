import {
  specificationKinds,
  specificationReviewFilters,
  type SpecificationKind,
  type SpecificationReviewFilter,
} from "@knotworking/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getAllItems, getSpecifications, getSuppliers } from "@/lib/api";
import { SpecificationsManager } from "./specifications-manager";

export const metadata: Metadata = { title: "Specifications" };

export default async function SpecificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ q?: string; status?: string; kind?: string; review?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const filters = {
    q: search.q?.trim() || undefined,
    status: (search.status === "all" || search.status === "archived" ? search.status : "active") as
      "active" | "archived" | "all",
    kind: (specificationKinds as readonly string[]).includes(search.kind ?? "")
      ? (search.kind as SpecificationKind)
      : undefined,
    review: (specificationReviewFilters as readonly string[]).includes(search.review ?? "")
      ? (search.review as SpecificationReviewFilter)
      : undefined,
  };
  const [page, items, suppliers] = await Promise.all([
    getSpecifications(slug, {
      status: filters.status,
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.review ? { review: filters.review } : {}),
    }),
    getAllItems(slug, { status: "active" }),
    getSuppliers(slug),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Specifications</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <SpecificationsManager
          slug={slug}
          specifications={page.specifications}
          total={page.total}
          items={items.items}
          suppliers={suppliers.suppliers}
          filters={filters}
        />
      </div>
    </>
  );
}
