import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getPurchaseOrder } from "@/lib/api";
import { loadOrderOptions } from "../../options";
import { OrderDetailView } from "./order-detail";

export const metadata: Metadata = { title: "Purchase order" };

export default async function PurchaseOrderPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [order, options] = await Promise.all([getPurchaseOrder(slug, id), loadOrderOptions(slug)]);
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/purchasing`} className="text-muted-foreground hover:text-foreground">
          Purchasing
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="font-mono font-medium">{order.reference}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <OrderDetailView slug={slug} order={order} options={options} />
      </div>
    </>
  );
}
