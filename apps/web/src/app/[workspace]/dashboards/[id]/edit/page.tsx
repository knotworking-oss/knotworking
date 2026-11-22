import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getBiDatasets, getBootstrap, getDashboard } from "@/lib/api";
import { DashboardBuilder } from "./dashboard-builder";

export const metadata: Metadata = { title: "Edit dashboard" };

/** The builder, for people who may change this dashboard; everyone else goes back to the viewer. */
export default async function EditDashboardPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [dashboard, catalogue, boot] = await Promise.all([
    getDashboard(slug, id),
    getBiDatasets(slug),
    getBootstrap(slug),
  ]);
  if (!dashboard.canEdit) redirect(`/${slug}/dashboards/${id}`);
  // Modules a dashboard can belong to: the ones the viewer reads that have data to show.
  const readable = boot.modules.filter((m) => m.access !== "none").map((m) => m.id);
  return <DashboardBuilder slug={slug} dashboard={dashboard} catalogue={catalogue} modules={readable} />;
}
