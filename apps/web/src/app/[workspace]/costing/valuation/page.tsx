import { itemTypes, itemTypeLabels, type ItemType } from "@knotworking/core";
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
import { CostSourceBadge, formatCost, formatUnitCost } from "@/components/costing-badges";
import { CostingNav } from "@/components/costing-nav";
import { PageHeader } from "@/components/page-header";
import { stackedTable } from "@/components/stacked-table";
import { formatAmount } from "@/components/stock-badges";
import { getStockValuation, getWorkspaceCurrency } from "@/lib/api";
import { formatLongDate } from "@/lib/format";

export const metadata: Metadata = { title: "Stock valuation" };

/**
 * Stock on hand valued at lot cost (costing module): per item, with each lot's cost and where it
 * comes from. Materials only; estimates (standard costs standing in for a price) are flagged.
 */
export default async function StockValuationPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ type?: string; q?: string; lots?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const currency = await getWorkspaceCurrency(slug);
  const itemType = itemTypes.find((t) => t === search.type) as ItemType | undefined;
  const q = search.q?.trim() || undefined;
  const showLots = search.lots === "1";
  const v = await getStockValuation(slug, { ...(itemType ? { itemType } : {}), ...(q ? { q } : {}) });
  const csv = `/api/v1/workspaces/${slug}/costing/export.csv?kind=valuation`;

  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Costing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-4 py-8">
          <CostingNav slug={slug} />
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Stock valuation</h2>
            <p className="text-sm text-muted-foreground">As at {formatLongDate(v.asOf)}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="px-4 py-3">
              <div className="text-xs text-muted-foreground">Total value</div>
              <div className="text-2xl font-semibold tabular-nums">
                {formatCost(v.totals.value, currency)}
              </div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-xs text-muted-foreground">Of which estimated</div>
              <div className="text-2xl font-semibold tabular-nums">
                {formatCost(v.totals.estimatedValue, currency)}
              </div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-xs text-muted-foreground">Lots without a cost</div>
              <div className="text-2xl font-semibold tabular-nums">{v.totals.unvaluedLots}</div>
            </Card>
          </div>
          <form className="flex flex-wrap items-end gap-3">
            <Input name="q" defaultValue={q} placeholder="Item or lot" className="w-48" />
            <select
              name="type"
              defaultValue={itemType ?? ""}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              aria-label="Item type"
            >
              <option value="">All types</option>
              {itemTypes.map((t) => (
                <option key={t} value={t}>
                  {itemTypeLabels[t]}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" name="lots" value="1" defaultChecked={showLots} /> Show lots
            </label>
            <Button type="submit" variant="outline" size="sm">
              Filter
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={csv}>Export CSV</a>
            </Button>
          </form>
          <Card className="overflow-x-auto py-0">
            <Table className={stackedTable}>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Item</TableHead>
                  {showLots && <TableHead>Lot</TableHead>}
                  <TableHead className="text-right">On hand</TableHead>
                  {showLots && <TableHead className="text-right">Unit cost</TableHead>}
                  {showLots && <TableHead>Cost from</TableHead>}
                  <TableHead className="pr-4 text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(showLots ? v.lots : v.items).map((row) => {
                  const lot = "lotCode" in row ? row : null;
                  return (
                    <TableRow key={lot ? lot.lotId : row.itemId}>
                      <TableCell className="pl-4" data-primary>
                        <span className="font-medium">{row.item.code}</span>{" "}
                        <span className="text-muted-foreground">{row.item.name}</span>
                      </TableCell>
                      {showLots && <TableCell data-label="Lot">{lot?.lotCode}</TableCell>}
                      <TableCell data-label="On hand" className="text-right tabular-nums">
                        {formatAmount(row.amount)}
                      </TableCell>
                      {showLots && (
                        <TableCell data-label="Unit cost" className="text-right tabular-nums">
                          {lot ? formatUnitCost(lot.unitCost, lot.unit, currency) : null}
                        </TableCell>
                      )}
                      {showLots && (
                        <TableCell data-label="Cost from">
                          {lot ? (
                            <CostSourceBadge
                              source={lot.source as never}
                              estimatedPercent={lot.estimatedPercent}
                            />
                          ) : null}
                        </TableCell>
                      )}
                      <TableCell data-label="Value" className="pr-4 text-right tabular-nums">
                        {row.value === null ? "No cost" : formatCost(row.value, currency)}
                        {"unvaluedLots" in row && row.unvaluedLots > 0 && (
                          <span className="ml-1 text-xs text-label-orange">
                            ({row.unvaluedLots} without a cost)
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        </div>
      </div>
    </>
  );
}
