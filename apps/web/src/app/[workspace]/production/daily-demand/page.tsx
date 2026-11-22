import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getProductionDailyDemand } from "@/lib/api";
import { DailyDemandView } from "./daily-demand";

export const metadata: Metadata = { title: "Daily demand" };

export default async function DailyDemandPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const days = Math.min(31, Math.max(1, Number(search.days) || 14));
  const demand = await getProductionDailyDemand(slug, days);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Daily demand</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <DailyDemandView slug={slug} days={days} demand={demand} />
      </div>
    </>
  );
}
