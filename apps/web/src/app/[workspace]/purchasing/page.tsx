import type { Metadata } from "next";
import { ModuleDashboardsLink } from "@/components/module-dashboards-link";
import { PageHeader } from "@/components/page-header";
import { PurchasingNav } from "@/components/purchasing-nav";
import { getPurchaseOrders, getPurchaseSettings } from "@/lib/api";
import { loadOrderOptions } from "./options";
import { OrdersBoard, type OrderFilter } from "./orders-board";

export const metadata: Metadata = { title: "Purchase orders" };

const FILTERS: readonly OrderFilter[] = ["open", "draft", "received", "closed", "cancelled", "all"];

export default async function PurchaseOrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string; q?: string; supplier?: string; offset?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const status = FILTERS.find((f) => f === search.status) ?? "open";
  const q = search.q?.trim() || undefined;
  const options = await loadOrderOptions(slug);
  const supplierId = options.suppliers.find((s) => s.id === search.supplier)?.id;
  const offset = Math.max(0, Number.parseInt(search.offset ?? "0", 10) || 0);
  const [page, settings] = await Promise.all([
    getPurchaseOrders(slug, {
      status,
      ...(q ? { q } : {}),
      ...(supplierId ? { supplierId } : {}),
      ...(offset ? { offset: String(offset) } : {}),
    }),
    getPurchaseSettings(slug),
  ]);
  return (
    <>
      <PageHeader actions={<ModuleDashboardsLink module="purchasing" />}>
        <h1 className="font-medium">Purchasing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-4 py-8">
          <PurchasingNav slug={slug} />
          <OrdersBoard
            slug={slug}
            status={status}
            q={q ?? ""}
            supplierId={supplierId ?? null}
            page={page}
            options={options}
            settings={settings}
          />
        </div>
      </div>
    </>
  );
}
