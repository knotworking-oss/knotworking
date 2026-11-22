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
import { PageHeader } from "@/components/page-header";
import { BatchStatusBadge } from "@/components/production-badges";
import { getWorkspaceCurrency, canReadModule, getBatchCost } from "@/lib/api";
import { formatLongDate } from "@/lib/format";

type Props = { params: Promise<{ workspace: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { workspace, id } = await params;
  return { title: `Cost of ${(await getBatchCost(workspace, id)).batch.batchCode}` };
}

/** One batch's cost in full (costing module). */
export default async function BatchCostPage({ params }: Props) {
  const { workspace: slug, id } = await params;
  const currency = await getWorkspaceCurrency(slug);
  // Costing depends on production, so a costing reader can read the batch page too.
  const [cost, canProduction] = await Promise.all([
    getBatchCost(slug, id),
    canReadModule(slug, "production"),
  ]);
  const { batch } = cost;
  return (
    <>
      <PageHeader>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={`/${slug}/costing/batches`}>Batch costs</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{batch.batchCode}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6">
          <div className="flex flex-col gap-1">
            <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
              <span className="font-mono">{batch.batchCode}</span>
              <BatchStatusBadge status={batch.status} />
            </h2>
            <p className="text-sm text-muted-foreground">
              {batch.outputItem.code} {batch.outputItem.name}
              {batch.recipe && (
                <>
                  {" "}
                  · {batch.recipe.code} version {batch.recipeVersion?.versionNumber ?? "?"}
                </>
              )}
              {batch.completedOn
                ? ` · completed ${formatLongDate(batch.completedOn)}`
                : ` · planned ${formatLongDate(batch.plannedOn)}`}
              {canProduction && (
                <>
                  {" "}
                  ·{" "}
                  <Link className="underline" href={`/${slug}/production/batches/${batch.id}`}>
                    Batch record
                  </Link>
                </>
              )}
            </p>
          </div>
          <BatchCostPanel slug={slug} currency={currency} cost={cost} />
        </div>
      </div>
    </>
  );
}
