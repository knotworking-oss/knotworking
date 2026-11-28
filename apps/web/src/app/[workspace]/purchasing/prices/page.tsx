import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PurchasingNav } from "@/components/purchasing-nav";
import { getSupplierPrices } from "@/lib/api";
import { loadOrderOptions } from "../options";
import { PricesBoard } from "./prices-board";

export const metadata: Metadata = { title: "Supplier price lists" };

export default async function SupplierPricesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ supplier?: string; offset?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const options = await loadOrderOptions(slug);
  const supplierId = options.suppliers.find((s) => s.id === search.supplier)?.id;
  const offset = Math.max(0, Number.parseInt(search.offset ?? "0", 10) || 0);
  const page = await getSupplierPrices(slug, {
    ...(supplierId ? { supplierId } : {}),
    ...(offset ? { offset: String(offset) } : {}),
  });
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Purchasing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-4 py-8">
          <PurchasingNav slug={slug} />
          <PricesBoard slug={slug} supplierId={supplierId ?? null} page={page} options={options} />
        </div>
      </div>
    </>
  );
}
