import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getCustomer, getDeliverySites } from "@/lib/api";
import { SitesManager } from "./sites-manager";
export default async function Page({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const [customer, sites] = await Promise.all([getCustomer(slug, id), getDeliverySites(slug, id)]);
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/customers`}>Customers</Link>
        <span>/</span>
        <h1>{customer.name} · Delivery sites</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content space-y-5 py-6">
          <SitesManager slug={slug} customerId={id} sites={sites.sites} />
        </div>
      </div>
    </>
  );
}
