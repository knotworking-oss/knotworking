import { itemTypes, type ItemType } from "@knotworking/core";
import type { Metadata } from "next";
import { ModuleDashboardsLink } from "@/components/module-dashboards-link";
import { PageHeader } from "@/components/page-header";
import {
  canReadModule,
  getAvailability,
  getItems,
  getStockLevels,
  getStockLocations,
  getSuppliers,
} from "@/lib/api";
import { StockLevels } from "./stock-levels";

export const metadata: Metadata = { title: "Stock" };

const EXPIRY_WINDOWS = ["7", "30"] as const;

export default async function StockPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ q?: string; type?: string; location?: string; expiring?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const locations = (await getStockLocations(slug)).locations;
  const filters = {
    q: search.q?.trim() || undefined,
    type: itemTypes.find((t) => t === search.type) as ItemType | undefined,
    location: locations.find((l) => l.id === search.location)?.id,
    expiring: EXPIRY_WINDOWS.find((d) => d === search.expiring),
  };
  const [page, { items }, { suppliers }] = await Promise.all([
    getStockLevels(slug, {
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.type ? { itemType: filters.type } : {}),
      ...(filters.location ? { locationId: filters.location } : {}),
      ...(filters.expiring ? { expiringWithinDays: filters.expiring } : {}),
    }),
    getItems(slug, { status: "active" }),
    getSuppliers(slug),
  ]);
  // Reserved and free stock come from the production module: only for people who can read it.
  const availability =
    page.levels.length > 0 && (await canReadModule(slug, "production"))
      ? Object.fromEntries(
          (
            await getAvailability(
              slug,
              page.levels.map((l) => l.item.id),
            )
          ).items.map((a) => [a.item.id, { reserved: a.reserved, free: a.available }]),
        )
      : undefined;
  return (
    <>
      <PageHeader actions={<ModuleDashboardsLink module="stock" />}>
        <h1 className="font-medium">Stock</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <StockLevels
          slug={slug}
          levels={page.levels}
          total={page.total}
          locations={locations}
          items={items}
          suppliers={suppliers}
          filters={filters}
          availability={availability}
        />
      </div>
    </>
  );
}
