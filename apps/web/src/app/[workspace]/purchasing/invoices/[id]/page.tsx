import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { canReadModule, getPurchaseInvoice, getSuppliers } from "@/lib/api";
import { InvoiceDetailView } from "./invoice-detail";

export const metadata: Metadata = { title: "Supplier invoice" };

export default async function PurchaseInvoicePage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [invoice, canItems] = await Promise.all([getPurchaseInvoice(slug, id), canReadModule(slug, "items")]);
  const suppliers = canItems
    ? (await getSuppliers(slug)).suppliers.map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code,
        approvalStatus: s.approvalStatus,
      }))
    : [];
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/purchasing/invoices`} className="text-muted-foreground hover:text-foreground">
          Invoices
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="font-mono font-medium">{invoice.invoiceNumber}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <InvoiceDetailView slug={slug} invoice={invoice} suppliers={suppliers} />
      </div>
    </>
  );
}
