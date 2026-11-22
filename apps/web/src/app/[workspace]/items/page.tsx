import { allergenCodes, itemTypes, type AllergenCode, type ItemType } from "@knotworking/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getItems, getSuppliers } from "@/lib/api";
import { ItemsManager } from "./items-manager";

export const metadata: Metadata = { title: "Items" };

export default async function ItemsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ q?: string; type?: string; allergen?: string; status?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const filters = {
    q: search.q?.trim() || undefined,
    type: itemTypes.find((t) => t === search.type) as ItemType | undefined,
    allergen: allergenCodes.find((a) => a === search.allergen) as AllergenCode | undefined,
    status: search.status === "all" ? ("all" as const) : ("active" as const),
  };
  const [page, { suppliers }] = await Promise.all([
    getItems(slug, {
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.allergen ? { allergen: filters.allergen } : {}),
      status: filters.status,
    }),
    getSuppliers(slug),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Items</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <ItemsManager
          slug={slug}
          items={page.items}
          total={page.total}
          suppliers={suppliers}
          filters={filters}
        />
      </div>
    </>
  );
}
