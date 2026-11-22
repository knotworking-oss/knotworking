import { biDashboardScopeSchema } from "@knotworking/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getBiDatasets, getBootstrap, getDashboards } from "@/lib/api";
import { DashboardList } from "./dashboard-list";

export const metadata: Metadata = { title: "Dashboards" };

/**
 * Every dashboard the viewer may open, or one module's (`?scope=module:<id>`: where each module's
 * Dashboards link lands). People who build get "New dashboard", from blank or a template.
 */
export default async function DashboardsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const scope = biDashboardScopeSchema.safeParse(search.scope).success ? search.scope : undefined;
  const boot = await getBootstrap(slug);
  const level = boot.modules.find((m) => m.id === "bi")?.access ?? "none";
  const canCreate = level === "write" || level === "manage";
  const [{ dashboards }, templates, catalogue] = await Promise.all([
    getDashboards(slug, scope ? { scope } : {}),
    canCreate ? getDashboards(slug, { template: "true" }) : Promise.resolve({ dashboards: [] }),
    canCreate ? getBiDatasets(slug) : Promise.resolve(null),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Dashboards</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <DashboardList
          slug={slug}
          scope={scope}
          dashboards={dashboards}
          templates={templates.dashboards}
          catalogue={catalogue}
          modules={boot.modules.filter((m) => m.access !== "none").map((m) => m.id)}
          canCreate={canCreate}
        />
      </div>
    </>
  );
}
