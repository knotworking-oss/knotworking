import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@knotworking/ui/components/breadcrumb";
import type { Metadata } from "next";
import Link from "next/link";
import { BatchCostPanel } from "@/components/batch-cost-panel";
import { BatchJobCardsPanel } from "@/components/batch-job-cards-panel";
import { HaccpBatchPanel } from "@/components/haccp-batch-panel";
import { PageHeader } from "@/components/page-header";
import {
  canReadModule,
  getBatchCost,
  getBatchJobCards,
  getBatchPacking,
  getBatchPerformance,
  getHaccpBatchRecord,
  getProductionBatch,
  getProductionReadiness,
  getProductionLines,
  getRecipe,
  getStockLocations,
  getWorkspaceCurrency,
} from "@/lib/api";
import { BatchDetail } from "./batch-detail";
import { BatchPackingPanel } from "./batch-packing";
import { BatchPerformancePanel } from "./batch-performance";

type Props = { params: Promise<{ workspace: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { workspace, id } = await params;
  return { title: `Batch ${(await getProductionBatch(workspace, id)).batchCode}` };
}

export default async function BatchPage({ params }: Props) {
  const { workspace: slug, id } = await params;
  const currency = await getWorkspaceCurrency(slug);
  const [
    batch,
    { locations },
    haccp,
    canCosting,
    { lines },
    readiness,
    performance,
    packing,
    jobCards,
    foodItems,
  ] = await Promise.all([
    getProductionBatch(slug, id),
    getStockLocations(slug),
    // The haccp module's checks on this batch, for people who can read it.
    canReadModule(slug, "haccp").then((can) => (can ? getHaccpBatchRecord(slug, id) : null)),
    canReadModule(slug, "costing"),
    getProductionLines(slug),
    getProductionReadiness(slug, id),
    getBatchPerformance(slug, id),
    getBatchPacking(slug, id),
    // Its operations (the routings module), for people who can read it.
    canReadModule(slug, "routings").then((can) => (can ? getBatchJobCards(slug, id) : null)),
    canReadModule(slug, "food_items"),
  ]);
  // What the batch cost (the costing module), once something is on record, for people who can read it.
  const cost = canCosting && batch.records.length > 0 ? await getBatchCost(slug, id) : null;
  // A planned batch whose version was superseded can be moved to the current approved version.
  const current =
    batch.status === "planned" && batch.recipeVersion?.status !== "approved"
      ? (await getRecipe(slug, batch.recipe.id)).currentVersion
      : null;
  return (
    <>
      <PageHeader>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={`/${slug}/production?week=${batch.plannedOn}`}>Production</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Batch {batch.batchCode}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <BatchDetail
          slug={slug}
          batch={batch}
          locations={locations}
          lines={lines.filter((l) => l.active)}
          openDeviations={haccp?.openCorrectiveActions ?? 0}
          readiness={readiness}
          currentVersion={
            current?.status === "approved" ? { id: current.id, versionNumber: current.versionNumber } : null
          }
          outputCardId={jobCards?.jobCards.at(-1)?.id ?? null}
        />
        {jobCards && <BatchJobCardsPanel slug={slug} data={jobCards} currency={currency} />}
        <BatchPackingPanel slug={slug} packing={packing} />
        <BatchPerformancePanel
          slug={slug}
          performance={performance}
          lineId={batch.line?.id ?? null}
          plannedOn={batch.plannedOn}
        />
        {cost && (
          <div className="workspace-content pb-8">
            <BatchCostPanel slug={slug} currency={currency} cost={cost} compact foodItems={foodItems} />
          </div>
        )}
        {haccp && <HaccpBatchPanel slug={slug} record={haccp} />}
      </div>
    </>
  );
}
