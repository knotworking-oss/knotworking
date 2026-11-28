import { hasModuleLevel } from "@knotworking/core";
import type { Metadata } from "next";
import { CostingNav } from "@/components/costing-nav";
import { PageHeader } from "@/components/page-header";
import { getAbsorptionRates, getAllItems, getBootstrap, getWorkspaceCurrency } from "@/lib/api";
import { RatesForm, StandardCostForm } from "./setup-forms";

export const metadata: Metadata = { title: "Rates and standard costs" };

/**
 * What people set for costing: labour and overhead absorption rates (per production line or for the
 * whole workspace, from a date) and standard costs from a date, so the standard side of a batch uses
 * the cost in force when it was completed.
 */
export default async function CostingSetupPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [currency, rates, items, boot] = await Promise.all([
    getWorkspaceCurrency(slug),
    getAbsorptionRates(slug),
    getAllItems(slug, { status: "active" }),
    getBootstrap(slug),
  ]);
  const canManage = hasModuleLevel(boot.modules.find((m) => m.id === "costing")?.access, "manage");
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Costing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-6 py-8">
          <CostingNav slug={slug} />
          <RatesForm slug={slug} currency={currency} data={rates} canManage={canManage} />
          <StandardCostForm
            slug={slug}
            currency={currency}
            canManage={canManage}
            items={items.items.map((i) => ({ id: i.id, code: i.code, name: i.name, unit: i.unit }))}
          />
        </div>
      </div>
    </>
  );
}
