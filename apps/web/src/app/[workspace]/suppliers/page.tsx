import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getSupplierCompliance, getSupplierControlSettings, getSuppliers } from "@/lib/api";
import { SuppliersManager } from "./suppliers-manager";

export const metadata: Metadata = { title: "Suppliers" };

export default async function SuppliersPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ suppliers }, compliance, { enforcement }] = await Promise.all([
    getSuppliers(slug),
    getSupplierCompliance(slug),
    getSupplierControlSettings(slug),
  ]);
  const bySupplier = Object.fromEntries(
    compliance.suppliers.map((c) => [c.supplierId, { riskLevel: c.riskLevel, actionCount: c.actionCount }]),
  );
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Suppliers</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <SuppliersManager
          slug={slug}
          suppliers={suppliers}
          compliance={bySupplier}
          enforcement={enforcement}
        />
      </div>
    </>
  );
}
