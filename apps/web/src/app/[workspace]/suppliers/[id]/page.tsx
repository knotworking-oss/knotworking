import Link from "next/link";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { canReadModule, getItems, getSupplier, getSupplierControls } from "@/lib/api";
import { SupplierDetail } from "./supplier-detail";

export const metadata: Metadata = { title: "Supplier" };

export default async function SupplierPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [supplier, controls] = await Promise.all([getSupplier(slug, id), getSupplierControls(slug, id)]);
  const showAuthenticity = await canReadModule(slug, "quality");
  const items = (await getItems(slug, { status: "active" })).items;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">{supplier.name}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        {showAuthenticity && (
          <div className="workspace-content pt-4 text-sm">
            <Link className="underline" href={`/${slug}/quality/authenticity?supplierId=${id}`}>
              View supplier authenticity assessments
            </Link>
          </div>
        )}
        <SupplierDetail slug={slug} supplier={supplier} controls={controls} items={items} />
      </div>
    </>
  );
}
