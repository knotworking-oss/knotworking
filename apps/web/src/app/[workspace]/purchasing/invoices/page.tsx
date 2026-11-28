import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PurchasingNav } from "@/components/purchasing-nav";
import { canReadModule, getInvoiceTolerances, getPurchaseInvoices, getSuppliers } from "@/lib/api";
import { InvoicesBoard, type InvoiceFilter } from "./invoices-board";

export const metadata: Metadata = { title: "Supplier invoices" };

const FILTERS: readonly InvoiceFilter[] = ["current", "draft", "approved", "superseded", "all"];

export default async function PurchaseInvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string; q?: string; supplier?: string; order?: string; offset?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const status = FILTERS.find((f) => f === search.status) ?? "current";
  const q = search.q?.trim() || undefined;
  const suppliers = (await canReadModule(slug, "items"))
    ? (await getSuppliers(slug)).suppliers.map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code,
        approvalStatus: s.approvalStatus,
      }))
    : [];
  const supplierId = suppliers.find((s) => s.id === search.supplier)?.id;
  const orderId = search.order && /^[0-9a-f-]{36}$/i.test(search.order) ? search.order : undefined;
  const offset = Math.max(0, Number.parseInt(search.offset ?? "0", 10) || 0);
  const [page, tolerances] = await Promise.all([
    getPurchaseInvoices(slug, {
      status,
      ...(q ? { q } : {}),
      ...(supplierId ? { supplierId } : {}),
      ...(orderId ? { purchaseOrderId: orderId } : {}),
      ...(offset ? { offset: String(offset) } : {}),
    }),
    getInvoiceTolerances(slug),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Purchasing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-4 py-8">
          <PurchasingNav slug={slug} />
          <InvoicesBoard
            slug={slug}
            status={status}
            q={q ?? ""}
            supplierId={supplierId ?? null}
            orderId={orderId ?? null}
            page={page}
            suppliers={suppliers}
            tolerances={tolerances}
          />
        </div>
      </div>
    </>
  );
}
