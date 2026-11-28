import { costingBatchListStatuses, type CostingBatchListStatus } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Input } from "@knotworking/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import type { Metadata } from "next";
import Link from "next/link";
import {
  EstimatedBadge,
  formatCost,
  formatUnitCost,
  IncompleteCostBadge,
  ProvisionalBadge,
  VarianceValue,
} from "@/components/costing-badges";
import { CostingNav } from "@/components/costing-nav";
import { PageHeader } from "@/components/page-header";
import { BatchStatusBadge } from "@/components/production-badges";
import { stackedTable } from "@/components/stacked-table";
import { formatAmount } from "@/components/stock-badges";
import { getWorkspaceCurrency, getBatchCosts } from "@/lib/api";
import { BatchCostsExport } from "./batch-costs-export";
import { formatLongDate } from "@/lib/format";

export const metadata: Metadata = { title: "Batch costs" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statusLabels: Record<CostingBatchListStatus, string> = {
  completed: "Completed",
  in_progress: "In progress",
  cancelled: "Cancelled",
  all: "All",
};

/** Batches with their actual cost (costing module), newest first. */
export default async function BatchCostsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string; q?: string; product?: string; offset?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const currency = await getWorkspaceCurrency(slug);
  const status = costingBatchListStatuses.find((s) => s === search.status) ?? "completed";
  const q = search.q?.trim() || undefined;
  const product = UUID.test(search.product ?? "") ? search.product : undefined;
  const offset = Math.max(0, Number.parseInt(search.offset ?? "0", 10) || 0);
  const page = await getBatchCosts(slug, {
    status,
    ...(q ? { q } : {}),
    ...(product ? { outputItemId: product } : {}),
    ...(offset ? { offset: String(offset) } : {}),
  });
  const href = (over: { status?: string; offset?: number }) => {
    const query = new URLSearchParams({
      status: over.status ?? status,
      ...(q ? { q } : {}),
      ...(product ? { product } : {}),
      ...(over.offset ? { offset: String(over.offset) } : {}),
    });
    return `/${slug}/costing/batches?${query}`;
  };
  const productName = product ? page.batches[0]?.outputItem : null;

  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Costing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-4 py-8">
          <CostingNav slug={slug} />
          <div className="flex flex-wrap items-center gap-2">
            {costingBatchListStatuses.map((s) => (
              <Button key={s} asChild size="sm" variant={s === status ? "secondary" : "ghost"}>
                <Link href={href({ status: s })}>{statusLabels[s]}</Link>
              </Button>
            ))}
            <div className="ml-auto">
              <BatchCostsExport slug={slug} status={status} q={q} product={product} />
            </div>
            <form className="flex gap-2">
              <input type="hidden" name="status" value={status} />
              {product && <input type="hidden" name="product" value={product} />}
              <Input name="q" placeholder="Batch or recipe" defaultValue={q ?? ""} className="w-48" />
              <Button type="submit" variant="outline" size="sm">
                Search
              </Button>
            </form>
          </div>
          {product && (
            <p className="text-sm text-muted-foreground">
              Batches making {productName ? `${productName.code} ${productName.name}` : "one product"}.{" "}
              <Link className="underline" href={`/${slug}/costing/batches?status=${status}`}>
                Show all products
              </Link>
            </p>
          )}
          {page.batches.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              {q || product
                ? "No batches match."
                : "No batches here yet. A batch has a cost once consumption is recorded against it."}
            </p>
          ) : (
            <Card className="overflow-x-auto py-0">
              <Table className={stackedTable}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Batch</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Produced</TableHead>
                    <TableHead className="text-right">Actual cost</TableHead>
                    <TableHead className="text-right">Per unit</TableHead>
                    <TableHead className="text-right">Standard per unit</TableHead>
                    <TableHead className="pr-4 text-right">Variance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.batches.map((b) => (
                    <TableRow key={b.id} className="align-top">
                      <TableCell className="pl-4" data-primary>
                        <span className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/${slug}/costing/batches/${b.id}`}
                            className="font-mono text-xs font-medium hover:underline"
                          >
                            {b.batchCode}
                          </Link>
                          {b.status !== "completed" && <BatchStatusBadge status={b.status} />}
                          {b.cost.provisional && b.status === "completed" && <ProvisionalBadge />}
                          {!b.cost.costComplete && <IncompleteCostBadge codes={[]} />}
                        </span>
                      </TableCell>
                      <TableCell data-label="Product">
                        {b.outputItem.code} <span className="text-muted-foreground">{b.outputItem.name}</span>
                      </TableCell>
                      <TableCell data-label="Date" className="tabular-nums">
                        {formatLongDate(b.costingDate)}
                      </TableCell>
                      <TableCell data-label="Produced" className="text-right tabular-nums">
                        {formatAmount(b.cost.produced)}
                        {b.cost.yieldPercent !== null && (
                          <div className="text-xs text-muted-foreground">
                            {b.cost.yieldPercent.toLocaleString("en-GB", { maximumFractionDigits: 1 })}% of
                            plan
                          </div>
                        )}
                      </TableCell>
                      <TableCell data-label="Actual cost" className="text-right tabular-nums">
                        <span className="inline-flex flex-col items-end gap-0.5">
                          {formatCost(b.cost.actualCost, currency)}
                          <EstimatedBadge percent={b.cost.estimatedPercent} />
                        </span>
                      </TableCell>
                      <TableCell data-label="Per unit" className="text-right tabular-nums">
                        {formatUnitCost(b.cost.costPerUnit, b.outputItem.unit, currency)}
                      </TableCell>
                      <TableCell data-label="Standard per unit" className="text-right tabular-nums">
                        {formatUnitCost(b.cost.standardCostPerUnit, b.outputItem.unit, currency)}
                      </TableCell>
                      <TableCell data-label="Variance" className="pr-4 text-right">
                        <VarianceValue
                          value={b.cost.variance}
                          percent={b.cost.variancePercent}
                          currency={currency}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
          {page.total > page.limit && (
            <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
              {offset + 1}–{Math.min(offset + page.batches.length, page.total)} of {page.total}
              {offset > 0 && (
                <Button asChild variant="outline" size="sm">
                  <Link href={href({ offset: Math.max(0, offset - page.limit) })}>Previous</Link>
                </Button>
              )}
              {offset + page.limit < page.total && (
                <Button asChild variant="outline" size="sm">
                  <Link href={href({ offset: offset + page.limit })}>Next</Link>
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
